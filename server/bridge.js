require('dotenv').config();
require('../src/silence-libsignal-logs');
if (process.env.AI_SDK_LOG_WARNINGS === undefined) {
  process.env.AI_SDK_LOG_WARNINGS = 'false';
}

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, fork } = require('child_process');
const WhatsAppSession = require('../src/whatsapp-session');
const ProxyManager = require('../src/proxy-manager');
const { probeProxy } = require('../src/proxy-probe');
const {
  getPairCount,
  getAccountCount,
  getAccountName,
  getAccountLabel,
} = require('../src/app-config');
const { AuditLogStore, FEEDING_STATUS } = require('../src/audit-log');
const { SlotDisplayLabelStore } = require('../src/slot-display-labels');

const MAX_PAIRS = 10;

const MAX_CHAT_PER_ACCOUNT = 400;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]);
}

function getPartnerSlot(slot) {
  const pairBase = Math.floor(slot / 2) * 2;
  return slot % 2 === 0 ? pairBase + 1 : pairBase;
}

const AI_ENV_DEFAULTS = {
  AI_PROVIDER_PRIMARY: 'openai',
  AI_PROVIDER_FALLBACK: 'ollama',
  OPENAI_AUTH_MODE: 'codex',
  OPENAI_MODEL: 'auto',
  LANGUAGE: 'English',
};

class DesktopBridge {
  constructor(emit) {
    this.emit = emit || (() => {});
    this.sessions = [];
    this.proxyManager = new ProxyManager(this.getProxiesPath());
    this.accountProxies = [];
    this.hasProxies = false;
    this.connecting = false;
    this.feedingProcess = null;
    this.feedingStarting = false;
    this.feedingLaunchPhase = 'prepare';
    this.chatHistory = new Map();
    this.logoutSlots = new Set();
    this.logoutPhase = new Map();
    /** slot → timestamp — debounce duplicate strict-logout handling */
    this.strictLogoutAt = new Map();
    /** Only one account may link (QR/pairing) at a time — avoids session collision. */
    this.linkingSlot = null;
    this.codexProxyPromise = null;
    this.auditLog = new AuditLogStore(this.getAppRoot());
    this.slotLabels = new SlotDisplayLabelStore(this.getAppRoot());
    this.currentFeedingRunId = null;
    this.lastFeedingComplete = null;
    /** 0-based pair index when a single-pair feeding run is active; null = all pairs. */
    this.feedingPairIndex = null;
    /** Slots that passed linked check when feeding started (parent socket is down during CLI run). */
    this.feedingLinkedSlots = null;
    this.ensureEnvAiDefaults();
    this.ensureFirstRunEnv();
    this.ensureCapacity();
    this.ensureCodexProxy().catch((err) => {
      this.log('warn', `[AI] Codex proxy startup failed: ${err.message}`);
    });
  }

  /** Create .env in install folder from example on first run (new PC). */
  ensureFirstRunEnv() {
    const envPath = this.getEnvPath();
    if (fs.existsSync(envPath)) return;
    const candidates = [
      path.join(this.getAppRoot(), '.env.example'),
    ];
    try {
      const { app } = require('electron');
      if (app?.isPackaged && process.resourcesPath) {
        candidates.unshift(path.join(process.resourcesPath, '.env.example'));
      }
    } catch {
      /* not in electron */
    }
    for (const src of candidates) {
      if (!fs.existsSync(src)) continue;
      try {
        fs.copyFileSync(src, envPath);
        this.log('info', `[CONFIG] Created .env from ${path.basename(src)}`);
        require('dotenv').config({ path: envPath, override: true });
        return;
      } catch (err) {
        this.log('warn', `[CONFIG] Could not create .env: ${err.message}`);
      }
    }
  }

  ensureEnvAiDefaults() {
    const current = this.readEnvFile();
    const updates = {};
    for (const [key, value] of Object.entries(AI_ENV_DEFAULTS)) {
      if (!current[key]) updates[key] = value;
    }
    const codex = this.getCodexStatus();
    const mode = (current.OPENAI_AUTH_MODE || '').trim().toLowerCase();
    if (codex.valid && (!mode || mode === 'auto')) {
      updates.OPENAI_AUTH_MODE = 'codex';
    }
    if (Object.keys(updates).length > 0) {
      this.writeEnvUpdates(updates);
      this.log('info', `[CONFIG] Added AI defaults to .env: ${Object.keys(updates).join(', ')}`);
    }
  }

  async ensureCodexProxy() {
    const codex = require('../src/codex-oauth');
    const existing = process.env.CODEX_PROXY_BASE_URL?.trim();
    if (existing) {
      if (await codex.probeCodexProxy(existing)) {
        return existing;
      }
      delete process.env.CODEX_PROXY_BASE_URL;
      this.codexProxyPromise = null;
      await codex.stopCodexProxy();
      this.log('warn', '[AI] Codex proxy URL set but port not reachable — restarting proxy…');
    }

    const authMode = (process.env.OPENAI_AUTH_MODE || 'codex').trim().toLowerCase();
    if (authMode === 'api_key' && process.env.OPENAI_API_KEY?.trim()) {
      return null;
    }

    if (!this.codexProxyPromise) {
      this.codexProxyPromise = (async () => {
        const codex = require('../src/codex-oauth');
        const result = await codex.startCodexProxy();
        if (!result.ok) {
          this.log('warn', `[AI] Codex proxy: ${result.message.replace(/\n/g, ' ')}`);
          return null;
        }
        process.env.CODEX_PROXY_BASE_URL = result.baseURL;
        this.log('success', `[AI] Codex proxy ready: ${result.baseURL}`);
        return result.baseURL;
      })();
    }

    return this.codexProxyPromise;
  }

  async restartCodexProxy() {
    const codex = require('../src/codex-oauth');
    try {
      await codex.stopCodexProxy();
    } catch {
      /* ignore */
    }
    delete process.env.CODEX_PROXY_BASE_URL;
    this.codexProxyPromise = null;
    const baseURL = await this.ensureCodexProxy();
    if (!baseURL) {
      return { ok: false, error: 'Codex proxy could not restart — check auth file and network.' };
    }
    return { ok: true, baseURL };
  }

  async getAiStatus() {
    try {
      await this.ensureCodexProxy();
    } catch (err) {
      this.log('warn', `[AI] Codex proxy skipped: ${err.message}`);
    }
    const env = this.readEnvFile();
    const codex = this.getCodexStatus();
    const out = {
      codex,
      env: {
        AI_PROVIDER_PRIMARY: env.AI_PROVIDER_PRIMARY || 'openai',
        AI_PROVIDER_FALLBACK: env.AI_PROVIDER_FALLBACK || 'ollama',
        OPENAI_AUTH_MODE: env.OPENAI_AUTH_MODE || 'codex',
        OPENAI_MODEL: env.OPENAI_MODEL || 'auto',
        hasApiKey: Boolean(env.OPENAI_API_KEY?.trim()),
      },
      codexProxyBaseURL: process.env.CODEX_PROXY_BASE_URL || null,
      probe: null,
    };

    try {
      const AIProvider = require('../src/ai-provider');
      const probe = new AIProvider(env.LANGUAGE || 'English');
      await probe.initialize();
      out.probe = {
        activeProvider: probe.activeProvider,
        openaiReady: probe.openaiReady,
        openaiAuthMode: probe.openaiAuthMode,
        openaiModel: probe.openaiModel,
        ollamaReady: probe.ollamaReady,
        ollamaModel: probe.ollamaModel,
      };
    } catch (err) {
      out.probe = { error: err.message };
    }

    return out;
  }

  accountCount() {
    return getAccountCount();
  }

  pairCount() {
    return getPairCount();
  }

  ensureCapacity() {
    const n = this.accountCount();
    for (let i = 0; i < n; i++) {
      if (!this.chatHistory.has(i)) this.chatHistory.set(i, []);
    }
    while (this.sessions.length < n) this.sessions.push(null);
    while (this.accountProxies.length < n) this.accountProxies.push(null);
  }

  reloadEnvConfig() {
    require('dotenv').config({ path: this.getEnvPath(), override: true });
    this.ensureCapacity();
  }

  async addPair() {
    const current = this.pairCount();
    if (current >= MAX_PAIRS) {
      return { ok: false, error: `Maximum ${MAX_PAIRS} pairs (${MAX_PAIRS * 2} accounts)` };
    }
    const next = current + 1;
    this.writeEnvUpdates({ PAIR_COUNT: String(next) });
    this.reloadEnvConfig();
    this.log('success', `[CONFIG] Added pair ${next} (${next * 2} accounts total)`);
    this.emit('status', this.getStatus());
    return { ok: true, pairCount: next, accountCount: this.accountCount() };
  }

