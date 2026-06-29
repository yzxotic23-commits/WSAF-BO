/**
 * Resolve auto-update feed (GitHub Releases by default).
 */
const DEFAULT_GITHUB_OWNER = 'yzxotic23-commits';
const DEFAULT_GITHUB_REPO = 'WSAF-BO';

function readPkgRepository() {
  try {
    const pkg = require('../package.json');
    const url = pkg.repository?.url || pkg.repository || '';
    const m = String(url).match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
    if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
  } catch { /* noop */ }
  return null;
}

function resolveUpdateConfig(env = process.env) {
  const customUrl = String(env.APP_UPDATE_URL || '').trim();
  const owner = String(env.APP_UPDATE_GITHUB_OWNER || '').trim() || readPkgRepository()?.owner || DEFAULT_GITHUB_OWNER;
  const repo = String(env.APP_UPDATE_GITHUB_REPO || '').trim() || readPkgRepository()?.repo || DEFAULT_GITHUB_REPO;

  if (customUrl) {
    return {
      enabled: true,
      mode: 'generic',
      url: customUrl.replace(/\/?$/, '/'),
      owner,
      repo,
    };
  }

  if (owner && repo) {
    return {
      enabled: true,
      mode: 'github-releases',
      url: `https://github.com/${owner}/${repo}/releases/latest/download/`,
      owner,
      repo,
    };
  }

  return { enabled: false, mode: 'none', url: null, owner: null, repo: null };
}

function resolveManualDownloadUrl(cfg = resolveUpdateConfig()) {
  if (cfg.owner && cfg.repo) {
    return `https://github.com/${cfg.owner}/${cfg.repo}/releases/latest`;
  }
  return String(cfg.url || '').replace(/\/download\/?$/i, '');
}

module.exports = {
  DEFAULT_GITHUB_OWNER,
  DEFAULT_GITHUB_REPO,
  resolveUpdateConfig,
  resolveManualDownloadUrl,
};
