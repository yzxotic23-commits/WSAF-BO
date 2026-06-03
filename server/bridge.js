require('dotenv').config();
require('../src/silence-libsignal-logs');
if (process.env.AI_SDK_LOG_WARNINGS === undefined) {
  process.env.AI_SDK_LOG_WARNINGS = 'false';
}

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, fork, spawnSync } = require('child_process');
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

const MAX_PAIRS = 10;

const MAX_CHAT_PER_ACCOUNT = 400;

function getPartnerSlot(slot) {
  const pairBase = Math.floor(slot / 2) * 2;
  return slot % 2 === 0 ? pairBase + 1 : pairBase;
}

const AI_ENV_DEFAULTS = {
  AI_PROVIDER_PRIMARY: 'openai',
  AI_PROVIDER_FALLBACK: 'ollama',
  OPENAI_AUTH_MODE: 'codex',
  OPENAI_MODEL: 'auto',
};

class DesktopBridge {
  constructor(emit) {
    this.emit = emit || (() => {});
    this.sessions = [];
    this.proxyManager = new ProxyManager();
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
    this.codexProxyPromise = null;
    this.auditLog = new AuditLogStore(this.getAppRoot());
    this.currentFeedingRunId = null;
    this.lastFeedingComplete = null;
    this.ensureEnvAiDefaults();
    this.ensureFirstRunEnv();
    this.ensureCapacity();
    this.ensureCodexProxy().catch(() => {});
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
    if (process.env.CODEX_PROXY_BASE_URL?.trim()) {
      return process.env.CODEX_PROXY_BASE_URL.trim();
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
      const probe = new AIProvider(env.LANGUAGE || 'Indonesia');
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

  /** Hapus pasangan terakhir (2 akun) — PAIR_COUNT turun 1; minimal 1 pasang tetap ada. */
  async removeLastPair() {
    const current = this.pairCount();
    if (current <= 1) {
      return { ok: false, error: 'At least one pair is required' };
    }
    if (this.feedingStarting || (this.feedingProcess && !this.feedingProcess.killed)) {
      return { ok: false, error: 'Stop feeding before removing a pair' };
    }

    const pairIndex = current - 1;
    const slotA = pairIndex * 2;
    const slotB = slotA + 1;

    for (const slot of [slotA, slotB]) {
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

    const next = current - 1;
    this.writeEnvUpdates({ PAIR_COUNT: String(next) });
    this.reloadEnvConfig();
    const newCount = this.accountCount();
    this.sessions = this.sessions.slice(0, newCount);
    this.accountProxies = this.accountProxies.slice(0, newCount);
    for (const key of [...this.chatHistory.keys()]) {
      if (key >= newCount) this.chatHistory.delete(key);
    }
    this.ensureCapacity();

    this.log(
      'success',
      `[CONFIG] Removed pair ${current} — now ${next} pair(s) (${newCount} accounts)`
    );
    const status = this.getStatus();
    this.emit('status', status);
    return {
      ok: true,
      pairCount: next,
      accountCount: newCount,
      removedPairNumber: current,
      removedSlots: [slotA, slotB],
      accounts: status.accounts,
    };
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
    for (let i = 0; i < this.accountCount(); i++) {
      if (getAccountLabel(i) === want) return i;
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
      const hasSaved = auth.saved && !this.logoutSlots.has(i);
      const partnerHasSaved = partnerAuth.saved && !this.logoutSlots.has(partnerSlot);
      const displayName = hasSaved
        ? session?.getDisplayName?.() || auth.profileName || null
        : null;
      const partnerDisplayName = partnerHasSaved
        ? partnerSession?.getDisplayName?.() || partnerAuth.profileName || null
        : null;
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
        phone: hasSaved ? session?.getPhone() || auth.phone || null : null,
        linking: Boolean(
          session?.isLinking
          && !session?.isConnected
          && !session?.isLoggedOut
          && !session?.isLoggingOut
        ),
        connected:
          !this.logoutSlots.has(i)
          && Boolean(session?.isConnected && !session?.isLoggedOut && !session?.isLoggingOut),
        linkedViaDirect: Boolean(session?.linkedViaDirect),
        proxy: session?.proxyUrl ? this.proxyManager.maskUrl(session.proxyUrl) : 'direct',
        authSaved: hasSaved,
        loggingOut: this.logoutSlots.has(i),
        logoutPhase: this.logoutPhase.get(i) || null,
        authValid: auth.valid,
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
      feedingRunning: Boolean(this.feedingProcess && !this.feedingProcess.killed),
      feedingStarting: Boolean(this.feedingStarting),
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
        language: process.env.LANGUAGE || 'Indonesia',
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
    this.hasProxies = this.proxyManager.load();
    if (!this.hasProxies) {
      this.accountProxies = [];
      return this.getStatus();
    }

    this.log('info', `[PROXY] Loaded ${this.proxyManager.proxies.length} proxies`);
    this.accountProxies = await this.assignWorkingProxies();
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

  async probeAllProxies() {
    const results = [];
    for (let i = 0; i < this.proxyManager.proxies.length; i++) {
      const url = this.proxyManager.proxies[i];
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

    this.setupSessionChatHooks(session, slotIndex);

    session.on('qr', (qr) => {
      if (this.feedingStarting || (this.feedingProcess && !this.feedingProcess.killed)) {
        return;
      }
      this.emit('qr', { account: name, slot: slotIndex, qr, method: 'qr' });
    });

    session.on('pairingCode', (data) => {
      if (this.feedingStarting || (this.feedingProcess && !this.feedingProcess.killed)) {
        return;
      }
      this.emit('pairingCode', { account: name, slot: slotIndex, ...data });
      this.log('info', `[${name}] Pairing code: ${data.code}`);
    });

    session.on('linkState', () => {
      this.emit('status', this.getStatus());
    });

    session.on('connected', (payload) => {
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
    let session = this.sessions[slotIndex];

    if (!session) {
      session = new WhatsAppSession(sessionName);
      session.autoReconnectAllowed = true;
      this.sessions[slotIndex] = session;
    }

    const proxyUrl = this.hasProxies ? this.accountProxies[slotIndex] : null;
    const qrMode = this.getProxyQrLinkMode();

    this.log('info', `[${sessionName}] Connecting...`);
    this.attachSessionEvents(session, slotIndex);

    if (qrMode === 'direct' || !proxyUrl) {
      session.setProxy(null);
      session.linkedViaDirect = true;
      session.connect(plan).catch((err) => this.log('error', `[${sessionName}] ${err.message}`));
      return { ok: true, mode: 'direct', pending: true };
    }

    session.setProxy(proxyUrl);
    const outcome = await session.connectUntilReady(plan, 22000);

    if (outcome === 'qr_waiting' || outcome === 'connected') {
      return { ok: true, outcome, proxy: proxyUrl };
    }

    session.setProxy(null);
    session.linkedViaDirect = true;
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
    if (session) await session.shutdown();
    this.sessions[slotIndex] = null;
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
        await session.shutdown();
        session.isLoggingOut = false;
        session.isShuttingDown = false;
      }

      this.emitAccountProgress(slotIndex, 'remote', 'Logging out from WhatsApp…');
      this.log('info', `[${sessionName}] Logging out from WhatsApp…`);
      session.isLoggingOut = true;
      await session.logoutAndClear();

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

  /** Stop feeding + sessions before installer runs (Windows may spawn extra app.exe children). */
  async shutdownForUpdate() {
    this.stopFeeding(true);
    try {
      await Promise.race([
        this.disconnectAll(),
        new Promise((resolve) => setTimeout(resolve, 2500)),
      ]);
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
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
      await session.shutdown();
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
    this.log('warn', `[SESSIONS] Cleared ${removed.length} item(s) from auth/ — link accounts again with QR`);
    const status = this.getStatus();
    this.emit('status', status);
    this.emit('sessionsCleared', { removed, accounts: status.accounts });
    return { ok: true, removed, authDir: authRoot, accounts: status.accounts };
  }

  stopFeeding(force = false) {
    this.feedingStarting = false;
    if (!this.feedingProcess) return { ok: true, wasRunning: false };
    const child = this.feedingProcess;
    try {
      if (process.platform === 'win32' && force && child.pid) {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        child.kill(force ? 'SIGKILL' : 'SIGTERM');
      }
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
    this.emit('status', this.getStatus());
    return { ok: false, error: message };
  }

  getCodexLoginCommand() {
    return 'npx @openai/codex login';
  }

  async startFeeding() {
    if (this.feedingProcess && !this.feedingProcess.killed) {
      return { ok: false, error: 'Feeding already running' };
    }
    if (this.feedingStarting) {
      return { ok: false, error: 'Feeding is already starting' };
    }

    this.feedingStarting = true;
    this.feedingLaunchPhase = 'prepare';
    this.lastFeedingComplete = null;
    this.emit('status', this.getStatus());

    try {
    const savedCount = this.accountCount();
    let linked = 0;
    for (let i = 0; i < savedCount; i++) {
      const auth = new WhatsAppSession(getAccountName(i)).getAuthStatus();
      if (auth.saved && auth.valid && !this.logoutSlots.has(i)) linked += 1;
    }
    if (linked < savedCount) {
      return this.failFeedingStart(
        `Not all accounts are linked (${linked}/${savedCount}). Scan QR for each account in the sidebar before Start feeding.`
      );
    }

    await this.ensureCodexProxy();
    const aiCheck = await this.getAiStatus();
    if (aiCheck.probe?.error) {
      return this.failFeedingStart(aiCheck.probe.error);
    }
    if (!aiCheck.probe?.openaiReady && !aiCheck.probe?.ollamaReady) {
      const codex = this.getCodexStatus();
      const hint = codex.valid
        ? 'Codex token found but AI probe failed — check System log.'
        : 'Login Codex: Settings → AI → Login Codex (browser), or copy ~/.codex/auth.json from another PC. Or install Ollama and set AI_PROVIDER_FALLBACK=ollama.';
      return this.failFeedingStart(`No AI provider ready. ${hint}`);
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
    this.log('info', `[FEEDING] Auth folder: ${path.join(root, 'auth')}`);

    this.setFeedingLaunchPhase('prepare');
    for (let i = 0; i < this.accountCount(); i++) {
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
      this.emit('status', this.getStatus());
    });

    return { ok: true, pid: child.pid };
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
