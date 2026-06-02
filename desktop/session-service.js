const QRCode = require('qrcode');
const WhatsAppSession = require('../src/whatsapp-session');
const ProxyManager = require('../src/proxy-manager');

class SessionService {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.sessions = new Map();
    this.proxyManager = new ProxyManager();
    this.proxyManager.load();
  }

  log(type, message, extra = {}) {
    this.onEvent({ type, message, ...extra });
  }

  getSession(name) {
    if (!this.sessions.has(name)) {
      const session = new WhatsAppSession(name);
      this.wireSession(session);
      this.sessions.set(name, session);
    }
    return this.sessions.get(name);
  }

  wireSession(session) {
    session.on('qr', async (qrText) => {
      let qrImage = null;
      try {
        qrImage = await QRCode.toDataURL(qrText || '', { margin: 1, width: 280 });
      } catch {
        // ignore QR render errors
      }
      this.log('qr', `QR ready for ${session.sessionName}`, {
        session: session.sessionName,
        qrImage,
      });
    });

    session.on('connected', (user) => {
      const phone = user?.id?.split(':')[0] || '?';
      this.log('connected', `${session.sessionName} connected as ${user?.name || phone}`, {
        session: session.sessionName,
        phone,
      });
    });

    session.on('loggedOut', () => {
      this.log('warn', `${session.sessionName} logged out`, { session: session.sessionName });
    });

    session.on('policyAlert', (alert) => {
      this.log('warn', `${session.sessionName}: ${alert?.title || 'policy'}`, {
        session: session.sessionName,
      });
    });
  }

  listAccounts(pairCount = 1, accountStart = 1) {
    const count = pairCount * 2;
    const list = [];
    for (let i = 0; i < count; i++) {
      const name = `account${accountStart + i}`;
      const session = this.getSession(name);
      const auth = session.getAuthStatus();
      list.push({
        name,
        saved: auth.saved,
        valid: auth.valid,
        phone: auth.phone,
        connected: session.isConnected,
      });
    }
    return list;
  }

  async connectAccount(name, options = {}) {
    const session = this.getSession(name);
    const method = options.method === 'pairing' ? 'pairing' : 'qr';
    const loginOptions = { method, phoneNumber: options.phoneNumber || null };

    if (options.proxyUrl) {
      session.setProxy(options.proxyUrl);
    }

    this.log('info', `Connecting ${name} (${method})...`, { session: name });
    await session.connect(loginOptions);

    if (method === 'pairing' && options.phoneNumber && session.socket) {
      try {
        const code = await session.requestPairingLogin(options.phoneNumber);
        this.log('pairing', `Pairing code for ${name}: ${code}`, { session: name, code });
      } catch (err) {
        this.log('error', err.message, { session: name });
      }
    }

    return session.getAuthStatus();
  }

  async disconnectAccount(name) {
    const session = this.getSession(name);
    await session.shutdown();
    this.log('info', `${name} disconnected`, { session: name });
  }

  async logoutAccount(name) {
    const session = this.getSession(name);
    await session.logoutAndClear();
    this.sessions.delete(name);
    this.log('info', `${name} logged out and auth cleared`, { session: name });
  }
}

module.exports = SessionService;