  async _shutdownAndPurgeSlot(slot) {
    const name = getAccountName(slot);
    let session = this.sessions[slot];
    if (!session) session = new WhatsAppSession(name);
    session.autoReconnectAllowed = false;
    session.clearReconnectTimer();
    try {
      if (session.isConnected || session.socket) {
        session.isLoggingOut = true;
        await session.shutdown();
      }
    } catch (err) {
      this.log('warn', `[${name}] Shutdown before remove pair: ${err.message}`);
    }
    try {
      session.purgeLocalSession();
    } catch (err) {
      this.log('warn', `[${name}] Purge before remove pair: ${err.message}`);
    }
    this.sessions[slot] = null;
    this.chatHistory.delete(slot);
    this.logoutSlots.delete(slot);
    this.logoutPhase.delete(slot);

    const authDir = path.join(this.getAppRoot(), 'auth', name);
    if (fs.existsSync(authDir)) {
      try {
        fs.rmSync(authDir, { recursive: true, force: true });
      } catch (err) {
        this.log('warn', `[${name}] Could not delete auth folder: ${err.message}`);
      }
    }
  }

  async _moveSlotData(fromSlot, toSlot) {
    const authRoot = path.join(this.getAppRoot(), 'auth');
    const fromDir = path.join(authRoot, getAccountName(fromSlot));
    const toDir = path.join(authRoot, getAccountName(toSlot));

    const fromSession = this.sessions[fromSlot];
    if (fromSession) {
      fromSession.autoReconnectAllowed = false;
      fromSession.clearReconnectTimer();
      try {
        if (fromSession.isConnected || fromSession.socket) await fromSession.shutdown();
      } catch { /* noop */ }
    }
    const toSession = this.sessions[toSlot];
    if (toSession) {
      try {
        if (toSession.isConnected || toSession.socket) await toSession.shutdown();
      } catch { /* noop */ }
    }

    if (fs.existsSync(toDir)) fs.rmSync(toDir, { recursive: true, force: true });
    if (fs.existsSync(fromDir)) fs.renameSync(fromDir, toDir);

    this.sessions[fromSlot] = null;
    this.sessions[toSlot] = null;
    this.accountProxies[toSlot] = this.accountProxies[fromSlot] ?? null;
    this.accountProxies[fromSlot] = null;

    if (this.chatHistory.has(fromSlot)) {
      this.chatHistory.set(toSlot, this.chatHistory.get(fromSlot));
      this.chatHistory.delete(fromSlot);
    }

    if (this.logoutSlots.has(fromSlot)) {
      this.logoutSlots.delete(fromSlot);
      this.logoutSlots.add(toSlot);
    }
    if (this.logoutPhase.has(fromSlot)) {
      this.logoutPhase.set(toSlot, this.logoutPhase.get(fromSlot));
      this.logoutPhase.delete(fromSlot);
    }
  }

  /** Hapus pasangan mana pun (0-based). Pair di bawahnya naik; minimal 1 pair tetap ada. */
  async removePair(pairIndex) {
    const current = this.pairCount();
    if (current <= 1) {
      return { ok: false, error: 'At least one pair is required' };
    }
    if (pairIndex < 0 || pairIndex >= current) {
      return { ok: false, error: `Invalid pair index: ${pairIndex}` };
    }
    if (this.feedingStarting || (this.feedingProcess && !this.feedingProcess.killed)) {
      return { ok: false, error: 'Stop feeding before removing a pair' };
    }

    const oldAccountCount = this.accountCount();
    const slotA = pairIndex * 2;
    const slotB = slotA + 1;
    const removedPairNumber = pairIndex + 1;

    const labelSnapshot = {};
    for (let slot = 0; slot < oldAccountCount; slot++) {
      const row = this.slotLabels.getRow(slot);
      if (row) labelSnapshot[slot] = { ...row };
    }

    await this._shutdownAndPurgeSlot(slotA);
    await this._shutdownAndPurgeSlot(slotB);

    for (let slot = slotB + 1; slot < oldAccountCount; slot++) {
      const newSlot = slot - 2;
      await this._moveSlotData(slot, newSlot);
    }

    const newLabels = {};
    for (let slot = 0; slot < oldAccountCount; slot++) {
      if (slot >= slotA && slot <= slotB) continue;
      const newSlot = slot > slotB ? slot - 2 : slot;
      if (labelSnapshot[slot]) newLabels[String(newSlot)] = labelSnapshot[slot];
    }
    this.slotLabels.labels = newLabels;
    this.slotLabels.save();

    const next = current - 1;
    this.writeEnvUpdates({ PAIR_COUNT: String(next) });
    this.reloadEnvConfig();
    const newCount = this.accountCount();
    this.sessions = this.sessions.slice(0, newCount);
    this.accountProxies = this.accountProxies.slice(0, newCount);
    for (const key of [...this.chatHistory.keys()]) {
      if (key >= newCount) this.chatHistory.delete(key);
    }
    for (const key of [...this.logoutSlots]) {
      if (key >= newCount) this.logoutSlots.delete(key);
    }
    for (const key of [...this.logoutPhase.keys()]) {
      if (key >= newCount) this.logoutPhase.delete(key);
    }
    this.ensureCapacity();

    this.log(
      'success',
      `[CONFIG] Removed pair ${removedPairNumber} — now ${next} pair(s) (${newCount} accounts)`
    );
    const status = this.getStatus();
    this.emit('status', status);
    return {
      ok: true,
      pairCount: next,
      accountCount: newCount,
      removedPairNumber,
      removedPairIndex: pairIndex,
      removedSlots: [slotA, slotB],
      accounts: status.accounts,
    };
  }

  /** @deprecated — use removePair(pairCount - 1) */
  async removeLastPair() {
    return this.removePair(this.pairCount() - 1);
  }

  log(level, message, data = {}) {
    this.emit('log', { level, message, time: new Date().toISOString(), ...data });
  }

  emitAccountProgress(slot, phase, message) {
    this.logoutPhase.set(slot, phase);
    this.emit('account', { slot, action: 'logout', phase, message, time: new Date().toISOString() });
  }

  getProxyQrLinkMode() {
    const mode = (process.env.PROXY_QR_LINK || 'direct').toLowerCase();
    return mode === 'rotate' ? 'rotate' : 'direct';
  }

  getChatHistory(slot) {
    return this.chatHistory.get(slot) || [];
  }

  pushChat(slot, entry) {
    const list = this.chatHistory.get(slot) || [];
    const msg = {
      id: `${Date.now()}-${list.length}`,
      time: new Date().toISOString(),
      ...entry,
    };
    list.push(msg);
    while (list.length > MAX_CHAT_PER_ACCOUNT) list.shift();
    this.chatHistory.set(slot, list);
    this.emit('chat', { slot, message: msg });
    return msg;
  }

  clearChat(slot) {
    this.chatHistory.set(slot, []);
    this.emit('chat', { slot, cleared: true });
  }

  findSlotByLabel(label) {
    const want = String(label || '').trim();
    if (!want) return -1;
    for (let i = 0; i < this.accountCount(); i++) {
      if (getAccountLabel(i) === want) return i;
      const probe = new WhatsAppSession(getAccountName(i));
      const display = probe.getBestProfileNameFromDisk?.() || probe.loadProfileName();
      if (display && display === want) return i;
    }
    return -1;
  }

