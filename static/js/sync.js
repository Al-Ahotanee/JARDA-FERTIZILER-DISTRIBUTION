/**
 * JARDA — Background Sync Manager
 *
 * Responsibilities:
 *   1. Intercept API fetch calls — detect offline errors and queue them
 *   2. Flush the offline queue when the network is restored
 *   3. Hydrate IndexedDB caches from the server on first load / reconnect
 *   4. Expose online/offline status + queue count to the UI
 */

// ─── State ───────────────────────────────────────────────────────────────────

const SyncManager = (() => {

  let _isSyncing    = false;
  let _onStatusChange = null;   // callback(isOnline, queueCount)

  // ─── Initialise ────────────────────────────────────────────────────────────

  async function init() {
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

  // ─── Network-aware fetch wrapper ───────────────────────────────────────────

  /**
   * Drop-in replacement for fetch() that:
   *   - Passes through to network when online
   *   - If offline and it's a mutation (POST/PUT/PATCH), queues it in IDB
   *   - Returns a synthetic success response so the UI can show feedback
   */
  async function apiFetch(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();

    try {
      const response = await fetch(url, options);
      // If GET succeeded, update IDB cache
      if (method === 'GET' && response.ok) {
        _updateCacheFromResponse(url, response.clone());
      }
      return response;
    } catch (networkError) {
      // We're offline (or server unreachable)
      if (method === 'GET') {
        // Try serving from IndexedDB
        const cached = await _getCachedResponse(url);
        if (cached) {
          return new Response(
            JSON.stringify({ ...cached, _offline: true, _cached: true }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({ success: false, _offline: true, message: 'Offline — no cached data available' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Mutation while offline → enqueue
      const body = options.body ? JSON.parse(options.body) : {};
      const label = _labelFor(url, method, body);
      const queueId = await window.JardaDB.enqueue(method, url, body, label);
      _broadcastStatus();

      // Register background sync if supported
      if ('serviceWorker' in navigator && 'SyncManager' in window) {
        const reg = await navigator.serviceWorker.ready;
        try { await reg.sync.register('jarda-sync'); } catch {}
      }

      // Return synthetic success so the UI doesn't show an error
      return new Response(
        JSON.stringify({
          success:   true,
          _offline:  true,
          _queued:   true,
          _queue_id: queueId,
          message:   `${label} saved offline — will sync when connected.`,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  // ─── Cache hydration ────────────────────────────────────────────────────────

  const HYDRATE_ENDPOINTS = [
    { url: '/api/farmers',              store: 'farmers',       key: 'data' },
    { url: '/api/seasons',              store: 'seasons',       key: 'data' },
    { url: '/api/inventory',            store: 'inventory',     key: 'data' },
    { url: '/api/distributions/pending',store: 'distributions', key: 'data' },
  ];

  async function hydrateCache() {
    if (!navigator.onLine) return;
    const token = localStorage.getItem('jarda_token');
    if (!token) return;   // not logged in yet — nothing to hydrate

    const headers = { 'Authorization': `Bearer ${token}` };

    for (const ep of HYDRATE_ENDPOINTS) {
      try {
        const resp = await fetch(ep.url, { headers });
        if (!resp.ok) continue;
        const json = await resp.json();
        const rows = json[ep.key] || [];
        if (rows.length) {
          await window.JardaDB[`save${_capitalize(ep.store)}`]?.(rows);
          await window.JardaDB.setLastSync(ep.store);
        }
      } catch { /* offline during hydration — skip */ }
    }
  }

  // ─── Flush offline queue ────────────────────────────────────────────────────

  async function flushQueue() {
    if (_isSyncing || !navigator.onLine) return;
    _isSyncing = true;

    const ops = await window.JardaDB.getPendingOps();
    if (!ops.length) { _isSyncing = false; _broadcastStatus(); return; }

    const token   = localStorage.getItem('jarda_token');
    const headers = {
      'Content-Type':  'application/json',
      'Authorization': token ? `Bearer ${token}` : '',
    };

    for (const op of ops) {
      try {
        const resp = await fetch(op.url, {
          method:  op.method,
          headers,
          body:    JSON.stringify(op.body),
        });
        if (resp.ok) {
          await window.JardaDB.markOpSynced(op.id);
        } else {
          const err = await resp.text();
          await window.JardaDB.markOpFailed(op.id, err);
        }
      } catch (e) {
        await window.JardaDB.markOpFailed(op.id, e.message);
      }
    }

    _isSyncing = false;
    // Refresh caches after sync
    await hydrateCache();
    _broadcastStatus();

    // Notify any listeners
    window.dispatchEvent(new CustomEvent('jarda:sync-complete'));
  }

  // ─── Internal helpers ───────────────────────────────────────────────────────

  async function _onNetworkRestored() {
    _broadcastStatus();
    await flushQueue();
  }

  async function _broadcastStatus() {
    const pending = await window.JardaDB.getPendingOps();
    const queueCount = pending.length;
    if (typeof _onStatusChange === 'function') {
      _onStatusChange(navigator.onLine, queueCount);
    }
    window.dispatchEvent(new CustomEvent('jarda:network-status', {
      detail: { online: navigator.onLine, queueCount }
    }));
  }

  async function _updateCacheFromResponse(url, response) {
    try {
      const json = await response.json();
      const rows = json.data || [];
      if (!rows.length) return;

      const storeMap = {
        '/api/farmers':               r => window.JardaDB.saveFarmers(r),
        '/api/seasons':               r => window.JardaDB.saveSeasons(r),
        '/api/inventory':             r => window.JardaDB.saveInventory(r),
        '/api/distributions/pending': r => window.JardaDB.saveDistributions(r),
      };

      const base = url.split('?')[0];
      if (storeMap[base]) {
        await storeMap[base](rows);
        const storeName = base.replace('/api/', '').replace('/pending', '').replace(/\/.*/, '');
        await window.JardaDB.setLastSync(storeName);
      }
    } catch {}
  }

  async function _getCachedResponse(url) {
    const base = url.split('?')[0];
    const cacheMap = {
      '/api/farmers':               () => window.JardaDB.getFarmers(),
      '/api/seasons':               () => window.JardaDB.getSeasons(),
      '/api/inventory':             () => window.JardaDB.getInventory(),
      '/api/distributions/pending': () => window.JardaDB.getDistributions(),
    };
    if (cacheMap[base]) {
      const data = await cacheMap[base]();
      if (data?.length) return { success: true, data };
    }
    return null;
  }

  function _labelFor(url, method, body) {
    if (url.includes('/api/requests') && method === 'POST')   return 'Fertilizer request';
    if (url.includes('/api/distribute'))                       return 'Distribution record';
    if (url.includes('/api/acknowledge'))                      return 'Acknowledgement';
    if (url.includes('/api/inventory')  && method === 'POST') return 'Inventory update';
    if (url.includes('/api/seasons')    && method === 'POST') return 'New season';
    return `${method} ${url}`;
  }

  function _capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ─── Public API ─────────────────────────────────────────────────────────────
  return {
    init,
    apiFetch,
    flushQueue,
    hydrateCache,
    onStatusChange: (cb) => { _onStatusChange = cb; },
    isOnline: () => navigator.onLine,
  };

})();

window.SyncManager = SyncManager;
