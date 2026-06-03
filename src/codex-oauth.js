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

async function startCodexProxy() {
  const authFile = await findCodexAuthFile();
  if (!authFile) {
    return {
      ok: false,
      reason: 'no_auth',
      message:
        'File auth Codex tidak ditemukan. Jalankan: npm run codex-login\n'
        + '  (menyimpan token di ~/.codex/auth.json seperti OpenClaw/Codex CLI)',
    };
  }

  if (runningServer) {
    return {
      ok: true,
      baseURL: runningServer.url,
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
    baseURL: runningServer.url,
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
  startCodexProxy,
  stopCodexProxy,
  getCodexLoginHint,
};
