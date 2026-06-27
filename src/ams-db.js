/**
 * AMS — Account Management System database layer (SQLite via better-sqlite3).
 * Stores alongside WSAF user data so it persists across app updates.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const ACCOUNT_STATUSES = [
  'registering',   // Registering
  'nurturing',     // Nurturing (manual 3d or auto 4-7d)
  'standby',       // Standby pool — ready to deliver
  'in_use',        // Delivered, active with a business
  'recovering',    // Banned but recovery in progress
  'dead',          // Permanently dead / retired
];

const IP_STATUSES = ['active', 'inactive'];
const SIM_STATUSES = ['ok', 'low_balance', 'expiring', 'expired', 'cancelled'];
const DEVICE_STATUSES = ['active', 'inactive'];

function getDbPath(appRoot) {
  return path.join(appRoot, 'ams.db');
}

function openDb(appRoot) {
  const dbPath = getDbPath(appRoot);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  return db;
}

function applySchema(db) {
  db.exec(`
    -- Sites / locations
    CREATE TABLE IF NOT EXISTS sites (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      name     TEXT NOT NULL UNIQUE,
      code     TEXT NOT NULL UNIQUE
    );

    -- Brands / businesses
    CREATE TABLE IF NOT EXISTS brands (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      code TEXT NOT NULL UNIQUE
    );

    -- Devices (phones on shelves)
    CREATE TABLE IF NOT EXISTS devices (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      code        TEXT NOT NULL UNIQUE,
      site_id     INTEGER REFERENCES sites(id),
      shelf       TEXT,
      slot        TEXT,
      brand_id    INTEGER REFERENCES brands(id),
      owner       TEXT,
      status      TEXT NOT NULL DEFAULT 'active',
      note        TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- IP / Proxy ledger
    CREATE TABLE IF NOT EXISTS ips (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      address     TEXT NOT NULL,
      port        TEXT,
      username    TEXT,
      password    TEXT,
      active      INTEGER NOT NULL DEFAULT 1,
      risk_count  INTEGER NOT NULL DEFAULT 0,
      in_use      INTEGER NOT NULL DEFAULT 0,
      note        TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- SIM cards
    CREATE TABLE IF NOT EXISTS sims (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number    TEXT NOT NULL UNIQUE,
      telco           TEXT,
      location        TEXT,
      balance         REAL,
      expiry_date     TEXT,
      status          TEXT NOT NULL DEFAULT 'ok',
      last_topped_up  TEXT,
      note            TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Accounts (core ledger)
    CREATE TABLE IF NOT EXISTS accounts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      phone_number    TEXT,
      status          TEXT NOT NULL DEFAULT 'registering',
      site_id         INTEGER REFERENCES sites(id),
      device_id       INTEGER REFERENCES devices(id),
      ip_id           INTEGER REFERENCES ips(id),
      sim_id          INTEGER REFERENCES sims(id),
      brand_id        INTEGER REFERENCES brands(id),
      owner           TEXT,
      channel         TEXT,
      nurture_start   TEXT,
      nurture_end     TEXT,
      wsaf_slot       INTEGER,
      note            TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Account status history (state machine log)
    CREATE TABLE IF NOT EXISTS account_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      from_status TEXT,
      to_status   TEXT NOT NULL,
      reason      TEXT,
      changed_by  TEXT,
      changed_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Ban / recovery log
    CREATE TABLE IF NOT EXISTS ban_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      detected_at     TEXT NOT NULL DEFAULT (datetime('now')),
      detection_mode  TEXT,  -- 'manual' | 'system'
      ban_reason      TEXT,
      recovery_status TEXT DEFAULT 'pending',  -- 'pending'|'in_progress'|'success'|'failed'
      recovery_note   TEXT,
      recovery_at     TEXT,
      ip_id           INTEGER REFERENCES ips(id)
    );

    -- Work orders (business self-service requests)
    CREATE TABLE IF NOT EXISTS work_orders (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ref          TEXT NOT NULL UNIQUE,
      type         TEXT NOT NULL DEFAULT 'new_account', -- 'new_account'|'account_swap'|'top_up'|'other'
      status       TEXT NOT NULL DEFAULT 'open',        -- 'open'|'in_progress'|'done'|'cancelled'
      priority     TEXT NOT NULL DEFAULT 'normal',      -- 'low'|'normal'|'high'|'urgent'
      brand_id     INTEGER REFERENCES brands(id),
      site_id      INTEGER REFERENCES sites(id),
      quantity     INTEGER DEFAULT 1,
      requester    TEXT,
      assignee     TEXT,
      title        TEXT NOT NULL,
      description  TEXT,
      account_id   INTEGER REFERENCES accounts(id),
      due_date     TEXT,
      closed_at    TEXT,
      note         TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_wo_status   ON work_orders(status);
    CREATE INDEX IF NOT EXISTS idx_wo_brand    ON work_orders(brand_id);

    -- IP Audit log (manual audit gateway)
    CREATE TABLE IF NOT EXISTS ip_audits (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ip_id        INTEGER NOT NULL REFERENCES ips(id) ON DELETE CASCADE,
      audited_by   TEXT,
      result       TEXT NOT NULL DEFAULT 'pass',  -- 'pass'|'flag'|'retire'
      risk_note    TEXT,
      ban_count_at INTEGER DEFAULT 0,
      audited_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ip_audit_ip ON ip_audits(ip_id);

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_accounts_status   ON accounts(status);
    CREATE INDEX IF NOT EXISTS idx_accounts_site     ON accounts(site_id);
    CREATE INDEX IF NOT EXISTS idx_accounts_brand    ON accounts(brand_id);
    CREATE INDEX IF NOT EXISTS idx_acct_history_acct ON account_history(account_id);
    CREATE INDEX IF NOT EXISTS idx_ban_account       ON ban_log(account_id);
  `);

  // Seed default sites and brands if empty
  const siteCount = db.prepare('SELECT COUNT(*) as n FROM sites').get().n;
  if (siteCount === 0) {
    const insertSite = db.prepare('INSERT OR IGNORE INTO sites(name, code) VALUES (?, ?)');
    insertSite.run('Malaysia', 'MY');
    insertSite.run('Poipet', 'PP');
  }

  const brandCount = db.prepare('SELECT COUNT(*) as n FROM brands').get().n;
  if (brandCount === 0) {
    const insertBrand = db.prepare('INSERT OR IGNORE INTO brands(name, code) VALUES (?, ?)');
    insertBrand.run('SBMY', 'SBMY');
    insertBrand.run('JMMY', 'JMMY');
    insertBrand.run('STMY', 'STMY');
  }
}

// ── AmsStore class ──────────────────────────────────────────────────────────
class AmsStore {
  constructor(appRoot) {
    this.db = openDb(appRoot);
  }

  close() {
    this.db.close();
  }

  // ── Sites & Brands ───────────────────────────────────────────────────────
  getSites() { return this.db.prepare('SELECT * FROM sites ORDER BY name').all(); }
  getBrands() { return this.db.prepare('SELECT * FROM brands ORDER BY name').all(); }

  // ── Accounts ─────────────────────────────────────────────────────────────
  getAccounts(filters = {}) {
    let q = `
      SELECT a.*,
        s.name  AS site_name,  s.code  AS site_code,
        b.name  AS brand_name, b.code  AS brand_code,
        d.code  AS device_code, d.shelf, d.slot,
        ip.address AS ip_address, ip.port AS ip_port,
        si.phone_number AS sim_phone, si.telco
      FROM accounts a
      LEFT JOIN sites   s  ON a.site_id   = s.id
      LEFT JOIN brands  b  ON a.brand_id  = b.id
      LEFT JOIN devices d  ON a.device_id = d.id
      LEFT JOIN ips     ip ON a.ip_id     = ip.id
      LEFT JOIN sims    si ON a.sim_id    = si.id
      WHERE 1=1
    `;
    const params = [];
    if (filters.status)   { q += ' AND a.status = ?';   params.push(filters.status); }
    if (filters.site_id)  { q += ' AND a.site_id = ?';  params.push(filters.site_id); }
    if (filters.brand_id) { q += ' AND a.brand_id = ?'; params.push(filters.brand_id); }
    if (filters.search)   {
      q += ' AND (a.name LIKE ? OR a.phone_number LIKE ? OR a.owner LIKE ?)';
      const s = `%${filters.search}%`;
      params.push(s, s, s);
    }
    q += ' ORDER BY a.updated_at DESC';
    if (filters.limit)  { q += ' LIMIT ?';  params.push(filters.limit); }
    if (filters.offset) { q += ' OFFSET ?'; params.push(filters.offset); }
    return this.db.prepare(q).all(...params);
  }

  getAccount(id) {
    const a = this.db.prepare(`
      SELECT a.*,
        s.name AS site_name, s.code AS site_code,
        b.name AS brand_name, b.code AS brand_code,
        d.code AS device_code, d.shelf, d.slot,
        ip.address AS ip_address, ip.port AS ip_port,
        si.phone_number AS sim_phone, si.telco
      FROM accounts a
      LEFT JOIN sites   s  ON a.site_id   = s.id
      LEFT JOIN brands  b  ON a.brand_id  = b.id
      LEFT JOIN devices d  ON a.device_id = d.id
      LEFT JOIN ips     ip ON a.ip_id     = ip.id
      LEFT JOIN sims    si ON a.sim_id    = si.id
      WHERE a.id = ?
    `).get(id);
    if (!a) return null;
    a.history = this.getAccountHistory(id);
    a.ban_log = this.getBanLog(id);
    return a;
  }

  createAccount(data) {
    const stmt = this.db.prepare(`
      INSERT INTO accounts (name, phone_number, status, site_id, device_id, ip_id, sim_id, brand_id, owner, channel, nurture_start, note)
      VALUES (@name, @phone_number, @status, @site_id, @device_id, @ip_id, @sim_id, @brand_id, @owner, @channel, @nurture_start, @note)
    `);
    const result = stmt.run({
      name: data.name || '',
      phone_number: data.phone_number || null,
      status: data.status || 'registering',
      site_id: data.site_id || null,
      device_id: data.device_id || null,
      ip_id: data.ip_id || null,
      sim_id: data.sim_id || null,
      brand_id: data.brand_id || null,
      owner: data.owner || null,
      channel: data.channel || null,
      nurture_start: data.status === 'nurturing' ? new Date().toISOString() : null,
      note: data.note || null,
    });
    this._logHistory(result.lastInsertRowid, null, data.status || 'registering', 'Account created', data.changed_by);
    return this.getAccount(result.lastInsertRowid);
  }

  updateAccount(id, data) {
    const current = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    if (!current) return null;

    const fields = ['name', 'phone_number', 'site_id', 'device_id', 'ip_id', 'sim_id', 'brand_id', 'owner', 'channel', 'note', 'wsaf_slot'];
    const updates = [];
    const params = [];
    for (const f of fields) {
      if (data[f] !== undefined) { updates.push(`${f} = ?`); params.push(data[f]); }
    }

    // Status change — log it
    if (data.status && data.status !== current.status) {
      updates.push('status = ?');
      params.push(data.status);
      if (data.status === 'nurturing' && !current.nurture_start) {
        updates.push('nurture_start = ?');
        params.push(new Date().toISOString());
      }
      if (data.status === 'standby' && current.nurture_start && !current.nurture_end) {
        updates.push('nurture_end = ?');
        params.push(new Date().toISOString());
      }
      this._logHistory(id, current.status, data.status, data.reason || null, data.changed_by || null);
    }

    if (!updates.length) return this.getAccount(id);
    updates.push("updated_at = datetime('now')");
    params.push(id);
    this.db.prepare(`UPDATE accounts SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    return this.getAccount(id);
  }

  getAccountCounts() {
    return this.db.prepare(`
      SELECT status, COUNT(*) as count FROM accounts GROUP BY status
    `).all();
  }

  // ── History ──────────────────────────────────────────────────────────────
  _logHistory(accountId, fromStatus, toStatus, reason, changedBy) {
    this.db.prepare(`
      INSERT INTO account_history (account_id, from_status, to_status, reason, changed_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(accountId, fromStatus, toStatus, reason || null, changedBy || null);
  }

  getAccountHistory(accountId) {
    return this.db.prepare(`
      SELECT * FROM account_history WHERE account_id = ? ORDER BY changed_at DESC
    `).all(accountId);
  }

  // ── IPs ──────────────────────────────────────────────────────────────────
  getIps(filters = {}) {
    let q = 'SELECT * FROM ips WHERE 1=1';
    const params = [];
    if (filters.active !== undefined) { q += ' AND active = ?'; params.push(filters.active ? 1 : 0); }
    q += ' ORDER BY created_at DESC';
    return this.db.prepare(q).all(...params);
  }

  createIp(data) {
    const r = this.db.prepare(`
      INSERT INTO ips (address, port, username, password, active, note)
      VALUES (@address, @port, @username, @password, @active, @note)
    `).run({ address: data.address, port: data.port || null, username: data.username || null, password: data.password || null, active: data.active !== false ? 1 : 0, note: data.note || null });
    return this.db.prepare('SELECT * FROM ips WHERE id = ?').get(r.lastInsertRowid);
  }

  updateIp(id, data) {
    const fields = ['address', 'port', 'username', 'password', 'active', 'risk_count', 'in_use', 'note'];
    const updates = []; const params = [];
    for (const f of fields) {
      if (data[f] !== undefined) { updates.push(`${f} = ?`); params.push(data[f]); }
    }
    if (!updates.length) return this.db.prepare('SELECT * FROM ips WHERE id = ?').get(id);
    params.push(id);
    this.db.prepare(`UPDATE ips SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    return this.db.prepare('SELECT * FROM ips WHERE id = ?').get(id);
  }

  deleteIp(id) {
    const inUse = this.db.prepare('SELECT COUNT(*) as n FROM accounts WHERE ip_id = ?').get(id);
    if (inUse.n > 0) throw new Error('IP is in use by accounts — cannot delete');
    this.db.prepare('DELETE FROM ips WHERE id = ?').run(id);
    return { ok: true };
  }

  // ── Devices ──────────────────────────────────────────────────────────────
  getDevices(filters = {}) {
    let q = `SELECT d.*, s.name AS site_name, b.name AS brand_name,
      (SELECT COUNT(*) FROM accounts a WHERE a.device_id = d.id) AS account_count,
      (SELECT COUNT(*) FROM accounts a WHERE a.device_id = d.id AND a.status = 'in_use') AS active_count
      FROM devices d
      LEFT JOIN sites  s ON d.site_id  = s.id
      LEFT JOIN brands b ON d.brand_id = b.id
      WHERE 1=1`;
    const params = [];
    if (filters.site_id) { q += ' AND d.site_id = ?'; params.push(filters.site_id); }
    q += ' ORDER BY d.shelf, d.slot';
    return this.db.prepare(q).all(...params);
  }

  createDevice(data) {
    const r = this.db.prepare(`
      INSERT INTO devices (code, site_id, shelf, slot, brand_id, owner, note)
      VALUES (@code, @site_id, @shelf, @slot, @brand_id, @owner, @note)
    `).run({ code: data.code, site_id: data.site_id || null, shelf: data.shelf || null, slot: data.slot || null, brand_id: data.brand_id || null, owner: data.owner || null, note: data.note || null });
    return this.db.prepare('SELECT * FROM devices WHERE id = ?').get(r.lastInsertRowid);
  }

  updateDevice(id, data) {
    const fields = ['code', 'site_id', 'shelf', 'slot', 'brand_id', 'owner', 'status', 'note'];
    const updates = []; const params = [];
    for (const f of fields) {
      if (data[f] !== undefined) { updates.push(`${f} = ?`); params.push(data[f]); }
    }
    if (!updates.length) return this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    params.push(id);
    this.db.prepare(`UPDATE devices SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    return this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  }

  // ── SIMs ─────────────────────────────────────────────────────────────────
  getSims(filters = {}) {
    let q = `SELECT si.*, a.name AS linked_account_name
      FROM sims si
      LEFT JOIN accounts a ON si.id = (SELECT sim_id FROM accounts WHERE sim_id = si.id LIMIT 1)
      WHERE 1=1`;
    const params = [];
    if (filters.status)  { q += ' AND si.status = ?';  params.push(filters.status); }
    if (filters.telco)   { q += ' AND si.telco = ?';   params.push(filters.telco); }
    if (filters.expiring) { q += " AND si.expiry_date <= date('now', '+7 days') AND si.status NOT IN ('expired','cancelled')"; }
    q += ' ORDER BY si.expiry_date ASC NULLS LAST';
    return this.db.prepare(q).all(...params);
  }

  createSim(data) {
    const r = this.db.prepare(`
      INSERT INTO sims (phone_number, telco, location, balance, expiry_date, status, note)
      VALUES (@phone_number, @telco, @location, @balance, @expiry_date, @status, @note)
    `).run({ phone_number: data.phone_number, telco: data.telco || null, location: data.location || null, balance: data.balance || null, expiry_date: data.expiry_date || null, status: data.status || 'ok', note: data.note || null });
    return this.db.prepare('SELECT * FROM sims WHERE id = ?').get(r.lastInsertRowid);
  }

  updateSim(id, data) {
    const fields = ['phone_number', 'telco', 'location', 'balance', 'expiry_date', 'status', 'last_topped_up', 'note'];
    const updates = []; const params = [];
    for (const f of fields) {
      if (data[f] !== undefined) { updates.push(`${f} = ?`); params.push(data[f]); }
    }
    if (!updates.length) return this.db.prepare('SELECT * FROM sims WHERE id = ?').get(id);
    params.push(id);
    this.db.prepare(`UPDATE sims SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    return this.db.prepare('SELECT * FROM sims WHERE id = ?').get(id);
  }

  // ── Ban Log ──────────────────────────────────────────────────────────────
  getBanLog(accountId) {
    return this.db.prepare('SELECT * FROM ban_log WHERE account_id = ? ORDER BY detected_at DESC').all(accountId);
  }

  recordBan(data) {
    const r = this.db.prepare(`
      INSERT INTO ban_log (account_id, detection_mode, ban_reason, ip_id)
      VALUES (@account_id, @detection_mode, @ban_reason, @ip_id)
    `).run({ account_id: data.account_id, detection_mode: data.detection_mode || 'manual', ban_reason: data.ban_reason || null, ip_id: data.ip_id || null });
    // Auto-transition account to 'recovering'
    this.updateAccount(data.account_id, { status: 'recovering', reason: 'Banned', changed_by: data.changed_by });
    return this.db.prepare('SELECT * FROM ban_log WHERE id = ?').get(r.lastInsertRowid);
  }

  updateBanLog(id, data) {
    const fields = ['recovery_status', 'recovery_note', 'recovery_at', 'ban_reason'];
    const updates = []; const params = [];
    for (const f of fields) {
      if (data[f] !== undefined) { updates.push(`${f} = ?`); params.push(data[f]); }
    }
    if (!updates.length) return;
    params.push(id);
    this.db.prepare(`UPDATE ban_log SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    // If recovery_status = 'success', move account to 'standby'
    const row = this.db.prepare('SELECT * FROM ban_log WHERE id = ?').get(id);
    if (data.recovery_status === 'success') {
      this.updateAccount(row.account_id, { status: 'standby', reason: 'Recovery success', changed_by: data.changed_by });
    } else if (data.recovery_status === 'failed') {
      this.updateAccount(row.account_id, { status: 'dead', reason: 'Recovery failed: ' + (data.recovery_note || ''), changed_by: data.changed_by });
    }
    return row;
  }

  // ── IP Audits ─────────────────────────────────────────────────────────────
  getIpAudits(ipId) {
    return this.db.prepare('SELECT * FROM ip_audits WHERE ip_id = ? ORDER BY audited_at DESC').all(ipId);
  }

  recordIpAudit(data) {
    const r = this.db.prepare(`
      INSERT INTO ip_audits (ip_id, audited_by, result, risk_note, ban_count_at)
      VALUES (@ip_id, @audited_by, @result, @risk_note, @ban_count_at)
    `).run({
      ip_id: data.ip_id, audited_by: data.audited_by || null,
      result: data.result || 'pass', risk_note: data.risk_note || null,
      ban_count_at: data.ban_count_at || 0,
    });
    // If result is 'retire', deactivate the IP
    if (data.result === 'retire') {
      this.db.prepare("UPDATE ips SET active = 0 WHERE id = ?").run(data.ip_id);
    }
    // Bump risk_count if result is 'flag'
    if (data.result === 'flag') {
      this.db.prepare("UPDATE ips SET risk_count = risk_count + 1 WHERE id = ?").run(data.ip_id);
    }
    return this.db.prepare('SELECT * FROM ip_audits WHERE id = ?').get(r.lastInsertRowid);
  }

  getIpAuditSummary() {
    return {
      total_ips: this.db.prepare('SELECT COUNT(*) as n FROM ips').get().n,
      active_ips: this.db.prepare('SELECT COUNT(*) as n FROM ips WHERE active = 1').get().n,
      high_risk: this.db.prepare('SELECT COUNT(*) as n FROM ips WHERE risk_count >= 3').get().n,
      never_audited: this.db.prepare(`SELECT COUNT(*) as n FROM ips WHERE id NOT IN (SELECT DISTINCT ip_id FROM ip_audits)`).get().n,
      flagged_last_30d: this.db.prepare(`SELECT COUNT(*) as n FROM ip_audits WHERE result = 'flag' AND audited_at >= datetime('now', '-30 days')`).get().n,
    };
  }

  getIpsWithAuditStatus() {
    return this.db.prepare(`
      SELECT i.*,
        (SELECT COUNT(*) FROM accounts WHERE ip_id = i.id AND status NOT IN ('dead','standby')) as active_account_count,
        (SELECT COUNT(*) FROM accounts WHERE ip_id = i.id) as total_account_count,
        (SELECT result FROM ip_audits WHERE ip_id = i.id ORDER BY audited_at DESC LIMIT 1) as last_audit_result,
        (SELECT audited_at FROM ip_audits WHERE ip_id = i.id ORDER BY audited_at DESC LIMIT 1) as last_audited_at,
        (SELECT audited_by FROM ip_audits WHERE ip_id = i.id ORDER BY audited_at DESC LIMIT 1) as last_audited_by
      FROM ips i
      ORDER BY i.risk_count DESC, i.created_at DESC
    `).all();
  }

  // ── Work Orders ──────────────────────────────────────────────────────────
  _genRef() {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).slice(2,5).toUpperCase();
    return `WO-${ts}-${rand}`;
  }

  getWorkOrders(filters = {}) {
    let q = `SELECT wo.*, b.name AS brand_name, b.code AS brand_code, s.name AS site_name, a.name AS account_name
      FROM work_orders wo
      LEFT JOIN brands b ON wo.brand_id = b.id
      LEFT JOIN sites s ON wo.site_id = s.id
      LEFT JOIN accounts a ON wo.account_id = a.id
      WHERE 1=1`;
    const params = [];
    if (filters.status)   { q += ' AND wo.status = ?';   params.push(filters.status); }
    if (filters.brand_id) { q += ' AND wo.brand_id = ?'; params.push(filters.brand_id); }
    if (filters.type)     { q += ' AND wo.type = ?';     params.push(filters.type); }
    q += ' ORDER BY wo.created_at DESC';
    if (filters.limit)    { q += ' LIMIT ?';  params.push(filters.limit); }
    return this.db.prepare(q).all(...params);
  }

  getWorkOrder(id) {
    return this.db.prepare(`SELECT wo.*, b.name AS brand_name, s.name AS site_name, a.name AS account_name
      FROM work_orders wo
      LEFT JOIN brands b ON wo.brand_id = b.id
      LEFT JOIN sites s ON wo.site_id = s.id
      LEFT JOIN accounts a ON wo.account_id = a.id
      WHERE wo.id = ?`).get(id);
  }

  createWorkOrder(data) {
    const ref = data.ref || this._genRef();
    const r = this.db.prepare(`
      INSERT INTO work_orders (ref, type, status, priority, brand_id, site_id, quantity, requester, assignee, title, description, account_id, due_date, note)
      VALUES (@ref, @type, @status, @priority, @brand_id, @site_id, @quantity, @requester, @assignee, @title, @description, @account_id, @due_date, @note)
    `).run({
      ref, type: data.type || 'new_account', status: data.status || 'open',
      priority: data.priority || 'normal', brand_id: data.brand_id || null,
      site_id: data.site_id || null, quantity: data.quantity || 1,
      requester: data.requester || null, assignee: data.assignee || null,
      title: data.title || '', description: data.description || null,
      account_id: data.account_id || null, due_date: data.due_date || null,
      note: data.note || null,
    });
    return this.getWorkOrder(r.lastInsertRowid);
  }

  updateWorkOrder(id, data) {
    const fields = ['type','status','priority','brand_id','site_id','quantity','requester','assignee','title','description','account_id','due_date','note'];
    const updates = ['updated_at = datetime(\'now\''+')']; const params = [];
    for (const f of fields) {
      if (data[f] !== undefined) { updates.push(`${f} = ?`); params.push(data[f]); }
    }
    if (data.status === 'done' || data.status === 'cancelled') {
      updates.push("closed_at = datetime('now')");
    }
    params.push(id);
    this.db.prepare(`UPDATE work_orders SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    return this.getWorkOrder(id);
  }

  getWorkOrderCounts() {
    return this.db.prepare("SELECT status, COUNT(*) as count FROM work_orders GROUP BY status").all();
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  getSummary() {
    const counts = this.getAccountCounts();
    const byStatus = {};
    for (const row of counts) byStatus[row.status] = row.count;
    const totalAccounts = counts.reduce((s, r) => s + r.count, 0);
    const ipStats = this.db.prepare('SELECT COUNT(*) as total, SUM(active) as active_count, SUM(in_use) as in_use_count FROM ips').get();
    const simStats = this.db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN expiry_date <= date('now', '+7 days') AND status NOT IN ('expired','cancelled') THEN 1 ELSE 0 END) as expiring_soon FROM sims").get();
    const deviceStats = this.db.prepare("SELECT COUNT(*) as total FROM devices WHERE status = 'active'").get();
    return {
      accounts: { total: totalAccounts, byStatus },
      ips: ipStats,
      sims: simStats,
      devices: deviceStats,
    };
  }
}

module.exports = { AmsStore, ACCOUNT_STATUSES, IP_STATUSES, SIM_STATUSES, DEVICE_STATUSES, getDbPath };