  /** Pesan dari proses feeding CLI → bubble chat di UI (WhatsApp Web style). */
  tryParseFeedingChatLog(line) {
    const m = line.match(
      /^\[Pair \d+\]\s+(.+?)\s*(?:→|->)\s*(.+?):\s+(.+?)(?:\s+\[\d+\/\d+\])?(?:\s+\(nudge\b.*)?$/u
    );
    if (!m) return false;
    const [, fromLabel, toLabel, text] = m;
    this.pushFeedingMessage(fromLabel.trim(), toLabel.trim(), text.trim(), 'message');
    return true;
  }

  pushFeedingMessage(fromLabel, toLabel, text, kind = 'message') {
    const body = String(text || '').trim();
    if (!body) return;

    const fromSlot = this.findSlotByLabel(fromLabel);
    const toSlot = this.findSlotByLabel(toLabel);

    if (kind === 'typing') {
      if (fromSlot >= 0) {
        this.pushChat(fromSlot, {
          direction: 'system',
          text: body,
          kind: 'typing',
        });
      }
      return;
    }

    if (fromSlot >= 0) {
      this.pushChat(fromSlot, {
        direction: 'out',
        text: body,
        to: toLabel,
        kind,
      });
    }
    if (toSlot >= 0) {
      this.pushChat(toSlot, {
        direction: 'in',
        text: body,
        from: fromLabel,
        kind,
      });
    }
  }

  getPartnerJidForSlot(slot) {
    const partnerSlot = getPartnerSlot(slot);
    const partnerSession = this.sessions[partnerSlot];
    const phone = partnerSession?.getPhone?.()
      || new WhatsAppSession(getAccountName(partnerSlot)).getAuthStatus().phone;
    if (!phone) return null;
    const cleaned = String(phone).replace(/[^0-9]/g, '');
    return cleaned ? `${cleaned}@s.whatsapp.net` : null;
  }

  setupSessionChatHooks(session, slotIndex) {
    session.removeAllListeners('message');
    const partnerJid = this.getPartnerJidForSlot(slotIndex);
    if (partnerJid) session.setExpectedPartner(partnerJid);

    session.on('message', (payload) => {
      const { sender, remoteJid, text, senderPn } = payload;
      const partner = session.expectedPartnerJid || this.getPartnerJidForSlot(slotIndex);
      const isPartner = partner
        ? session.isPartnerMessage(sender, remoteJid, partner, { senderPn })
        : true;

      if (!isPartner && partner) return;

      this.pushChat(slotIndex, {
        direction: 'in',
        text,
        from: getAccountLabel(getPartnerSlot(slotIndex)),
        peer: remoteJid || sender,
      });
    });

    if (session._desktopSendWrapped) return;
    session._desktopSendWrapped = true;
    const originalSend = session.sendMessage.bind(session);
    session.sendMessage = async (jid, text) => {
      const ok = await originalSend(jid, text);
      if (ok && text) {
        this.pushChat(slotIndex, {
          direction: 'out',
          text,
          to: getAccountLabel(getPartnerSlot(slotIndex)),
          peer: jid,
        });
      }
      return ok;
    };
  }

  refreshProfileNamesFromDisk() {
    for (let i = 0; i < this.accountCount(); i++) {
      const probe = new WhatsAppSession(getAccountName(i));
      probe.syncProfileNameFromDisk();
    }
  }

  isFeedingActive() {
    return Boolean(
      this.feedingStarting
      || (this.feedingProcess && !this.feedingProcess.killed)
    );
  }

  resolveDisplayName(probe, session, auth, slotIndex = null) {
    const fromCreds = probe.getBestProfileNameFromDisk?.() || null;
    if (fromCreds) return fromCreds;
    const fromSession = session?.getDisplayName?.() || auth.profileName || probe.loadProfileName() || null;
    if (fromSession) return fromSession;
    if (slotIndex != null) {
      const fromAms = this.slotLabels.get(slotIndex);
      if (fromAms) return fromAms;
    }
    return null;
  }

  setSlotDisplayLabel(slotIndex, accountName, extra = {}) {
    const row = this.slotLabels.set(slotIndex, accountName, extra);
    this.syncLinkedSlotAudit(slotIndex, extra);
    this.emit('status', this.getStatus());
    return row;
  }

  syncLinkedSlotAudit(slotIndex, extra = {}) {
    if (!this.isAccountLinked(slotIndex)) return null;
    const name = getAccountName(slotIndex);
    const session = this.sessions[slotIndex];
    const probe = new WhatsAppSession(name);
    const auth = probe.getAuthStatus();
    const labelRow = this.slotLabels.getRow(slotIndex) || {};
    const accountName = this.resolveDisplayName(probe, session, auth, slotIndex)
      || labelRow.accountName
      || getAccountLabel(slotIndex);
    const merged = { ...labelRow, ...extra };
    return this.auditLog.upsertLinkedSlot({
      slot: slotIndex,
      sessionName: name,
      accountName,
      location: merged.location || null,
      ipAddress: merged.ipAddress || null,
      proxyUrl: session?.proxyUrl || this.accountProxies[slotIndex] || null,
      reason: 'account_linked',
    });
  }

  syncLinkedSlotsAudit() {
    const updated = [];
    for (let i = 0; i < this.accountCount(); i++) {
      if (!this.isAccountLinked(i)) continue;
      const entry = this.syncLinkedSlotAudit(i);
      if (entry) updated.push(entry);
    }
    if (updated.length) this.emitAuditUpdate(updated[updated.length - 1]);
    return { count: updated.length, entries: updated };
  }

  /** Proxy shown in UI/logs: live socket, or feeding assignment when parent socket is down. */
  resolveAccountProxy(slot, session) {
    const assigned = this.accountProxies[slot] || null;
    const live = session?.proxyUrl || null;
    const feeding = this.isFeedingActive();
    const url = live || (feeding ? assigned : null);

    if (!url) {
      const linkedDirect = Boolean(session?.linkedViaDirect);
      return {
        masked: 'direct',
        mode: 'direct',
        source: linkedDirect ? 'linked-via-direct' : 'none',
        detail: linkedDirect
          ? 'Linked without proxy — preview uses local IP; feeding CLI may still assign proxy'
          : 'No proxy on this connection',
      };
    }

    const masked = this.proxyManager.maskUrl(url);
    let source = 'session';
    if (!live && feeding) source = 'feeding-assigned';
    return {
      masked,
      mode: 'proxy',
      source,
      detail: `WA traffic via ${masked} (${source})`,
    };
  }

  isAccountLinked(slot) {
    const name = getAccountName(slot);
    const session = this.sessions[slot];
    const auth = new WhatsAppSession(name).getAuthStatus();
    if (this.logoutSlots.has(slot)) return false;
    if (this.isFeedingActive()) {
      if (this.feedingLinkedSlots?.has(slot)) return true;
      return Boolean(auth.saved && auth.valid);
    }
    if (auth.saved && auth.valid && auth.registered) return true;
    return Boolean(
      session?.isConnected
      && !session?.isLoggedOut
      && !session?.isLoggingOut
      && auth.saved
      && auth.valid
    );
  }

  getStatus() {
    this.refreshProfileNamesFromDisk();
    const accounts = [];
    for (let i = 0; i < this.accountCount(); i++) {
      const name = getAccountName(i);
      const session = this.sessions[i];
      const probe = new WhatsAppSession(name);
      const auth = probe.getAuthStatus();
      const partnerSlot = getPartnerSlot(i);
      const partnerSession = this.sessions[partnerSlot];
      const partnerProbe = new WhatsAppSession(getAccountName(partnerSlot));
      const partnerAuth = partnerProbe.getAuthStatus();
      const hasSaved = this.isAccountLinked(i);
      const partnerHasSaved = this.isAccountLinked(partnerSlot);
      const displayName = this.resolveDisplayName(probe, session, auth, i);
      const partnerDisplayName = this.resolveDisplayName(
        partnerProbe,
        partnerSession,
        partnerAuth,
        partnerSlot
      );
      const slotLabel = getAccountLabel(i);
      const partnerSlotLabel = getAccountLabel(partnerSlot);
      accounts.push({
        slot: i,
        pairIndex: Math.floor(i / 2),
        name,
        label: displayName || slotLabel,
        slotLabel,
        displayName,
        partnerLabel: partnerDisplayName || partnerSlotLabel,
        partnerSlotLabel,
        partnerDisplayName,
        partnerSlot,
        phone: hasSaved || (auth.saved && auth.valid)
          ? session?.getPhone() || auth.phone || null
          : null,
        linking: Boolean(
          session?.isLinking
          && !session?.isConnected
          && !session?.isLoggedOut
          && !session?.isLoggingOut
        ),
        connected:
          !this.logoutSlots.has(i)
          && Boolean(session?.isConnected && !session?.isLoggedOut && !session?.isLoggingOut),
        feedingActive: this.isFeedingActive() && Boolean(this.feedingLinkedSlots?.has(i)),
        linkedViaDirect: Boolean(session?.linkedViaDirect),
        ...(() => {
          const px = this.resolveAccountProxy(i, session);
          return {
            proxy: px.masked,
            proxyMode: px.mode,
            proxySource: px.source,
            proxyDetail: px.detail,
          };
        })(),
        authSaved: hasSaved,
        loggingOut: this.logoutSlots.has(i),
        logoutPhase: this.logoutPhase.get(i) || null,
        authValid: auth.valid,
        authRegistered: auth.registered,
        loginMethod: session?.loginMethod || null,
        pairingCode: session?.pairingCodeDisplay || null,
        pairingPhone: session?.pairingPhone || null,
        chatCount: this.getChatHistory(i).length,
      });
    }

    const appRoot = this.getAppRoot();
    return {
      pairCount: this.pairCount(),
      accountCount: this.accountCount(),
      appRoot,
      authDir: path.join(appRoot, 'auth'),
      hasProxies: this.hasProxies,
      connecting: this.connecting,
      linkingSlot: this.linkingSlot,
      feedingRunning: Boolean(this.feedingProcess && !this.feedingProcess.killed),
      feedingStarting: Boolean(this.feedingStarting),
      feedingPairIndex: this.feedingPairIndex,
      feedingLaunchPhase: this.feedingLaunchPhase || 'prepare',
      lastFeedingComplete: this.lastFeedingComplete,
      accounts,
      proxies: this.proxyManager.proxies.map((url, idx) => ({
        index: idx,
        masked: this.proxyManager.maskUrl(url),
        assigned: this.accountProxies[idx]
          ? this.accountProxies[idx] === url
          : false,
      })),
      config: {
        proxyQrLink: this.getProxyQrLinkMode(),
        proxyProbe: process.env.PROXY_PROBE !== 'false',
        maxMessages: parseInt(process.env.MAX_MESSAGES || '20', 10),
        minDelay: parseInt(process.env.MIN_DELAY || '30', 10),
        maxDelay: parseInt(process.env.MAX_DELAY || '90', 10),
        language: process.env.LANGUAGE || 'English',
        openaiAuthMode: process.env.OPENAI_AUTH_MODE || 'codex',
        pairCount: this.pairCount(),
        accountStart: parseInt(process.env.ACCOUNT_START || '1', 10),
      },
      codex: this.getCodexStatus(),
    };
  }

  getAppRoot() {
    return process.env.APP_ROOT || process.cwd();
  }

  getElectronApp() {
    try {
      return require('electron').app;
    } catch {
      return null;
    }
  }

  /**
   * Jalankan index.js dari dalam app.asar agar require('dotenv') dll. resolve ke node_modules di asar.
   * Jangan pakai app.asar.unpacked/index.js — node_modules tidak ada di folder unpacked.
   */
  resolveFeedingScript() {
    const electronApp = this.getElectronApp();
    if (electronApp?.isPackaged) {
      return path.join(electronApp.getAppPath(), 'index.js');
    }

    const root = this.getAppRoot();
    const local = path.join(root, 'index.js');
    if (fs.existsSync(local)) return local;
    return path.join(__dirname, '..', 'index.js');
  }

  getFeedingEnv(root) {
    const env = { ...process.env, APP_ROOT: root };
    // NODE_OPTIONS dari parent bisa merusak argv child di Windows (path ber-spasi).
    delete env.NODE_OPTIONS;
    if (process.env.CODEX_PROXY_BASE_URL) {
      env.CODEX_PROXY_BASE_URL = process.env.CODEX_PROXY_BASE_URL;
    }
    const electronApp = this.getElectronApp();
    if (process.versions.electron) {
      env.ELECTRON_RUN_AS_NODE = '1';
      env.ELECTRON_NO_ATTACH_CONSOLE = '1';
    }
    if (electronApp?.isPackaged) {
      const asarRoot = electronApp.getAppPath();
      const asarNodeModules = path.join(asarRoot, 'node_modules');
      const parts = [asarNodeModules, env.NODE_PATH].filter(Boolean);
      env.NODE_PATH = parts.join(path.delimiter);
    }
    return env;
  }

  /**
   * Jalankan index.js feeding — fork() aman untuk path Windows ber-spasi (D:\Whatsapp Auto Feeding\...).
   * Fallback spawn -e require() untuk script di dalam app.asar.
   */
  spawnFeedingChild(scriptPath, root, env) {
    const resolvedScript = path.resolve(scriptPath);
    const resolvedRoot = path.resolve(root);
    const inAsar = resolvedScript.includes('.asar');

    if (!inAsar) {
      return fork(resolvedScript, [], {
        cwd: resolvedRoot,
        env,
        silent: true,
        execPath: process.execPath,
        windowsHide: true,
      });
    }

    const expr = `require(${JSON.stringify(resolvedScript)})`;
    return spawn(process.execPath, ['-e', expr], {
      cwd: resolvedRoot,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  getEnvPath() {
    return path.join(this.getAppRoot(), '.env');
  }

  getProxiesPath() {
    return path.join(this.getAppRoot(), 'proxies.txt');
  }

  getCodexAuthPath() {
    if (process.env.CODEX_AUTH_FILE) return process.env.CODEX_AUTH_FILE;
    return path.join(os.homedir(), '.codex', 'auth.json');
  }

  getCodexStatus() {
    const authPath = this.getCodexAuthPath();
    const exists = fs.existsSync(authPath);
    let valid = false;
    if (exists) {
      try {
        const raw = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        valid = Boolean(
          raw.access_token
          || raw.refresh_token
          || raw.tokens?.access_token
          || raw.tokens?.refresh_token
        );
      } catch {
        valid = false;
      }
    }
    return { path: authPath, exists, valid };
  }

  readEnvFile() {
    const envPath = this.getEnvPath();
    if (!fs.existsSync(envPath)) return {};
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    const out = {};
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return out;
  }

  readEnvRaw() {
    const envPath = this.getEnvPath();
    if (!fs.existsSync(envPath)) {
      const example = path.join(this.getAppRoot(), '.env.example');
      if (fs.existsSync(example)) return fs.readFileSync(example, 'utf8');
      return '';
    }
    return fs.readFileSync(envPath, 'utf8');
  }

  writeEnvUpdates(updates = {}) {
    const envPath = this.getEnvPath();
    let lines = [];
    if (fs.existsSync(envPath)) {
      lines = fs.readFileSync(envPath, 'utf8').split('\n');
    } else {
      const example = path.join(this.getAppRoot(), '.env.example');
      if (fs.existsSync(example)) {
        lines = fs.readFileSync(example, 'utf8').split('\n');
      }
    }

    const keys = Object.keys(updates);
    const seen = new Set();

    const newLines = lines.map((line) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      const eq = t.indexOf('=');
      if (eq === -1) return line;
      const key = t.slice(0, eq).trim();
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        seen.add(key);
        return `${key}=${updates[key]}`;
      }
      return line;
    });

    for (const key of keys) {
      if (!seen.has(key)) newLines.push(`${key}=${updates[key]}`);
    }

    fs.writeFileSync(envPath, `${newLines.join('\n').replace(/\n*$/, '')}\n`, 'utf8');

    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined && v !== null) process.env[k] = String(v);
    }

    require('dotenv').config({ path: envPath, override: true });
    this.log('success', '[SETTINGS] .env saved');
    this.emit('status', this.getStatus());
    return this.readEnvFile();
  }

