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
        const isApi = /\/api(\/|$)/.test(url);
        if (isApi) {
          init = {
            ...init,
            headers: {
              'X-FeedFlow-Client': 'feedflow-app',
              ...(init?.headers || {}),
            },
          };
        }
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
    if (typeof window !== 'undefined' && window.location?.origin) {
      return window.location.origin.replace(/\/$/, '');
    }
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
    const LOGO_FALLBACK = './assets/feedflow-logo.png';
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
        if (!img.dataset.ffLogoFallbackBound) {
          img.dataset.ffLogoFallbackBound = '1';
          img.addEventListener('error', () => {
            if (img.src.includes('feedflow-logo.png')) return;
            img.src = LOGO_FALLBACK;
          }, { once: true });
        }
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
      const img = el.querySelector('img.ff-logo-img');
      img?.addEventListener('error', () => {
        if (img.src.includes('feedflow-logo.png')) return;
        img.src = LOGO_FALLBACK;
      }, { once: true });
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
      headers: {
        'Content-Type': 'application/json',
        'X-FeedFlow-Client': 'feedflow-app',
        ...(options?.headers || {}),
      },
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
    return slots.every((a) =>
      a.authSaved
      && a.authValid
      && a.authRegistered
      && !a.linking
      && !a.loggingOut
    );
  }

  function pairStartBlockReason(pairIndex) {
    const accounts = ffAppStatus?.accounts || [];
    const slots = accounts.filter((a) => a.pairIndex === pairIndex);
    if (slots.length < 2) return 'Pair incomplete — add accounts or remove empty pairs.';
    const names = slots.map((a) => a.label || a.slotLabel || `Account ${a.slot + 1}`);
    if (slots.some((a) => a.linking)) {
      return `Pair ${pairIndex + 1} is still linking — finish QR/pairing first.`;
    }
    if (slots.some((a) => !a.authSaved)) {
      return `Link first: ${names.join(' & ')}`;
    }
    if (slots.some((a) => !a.authRegistered || !a.authValid)) {
      return `Session not ready for ${names.join(' & ')} — complete login first.`;
    }
    return null;
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

  /** Footer Stop hanya untuk multi-pair; single pair pakai tombol React di footer. */
  function ensureStopFeedFooter() {
    const footer = document.querySelector('.wa-list-footer');
    if (!footer) return;

    if (!isMultiPairMode()) {
      footer.classList.remove('ff-feeding-footer-visible');
      footer.querySelector('.ff-stop-feed-btn')?.remove();
      return;
    }

    const running = !!(ffAppStatus?.feedingRunning || ffAppStatus?.feedingStarting);
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

  function getPairCount() {
    return ffAppStatus?.pairCount || getPairCountFromDom() || 1;
  }

  function isMultiPairMode() {
    return getPairCount() > 1;
  }

  function updatePerPairFeedingButtons() {
    if (!isMultiPairMode()) {
      ensureStopFeedFooter();
      return;
    }

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
          : (pairStartBlockReason(pairIndex) || `Link both accounts in Pair ${pairIndex + 1} first`);
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
    const block = pairStartBlockReason(pairIndex);
    if (block) {
      window.alert(block);
      return;
    }
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
    const singlePair = !isMultiPairMode();
    const footer = document.querySelector('.wa-list-footer');

    document.querySelectorAll('.wa-pair-label-row').forEach((row) => {
      normalizePairLabelRow(row);

      const labelEl = row.querySelector('.wa-pair-label');
      if (!labelEl) return;
      const match = labelEl.textContent.match(/Pair\s+(\d+)/i);
      if (!match) return;
      const pairIndex = parseInt(match[1], 10) - 1;

      injectPerPairRemoveButtons(row, pairIndex);

      if (singlePair) {
        row.querySelector('.ff-pair-start-btn')?.remove();
        return;
      }

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

    if (footer) {
      footer.classList.toggle('ff-single-pair-footer-visible', singlePair);
    }

    const globalStart = document.querySelector('.wa-footer-btn--feed');
    if (globalStart) {
      if (singlePair) {
        globalStart.style.removeProperty('display');
        globalStart.removeAttribute('aria-hidden');
      } else {
        globalStart.style.display = 'none';
        globalStart.setAttribute('aria-hidden', 'true');
      }
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

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function parseProxyLines(raw) {
    return String(raw || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  }

  function readProxyPanelContent(modal) {
    const bulk = modal.querySelector('.ff-proxy-textarea');
    const bulkOpen = modal.querySelector('.ff-proxy-bulk')?.open;
    if (bulkOpen && bulk) return bulk.value;

    const inputs = [...modal.querySelectorAll('.ff-proxy-account-input')].sort(
      (a, b) => parseInt(a.dataset.slot, 10) - parseInt(b.dataset.slot, 10),
    );
    if (!inputs.length) return bulk?.value || '';

    const maxSlot = Math.max(...inputs.map((inp) => parseInt(inp.dataset.slot, 10)));
    const lines = new Array(maxSlot + 1).fill('');
    inputs.forEach((inp) => {
      const slot = parseInt(inp.dataset.slot, 10);
      if (Number.isFinite(slot) && slot >= 0) lines[slot] = inp.value.trim();
    });
    return lines.join('\n');
  }

  function syncProxyBulkFromRows(modal) {
    const bulk = modal.querySelector('.ff-proxy-textarea');
    if (!bulk) return;
    bulk.value = readProxyPanelContent(modal);
  }

  function syncProxyRowsFromBulk(modal) {
    const bulk = modal.querySelector('.ff-proxy-textarea');
    if (!bulk) return;
    const lines = parseProxyLines(bulk.value);
    modal.querySelectorAll('.ff-proxy-account-input').forEach((inp) => {
      const slot = parseInt(inp.dataset.slot, 10);
      inp.value = lines[slot] || '';
    });
  }

  function proxyHostKey(url) {
    try {
      const u = new URL(String(url || '').trim());
      if (!u.hostname) return null;
      return `${u.hostname}:${u.port || '1080'}`;
    } catch {
      return null;
    }
  }

  function analyzeProxySharedFromLines(lines, accountCount) {
    const byHost = new Map();
    const count = Math.max(accountCount || 0, lines.length);
    for (let i = 0; i < count; i++) {
      const trimmed = String(lines[i] || '').trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const host = proxyHostKey(trimmed);
      if (!host) continue;
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host).push(i + 1);
    }
    const shared = [];
    for (const [host, lineNums] of byHost) {
      if (lineNums.length > 1) {
        shared.push({ host, lines: lineNums });
      }
    }
    return {
      shared,
      duplicates: shared,
      uniqueHosts: byHost.size,
    };
  }

  function showProxyPairTab(modal, pairIndex) {
    const root = modal.querySelector('.ff-proxy-panel');
    if (!root) return;
    root.dataset.ffActivePair = String(pairIndex);

    modal.querySelectorAll('.ff-proxy-pair-tab').forEach((btn) => {
      const p = parseInt(btn.dataset.pair, 10);
      const active = p === pairIndex;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    modal.querySelectorAll('.ff-proxy-pair-panel').forEach((pane) => {
      const p = parseInt(pane.dataset.pair, 10);
      const active = p === pairIndex;
      pane.hidden = !active;
      pane.classList.toggle('active', active);
    });
  }

  function updateProxyPairTabShared(modal, report) {
    const sharedLines = new Set((report?.shared || report?.duplicates || []).flatMap((d) => d.lines));
    modal.querySelectorAll('.ff-proxy-pair-tab').forEach((btn) => {
      const p = parseInt(btn.dataset.pair, 10);
      if (!Number.isFinite(p)) return;
      const shared = sharedLines.has(p * 2 + 1) || sharedLines.has(p * 2 + 2);
      btn.classList.toggle('ff-proxy-pair-tab--shared', shared);
    });
  }

  function renderProxySharedInfo(modal, report) {
    const el = modal.querySelector('.ff-proxy-shared-info');
    if (!el) return;

    const shared = report?.shared || report?.duplicates || [];
    if (!shared.length) {
      el.hidden = true;
      el.textContent = '';
      updateProxyPairTabShared(modal, report);
      return;
    }

    const parts = shared.map(
      (d) => `lines ${d.lines.join(', ')} → ${d.host}`,
    );
    el.textContent =
      `Shared proxy (same device / Shadowrocket): ${parts.join(' · ')}. ` +
      'Repeat the same proxy for every account on that device — this is expected.';
    el.hidden = false;
    updateProxyPairTabShared(modal, report);
  }

  function updateProxySharedInfo(modal, accountCount) {
    const content = readProxyPanelContent(modal);
    const rawLines = String(content || '').split(/\r?\n/);
    const padded = new Array(Math.max(accountCount || 0, rawLines.length)).fill('');
    rawLines.forEach((line, i) => { padded[i] = line.trim(); });
    renderProxySharedInfo(modal, analyzeProxySharedFromLines(padded, accountCount));
  }

  function proxyRouteIsActive(_slot, _lines, meta) {
    const route = meta?.proxyNow || 'direct';
    return Boolean(route && route !== 'direct');
  }

  function formatProxyRouteLabel(_slot, _lines, meta) {
    const route = meta?.proxyNow || 'direct';
    if (!route || route === 'direct') {
      return 'Active: direct (local IP)';
    }
    return `Active: ${route}`;
  }

  function getProxyAccountMeta(slot, status) {
    const acc = status?.accounts?.find((a) => a.slot === slot);
    const accountNum = (status?.config?.accountStart || 1) + slot;
    const label = acc?.displayName || acc?.label || acc?.slotLabel || `Account ${accountNum}`;
    const pairIndex = acc?.pairIndex ?? Math.floor(slot / 2);
    return {
      label,
      accountNum,
      pairIndex,
      linked: Boolean(acc?.authSaved),
      proxyNow: acc?.proxy || 'direct',
    };
  }

  async function renderProxyAccountGrid(modal) {
    const panelsWrap = modal.querySelector('.ff-proxy-pair-panels');
    const tabsNav = modal.querySelector('.ff-proxy-pair-tabs');
    const rootPanel = modal.querySelector('.ff-proxy-panel');
    if (!panelsWrap || !tabsNav) return;

    let settings = {};
    let status = {};
    try {
      [settings, status] = await Promise.all([
        apiJson('/api/settings'),
        apiJson('/api/status'),
      ]);
    } catch { /* partial load ok */ }

    const lines = String(settings.proxies || '')
      .split(/\r?\n/)
      .map((l) => l.trim());
    const slotCount = status.accountCount || (status.pairCount || 1) * 2;
    const pairCount = status.pairCount || Math.max(1, Math.ceil(slotCount / 2));
    const accountStart = status?.config?.accountStart || 1;
    const prevActive = parseInt(rootPanel?.dataset.ffActivePair, 10);
    const activePair = Number.isFinite(prevActive) && prevActive >= 0 && prevActive < pairCount
      ? prevActive
      : 0;

    panelsWrap.innerHTML = '';
    tabsNav.innerHTML = '';

    for (let p = 0; p < pairCount; p++) {
      const pane = document.createElement('div');
      pane.className = 'ff-proxy-pair-panel';
      pane.dataset.pair = String(p);
      pane.setAttribute('role', 'tabpanel');
      pane.hidden = p !== activePair;

      const rows = document.createElement('div');
      rows.className = 'ff-proxy-pair-rows';

      for (let slot = p * 2; slot < p * 2 + 2 && slot < slotCount; slot++) {
        const meta = getProxyAccountMeta(slot, status);
        const row = document.createElement('div');
        row.className = 'ff-proxy-account-row';
        row.innerHTML =
          '<div class="ff-proxy-account-meta">' +
          `<span class="ff-proxy-account-name">${escapeHtml(meta.label)}</span>` +
          `<span class="ff-proxy-line-badge">Line ${slot + 1}</span>` +
          '</div>' +
          '<div class="ff-proxy-input-wrap">' +
          `<input type="text" class="ff-proxy-account-input" data-slot="${slot}" ` +
          `value="${escapeHtml(lines[slot] || '')}" ` +
          'placeholder="socks5://user:pass@ip:port — empty = direct" spellcheck="false" autocomplete="off" />' +
          '</div>' +
          `<span class="ff-proxy-account-route${proxyRouteIsActive(slot, lines, meta) ? ' ff-proxy-account-route--live' : ''}">${escapeHtml(formatProxyRouteLabel(slot, lines, meta))}</span>`;

        const input = row.querySelector('.ff-proxy-account-input');
        input.addEventListener('input', () => {
          modal.querySelector('.ff-proxy-panel')?.setAttribute('data-ff-dirty', '1');
          syncProxyBulkFromRows(modal);
          updateProxySharedInfo(modal, slotCount);
        });

        rows.appendChild(row);
      }

      pane.appendChild(rows);
      panelsWrap.appendChild(pane);

      if (pairCount > 1) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'ff-proxy-pair-tab';
        tab.dataset.pair = String(p);
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', p === activePair ? 'true' : 'false');
        tab.textContent = `Pair ${p + 1}`;
        tab.addEventListener('click', (e) => {
          e.preventDefault();
          showProxyPairTab(modal, p);
        });
        tabsNav.appendChild(tab);
      }
    }

    tabsNav.hidden = pairCount <= 1;
    showProxyPairTab(modal, activePair);

    const mapEl = modal.querySelector('.ff-proxy-map-live');
    if (mapEl) {
      if (slotCount <= 4) {
        const parts = [];
        for (let slot = 0; slot < slotCount; slot++) {
          const n = accountStart + slot;
          const pair = Math.floor(slot / 2) + 1;
          parts.push(`Account ${n} (Pair ${pair}) → line ${slot + 1}`);
        }
        mapEl.textContent = parts.join(' · ');
      } else {
        mapEl.textContent =
          `${slotCount} accounts · line ${1} = Account ${accountStart}, line ${slotCount} = Account ${accountStart + slotCount - 1}`;
      }
    }

    syncProxyBulkFromRows(modal);
    updateProxySharedInfo(modal, slotCount);
    modal.querySelector('.ff-proxy-panel')?.removeAttribute('data-ff-dirty');
  }

  async function loadProxyPanel(modal) {
    await renderProxyAccountGrid(modal);
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
    hideUpdatePanel(modal);
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
    loadProxyPanel(modal);
  }

  function hideUpdatePanel(modal) {
    const panel = modal.querySelector('.ff-update-panel');
    const tab = modal.querySelector('.ff-update-tab');
    if (panel) {
      panel.hidden = true;
      panel.style.display = 'none';
    }
    if (tab) {
      tab.classList.remove('active');
      tab.setAttribute('aria-selected', 'false');
    }
  }

  function formatUpdateStatus(state) {
    if (!state?.enabled) return 'Auto-update unavailable (dev mode or portable build)';
    switch (state.status) {
      case 'checking': return 'Checking for updates…';
      case 'not-available': return `You are on the latest version (v${state.currentVersion})`;
      case 'available': return `Update v${state.latestVersion} found — downloading…`;
      case 'downloading': return `Downloading v${state.latestVersion}… ${state.percent || 0}%`;
      case 'downloaded': return `v${state.latestVersion} ready — click Update Now in the corner toast or restart via installer`;
      case 'error': return state.error || 'Update check failed';
      default: return `Version v${state.currentVersion}`;
    }
  }

  async function refreshUpdatePanel(modal) {
    const panel = modal.querySelector('.ff-update-panel');
    if (!panel || panel.hidden) return;
    const currentEl = panel.querySelector('.ff-update-current');
    const statusEl = panel.querySelector('.ff-update-status');
    const bar = panel.querySelector('.ff-update-bar');
    const barFill = panel.querySelector('.ff-update-bar-fill');
    const manualBtn = panel.querySelector('.ff-update-manual');
    try {
      const state = await apiJson('/api/update');
      if (currentEl) currentEl.textContent = `v${state.currentVersion || '?'}`;
      if (statusEl) {
        statusEl.textContent = formatUpdateStatus(state);
        statusEl.className = `ff-update-status${state.status === 'error' ? ' ff-update-status--error' : ''}`;
      }
      if (bar && barFill) {
        const showBar = state.status === 'downloading';
        bar.hidden = !showBar;
        barFill.style.width = `${state.percent || 0}%`;
      }
      if (manualBtn) {
        manualBtn.hidden = false;
        manualBtn.disabled = !state.manualDownloadUrl;
      }
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = err.message || 'Could not reach update API';
        statusEl.className = 'ff-update-status ff-update-status--error';
      }
    }
  }

  function showUpdatePanel(modal) {
    hideProxyPanel(modal);
    modal.querySelectorAll('.modal-body > [role="tabpanel"]:not(.ff-update-panel)').forEach((panel) => {
      panel.style.display = 'none';
    });
    modal.querySelectorAll('.modal-tabs .tab:not(.ff-update-tab)').forEach((tab) => {
      tab.classList.remove('active');
      tab.setAttribute('aria-selected', 'false');
    });

    const panel = modal.querySelector('.ff-update-panel');
    const tab = modal.querySelector('.ff-update-tab');
    if (panel) {
      panel.hidden = false;
      panel.style.display = '';
    }
    if (tab) {
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
    }
    refreshUpdatePanel(modal);
  }

  async function openManualDownload() {
    try {
      const res = await apiJson('/api/update/open-browser', { method: 'POST' });
      if (!res.opened && res.url) window.open(res.url, '_blank', 'noopener');
    } catch {
      window.open('https://github.com/yzxotic23-commits/WSAF-BO/releases/latest', '_blank', 'noopener');
    }
  }

  function patchUpdateTab(modal) {
    if (modal.dataset.ffUpdateTab) return;
    modal.dataset.ffUpdateTab = '1';

    const tabsNav = modal.querySelector('.modal-tabs');
    const modalBody = modal.querySelector('.modal-body');
    if (!tabsNav || !modalBody) return;

    const updateTab = document.createElement('button');
    updateTab.type = 'button';
    updateTab.role = 'tab';
    updateTab.className = 'tab ff-update-tab';
    updateTab.setAttribute('aria-selected', 'false');
    updateTab.textContent = 'Update';
    updateTab.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showUpdatePanel(modal);
    });
    tabsNav.appendChild(updateTab);

    const panel = document.createElement('div');
    panel.className = 'ff-update-panel';
    panel.hidden = true;
    panel.style.display = 'none';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-label', 'Update');
    panel.innerHTML =
      '<p class="hint">Installed via desktop installer required for in-app update. If auto-update fails (SmartScreen/antivirus), use <strong>Download manual</strong>.</p>' +
      '<div class="ff-update-version">' +
      '<span class="ff-update-version-label">Current version</span>' +
      '<strong class="ff-update-current">—</strong>' +
      '</div>' +
      '<div class="ff-update-status" role="status">Open this tab to check for updates.</div>' +
      '<div class="ff-update-bar" hidden><div class="ff-update-bar-fill"></div></div>' +
      '<div class="form-actions">' +
      '<button type="button" class="btn btn-primary ff-update-check">Check for updates</button>' +
      '<button type="button" class="btn btn-ghost ff-update-manual">Download manual</button>' +
      '</div>';
    modalBody.appendChild(panel);

    panel.querySelector('.ff-update-check').addEventListener('click', async () => {
      const btn = panel.querySelector('.ff-update-check');
      const statusEl = panel.querySelector('.ff-update-status');
      btn.disabled = true;
      if (statusEl) statusEl.textContent = 'Checking for updates…';
      try {
        if (window.ffUpdateUi?.checkForUpdate) {
          await window.ffUpdateUi.checkForUpdate();
        } else {
          await apiJson('/api/update/check', { method: 'POST' });
        }
      } catch (err) {
        if (statusEl) {
          statusEl.textContent = err.message || 'Check failed';
          statusEl.className = 'ff-update-status ff-update-status--error';
        }
      } finally {
        btn.disabled = false;
        await refreshUpdatePanel(modal);
      }
    });

    panel.querySelector('.ff-update-manual').addEventListener('click', () => {
      openManualDownload();
    });

    tabsNav.querySelectorAll('.tab:not(.ff-update-tab)').forEach((tab) => {
      tab.addEventListener('click', () => hideUpdatePanel(modal));
    });

    const proxyTab = modal.querySelector('.ff-proxy-tab');
    if (proxyTab) {
      proxyTab.addEventListener('click', () => hideUpdatePanel(modal));
    }
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
      '<div class="ff-proxy-top">' +
      '<div class="ff-proxy-guide">' +
      '<p class="ff-proxy-guide-title">Proxy per WhatsApp account</p>' +
      '<p class="ff-proxy-guide-text">Each account gets <strong>one proxy line</strong> (line order = account order). ' +
      'Accounts on the <strong>same physical device</strong> (Shadowrocket) use the <strong>same proxy</strong> — repeat it on each line. ' +
      'Leave empty for direct (local IP).</p>' +
      '<div class="ff-proxy-map-card">' +
      '<span class="ff-proxy-map-label">Mapping</span>' +
      '<span class="ff-proxy-map-live">Loading…</span>' +
      '</div>' +
      '<p class="ff-proxy-format-hint">Format: <code>socks5://user:pass@ip:port</code></p>' +
      '</div>' +
      '<div class="ff-proxy-shared-info" hidden role="status"></div>' +
      '</div>' +
      '<div class="ff-proxy-scroll">' +
      '<nav class="ff-proxy-pair-tabs" role="tablist" aria-label="Proxy pairs" hidden></nav>' +
      '<div class="ff-proxy-pair-panels"></div>' +
      '<details class="ff-proxy-bulk">' +
      '<summary>Bulk edit (advanced — one proxy per line)</summary>' +
      '<p class="hint">Line 1 = first account, line 2 = second account, and so on.</p>' +
      '<div class="ff-proxy-textarea-wrap">' +
      '<textarea class="textarea ff-proxy-textarea" spellcheck="false" rows="5" wrap="off"></textarea>' +
      '</div>' +
      '</details>' +
      '</div>' +
      '<div class="form-actions ff-proxy-actions">' +
      '<button type="button" class="btn btn-primary ff-proxy-save">Save</button>' +
      '<button type="button" class="btn btn-ghost ff-proxy-probe">Test proxies</button>' +
      '<button type="button" class="ff-proxy-refresh icon-btn ff-has-tooltip" ' +
      'data-ff-tooltip="Reload accounts from sidebar" ' +
      'aria-label="Reload accounts from sidebar">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08a5.99 5.99 0 0 1-5.65 4c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>' +
      '</svg></button>' +
      '</div>';

    modalBody.appendChild(panel);

    const textarea = panel.querySelector('.ff-proxy-textarea');
    const bulkDetails = panel.querySelector('.ff-proxy-bulk');

    textarea.addEventListener('input', () => {
      panel.setAttribute('data-ff-dirty', '1');
      syncProxyRowsFromBulk(modal);
      apiJson('/api/status').then((status) => {
        const slotCount = status.accountCount || (status.pairCount || 1) * 2;
        updateProxySharedInfo(modal, slotCount);
      }).catch(() => {});
    });

    bulkDetails?.addEventListener('toggle', () => {
      if (bulkDetails.open) syncProxyBulkFromRows(modal);
      else syncProxyRowsFromBulk(modal);
    });

    tabsNav.querySelectorAll('.tab:not(.ff-proxy-tab)').forEach((tab) => {
      tab.addEventListener('click', () => {
        hideProxyPanel(modal);
      });
    });

    panel.querySelector('.ff-proxy-refresh')?.addEventListener('click', () => {
      renderProxyAccountGrid(modal);
    });

    panel.querySelector('.ff-proxy-save').addEventListener('click', async () => {
      const saveBtn = panel.querySelector('.ff-proxy-save');
      const probeBtn = panel.querySelector('.ff-proxy-probe');
      const refreshBtn = panel.querySelector('.ff-proxy-refresh');
      const content = readProxyPanelContent(modal);
      saveBtn.disabled = true;
      probeBtn.disabled = true;
      if (refreshBtn) refreshBtn.disabled = true;
      try {
        const res = await apiJson('/api/settings/proxies', {
          method: 'POST',
          body: JSON.stringify({ content }),
        });
        panel.removeAttribute('data-ff-dirty');
        await renderProxyAccountGrid(modal);
        const shared = res?.proxyShared || res?.proxyDuplicates;
        if (shared?.shared?.length || shared?.duplicates?.length) {
          renderProxySharedInfo(modal, shared);
        }
        showSettingsToast(modal, 'success', 'Saved');
      } catch (err) {
        showSettingsToast(modal, 'error', err.message || 'Save failed');
      } finally {
        saveBtn.disabled = false;
        probeBtn.disabled = false;
        if (refreshBtn) refreshBtn.disabled = false;
      }
    });

    panel.querySelector('.ff-proxy-probe').addEventListener('click', async () => {
      const saveBtn = panel.querySelector('.ff-proxy-save');
      const probeBtn = panel.querySelector('.ff-proxy-probe');
      const refreshBtn = panel.querySelector('.ff-proxy-refresh');
      const content = readProxyPanelContent(modal);
      saveBtn.disabled = true;
      probeBtn.disabled = true;
      if (refreshBtn) refreshBtn.disabled = true;
      try {
        const status = await apiJson('/api/status').catch(() => ({}));
        const slotCount = status.accountCount || (status.pairCount || 1) * 2;
        const shared = analyzeProxySharedFromLines(
          String(content || '').split(/\r?\n/).map((l) => l.trim()),
          slotCount,
        );
        if (shared.shared.length) {
          renderProxySharedInfo(modal, shared);
        }
        const results = await apiJson('/api/proxies/probe', {
          method: 'POST',
          body: JSON.stringify({ content }),
        });
        const ok = (results || []).filter((r) => r.ok).length;
        const total = (results || []).length;
        const msg = total === 0
          ? 'No valid proxies — check format socks5://user:pass@ip:port'
          : `Probe done — ${ok}/${total} proxies OK`;
        showSettingsToast(modal, total === 0 ? 'error' : 'success', msg);
      } catch (err) {
        showSettingsToast(modal, 'error', err.message || 'Probe failed');
      } finally {
        saveBtn.disabled = false;
        probeBtn.disabled = false;
        if (refreshBtn) refreshBtn.disabled = false;
      }
    });

    loadProxyPanel(modal);
  }

  function patchSettingsModal() {
    const modal = getSettingsModal();
    if (!modal) return;
    patchFeedingSave(modal);
    patchProxyTab(modal);
    patchUpdateTab(modal);
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

    const success = data.success !== false
      && !data.manualStop
      && ((data.messagesSent ?? 0) > 0 || (data.completed ?? 0) > 0);
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
      '<div class="ff-pairing-actions">' +
      '<button type="button" class="ff-pairing-switch-qr">Log in with QR code <span aria-hidden="true">›</span></button>' +
      '<button type="button" class="ff-pairing-cancel-link">Cancel linking</button>' +
      '</div>' +
      '</div>';
    host.appendChild(overlay);
    document.body.classList.add('ff-pairing-active');

    overlay.querySelector('.ff-pairing-switch-qr')?.addEventListener('click', () => {
      switchToQrLoginView().catch((err) => {
        console.warn('[FeedFlow] switchToQrLoginView:', err);
      });
    });

    overlay.querySelector('.ff-pairing-cancel-link')?.addEventListener('click', () => {
      if (pairingSwitchInProgress) return;
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

    function updateToastButtons(state) {
      if (!toastEl) return;
      const ghost = toastEl.querySelector('.ff-update-toast__btn--ghost');
      const primary = toastEl.querySelector('.ff-update-toast__btn--primary');
      if (!ghost || !primary) return;

      ghost.textContent = 'Later';
      ghost.onclick = () => {
        setDismissedVersion(state.latestVersion || state.currentVersion || '1');
        removeToast();
      };

      const errored = state.status === 'error';
      const ready = state.status === 'downloaded';
      const downloading = state.status === 'downloading';

      if (errored) {
        primary.disabled = false;
        primary.textContent = 'Download manual';
        primary.onclick = () => openManualDownload();
        return;
      }

      if (ready) {
        primary.disabled = false;
        primary.textContent = 'Update Now';
        primary.onclick = async () => {
          primary.disabled = true;
          primary.textContent = 'Installing…';
          try {
            await apiJson('/api/update/install', { method: 'POST' });
          } catch (err) {
            primary.disabled = false;
            primary.textContent = 'Update Now';
            const subEl = toastEl.querySelector('.ff-update-toast__sub');
            if (subEl) {
              subEl.textContent = `${err.message || 'Install failed'} — try Download manual`;
            }
          }
        };
        return;
      }

      primary.disabled = true;
      if (downloading) {
        primary.textContent = `Downloading… ${state.percent || 0}%`;
      } else if (state.status === 'available') {
        primary.textContent = 'Preparing…';
      } else {
        primary.textContent = 'Update Now';
      }
      primary.onclick = null;
    }

    function bindToastActions(state) {
      updateToastButtons(state);
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
        ? `${state.error || 'Could not reach update server'} — use Download manual if needed`
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

      updateToastButtons(state);

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
    const CHECK_MS = 20 * 60 * 1000;
    const updateUi = setupUpdateCornerToast();
    window.ffUpdateUi = updateUi;
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
    [4000, 8000, 15000, 30000, 60000].forEach((ms) => setTimeout(() => updateUi.refreshUpdateState(), ms));
    setTimeout(fetchUpdate, 5000);

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
