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
    if (e.target.closest('.modal, .wa-modal')) return;

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
    if (isModalOpen()) {
      patchSettingsModal();
      return;
    }
    if (domFixTimer) clearTimeout(domFixTimer);
    domFixTimer = setTimeout(() => {
      domFixTimer = null;
      applyDomFixes();
    }, DOM_FIX_DEBOUNCE_MS);
  }

  async function apiJson(path, options) {
    const res = await fetch(`${API}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || `Request failed (${res.status})`);
    return data;
  }

  function getSettingsModal() {
    return document.querySelector('.modal-backdrop .modal');
  }

  function restoreNativePanels(modal) {
    modal.querySelectorAll('.modal-body > [role="tabpanel"]:not(.ff-proxy-panel)').forEach((panel) => {
      panel.hidden = false;
      panel.style.removeProperty('display');
    });
  }

  function showSettingsToast(modal, type, message) {
    const header = modal.querySelector('.modal-header');
    if (!header) return;

    let group = header.querySelector('.ff-settings-header-title');
    const h2 = header.querySelector('h2');
    if (!group && h2) {
      group = document.createElement('div');
      group.className = 'ff-settings-header-title';
      h2.parentNode.insertBefore(group, h2);
      group.appendChild(h2);
    }

    modal.querySelectorAll('.form-actions .ff-settings-toast').forEach((el) => el.remove());

    let sep = (group || header).querySelector('.ff-settings-saved-sep');
    if (!sep) {
      sep = document.createElement('span');
      sep.className = 'ff-settings-saved-sep';
      sep.setAttribute('aria-hidden', 'true');
      sep.hidden = true;
    }

    let toast = header.querySelector('.ff-settings-toast');
    if (!toast) {
      toast = document.createElement('span');
      toast.className = 'ff-settings-toast';
      toast.setAttribute('role', 'status');
      toast.hidden = true;
    }

    if (group) {
      group.appendChild(sep);
      group.appendChild(toast);
    } else {
      header.appendChild(sep);
      header.appendChild(toast);
    }

    toast.className = `ff-settings-toast ff-settings-toast--${type}`;
    toast.textContent = message;
    toast.hidden = false;
    sep.hidden = false;

    if (type === 'success') {
      window.clearTimeout(toast._ffHideTimer);
      toast._ffHideTimer = window.setTimeout(() => {
        toast.hidden = true;
        sep.hidden = true;
      }, 4000);
    }
  }

  function readFeedingForm(panel) {
    const numbers = panel.querySelectorAll('input[type="number"]');
    const select = panel.querySelector('select');
    return {
      MAX_MESSAGES: numbers[0]?.value ?? '20',
      MIN_DELAY: numbers[1]?.value ?? '30',
      MAX_DELAY: numbers[2]?.value ?? '90',
      LANGUAGE: select?.value ?? 'English',
    };
  }

  function patchFeedingSave(modal) {
    const panel = modal.querySelector('[aria-label="Feeding"]');
    if (!panel) return;

    const saveBtn = panel.querySelector('.form-actions .btn-primary');
    if (!saveBtn || saveBtn.dataset.ffSavePatched) return;
    saveBtn.dataset.ffSavePatched = '1';

    saveBtn.addEventListener(
      'click',
      async (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        if (saveBtn.disabled) return;
        saveBtn.disabled = true;

        try {
          const updates = readFeedingForm(panel);
          await apiJson('/api/settings/env', {
            method: 'POST',
            body: JSON.stringify({ updates }),
          });
          if (window.desktop?.reloadEnv) await window.desktop.reloadEnv();
          showSettingsToast(modal, 'success', 'Saved');
        } catch (err) {
          showSettingsToast(modal, 'error', err.message || 'Save failed');
        } finally {
          saveBtn.disabled = false;
        }
      },
      true
    );
  }

  async function loadProxyTextarea(modal) {
    const textarea = modal.querySelector('.ff-proxy-textarea');
    if (!textarea || textarea.dataset.ffDirty === '1') return;

    try {
      const data = await apiJson('/api/settings');
      textarea.value = data.proxies || '';
    } catch {
      /* keep current draft */
    }
  }

  function hideProxyPanel(modal) {
    const panel = modal.querySelector('.ff-proxy-panel');
    const tab = modal.querySelector('.ff-proxy-tab');
    if (panel) {
      panel.hidden = true;
      panel.style.display = 'none';
    }
    if (tab) {
      tab.classList.remove('active');
      tab.setAttribute('aria-selected', 'false');
    }
    restoreNativePanels(modal);
  }

  function showProxyPanel(modal) {
    modal.querySelectorAll('.modal-body > [role="tabpanel"]:not(.ff-proxy-panel)').forEach((panel) => {
      panel.style.display = 'none';
    });
    modal.querySelectorAll('.modal-tabs .tab:not(.ff-proxy-tab)').forEach((tab) => {
      tab.classList.remove('active');
      tab.setAttribute('aria-selected', 'false');
    });

    const panel = modal.querySelector('.ff-proxy-panel');
    const tab = modal.querySelector('.ff-proxy-tab');
    if (panel) {
      panel.hidden = false;
      panel.style.display = '';
    }
    if (tab) {
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
    }
    loadProxyTextarea(modal);
  }

  function patchProxyTab(modal) {
    if (modal.dataset.ffProxyTab) return;
    modal.dataset.ffProxyTab = '1';

    const tabsNav = modal.querySelector('.modal-tabs');
    const modalBody = modal.querySelector('.modal-body');
    if (!tabsNav || !modalBody) return;

    const proxyTab = document.createElement('button');
    proxyTab.type = 'button';
    proxyTab.role = 'tab';
    proxyTab.className = 'tab ff-proxy-tab';
    proxyTab.setAttribute('aria-selected', 'false');
    proxyTab.textContent = 'Proxy';
    proxyTab.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showProxyPanel(modal);
    });
    tabsNav.appendChild(proxyTab);

    const panel = document.createElement('div');
    panel.className = 'ff-proxy-panel';
    panel.hidden = true;
    panel.style.display = 'none';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-label', 'Proxy');
    panel.innerHTML =
      '<p class="hint">One proxy per line. Format: <code>socks5://user:pass@ip:port</code>.</p>' +
      '<label class="field ff-proxy-field">' +
      '<span>Proxy list (IP per account)</span>' +
      '<textarea class="textarea ff-proxy-textarea" spellcheck="false" placeholder="socks5://user:pass@193.8.114.78:1081"></textarea>' +
      '</label>' +
      '<div class="form-actions">' +
      '<button type="button" class="btn btn-primary ff-proxy-save">Save</button>' +
      '<button type="button" class="btn btn-ghost ff-proxy-probe">Test proxies</button>' +
      '</div>';

    modalBody.appendChild(panel);

    const textarea = panel.querySelector('.ff-proxy-textarea');
    textarea.addEventListener('input', () => {
      textarea.dataset.ffDirty = '1';
    });

    tabsNav.querySelectorAll('.tab:not(.ff-proxy-tab)').forEach((tab) => {
      tab.addEventListener('click', () => {
        hideProxyPanel(modal);
      });
    });

    panel.querySelector('.ff-proxy-save').addEventListener('click', async () => {
      const saveBtn = panel.querySelector('.ff-proxy-save');
      const probeBtn = panel.querySelector('.ff-proxy-probe');
      saveBtn.disabled = true;
      probeBtn.disabled = true;
      try {
        await apiJson('/api/settings/proxies', {
          method: 'POST',
          body: JSON.stringify({ content: textarea.value }),
        });
        await apiJson('/api/proxies/load', { method: 'POST' });
        textarea.dataset.ffDirty = '0';
        showSettingsToast(modal, 'success', 'Saved');
      } catch (err) {
        showSettingsToast(modal, 'error', err.message || 'Save failed');
      } finally {
        saveBtn.disabled = false;
        probeBtn.disabled = false;
      }
    });

    panel.querySelector('.ff-proxy-probe').addEventListener('click', async () => {
      const saveBtn = panel.querySelector('.ff-proxy-save');
      const probeBtn = panel.querySelector('.ff-proxy-probe');
      saveBtn.disabled = true;
      probeBtn.disabled = true;
      try {
        const results = await apiJson('/api/proxies/probe', { method: 'POST' });
        const ok = (results || []).filter((r) => r.ok).length;
        const total = (results || []).length;
        showSettingsToast(modal, 'success', `Probe selesai — ${ok}/${total} proxy OK`);
      } catch (err) {
        showSettingsToast(modal, 'error', err.message || 'Probe failed');
      } finally {
        saveBtn.disabled = false;
        probeBtn.disabled = false;
      }
    });

    loadProxyTextarea(modal);
  }

  function patchSettingsModal() {
    const modal = getSettingsModal();
    if (!modal) return;
    patchFeedingSave(modal);
    patchProxyTab(modal);
    patchClearSessionsConfirm(modal);
  }

  function closeAllSettingsModals() {
    const backdrop = document.querySelector('.modal-backdrop');
    if (!backdrop) return;
    const closeBtn = backdrop.querySelector('.modal-header .icon-btn[aria-label="Close"]');
    if (closeBtn) closeBtn.click();
  }

  function patchClearSessionsConfirm(modal) {
    const root = modal.closest('.modal-backdrop');
    if (!root) return;

    const confirm = root.querySelector('.wa-modal-backdrop');
    if (!confirm) return;

    const title = confirm.querySelector('#wa-modal-title');
    if (!title || !/clear all sessions/i.test(title.textContent)) return;

    if (confirm.dataset.ffClearHook) return;
    confirm.dataset.ffClearHook = '1';

    const confirmBtn = [...confirm.querySelectorAll('button')].find((b) =>
      /^clear all$/i.test(b.textContent.trim())
    );
    if (!confirmBtn || confirmBtn.dataset.ffClearClick) return;
    confirmBtn.dataset.ffClearClick = '1';

    confirmBtn.addEventListener('click', () => {
      window.setTimeout(closeAllSettingsModals, 500);
    });
  }

  function setupSessionsClearAutoClose() {
    if (window.__ffFetchPatched) return;
    window.__ffFetchPatched = true;

    const nativeFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      const response = await nativeFetch(input, init);
      try {
        const url = typeof input === 'string' ? input : input?.url || '';
        const method = (init?.method || 'GET').toUpperCase();
        if (url.includes('/api/sessions/clear-all') && method === 'POST' && response.ok) {
          window.setTimeout(closeAllSettingsModals, 80);
        }
      } catch { /* noop */ }
      return response;
    };
  }

  let wasFeedingActive = false;
  let lastCompleteShownAt = null;

  function removeFeedingCompleteUI() {
    document.querySelectorAll('.ff-feeding-complete').forEach((el) => el.remove());
  }

  function showFeedingCompleteUI(data) {
    const main = document.querySelector('.wa-main');
    if (!main || !data?.at) return;

    if (lastCompleteShownAt === data.at) return;
    try {
      if (sessionStorage.getItem('ff-last-complete-at') === data.at) return;
    } catch { /* noop */ }

    removeFeedingCompleteUI();
    lastCompleteShownAt = data.at;

    const success = data.success !== false && !data.manualStop;
    const title = success ? 'Feeding selesai' : 'Feeding dihentikan';
    const subtitle = success
      ? 'Semua pair AI chat telah selesai. Sesi tersimpan di PC ini.'
      : 'Feeding berhenti sebelum selesai. Anda bisa mulai lagi kapan saja.';

    const overlay = document.createElement('div');
    overlay.className = 'ff-feeding-complete';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.innerHTML =
      '<div class="ff-feeding-complete-backdrop"></div>' +
      '<div class="ff-feeding-complete-card' + (success ? '' : ' ff-feeding-complete-card--stopped') + '">' +
      '<div class="ff-feeding-complete-icon" aria-hidden="true">' + (success ? '✓' : '■') + '</div>' +
      '<h2 class="ff-feeding-complete-title">' + title + '</h2>' +
      '<p class="ff-feeding-complete-sub">' + subtitle + '</p>' +
      '<div class="ff-feeding-complete-stats">' +
      '<div class="ff-feeding-complete-stat"><span class="ff-feeding-complete-stat-value">' + (data.completed ?? 0) + '</span><span class="ff-feeding-complete-stat-label">Pair selesai</span></div>' +
      '<div class="ff-feeding-complete-stat"><span class="ff-feeding-complete-stat-value">' + (data.messagesSent ?? 0) + '</span><span class="ff-feeding-complete-stat-label">Pesan terkirim</span></div>' +
      '<div class="ff-feeding-complete-stat"><span class="ff-feeding-complete-stat-value">' + (data.totalPairs ?? 0) + '</span><span class="ff-feeding-complete-stat-label">Total pair</span></div>' +
      '</div>' +
      '<button type="button" class="btn btn-primary ff-feeding-complete-ok">OK</button>' +
      '</div>';

    main.appendChild(overlay);

    overlay.querySelector('.ff-feeding-complete-ok').addEventListener('click', () => {
      try {
        sessionStorage.setItem('ff-last-complete-at', data.at);
      } catch { /* noop */ }
      apiJson('/api/feeding/complete/dismiss', { method: 'POST' }).catch(() => {});
      overlay.remove();
    });

    overlay.querySelector('.ff-feeding-complete-backdrop').addEventListener('click', () => {
      overlay.querySelector('.ff-feeding-complete-ok').click();
    });
  }

  async function pollFeedingComplete() {
    try {
      const status = await apiJson('/api/status');
      const running = !!(status.feedingRunning || status.feedingStarting);
      const complete = status.lastFeedingComplete;

      if (running) {
        if (document.querySelector('.ff-feeding-complete')) {
          removeFeedingCompleteUI();
          lastCompleteShownAt = null;
        }
        wasFeedingActive = true;
        return;
      }

      if (wasFeedingActive && complete && !complete.dismissed) {
        showFeedingCompleteUI(complete);
      }

      wasFeedingActive = false;
    } catch {
      /* API belum siap */
    }
  }

  function setupFeedingCompleteWatcher() {
    pollFeedingComplete();
    setInterval(pollFeedingComplete, 1500);
  }

  /** Corner update toast — Later / Update Now */
  function setupUpdateCornerToast() {
    let toastEl = null;
    let pollTimer = null;
    let lastState = null;

    function getDismissedVersion() {
      try {
        return sessionStorage.getItem('ff-update-dismissed') || '';
      } catch {
        return '';
      }
    }

    function setDismissedVersion(version) {
      try {
        sessionStorage.setItem('ff-update-dismissed', version || '');
      } catch { /* noop */ }
    }

    function removeToast() {
      if (toastEl) toastEl.remove();
      toastEl = null;
    }

    function shouldShow(state) {
      if (!state?.enabled) return false;
      if (state.status === 'disabled' || state.status === 'idle' || state.status === 'checking') return false;
      if (state.status === 'not-available') return false;
      if (state.status === 'error') return false;
      if (state.status === 'downloaded') return true;
      const ver = state.latestVersion || '';
      return getDismissedVersion() !== ver;
    }

    function bindToastActions(state) {
      const ghost = toastEl.querySelector('.ff-update-toast__btn--ghost');
      const primary = toastEl.querySelector('.ff-update-toast__btn--primary');
      if (!ghost || !primary || ghost.dataset.ffBound) return;
      ghost.dataset.ffBound = '1';
      primary.dataset.ffBound = '1';

      ghost.addEventListener('click', () => {
        setDismissedVersion(state.latestVersion || state.currentVersion || '1');
        removeToast();
      });

      primary.addEventListener('click', async () => {
        const current = lastState;
        if (!current || current.status !== 'downloaded') return;
        primary.disabled = true;
        primary.textContent = 'Installing…';
        try {
          await apiJson('/api/update/install', { method: 'POST' });
        } catch (err) {
          primary.disabled = false;
          primary.textContent = 'Update Now';
          const subEl = toastEl.querySelector('.ff-update-toast__sub');
          if (subEl) subEl.textContent = err.message || 'Install failed';
        }
      });
    }

    function renderToast(state) {
      lastState = state;
      if (!shouldShow(state)) {
        removeToast();
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        return;
      }

      if (!pollTimer && (state.status === 'available' || state.status === 'downloading')) {
        pollTimer = setInterval(refreshUpdateState, 3000);
      }
      if (pollTimer && state.status === 'downloaded') {
        clearInterval(pollTimer);
        pollTimer = null;
      }

      const ready = state.status === 'downloaded';
      const downloading = state.status === 'downloading';
      const title = ready ? 'Update ready' : 'Update available';
      const sub = ready
        ? `v${state.latestVersion} — restart to install`
        : downloading
          ? `v${state.latestVersion} · downloading ${state.percent || 0}%`
          : `v${state.currentVersion} → v${state.latestVersion}`;

      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.className = 'ff-update-toast';
        toastEl.setAttribute('role', 'status');
        toastEl.setAttribute('aria-live', 'polite');
        document.body.appendChild(toastEl);
      }

      let titleEl = toastEl.querySelector('.ff-update-toast__title');
      let subEl = toastEl.querySelector('.ff-update-toast__sub');
      let barFill = toastEl.querySelector('.ff-update-toast__bar-fill');
      let primary = toastEl.querySelector('.ff-update-toast__btn--primary');

      if (!titleEl) {
        toastEl.innerHTML =
          '<div class="ff-update-toast__content">' +
          '<strong class="ff-update-toast__title"></strong>' +
          '<span class="ff-update-toast__sub"></span>' +
          '</div>' +
          '<div class="ff-update-toast__actions">' +
          '<button type="button" class="ff-update-toast__btn ff-update-toast__btn--ghost">Later</button>' +
          '<button type="button" class="ff-update-toast__btn ff-update-toast__btn--primary">Update Now</button>' +
          '</div>';
        titleEl = toastEl.querySelector('.ff-update-toast__title');
        subEl = toastEl.querySelector('.ff-update-toast__sub');
        primary = toastEl.querySelector('.ff-update-toast__btn--primary');
        bindToastActions(state);
      }

      titleEl.textContent = title;
      subEl.textContent = sub;

      let bar = toastEl.querySelector('.ff-update-toast__bar');
      if (downloading) {
        if (!bar) {
          bar = document.createElement('div');
          bar.className = 'ff-update-toast__bar';
          bar.innerHTML = '<div class="ff-update-toast__bar-fill"></div>';
          toastEl.querySelector('.ff-update-toast__content').appendChild(bar);
        }
        barFill = bar.querySelector('.ff-update-toast__bar-fill');
        if (barFill) barFill.style.width = (state.percent || 0) + '%';
      } else if (bar) {
        bar.remove();
      }

      if (primary) {
        primary.disabled = !ready;
        if (primary.textContent === 'Installing…' && !ready) {
          primary.textContent = 'Update Now';
        }
      }
    }

    async function refreshUpdateState() {
      try {
        const state = await apiJson('/api/update');
        renderToast(state);
      } catch { /* API offline */ }
    }

    async function checkForUpdate() {
      try {
        await fetch(`${API}/api/update/check`, { method: 'POST' });
      } catch { /* noop */ }
      await refreshUpdateState();
    }

    return { refreshUpdateState, checkForUpdate };
  }

  /** Re-check when app window becomes visible (complements Electron scheduler) */
  function setupAutoUpdatePolling() {
    const CHECK_MS = 4 * 60 * 60 * 1000;
    const updateUi = setupUpdateCornerToast();

    async function fetchUpdate() {
      await updateUi.checkForUpdate();
    }

    updateUi.refreshUpdateState();
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
    setupFeedingCompleteWatcher();
    setupSessionsClearAutoClose();

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