  readProxiesRaw() {
    const p = this.getProxiesPath();
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf8');
  }

  writeProxiesRaw(content) {
    fs.writeFileSync(this.getProxiesPath(), content, 'utf8');
    this.log('success', '[SETTINGS] proxies.txt saved');
    return this.loadProxies();
  }

  async loadProxies() {
    this.proxyManager.filePath = this.getProxiesPath();
    this.hasProxies = this.proxyManager.load();
    if (!this.hasProxies) {
      this.accountProxies = [];
      return this.getStatus();
    }

    this.log('info', `[PROXY] Loaded ${this.proxyManager.proxies.length} proxies from proxies.txt`);
    this.accountProxies = await this.assignWorkingProxies();
    for (let i = 0; i < this.accountCount(); i++) {
      const name = getAccountName(i);
      const url = this.accountProxies[i];
      const route = url
        ? this.proxyManager.maskUrl(url)
        : 'direct (no working proxy for slot)';
      this.log('info', `[PROXY] Slot ${name}: ${route}`);
    }
    this.emit('status', this.getStatus());
    return this.getStatus();
  }

  async assignWorkingProxies() {
    const probeEnabled = process.env.PROXY_PROBE !== 'false';
    if (probeEnabled) {
      return this.proxyManager.assignWorkingForAccounts(this.accountCount(), (i) => getAccountName(i));
    }
    return this.proxyManager.assignForAccounts(this.accountCount());
  }

