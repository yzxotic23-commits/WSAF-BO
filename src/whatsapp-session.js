const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  areJidsSameUser,
  jidNormalizedUser,
  isLidUser,
  isJidGroup,
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
} = require('./wa-policy-detector');

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
    const name = (me.notify || me.name || me.verifiedName || '').trim();
    return name || null;
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
    const credsPath = path.join(this.authDir, 'creds.json');
    if (!fs.existsSync(credsPath)) return this.loadProfileName();
    try {
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      const fromCreds = this.extractProfileNameFromMe(creds?.me);
      if (fromCreds) {
        const previous = this.loadProfileName();
        if (previous !== fromCreds) this.saveProfileName(fromCreds);
        return fromCreds;
      }
    } catch {
      /* ignore */
    }
    return this.loadProfileName();
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
    return this.loadProfileName();
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

  learnPartnerLid(lidJid, source = '') {
    const lid = lidJid ? jidNormalizedUser(lidJid) : '';
    if (!lid || !isLidUser(lid)) return;
    if (this.partnerLidJid === lid) return;

    this.partnerLidJid = lid;
    const tag = source ? ` (${source})` : '';
    console.log(
      `[${this.sessionName}] Partner LID mapped: ${lid} ↔ ${this.expectedPartnerJid || '?'}${tag}`
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

  setProxy(proxyUrl) {
    this.proxyUrl = proxyUrl;
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
      return { saved: false, valid: false, registered: false, phone: null, lid: null, profileName: null };
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
      const profileName = fromFile || fromCreds;
      if (fromCreds && !fromFile) {
        try {
          this.saveProfileName(fromCreds);
        } catch {
          /* ignore */
        }
      }
      return { saved: true, valid, registered, phone, lid, profileName };
    } catch {
      return { saved: true, valid: false, registered: false, phone: null, lid: null, profileName: null };
    }
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

    const socketOptions = {
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['Chrome', 'Windows', '10.0'],
      connectTimeoutMs: 60000,
    };
    if (agent) {
      socketOptions.agent = agent;
      socketOptions.fetchAgent = agent;
    }

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

  async requestPairingLogin(phoneNumber) {
    const cleaned = String(phoneNumber || '').replace(/\D/g, '');
    if (cleaned.length < 8 || cleaned.length > 15) {
      throw new Error('Invalid phone — use country code + number, digits only (e.g. 628123456789)');
    }

    await new Promise((r) => setTimeout(r, 3000));
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

    this.emit('pairingCode', { code: display, phone: cleaned });
    return display;
  }

  /**
   * @param {{ method?: 'qr'|'pairing', phoneNumber?: string }} loginOptions
   */
  async connect(loginOptions = {}) {
    if (this.isShuttingDown || !this.autoReconnectAllowed) return;

    this.isLinking = true;
    this.emit('linkState');

    if (this.socket) {
      this.socket.ev.removeAllListeners();
      try { this.socket.end(); } catch (_) {}
      this.socket = null;
    }

    const hasAuth = this.hasSavedAuth();
    if (hasAuth) {
      this.loginMethod = 'qr';
    } else {
      this.loginMethod = loginOptions.method === 'pairing' ? 'pairing' : 'qr';
      this.pairingPhone = loginOptions.phoneNumber || null;
      this.pendingLoginPlan = {
        method: this.loginMethod,
        phoneNumber: this.pairingPhone,
      };
    }
    this.pairingCodeRequested = false;

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    if (hasAuth) {
      console.log(`[${this.sessionName}] Saved session found — connecting...`);
    } else if (this.loginMethod === 'pairing') {
      console.log(`[${this.sessionName}] No session — login via pairing code (${this.pairingPhone})`);
    } else {
      console.log(`[${this.sessionName}] No session — scan QR to link`);
    }

    const logger = pino({ level: 'silent' });
    const agent = this.createProxyAgent(this.proxyUrl);

    this.qrCount = 0;

    const socketOptions = {
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['Chrome', 'Windows', '10.0'],
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      retryRequestDelayMs: 2000,
    };

    if (agent) {
      socketOptions.agent = agent;
      socketOptions.fetchAgent = agent;
    }

    this.socket = makeWASocket(socketOptions);

    this.socket.ev.on('creds.update', async (update) => {
      await saveCreds(update);
      if (!this.isShuttingDown) {
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
      }

      if (connection === 'open') {
        this.isLinking = false;
        this.isConnected = true;
        this.isLoggedOut = false;
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
        this.emit('connected', { user, profileName: profileName || null, phone });
        this.scheduleProfileNameCapture();
      }

      if (connection === 'close') {
        this.isConnected = false;
        this.isLinking = false;
        this.emit('linkState');
        if (this.isLoggingOut) return;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isReplaced = statusCode === DisconnectReason.connectionReplaced;
        const isBadSession = statusCode === DisconnectReason.badSession;

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

        const policyAlert = classifyDisconnect(lastDisconnect);
        if (policyAlert) {
          this.emitPolicyAlert(policyAlert);
        }

        const hadAuth = this.hasSavedAuth();
        const authValid = this.getAuthStatus().valid;
        const isForbidden = statusCode === DisconnectReason.forbidden;

        if (isReplaced) {
          this.isLoggedOut = true;
          console.log(
            `[${this.sessionName}] Session opened elsewhere (440). Auth kept — close other clients, then reconnect.`
          );
          this.reconnectAttempts = 0;
          this.emit('loggedOut');
        } else if (isLoggedOut || isForbidden) {
          const errMsg = lastDisconnect?.error?.message || '';
          const transient401 =
            isLoggedOut
            && /connection\s*failure|connection\s*closed|connection\s*lost|timed\s*out|econnreset|network|stream\s*errored/i.test(
              errMsg
            );
          if (transient401 && hadAuth && authValid) {
            console.log(
              `[${this.sessionName}] Temporary disconnect (401: ${errMsg || 'unknown'}) — auth kept, will retry`
            );
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
              this.reconnectAttempts++;
              const delay = Math.min(3000 * this.reconnectAttempts, 15000);
              this.scheduleReconnect(() => this.connect(), delay);
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
            this.scheduleReconnect(() => this.connect(), delay);
        } else if (isBadSession && hadAuth && authValid) {
          // Saved session — bad session is usually proxy/IP change; keep auth folder
          if (this.proxyUrl) {
            this.linkedViaDirect = true;
            this.proxyUrl = null;
            this.reconnectAttempts = 0;
            console.log(`[${this.sessionName}] Bad session via proxy — retrying on direct (auth kept)`);
            this.scheduleReconnect(() => this.connect(), 3000);
          } else if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(3000 * this.reconnectAttempts, 15000);
            console.log(
              `[${this.sessionName}] Bad session — retrying direct in ${delay / 1000}s (${this.reconnectAttempts}/${this.maxReconnectAttempts}, auth kept)`
            );
            this.scheduleReconnect(() => this.connect(), delay);
          } else {
            console.log(`[${this.sessionName}] Bad session persists — auth kept; restart app or check proxy in proxies.txt`);
          }
        } else if (isBadSession && hadAuth && !authValid) {
          console.log(`[${this.sessionName}] Invalid saved session — auth cleared`);
          this.purgeLocalSession();
          this.reconnectAttempts = 0;
          this.emit('loggedOut');
        } else if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(3000 * this.reconnectAttempts, 15000);
          console.log(`[${this.sessionName}] Connection lost. Reconnecting in ${delay / 1000}s... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
          this.scheduleReconnect(() => this.connect(), delay);
        } else {
          console.log(`[${this.sessionName}] Max reconnect attempts (${this.maxReconnectAttempts}) reached. Resetting and retrying...`);
          this.reconnectAttempts = 0;
          this.scheduleReconnect(() => this.connect(), 30000);
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

        this.emit('message', {
          sender,
          remoteJid,
          text,
          message: msg,
          senderPn: msg.key?.senderPn || msg.key?.participantPn,
        });
      }
    });

    const connectPromise = new Promise((resolve) => {
      this.once('connected', resolve);
    });

    if (!state.creds.registered && this.loginMethod === 'pairing' && this.pairingPhone) {
      this.pairingCodeRequested = true;
      this.requestPairingLogin(this.pairingPhone).catch((err) => {
        console.log(`[${this.sessionName}] Pairing code error: ${err.message}`);
        this.pairingCodeRequested = false;
      });
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
      this.learnPartnerLid(lid, 'sender_pn');
      return true;
    }

    const chatJid = remoteJid || sender;
    if (
      partner &&
      !isJidGroup(chatJid) &&
      (isLidUser(sender) || isLidUser(remoteJid))
    ) {
      const lid = isLidUser(sender) ? sender : remoteJid;
      this.learnPartnerLid(lid, 'inbound_lid');
      return true;
    }

    return false;
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
