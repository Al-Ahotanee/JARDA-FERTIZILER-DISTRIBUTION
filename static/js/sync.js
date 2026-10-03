/**
 * JARDA — Background Sync Manager & Offline AJAX Bridge
 *
 * Responsibilities:
 *   1. Intercept jQuery $.ajax & native fetch calls:
 *      - Auto-injects Authorization: Bearer <token>
 *      - Automatically serves GET requests from IndexedDB when offline
 *      - Automatically enqueues POST/PUT mutations into IndexedDB when offline
 *      - Optimistically updates local IndexedDB so the UI reflects changes immediately
 *   2. Flush the offline queue sequentially when network is restored
 *   3. Hydrate IndexedDB caches from the server on login and reconnect
 *   4. Expose online/offline state + pending sync counter to UI
 */

const SyncManager = (() => {

  let _isSyncing = false;
  let _onStatusChange = null;   // callback(isOnline, queueCount)
  let _ajaxBridgeInstalled = false;

  // ─── Initialise ────────────────────────────────────────────────────────────

  async function init() {
    // Install jQuery AJAX bridge
    _setupAjaxBridge();

    // Listen for online/offline events
    window.addEventListener('online',  () => _onNetworkRestored());
    window.addEventListener('offline', () => _broadcastStatus());

    // Listen for SW sync messages
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', e => {
        if (e.data?.type === 'SYNC_REQUESTED') flushQueue();
      });
    }

    // Initial cache hydration if online
    if (navigator.onLine) await hydrateCache();
    _broadcastStatus();
  }

  // ─── Token Helper ─────────────────────────────────────────────────────────

  function _getAuthToken() {
    try {
      const direct = localStorage.getItem('jarda_token');
      if (direct) return direct;
      if (window.currentUser && window.currentUser.token) return window.currentUser.token;
      const saved = localStorage.getItem('currentUser');
      if (saved) {
        const u = JSON.parse(saved);
        return u.token || null;
      }
    } catch (e) {}
    return null;
  }

  // ─── jQuery AJAX Bridge ───────────────────────────────────────────────────

  function _setupAjaxBridge() {
    if (!window.$ || _ajaxBridgeInstalled) return;

    // 1. Global Authorization Header Setup
    if ($.ajaxSetup) {
      $.ajaxSetup({
        beforeSend: function(xhr, settings) {
          const token = _getAuthToken();
          if (token && (!settings.headers || !settings.headers.Authorization)) {
            xhr.setRequestHeader('Authorization', 'Bearer ' + token);
          }
        }
      });
    }

    // 2. Wrap $.ajax for offline-first interception
    const _origAjax = $.ajax;
    $.ajax = function(urlOrSettings, maybeSettings) {
      let settings = typeof urlOrSettings === 'string' ? (maybeSettings || {}) : (urlOrSettings || {});
      let url = typeof urlOrSettings === 'string' ? urlOrSettings : (settings.url || '');
      let method = (settings.type || settings.method || 'GET').toUpperCase();

      // Ensure Authorization header is present
      const token = _getAuthToken();
      if (token) {
        settings.headers = settings.headers || {};
        if (!settings.headers.Authorization) {
          settings.headers.Authorization = 'Bearer ' + token;
        }
      }

      // If online, try network request with offline fallback
      if (navigator.onLine) {
        const origSuccess = settings.success;
        const origError = settings.error;

        settings.success = function(data, textStatus, jqXHR) {
          if (method === 'GET' && data && data.success) {
            _cacheGetResult(url, data);
          }
          if (typeof origSuccess === 'function') origSuccess(data, textStatus, jqXHR);
        };

        settings.error = function(jqXHR, textStatus, errorThrown) {
          // If network dropped mid-call (status 0 or 503/504), fall back to offline handling
          if (jqXHR.status === 0 || jqXHR.status === 503 || jqXHR.status === 504) {
            console.warn('[SyncManager] Network error on ' + url + ', switching to offline handler');
            _handleOfflineAjax(url, method, settings, origSuccess, origError);
            return;
          }
          if (typeof origError === 'function') origError(jqXHR, textStatus, errorThrown);
        };

        return _origAjax.call($, typeof urlOrSettings === 'string' ? url : settings);
      }

      // We are strictly OFFLINE
      return _handleOfflineAjax(url, method, settings, settings.success, settings.error);
    };

    _ajaxBridgeInstalled = true;
    console.log('[SyncManager] jQuery AJAX bridge installed successfully');
  }

  function _handleOfflineAjax(url, method, settings, successCb, errorCb) {
    const deferred = $.Deferred();

    // Parse data payload
    let postData = settings.data;
    if (typeof postData === 'string') {
      try { postData = JSON.parse(postData); } catch (e) { /* keep as string or params */ }
    }

    if (method === 'GET') {
      _getCachedResponse(url).then(cached => {
        if (cached) {
          const resp = { ...cached, _offline: true, _cached: true };
          if (typeof successCb === 'function') successCb(resp, 'success', _makeFakeXHR(resp));
          deferred.resolve(resp, 'success', _makeFakeXHR(resp));
        } else {
          // Graceful empty data fallback
          const emptyResp = { success: true, data: [], _offline: true, _empty: true, message: 'Offline mode: no local cached data' };
          if (typeof successCb === 'function') successCb(emptyResp, 'success', _makeFakeXHR(emptyResp));
          deferred.resolve(emptyResp, 'success', _makeFakeXHR(emptyResp));
        }
      }).catch(err => {
        const errResp = { success: false, _offline: true, message: err.message };
        if (typeof errorCb === 'function') errorCb(_makeFakeXHR(errResp, 503), 'error', err.message);
        deferred.reject(_makeFakeXHR(errResp, 503), 'error', err.message);
      });
      return deferred.promise();
    }

    // Handle Mutations (POST / PUT / PATCH)
    _handleOfflineMutation(url, method, postData).then(result => {
      _broadcastStatus();
      if (typeof successCb === 'function') successCb(result, 'success', _makeFakeXHR(result));
      deferred.resolve(result, 'success', _makeFakeXHR(result));
    }).catch(err => {
      const errResp = { success: false, _offline: true, message: err.message };
      if (typeof errorCb === 'function') errorCb(_makeFakeXHR(errResp, 500), 'error', err.message);
      deferred.reject(_makeFakeXHR(errResp, 500), 'error', err.message);
    });

    return deferred.promise();
  }

  async function _handleOfflineMutation(url, method, data) {
    if (!window.JardaDB) {
      throw new Error('IndexedDB is not available');
    }

    // 1. QR Code Verification Offline
    if (url.includes('/api/verify_qr')) {
      const qrData = (data && data.qr_data) ? data.qr_data : data;
      const verifyRes = await window.JardaDB.verifyQrOffline(qrData);
      if (!verifyRes.success) {
        throw new Error(verifyRes.message || 'QR verification failed offline');
      }
      return { success: true, data: verifyRes.data, _offline: true };
    }

    // 2. Farmer Fertilizer Request Submission
    if (url.includes('/api/requests') && method === 'POST') {
      const tempId = 'offline_' + Date.now();
      const localReq = {
        id: tempId,
        farmer_id: data.farmer_id || (window.currentUser ? window.currentUser.user_id : ''),
        season_id: data.season_id,
        fertilizer_type: data.fertilizer_type || 'NPK 15-15-15',
        requested_bags: Number(data.requested_bags) || 1,
        allocated_bags: 0,
        status: 'pending',
        created_at: new Date().toISOString(),
        _offline_temp: true,
      };
      await window.JardaDB.saveRequest(localReq);
      const queueId = await window.JardaDB.enqueue(method, url, data, 'Submit Fertilizer Request');
      return {
        success: true,
        _offline: true,
        _queued: true,
        _queue_id: queueId,
        message: 'Fertilizer request saved offline! It will sync automatically once online.',
      };
    }

    // 3. Fertilizer Distribution
    if (url.includes('/api/distribute') && method === 'POST') {
      const reqId = data.request_id;
      const officerId = data.officer_id || (window.currentUser ? window.currentUser.user_id : '');
      await window.JardaDB.updateRequestStatus(reqId, 'distributed', {
        distributed_by: officerId,
        distributed_at: new Date().toISOString(),
      });
      const queueId = await window.JardaDB.enqueue(method, url, data, 'Record Distribution');
      return {
        success: true,
        _offline: true,
        _queued: true,
        _queue_id: queueId,
        message: 'Distribution recorded offline! It will sync automatically once online.',
      };
    }

    // 4. Receipt Acknowledgement
    if (url.includes('/api/acknowledge') && method === 'POST') {
      const reqId = data.request_id;
      await window.JardaDB.updateRequestStatus(reqId, 'completed', {
        acknowledged: 1,
        acknowledged_at: new Date().toISOString(),
      });
      const queueId = await window.JardaDB.enqueue(method, url, data, 'Acknowledge Receipt');
      return {
        success: true,
        _offline: true,
        _queued: true,
        _queue_id: queueId,
        message: 'Receipt acknowledged offline! It will sync automatically once online.',
      };
    }

    // 5. Stock / Inventory Update
    if (url.includes('/api/inventory') && method === 'POST') {
      const queueId = await window.JardaDB.enqueue(method, url, data, 'Add Stock');
      return {
        success: true,
        _offline: true,
        _queued: true,
        _queue_id: queueId,
        message: 'Stock update saved offline! It will sync automatically once online.',
      };
    }

    // 6. Farmer Registration Offline
    if (url.includes('/api/register/farmer') && method === 'POST') {
      const queueId = await window.JardaDB.enqueue(method, url, data, 'Register Farmer: ' + (data.name || data.farmer_id));
      return {
        success: true,
        _offline: true,
        _queued: true,
        _queue_id: queueId,
        message: 'Registration saved offline! Your account will be submitted when internet is restored.',
      };
    }

    // General fallback mutation
    const label = _labelFor(url, method, data);
    const queueId = await window.JardaDB.enqueue(method, url, data, label);
    return {
      success: true,
      _offline: true,
      _queued: true,
      _queue_id: queueId,
      message: label + ' saved offline. Will sync when connected.',
    };
  }

  function _makeFakeXHR(data, status = 200) {
    return {
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      responseJSON: data,
      responseText: JSON.stringify(data),
      readyState: 4,
      getResponseHeader: () => 'application/json',
    };
  }

  // ─── Fetch API drop-in replacement ─────────────────────────────────────────

  async function apiFetch(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const token = _getAuthToken();

    options.headers = options.headers || {};
    if (token && !options.headers['Authorization']) {
      options.headers['Authorization'] = 'Bearer ' + token;
    }

    try {
      const response = await fetch(url, options);
      if (method === 'GET' && response.ok) {
        const clone = response.clone();
        clone.json().then(json => _cacheGetResult(url, json)).catch(() => {});
      }
      return response;
    } catch (networkError) {
      if (method === 'GET') {
        const cached = await _getCachedResponse(url);
        if (cached) {
          return new Response(JSON.stringify({ ...cached, _offline: true, _cached: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ success: true, data: [], _offline: true, _empty: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const body = options.body ? JSON.parse(options.body) : {};
      const mutationRes = await _handleOfflineMutation(url, method, body);
      return new Response(JSON.stringify(mutationRes), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // ─── Cache Hydration ────────────────────────────────────────────────────────

  async function hydrateCache() {
    if (!navigator.onLine || !window.JardaDB) return;
    const token = _getAuthToken();
    const headers = token ? { 'Authorization': Bearer  } : {};

    const endpoints = [
      { url: '/api/farmers',               store: 'farmers',       key: 'data' },
      { url: '/api/seasons',               store: 'seasons',       key: 'data' },
      { url: '/api/inventory',             store: 'inventory',     key: 'data' },
      { url: '/api/distributions/pending', store: 'distributions', key: 'data' },
      { url: '/api/locations/lga',         kv: 'locations',        key: 'lga' },
      { url: '/api/stats/admin',           kv: 'stats',            key: 'admin_stats' },
    ];

    // If current logged in user is a farmer, also fetch their requests
    let user = window.currentUser;
    if (!user) {
      const saved = localStorage.getItem('currentUser');
      if (saved) {
        try { user = JSON.parse(saved); } catch (e) {}
      }
    }
    if (user && user.user_id && user.user_type === 'farmer') {
      endpoints.push({
        url: /api/requests/farmer/,
        store: 'requests',
        key: 'data'
      });
    }

    for (const ep of endpoints) {
      try {
        const resp = await fetch(ep.url, { headers });
        if (!resp.ok) continue;
        const json = await resp.json();
        if (ep.store) {
          const rows = json[ep.key] || [];
          if (rows.length && window.JardaDB[save]) {
            await window.JardaDB[save](rows);
            await window.JardaDB.setLastSync(ep.store);
          }
        } else if (ep.kv === 'locations') {
          await window.JardaDB.saveLocations(ep.key, json.data || json);
        } else if (ep.kv === 'stats') {
          await window.JardaDB.saveStats(ep.key, json.data || json);
        }
      } catch (err) {
        // Ignore single endpoint failures during hydration
      }
    }
  }

  // ─── Flush Offline Queue ───────────────────────────────────────────────────

  async function flushQueue() {
    if (_isSyncing || !navigator.onLine || !window.JardaDB) return;
    _isSyncing = true;

    const ops = await window.JardaDB.getPendingOps();
    if (!ops.length) {
      _isSyncing = false;
      _broadcastStatus();
      return;
    }

    console.log([SyncManager] Flushing  queued operations...);
    const token = _getAuthToken();
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': Bearer  } : {})
    };

    for (const op of ops) {
      try {
        const resp = await fetch(op.url, {
          method: op.method,
          headers,
          body: JSON.stringify(op.body),
        });

        if (resp.ok) {
          console.log([SyncManager] Synced op # ());
          await window.JardaDB.markOpSynced(op.id);
        } else {
          const errText = await resp.text();
          console.warn([SyncManager] Op # failed with status :, errText);
          await window.JardaDB.markOpFailed(op.id, Server returned : );
        }
      } catch (e) {
        console.warn([SyncManager] Op # network exception:, e.message);
        await window.JardaDB.markOpFailed(op.id, e.message);
      }
    }

    _isSyncing = false;
    await hydrateCache();
    _broadcastStatus();

    // Notify UI that synchronization completed
    window.dispatchEvent(new CustomEvent('jarda:sync-complete'));
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  async function _onNetworkRestored() {
    console.log('[SyncManager] Network restored. Initializing sync.');
    _broadcastStatus();
    await flushQueue();
  }

  async function _broadcastStatus() {
    if (!window.JardaDB) return;
    try {
      const pending = await window.JardaDB.getPendingOps();
      const queueCount = pending.length;
      if (typeof _onStatusChange === 'function') {
        _onStatusChange(navigator.onLine, queueCount);
      }
      window.dispatchEvent(new CustomEvent('jarda:network-status', {
        detail: { online: navigator.onLine, queueCount }
      }));
    } catch (e) {}
  }

  async function _cacheGetResult(url, json) {
    if (!window.JardaDB || !json) return;
    const base = url.split('?')[0];
    const rows = json.data || (Array.isArray(json) ? json : null);

    try {
      if (base === '/api/farmers' && rows) {
        await window.JardaDB.saveFarmers(rows);
      } else if (base === '/api/seasons' && rows) {
        await window.JardaDB.saveSeasons(rows);
      } else if (base === '/api/inventory' && rows) {
        await window.JardaDB.saveInventory(rows);
      } else if (base.startsWith('/api/requests/farmer/') && rows) {
        await window.JardaDB.saveRequests(rows);
      } else if (base === '/api/distributions/pending' && rows) {
        await window.JardaDB.saveDistributions(rows);
        await window.JardaDB.saveRequests(rows);
      } else if (base === '/api/locations/lga') {
        await window.JardaDB.saveLocations('lga', rows);
      } else if (base.startsWith('/api/locations/ward/')) {
        const lgaId = base.split('/').pop();
        await window.JardaDB.saveLocations('ward_' + lgaId, rows);
      } else if (base.startsWith('/api/locations/polling_unit/')) {
        const wardId = base.split('/').pop();
        await window.JardaDB.saveLocations('pu_' + wardId, rows);
      } else if (base === '/api/stats/admin') {
        await window.JardaDB.saveStats('admin_stats', json.data || json);
      }
    } catch (e) {
      console.debug('[SyncManager] Cache update error:', e);
    }
  }

  async function _getCachedResponse(url) {
    if (!window.JardaDB) return null;
    const base = url.split('?')[0];

    try {
      if (base === '/api/farmers') {
        const data = await window.JardaDB.getFarmers();
        return { success: true, data };
      }
      if (base === '/api/seasons') {
        const data = await window.JardaDB.getSeasons();
        return { success: true, data };
      }
      if (base === '/api/inventory') {
        const data = await window.JardaDB.getInventory();
        return { success: true, data };
      }
      if (base === '/api/distributions/pending') {
        const data = await window.JardaDB.getPendingDistributions();
        return { success: true, data };
      }
      if (base.startsWith('/api/requests/farmer/')) {
        const farmerId = base.split('/').pop();
        const data = await window.JardaDB.getRequestsByFarmer(farmerId);
        return { success: true, data };
      }
      if (base.startsWith('/api/requests/season/')) {
        const seasonId = base.split('/').pop();
        const all = await window.JardaDB.getRequests();
        const data = all.filter(r => String(r.season_id) === String(seasonId));
        return { success: true, data };
      }
      if (base === '/api/locations/lga') {
        const data = await window.JardaDB.getLocations('lga');
        if (data) return { success: true, data };
      }
      if (base.startsWith('/api/locations/ward/')) {
        const lgaId = base.split('/').pop();
        const data = await window.JardaDB.getLocations('ward_' + lgaId);
        if (data) return { success: true, data };
      }
      if (base.startsWith('/api/locations/polling_unit/')) {
        const wardId = base.split('/').pop();
        const data = await window.JardaDB.getLocations('pu_' + wardId);
        if (data) return { success: true, data };
      }
      if (base === '/api/stats/admin') {
        const data = await window.JardaDB.getStats('admin_stats');
        if (data) return { success: true, data };
      }
    } catch (e) {
      console.warn('[SyncManager] Error reading cache for ' + url, e);
    }
    return null;
  }

  function _labelFor(url, method, body) {
    if (url.includes('/api/requests') && method === 'POST')   return 'Fertilizer request';
    if (url.includes('/api/distribute'))                       return 'Distribution record';
    if (url.includes('/api/acknowledge'))                      return 'Acknowledgement';
    if (url.includes('/api/inventory')  && method === 'POST') return 'Inventory update';
    if (url.includes('/api/seasons')    && method === 'POST') return 'New season';
    if (url.includes('/api/register/farmer'))                  return 'Farmer registration';
    return ${method} ;
  }

  function _capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  return {
    init,
    apiFetch,
    flushQueue,
    hydrateCache,
    setupAjaxBridge: _setupAjaxBridge,
    onStatusChange: (cb) => { _onStatusChange = cb; },
    isOnline: () => navigator.onLine,
  };

})();

window.SyncManager = SyncManager;

// Auto-wire on load if jQuery is ready
if (typeof $ !== 'undefined') {
  SyncManager.setupAjaxBridge();
} else {
  document.addEventListener('DOMContentLoaded', () => {
    SyncManager.setupAjaxBridge();
  });
}
