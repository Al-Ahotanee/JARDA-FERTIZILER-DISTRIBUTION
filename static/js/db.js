/**
 * JARDA — IndexedDB wrapper
 * Single source of truth for all local offline storage.
 *
 * Stores:
 *   farmers       – farmer records
 *   seasons       – distribution seasons
 *   inventory     – fertilizer stock
 *   requests      – farmer requests / allocations
 *   distributions – completed distributions
 *   offline_queue – pending operations (POST/PUT) to sync
 *   cache_meta    – last-sync timestamps per store
 */

const JARDA_DB_NAME    = 'jarda-offline';
const JARDA_DB_VERSION = 2;

let _db = null;

// ─── Open / initialise ───────────────────────────────────────────────────────

function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(JARDA_DB_NAME, JARDA_DB_VERSION);

    req.onupgradeneeded = e => {
      const db = e.target.result;

      // Entity stores
      if (!db.objectStoreNames.contains('farmers'))
        db.createObjectStore('farmers', { keyPath: 'id' });

      if (!db.objectStoreNames.contains('seasons'))
        db.createObjectStore('seasons', { keyPath: 'id' });

      if (!db.objectStoreNames.contains('inventory'))
        db.createObjectStore('inventory', { keyPath: 'id' });

      // Requests store with search indexes
      let reqStore;
      if (!db.objectStoreNames.contains('requests')) {
        reqStore = db.createObjectStore('requests', { keyPath: 'id' });
      } else {
        reqStore = req.transaction.objectStore('requests');
      }
      if (!reqStore.indexNames.contains('by_farmer'))
        reqStore.createIndex('by_farmer', 'farmer_id', { unique: false });
      if (!reqStore.indexNames.contains('by_season'))
        reqStore.createIndex('by_season', 'season_id', { unique: false });
      if (!reqStore.indexNames.contains('by_status'))
        reqStore.createIndex('by_status', 'status', { unique: false });

      // Distributions store
      let distStore;
      if (!db.objectStoreNames.contains('distributions')) {
        distStore = db.createObjectStore('distributions', { keyPath: 'id' });
      } else {
        distStore = req.transaction.objectStore('distributions');
      }
      if (!distStore.indexNames.contains('by_officer'))
        distStore.createIndex('by_officer', 'officer_id', { unique: false });

      // Offline queue — auto-increment id
      if (!db.objectStoreNames.contains('offline_queue')) {
        const qs = db.createObjectStore('offline_queue', { keyPath: 'id', autoIncrement: true });
        qs.createIndex('by_status', 'status', { unique: false });
      }

      // Metadata (last sync times, etc.)
      if (!db.objectStoreNames.contains('cache_meta'))
        db.createObjectStore('cache_meta', { keyPath: 'key' });

      // Generic Key-Value store for locations & dashboard stats
      if (!db.objectStoreNames.contains('locations'))
        db.createObjectStore('locations', { keyPath: 'key' });

      if (!db.objectStoreNames.contains('stats'))
        db.createObjectStore('stats', { keyPath: 'key' });
    };

    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = e => reject(e.target.error);
  });
}

// ─── Generic CRUD helpers ────────────────────────────────────────────────────

