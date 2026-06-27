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

module.exports = { probeProxy, probeTcp };