  async probeAllProxies(content = null) {
    this.proxyManager.filePath = this.getProxiesPath();
    const urls = content != null
      ? this.proxyManager.parseContent(content)
      : (this.proxyManager.load(), this.proxyManager.proxies);

    const results = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const ok = await probeProxy(url);
      results.push({ index: i, masked: this.proxyManager.maskUrl(url), ok });
      this.log('info', `[PROXY] ${this.proxyManager.maskUrl(url)} → ${ok ? 'OK' : 'FAIL'}`);
    }
    this.emit('proxies', results);
    return results;
  }

  attachSessionEvents(session, slotIndex) {
    const name = getAccountName(slotIndex);
    session.removeAllListeners('qr');
    session.removeAllListeners('connected');
    session.removeAllListeners('linkState');
    session.removeAllListeners('loggedOut');
    session.removeAllListeners('strictLogout');
    session.removeAllListeners('profileName');
    session.removeAllListeners('policyAlert');
    session.removeAllListeners('pairingCode');
    session.removeAllListeners('pairingCodePending');
    session.removeAllListeners('pairingCodeFailed');

    this.setupSessionChatHooks(session, slotIndex);

    session.on('qr', (qr) => {
      if (this.feedingStarting || (this.feedingProcess && !this.feedingProcess.killed)) {
        return;
      }
      this.emit('qr', { account: name, slot: slotIndex, qr, method: 'qr' });
    });

    session.on('pairingCodePending', () => {
      this.log('info', `[${name}] Requesting pairing code from WhatsApp…`);
      this.emit('status', this.getStatus());
    });

    session.on('pairingCodeFailed', (data) => {
      this.log('warn', `[${name}] Pairing code failed: ${data?.message || 'unknown'}`);
      this.emit('pairingCodeFailed', { account: name, slot: slotIndex, ...data });
      this.emit('status', this.getStatus());
    });

    session.on('pairingCode', (data) => {
      if (this.feedingStarting || (this.feedingProcess && !this.feedingProcess.killed)) {
        return;
      }
      this.emit('pairingCode', { account: name, slot: slotIndex, ...data });
      this.log('info', `[${name}] Pairing code: ${data.code}`);
      this.pushChat(slotIndex, {
        direction: 'system',
        kind: 'pairing',
        code: data.code,
        phone: data.phone,
        text: `Pairing code: ${data.code}\nOn your phone: WhatsApp → Linked devices → Link with phone number → enter this code.`,
      });
      this.emit('status', this.getStatus());
    });

    session.on('linkState', () => {
      this.emit('status', this.getStatus());
    });

    session.on('connected', (payload) => {
      if (this.linkingSlot === slotIndex) {
        this.linkingSlot = null;
      }
      const profileName = payload?.profileName || session.getDisplayName?.();
      const shown = profileName ? `${name} (${profileName})` : name;
      this.log('success', `[${shown}] Connected`);
      const partnerJid = this.getPartnerJidForSlot(slotIndex);
      if (partnerJid) session.setExpectedPartner(partnerJid);
      this.emit('status', this.getStatus());
    });

    session.on('profileName', (payload) => {
      if (payload?.profileName) {
        this.log('info', `[${name}] Profile name synced: ${payload.profileName}`);
      }
      this.emit('status', this.getStatus());
    });

    session.on('loggedOut', () => {
      this.log('warn', `[${name}] Logged out`);
      this.emit('status', this.getStatus());
    });

    session.on('strictLogout', ({ alert }) => {
      this.handleStrictLogout(slotIndex, alert).catch((err) => {
        this.log('error', `[${name}] Strict logout handler: ${err.message}`);
      });
    });

    session.on('policyAlert', (alert) => {
      if (!alert) return;
      if (
        (session.isPairingLinkActive?.() || (session.isLinking && !session.isConnected))
        && (alert.type === 'LOGGED_OUT_OR_RESTRICTED' || !alert.strictScanPossible)
        && /connection\s*failure|connection\s*closed|connection\s*lost/i.test(alert?.detail || '')
      ) {
        return;
      }
      this.emit('alert', { account: name, slot: slotIndex, ...alert });
      if (this.feedingProcess && !this.feedingProcess.killed) {
        const entry = this.auditLog.recordOrUpdate({
          runId: this.currentFeedingRunId,
          slot: slotIndex,
          sessionName: name,
          accountName: session.getDisplayName?.() || getAccountLabel(slotIndex),
          policyType: alert.type,
          reason: alert.title || alert.type,
          proxyUrl: session.proxyUrl || this.accountProxies[slotIndex] || null,
          pairIndex: Math.floor(slotIndex / 2),
        });
        this.emitAuditUpdate(entry);
      }
    });
  }

  emitAuditUpdate(entry) {
    this.emit('audit', {
      entry,
      summary: this.auditLog.computeSummary(),
    });
  }

  recordAuditEntry(payload) {
    const session = this.sessions[payload.slot];
    const entry = this.auditLog.recordOrUpdate({
      runId: payload.runId || this.currentFeedingRunId,
      slot: payload.slot,
      sessionName: payload.sessionName || getAccountName(payload.slot),
      accountName:
        payload.accountName
        || session?.getDisplayName?.()
        || getAccountLabel(payload.slot),
      feedingStatus: payload.feedingStatus,
      reason: payload.reason,
      policyType: payload.policyType,
      proxyUrl:
        payload.proxyUrl
        || session?.proxyUrl
        || this.accountProxies[payload.slot]
        || null,
      pairIndex: payload.pairIndex ?? Math.floor((payload.slot || 0) / 2),
      messageCount: payload.messageCount,
    });
    this.emitAuditUpdate(entry);
    return entry;
  }

  getAuditList(opts) {
    return this.auditLog.list(opts);
  }

  getAuditSummary() {
    return this.auditLog.computeSummary();
  }

  recordFeedingComplete(payload = {}) {
    const summary = this.getAuditSummary();
    this.lastFeedingComplete = {
      at: new Date().toISOString(),
      completed: payload.completed ?? summary.successVolume ?? 0,
      stopped: payload.stopped ?? Math.max(0, (payload.totalPairs ?? this.pairCount()) - (payload.completed ?? summary.successVolume ?? 0)),
      totalPairs: payload.totalPairs ?? this.pairCount(),
      messagesSent: payload.messagesSent ?? 0,
      success: payload.success !== false && !payload.manualStop,
      manualStop: Boolean(payload.manualStop),
    };
    this.emit('feedingComplete', this.lastFeedingComplete);
    this.emit('status', this.getStatus());
    return this.lastFeedingComplete;
  }

  dismissFeedingComplete() {
    if (!this.lastFeedingComplete) return { ok: true };
    this.lastFeedingComplete = { ...this.lastFeedingComplete, dismissed: true };
    this.emit('status', this.getStatus());
    return { ok: true };
  }

  exportAuditCsv() {
    return this.auditLog.exportCsv();
  }

  async ensurePreviewConnection(slotIndex) {
    if (this.feedingStarting || (this.feedingProcess && !this.feedingProcess.killed)) {
      return { ok: false, skipped: 'feeding' };
    }
    if (this.logoutSlots.has(slotIndex)) {
      return { ok: false, skipped: 'logout' };
    }
    const sessionName = getAccountName(slotIndex);
    const auth = new WhatsAppSession(sessionName).getAuthStatus();
    if (!auth.saved) {
      return { ok: false, skipped: 'no_auth' };
    }
    const existing = this.sessions[slotIndex];
    if (existing?.isConnected && !existing?.isLoggedOut) {
      return { ok: true, already: true };
    }
    if (existing?.isLinking) {
      return { ok: true, pending: true };
    }
    return this.connectAccount(slotIndex, { method: 'qr' });
  }

  /** Restore desktop preview sockets after feeding CLI exits (one account at a time). */
  async reconnectPreviewSessions() {
    if (this.feedingStarting || (this.feedingProcess && !this.feedingProcess.killed)) {
      return;
    }
    for (let i = 0; i < this.accountCount(); i++) {
      const auth = new WhatsAppSession(getAccountName(i)).getAuthStatus();
      if (!auth.saved || this.logoutSlots.has(i)) continue;
      const session = this.sessions[i];
      if (session?.isConnected || session?.isLinking) continue;
      try {
        await this.connectAccount(i, { method: 'qr' });
        await new Promise((r) => setTimeout(r, 1200));
      } catch (err) {
        this.log('warn', `[${getAccountName(i)}] Preview reconnect: ${err.message}`);
      }
    }
    this.emit('status', this.getStatus());
  }

  async connectAccount(slotIndex, plan = { method: 'qr' }) {
    if (this.feedingStarting || (this.feedingProcess && !this.feedingProcess.killed)) {
      throw new Error('Stop or wait for feeding startup to finish before linking accounts');
    }

    const sessionName = getAccountName(slotIndex);
    const existing = this.sessions[slotIndex];
    const pairingCodeActive = Boolean(
      existing?.loginMethod === 'pairing'
      && existing?.pairingCodeDisplay
      && !existing?.isConnected
    );
    const pairingBusy = Boolean(
      existing
      && existing.loginMethod === 'pairing'
      && existing.pairingPhone
      && !existing?.isConnected
      && (pairingCodeActive || existing.isLinking || existing.pairingCodeRequested)
    );

    if (plan.method === 'pairing' && pairingBusy && !plan.refreshPairing) {
      this.linkingSlot = slotIndex;
      this.emit('status', this.getStatus());
      this.log(
        'info',
        `[${sessionName}] Pairing already in progress — enter the code on your phone (do not request a new code)`
      );
      if (existing.pairingCodeDisplay) {
        existing.emit('pairingCode', {
          code: existing.pairingCodeDisplay,
          phone: existing.pairingPhone,
        });
      }
      return { ok: true, mode: 'direct', pending: true, pairingCodeActive: pairingCodeActive };
    }

    if (
      existing
      && existing.isLinking
      && !existing.isConnected
      && !plan.refreshPairing
    ) {
      const partial = existing.getAuthStatus();
      if (!partial.registered) {
        this.linkingSlot = slotIndex;
        this.emit('status', this.getStatus());
        this.log('info', `[${sessionName}] Link already in progress — wait before starting again`);
        if (existing.pairingCodeDisplay) {
          existing.emit('pairingCode', {
            code: existing.pairingCodeDisplay,
            phone: existing.pairingPhone,
          });
        }
        return { ok: true, mode: 'direct', pending: true, linkInProgress: true };
      }
    }

    const authProbe = new WhatsAppSession(sessionName).getAuthStatus();
    const needsFreshLink = !authProbe.valid || !authProbe.registered;

    if (needsFreshLink && this.linkingSlot !== null && this.linkingSlot !== slotIndex) {
      throw new Error(
        `${getAccountLabel(this.linkingSlot)} is still linking. Finish or cancel that link before starting ${getAccountLabel(slotIndex)}.`
      );
    }

    if (plan.clearIncomplete && pairingCodeActive && !plan.refreshPairing) {
      this.log(
        'warn',
        `[${sessionName}] Ignored clearIncomplete — active pairing code ${existing.pairingCodeDisplay} (enter it on your phone)`
      );
      plan = { ...plan, clearIncomplete: false };
    }

    if (plan.clearIncomplete) {
      const existing = this.sessions[slotIndex];
      if (existing) {
        existing.autoReconnectAllowed = false;
        existing.clearReconnectTimer?.();
        try {
          await existing.shutdown();
        } catch {
          /* ignore */
        }
      }
      const probe = new WhatsAppSession(sessionName);
      const partial = probe.getAuthStatus();
      if (partial.saved && !partial.registered) {
        probe.purgeLocalSession();
      }
      this.sessions[slotIndex] = null;
      if (this.linkingSlot === slotIndex) {
        this.linkingSlot = null;
      }
    }

    let session = this.sessions[slotIndex];

    if (plan.method === 'pairing' && (plan.clearIncomplete || plan.refreshPairing)) {
      if (session) {
        session.autoReconnectAllowed = false;
        session.clearReconnectTimer?.();
        try {
          await session.shutdown();
        } catch {
          /* ignore */
        }
      }
      const probe = new WhatsAppSession(sessionName);
      if (probe.getAuthStatus().saved && !probe.getAuthStatus().registered) {
        probe.purgeLocalSession();
        this.log('info', `[${sessionName}] Cleared incomplete session before phone pairing`);
      }
      this.sessions[slotIndex] = null;
      session = null;
      if (this.linkingSlot === slotIndex) {
        this.linkingSlot = null;
      }
    }

    if (!session) {
      session = new WhatsAppSession(sessionName);
      session.autoReconnectAllowed = true;
      this.sessions[slotIndex] = session;
    }

    const proxyUrl = this.hasProxies ? this.accountProxies[slotIndex] : null;
    const qrMode = this.getProxyQrLinkMode();

    if (needsFreshLink || plan.method === 'pairing') {
      this.linkingSlot = slotIndex;
      this.emit('status', this.getStatus());
    }

    this.log('info', `[${sessionName}] Connecting...`);
    this.attachSessionEvents(session, slotIndex);

    if (plan.method === 'pairing') {
      session.setProxy(null);
      session.linkedViaDirect = true;
      if (authProbe.saved && !authProbe.registered && !plan.clearIncomplete && !plan.refreshPairing) {
        session.purgeLocalSession();
        this.log('info', `[${sessionName}] Cleared incomplete session before phone pairing`);
      }
      this.log('info', `[${sessionName}] Link route: direct — phone pairing never uses proxy`);
      session.connect(plan).catch((err) => this.log('error', `[${sessionName}] ${err.message}`));
      return { ok: true, mode: 'direct', pending: true };
    }

    if (qrMode === 'direct' || !proxyUrl) {
      session.setProxy(null);
      session.linkedViaDirect = true;
      const why = !proxyUrl
        ? 'no proxy assigned to this slot'
        : `PROXY_QR_LINK=${qrMode} (QR link uses local IP by default)`;
      this.log('info', `[${sessionName}] Link route: direct — ${why}`);
      session.connect(plan).catch((err) => this.log('error', `[${sessionName}] ${err.message}`));
      return { ok: true, mode: 'direct', pending: true };
    }

    session.setProxy(proxyUrl);
    this.log(
      'info',
      `[${sessionName}] Link route: trying proxy ${this.proxyManager.maskUrl(proxyUrl)} (PROXY_QR_LINK=rotate)`
    );
    const outcome = await session.connectUntilReady(plan, 22000);

    if (outcome === 'qr_waiting' || outcome === 'connected') {
      this.log('info', `[${sessionName}] Link route: proxy OK — ${this.proxyManager.maskUrl(proxyUrl)}`);
      return { ok: true, outcome, proxy: proxyUrl };
    }

    session.setProxy(null);
    session.linkedViaDirect = true;
    this.log(
      'warn',
      `[${sessionName}] Link route: proxy failed for QR — falling back to direct (local IP)`
    );
    session.connect(plan).catch((err) => this.log('error', `[${sessionName}] ${err.message}`));
    return { ok: true, mode: 'direct_fallback' };
  }

  async connectAll(loginMethod = 'qr') {
    if (this.feedingStarting || (this.feedingProcess && !this.feedingProcess.killed)) {
      throw new Error('Cannot link while feeding is starting or running');
    }
    if (this.connecting) return this.getStatus();
    this.connecting = true;
    this.emit('status', this.getStatus());

    try {
      await this.loadProxies();
      const plan = { method: loginMethod === 'pairing' ? 'pairing' : 'qr' };

      for (let i = 0; i < this.accountCount(); i++) {
        const auth = new WhatsAppSession(getAccountName(i)).getAuthStatus();
        if (auth.valid) {
          const session = new WhatsAppSession(getAccountName(i));
          session.autoReconnectAllowed = true;
          this.sessions[i] = session;
          if (this.accountProxies[i]) session.setProxy(this.accountProxies[i]);
          this.attachSessionEvents(session, i);
          try {
            await session.connect();
          } catch (err) {
            this.log('error', `[${getAccountName(i)}] Connect failed: ${err.message}`);
          }
        } else {
          try {
            await this.connectAccount(i, plan);
          } catch (err) {
            this.log('error', `[${getAccountName(i)}] Link failed: ${err.message}`);
          }
        }
      }

      this.emit('status', this.getStatus());
      return this.getStatus();
    } finally {
      this.connecting = false;
      this.emit('status', this.getStatus());
    }
  }

  async disconnectAccount(slotIndex) {
    const session = this.sessions[slotIndex];
    if (session) {
      session.autoReconnectAllowed = false;
      session.clearReconnectTimer?.();
      await session.shutdown();
    }
    this.sessions[slotIndex] = null;
    if (this.linkingSlot === slotIndex) {
      this.linkingSlot = null;
    }
    this.log('info', `[${getAccountName(slotIndex)}] Disconnected`);
    this.emit('status', this.getStatus());
  }

  /**
   * WhatsApp strict scan / ban / hard 401–403: remove this account's local session and notify UI.
   */
  async handleStrictLogout(slotIndex, alert) {
    const now = Date.now();
    const last = this.strictLogoutAt.get(slotIndex) || 0;
    if (now - last < 12000) {
      return { ok: true, deduped: true };
    }
    this.strictLogoutAt.set(slotIndex, now);

    const sessionName = getAccountName(slotIndex);
    const accountLabel = getAccountLabel(slotIndex);
    let session = this.sessions[slotIndex];

    if (session) {
      session.autoReconnectAllowed = false;
      session.clearReconnectTimer?.();
      session.isLinking = false;
      try {
        await session.shutdown();
      } catch {
        /* ignore */
      }
    }

    const probe = new WhatsAppSession(sessionName);
    if (probe.getAuthStatus().saved) {
      probe.purgeLocalSession();
    }

    this.sessions[slotIndex] = null;
    this.logoutSlots.delete(slotIndex);
    this.logoutPhase.delete(slotIndex);
    this.clearChat(slotIndex);

    const normalizedAlert = {
      type: alert?.type || 'STRICT_LOGOUT',
      severity: alert?.severity || 'critical',
      title: alert?.title || 'Strict logout — session removed',
      detail:
        alert?.detail
        || 'WhatsApp ended or restricted this session. Local auth for this account was deleted.',
      strictScanPossible: alert?.strictScanPossible !== false,
      action:
        alert?.action
        || 'Open WhatsApp on your phone and check for a strict scan or temporary limit (~6h). Then go to Settings → Session → Clear all sessions before linking again.',
      statusCode: alert?.statusCode,
    };

    this.log(
      'warn',
      `[${sessionName}] Strict logout — local session deleted. Open Settings → Session → Clear all sessions.`
    );

    const payload = {
      slot: slotIndex,
      sessionName,
      accountLabel,
      alert: normalizedAlert,
      time: new Date().toISOString(),
    };
    this.emit('strictLogout', payload);
    this.emit('status', this.getStatus());
    return { ok: true, ...payload };
  }

  async logoutAccount(slotIndex) {
    if (this.feedingProcess && !this.feedingProcess.killed) {
      throw new Error('Stop feeding before logging out an account');
    }

    const sessionName = getAccountName(slotIndex);
    const probe = new WhatsAppSession(sessionName);
    const auth = probe.getAuthStatus();
    if (!auth.valid && !this.sessions[slotIndex]?.isConnected) {
      throw new Error('No linked session for this account');
    }

    this.logoutSlots.add(slotIndex);
    this.emitAccountProgress(slotIndex, 'start', 'Starting logout…');
    this.emit('status', this.getStatus());

    try {
      let session = this.sessions[slotIndex];
      if (!session) {
        session = new WhatsAppSession(sessionName);
        const proxyUrl = this.hasProxies ? this.accountProxies[slotIndex] : null;
        if (proxyUrl) session.setProxy(proxyUrl);
      } else if (session.isConnected || session.socket) {
        this.emitAccountProgress(slotIndex, 'disconnect', 'Closing connection…');
        this.log('info', `[${sessionName}] Closing connection before logout…`);
        session.isLoggingOut = true;
        try {
          await withTimeout(session.shutdown(), 12_000, 'Closing connection');
        } catch (err) {
          this.log('warn', `[${sessionName}] ${err.message} — forcing local disconnect`);
          await session.disconnect().catch(() => {});
        }
        session.isLoggingOut = false;
        session.isShuttingDown = false;
      }

      this.emitAccountProgress(slotIndex, 'remote', 'Logging out from WhatsApp…');
      this.log('info', `[${sessionName}] Logging out from WhatsApp…`);
      session.isLoggingOut = true;
      try {
        await withTimeout(session.logoutAndClear(), 35_000, 'WhatsApp logout');
      } catch (err) {
        this.log('warn', `[${sessionName}] ${err.message} — purging local session only`);
        session.purgeLocalSession();
      }

      this.sessions[slotIndex] = null;
      this.emitAccountProgress(slotIndex, 'clear', 'Removing session data…');
      this.clearChat(slotIndex);
      this.emitAccountProgress(slotIndex, 'done', 'Logout complete');
      this.log('success', `[${sessionName}] Logged out — scan QR to link again`);
    } finally {
      this.logoutSlots.delete(slotIndex);
      this.logoutPhase.delete(slotIndex);
      this.emit('status', this.getStatus());
    }
  }

  /**
   * Re-read auth/ from disk and drop stale in-memory sessions (fixes UI stuck after clear/logout).
   */
  async refreshAccounts() {
    const feedingActive =
      this.feedingStarting || (this.feedingProcess && !this.feedingProcess.killed);
    const count = this.accountCount();

    if (!feedingActive) {
      for (let i = 0; i < count; i++) {
        const session = this.sessions[i];
        if (!session) continue;
        if (session.isConnected) continue;
        const stillLinking =
          Boolean(session.isLinking) && !session.isLoggedOut && !session.isLoggingOut;
        if (stillLinking) continue;
        session.autoReconnectAllowed = false;
        session.clearReconnectTimer();
        try {
          await session.shutdown();
        } catch {
          /* ignore */
        }
        this.sessions[i] = null;
      }
    }

    const status = this.getStatus();
    this.emit('status', status);
    return status;
  }

  async disconnectAll() {
    const count = this.accountCount();
    for (let i = 0; i < count; i++) {
      const session = this.sessions[i];
      if (session) {
        session.autoReconnectAllowed = false;
        session.clearReconnectTimer();
        await session.shutdown();
      }
      this.sessions[i] = null;
    }
    this.sessions = [];
    this.emit('status', this.getStatus());
  }

  /**
   * Delete all local WhatsApp session data (auth/account*, prefs, proxy cache).
   * Use when sessions are corrupted or stuck — does not call WhatsApp remote logout.
   */
  async clearAllSessions() {
    if (this.feedingStarting || (this.feedingProcess && !this.feedingProcess.killed)) {
      this.stopFeeding();
      await new Promise((r) => setTimeout(r, 500));
    }

    const count = this.accountCount();
    for (let i = 0; i < count; i++) {
      let session = this.sessions[i];
      if (!session) {
        session = new WhatsAppSession(getAccountName(i));
      }
      session.autoReconnectAllowed = false;
      session.clearReconnectTimer();
      session.isLoggedOut = true;
      try {
        await withTimeout(session.shutdown(), 8_000, 'Session shutdown');
      } catch (err) {
        this.log('warn', `[${getAccountName(i)}] ${err.message} — forcing disconnect`);
        await session.disconnect().catch(() => {});
      }
      this.sessions[i] = null;
    }
    this.sessions = [];
    await new Promise((r) => setTimeout(r, 400));

    const authRoot = path.join(this.getAppRoot(), 'auth');
    const removed = [];

    if (fs.existsSync(authRoot)) {
      for (const entry of fs.readdirSync(authRoot)) {
        const full = path.join(authRoot, entry);
        if (/^account\d+$/i.test(entry)) {
          try {
            const stat = fs.statSync(full);
            if (stat.isDirectory()) {
              fs.rmSync(full, { recursive: true, force: true });
              removed.push(entry);
            }
          } catch (err) {
            this.log('warn', `[SESSIONS] Could not remove ${entry}: ${err.message}`);
          }
        }
      }
      for (const sidecar of ['_login-prefs.json', '_proxy-working.json']) {
        const p = path.join(authRoot, sidecar);
        if (fs.existsSync(p)) {
          try {
            fs.unlinkSync(p);
            removed.push(sidecar);
          } catch {
            /* ignore */
          }
        }
      }
    }

    for (let i = 0; i < this.accountCount(); i++) {
      this.clearChat(i);
    }
    this.sessions = [];
    this.logoutSlots.clear();
    this.logoutPhase.clear();
    this.slotLabels.clearAll();
    this.log('warn', `[SESSIONS] Cleared ${removed.length} item(s) from auth/ — link accounts again with QR`);
    const status = this.getStatus();
    this.emit('status', status);
    this.emit('sessionsCleared', { removed, accounts: status.accounts });
    return { ok: true, removed, authDir: authRoot, accounts: status.accounts };
  }

  stopFeeding() {
    this.feedingStarting = false;
    this.feedingLinkedSlots = null;
    this.feedingPairIndex = null;
    if (!this.feedingProcess) return { ok: true, wasRunning: false };
    try {
      this.feedingProcess.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    this.feedingProcess = null;
    this.log('warn', '[FEEDING] Stopped');
    this.recordFeedingComplete({
      manualStop: true,
      success: false,
      stopped: this.pairCount(),
      completed: 0,
      totalPairs: this.pairCount(),
    });
    this.emit('status', this.getStatus());
    return { ok: true, wasRunning: true };
  }

  setFeedingLaunchPhase(phase) {
    this.feedingLaunchPhase = phase;
    this.emit('status', this.getStatus());
  }

  failFeedingStart(message) {
    this.feedingStarting = false;
    this.feedingLaunchPhase = 'prepare';
    this.feedingLinkedSlots = null;
    this.feedingPairIndex = null;
    this.emit('status', this.getStatus());
    return { ok: false, error: message };
  }

  getCodexLoginCommand() {
    return 'npx @openai/codex login';
  }

  async startFeeding(options = {}) {
    if (this.feedingProcess && !this.feedingProcess.killed) {
      return { ok: false, error: 'Feeding already running' };
    }
    if (this.feedingStarting) {
      return { ok: false, error: 'Feeding is already starting' };
    }

    let pairIndex = options.pairIndex;
    if (pairIndex !== undefined && pairIndex !== null && pairIndex !== '') {
      pairIndex = parseInt(pairIndex, 10);
      if (!Number.isFinite(pairIndex) || pairIndex < 0 || pairIndex >= this.pairCount()) {
        return { ok: false, error: `Invalid pair (${options.pairIndex})` };
      }
    } else {
      pairIndex = null;
    }

    this.feedingStarting = true;
    this.feedingLaunchPhase = 'prepare';
    this.feedingPairIndex = pairIndex;
    this.lastFeedingComplete = null;
    this.emit('status', this.getStatus());

    try {
    if (pairIndex !== null) {
      const slotA = pairIndex * 2;
      const slotB = slotA + 1;
      if (!this.isAccountLinked(slotA) || !this.isAccountLinked(slotB)) {
        return this.failFeedingStart(
          `Pair ${pairIndex + 1} is not fully linked — scan QR for both accounts before Start feeding.`
        );
      }
      this.feedingLinkedSlots = new Set([slotA, slotB]);
    } else {
      const savedCount = this.accountCount();
      let linked = 0;
      for (let i = 0; i < savedCount; i++) {
        if (this.isAccountLinked(i)) linked += 1;
      }
      if (linked < savedCount) {
        return this.failFeedingStart(
          `Not all accounts are linked (${linked}/${savedCount}). Scan QR for each account in the sidebar before Start feeding.`
        );
      }

      this.feedingLinkedSlots = new Set();
      for (let i = 0; i < savedCount; i++) {
        this.feedingLinkedSlots.add(i);
      }
    }

    await this.ensureCodexProxy();
    const aiCheck = await this.getAiStatus();
    if (aiCheck.probe?.error) {
      return this.failFeedingStart(aiCheck.probe.error);
    }
    if (!aiCheck.probe?.openaiReady && !aiCheck.probe?.ollamaReady) {
      return this.failFeedingStart('No AI provider available.');
    }
    if (!aiCheck.probe?.openaiReady && aiCheck.probe?.ollamaReady) {
      this.log(
        'warn',
        '[AI] OpenAI/Codex unavailable — feeding will use Ollama only. Check Codex login or .env OPENAI_AUTH_MODE=codex'
      );
    } else if (aiCheck.probe?.openaiReady) {
      const mode = aiCheck.probe.openaiAuthMode === 'codex' ? 'Codex' : 'OpenAI API';
      this.log('info', `[AI] Feeding will use ${mode} (${aiCheck.probe.openaiModel})`);
    }

    const root = this.getAppRoot();
    if (pairIndex !== null) {
      this.log(
        'info',
        `[FEEDING] Pair ${pairIndex + 1} only — accounts ${getAccountName(pairIndex * 2)} & ${getAccountName(pairIndex * 2 + 1)}`
      );
    } else {
      this.log('info', `[FEEDING] All ${this.pairCount()} pair(s)`);
    }
    this.log('info', `[FEEDING] Auth folder: ${path.join(root, 'auth')}`);
    if (this.hasProxies) {
      this.log('info', '[FEEDING] Proxy plan for this run:');
      const slotsToLog = pairIndex !== null
        ? [pairIndex * 2, pairIndex * 2 + 1]
        : Array.from({ length: this.accountCount() }, (_, i) => i);
      for (const i of slotsToLog) {
        const name = getAccountName(i);
        const url = this.accountProxies[i];
        const route = url
          ? this.proxyManager.maskUrl(url)
          : 'direct (no working proxy for slot)';
        this.log('info', `[FEEDING]   ${name} → ${route}`);
      }
      this.log(
        'info',
        '[FEEDING] CLI will connect each account via route above (see Route (connect/connected) in log)'
      );
    } else {
      this.log('info', '[FEEDING] No proxies.txt — all accounts will use direct (local IP)');
    }

    this.setFeedingLaunchPhase('prepare');
    const clearSlots = pairIndex !== null
      ? [pairIndex * 2, pairIndex * 2 + 1]
      : Array.from({ length: this.accountCount() }, (_, i) => i);
    for (const i of clearSlots) {
      this.clearChat(i);
    }

    this.setFeedingLaunchPhase('disconnect');
    await this.disconnectAll();
    await new Promise((r) => setTimeout(r, 2500));

    this.setFeedingLaunchPhase('ai');
    const scriptPath = path.resolve(this.resolveFeedingScript());
    this.log('info', `[FEEDING] Starting CLI (${scriptPath})...`);
    this.log('info', `[FEEDING] Node: ${process.execPath}`);

    this.currentFeedingRunId = this.auditLog.createRun();
    this.setFeedingLaunchPhase('connect');

    const env = this.getFeedingEnv(root);
    env.DESKTOP_FEEDING = '1';
    env.DESKTOP_API_PORT = process.env.DESKTOP_API_PORT || '47821';
    env.FEEDING_RUN_ID = this.currentFeedingRunId;
    if (pairIndex !== null) {
      env.FEEDING_PAIR_INDEX = String(pairIndex);
    } else {
      delete env.FEEDING_PAIR_INDEX;
    }
    let child;
    try {
      child = this.spawnFeedingChild(scriptPath, root, env);
    } catch (err) {
      return this.failFeedingStart(`Failed to start feeding CLI: ${err.message}`);
    }

    this.feedingProcess = child;
    this.emit('status', this.getStatus());

    let launchEnded = false;
    let cliReady = false;
    const endFeedingLaunch = () => {
      if (launchEnded) return;
      launchEnded = true;
      this.feedingStarting = false;
      this.emit('status', this.getStatus());
    };
    const launchMaxTimer = setTimeout(endFeedingLaunch, 12000);

    const onLine = (buf, level = 'info') => {
      String(buf)
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((line) => {
          if (this.tryParseFeedingChatLog(line)) return;
          if (
            /Profile name|Connected as:/i.test(line)
            && !/~\s*$/.test(line)
          ) {
            this.refreshProfileNamesFromDisk();
            this.emit('status', this.getStatus());
          }
          if (/Route \((connect|connected)\):/i.test(line)) {
            this.emit('status', this.getStatus());
          }
          if (/^\[PROXY\]/i.test(line) || /Route \(/i.test(line) || /linkedViaDirect/i.test(line)) {
            this.log('info', line);
            return;
          }
          this.log(level, line);
          if (
            !cliReady
            && !line.includes('MODULE_NOT_FOUND')
            && /WhatsApp Auto Chat|SESSION STATUS|AI Provider|FEEDING|Connected as/i.test(line)
          ) {
            cliReady = true;
            clearTimeout(launchMaxTimer);
            setTimeout(endFeedingLaunch, 800);
          }
        });
    };

    child.stdout.on('data', (d) => onLine(d, 'info'));
    child.stderr.on('data', (d) => onLine(d, 'warn'));
    child.on('close', (code) => {
      clearTimeout(launchMaxTimer);
      endFeedingLaunch();
      if (code !== 0) {
        this.log(
          'error',
          '[FEEDING] CLI failed to start. Restart the app (stop npm run dev:app, then run again). If it persists, send the [FEEDING] Node log line.'
        );
      }
      this.log(code === 0 ? 'success' : 'warn', `[FEEDING] Exited (code ${code ?? '?'})`);
      this.feedingProcess = null;
      this.feedingLinkedSlots = null;
      this.feedingPairIndex = null;
      if (code === 0 && !this.lastFeedingComplete?.at) {
        this.recordFeedingComplete({ success: true });
      } else if (code !== 0 && code != null && !this.lastFeedingComplete?.at) {
        this.recordFeedingComplete({
          success: false,
          manualStop: true,
          stopped: this.pairCount(),
        });
      }
      this.emit('status', this.getStatus());
      this.reconnectPreviewSessions().catch((err) => {
        this.log('warn', `[FEEDING] Preview reconnect: ${err.message}`);
      });
    });
    child.on('error', (err) => {
      clearTimeout(launchMaxTimer);
      endFeedingLaunch();
      this.log('error', `[FEEDING] ${err.message}`);
      this.feedingProcess = null;
      this.feedingLinkedSlots = null;
      this.feedingPairIndex = null;
      this.emit('status', this.getStatus());
    });

    return { ok: true, pid: child.pid, pairIndex };
    } catch (err) {
      return this.failFeedingStart(err.message || String(err));
    }
  }

  getSettingsBundle() {
    return {
      env: this.readEnvFile(),
      envRaw: this.readEnvRaw(),
      proxies: this.readProxiesRaw(),
      codex: this.getCodexStatus(),
      config: this.getStatus().config,
    };
  }
}

module.exports = DesktopBridge;
