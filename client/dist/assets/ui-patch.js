/**
 * Lightweight runtime patches for FeedFlow UI (no React source rebuild).
 */
(function () {
  'use strict';

  /** Normalize pairing phone before /api/connect (country code + local number). */
  function normalizePairingPhoneInput(phoneNumber) {
    let p = String(phoneNumber || '').replace(/\D/g, '');
    if (!p) return p;
    if (p.startsWith('00')) p = p.slice(2);
    if (p.startsWith('62')) {
      const local = p.slice(2).replace(/^0+/, '');
      if (local.length >= 9) return `62${local}`;
    }
    if (p.startsWith('60')) {
      const local = p.slice(2).replace(/^0+/, '');
      if (local.length >= 8) return `60${local}`;
    }
    const m = p.match(
      /^(1\d{2}|2\d{1,2}|3\d{2}|4\d{2}|5\d{2}|6\d{1,2}|7\d{1,2}|8\d{2}|9\d{1,2})(0+)(\d{6,})$/
    );
    if (m) p = m[1] + m[3];
    return p;
  }

  (function patchConnectFetchEarly() {
    const orig = window.fetch;
    if (!orig || orig.__ffPairingPatch) return;
    function wrappedFetch(input, init) {
      try {
        const url = typeof input === 'string' ? input : input?.url || '';
        const method = (init?.method || 'GET').toUpperCase();
        if (method === 'POST' && /\/api\/connect\/(\d+)/.test(url) && init?.body) {
          const slot = url.match(/\/api\/connect\/(\d+)/)[1];
          const body = JSON.parse(init.body);
          if (body?.method === 'pairing' && body.phoneNumber) {
            body.phoneNumber = normalizePairingPhoneInput(body.phoneNumber);
            body.clearIncomplete = true;
            sessionStorage.setItem('ff-pairing-slot', slot);
            sessionStorage.setItem('ff-pairing-until', String(Date.now() + 15 * 60 * 1000));
            init = { ...init, body: JSON.stringify(body) };
          }
        }
      } catch {
        /* keep original request */
      }
      return orig.call(this, input, init);
    }
    wrappedFetch.__ffPairingPatch = true;
    window.fetch = wrappedFetch;
  })();

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

  /** Satu baris: stats kiri, tombol refresh/+ kanan — tanpa wrap */
  function fixListHeaderLayout() {
    document.querySelectorAll('.wa-list-header').forEach((header) => {
      const top = header.querySelector('.wa-list-header-top');
      const stats = header.querySelector('.wa-list-header-stats');
      const toolbar = header.querySelector('.wa-list-header-toolbar');
      if (!top || !stats || !toolbar) return;

      let actions = header.querySelector('.ff-list-header-actions');
      if (!actions) {
        actions = document.createElement('div');
        actions.className = 'ff-list-header-actions';
        actions.setAttribute('role', 'group');
        actions.setAttribute('aria-label', 'Sidebar status and actions');
        header.insertBefore(actions, toolbar);
      }

      if (stats.parentElement !== actions) {
        actions.insertBefore(stats, actions.firstChild);
      }
      if (toolbar.parentElement !== actions) {
        actions.appendChild(toolbar);
      }
    });
  }

  /** Stat pills satu baris — scroll halus jika sidebar sangat sempit */
  function stabilizeStatPills() {
    document.querySelectorAll('.wa-list-header-stats').forEach((el) => {
      el.style.flexWrap = 'nowrap';
      el.style.alignItems = 'center';
      el.style.overflowX = 'auto';
      el.style.overflowY = 'hidden';
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
    const LOGO_SRC = './assets/xchat-logo.webp';
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

  /** Audit log is in AMS — remove legacy FeedFlow topbar pill */
  function removeAuditTopbarPill() {
    document.querySelectorAll('.wa-topbar-pill--audit').forEach((el) => {
      el.remove();
    });
  }

  /** Sidebar footer: hide Unlink all (Stop feeding tetap muncul saat feeding jalan). */
  function tidyListFooter() {
    document.querySelectorAll('.wa-list-footer .wa-footer-btn--muted').forEach((btn) => {
      btn.style.display = 'none';
      btn.setAttribute('aria-hidden', 'true');
    });
  }

  function applyDomFixes() {
    stampModalBackdrops();
    if (isModalOpen()) return;

    hideDuplicateTopbarTitle();
    removeAuditTopbarPill();
    fixListHeaderLayout();
    stabilizeStatPills();
    fixToolbarButtons();
    syncOfficialLogo();
    injectPerPairControls();
    tidyListFooter();
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

  let ffAppStatus = null;
  let ffStatusTimer = null;

  async function refreshAppStatus() {
    try {
      ffAppStatus = await apiJson('/api/status');
    } catch {
      /* sidebar may not be ready */
    }
    return ffAppStatus;
  }

  function isPairLinked(pairIndex) {
    const accounts = ffAppStatus?.accounts || [];
    const slots = accounts.filter((a) => a.pairIndex === pairIndex);
    if (slots.length < 2) return false;
    return slots.every((a) => a.authSaved);
  }

  const START_FEED_ICON =
    '<svg class="ff-pair-start-btn__icon" viewBox="0 0 24 24" width="10" height="10" aria-hidden="true">' +
    '<path fill="currentColor" d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>';

  function setStartFeedButtonLabel(btn, text) {
    let label = btn.querySelector('.ff-pair-start-btn__label');
    if (!label) {
      btn.innerHTML = START_FEED_ICON + `<span class="ff-pair-start-btn__label">${text}</span>`;
      return;
    }
    label.textContent = text;
  }

  function ensureStartFeedButtonStructure(btn) {
    if (!btn.querySelector('.ff-pair-start-btn__label')) {
      const text = btn.textContent.trim() || 'Start';
      setStartFeedButtonLabel(btn, text);
    }
  }

  function getActiveFeedingPairs() {
    const pairs = ffAppStatus?.feedingActivePairs;
    if (Array.isArray(pairs) && pairs.length) return pairs;
    if (ffAppStatus?.feedingPairIndex != null
      && (ffAppStatus?.feedingRunning || ffAppStatus?.feedingStarting)) {
      return [ffAppStatus.feedingPairIndex];
    }
    return [];
  }

  function isPairFeeding(pairIndex) {
    return getActiveFeedingPairs().includes(pairIndex);
  }

  async function stopFeeding(pairIndex = null) {
    try {
      const body = pairIndex != null ? { pairIndex } : {};
      await apiJson('/api/feeding/stop', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    } catch (err) {
      window.alert(err.message || 'Could not stop feeding');
    } finally {
      await refreshAppStatus();
      updatePerPairFeedingButtons();
      ensureStopFeedFooter();
    }
  }

  /** Footer Stop hilang saat feedingStarting (React belum render stop + CSS sembunyikan footer). */
  function ensureStopFeedFooter() {
    const running = !!(ffAppStatus?.feedingRunning || ffAppStatus?.feedingStarting);
    const footer = document.querySelector('.wa-list-footer');
    if (!footer) return;

    let stopBtn = footer.querySelector('.wa-footer-btn--stop');
    if (running) {
      footer.classList.add('ff-feeding-footer-visible');
      footer.style.removeProperty('display');
      if (!stopBtn) {
        stopBtn = document.createElement('button');
        stopBtn.type = 'button';
        stopBtn.className = 'wa-footer-btn wa-footer-btn--stop ff-stop-feed-btn';
        stopBtn.textContent = 'Stop all feeding';
        stopBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          stopFeeding();
        });
        footer.appendChild(stopBtn);
      }
      stopBtn.disabled = false;
      stopBtn.style.removeProperty('display');
    } else {
      footer.classList.remove('ff-feeding-footer-visible');
      footer.querySelector('.ff-stop-feed-btn')?.remove();
    }
  }

  function updatePerPairFeedingButtons() {
    const activePairs = getActiveFeedingPairs();

    document.querySelectorAll('.ff-pair-start-btn').forEach((btn) => {
      ensureStartFeedButtonStructure(btn);
      const pairIndex = parseInt(btn.dataset.pairIndex || '-1', 10);
      const ready = isPairLinked(pairIndex);
      const isActive = isPairFeeding(pairIndex);

      if (isActive) {
        btn.disabled = false;
        btn.classList.add('ff-pair-start-btn--active', 'ff-pair-start-btn--stop');
        setStartFeedButtonLabel(btn, 'Stop');
        btn.title = `Stop feeding for Pair ${pairIndex + 1}`;
        btn.onclick = (e) => {
          e.stopPropagation();
          stopFeeding(pairIndex);
        };
      } else {
        btn.disabled = !ready || isPairFeeding(pairIndex);
        btn.classList.toggle('ff-pair-start-btn--active', false);
        btn.classList.remove('ff-pair-start-btn--stop');
        setStartFeedButtonLabel(btn, 'Start');
        btn.title = ready
          ? `Start AI feeding for Pair ${pairIndex + 1} only`
          : `Link both accounts in Pair ${pairIndex + 1} first`;
        btn.onclick = (e) => {
          e.stopPropagation();
          startPairFeeding(pairIndex, btn);
        };
      }
    });

    document.querySelectorAll('.ff-pair-remove-btn').forEach((btn) => {
      const pairIndex = parseInt(btn.dataset.pairIndex || '-1', 10);
      btn.disabled = isPairFeeding(pairIndex);
    });

    ensureStopFeedFooter();
  }

  async function startPairFeeding(pairIndex, btn) {
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    try {
      await apiJson('/api/feeding/start', {
        method: 'POST',
        body: JSON.stringify({ pairIndex }),
      });
    } catch (err) {
      window.alert(err.message || 'Could not start feeding');
    } finally {
      await refreshAppStatus();
      updatePerPairFeedingButtons();
    }
  }

  /** Restore row structure; keep Start feeding as last child (React owns label). */
  function normalizePairLabelRow(row) {
    const wrapper = row.querySelector(':scope > .ff-pair-label-actions');
    if (wrapper) {
      while (wrapper.firstChild) {
        row.appendChild(wrapper.firstChild);
      }
      wrapper.remove();
    }

    const startBtn = row.querySelector('.ff-pair-start-btn');
    if (startBtn && startBtn !== row.lastElementChild) {
      row.appendChild(startBtn);
    }

    row.querySelectorAll('.wa-pair-remove-btn').forEach((btn) => {
      btn.hidden = true;
      btn.setAttribute('aria-hidden', 'true');
      btn.tabIndex = -1;
    });
  }

  function getPairCountFromDom() {
    return document.querySelectorAll('.wa-pair-label-row').length;
  }

  function closeFfModal(backdrop) {
    if (!backdrop) return;
    backdrop.remove();
  }

  function showConfirmModal({
    title,
    message,
    confirmLabel = 'OK',
    cancelLabel = 'Cancel',
    danger = false,
    onConfirm,
  }) {
    document.querySelector('.ff-confirm-modal-backdrop')?.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'wa-modal-backdrop ff-confirm-modal-backdrop';
    backdrop.setAttribute('role', 'presentation');

    const dialog = document.createElement('div');
    dialog.className = 'wa-modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'ff-confirm-modal-title');
    dialog.innerHTML =
      `<h2 id="ff-confirm-modal-title" class="wa-modal-title">${title}</h2>` +
      `<p class="wa-modal-message">${message}</p>` +
      '<div class="wa-modal-actions">' +
      `<button type="button" class="wa-modal-btn wa-modal-btn--ghost ff-confirm-cancel">${cancelLabel}</button>` +
      `<button type="button" class="wa-modal-btn ${danger ? 'wa-modal-btn--danger' : 'wa-modal-btn--primary'} ff-confirm-ok">${confirmLabel}</button>` +
      '</div>';

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    stampModalBackdrops();

    const cancel = () => closeFfModal(backdrop);
    backdrop.addEventListener('click', cancel);
    dialog.addEventListener('click', (e) => e.stopPropagation());
    dialog.querySelector('.ff-confirm-cancel')?.addEventListener('click', cancel);
    dialog.querySelector('.ff-confirm-ok')?.addEventListener('click', async () => {
      const okBtn = dialog.querySelector('.ff-confirm-ok');
      if (okBtn) okBtn.disabled = true;
      try {
        await onConfirm?.();
        cancel();
      } catch (err) {
        if (okBtn) okBtn.disabled = false;
        window.alert(err.message || 'Action failed');
      }
    });
  }

  function removePairAt(pairIndex) {
    const pairNum = pairIndex + 1;
    showConfirmModal({
      title: `Remove Pair ${pairNum}?`,
      message:
        'This deletes both accounts in this pair (local WhatsApp session files on this PC). Remaining pairs will shift up. At least one pair must remain. Stop feeding first if it is running.',
      confirmLabel: 'Remove pair',
      cancelLabel: 'Cancel',
      danger: true,
      onConfirm: async () => {
        const result = await apiJson('/api/accounts/remove-pair', {
          method: 'POST',
          body: JSON.stringify({ pairIndex }),
        });
        if (result.error) throw new Error(result.error);
        await refreshAppStatus();
        injectPerPairControls();
        updatePerPairFeedingButtons();
      },
    });
  }

  function injectPerPairRemoveButtons(row, pairIndex) {
    const pairCount = ffAppStatus?.pairCount || getPairCountFromDom();
    const feeding = isPairFeeding(pairIndex);

    if (pairCount <= 1) {
      row.querySelector('.ff-pair-remove-btn')?.remove();
      return;
    }

    let removeBtn = row.querySelector('.ff-pair-remove-btn');
    if (!removeBtn) {
      removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'ff-pair-remove-btn';
      removeBtn.setAttribute('aria-label', `Remove pair ${pairIndex + 1}`);
      removeBtn.title = 'Remove pair';
      removeBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
        '<path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>' +
        '</svg>';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removePairAt(pairIndex);
      });
      const labelEl = row.querySelector('.wa-pair-label');
      if (labelEl?.nextSibling) {
        row.insertBefore(removeBtn, labelEl.nextSibling);
      } else if (labelEl) {
        labelEl.after(removeBtn);
      } else {
        row.prepend(removeBtn);
      }
    }

    removeBtn.dataset.pairIndex = String(pairIndex);
    removeBtn.disabled = feeding;
  }

  function injectPerPairControls() {
    document.querySelectorAll('.wa-pair-label-row').forEach((row) => {
      normalizePairLabelRow(row);

      const labelEl = row.querySelector('.wa-pair-label');
      if (!labelEl) return;
      const match = labelEl.textContent.match(/Pair\s+(\d+)/i);
      if (!match) return;
      const pairIndex = parseInt(match[1], 10) - 1;

      injectPerPairRemoveButtons(row, pairIndex);

      let startBtn = row.querySelector('.ff-pair-start-btn');
      if (!startBtn) {
        startBtn = document.createElement('button');
        startBtn.type = 'button';
        startBtn.className = 'ff-pair-start-btn';
        startBtn.dataset.pairIndex = String(pairIndex);
        setStartFeedButtonLabel(startBtn, 'Start');
        row.appendChild(startBtn);
      } else if (startBtn.dataset.pairIndex !== String(pairIndex)) {
        startBtn.dataset.pairIndex = String(pairIndex);
      }
    });

    const globalStart = document.querySelector('.wa-footer-btn--feed');
    if (globalStart) {
      globalStart.style.display = 'none';
      globalStart.setAttribute('aria-hidden', 'true');
    }

    updatePerPairFeedingButtons();
    wirePairHoverGroups();
  }

  function wirePairHoverGroups() {
    const wraps = [...document.querySelectorAll('.wa-chat-row-wrap')];
    let currentPair = -1;
    const groups = new Map();

    wraps.forEach((wrap) => {
      const label = wrap.querySelector('.wa-pair-label');
      if (label) {
        const m = label.textContent.match(/Pair\s+(\d+)/i);
        if (m) currentPair = parseInt(m[1], 10) - 1;
      }
      if (currentPair < 0) return;
      if (!groups.has(currentPair)) groups.set(currentPair, []);
      groups.get(currentPair).push(wrap);
    });

    groups.forEach((groupWraps) => {
      const labelRow = groupWraps[0]?.querySelector('.wa-pair-label-row');
      if (!labelRow) return;
      groupWraps.forEach((wrap) => {
        if (wrap.dataset.ffPairHoverBound === '1') return;
        wrap.dataset.ffPairHoverBound = '1';
        wrap.addEventListener('mouseenter', () => labelRow.classList.add('ff-pair-hover'));
        wrap.addEventListener('mouseleave', () => labelRow.classList.remove('ff-pair-hover'));
      });
    });
  }

  function injectPerPairFeedingButtons() {
    injectPerPairControls();
  }

  function setupPerPairFeedingStatusPoll() {
    refreshAppStatus().then(() => {
      injectPerPairControls();
      updatePerPairFeedingButtons();
    });
    if (ffStatusTimer) clearInterval(ffStatusTimer);
    ffStatusTimer = setInterval(async () => {
      await refreshAppStatus();
      injectPerPairControls();
      updatePerPairFeedingButtons();
    }, 2500);
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
        const results = await apiJson('/api/proxies/probe', {
          method: 'POST',
          body: JSON.stringify({ content: textarea.value }),
        });
        const ok = (results || []).filter((r) => r.ok).length;
        const total = (results || []).length;
        const msg = total === 0
          ? 'No valid proxies in list — check format (socks5://user:pass@ip:port)'
          : `Probe complete — ${ok}/${total} proxies OK`;
        showSettingsToast(modal, total === 0 ? 'error' : 'success', msg);
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
    const title = success ? 'Feeding complete' : 'Feeding stopped';
    const subtitle = success
      ? 'All AI chat pairs have finished. Sessions remain saved on this device.'
      : 'Feeding ended before all pairs finished. You can start again anytime.';

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
      '<div class="ff-feeding-complete-stat"><span class="ff-feeding-complete-stat-value">' + (data.completed ?? 0) + '</span><span class="ff-feeding-complete-stat-label">Pairs done</span></div>' +
      '<div class="ff-feeding-complete-stat"><span class="ff-feeding-complete-stat-value">' + (data.messagesSent ?? 0) + '</span><span class="ff-feeding-complete-stat-label">Messages sent</span></div>' +
      '<div class="ff-feeding-complete-stat"><span class="ff-feeding-complete-stat-value">' + (data.totalPairs ?? 0) + '</span><span class="ff-feeding-complete-stat-label">Total pairs</span></div>' +
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

  /** Pairing code screen — WhatsApp Web layout with QR fallback link */
  let lastShownPairingKey = null;
  let pairingSwitchInProgress = false;

  function removePairingCodeOverlay() {
    document.querySelectorAll('.ff-pairing-code-overlay').forEach((el) => el.remove());
    document.body.classList.remove('ff-pairing-active');
  }

  async function getActivePairingSlot() {
    const overlay = document.querySelector('.ff-pairing-code-overlay');
    if (overlay?.dataset?.slot !== undefined && overlay.dataset.slot !== '') {
      return parseInt(overlay.dataset.slot, 10);
    }
    const stored = sessionStorage.getItem('ff-pairing-slot');
    if (stored !== null && stored !== '') {
      return parseInt(stored, 10);
    }
    try {
      const status = await apiJson('/api/status');
      const acc = (status.accounts || []).find(
        (a) => a.linking && a.loginMethod === 'pairing' && a.pairingCode
      );
      return acc?.slot ?? null;
    } catch {
      return null;
    }
  }

  async function cancelActivePairing() {
    const slot = await getActivePairingSlot();
    sessionStorage.removeItem('ff-pairing-slot');
    sessionStorage.removeItem('ff-pairing-until');
    lastShownPairingKey = null;
    removePairingCodeOverlay();
    if (slot !== null && !Number.isNaN(slot)) {
      try {
        await apiJson(`/api/disconnect/${slot}`, { method: 'POST' });
      } catch {
        /* session may already be closed */
      }
    }
    return slot;
  }

  function clickNativeQrLoginLink() {
    const qrLink = [...document.querySelectorAll('.wa-web-text-link--center, .wa-web-text-link')].find(
      (el) => /log in with qr code/i.test(el.textContent || '')
    );
    if (qrLink) {
      qrLink.click();
      return true;
    }
    const footPhone = [...document.querySelectorAll('.wa-web-text-link--foot')].find(
      (el) => /phone number/i.test(el.textContent || '')
    );
    if (footPhone && document.querySelector('.wa-web-card--qr')) {
      return true;
    }
    if (footPhone) {
      footPhone.click();
      requestAnimationFrame(() => clickNativeQrLoginLink());
    }
    return false;
  }

  function formatPhoneForDisplay(phone) {
    const p = String(phone || '').replace(/\D/g, '');
    if (!p) return '';
    if (p.startsWith('62') && p.length >= 11) {
      const rest = p.slice(2).replace(/^0+/, '');
      if (rest.length >= 10) {
        return `+62 ${rest.slice(0, 3)}-${rest.slice(3, 7)}-${rest.slice(7)}`;
      }
      return `+62 ${rest}`;
    }
    if (p.startsWith('60') && p.length >= 10) {
      const rest = p.slice(2).replace(/^0+/, '');
      if (rest.length >= 9) {
        return `+60 ${rest.slice(0, 2)}-${rest.slice(2, 6)}-${rest.slice(6)}`;
      }
      return `+60 ${rest}`;
    }
    return `+${p}`;
  }

  function buildPairingCodeBoxes(code) {
    const raw = String(code || '').replace(/-/g, '').toUpperCase().slice(0, 8);
    let html = '<div class="ff-pairing-code-boxes" aria-live="polite">';
    for (let i = 0; i < 8; i += 1) {
      if (i === 4) {
        html += '<span class="ff-pairing-code-sep" aria-hidden="true">-</span>';
      }
      html += `<span class="ff-pairing-code-box">${raw[i] || ''}</span>`;
    }
    html += '</div>';
    return html;
  }

  function switchToPhoneLoginView() {
    if (document.querySelector('.wa-web-card--phone')) return;
    const link = [...document.querySelectorAll('.wa-web-text-link--foot, .wa-web-text-link--center')].find(
      (el) => /phone number/i.test(el.textContent || '')
    );
    if (link) link.click();
  }

  async function switchToQrLoginView() {
    if (pairingSwitchInProgress) return;
    pairingSwitchInProgress = true;
    const btn = document.querySelector('.ff-pairing-switch-qr');
    const btnHtml = btn?.innerHTML;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Switching to QR…';
    }
    try {
      const slot = await cancelActivePairing();
      if (slot !== null && !Number.isNaN(slot)) {
        try {
          await apiJson(`/api/connect/${slot}`, {
            method: 'POST',
            body: JSON.stringify({ method: 'qr', clearIncomplete: true }),
          });
        } catch (err) {
          console.warn('[FeedFlow] QR connect after pairing cancel:', err.message || err);
        }
      }
      requestAnimationFrame(() => {
        clickNativeQrLoginLink();
      });
    } finally {
      pairingSwitchInProgress = false;
      if (btn) {
        btn.disabled = false;
        btn.innerHTML =
          btnHtml || 'Log in with QR code <span aria-hidden="true">›</span>';
      }
    }
  }

  function showPairingCodeOverlay(acc) {
    const key = `${acc.slot}:${acc.pairingCode}`;
    if (lastShownPairingKey === key && document.querySelector('.ff-pairing-code-overlay')) return;
    lastShownPairingKey = key;
    switchToPhoneLoginView();
    removePairingCodeOverlay();

    const host =
      document.querySelector('.wa-web-login-center')
      || document.querySelector('.wa-web-login')
      || document.querySelector('.wa-main');
    if (!host) return;

    const raw = String(acc.pairingCode || '').replace(/-/g, '').toUpperCase();
    const formatted =
      raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : acc.pairingCode;
    const phoneDisplay = formatPhoneForDisplay(acc.pairingPhone);

    const overlay = document.createElement('div');
    overlay.className = 'ff-pairing-code-overlay ff-pairing-code-overlay--wa';
    overlay.dataset.slot = String(acc.slot);
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Enter code on phone');
    overlay.innerHTML =
      '<div class="ff-pairing-code-card ff-pairing-code-card--wa">' +
      '<h2 class="ff-pairing-code-title">Enter code on phone</h2>' +
      (phoneDisplay
        ? `<p class="ff-pairing-code-account">Linking WhatsApp account <strong>${phoneDisplay}</strong> <button type="button" class="ff-pairing-edit">edit</button></p>`
        : '') +
      buildPairingCodeBoxes(formatted) +
      '<ol class="ff-pairing-code-timeline">' +
      '<li><span class="ff-pairing-step-num">1</span><span class="ff-pairing-step-text">Open <strong>WhatsApp</strong> on your phone</span></li>' +
      '<li><span class="ff-pairing-step-num">2</span><span class="ff-pairing-step-text">On Android tap <strong>Menu</strong> · On iPhone tap <strong>Settings</strong></span></li>' +
      '<li><span class="ff-pairing-step-num">3</span><span class="ff-pairing-step-text">Tap <strong>Linked devices</strong>, then <strong>Link device</strong></span></li>' +
      '<li><span class="ff-pairing-step-num">4</span><span class="ff-pairing-step-text">Tap <strong>Link with phone number instead</strong> and enter this code on your phone</span></li>' +
      '</ol>' +
      '<button type="button" class="ff-pairing-switch-qr">Log in with QR code <span aria-hidden="true">›</span></button>' +
      '</div>';
    host.appendChild(overlay);
    document.body.classList.add('ff-pairing-active');

    overlay.querySelector('.ff-pairing-switch-qr')?.addEventListener('click', () => {
      switchToQrLoginView().catch((err) => {
        console.warn('[FeedFlow] switchToQrLoginView:', err);
      });
    });

    overlay.querySelector('.ff-pairing-edit')?.addEventListener('click', () => {
      pairingSwitchInProgress = true;
      cancelActivePairing()
        .catch(() => {})
        .finally(() => {
          pairingSwitchInProgress = false;
          switchToPhoneLoginView();
          const input = document.querySelector('.wa-web-pill-input');
          if (input) {
            input.focus();
            input.select?.();
          }
        });
    });

    const nativeDigits = document.querySelector('.wa-web-pairing-digits');
    if (nativeDigits) nativeDigits.textContent = formatted;
  }

  async function pollPairingCodeOverlay() {
    if (pairingSwitchInProgress) return;
    try {
      const status = await apiJson('/api/status');
      let anyPairing = false;
      for (const acc of status.accounts || []) {
        if (acc.linking && acc.pairingCode && acc.loginMethod === 'pairing') {
          anyPairing = true;
          showPairingCodeOverlay(acc);
        }
      }
      if (!anyPairing) {
        lastShownPairingKey = null;
        removePairingCodeOverlay();
        sessionStorage.removeItem('ff-pairing-slot');
        sessionStorage.removeItem('ff-pairing-until');
      }
    } catch {
      /* API not ready */
    }
  }

  function setupPairingCodeOverlay() {
    pollPairingCodeOverlay();
    setInterval(pollPairingCodeOverlay, 900);
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
      if (state.status === 'error') return true;
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
      const errored = state.status === 'error';
      const title = errored
        ? 'Update check failed'
        : ready
          ? 'Update ready'
          : 'Update available';
      const sub = errored
        ? (state.error || 'Could not reach update server')
        : ready
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
        if (ready) {
          primary.textContent = 'Update Now';
        } else if (downloading) {
          primary.textContent = `Downloading… ${state.percent || 0}%`;
        } else if (state.status === 'available') {
          primary.textContent = 'Preparing…';
        } else if (primary.textContent === 'Installing…') {
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

    return {
      refreshUpdateState,
      checkForUpdate,
      renderToast,
      /** Dev preview: ffPreviewUpdate('available'|'downloading'|'ready') */
      showPreview(mode) {
        const samples = {
          available: {
            enabled: true,
            status: 'available',
            currentVersion: '1.0.18',
            latestVersion: '1.0.20',
          },
          downloading: {
            enabled: true,
            status: 'downloading',
            currentVersion: '1.0.18',
            latestVersion: '1.0.20',
            percent: 62,
          },
          ready: {
            enabled: true,
            status: 'downloaded',
            currentVersion: '1.0.18',
            latestVersion: '1.0.20',
          },
          downloaded: {
            enabled: true,
            status: 'downloaded',
            currentVersion: '1.0.18',
            latestVersion: '1.0.20',
          },
        };
        const key = String(mode || 'ready').toLowerCase();
        const state = samples[key] || samples.ready;
        try {
          sessionStorage.removeItem('ff-update-dismissed');
        } catch { /* noop */ }
        renderToast(state);
      },
    };
  }

  /** Re-check when app window becomes visible (complements Electron scheduler) */
  function setupAutoUpdatePolling() {
    const CHECK_MS = 60 * 60 * 1000;
    const updateUi = setupUpdateCornerToast();
    window.ffPreviewUpdate = (mode) => updateUi.showPreview(mode);

    async function fetchUpdate() {
      await updateUi.checkForUpdate();
    }

    function hookUpdateSocket() {
      function connect() {
        if (typeof io === 'undefined') return;
        try {
          const socket = io(API, { transports: ['websocket', 'polling'] });
          socket.on('update', (state) => {
            if (state && typeof state === 'object') updateUi.renderToast(state);
          });
        } catch {
          /* socket optional */
        }
      }
      if (typeof io !== 'undefined') {
        connect();
        return;
      }
      const scriptId = 'ff-socket-io-client';
      if (document.getElementById(scriptId)) return;
      const script = document.createElement('script');
      script.id = scriptId;
      script.src = `${API}/socket.io/socket.io.js`;
      script.onload = connect;
      script.onerror = () => { /* polling fallback only */ };
      document.head.appendChild(script);
    }

    // Initial + delayed checks — main process also checks ~4s after launch.
    fetchUpdate();
    [6000, 15000, 30000].forEach((ms) => setTimeout(() => updateUi.refreshUpdateState(), ms));
    setTimeout(fetchUpdate, 8000);

    hookUpdateSocket();
    setInterval(fetchUpdate, CHECK_MS);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') fetchUpdate();
    });
    window.addEventListener('focus', () => updateUi.refreshUpdateState());
  }

  function boot() {
    document.addEventListener('mousedown', guardModalGhostClick, true);
    document.addEventListener('click', guardModalGhostClick, true);

    applyDomFixes();
    setupAutoUpdatePolling();
    setupFeedingCompleteWatcher();
    setupPairingCodeOverlay();
    setupSessionsClearAutoClose();
    setupPerPairFeedingStatusPoll();

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
