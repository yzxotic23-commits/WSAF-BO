const net = require('net');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

const DEFAULT_TIMEOUT_MS = parseInt(process.env.PROXY_PROBE_TIMEOUT_MS || '12000', 10);

const WA_PROBE_HOSTS = [
  { host: 'web.whatsapp.com', port: 443 },
  { host: 'g.whatsapp.net', port: 443 },
];

function createAgent(proxyUrl) {
  if (proxyUrl.startsWith('socks')) {
    return new SocksProxyAgent(proxyUrl);
  }
  return new HttpsProxyAgent(proxyUrl);
}

/** TCP connect to WA hosts through proxy (matches how Baileys uses SOCKS). */
function probeTcp(proxyUrl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let agent;
    try {
      agent = createAgent(proxyUrl);
    } catch {
      resolve(false);
      return;
    }

    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);

    (async () => {
      for (const { host, port } of WA_PROBE_HOSTS) {
        const ok = await new Promise((res) => {
          const socket = net.connect({ host, port, agent }, () => {
            socket.destroy();
            res(true);
          });
          socket.setTimeout(timeoutMs, () => {
            socket.destroy();
            res(false);
          });
          socket.on('error', () => res(false));
        });
        if (ok) {
          clearTimeout(timer);
          finish(true);
          return;
        }
      }
      clearTimeout(timer);
      finish(false);
    })();
  });
}

async function probeProxy(proxyUrl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!proxyUrl) return false;
  return probeTcp(proxyUrl, timeoutMs);
}

/**
 * Public egress IP seen through the proxy (proves WA will not use Railway egress).
 * Returns null if lookup fails.
 */
async function resolveProxyEgressIp(proxyUrl, timeoutMs = 10000) {
  if (!proxyUrl) return null;
  let agent;
  try {
    agent = createAgent(proxyUrl);
  } catch {
    return null;
  }

  const https = require('https');
  const urls = [
    'https://api.ipify.org',
    'https://ifconfig.me/ip',
  ];

  for (const url of urls) {
    const ip = await new Promise((resolve) => {
      const req = https.get(url, { agent, timeout: timeoutMs }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          const trimmed = String(body || '').trim();
          resolve(/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed) ? trimmed : null);
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
    });
    if (ip) return ip;
  }
  return null;
}

module.exports = { probeProxy, probeTcp, resolveProxyEgressIp };
