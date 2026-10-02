"""
JARDA — PWA Service Worker
Offline-first architecture:
  • Static assets  → Cache-first
  • GET /api/*     → Network-first, IndexedDB fallback handled in page JS
  • POST /api/*    → Network → if offline, save to IDB offline_queue (page JS)
  • App shell      → Pre-cached on install
"""

const CACHE_NAME = 'jarda-shell-v1';
const API_CACHE  = 'jarda-api-v1';

// App shell files to pre-cache on install
const SHELL_FILES = [
  '/',
  '/app',
  '/manifest.json',
  '/static/js/db.js',
  '/static/js/sync.js',
  '/static/js/offline.js',
];

// ─── Install ────────────────────────────────────────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Pre-cache failed (ok in dev):', err))
  );
});

// ─── Activate ───────────────────────────────────────────────────────────────

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== API_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch ──────────────────────────────────────────────────────────────────

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // ── Static assets: Cache-first ──────────────────────────────────────────
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request, CACHE_NAME));
    return;
  }

  // ── App shell pages: Cache-first with network refresh ───────────────────
  if (url.pathname === '/' || url.pathname === '/app') {
    event.respondWith(staleWhileRevalidate(request, CACHE_NAME));
    return;
  }

  // ── GET /api/*: Network-first with offline response ─────────────────────
  if (url.pathname.startsWith('/api/') && request.method === 'GET') {
    event.respondWith(networkFirstApi(request));
    return;
  }

  // ── POST/PUT /api/*: Network-only; page JS handles offline queue ─────────
  // We pass through transparently — sync.js in the page intercepts offline
  // errors and stores them in IndexedDB's offline_queue store itself.

  // ── All other requests: Network with cache fallback ──────────────────────
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});

// ─── Background Sync ────────────────────────────────────────────────────────

self.addEventListener('sync', event => {
  if (event.tag === 'jarda-sync') {
    event.waitUntil(notifyClientsToSync());
  }
});

// Tell all open tabs to flush their offline queues
async function notifyClientsToSync() {
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(client => client.postMessage({ type: 'SYNC_REQUESTED' }));
}

// ─── Push Notifications (future use) ────────────────────────────────────────

self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : { title: 'JARDA', body: 'Update available' };
  event.waitUntil(
    self.registration.showNotification(data.title || 'JARDA FDS', {
      body: data.body || '',
      icon: '/static/icons/icon-192.png',
      badge: '/static/icons/icon-72.png',
    })
  );
});

// ─── Strategy helpers ────────────────────────────────────────────────────────

function isStaticAsset(url) {
  return url.pathname.startsWith('/static/') ||
         url.pathname === '/manifest.json' ||
         url.pathname === '/favicon.ico';
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkFetch = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  return cached || await networkFetch || offlineFallback();
}

async function networkFirstApi(request) {
  try {
    const response = await fetch(request);
    // Cache successful GET responses
    if (response.ok) {
      const cache = await caches.open(API_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Offline — return cached API response if we have one
    const cached = await caches.match(request, { cacheName: API_CACHE });
    if (cached) {
      // Clone and add offline header so page can show stale badge
      const body = await cached.json();
      return new Response(
        JSON.stringify({ ...body, _offline: true, _cached: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    // No cache — return empty offline response
    return new Response(
      JSON.stringify({ success: false, _offline: true, message: 'You are offline and no cached data is available.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

function offlineFallback() {
  return new Response(
    `<!DOCTYPE html><html><head><title>JARDA — Offline</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{font-family:sans-serif;text-align:center;padding:60px 20px;background:#f0fdf4}
    h1{color:#16a34a}p{color:#555}.icon{font-size:4rem}</style></head>
    <body><div class="icon">🌾</div>
    <h1>JARDA is offline</h1>
    <p>You are not connected to the internet.<br>Cached data is available — please reload once connected.</p>
    <button onclick="location.reload()" style="padding:10px 24px;background:#16a34a;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:1rem">Retry</button>
    </body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html' } }
  );
}
