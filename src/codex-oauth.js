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

async function startCodexProxy() {
  const envBase = process.env.CODEX_PROXY_BASE_URL?.trim();
  if (envBase) {
    return {
      ok: true,
      baseURL: normalizeBaseURL(envBase),
      authFile: await findCodexAuthFile(),
      reused: true,
      external: true,
    };
  }

  const authFile = await findCodexAuthFile();
  if (!authFile) {
    return {
      ok: false,
      reason: 'no_auth',
      message:
        'Codex auth file not found. Run: npm run codex-login\n'
        + '  (saves token to ~/.codex/auth.json — same as Codex CLI)',
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

  const { startOpenAIOAuthServer } = await import('openai-oauth');

  runningServer = await startOpenAIOAuthServer({
    host,
    port,
    authFilePath: process.env.CODEX_AUTH_FILE?.trim() || authFile,
    models,
  });

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
  return [
    'Login Codex (subscription ChatGPT):',
    '  npm run codex-login',
    '',
    'Browser akan terbuka — masuk dengan akun ChatGPT Plus/Pro yang punya Codex.',
    'Token disimpan di ~/.codex/auth.json (sama seperti Codex CLI / OpenClaw).',
    '',
    'Lalu di .env set:',
    '  OPENAI_AUTH_MODE=codex',
    '  OPENAI_MODEL=auto',
  ].join('\n');
}

module.exports = {
  findCodexAuthFile,
  getAuthFileCandidates,
  getRunningProxyBaseURL,
  normalizeBaseURL,
  startCodexProxy,
  stopCodexProxy,
  getCodexLoginHint,
};
