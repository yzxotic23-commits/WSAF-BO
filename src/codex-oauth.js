const fs = require('fs').promises;
const path = require('path');
const os = require('os');

let runningServer = null;

function getAuthFileCandidates() {
  const explicit = process.env.CODEX_AUTH_FILE?.trim();
  const envHome = process.env.CHATGPT_LOCAL_HOME?.trim();
  const codexHome = process.env.CODEX_HOME?.trim();

  const candidates = [
    explicit,
    envHome ? path.join(envHome, 'auth.json') : null,
    codexHome ? path.join(codexHome, 'auth.json') : null,
    path.join(os.homedir(), '.chatgpt-local', 'auth.json'),
    path.join(os.homedir(), '.codex', 'auth.json'),
  ].filter(Boolean);

  return [...new Set(candidates)];
}

async function findCodexAuthFile() {
  for (const candidate of getAuthFileCandidates()) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

function parseModelList(raw) {
  if (!raw || raw.toLowerCase() === 'auto') return undefined;
  const models = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return models.length > 0 ? models : undefined;
}

function normalizeBaseURL(url) {
  const raw = String(url || '').trim().replace(/\/+$/, '');
  return raw.endsWith('/v1') ? raw : `${raw}/v1`;
}

function getRunningProxyBaseURL() {
  if (!runningServer?.url) return null;
  return normalizeBaseURL(runningServer.url);
}

async function probeCodexProxy(baseURL, timeoutMs = 4000) {
  const root = normalizeBaseURL(baseURL).replace(/\/v1$/, '');
  const url = `${root}/v1/models`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      headers: { Authorization: 'Bearer codex-oauth' },
    });
    clearTimeout(timer);
    // Server up: 200 with models, or 401/403 (auth issue but proxy reachable)
    return res.status === 200 || res.status === 401 || res.status === 403;
  } catch {
    return false;
  }
}

async function startCodexProxy() {
  const envBase = process.env.CODEX_PROXY_BASE_URL?.trim();
  if (envBase) {
    const reachable = await probeCodexProxy(envBase);
    if (reachable) {
      return {
        ok: true,
        baseURL: normalizeBaseURL(envBase),
        authFile: await findCodexAuthFile(),
        reused: true,
        external: true,
      };
    }
    delete process.env.CODEX_PROXY_BASE_URL;
  }

  const authFile = await findCodexAuthFile();
  if (!authFile) {
    return {
      ok: false,
      reason: 'no_auth',
      message: 'Codex login not available.',
    };
  }

  if (runningServer) {
    return {
      ok: true,
      baseURL: getRunningProxyBaseURL(),
      authFile,
      reused: true,
    };
  }

  const host = process.env.CODEX_PROXY_HOST || '127.0.0.1';
  const port = Math.max(1, parseInt(process.env.CODEX_PROXY_PORT || '10531', 10));
  const models = parseModelList(process.env.OPENAI_MODEL?.trim());

  let startOpenAIOAuthServer;
  try {
    ({ startOpenAIOAuthServer } = await import('openai-oauth'));
  } catch (err) {
    return {
      ok: false,
      reason: 'import_failed',
      message:
        `Could not load openai-oauth: ${err.message}. `
        + 'Try: npm run codex-proxy (keep terminal open) or reinstall the app.',
    };
  }

  try {
    runningServer = await startOpenAIOAuthServer({
      host,
      port,
      authFilePath: process.env.CODEX_AUTH_FILE?.trim() || authFile,
      models,
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'start_failed',
      message: `Codex proxy failed to start on ${host}:${port}: ${err.message}`,
    };
  }

  const live = await probeCodexProxy(getRunningProxyBaseURL());
  if (!live) {
    await stopCodexProxy();
    return {
      ok: false,
      reason: 'probe_failed',
      message: `Codex proxy started but is not reachable at http://${host}:${port}/v1`,
    };
  }

  return {
    ok: true,
    baseURL: getRunningProxyBaseURL(),
    authFile,
    host: runningServer.host,
    port: runningServer.port,
  };
}

async function stopCodexProxy() {
  if (!runningServer) return;
  const server = runningServer;
  runningServer = null;
  try {
    await server.close();
  } catch {
    // ignore shutdown errors
  }
}

function getCodexLoginHint() {
  return 'AI provider not available.';
}

module.exports = {
  findCodexAuthFile,
  getAuthFileCandidates,
  getRunningProxyBaseURL,
  normalizeBaseURL,
  probeCodexProxy,
  startCodexProxy,
  stopCodexProxy,
  getCodexLoginHint,
};
