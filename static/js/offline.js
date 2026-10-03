/**
 * JARDA — Offline UI
 * Handles:
 *   1. Service Worker registration
 *   2. Online/offline status banner
 *   3. Offline queue badge
 *   4. PWA install prompt
 */

(function () {

  // ─── Service Worker Registration ──────────────────────────────────────────

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then(reg => {
          console.log('[JARDA] Service Worker registered:', reg.scope);

          // Check for updates periodically
          setInterval(() => reg.update(), 60 * 60 * 1000); // every hour
        })
        .catch(err => console.warn('[JARDA] SW registration failed:', err));
    });
  }

  // ─── Create DOM elements ──────────────────────────────────────────────────

  function createBanner() {
    const banner = document.createElement('div');
    banner.id = 'jarda-offline-banner';
    banner.innerHTML = `
      <span id="jarda-status-icon">📶</span>
      <span id="jarda-status-text">Checking connection…</span>
      <span id="jarda-queue-badge" style="display:none;"></span>
    `;
    Object.assign(banner.style, {
      position:      'fixed',
      top:           '0',
      left:          '0',
      right:         '0',
      zIndex:        '99999',
      padding:       '8px 16px',
      display:       'flex',
      alignItems:    'center',
      gap:           '8px',
      fontSize:      '14px',
      fontFamily:    'system-ui, sans-serif',
      fontWeight:    '600',
      transition:    'transform 0.3s ease, opacity 0.3s ease',
      transform:     'translateY(-100%)',
      opacity:       '0',
    });
    document.body.appendChild(banner);
    return banner;
  }

  function createInstallBtn() {
    const btn = document.createElement('button');
    btn.id = 'jarda-install-btn';
    btn.innerHTML = '📲 Install App';
    Object.assign(btn.style, {
      position:     'fixed',
      bottom:       '20px',
      right:        '20px',
      zIndex:       '99998',
      padding:      '12px 20px',
      background:   '#16a34a',
      color:        '#fff',
      border:       'none',
      borderRadius: '50px',
      cursor:       'pointer',
      fontWeight:   '700',
      fontSize:     '14px',
      boxShadow:    '0 4px 16px rgba(0,0,0,0.25)',
      display:      'none',
      fontFamily:   'system-ui, sans-serif',
      transition:   'transform 0.2s',
    });
    btn.onmouseenter = () => btn.style.transform = 'scale(1.05)';
    btn.onmouseleave = () => btn.style.transform = 'scale(1)';
    document.body.appendChild(btn);
    return btn;
  }

  function createSyncDrawer() {
    const drawer = document.createElement('div');
    drawer.id = 'jarda-sync-drawer';
    drawer.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <strong>⏳ Pending Sync</strong>
        <button id="jarda-sync-close" style="background:none;border:none;cursor:pointer;font-size:18px;">✕</button>
      </div>
      <div id="jarda-sync-list"><p style="color:#888;font-size:13px;">No pending items.</p></div>
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button id="jarda-manual-sync" style="flex:1;padding:10px;background:#16a34a;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;">
          🔄 Sync Now
        </button>
        <button id="jarda-clear-failed" style="padding:10px 14px;background:#ef4444;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:12px;" title="Clear failed items">
          🗑 Clear
        </button>
      </div>
    `;
    Object.assign(drawer.style, {
      position:     'fixed',
      bottom:       '0',
      right:        '0',
      width:        '320px',
      background:   '#fff',
      borderRadius: '16px 0 0 0',
      boxShadow:    '0 -4px 24px rgba(0,0,0,0.15)',
      padding:      '20px',
      zIndex:       '99997',
      fontFamily:   'system-ui, sans-serif',
      fontSize:     '14px',
      transform:    'translateY(100%)',
      transition:   'transform 0.3s ease',
    });
    document.body.appendChild(drawer);
    return drawer;
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  let _deferredPrompt = null;
  let _banner, _installBtn, _syncDrawer;

  function init() {
    _banner      = createBanner();
    _installBtn  = createInstallBtn();
    _syncDrawer  = createSyncDrawer();

    // Wire up events
    document.getElementById('jarda-sync-close').onclick = closeSyncDrawer;
    document.getElementById('jarda-manual-sync').onclick = async () => {
      if (window.SyncManager) {
        document.getElementById('jarda-manual-sync').textContent = '🔄 Syncing…';
        await window.SyncManager.flushQueue();
        document.getElementById('jarda-manual-sync').textContent = '🔄 Sync Now';
        await refreshSyncList();
      }
    };
    document.getElementById('jarda-clear-failed').onclick = async () => {
      if (window.JardaDB) {
        const ops = await window.JardaDB.getPendingOps();
        for (const op of ops) {
          if (op.status === 'failed') await window.JardaDB.markOpSynced(op.id);
        }
        await refreshSyncList();
        if (window.SyncManager) await window.SyncManager.flushQueue();
      }
    };

    // Queue badge click → open drawer
    document.getElementById('jarda-queue-badge').onclick = openSyncDrawer;

    // PWA install
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      _deferredPrompt = e;
      _installBtn.style.display = 'block';
    });

    _installBtn.addEventListener('click', async () => {
      if (!_deferredPrompt) return;
      _deferredPrompt.prompt();
      const { outcome } = await _deferredPrompt.userChoice;
      if (outcome === 'accepted') _installBtn.style.display = 'none';
      _deferredPrompt = null;
    });

    window.addEventListener('appinstalled', () => {
      _installBtn.style.display = 'none';
    });

    // Network status events
    window.addEventListener('jarda:network-status', e => {
      updateBanner(e.detail.online, e.detail.queueCount);
    });

    window.addEventListener('jarda:sync-complete', () => {
      if (_syncDrawer.style.transform !== 'translateY(100%)') refreshSyncList();
    });

    // Initial status
    updateBanner(navigator.onLine, 0);
  }

  // ─── Banner logic ─────────────────────────────────────────────────────────

  let _bannerTimeout = null;

  function updateBanner(isOnline, queueCount) {
    const icon  = document.getElementById('jarda-status-icon');
    const text  = document.getElementById('jarda-status-text');
    const badge = document.getElementById('jarda-queue-badge');

    if (isOnline) {
      _banner.style.background = '#dcfce7';
      _banner.style.color      = '#15803d';
      icon.textContent         = '✅';
      text.textContent         = queueCount > 0
        ? `Online — syncing ${queueCount} queued item${queueCount > 1 ? 's' : ''}…`
        : 'Online';
    } else {
      _banner.style.background = '#fef9c3';
      _banner.style.color      = '#854d0e';
      icon.textContent         = '⚠️';
      text.textContent         = 'Offline — working from local data';
    }

    if (queueCount > 0) {
      badge.style.display  = 'inline-flex';
      badge.textContent    = `${queueCount} pending`;
      Object.assign(badge.style, {
        background:   '#dc2626',
        color:        '#fff',
        borderRadius: '12px',
        padding:      '2px 8px',
        fontSize:     '12px',
        cursor:       'pointer',
      });
    } else {
      badge.style.display = 'none';
    }

    // Show banner
    _banner.style.transform = 'translateY(0)';
    _banner.style.opacity   = '1';

    // Auto-hide when online + no queue after 3s
    clearTimeout(_bannerTimeout);
    if (isOnline && queueCount === 0) {
      _bannerTimeout = setTimeout(() => {
        _banner.style.transform = 'translateY(-100%)';
        _banner.style.opacity   = '0';
      }, 3000);
    }
  }

  // ─── Sync drawer ─────────────────────────────────────────────────────────

  function openSyncDrawer() {
    _syncDrawer.style.transform = 'translateY(0)';
    refreshSyncList();
  }

  function closeSyncDrawer() {
    _syncDrawer.style.transform = 'translateY(100%)';
  }

  async function refreshSyncList() {
    const list = document.getElementById('jarda-sync-list');
    if (!window.JardaDB) { list.innerHTML = '<p style="color:#888">IndexedDB not ready.</p>'; return; }

    const ops = await window.JardaDB.getPendingOps();
    if (!ops.length) {
      list.innerHTML = '<p style="color:#888;font-size:13px;">✓ Everything is synced.</p>';
      return;
    }

    list.innerHTML = ops.map(op => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f0f0f0;">
        <div>
          <div style="font-weight:600">${escapeHtml(op.label || op.url)}</div>
          <div style="color:#888;font-size:12px;">${new Date(op.timestamp).toLocaleString()}</div>
          ${op.error ? `<div style="color:#dc2626;font-size:11px;">⚠ ${escapeHtml(op.error)}</div>` : ''}
        </div>
        <span style="padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;
          background:${op.status === 'failed' ? '#fee2e2' : '#fef9c3'};
          color:${op.status === 'failed' ? '#b91c1c' : '#854d0e'}">
          ${op.status}
        </span>
      </div>
    `).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // ─── Start ────────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
