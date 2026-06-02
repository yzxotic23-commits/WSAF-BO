/**
 * Lightweight runtime patches for FeedFlow UI (no React source rebuild).
 */
(function () {
  'use strict';

  const API = (() => {
    try {
      if (window.desktop?.apiUrl) return window.desktop.apiUrl.replace(/\/$/, '');
    } catch { /* noop */ }
    return 'http://127.0.0.1:47821';
  })();

  const MODAL_GUARD_MS = 320;
  const DOM_FIX_DEBOUNCE_MS = 120;

  let domFixTimer = null;

  function isModalOpen() {
    return !!document.querySelector('.modal-backdrop, .wa-modal-backdrop');
  }

  /** Prevent same-click that opened Settings from closing the backdrop immediately */
  function stampModalBackdrops() {
    document.querySelectorAll('.modal-backdrop, .wa-modal-backdrop').forEach((el) => {
      if (!el.dataset.ffOpenedAt) {
        el.dataset.ffOpenedAt = String(Date.now());
      }
    });
  }

  function guardModalGhostClick(e) {
    const backdrop = e.target.closest('.modal-backdrop, .wa-modal-backdrop');
    if (!backdrop) return;

    const openedAt = parseInt(backdrop.dataset.ffOpenedAt || '0', 10);
    if (openedAt && Date.now() - openedAt < MODAL_GUARD_MS) {
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }

  /** Keep stat pills on one row after dynamic pair-count changes */
  function stabilizeStatPills() {
    document.querySelectorAll('.wa-list-header-stats').forEach((el) => {
      el.style.flexWrap = 'nowrap';
      el.style.alignItems = 'center';
    });
  }

  /** Remove redundant topbar title node (brand already shown in sidebar) */
  function hideDuplicateTopbarTitle() {
    document.querySelectorAll('.wa-main-topbar-title').forEach((el) => {
      el.setAttribute('aria-hidden', 'true');
      el.style.display = 'none';
    });
  }

  /** Normalize toolbar button frames (sidebar toolbar only — skip header settings gear) */
  function fixToolbarButtons() {
    document.querySelectorAll('.wa-toolbar-btn, .wa-icon-btn').forEach((btn) => {
      btn.style.boxSizing = 'border-box';
      const svg = btn.querySelector('svg');
      if (svg) {
        svg.setAttribute('width', btn.classList.contains('wa-icon-btn--sm') ? '18' : '20');
        svg.setAttribute('height', btn.classList.contains('wa-icon-btn--sm') ? '18' : '20');
      }
    });
  }

  /** FeedFlow logo — user's PNG asset (transparent background) */
  function syncOfficialLogo() {
    const LOGO_SRC = './assets/feedflow-logo.png';
    document.querySelectorAll('.wa-app-logo').forEach((el) => {
      if (el.querySelector('img.ff-logo-img')) {
        const size = el.classList.contains('wa-app-logo--header')
          ? 44
          : el.classList.contains('wa-app-logo--empty')
            ? 56
            : parseInt(el.style.width, 10) || 48;
        const img = el.querySelector('img.ff-logo-img');
        img.setAttribute('width', String(size));
        img.setAttribute('height', String(size));
        return;
      }

      const isHeader = el.classList.contains('wa-app-logo--header');
      const isEmpty = el.classList.contains('wa-app-logo--empty');
      const size = isHeader ? 44 : isEmpty ? 56 : (parseInt(el.style.width, 10) || 48);

      el.style.width = size + 'px';
      el.style.height = size + 'px';
      el.setAttribute('data-ff-logo-official', 'png');
      el.innerHTML =
        '<img class="ff-logo-img" src="' + LOGO_SRC + '" alt="" width="' + size + '" height="' + size + '" draggable="false" decoding="async" />';
    });
  }

  function applyDomFixes() {
    stampModalBackdrops();
    if (isModalOpen()) return;

    hideDuplicateTopbarTitle();
    stabilizeStatPills();
    fixToolbarButtons();
    syncOfficialLogo();
  }

  function scheduleDomFixes() {
    stampModalBackdrops();
    if (domFixTimer) clearTimeout(domFixTimer);
    domFixTimer = setTimeout(() => {
      domFixTimer = null;
      applyDomFixes();
    }, DOM_FIX_DEBOUNCE_MS);
  }

  /** Re-check when app window becomes visible (complements Electron scheduler) */
  function setupAutoUpdatePolling() {
    const CHECK_MS = 4 * 60 * 60 * 1000;

    async function fetchUpdate() {
      try {
        await fetch(`${API}/api/update/check`, { method: 'POST' });
      } catch {
        /* offline / dev */
      }
    }

    setInterval(fetchUpdate, CHECK_MS);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') fetchUpdate();
    });
  }

  function boot() {
    document.addEventListener('mousedown', guardModalGhostClick, true);
    document.addEventListener('click', guardModalGhostClick, true);

    applyDomFixes();
    setupAutoUpdatePolling();

    document.documentElement.style.zoom = '1';
    document.body.style.zoom = '1';

    const root = document.getElementById('root');
    if (root && typeof MutationObserver !== 'undefined') {
      const obs = new MutationObserver(() => scheduleDomFixes());
      obs.observe(root, { childList: true, subtree: true });
    } else {
      setInterval(applyDomFixes, 3000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
