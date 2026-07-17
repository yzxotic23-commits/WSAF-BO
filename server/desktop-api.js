const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const DesktopBridge = require('./bridge');
const { AmsStore } = require('../src/ams-db');
const { isAmsBridgeRequest } = require('../src/bridge-client-mode');

const PORT = parseInt(process.env.DESKTOP_API_PORT || '47821', 10);
const PKG = require('../package.json');

function createDesktopApi(options = {}) {
  const { updater, host = '127.0.0.1' } = options;
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  const bridge = new DesktopBridge((event, payload) => {
    io.emit(event, payload);
  });

  // AMS store — shares app root with WSAF data
  const amsRoot = process.env.APP_ROOT || process.cwd();
  const ams = new AmsStore(amsRoot);

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  app.use((req, _res, next) => {
    req.feedflowClient = isAmsBridgeRequest(req) ? 'ams-bridge' : 'feedflow-app';
    next();
  });

  function requireAmsBridge(req, res, next) {
    if (req.feedflowClient !== 'ams-bridge') {
      return res.status(403).json({
        error: 'Endpoint ini khusus AMS dashboard — FeedFlow app pakai route langsung tanpa sync AMS.',
      });
    }
    next();
  }

  // Allow embedding inside AMS web shell (iframe)
  app.use((_req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "frame-ancestors 'self' http://localhost:3000 http://127.0.0.1:3000 http://localhost:5173 http://127.0.0.1:5173",
    );
    next();
  });

  // Serve compiled frontend (unified React SPA)
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));

  // Legacy client portal (standalone page, not yet in React)
  app.get('/portal', (_req, res) => {
    res.sendFile(path.join(__dirname, 'ams', 'portal.html'));
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, version: PKG.version });
  });

  app.get('/api/update', (_req, res) => {
    const { resolveManualDownloadUrl } = require('../electron/update-config');
    const base = updater?.getState() || { enabled: false, status: 'disabled', currentVersion: PKG.version };
    res.json({ ...base, manualDownloadUrl: base.manualDownloadUrl || resolveManualDownloadUrl() });
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

  app.post('/api/update/install', (_req, res) => {
    try {
      if (!updater) return res.status(400).json({ error: 'Updater not available' });
      const state = updater.getState();
      if (state.status !== 'downloaded') {
        const hint =
          state.status === 'downloading'
            ? `Download in progress (${state.percent || 0}%) — wait until 100%`
            : state.status === 'available' || state.status === 'checking'
              ? 'Download still starting — wait a moment or use Manual download'
              : 'No update downloaded yet';
        return res.status(400).json({ error: hint, status: state.status, percent: state.percent });
      }
      if (bridge.isFeedingActive()) {
        bridge.stopFeeding();
      }
      res.json({ ok: true });
      // Give child feeding processes time to exit before NSIS replaces the exe.
      setTimeout(() => updater.quitAndInstall(), 1500);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/update/open-browser', (_req, res) => {
    try {
      const { resolveManualDownloadUrl } = require('../electron/update-config');
      const url = resolveManualDownloadUrl();
      let opened = false;
      try {
        const { shell } = require('electron');
        shell.openExternal(url);
        opened = true;
      } catch {
        /* API not running inside Electron shell */
      }
      res.json({ ok: true, url, opened });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/status', (_req, res) => {
    res.json(bridge.getStatus());
  });

  /** Unified payload for AMS Project dashboard (Phase 4 bridge). */
  app.get('/api/bridge/summary', requireAmsBridge, (_req, res) => {
    try {
      const status = bridge.getStatus();
      const summary = bridge.getAuditSummary();
      const accounts = status.accounts || [];
      const slotsOnline = accounts.filter((a) => a.connected).length;
      const slotsFeeding = accounts.filter((a) => a.feedingActive).length;
      const slotsLinking = accounts.filter((a) => a.linking).length;

      res.json({
        ok: true,
        version: PKG.version,
        reachable: true,
        engine: {
          accountCount: status.accountCount,
          pairCount: status.pairCount,
          feedingRunning: Boolean(status.feedingRunning),
          feedingStarting: Boolean(status.feedingStarting),
          feedingActivePairs: status.feedingActivePairs || [],
          slotsOnline,
          slotsOffline: Math.max(0, accounts.length - slotsOnline - slotsLinking),
          slotsFeeding,
          slotsLinking,
          lastFeedingComplete: status.lastFeedingComplete || null,
        },
        slots: accounts.map((a) => ({
          slot: a.slot,
          label: a.label || a.name,
          phone: a.phone || null,
          connected: Boolean(a.connected),
          linking: Boolean(a.linking),
          feedingActive: Boolean(a.feedingActive),
        })),
        feeding: {
          summary: {
            totalFeedingVolume: summary.totalFeedingVolume ?? 0,
            successVolume: summary.successVolume ?? 0,
            restrictVolume: summary.restrictVolume ?? 0,
            bannedVolume: summary.bannedVolume ?? 0,
            successRate: summary.successRate ?? 0,
          },
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
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

  app.post('/api/settings/proxies', async (req, res) => {
    try {
      const content = req.body?.content ?? '';
      res.json(await bridge.writeProxiesRaw(content));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/proxies/validate', (req, res) => {
    try {
      const content = req.body?.content;
      res.json(bridge.analyzeProxyDuplicates(content ?? null));
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

  app.post('/api/profile/refresh', requireAmsBridge, (_req, res) => {
    try {
      const status = bridge.getStatus();
      bridge.emit('status', status);
      res.json(status);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/slots/:slot/display-label', requireAmsBridge, (req, res) => {
    try {
      const slot = parseInt(req.params.slot, 10);
      if (Number.isNaN(slot) || slot < 0) {
        res.status(400).json({ error: 'Invalid slot' });
        return;
      }
      const clear = req.body?.clear === true || req.body?.clear === 'true';
      const accountName = req.body?.accountName || req.body?.account_name;
      if (clear || accountName === '') {
        const result = bridge.clearSlotDisplayLabel(slot);
        res.json({ ok: true, cleared: true, ...result });
        return;
      }
      if (!accountName) {
        res.status(400).json({ error: 'accountName required (or clear:true)' });
        return;
      }
      const row = bridge.setSlotDisplayLabel(slot, accountName, {
        phone: req.body?.phone || req.body?.phone_number || null,
        siteKey: req.body?.siteKey || req.body?.site_key || null,
        location: req.body?.location || null,
        ipAddress: req.body?.ipAddress || req.body?.ip_address || null,
      });
      res.json({ ok: true, slot, label: row });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/slots/:slot/proxy', requireAmsBridge, async (req, res) => {
    try {
      const slot = parseInt(req.params.slot, 10);
      if (Number.isNaN(slot) || slot < 0) {
        res.status(400).json({ error: 'Invalid slot' });
        return;
      }
      const proxyUrl = req.body?.proxyUrl || req.body?.proxy_url;
      if (!proxyUrl) {
        res.status(400).json({ error: 'proxyUrl required' });
        return;
      }
      const data = await bridge.setSlotProxy(slot, proxyUrl);
      res.json(data);
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

  app.post('/api/auth/codex/restart', async (_req, res) => {
    try {
      const result = await bridge.restartCodexProxy();
      if (!result.ok) {
        res.status(503).json(result);
        return;
      }
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
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

  app.post('/api/proxies/probe', async (req, res) => {
    try {
      const content = req.body?.content;
      res.json(await bridge.probeAllProxies(content));
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
      const phoneNumber = req.body?.phoneNumber || null;
      const clearIncomplete = Boolean(req.body?.clearIncomplete);
      const refreshPairing = Boolean(req.body?.refreshPairing);
      if (method === 'pairing') {
        const digits = String(phoneNumber || '').replace(/\D/g, '');
        if (digits.length < 8) {
          return res.status(400).json({
            error: 'Nomor telepon wajib untuk pairing code (kode negara + nomor, contoh: 628123456789)',
          });
        }
      }
      res.json(await bridge.connectAccount(slot, {
        method: method === 'pairing' ? 'pairing' : 'qr',
        phoneNumber: method === 'pairing' ? phoneNumber : undefined,
        clearIncomplete,
        refreshPairing,
      }));
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
      const { fromLabel, toLabel, fromSlot, toSlot, pairIndex, text, kind } = req.body || {};
      bridge.pushFeedingMessage(fromLabel, toLabel, text, kind, {
        fromSlot,
        toSlot,
        pairIndex,
      });
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

  app.post('/api/accounts/remove-pair', async (req, res) => {
    try {
      const pairIndex = parseInt(req.body?.pairIndex, 10);
      if (!Number.isFinite(pairIndex)) {
        res.status(400).json({ ok: false, error: 'pairIndex is required' });
        return;
      }
      res.json(await bridge.removePair(pairIndex));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/feeding/start', async (req, res) => {
    try {
      const pairIndex = req.body?.pairIndex;
      res.json(await bridge.startFeeding({ pairIndex }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/feeding/stop', (req, res) => {
    try {
      const pairIndex = req.body?.pairIndex;
      res.json(bridge.stopFeeding({ pairIndex }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/env', (_req, res) => {
    res.json(bridge.readEnvFile());
  });

  app.post('/api/audit/sync', requireAmsBridge, (_req, res) => {
    try {
      const synced = bridge.syncLinkedSlotsAudit();
      res.json({
        ok: true,
        synced: synced.count,
        ...bridge.getAuditList({ limit: 500, offset: 0 }),
        summary: bridge.getAuditSummary(),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/audit', (req, res) => {
    try {
      const rawLimit = req.query.limit;
      const limit = rawLimit == null || rawLimit === ''
        ? 0
        : parseInt(rawLimit, 10);
      const offset = parseInt(req.query.offset || '0', 10);
      if (
        req.feedflowClient === 'ams-bridge'
        && offset === 0
        && bridge.getAuditList({ limit: 1, offset: 0 }).total === 0
      ) {
        bridge.syncLinkedSlotsAudit();
      }
      res.json({
        ...bridge.getAuditList({
          limit: Number.isFinite(limit) ? limit : 0,
          offset,
        }),
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

  // ── AMS API ───────────────────────────────────────────────────────────────
  // Reference data
  app.get('/api/ams/meta', (_req, res) => {
    try {
      res.json({ sites: ams.getSites(), brands: ams.getBrands() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/ams/summary', (_req, res) => {
    try { res.json(ams.getSummary()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Accounts
  app.get('/api/ams/accounts', (req, res) => {
    try {
      const { status, site_id, brand_id, search, limit, offset } = req.query;
      const accounts = ams.getAccounts({ status, site_id, brand_id, search,
        limit: limit ? parseInt(limit) : undefined,
        offset: offset ? parseInt(offset) : undefined });
      res.json({ accounts, total: accounts.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/ams/accounts/:id', (req, res) => {
    try {
      const a = ams.getAccount(parseInt(req.params.id));
      if (!a) return res.status(404).json({ error: 'Not found' });
      res.json(a);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/ams/accounts', (req, res) => {
    try { res.json(ams.createAccount(req.body || {})); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/ams/accounts/:id', (req, res) => {
    try {
      const a = ams.updateAccount(parseInt(req.params.id), req.body || {});
      if (!a) return res.status(404).json({ error: 'Not found' });
      res.json(a);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Ban log
  app.post('/api/ams/accounts/:id/ban', (req, res) => {
    try {
      res.json(ams.recordBan({ ...req.body, account_id: parseInt(req.params.id) }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/ams/ban/:id', (req, res) => {
    try { res.json(ams.updateBanLog(parseInt(req.params.id), req.body || {})); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // IPs
  app.get('/api/ams/ips', (req, res) => {
    try {
      const { active } = req.query;
      res.json(ams.getIps(active !== undefined ? { active: active === '1' || active === 'true' } : {}));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/ams/ips', (req, res) => {
    try { res.json(ams.createIp(req.body || {})); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/ams/ips/:id', (req, res) => {
    try { res.json(ams.updateIp(parseInt(req.params.id), req.body || {})); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/ams/ips/:id', (req, res) => {
    try { res.json(ams.deleteIp(parseInt(req.params.id))); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Devices
  app.get('/api/ams/devices', (req, res) => {
    try {
      const { site_id } = req.query;
      res.json(ams.getDevices(site_id ? { site_id } : {}));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/ams/devices', (req, res) => {
    try { res.json(ams.createDevice(req.body || {})); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/ams/devices/:id', (req, res) => {
    try { res.json(ams.updateDevice(parseInt(req.params.id), req.body || {})); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // SIMs
  app.get('/api/ams/sims', (req, res) => {
    try {
      const { status, telco, expiring } = req.query;
      res.json(ams.getSims({ status, telco, expiring: expiring === '1' || expiring === 'true' }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/ams/sims', (req, res) => {
    try { res.json(ams.createSim(req.body || {})); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/ams/sims/:id', (req, res) => {
    try { res.json(ams.updateSim(parseInt(req.params.id), req.body || {})); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // IP Audits
  app.get('/api/ams/ips/audit-summary', (_req, res) => {
    try { res.json(ams.getIpAuditSummary()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/ams/ips/with-audit', (_req, res) => {
    try { res.json(ams.getIpsWithAuditStatus()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/ams/ips/:id/audits', (req, res) => {
    try { res.json(ams.getIpAudits(parseInt(req.params.id))); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/ams/ips/:id/audit', (req, res) => {
    try {
      const record = ams.recordIpAudit({ ...req.body, ip_id: parseInt(req.params.id) });
      res.json(record);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Work Orders
  app.get('/api/ams/workorders', (req, res) => {
    try {
      const { status, brand_id, type } = req.query;
      res.json(ams.getWorkOrders({ status, brand_id, type }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/ams/workorders/counts', (_req, res) => {
    try { res.json(ams.getWorkOrderCounts()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/ams/workorders/:id', (req, res) => {
    try {
      const wo = ams.getWorkOrder(parseInt(req.params.id));
      if (!wo) return res.status(404).json({ error: 'Not found' });
      res.json(wo);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/ams/workorders', (req, res) => {
    try { res.json(ams.createWorkOrder(req.body || {})); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/ams/workorders/:id', (req, res) => {
    try {
      const wo = ams.updateWorkOrder(parseInt(req.params.id), req.body || {});
      if (!wo) return res.status(404).json({ error: 'Not found' });
      res.json(wo);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  io.on('connection', (socket) => {
    socket.emit('status', bridge.getStatus());
    if (updater) socket.emit('update', updater.getState());
    for (let i = 0; i < bridge.getStatus().accountCount; i++) {
      socket.emit('chat', { slot: i, history: bridge.getChatHistory(i) });
    }
    socket.on('disconnect', () => {});
  });

  // SPA fallback — unified FeedFlow React app (HashRouter)
  const spaIndex = path.join(clientDist, 'index.html');
  app.get('*', (req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.sendFile(spaIndex, (err) => (err ? next(err) : undefined));
  });

  return {
    app,
    server,
    io,
    bridge,
    updater,
    port: PORT,
    start: () =>
      new Promise((resolve) => {
        process.env.DESKTOP_API_PORT = String(PORT);
        server.listen(PORT, host, () => {
          console.log(`[API] Desktop API http://${host}:${PORT}`);
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
