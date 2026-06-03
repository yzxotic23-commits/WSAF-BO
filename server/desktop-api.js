const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const DesktopBridge = require('./bridge');
const { normalizePairingPhone } = require('../src/login-prefs');

const PORT = parseInt(process.env.DESKTOP_API_PORT || '47821', 10);
const PKG = require('../package.json');

function createDesktopApi(options = {}) {
  const { updater } = options;
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  const bridge = new DesktopBridge((event, payload) => {
    io.emit(event, payload);
  });

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, version: PKG.version });
  });

  app.get('/api/update', (_req, res) => {
    res.json(updater?.getState() || { enabled: false, status: 'disabled', currentVersion: PKG.version });
  });

  app.post('/api/update/check', async (_req, res) => {
    try {
      if (!updater) return res.json({ enabled: false, status: 'disabled' });
      updater.refreshConfig();
      const state = await updater.check(false);
      res.json(state);
    } catch (e) {
      res.status(500).json({ error: e.message, ...(updater?.getState() || {}) });
    }
  });

  app.post('/api/update/install', async (_req, res) => {
    try {
      if (!updater) return res.status(400).json({ error: 'Updater not available' });
      const state = updater.getState();
      if (state.manualInstall && state.status === 'available') {
        if (!updater.openDownloadPage()) {
          return res.status(400).json({ error: 'No download URL for this update' });
        }
        return res.json({
          ok: true,
          mode: 'mac-dmg-manual',
          downloadUrl: state.downloadUrl,
        });
      }
      if (state.status !== 'downloaded') {
        return res.status(400).json({ error: 'No update downloaded yet' });
      }
      await bridge.shutdownForUpdate();
      res.json({ ok: true });
      setTimeout(() => updater.quitAndInstall(), 600);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/status', (_req, res) => {
    res.json(bridge.getStatus());
  });

  app.post('/api/refresh', async (_req, res) => {
    try {
      res.json(await bridge.refreshAccounts());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/chat/:slot', (req, res) => {
    const slot = parseInt(req.params.slot, 10);
    if (Number.isNaN(slot) || slot < 0 || slot >= bridge.getStatus().accountCount) {
      return res.status(400).json({ error: 'Invalid slot' });
    }
    res.json({ slot, messages: bridge.getChatHistory(slot) });
  });

  app.delete('/api/chat/:slot', (req, res) => {
    const slot = parseInt(req.params.slot, 10);
    bridge.clearChat(slot);
    res.json({ ok: true });
  });

  app.get('/api/settings', (_req, res) => {
    res.json(bridge.getSettingsBundle());
  });

  app.post('/api/settings/env', (req, res) => {
    try {
      const updates = req.body?.updates || req.body || {};
      res.json({ ok: true, env: bridge.writeEnvUpdates(updates) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/settings/proxies', (req, res) => {
    try {
      const content = req.body?.content ?? '';
      res.json(bridge.writeProxiesRaw(content));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/sessions/clear-all', async (_req, res) => {
    try {
      res.json(await bridge.clearAllSessions());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/profile/refresh', (_req, res) => {
    try {
      const status = bridge.getStatus();
      bridge.emit('status', status);
      res.json(status);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/sessions/strict-logout', async (req, res) => {
    try {
      const slot = parseInt(req.body?.slot, 10);
      if (Number.isNaN(slot) || slot < 0) {
        res.status(400).json({ error: 'Invalid slot' });
        return;
      }
      res.json(await bridge.handleStrictLogout(slot, req.body?.alert || null));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/auth/codex', (_req, res) => {
    res.json(bridge.getCodexStatus());
  });

  app.get('/api/auth/codex/login-command', (_req, res) => {
    const codex = require('../src/codex-oauth');
    res.json({
      command: bridge.getCodexLoginCommand(),
      hint: codex.getCodexLoginHint(),
      authPath: bridge.getCodexAuthPath(),
    });
  });

  app.get('/api/ai/status', async (_req, res) => {
    try {
      res.json(await bridge.getAiStatus());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/proxies/load', async (_req, res) => {
    try {
      res.json(await bridge.loadProxies());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/proxies/probe', async (_req, res) => {
    try {
      res.json(await bridge.probeAllProxies());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/connect', (_req, res) => {
    res.status(410).json({
      error:
        'Bulk connect disabled. Link one account at a time via POST /api/connect/:slot or the desktop UI.',
    });
  });

  app.post('/api/connect/:slot', async (req, res) => {
    try {
      const slot = parseInt(req.params.slot, 10);
      const method = req.body?.method || 'qr';
      if (method === 'pairing') {
        const phoneNumber = normalizePairingPhone(req.body?.phoneNumber);
        if (phoneNumber.length < 8 || phoneNumber.length > 15) {
          res.status(400).json({
            error:
              'Invalid phone number — use country code + number without + (e.g. 60123456789)',
          });
          return;
        }
        res.json(
          await bridge.connectAccount(slot, { method: 'pairing', phoneNumber })
        );
        return;
      }
      res.json(
        await bridge.connectAccount(slot, {
          method: 'qr',
          clearIncomplete: Boolean(req.body?.clearIncomplete),
        })
      );
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/disconnect', async (_req, res) => {
    try {
      await bridge.disconnectAll();
      res.json(bridge.getStatus());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/disconnect/:slot', async (req, res) => {
    try {
      const slot = parseInt(req.params.slot, 10);
      await bridge.disconnectAccount(slot);
      res.json(bridge.getStatus());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/logout/:slot', async (req, res) => {
    try {
      const slot = parseInt(req.params.slot, 10);
      await bridge.logoutAccount(slot);
      res.json(bridge.getStatus());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/feeding/chat', (req, res) => {
    try {
      const { fromLabel, toLabel, text, kind } = req.body || {};
      bridge.pushFeedingMessage(fromLabel, toLabel, text, kind);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/feeding/complete', (req, res) => {
    try {
      res.json(bridge.recordFeedingComplete(req.body || {}));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/feeding/complete/dismiss', (_req, res) => {
    try {
      res.json(bridge.dismissFeedingComplete());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/accounts/add-pair', async (_req, res) => {
    try {
      res.json(await bridge.addPair());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/accounts/remove-last-pair', async (_req, res) => {
    try {
      res.json(await bridge.removeLastPair());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/feeding/start', async (_req, res) => {
    try {
      res.json(await bridge.startFeeding());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/feeding/stop', (_req, res) => {
    try {
      res.json(bridge.stopFeeding());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/env', (_req, res) => {
    res.json(bridge.readEnvFile());
  });

  app.get('/api/audit', (req, res) => {
    try {
      const limit = parseInt(req.query.limit || '500', 10);
      const offset = parseInt(req.query.offset || '0', 10);
      res.json({
        ...bridge.getAuditList({ limit, offset }),
        summary: bridge.getAuditSummary(),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/audit/summary', (_req, res) => {
    try {
      res.json(bridge.getAuditSummary());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/audit/export', (_req, res) => {
    try {
      const csv = bridge.exportAuditCsv();
      const version = PKG.version || '0';
      const filename = `WhatsApp-Audit-Log-v${version}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/audit/record', (req, res) => {
    try {
      const entry = bridge.recordAuditEntry(req.body || {});
      res.json({ ok: true, entry, summary: bridge.getAuditSummary() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  io.on('connection', (socket) => {
    socket.emit('status', bridge.getStatus());
    if (updater) socket.emit('update', updater.getState());
    for (let i = 0; i < bridge.getStatus().accountCount; i++) {
      socket.emit('chat', { slot: i, history: bridge.getChatHistory(i) });
    }
    socket.on('disconnect', () => {});
  });

  return {
    app,
    server,
    io,
    bridge,
    updater,
    port: PORT,
    start: () =>
      new Promise((resolve, reject) => {
        process.env.DESKTOP_API_PORT = String(PORT);
        server.once('error', (err) => {
          console.error('[API] listen failed:', err.message);
          reject(err);
        });
        server.listen(PORT, '127.0.0.1', () => {
          console.log(`[API] Desktop API http://127.0.0.1:${PORT}`);
          resolve(PORT);
        });
      }),
  };
}

function installProcessGuards() {
  if (installProcessGuards._done) return;
  installProcessGuards._done = true;
  process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || reason?.output?.payload?.message || String(reason);
    console.error('[API] Unhandled rejection (kept running):', msg);
  });
  process.on('uncaughtException', (err) => {
    console.error('[API] Uncaught exception (kept running):', err?.message || err);
  });
}

installProcessGuards();

if (require.main === module) {
  const api = createDesktopApi();
  api.start();
}

module.exports = { createDesktopApi, PORT };
