const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  areJidsSameUser,
  jidNormalizedUser,
  isLidUser,
  isJidGroup,
  Browsers,
} = require('@whiskeysockets/baileys');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const {
  classifyDisconnect,
  classifySendError,
  formatPolicyAlert,
  isTransientHandshakeMessage,
} = require('./wa-policy-detector');
const ProxyManager = require('./proxy-manager');

class WhatsAppSession extends EventEmitter {
  constructor(sessionName) {
    super();
    this.sessionName = sessionName;
    this.socket = null;
    this.isConnected = false;
    /** True while socket is opening or auto-reconnect is in progress (desktop UI "connecting"). */
    this.isLinking = false;
    this.qrCount = 0;
    this.maxQrRetries = 10;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.proxyUrl = null;
    const { getAuthDir } = require('./app-root');
    this.authDir = getAuthDir(sessionName);
    this.isLoggedOut = false;
    this.isShuttingDown = false;
    this.isLoggingOut = false;
    /** Set false on shutdown() so delayed reconnect timers cannot reopen the socket. */
    this.autoReconnectAllowed = true;
    this.reconnectTimer = null;
    this.loginMethod = 'qr';
    this.pairingPhone = null;
    this.pairingCodeRequested = false;
    this.pairingCodeDisplay = null;
    /** True after pairing code is shown — waiting for user to enter it on phone. */
    this.pairingAwaitingUser = false;
    this.pairingReconnectAttempts = 0;
    this.pairingCodeRequestTimer = null;
    this.expectedPartnerJid = null;
    this.partnerLidJid = null;
    this.proxyFallbackAttempts = 0;
    this.proxyLinkFallbackDone = false;
    this.pendingLoginPlan = null;
    /** True when this run connected without proxy (QR/link or fallback). Continue must not force proxy. */
    this.linkedViaDirect = false;
    /** Parent rotates proxies; skip internal retry / proxyLinkFailed. */
    this.linkControlMode = false;
    this.displayName = null;
    this.profileProbeTimers = [];
  }

  extractProfileNameFromMe(me) {
    if (!me) return null;
    const notify = (me.notify || '').trim();
    const verified = (me.verifiedName || '').trim();
    const name = (me.name || '').trim();
    // Push name (notify) = what contacts see on WhatsApp; prefer over internal name field.
    if (notify && notify !== '~') return notify;
    if (verified && verified !== '~') return verified;
    if (name && name !== '~') return name;
    return null;
  }

  /** Best display name from creds (live) then profile-name.json; sync disk when creds wins. */
  getBestProfileNameFromDisk() {
    const credsPath = path.join(this.authDir, 'creds.json');
    let fromCreds = null;
    if (fs.existsSync(credsPath)) {
      try {
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
        fromCreds = this.extractProfileNameFromMe(creds?.me);
      } catch {
        /* ignore */
      }
    }
    const fromFile = this.loadProfileName();
    const best = fromCreds || fromFile || null;
    if (fromCreds && fromCreds !== fromFile) {
      this.saveProfileName(fromCreds);
    } else if (best) {
      this.displayName = best;
    }
    return best;
  }

  clearProfileProbeTimers() {
    if (!this.profileProbeTimers?.length) return;
    for (const timer of this.profileProbeTimers) clearTimeout(timer);
    this.profileProbeTimers = [];
  }

  scheduleProfileNameCapture() {
    this.clearProfileProbeTimers();
    for (const ms of [1500, 4000, 9000, 20000, 45000]) {
      const timer = setTimeout(() => {
        if (!this.isConnected || this.isShuttingDown) return;
        this.syncProfileNameFromDisk();
        this.captureProfileName(`wait-${ms}ms`);
      }, ms);
      this.profileProbeTimers.push(timer);
    }
  }

  /** Read push name from creds.json on disk (CLI feeding updates this file). */
  syncProfileNameFromDisk() {
    return this.getBestProfileNameFromDisk();
  }

  /** Save push name when Baileys provides it (often after connection open). */
  captureProfileName(source = 'update') {
    const me = this.socket?.authState?.creds?.me || this.socket?.user;
    let profileName = this.extractProfileNameFromMe(me);
    if (!profileName) profileName = this.syncProfileNameFromDisk();
    if (!profileName) return false;

    const previous = this.displayName || this.loadProfileName();
    if (previous === profileName) return false;

    this.saveProfileName(profileName);
    const phone = me?.id ? String(me.id).split(':')[0].split('@')[0] : null;
    console.log(`[${this.sessionName}] Profile name (${source}): ${profileName}`);
    this.emit('profileName', { profileName, phone, source });
    return true;
  }

  handleContactsProfileUpdate(contacts) {
    const myJid = this.socket?.user?.id;
    if (!myJid || !Array.isArray(contacts)) return;
    const myNorm = jidNormalizedUser(myJid);
    for (const c of contacts) {
      if (!c?.id || jidNormalizedUser(c.id) !== myNorm) continue;
      const profileName = this.extractProfileNameFromMe(c);
      if (!profileName) continue;
      const previous = this.displayName || this.loadProfileName();
      if (previous === profileName) continue;
      this.saveProfileName(profileName);
      console.log(`[${this.sessionName}] Profile name (contacts): ${profileName}`);
      this.emit('profileName', { profileName, source: 'contacts' });
      return;
    }
  }

  getProfileNamePath() {
    return path.join(this.authDir, 'profile-name.json');
  }

