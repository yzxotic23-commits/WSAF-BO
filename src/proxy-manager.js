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
      this.proxies = [];
      this.rawContent = '';
      return false;
    }
    this.rawContent = fs.readFileSync(this.filePath, 'utf8');
    this.proxies = this.parseContent(this.rawContent);
    if (this.proxies.length === 0) {
      console.log('[PROXY] proxies.txt is empty, using direct connection.');
      return false;
    }
    console.log(`[PROXY] Loaded ${this.proxies.length} proxies.`);
    return true;
  }

  /** Line N in proxies.txt → account slot N (empty line = direct). */
  parseLinesBySlot(content, accountCount) {
    const rawLines = String(content || '').split(/\r?\n/);
    const slots = [];
    for (let i = 0; i < accountCount; i++) {
      const line = (rawLines[i] || '').trim();
      if (!line || line.startsWith('#')) {
        slots.push(null);
      } else if (this.isValidProxyUrl(line)) {
        slots.push(line);
      } else {
        slots.push(null);
      }
    }
    return slots;
  }

  getProxiesBySlot(accountCount) {
    const content = this.rawContent != null
      ? this.rawContent
      : (fs.existsSync(this.filePath) ? fs.readFileSync(this.filePath, 'utf8') : '');
    return this.parseLinesBySlot(content, accountCount);
  }

  parseContent(content) {
    const lines = String(content || '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));

    const proxies = [];
    for (const line of lines) {
      if (this.isValidProxyUrl(line)) {
        proxies.push(line);
      } else {
        console.log(`[PROXY] Skipped invalid line: ${line}`);
      }
    }
    return proxies;
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

  /** One proxy per account slot — line 1 → slot 0, line 2 → slot 1, … (duplicates OK). */
  assignForAccounts(accountCount) {
    return this.getProxiesBySlot(accountCount);
  }

  hasProxies() {
    return this.proxies.length > 0;
  }

  /** Host:port key for duplicate detection (same IP = duplicate for feeding). */
  static proxyHostKey(proxyUrl) {
    if (!proxyUrl) return null;
    try {
      const url = new URL(proxyUrl);
      if (!url.hostname) return null;
      const port = url.port || (url.protocol === 'socks5:' ? '1080' : '1080');
      return `${url.hostname}:${port}`;
    } catch {
      return null;
    }
  }

  /**
   * Find proxy hosts shared across multiple lines (same device / Shadowrocket).
   * @param {string|string[]|null} contentOrList
   */
  findSharedProxyHosts(contentOrList, accountCount = null) {
    const proxies = Array.isArray(contentOrList)
      ? contentOrList
      : (accountCount != null
        ? this.parseLinesBySlot(contentOrList, accountCount)
        : this.parseContent(contentOrList));

    const byHost = new Map();
    for (let i = 0; i < proxies.length; i++) {
      const url = proxies[i];
      if (!url) continue;
      const host = ProxyManager.proxyHostKey(url);
      if (!host) continue;
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host).push({
        line: i + 1,
        slot: i,
        host,
        masked: this.maskUrl(url),
      });
    }

    const shared = [];
    for (const [host, entries] of byHost) {
      if (entries.length > 1) {
        shared.push({
          host,
          lines: entries.map((e) => e.line),
          slots: entries.map((e) => e.slot),
          masked: entries[0].masked,
        });
      }
    }

    return {
      shared,
      duplicates: shared,
      uniqueHosts: byHost.size,
      totalLines: proxies.length,
      accountCount: proxies.length,
    };
  }

  findDuplicateHosts(contentOrList, accountCount = null) {
    return this.findSharedProxyHosts(contentOrList, accountCount);
  }

  maskUrl(proxyUrl) {
    return ProxyManager.maskProxyUrl(proxyUrl);
  }

  /** Mask credentials/host for logs and UI (static — safe without ProxyManager instance). */
  static maskProxyUrl(proxyUrl) {
    if (!proxyUrl) return 'direct';
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

  /** Human-readable route label for connection logs. */
  static describeRoute(proxyUrl) {
    if (!proxyUrl) return 'direct (local IP — no proxy)';
    return `via proxy ${ProxyManager.maskProxyUrl(proxyUrl)}`;
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
   * Probe each account slot's configured line. Same proxy on multiple slots is allowed
   * (e.g. Shadowrocket — one fixed proxy per physical device).
   */
  async assignWorkingForAccounts(accountCount, getAccountName) {
    const slotProxies = this.getProxiesBySlot(accountCount);
    const assigned = [];
    const store = this.loadWorkingStore();
    const updatedStore = { ...store };
    const probeCache = new Map();

    console.log('[PROXY] Probing proxies per account line (shared IP across slots is OK)');
    console.log('[PROXY] Note: probe OK does not guarantee QR link; app will rotate proxies until QR works.');
    console.log('');

    for (let i = 0; i < accountCount; i++) {
      const accountName = getAccountName ? getAccountName(i) : `account${i + 1}`;
      const configured = slotProxies[i];
      const saved = store[accountName];
      let found = null;

      const candidates = [];
      if (configured) candidates.push(configured);
      if (saved && !candidates.includes(saved)) candidates.push(saved);

      for (const url of candidates) {
        let ok = probeCache.get(url);
        if (ok === undefined) {
          const label = this.maskUrl(url);
          process.stdout.write(`[PROXY] ${accountName}: testing ${label} ... `);
          ok = await probeProxy(url);
          probeCache.set(url, ok);
          console.log(ok ? 'OK' : 'fail');
        } else if (ok) {
          console.log(`[PROXY] ${accountName}: ${this.maskUrl(url)} (cached OK)`);
        }
        if (ok) {
          found = url;
          updatedStore[accountName] = url;
          break;
        }
      }

      if (!found && !configured) {
        console.log(`[PROXY] ${accountName}: no proxy on this line — direct connection`);
      } else if (!found) {
        console.log(`[PROXY] ${accountName}: line proxy failed probe — direct connection`);
      } else {
        console.log(`[PROXY] ${accountName}: assigned ${this.maskUrl(found)}`);
      }

      assigned.push(found);
    }

    this.saveWorkingStore(updatedStore);
    console.log('');
    console.log('[PROXY] Assignment summary (probe TCP → WA hosts):');
    for (let i = 0; i < accountCount; i++) {
      const accountName = getAccountName ? getAccountName(i) : `account${i + 1}`;
      const url = assigned[i];
      const route = url ? this.maskUrl(url) : 'direct (probe failed or none)';
      console.log(`  ${accountName}: ${route}`);
    }
    console.log('[PROXY] Feeding/connect will use the route above per account slot.');
    console.log('');
    return assigned;
  }

  /**
   * Probe and assign proxies for specific account slots only (per-pair feeding).
   * Returns a full-length array; unassigned slots stay null.
   */
  async assignWorkingForSlotIndices(totalSlots, slotIndices, getAccountName) {
    const assigned = new Array(totalSlots).fill(null);
    if (!slotIndices?.length) return assigned;

    const slotProxies = this.getProxiesBySlot(totalSlots);
    const store = this.loadWorkingStore();
    const updatedStore = { ...store };
    const probeCache = new Map();

    console.log('[PROXY] Probing proxies for selected pair slot(s) only');
    console.log('');

    for (const i of slotIndices) {
      const accountName = getAccountName ? getAccountName(i) : `account${i + 1}`;
      const configured = slotProxies[i];
      const saved = store[accountName];
      let found = null;

      const candidates = [];
      if (configured) candidates.push(configured);
      if (saved && !candidates.includes(saved)) candidates.push(saved);

      for (const url of candidates) {
        let ok = probeCache.get(url);
        if (ok === undefined) {
          const label = this.maskUrl(url);
          process.stdout.write(`[PROXY] ${accountName}: testing ${label} ... `);
          ok = await probeProxy(url);
          probeCache.set(url, ok);
          console.log(ok ? 'OK' : 'fail');
        } else if (ok) {
          console.log(`[PROXY] ${accountName}: ${this.maskUrl(url)} (cached OK)`);
        }
        if (ok) {
          found = url;
          updatedStore[accountName] = url;
          break;
        }
      }

      if (!found && !configured) {
        console.log(`[PROXY] ${accountName}: no proxy on this line — direct connection`);
      } else if (!found) {
        console.log(`[PROXY] ${accountName}: line proxy failed probe — direct connection`);
      } else {
        console.log(`[PROXY] ${accountName}: assigned ${this.maskUrl(found)}`);
      }

      assigned[i] = found;
    }

    this.saveWorkingStore(updatedStore);
    console.log('');
    console.log('[PROXY] Assignment summary (selected slots):');
    for (const i of slotIndices) {
      const accountName = getAccountName ? getAccountName(i) : `account${i + 1}`;
      const url = assigned[i];
      const route = url ? this.maskUrl(url) : 'direct (probe failed or none)';
      console.log(`  ${accountName}: ${route}`);
    }
    console.log('');
    return assigned;
  }
}

module.exports = ProxyManager;
