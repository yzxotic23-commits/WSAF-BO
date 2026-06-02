const fs = require('fs');
const path = require('path');
const { probeProxy } = require('./proxy-probe');

const WORKING_PROXY_STORE = path.join(process.cwd(), 'auth', '_proxy-working.json');

class ProxyManager {
  constructor(filePath) {
    this.filePath = filePath || path.join(process.cwd(), 'proxies.txt');
    this.proxies = [];
    this.usedIndices = [];
    this.currentProxy = null;
  }

  isValidProxyUrl(line) {
    if (!line || line.includes('...')) return false;
    try {
      const url = new URL(line);
      const hasHost = url.hostname && url.hostname.length > 3;
      const hasPort = Boolean(url.port);
      return (url.protocol === 'socks5:' || url.protocol === 'socks4:') && hasHost && hasPort;
    } catch {
      return false;
    }
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      console.log('[PROXY] No proxies.txt found, using direct connection.');
      return false;
    }

    const content = fs.readFileSync(this.filePath, 'utf8');
    const lines = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));

    this.proxies = [];
    for (const line of lines) {
      if (this.isValidProxyUrl(line)) {
        this.proxies.push(line);
      } else {
        console.log(`[PROXY] Skipped invalid line: ${line}`);
      }
    }

    if (this.proxies.length === 0) {
      console.log('[PROXY] proxies.txt is empty, using direct connection.');
      return false;
    }

    console.log(`[PROXY] Loaded ${this.proxies.length} proxies.`);
    return true;
  }

  getNext() {
    if (this.proxies.length === 0) return null;

    // Reset if all proxies have been used
    if (this.usedIndices.length >= this.proxies.length) {
      this.usedIndices = [];
    }

    // Pick random unused proxy
    let index;
    do {
      index = Math.floor(Math.random() * this.proxies.length);
    } while (this.usedIndices.includes(index));

    this.usedIndices.push(index);
    this.currentProxy = this.proxies[index];

    console.log(`[PROXY] Using: ${this.maskUrl(this.currentProxy)}`);
    return this.currentProxy;
  }

  getCurrent() {
    return this.currentProxy;
  }

  getProxyAt(index) {
    if (this.proxies.length === 0) return null;
    return this.proxies[index % this.proxies.length];
  }

  pickRandom() {
    if (this.proxies.length === 0) return null;
    const index = Math.floor(Math.random() * this.proxies.length);
    return this.proxies[index];
  }

  /**
   * Smart assign: 1 proxy per pair while slots are available.
   * If pairs > proxies, overflow pairs get a random proxy from the list.
   */
  assignForPairs(pairCount) {
    const assignments = [];
    const capacity = this.proxies.length;

    for (let p = 0; p < pairCount; p++) {
      if (p < capacity) {
        assignments.push({
          proxy: this.proxies[p],
          mode: 'dedicated',
        });
      } else {
        assignments.push({
          proxy: this.pickRandom(),
          mode: 'random',
        });
      }
    }

    return assignments;
  }

  /** One proxy per account slot (account1→proxy[0], account2→proxy[1], …). */
  assignForAccounts(accountCount) {
    const list = [];
    const n = this.proxies.length;
    for (let i = 0; i < accountCount; i++) {
      list.push(n > 0 ? this.proxies[i % n] : null);
    }
    return list;
  }

  hasProxies() {
    return this.proxies.length > 0;
  }

  maskUrl(proxyUrl) {
    try {
      const url = new URL(proxyUrl);
      const host = url.hostname;
      const parts = host.split('.');
      if (parts.length === 4) {
        return `${url.protocol}//${parts[0]}.xxx.xxx.${parts[3]}:${url.port}`;
      }
      return `${url.protocol}//${host.substring(0, 4)}***:${url.port}`;
    } catch {
      return '***masked***';
    }
  }

  loadWorkingStore() {
    try {
      if (!fs.existsSync(WORKING_PROXY_STORE)) return {};
      return JSON.parse(fs.readFileSync(WORKING_PROXY_STORE, 'utf8'));
    } catch {
      return {};
    }
  }

  saveWorkingStore(store) {
    try {
      fs.mkdirSync(path.dirname(WORKING_PROXY_STORE), { recursive: true });
      fs.writeFileSync(WORKING_PROXY_STORE, JSON.stringify(store, null, 2));
    } catch {
      // ignore
    }
  }

  /**
   * Try proxies one-by-one (rotate) until one reaches WA. Prefer different IP per slot.
   * @param {number} accountCount
   * @param {(name: string) => string} getAccountName
   */
  async assignWorkingForAccounts(accountCount, getAccountName) {
    const assigned = [];
    const usedUrls = new Set();
    const store = this.loadWorkingStore();
    const updatedStore = { ...store };

    console.log('[PROXY] Probing proxies (TCP to WA — routing check only)');
    console.log('[PROXY] Note: probe OK does not guarantee QR link; app will rotate proxies until QR works.');
    console.log('');

    for (let i = 0; i < accountCount; i++) {
      const accountName = getAccountName ? getAccountName(i) : `account${i + 1}`;
      let found = null;

      const candidates = [];
      const saved = store[accountName];
      if (saved && this.proxies.includes(saved)) {
        candidates.push(saved);
      }
      const startIdx = i % this.proxies.length;
      for (let attempt = 0; attempt < this.proxies.length; attempt++) {
        const url = this.proxies[(startIdx + attempt) % this.proxies.length];
        if (!candidates.includes(url)) candidates.push(url);
      }

      for (const url of candidates) {
        if (usedUrls.has(url) && accountCount > 1) continue;

        const label = this.maskUrl(url);
        process.stdout.write(`[PROXY] ${accountName}: testing ${label} ... `);
        const ok = await probeProxy(url);
        if (ok) {
          console.log('OK');
          found = url;
          usedUrls.add(url);
          updatedStore[accountName] = url;
          break;
        }
        console.log('fail');
      }

      if (!found && accountCount > 1) {
        for (const url of this.proxies) {
          if (usedUrls.has(url)) continue;
          const label = this.maskUrl(url);
          process.stdout.write(`[PROXY] ${accountName}: retry ${label} ... `);
          const ok = await probeProxy(url);
          if (ok) {
            console.log('OK');
            found = url;
            usedUrls.add(url);
            updatedStore[accountName] = url;
            break;
          }
          console.log('fail');
        }
      }

      if (!found) {
        console.log(`[PROXY] ${accountName}: no working proxy — will use direct connection`);
      }

      assigned.push(found);
    }

    this.saveWorkingStore(updatedStore);
    console.log('');
    return assigned;
  }
}

module.exports = ProxyManager;