async function dbGetAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function dbGet(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function dbPut(storeName, record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function dbPutMany(storeName, records) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    records.forEach(r => store.put(r));
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function dbDelete(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

async function dbClear(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).clear();
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ─── Cache-meta helpers ──────────────────────────────────────────────────────

async function setLastSync(storeName) {
  await dbPut('cache_meta', { key: `last_sync_${storeName}`, value: Date.now() });
}

async function getLastSync(storeName) {
  const meta = await dbGet('cache_meta', `last_sync_${storeName}`);
  return meta ? meta.value : null;
}

// ─── Offline queue ───────────────────────────────────────────────────────────

/**
 * Add a pending operation to the offline queue.
 * @param {string} method   HTTP method: 'POST' | 'PUT' | 'PATCH'
 * @param {string} url      Relative API URL e.g. '/api/requests'
 * @param {object} body     Request body
 * @param {string} label    Human-readable description e.g. 'Submit request'
 */
async function enqueueOfflineOp(method, url, body, label = '') {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('offline_queue', 'readwrite');
    const req = tx.objectStore('offline_queue').add({
      method,
      url,
      body,
      label,
      status:    'pending',
      timestamp: Date.now(),
      attempts:  0,
    });
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function getPendingOps() {
  const all = await dbGetAll('offline_queue');
  return all.filter(op => op.status === 'pending' || op.status === 'failed');
}

async function markOpSynced(id) {
  await dbDelete('offline_queue', id);
}

async function markOpFailed(id, errorMsg) {
  const op = await dbGet('offline_queue', id);
  if (op) {
    await dbPut('offline_queue', {
      ...op,
      status:   'failed',
      attempts: (op.attempts || 0) + 1,
      error:    errorMsg,
    });
  }
}

async function clearSyncedOps() {
  const all = await dbGetAll('offline_queue');
  for (const op of all) {
    if (op.status === 'synced') await dbDelete('offline_queue', op.id);
  }
}

// ─── Query & Offline helpers ─────────────────────────────────────────────────

async function getRequestsByFarmer(farmerId) {
  const all = await dbGetAll('requests');
  return all.filter(r => String(r.farmer_id) === String(farmerId));
}

async function getPendingDistributions() {
  const all = await dbGetAll('requests');
  return all.filter(r => r.status === 'approved');
}

async function updateRequestStatus(requestId, status, fields = {}) {
  const req = await dbGet('requests', Number(requestId)) || await dbGet('requests', String(requestId));
  if (req) {
    const updated = { ...req, status, ...fields };
    await dbPut('requests', updated);
    return updated;
  }
  return null;
}

async function verifyQrOffline(qrData) {
  let parsed = qrData;
  if (typeof qrData === 'string') {
    try { parsed = JSON.parse(qrData); } catch (e) { return { success: false, message: 'Invalid QR format' }; }
  }
  const reqId = parsed.request_id;
  const hash = parsed.blockchain_hash;
  if (!reqId || !hash) return { success: false, message: 'Missing fields in QR' };

  const req = await dbGet('requests', Number(reqId)) || await dbGet('requests', String(reqId));
  if (!req) return { success: false, message: 'Allocation not found in local offline storage' };
  if (req.blockchain_hash && req.blockchain_hash !== hash) {
    return { success: false, message: 'Security verification failed: hash mismatch' };
  }
  if (req.status === 'distributed') return { success: false, message: 'Already distributed' };
  if (req.status === 'completed') return { success: false, message: 'Already completed' };
  if (req.status !== 'approved') return { success: false, message: `Status is ${req.status}, not approved` };

  return { success: true, data: req };
}

// ─── High-level store accessors ──────────────────────────────────────────────

const JardaDB = {
  // Farmers
  getFarmers:       ()         => dbGetAll('farmers'),
  getFarmer:        (id)       => dbGet('farmers', id),
  saveFarmers:      (rows)     => dbPutMany('farmers', rows),
  saveFarmer:       (row)      => dbPut('farmers', row),

  // Seasons
  getSeasons:       ()         => dbGetAll('seasons'),
  saveSeasons:      (rows)     => dbPutMany('seasons', rows),
  saveSeason:       (row)      => dbPut('seasons', row),

  // Inventory
  getInventory:     ()         => dbGetAll('inventory'),
  saveInventory:    (rows)     => dbPutMany('inventory', rows),

  // Requests
  getRequests:      ()         => dbGetAll('requests'),
  getRequest:       (id)       => dbGet('requests', id),
  getRequestsByFarmer,
  getPendingDistributions,
  updateRequestStatus,
  verifyQrOffline,
  saveRequests:     (rows)     => dbPutMany('requests', rows),
  saveRequest:      (row)      => dbPut('requests', row),

  // Distributions
  getDistributions: ()         => dbGetAll('distributions'),
  saveDistributions:(rows)     => dbPutMany('distributions', rows),
  saveDistribution: (row)      => dbPut('distributions', row),

  // Locations & Stats KV cache
  getLocations:     (key)      => dbGet('locations', key).then(r => r ? r.data : null),
  saveLocations:    (key, data)=> dbPut('locations', { key, data, timestamp: Date.now() }),
  getStats:         (key)      => dbGet('stats', key).then(r => r ? r.data : null),
  saveStats:        (key, data)=> dbPut('stats', { key, data, timestamp: Date.now() }),

  // Offline queue
  enqueue:          (method, url, body, label) => enqueueOfflineOp(method, url, body, label),
  getPendingOps,
  markOpSynced,
  markOpFailed,
  clearSyncedOps,

  // Cache meta
  setLastSync,
  getLastSync,
};

// Make available globally
window.JardaDB = JardaDB;

