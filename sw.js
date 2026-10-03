/**
 * JARDA — PWA Service Worker
 * Offline-first architecture:
 *   • Static assets  → Cache-first
 *   • GET /api/*     → Network-first, IndexedDB fallback handled in page JS
 *   • POST /api/*    → Network → if offline, save to IDB offline_queue (page JS)
 *   • App shell      → Pre-cached on install, Network-first with Cache fallback
 */

const CACHE_NAME = 'jarda-shell-v3';
const API_CACHE  = 'jarda-api-v3';
const CDN_CACHE  = 'jarda-cdn-v1';

// App shell files to pre-cache on install
const SHELL_FILES = [
  '/',
  '/app',
  '/manifest.json',
  '/favicon.ico',
  '/static/js/db.js',
  '/static/js/sync.js',
  '/static/js/offline.js',
  '/static/icons/icon-72.png',
  '/static/icons/icon-96.png',
  '/static/icons/icon-128.png',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
];

// ─── Install ────────────────────────────────────────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Pre-cache failed (continuing anyway):', err))
  );
});

// ─── Activate ───────────────────────────────────────────────────────────────

self.addEventListener('activate', event => {
  const allowedCaches = [CACHE_NAME, API_CACHE, CDN_CACHE];
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => !allowedCaches.includes(k))
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch ──────────────────────────────────────────────────────────────────

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // ── Handle Third-Party CDNs (Bootstrap, jQuery, AdminLTE, SweetAlert2, Google Fonts)
  if (isCdnAsset(url)) {
    event.respondWith(staleWhileRevalidate(request, CDN_CACHE));
    return;
  }

  // Only handle same-origin requests past this point
  if (url.origin !== self.location.origin) return;

  // ── Static assets: Cache-first
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request, CACHE_NAME));
    return;
  }

  // ── App shell pages: Network-first with cache fallback
  if (url.pathname === '/' || url.pathname === '/app') {
    event.respondWith(networkFirstPage(request, CACHE_NAME));
    return;
  }

  // ── GET /api/*: Network-first with offline cached response
  if (url.pathname.startsWith('/api/') && request.method === 'GET') {
    event.respondWith(networkFirstApi(request));
    return;
  }

  // ── POST/PUT /api/*: Let network handle; SyncManager in page intercepts offline
  if (request.method !== 'GET') {
    return;
  }

  // ── All other same-origin requests: Network with cache fallback
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

function isCdnAsset(url) {
  const host = url.hostname;
  return host.includes('jsdelivr.net') ||
         host.includes('jquery.com') ||
         host.includes('cloudflare.com') ||
         host.includes('googleapis.com') ||
         host.includes('gstatic.com');
}

function isStaticAsset(url) {
  return url.pathname.startsWith('/static/') ||
         url.pathname === '/manifest.json' ||
         url.pathname === '/favicon.ico';
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    return cached || offlineFallback();
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(networkResponse => {
    if (networkResponse && (networkResponse.ok || networkResponse.type === 'opaque')) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  }).catch(err => {
    console.debug('[SW] CDN offline fetch ignored:', request.url);
    return null;
  });

  return cached || (await fetchPromise);
}

async function networkFirstPage(request, cacheName) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    return offlineFallback();
  }
}

async function networkFirstApi(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(API_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (netErr) {
    // Offline — return cached API response if available
    const cached = await caches.match(request, { cacheName: API_CACHE });
    if (cached) {
      try {
        const body = await cached.json();
        return new Response(
          JSON.stringify({ ...body, _offline: true, _cached: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      } catch (parseErr) {
        return cached;
      }
    }
    // No cache — return structured empty response instead of failing
    return new Response(
      JSON.stringify({
        success: true,
        data: [],
        _offline: true,
        _empty: true,
        message: 'Offline mode — using local IndexedDB database.',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

function offlineFallback() {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>JARDA FDS — Offline</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; text-align: center; padding: 60px 20px; background: #f0fdf4; color: #1f2937; }
    h1 { color: #16a34a; font-size: 1.8rem; margin-bottom: 8px; }
    p { color: #4b5563; font-size: 1rem; max-width: 400px; margin: 0 auto 24px; line-height: 1.5; }
    .icon { font-size: 4rem; margin-bottom: 16px; }
    .btn { display: inline-block; padding: 12px 28px; background: #16a34a; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; cursor: pointer; border: none; font-size: 1rem; box-shadow: 0 4px 12px rgba(22,163,74,0.3); }
    .btn:hover { background: #15803d; }
  </style>
</head>
<body>
  <div class="icon">🌾</div>
  <h1>JARDA FDS — Offline Mode</h1>
  <p>You are currently offline or in an area with poor connectivity.<br>Cached app data remains accessible.</p>
  <button class="btn" onclick="location.reload()">Reload Application</button>
</body>
</html>`,
    { status: 200, headers: { 'Content-Type': 'text/html' } }
  );
}
