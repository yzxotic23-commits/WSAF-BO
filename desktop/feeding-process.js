const { spawn } = require('child_process');
const path = require('path');

class FeedingProcess {
  constructor(projectRoot, userDataPath, onLine) {
    this.projectRoot = projectRoot;
    this.userDataPath = userDataPath;
    this.onLine = onLine;
    this.child = null;
  }

  isRunning() {
    return Boolean(this.child);
  }

  start(options = {}) {
    if (this.child) {
      return { ok: false, error: 'Feeding already running' };
    }

    const nodeBin = process.execPath;
    const scriptPath = path.join(this.projectRoot, 'index.js');
    const env = {
      ...process.env,
      WA_APP_DATA: this.userDataPath,
      WA_NON_INTERACTIVE: '1',
      WA_DESKTOP_MODE: '1',
      WA_LANGUAGE: options.language || process.env.LANGUAGE || 'Indonesia',
      WA_LOGIN_METHOD: options.loginMethod || 'qr',
      WA_POST_FEEDING: 'exit',
      ELECTRON_RUN_AS_NODE: '1',
    };

    this.child = spawn(nodeBin, [scriptPath], {
      cwd: this.projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const handleChunk = (chunk) => {
      String(chunk)
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((line) => this.onLine(line));
    };

    this.child.stdout.on('data', handleChunk);
    this.child.stderr.on('data', handleChunk);

    this.child.on('close', (code) => {
      this.onLine(`[feeding] Process ended (code ${code})`);
      this.child = null;
    });

    return { ok: true };
  }

  stop() {
    if (!this.child) return { ok: false };
    this.child.kill('SIGTERM');
    return { ok: true };
  }
}

module.exports = FeedingProcess;