  loadProfileName() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.getProfileNamePath(), 'utf8'));
      const name = (raw?.name || '').trim();
      return name || null;
    } catch {
      return null;
    }
  }

  saveProfileName(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    this.displayName = trimmed;
    try {
      fs.mkdirSync(this.authDir, { recursive: true });
      fs.writeFileSync(
        this.getProfileNamePath(),
        JSON.stringify({ name: trimmed, updatedAt: new Date().toISOString() }, null, 2)
      );
    } catch (err) {
      console.error(`[${this.sessionName}] Failed to save profile name: ${err.message}`);
    }
  }

  /** WhatsApp profile name (saved after connect), else null. */
  getDisplayName() {
    if (this.displayName) return this.displayName;
    if (this.socket?.user) {
      const live = this.extractProfileNameFromMe(this.socket.user);
      if (live) return live;
    }
    return this.getBestProfileNameFromDisk() || this.loadProfileName();
  }

  getPartnerLidStorePath() {
    return path.join(this.authDir, 'partner-lid.json');
  }

  loadPartnerLid(partnerPhoneJid) {
    try {
      const storePath = this.getPartnerLidStorePath();
      if (!fs.existsSync(storePath)) return null;
      const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      const key = WhatsAppSession.phoneFromJid(partnerPhoneJid);
      return data[key] || data[partnerPhoneJid] || null;
    } catch {
      return null;
    }
  }

  savePartnerLid(partnerPhoneJid, lidJid) {
    try {
      const key = WhatsAppSession.phoneFromJid(partnerPhoneJid);
      if (!key || !lidJid) return;
      const storePath = this.getPartnerLidStorePath();
      let data = {};
      if (fs.existsSync(storePath)) {
        data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      }
      data[key] = jidNormalizedUser(lidJid);
      fs.writeFileSync(storePath, JSON.stringify(data, null, 2));
    } catch {
      // ignore write errors
    }
  }

  setExpectedPartner(partnerJid) {
    this.expectedPartnerJid = partnerJid ? jidNormalizedUser(partnerJid) : null;
    const saved = this.loadPartnerLid(this.expectedPartnerJid);
    if (saved) {
      this.partnerLidJid = jidNormalizedUser(saved);
      console.log(
        `[${this.sessionName}] Partner LID loaded: ${this.partnerLidJid} ↔ ${this.expectedPartnerJid}`
      );
    }
  }

  /** Only trust LID mappings from creds seed or verified phone-number metadata. */
  learnPartnerLid(lidJid, source = '') {
    const verified = source === 'creds_seed' || source === 'sender_pn' || source === 'phoneNumberShare';
    if (!verified) return;

    const lid = lidJid ? jidNormalizedUser(lidJid) : '';
    if (!lid || !isLidUser(lid)) return;
    if (this.partnerLidJid === lid) return;

    this.partnerLidJid = lid;
    console.log(
      `[${this.sessionName}] Partner LID mapped: ${lid} ↔ ${this.expectedPartnerJid || '?'} (${source})`
    );

    if (this.expectedPartnerJid) {
      this.savePartnerLid(this.expectedPartnerJid, lid);
    }
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  clearPairingCodeRequestTimer() {
    if (this.pairingCodeRequestTimer) {
      clearTimeout(this.pairingCodeRequestTimer);
      this.pairingCodeRequestTimer = null;
    }
  }

  /** Baileys expects [OS, browser, version] — wrong order breaks pairing codes. */
  getBrowserConfig() {
    return Browsers.windows('Chrome');
  }

  scheduleReconnect(fn, delayMs) {
    this.clearReconnectTimer();
    if (this.isShuttingDown || !this.autoReconnectAllowed) return;
    this.isLinking = true;
    this.emit('linkState');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isShuttingDown && !this.isLoggingOut && this.autoReconnectAllowed) {
        Promise.resolve(fn()).catch((err) => {
          const msg = err?.message || err?.output?.payload?.message || String(err);
          console.log(`[${this.sessionName}] Reconnect error: ${msg}`);
        });
      }
    }, delayMs);
  }

  /** Preserve pairing plan across auto-reconnects (bare connect() otherwise falls back to QR). */
  loginPlanForReconnect() {
    if (this.pendingLoginPlan?.method === 'pairing' && this.pendingLoginPlan?.phoneNumber) {
      return this.pendingLoginPlan;
    }
    if (this.loginMethod === 'pairing' && this.pairingPhone) {
      return { method: 'pairing', phoneNumber: this.pairingPhone };
    }
    return undefined;
  }

  scheduleReconnectWithLoginPlan(delayMs) {
    const plan = this.loginPlanForReconnect();
    this.scheduleReconnect(() => this.connect(plan), delayMs);
  }

  setProxy(proxyUrl) {
    this.proxyUrl = proxyUrl;
  }

  logConnectionRoute(phase = 'connect') {
    console.log(
      `[${this.sessionName}] Route (${phase}): ${ProxyManager.describeRoute(this.proxyUrl)}`
    );
  }

  buildBaseSocketOptions(version, state, logger, agent) {
    const socketOptions = {
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: this.getBrowserConfig(),
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      retryRequestDelayMs: 2000,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      getMessage: async () => undefined,
    };
    if (agent) {
      socketOptions.agent = agent;
      socketOptions.fetchAgent = agent;
    }
    return socketOptions;
  }

  emitPolicyAlert(alert) {
    if (!alert) return;
    console.log(formatPolicyAlert(this.sessionName, alert));
    this.emit('policyAlert', alert);
  }

  createProxyAgent(proxyUrl) {
    if (!proxyUrl) return undefined;

    try {
      if (proxyUrl.startsWith('socks')) {
        return new SocksProxyAgent(proxyUrl);
      } else {
        return new HttpsProxyAgent(proxyUrl);
      }
    } catch (err) {
      console.log(`[${this.sessionName}] Invalid proxy, using direct connection.`);
      return undefined;
    }
  }

  getAuthStatus() {
    const credsPath = path.join(this.authDir, 'creds.json');
    if (!fs.existsSync(credsPath)) {
      return {
        saved: false,
        valid: false,
        registered: false,
        phone: null,
        lid: null,
        profileName: null,
        pairingCode: null,
      };
    }

    try {
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      const meId = creds?.me?.id || '';
      const phone = meId ? meId.split(':')[0].split('@')[0] : null;
      const registered = Boolean(creds.registered);
      const valid = Boolean(meId && meId.includes('@'));
      const rawLid = creds?.me?.lid || '';
      const lid = rawLid ? jidNormalizedUser(rawLid) : null;
      const fromCreds = this.extractProfileNameFromMe(creds?.me);
      const fromFile = this.loadProfileName();
      const profileName = fromCreds || fromFile;
      if (fromCreds && fromCreds !== fromFile) {
        try {
          this.saveProfileName(fromCreds);
        } catch {
          /* ignore */
        }
      }
      return {
        saved: true,
        valid,
        registered,
        phone,
        lid,
        profileName,
        pairingCode: creds?.pairingCode || null,
      };
    } catch {
      return {
        saved: true,
        valid: false,
        registered: false,
        phone: null,
        lid: null,
        profileName: null,
        pairingCode: null,
      };
    }
  }

  restorePairingFromPartialAuth(authStatus) {
    if (!authStatus?.valid || authStatus.registered || !authStatus.phone) return false;
    this.loginMethod = 'pairing';
    this.pairingPhone = this.normalizePairingPhone(authStatus.phone);
    if (authStatus.pairingCode) {
      this.pairingCodeDisplay = this.formatPairingCode(authStatus.pairingCode);
      this.pairingAwaitingUser = true;
    }
    this.pendingLoginPlan = { method: 'pairing', phoneNumber: this.pairingPhone };
    return true;
  }

  isRegistrationComplete() {
    try {
      const live = this.socket?.authState?.creds?.registered;
      if (live === true) return true;
      if (live === false) return false;
      return this.getAuthStatus().registered;
    } catch {
      return false;
    }
  }

  finalizeSuccessfulLogin() {
    if (this.isShuttingDown || !this.socket?.user) return;
    if (this.isConnected && this.isRegistrationComplete()) return;

    this.isLinking = false;
    this.isConnected = true;
    this.isLoggedOut = false;
    this.pairingAwaitingUser = false;
    this.pairingCodeDisplay = null;
    this.pairingCodeRequested = false;
    this.pairingReconnectAttempts = 0;
    this.qrCount = 0;
    this.reconnectAttempts = 0;
    this.proxyFallbackAttempts = 0;
    this.linkedViaDirect = !this.proxyUrl;

    const user = this.socket.user;
    const phone = user.id.split(':')[0];
    const profileName = this.extractProfileNameFromMe(user);
    if (profileName) this.saveProfileName(profileName);
    console.log(`[${this.sessionName}] Connected as: ${profileName || phone}`);
    console.log(`[${this.sessionName}] JID: ${jidNormalizedUser(user.id)}`);
    this.logConnectionRoute('connected');
    if (!this.proxyUrl) {
      console.log(
        `[${this.sessionName}] linkedViaDirect=true — preview reconnect may skip proxy; feeding CLI still assigns proxy from proxies.txt`
      );
    }
    this.emit('connected', { user, profileName: profileName || null, phone });
    this.scheduleProfileNameCapture();
    this.emit('linkState');
  }

  /** Phone pairing in progress — not yet fully connected. */
  isPairingLinkActive() {
    if (this.loginMethod !== 'pairing' || !this.pairingPhone) return false;
    if (this.isConnected || this.isShuttingDown || this.isLoggingOut) return false;
    return true;
  }

  /** Transient WA disconnects during pairing — not a ban/logout. */
  isTransientPairingDisconnect(lastDisconnect) {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const errMsg = lastDisconnect?.error?.message || '';
    if (statusCode === DisconnectReason.forbidden) return false;
    if (statusCode === DisconnectReason.connectionReplaced) return false;
    if (statusCode === DisconnectReason.restartRequired) return false;
    const softMsg = /connection\s*failure|connection\s*closed|connection\s*lost|timed\s*out|econnreset|network|stream\s*errored|conflict/i.test(
      errMsg
    );
    return (
      softMsg
      || statusCode === DisconnectReason.badSession
      || statusCode === DisconnectReason.loggedOut
      || statusCode === DisconnectReason.connectionClosed
      || statusCode === DisconnectReason.connectionLost
    );
  }

  /** Returns this account's own LID from creds (available after connect). */
  getMyLid() {
    try {
      // Try from the live running socket first
      const liveLid = this.socket?.authState?.creds?.me?.lid || '';
      if (liveLid) return jidNormalizedUser(liveLid);
      // Fallback: read from saved creds.json
      const credsPath = path.join(this.authDir, 'creds.json');
      if (fs.existsSync(credsPath)) {
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
        const savedLid = creds?.me?.lid || '';
        if (savedLid) return jidNormalizedUser(savedLid);
      }
      return null;
    } catch {
      return null;
    }
  }

  hasSavedAuth() {
    return this.getAuthStatus().valid;
  }

  deleteAuthFolder() {
    try {
      if (fs.existsSync(this.authDir)) {
        fs.rmSync(this.authDir, { recursive: true, force: true });
        console.log(`[${this.sessionName}] Auth folder deleted: ${this.authDir}`);
      }
    } catch (err) {
      console.error(`[${this.sessionName}] Failed to delete auth folder: ${err.message}`);
    }
  }

  /** Hapus sisa metadata sesi (login prefs, proxy cache) di folder auth/. */
  clearSessionSidecars() {
    const { getAppRoot } = require('./app-root');
    const authRoot = path.join(getAppRoot(), 'auth');

    const loginPrefsPath = path.join(authRoot, '_login-prefs.json');
    if (fs.existsSync(loginPrefsPath)) {
      try {
        const prefs = JSON.parse(fs.readFileSync(loginPrefsPath, 'utf8'));
        if (prefs[this.sessionName]) {
          delete prefs[this.sessionName];
          if (Object.keys(prefs).length === 0) {
            fs.unlinkSync(loginPrefsPath);
          } else {
            fs.writeFileSync(loginPrefsPath, JSON.stringify(prefs, null, 2));
          }
        }
      } catch {
        /* ignore */
      }
    }

    const proxyStorePath = path.join(authRoot, '_proxy-working.json');
    if (fs.existsSync(proxyStorePath)) {
      try {
        const store = JSON.parse(fs.readFileSync(proxyStorePath, 'utf8'));
        if (store[this.sessionName]) {
          delete store[this.sessionName];
          if (Object.keys(store).length === 0) {
            fs.unlinkSync(proxyStorePath);
          } else {
            fs.writeFileSync(proxyStorePath, JSON.stringify(store, null, 2));
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  /** Hapus semua data sesi lokal untuk akun ini (folder auth + metadata). */
  purgeLocalSession() {
    this.deleteAuthFolder();
    this.clearSessionSidecars();
    this.displayName = null;
    this.partnerLidJid = null;
    this.expectedPartnerJid = null;
    console.log(`[${this.sessionName}] Local session data fully removed`);
  }

  async disconnect() {
    this.clearProfileProbeTimers();
    this.clearReconnectTimer();
    this.clearPairingCodeRequestTimer();
    this.isLinking = false;
    if (this.socket) {
      this.socket.ev.removeAllListeners();
      try {
        this.socket.end();
      } catch (_) {}
      this.socket = null;
      this.isConnected = false;
    }
    this.emit('linkState');
  }

  async shutdown() {
    this.isShuttingDown = true;
    this.autoReconnectAllowed = false;
    this.clearReconnectTimer();
    this.clearPairingCodeRequestTimer();
    await this.disconnect();
    console.log(`[${this.sessionName}] Connection closed (auth saved, not logged out).`);
  }

  resetForReconnect() {
    this.isShuttingDown = false;
    this.isLoggedOut = false;
    this.reconnectAttempts = 0;
    this.qrCount = 0;
  }

  /** Connect briefly with saved creds so WhatsApp receives a remote logout. */
  async openSocketForLogout(timeoutMs = 25000) {
    if (this.socket || !this.hasSavedAuth()) return;

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level: 'silent' });
    const agent = this.createProxyAgent(this.proxyUrl);

    const socketOptions = this.buildBaseSocketOptions(version, state, logger, agent);
    this.socket = makeWASocket(socketOptions);
    this.socket.ev.on('creds.update', saveCreds);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Connection timeout')), timeoutMs);
      const onUpdate = (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
          clearTimeout(timer);
          this.socket.ev.off('connection.update', onUpdate);
          resolve();
        }
        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code === DisconnectReason.loggedOut) {
            clearTimeout(timer);
            this.socket.ev.off('connection.update', onUpdate);
            resolve();
          }
        }
      };
      this.socket.ev.on('connection.update', onUpdate);
    });
  }

  async logoutAndClear() {
    this.isShuttingDown = true;
    this.isLoggingOut = true;
    this.clearReconnectTimer();

    try {
      if (!this.socket && this.hasSavedAuth()) {
        try {
          console.log(`[${this.sessionName}] Connecting to send logout to WhatsApp...`);
          await this.openSocketForLogout();
        } catch (err) {
          console.log(`[${this.sessionName}] Remote logout skipped: ${err.message}`);
        }
      }

      if (this.socket) {
        try {
          await this.socket.logout();
          console.log(`[${this.sessionName}] Logged out from WhatsApp device.`);
        } catch (err) {
          console.log(`[${this.sessionName}] Logout: ${err.message}`);
        }
        try {
          this.socket.ev.removeAllListeners();
        } catch (_) {}
        this.socket = null;
      }

      this.isConnected = false;
      this.isLoggedOut = true;
      this.purgeLocalSession();
    } finally {
      this.isLoggingOut = false;
      this.isShuttingDown = false;
    }
  }

  async reconnectWithProxy(proxyUrl, loginOptions = null) {
    await this.disconnect();
    this.setProxy(proxyUrl);
    await this.connect(loginOptions || { method: this.loginMethod, phoneNumber: this.pairingPhone });
  }

  formatPairingCode(code) {
    const raw = (code || '').replace(/-/g, '');
    if (raw.length === 8) return `${raw.slice(0, 4)}-${raw.slice(4)}`;
    return code;
  }

  /** E.164 digits only — no +, spaces, or leading zeros after country code. */
  normalizePairingPhone(phoneNumber) {
    let p = String(phoneNumber || '').replace(/\D/g, '');
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

  async requestPairingLogin(phoneNumber) {
    if (!this.socket || this.isShuttingDown) return null;
    const cleaned = this.normalizePairingPhone(phoneNumber);
    if (cleaned.length < 8 || cleaned.length > 15) {
      throw new Error('Invalid phone — use country code + number, digits only (e.g. 628123456789)');
    }
    this.pairingPhone = cleaned;

    const code = await this.socket.requestPairingCode(cleaned);
    const display = this.formatPairingCode(code);

    console.log('');
    console.log('='.repeat(50));
    console.log(`[${this.sessionName}] PAIRING CODE: ${display}`);
    console.log('='.repeat(50));
    console.log('On your phone: WhatsApp → Settings → Linked devices');
    console.log('→ Link a device → Link with phone number instead');
    console.log(`→ Enter code: ${display}`);
    console.log('(Code expires in a few minutes — request new if needed)');
    console.log('='.repeat(50));
    console.log('');

    this.pairingCodeDisplay = display;
    this.pairingAwaitingUser = true;
    this.pairingReconnectAttempts = 0;
    this.emit('pairingCode', { code: display, phone: cleaned });
    return display;
  }

  maybeRequestPairingCode(connection, qr) {
    if (this.loginMethod !== 'pairing' || !this.pairingPhone || this.pairingCodeRequested) {
      return;
    }
    const authStatus = this.getAuthStatus();
    if (authStatus.valid && authStatus.registered) return;
    const registered = this.socket?.authState?.creds?.registered;
    if (registered) return;
    if (!qr && connection !== 'connecting') return;
    if (this.pairingCodeRequestTimer) return;

    const delayMs = qr ? 1500 : 2500;
    console.log(
      `[${this.sessionName}] Pairing handshake ready — requesting code in ${delayMs / 1000}s...`
    );
    this.emit('pairingCodePending', { phone: this.pairingPhone });

    this.pairingCodeRequestTimer = setTimeout(() => {
      this.pairingCodeRequestTimer = null;
      if (this.isShuttingDown || !this.socket || this.pairingCodeRequested) return;

      this.pairingCodeRequested = true;
      this.requestPairingLogin(this.pairingPhone).catch((err) => {
        const msg = err?.message || String(err);
        console.log(`[${this.sessionName}] Pairing code error: ${msg}`);
        this.pairingCodeRequested = false;
        this.emit('pairingCodeFailed', { message: msg, phone: this.pairingPhone });
      });
    }, delayMs);
  }

  /**
   * @param {{ method?: 'qr'|'pairing', phoneNumber?: string }} loginOptions
   */
  async connect(loginOptions = {}) {
    if (this.isShuttingDown || !this.autoReconnectAllowed) return;

    this.isLinking = true;
    this.emit('linkState');
    this.clearPairingCodeRequestTimer();

    if (this.socket) {
      this.socket.ev.removeAllListeners();
      try { this.socket.end(); } catch (_) {}
      this.socket = null;
    }

    const authStatus = this.getAuthStatus();
    const hasCompleteAuth = authStatus.valid && authStatus.registered && loginOptions.method !== 'pairing';

    if (hasCompleteAuth) {
      this.loginMethod = 'qr';
      this.pairingAwaitingUser = false;
      this.pairingCodeDisplay = null;
    } else {
      if (loginOptions.method === 'pairing') {
        this.loginMethod = 'pairing';
      } else if (loginOptions.method === 'qr') {
        this.loginMethod = 'qr';
      } else if (this.loginMethod === 'pairing' && this.pairingPhone) {
        // Bare reconnect after pairing code accepted (restartRequired) — keep finish path.
      } else if (this.restorePairingFromPartialAuth(authStatus)) {
        // Partial pairing session on disk — stay on pairing, not QR.
      } else {
        this.loginMethod = 'qr';
      }
      this.pairingPhone = loginOptions.phoneNumber
        ? this.normalizePairingPhone(loginOptions.phoneNumber)
        : this.pairingPhone || null;
      this.pendingLoginPlan = {
        method: this.loginMethod,
        phoneNumber: this.pairingPhone,
      };
      if (this.loginMethod !== 'pairing') {
        this.pairingAwaitingUser = false;
        this.pairingCodeDisplay = null;
      }
    }
    if (this.loginMethod !== 'pairing') {
      this.pairingCodeRequested = false;
    } else if (!this.pairingCodeDisplay) {
      this.pairingCodeRequested = false;
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    const safeSaveCreds = async (update) => {
      try {
        await saveCreds(update);
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    };

    if (hasCompleteAuth) {
      const phoneHint = authStatus.phone ? ` (${authStatus.phone})` : '';
      console.log(`[${this.sessionName}] Saved session found${phoneHint} — reconnecting...`);
    } else if (authStatus.valid && !authStatus.registered) {
      console.log(
        `[${this.sessionName}] Session on disk (valid, not registered yet) — completing link...`
      );
    } else if (this.loginMethod === 'pairing') {
      console.log(`[${this.sessionName}] No session — login via pairing code (${this.pairingPhone})`);
    } else {
      console.log(`[${this.sessionName}] No session — scan QR to link`);
    }

    this.logConnectionRoute('connect');

    const logger = pino({ level: 'silent' });
    const agent = this.createProxyAgent(this.proxyUrl);

    this.qrCount = 0;

    const socketOptions = this.buildBaseSocketOptions(version, state, logger, agent);
    this.socket = makeWASocket(socketOptions);

    this.socket.ev.on('creds.update', async (update) => {
      await safeSaveCreds(update);
      if (this.isShuttingDown) return;
      if (this.isRegistrationComplete() && !this.isConnected) {
        this.finalizeSuccessfulLogin();
      } else if (!this.isPairingLinkActive()) {
        this.captureProfileName('creds.update');
      }
    });

    this.socket.ev.on('contacts.update', (contacts) => {
      this.handleContactsProfileUpdate(contacts);
    });
    this.socket.ev.on('contacts.upsert', (contacts) => {
      this.handleContactsProfileUpdate(contacts);
    });

    this.socket.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
      if (!lid || !jid || !this.expectedPartnerJid) return;
      const pn = jidNormalizedUser(jid);
      if (this.isSameUser(pn, this.expectedPartnerJid)) {
        this.learnPartnerLid(lid, 'phoneNumberShare');
      }
    });

    this.socket.ev.on('connection.update', (update) => {
      if (this.isShuttingDown || this.isLoggingOut) return;

      const { connection, lastDisconnect, qr } = update;

      if (qr && this.loginMethod !== 'pairing') {
        this.qrCount++;
        if (this.qrCount > this.maxQrRetries) {
          console.log(`[${this.sessionName}] QR expired ${this.maxQrRetries}x. Scan QR or restart app.`);
          return;
        }

        if (this.qrCount > 1) {
          console.log(`\n[${this.sessionName}] QR expired, auto-refreshing... (${this.qrCount}/${this.maxQrRetries})`);
        } else {
          console.log(`\n[${this.sessionName}] Scan this QR Code:`);
        }
        console.log('-'.repeat(40));
        qrcode.generate(qr, { small: true });
        console.log('-'.repeat(40));
        console.log(`Waiting for scan... (auto-refresh on expire)`);
        this.emit('qr', qr);
      }

      if (connection === 'connecting') {
        this.isLinking = true;
        this.emit('linkState');
        this.maybeRequestPairingCode(connection, qr);
      }

      if (qr && this.loginMethod === 'pairing') {
        this.maybeRequestPairingCode(connection, qr);
      }

      if (connection === 'open') {
        if (!this.isRegistrationComplete()) {
          this.isLinking = true;
          this.isConnected = false;
          this.emit('linkState');
          console.log(
            `[${this.sessionName}] Waiting for login to finish — enter pairing code on phone or scan QR`
          );
          return;
        }
        this.finalizeSuccessfulLogin();
      }

      if (connection === 'close') {
        this.isConnected = false;
        if (this.isLoggingOut) return;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isReplaced = statusCode === DisconnectReason.connectionReplaced;
        const isBadSession = statusCode === DisconnectReason.badSession;
        const isRestartRequired = statusCode === DisconnectReason.restartRequired;

        const reasonLabels = {
          [DisconnectReason.loggedOut]: 'logged out / invalid session',
          [DisconnectReason.connectionReplaced]: 'logged in elsewhere',
          [DisconnectReason.connectionClosed]: 'connection closed',
          [DisconnectReason.connectionLost]: 'connection lost',
          [DisconnectReason.restartRequired]: 'restart required',
          [DisconnectReason.badSession]: 'bad session',
          [DisconnectReason.forbidden]: 'forbidden',
        };
        const reasonText = reasonLabels[statusCode] || `code ${statusCode}`;
        console.log(`[${this.sessionName}] Disconnected: ${reasonText}`);

        const pairingActive = this.isPairingLinkActive();
        if (pairingActive) {
          this.isLinking = true;
          this.isLoggedOut = false;
        } else {
          this.isLinking = false;
        }
        this.emit('linkState');

        const hadAuth = this.hasSavedAuth();
        const authSnapshot = this.getAuthStatus();
        const errMsg = lastDisconnect?.error?.message || '';
        const transientHandshake = isTransientHandshakeMessage(errMsg);
        const incompleteLink = !authSnapshot.registered
          && (this.isLinking || pairingActive || hadAuth);
        const policyAlert = classifyDisconnect(lastDisconnect);
        const suppressPolicyAlert =
          (pairingActive && this.isTransientPairingDisconnect(lastDisconnect))
          || (incompleteLink && transientHandshake)
          || (transientHandshake && ((hadAuth && authSnapshot.valid) || this.pairingPhone));
        if (policyAlert && !suppressPolicyAlert) {
          this.emitPolicyAlert(policyAlert);
        } else if (suppressPolicyAlert) {
          console.log(
            `[${this.sessionName}] Link handshake retry (${errMsg || reasonText}) — session kept`
          );
        }

        const authValid = authSnapshot.valid;
        const isForbidden = statusCode === DisconnectReason.forbidden;
        const pairingInProgress =
          this.loginMethod === 'pairing'
          && (this.pairingAwaitingUser || this.pairingCodeDisplay)
          && !authSnapshot.registered;

        // After user enters pairing code on phone, WA sends 515 — must reconnect immediately.
        if (isRestartRequired) {
          this.isLinking = true;
          this.isLoggedOut = false;
          this.pairingAwaitingUser = false;
          this.pairingCodeDisplay = null;
          this.pairingCodeRequested = false;
          this.pairingReconnectAttempts = 0;
          this.reconnectAttempts = 0;
          console.log(`[${this.sessionName}] Pairing code accepted — finishing link (reconnect)...`);
          this.emit('linkState');
          this.scheduleReconnect(
            () => this.connect(
              this.pendingLoginPlan || { method: 'pairing', phoneNumber: this.pairingPhone }
            ),
            400
          );
          return;
        }

        if (pairingInProgress && !isForbidden) {
          if (isReplaced) {
            this.isLinking = true;
            this.isLoggedOut = false;
            console.log(
              `[${this.sessionName}] Pairing paused — another client took the session. Close it, then enter the code on your phone.`
            );
            this.emit('linkState');
            if (this.pairingCodeDisplay) {
              this.emit('pairingCode', { code: this.pairingCodeDisplay, phone: this.pairingPhone });
            }
            return;
          }
          if (isLoggedOut || isBadSession) {
            this.isLinking = true;
            this.isLoggedOut = false;
            this.emit('linkState');
            if (this.pairingReconnectAttempts < 3) {
              this.pairingReconnectAttempts += 1;
              const delay = Math.min(6000 * this.pairingReconnectAttempts, 18000);
              console.log(
                `[${this.sessionName}] Pairing in progress — waiting for code on phone (retry ${this.pairingReconnectAttempts}/3 in ${delay / 1000}s)`
              );
              this.scheduleReconnect(
                () => this.connect(
                  this.pendingLoginPlan || { method: 'pairing', phoneNumber: this.pairingPhone }
                ),
                delay
              );
            } else if (this.pairingCodeDisplay) {
              this.emit('pairingCode', { code: this.pairingCodeDisplay, phone: this.pairingPhone });
            }
            return;
          }
          // Do not reconnect while the user types the code — reconnect invalidates the active code.
          this.isLinking = true;
          this.isLoggedOut = false;
          this.emit('linkState');
          if (this.pairingCodeDisplay) {
            this.emit('pairingCode', { code: this.pairingCodeDisplay, phone: this.pairingPhone });
          }
          return;
        }

        if (pairingActive && !isForbidden && !isRestartRequired) {
          if (isReplaced) {
            this.isLinking = true;
            this.isLoggedOut = false;
            console.log(
              `[${this.sessionName}] Pairing paused — another client took the session. Close it, then enter the code on your phone.`
            );
            this.emit('linkState');
            return;
          }

          if (this.isTransientPairingDisconnect(lastDisconnect) || isLoggedOut || isBadSession) {
            this.isLinking = true;
            this.isLoggedOut = false;
            this.emit('linkState');
            const maxPreCodeRetries = 2;
            if (this.pairingReconnectAttempts < maxPreCodeRetries) {
              this.pairingReconnectAttempts += 1;
              const delay = 8000 + this.pairingReconnectAttempts * 4000;
              this.pairingCodeRequested = false;
              console.log(
                `[${this.sessionName}] Requesting pairing code (attempt ${this.pairingReconnectAttempts}/${maxPreCodeRetries} in ${delay / 1000}s)...`
              );
              this.scheduleReconnect(
                () => this.connect(
                  this.pendingLoginPlan || { method: 'pairing', phoneNumber: this.pairingPhone }
                ),
                delay
              );
            } else {
              console.log(
                `[${this.sessionName}] Pairing code request stalled — cancel link and retry, or use QR login.`
              );
              this.emit('linkAttemptFailed');
            }
            return;
          }

          this.isLinking = true;
          this.isLoggedOut = false;
          this.emit('linkState');
          return;
        }

        if (isReplaced) {
          this.isLoggedOut = true;
          console.log(
            `[${this.sessionName}] Session opened elsewhere (440). Auth kept — close other clients, then reconnect.`
          );
          this.reconnectAttempts = 0;
          this.emit('loggedOut');
        } else if (isLoggedOut || isForbidden) {
          const transient401 =
            isLoggedOut
            && isTransientHandshakeMessage(errMsg);
          if (transient401 && ((hadAuth && authValid) || this.pairingPhone || incompleteLink)) {
            console.log(
              `[${this.sessionName}] Handshake retry ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts} (${errMsg || 'connection drop'})`
            );
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
              this.reconnectAttempts++;
              const delay = Math.min(3000 * this.reconnectAttempts, 15000);
              this.scheduleReconnectWithLoginPlan(delay);
            }
            return;
          }
          this.isLoggedOut = true;
          if (isLoggedOut) {
            console.log(`[${this.sessionName}] Logged out (401). Auth cleared.`);
            console.log(`[${this.sessionName}] Check phone: if you see a strict scan / temporary limit notice → wait ~6h before re-linking.`);
          } else {
            console.log(`[${this.sessionName}] Forbidden (403). Auth cleared.`);
          }
          this.purgeLocalSession();
          this.reconnectAttempts = 0;
          this.qrCount = 0;
          this.proxyFallbackAttempts = 0;
          this.emit('strictLogout', {
            alert:
              policyAlert
              || {
                type: isForbidden ? 'BAN_OR_FORBIDDEN' : 'LOGGED_OUT_OR_RESTRICTED',
                severity: 'critical',
                title: isForbidden
                  ? 'Account forbidden (403) — session removed'
                  : 'Logged out (401) — session removed',
                detail: errMsg || 'WhatsApp ended this session.',
                strictScanPossible: true,
                action:
                  'Open WhatsApp on your phone. If you see a strict scan or temporary limit, wait ~6 hours. Then use Settings → Session → Clear all sessions before re-linking.',
              },
          });
          this.emit('loggedOut');
        } else if (isBadSession && !hadAuth) {
            if (this.linkControlMode) {
              this.emit('linkAttemptFailed');
              return;
            }
            // New session (QR not scanned yet) — WA rejected connection before QR appeared.
            this.reconnectAttempts++;
            const maxQrWithProxy = 2;
            if (
              this.proxyUrl &&
              !this.proxyLinkFallbackDone &&
              this.reconnectAttempts >= maxQrWithProxy
            ) {
              this.reconnectAttempts = 0;
              this.emit('proxyLinkFailed', this.pendingLoginPlan || { method: this.loginMethod });
              return;
            }
            const maxNewSessionRetries = 5;
            if (this.reconnectAttempts > maxNewSessionRetries) {
              console.log(
                `[${this.sessionName}] Initial connection failed ${this.reconnectAttempts}x in a row.`
              );
              console.log(
                `[${this.sessionName}] ⚠ Proxy cannot reach WA. Check proxies.txt and restart.`
              );
              this.reconnectAttempts = 0;
              this.emit('loggedOut');
              return;
            }
            const delay = Math.min(5000 * this.reconnectAttempts, 30000);
            console.log(
              `[${this.sessionName}] Initial connection failed (bad session / proxy). Retrying in ${delay / 1000}s... (${this.reconnectAttempts}/${maxNewSessionRetries})`
            );
            if (this.reconnectAttempts === 1 && this.proxyUrl) {
              console.log(
                `[${this.sessionName}] Tip: If linking keeps failing, proxy IP may be blocked — will try direct connection automatically.`
              );
            }
            if (
              this.proxyUrl &&
              !this.proxyLinkFallbackDone &&
              this.loginMethod === 'pairing' &&
              this.reconnectAttempts >= 2
            ) {
              this.reconnectAttempts = 0;
              this.emit('proxyLinkFailed', this.pendingLoginPlan || { method: 'pairing', phoneNumber: this.pairingPhone });
              return;
            }
            this.scheduleReconnectWithLoginPlan(delay);
        } else if (isBadSession && hadAuth && authValid) {
          // Saved session — bad session is usually proxy/IP change; keep auth folder
          if (this.proxyUrl) {
            const failedProxy = this.proxyUrl;
            this.linkedViaDirect = true;
            this.proxyUrl = null;
            this.reconnectAttempts = 0;
            console.log(
              `[${this.sessionName}] Bad session via proxy ${ProxyManager.maskProxyUrl(failedProxy)} — retrying on direct (auth kept)`
            );
            console.log(
              `[${this.sessionName}] Tip: avoid switching proxy IP after link; use stable proxy per account slot`
            );
            this.scheduleReconnectWithLoginPlan(3000);
          } else if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(3000 * this.reconnectAttempts, 15000);
            console.log(
              `[${this.sessionName}] Bad session — retrying direct in ${delay / 1000}s (${this.reconnectAttempts}/${this.maxReconnectAttempts}, auth kept)`
            );
            this.scheduleReconnectWithLoginPlan(delay);
          } else {
            console.log(`[${this.sessionName}] Bad session persists — auth kept; restart app or check proxy in proxies.txt`);
          }
        } else if (isBadSession && hadAuth && !authValid) {
          console.log(`[${this.sessionName}] Invalid saved session — auth cleared`);
          this.purgeLocalSession();
          this.reconnectAttempts = 0;
          this.emit('loggedOut');
        } else if (this.isPairingLinkActive()) {
          this.isLinking = true;
          this.isLoggedOut = false;
          this.emit('linkState');
          if (this.pairingAwaitingUser || this.pairingCodeDisplay) {
            if (this.pairingCodeDisplay) {
              this.emit('pairingCode', { code: this.pairingCodeDisplay, phone: this.pairingPhone });
            }
            return;
          }
          if (this.pairingReconnectAttempts < 3) {
            this.pairingReconnectAttempts += 1;
            const delay = Math.min(6000 * this.pairingReconnectAttempts, 18000);
            console.log(
              `[${this.sessionName}] Pairing handshake lost — retry ${this.pairingReconnectAttempts}/3 in ${delay / 1000}s`
            );
            this.pairingCodeRequested = false;
            this.scheduleReconnectWithLoginPlan(delay);
          }
        } else if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(3000 * this.reconnectAttempts, 15000);
          console.log(`[${this.sessionName}] Connection lost. Reconnecting in ${delay / 1000}s... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
          this.scheduleReconnectWithLoginPlan(delay);
        } else {
          console.log(`[${this.sessionName}] Max reconnect attempts (${this.maxReconnectAttempts}) reached. Resetting and retrying...`);
          this.reconnectAttempts = 0;
          this.scheduleReconnectWithLoginPlan(30000);
        }
      }
    });

    this.socket.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.message) continue;

        const myJid = this.socket?.user?.id
          ? jidNormalizedUser(this.socket.user.id)
          : null;

        const text = msg.message.conversation
          || msg.message.extendedTextMessage?.text
          || msg.message.imageMessage?.caption
          || msg.message.buttonsResponseMessage?.selectedDisplayText
          || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId
          || '';

        if (!text) continue;

        const remoteJid = jidNormalizedUser(msg.key.remoteJid);
        const sender = jidNormalizedUser(
          msg.key.participant || msg.key.remoteJid
        );

        if (myJid && (this.isSameUser(sender, myJid) || this.isSameUser(remoteJid, myJid))) {
          continue;
        }

        const senderPn = msg.key?.senderPn || msg.key?.participantPn || null;
        if (
          this.expectedPartnerJid
          && !this.isPartnerMessage(sender, remoteJid, this.expectedPartnerJid, { senderPn })
        ) {
          continue;
        }

        this.emit('message', {
          sender,
          remoteJid,
          text,
          message: msg,
          senderPn,
        });
      }
    });

    const connectPromise = new Promise((resolve) => {
      this.once('connected', resolve);
    });

    if (this.pairingCodeDisplay && this.loginMethod === 'pairing') {
      this.emit('pairingCode', { code: this.pairingCodeDisplay, phone: this.pairingPhone });
    }

    return connectPromise;
  }

  /**
   * One link attempt (used when rotating proxies). Returns:
   * connected | qr_waiting | failed | timeout
   */
  async connectUntilReady(loginOptions = {}, timeoutMs = 22000) {
    this.linkControlMode = true;
    this.proxyLinkFallbackDone = false;
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();

    const result = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.removeListener('connected', onConnected);
        this.removeListener('qr', onQr);
        this.removeListener('linkAttemptFailed', onFail);
        resolve(value);
      };

      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      const onConnected = () => finish('connected');
      const onQr = () => finish('qr_waiting');
      const onFail = () => finish('failed');

      this.once('connected', onConnected);
      this.once('qr', onQr);
      this.once('linkAttemptFailed', onFail);

      this.connect(loginOptions).catch(() => finish('failed'));
    });

    this.linkControlMode = false;
    return result;
  }

  async waitUntilConnected(timeoutMs = 600000) {
    if (this.isConnected) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.once('connected', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  async waitForConnection(timeoutMs = 10000) {
    if (this.isConnected) return true;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), timeoutMs);
      const check = () => {
        if (this.isConnected) {
          clearTimeout(timeout);
          resolve(true);
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });
  }

  isSameUser(jid1, jid2) {
    if (!jid1 || !jid2) return false;
    try {
      return areJidsSameUser(jid1, jid2);
    } catch {
      return jidNormalizedUser(jid1) === jidNormalizedUser(jid2);
    }
  }

  static phoneFromJid(jid) {
    if (!jid) return '';
    return String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
  }

  /** Match partner DM by phone JID, LID, or sender_pn (WhatsApp multi-device). */
  isPartnerMessage(sender, remoteJid, partnerJid, meta = {}) {
    const partner = partnerJid || this.expectedPartnerJid;
    if (!partner) return false;

    if (isJidGroup(remoteJid) || isJidGroup(sender)) return false;

    if (this.isSameUser(sender, partner)) return true;
    if (remoteJid && this.isSameUser(remoteJid, partner)) return true;

    const partnerPhone = WhatsAppSession.phoneFromJid(partner);
    if (partnerPhone.length >= 8) {
      const senderPhone = WhatsAppSession.phoneFromJid(sender);
      const remotePhone = WhatsAppSession.phoneFromJid(remoteJid);
      if (senderPhone === partnerPhone || remotePhone === partnerPhone) return true;
    }

    if (this.partnerLidJid) {
      if (this.isSameUser(sender, this.partnerLidJid)) return true;
      if (remoteJid && this.isSameUser(remoteJid, this.partnerLidJid)) return true;
    }

    const senderPn = meta.senderPn ? jidNormalizedUser(meta.senderPn) : '';
    if (senderPn && this.isSameUser(senderPn, partner)) {
      const lid = isLidUser(sender) ? sender : remoteJid;
      if (isLidUser(lid)) this.learnPartnerLid(lid, 'sender_pn');
      return true;
    }

    // Unknown LID/PN without verified sender_pn — ignore (may be another contact on linked phone).
    return false;
  }

  canSendToJid(jid) {
    if (!this.expectedPartnerJid) return true;
    const target = jidNormalizedUser(jid);
    return this.isSameUser(target, this.expectedPartnerJid);
  }

  async sendMessage(jid, text) {
    if (!this.isConnected) {
      const connected = await this.waitForConnection(15000);
      if (!connected) {
        console.log(`[${this.sessionName}] Connection timeout, message skipped.`);
        return false;
      }
    }

    try {
      let target = jidNormalizedUser(jid);
      if (!this.canSendToJid(target)) {
        console.log(
          `[${this.sessionName}] Send blocked — not feeding partner (target=${target}, partner=${this.expectedPartnerJid})`
        );
        return false;
      }
      if (
        this.partnerLidJid &&
        this.expectedPartnerJid &&
        this.isSameUser(target, this.expectedPartnerJid)
      ) {
        target = this.partnerLidJid;
      }
      await this.socket.sendMessage(target, { text });
      return true;
    } catch (error) {
      const policyAlert = classifySendError(error);
      if (policyAlert) {
        this.emitPolicyAlert(policyAlert);
        if (policyAlert.strictScanPossible && policyAlert.severity === 'critical') {
          this.isLoggedOut = true;
          this.autoReconnectAllowed = false;
          this.clearReconnectTimer();
          await this.disconnect();
          this.purgeLocalSession();
          this.emit('strictLogout', { alert: policyAlert });
          this.emit('loggedOut');
        }
      } else {
        console.error(`[${this.sessionName}] Failed to send: ${error.message}`);
      }
      return false;
    }
  }

  formatJid(phoneNumber) {
    const cleaned = phoneNumber.replace(/[^0-9]/g, '');
    return `${cleaned}@s.whatsapp.net`;
  }

  getMyJid() {
    if (!this.socket?.user) return null;
    return jidNormalizedUser(this.socket.user.id);
  }

  getPhone() {
    const jid = this.getMyJid();
    if (!jid) return null;
    return jid.split('@')[0].split(':')[0];
  }
}

module.exports = WhatsAppSession;
