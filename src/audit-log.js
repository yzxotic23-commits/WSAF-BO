const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FEEDING_STATUS = {
  ACTIVE: 'Active',
  SUCCESS: 'Success',
  RESTRICT: 'Restrict',
  BANNED: 'Banned',
};

const CSV_COLUMNS = [
  'Date / Time',
  'Location',
  'Account name',
  'Feeding Days',
  'Feeding status',
  'IP address',
];

/** Location not configured yet — show dash instead of "Pending". */
function formatAuditLocation(location) {
  if (!location || location === 'Pending') return '-';
  return location;
}

function extractIpAddress(proxyUrl) {
  if (!proxyUrl || proxyUrl === 'direct') return 'direct';
  try {
    const u = new URL(proxyUrl);
    const port = u.port ? `:${u.port}` : '';
    return `${u.hostname}${port}`;
  } catch {
    return String(proxyUrl);
  }
}

function feedingDaysLabel(dayCount) {
  if (dayCount <= 1) return 'D1';
  if (dayCount === 2) return 'D2';
  return 'more than D2';
}

function mapPolicyTypeToStatus(policyType) {
  const t = String(policyType || '').toUpperCase();
  if (
    t.includes('BAN')
    || t.includes('FORBIDDEN')
    || t.includes('SEND_FORBIDDEN')
    || t.includes('SEND_RATE')
    || t.includes('SEND_POLICY')
    || t.includes('POLICY_KEYWORD')
  ) {
    return FEEDING_STATUS.BANNED;
  }
  if (t.includes('RESTRICT') || t.includes('LOGGED_OUT')) {
    return FEEDING_STATUS.RESTRICT;
  }
  return FEEDING_STATUS.RESTRICT;
}

function reasonToStatus(reason, completed = false) {
  if (completed) return FEEDING_STATUS.SUCCESS;
  const r = String(reason || '').toLowerCase();
  if (/feeding_started|feeding_active|session_started|account_linked/.test(r)) {
    return FEEDING_STATUS.ACTIVE;
  }
  if (
    /ban|forbidden|403|send_forbidden|send_rate|send_policy|policy_keyword/.test(r)
  ) {
    return FEEDING_STATUS.BANNED;
  }
  if (/logged out|401|restrict|strict|unavailable|send failed|policy/.test(r)) {
    return FEEDING_STATUS.RESTRICT;
  }
  if (/completed|done|finished/.test(r)) {
    return FEEDING_STATUS.SUCCESS;
  }
  return FEEDING_STATUS.RESTRICT;
}

function formatDateTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-GB', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return iso;
  }
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

class AuditLogStore {
  constructor(appRoot) {
    this.appRoot = appRoot || process.cwd();
    this.dataDir = path.join(this.appRoot, 'data');
    this.logPath = path.join(this.dataDir, 'audit-log.jsonl');
    this.metaPath = path.join(this.dataDir, 'audit-meta.json');
    this.entries = [];
    this.meta = { accounts: {} };
    this.ensureDirs();
    this.load();
  }

  ensureDirs() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  load() {
    this.entries = [];
    if (fs.existsSync(this.logPath)) {
      const raw = fs.readFileSync(this.logPath, 'utf8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          this.entries.push(JSON.parse(t));
        } catch {
          /* skip corrupt line */
        }
      }
    }
    if (fs.existsSync(this.metaPath)) {
      try {
        this.meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
      } catch {
        this.meta = { accounts: {} };
      }
    }
    if (!this.meta.accounts) this.meta.accounts = {};
  }

  persistEntry(entry) {
    fs.appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  persistMeta() {
    fs.writeFileSync(this.metaPath, JSON.stringify(this.meta, null, 2), 'utf8');
  }

  accountKey(sessionName, slot) {
    return sessionName || `slot_${slot}`;
  }

  bumpFeedingDay(key, dateIso) {
    const day = dateIso.slice(0, 10);
    const acc = this.meta.accounts[key] || { dates: [] };
    if (!acc.dates.includes(day)) {
      acc.dates.push(day);
      acc.dates.sort();
    }
    this.meta.accounts[key] = acc;
    this.persistMeta();
    return feedingDaysLabel(acc.dates.length);
  }

  createRun() {
    const runId = `run-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    return runId;
  }

  statusRank(status) {
    if (status === FEEDING_STATUS.BANNED) return 4;
    if (status === FEEDING_STATUS.RESTRICT) return 3;
    if (status === FEEDING_STATUS.ACTIVE) return 2;
    return 1;
  }

  findRunSlot(runId, slot) {
    if (runId == null || slot == null) return null;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.runId === runId && e.slot === slot) return e;
    }
    return null;
  }

  /** Stable AMS-linked row per slot (not tied to a feeding run). */
  upsertLinkedSlot({
    slot = null,
    sessionName = null,
    accountName = null,
    location = null,
    proxyUrl = null,
    ipAddress = null,
    feedingStatus = FEEDING_STATUS.ACTIVE,
    reason = 'account_linked',
  }) {
    const LINK_RUN = 'ams-linked';
    const existing = this.findRunSlot(LINK_RUN, slot);
    const ip = ipAddress || extractIpAddress(proxyUrl);

    if (existing) {
      if (accountName) existing.accountName = accountName;
      if (location) existing.location = formatAuditLocation(location);
      if (ip) existing.ipAddress = ip;
      if (
        feedingStatus
        && this.statusRank(feedingStatus) >= this.statusRank(existing.feedingStatus)
      ) {
        existing.feedingStatus = feedingStatus;
      }
      existing.reason = reason || existing.reason;
      existing.sessionName = sessionName || existing.sessionName;
      existing.ts = new Date().toISOString();
      existing.dateTime = formatDateTime(existing.ts);
      this.rewriteLog();
      return existing;
    }

    return this.record({
      runId: LINK_RUN,
      slot,
      sessionName,
      accountName,
      location,
      feedingStatus,
      reason,
      proxyUrl,
      ipAddress: ip,
    });
  }

  recordOrUpdate(payload) {
    const existing = this.findRunSlot(payload.runId, payload.slot);
    if (!existing) return this.record(payload);

    const completed =
      payload.feedingStatus === FEEDING_STATUS.SUCCESS
      || String(payload.reason || '').toLowerCase().includes('completed');

    let nextStatus = payload.policyType
      ? mapPolicyTypeToStatus(payload.policyType)
      : reasonToStatus(payload.reason, completed);

    if (
      completed
      && existing.feedingStatus !== FEEDING_STATUS.BANNED
      && this.statusRank(nextStatus) < this.statusRank(existing.feedingStatus)
    ) {
      nextStatus = FEEDING_STATUS.SUCCESS;
    }

    if (this.statusRank(nextStatus) <= this.statusRank(existing.feedingStatus)) {
      const completingActive = (
        nextStatus === FEEDING_STATUS.SUCCESS
        && existing.feedingStatus === FEEDING_STATUS.ACTIVE
      );
      if (!completingActive) return existing;
    }

    existing.feedingStatus = nextStatus;
    existing.reason = payload.reason || existing.reason;
    existing.policyType = payload.policyType || existing.policyType;
    existing.ts = new Date().toISOString();
    existing.dateTime = formatDateTime(existing.ts);
    this.rewriteLog();
    return existing;
  }

  rewriteLog() {
    const lines = this.entries.map((e) => JSON.stringify(e)).join('\n');
    fs.writeFileSync(this.logPath, lines ? `${lines}\n` : '', 'utf8');
  }

  record({
    runId = null,
    slot = null,
    sessionName = null,
    accountName = null,
    feedingStatus = FEEDING_STATUS.SUCCESS,
    reason = null,
    policyType = null,
    proxyUrl = null,
    ipAddress: explicitIp = null,
    location = null,
    pairIndex = null,
    messageCount = null,
  }) {
    const ts = new Date().toISOString();
    const key = this.accountKey(sessionName, slot);
    const feedingDays = this.bumpFeedingDay(key, ts);

    let status = feedingStatus;
    if (policyType) {
      status = mapPolicyTypeToStatus(policyType);
    } else if (reason && feedingStatus === FEEDING_STATUS.SUCCESS) {
      status = reasonToStatus(reason, true);
    }

    const entry = {
      id: crypto.randomUUID(),
      runId,
      ts,
      dateTime: formatDateTime(ts),
      location: formatAuditLocation(location),
      accountName: accountName || sessionName || `Account ${(slot ?? 0) + 1}`,
      slot,
      sessionName,
      feedingDays,
      feedingStatus: status,
      ipAddress: explicitIp || extractIpAddress(proxyUrl),
      proxyMasked: proxyUrl && proxyUrl !== 'direct' ? proxyUrl : null,
      reason: reason || null,
      policyType: policyType || null,
      pairIndex,
      messageCount,
    };

    this.entries.push(entry);
    this.persistEntry(entry);
    return entry;
  }

  list({ limit = 500, offset = 0 } = {}) {
    const slice = this.entries.slice().reverse();
    const page = slice.slice(offset, offset + limit).map((e) => ({
      ...e,
      location: formatAuditLocation(e.location),
    }));
    return {
      total: slice.length,
      entries: page,
    };
  }

  computeSummary(entries = this.entries) {
    const total = entries.length;
    const count = (status) => entries.filter((e) => e.feedingStatus === status).length;
    const banned = count(FEEDING_STATUS.BANNED);
    const restrict = count(FEEDING_STATUS.RESTRICT);
    const success = count(FEEDING_STATUS.SUCCESS);

    const ipMap = new Map();
    for (const e of entries) {
      const ip = e.ipAddress || 'direct';
      if (!ipMap.has(ip)) {
        ipMap.set(ip, { total: 0, banned: 0, restrict: 0, success: 0 });
      }
      const row = ipMap.get(ip);
      row.total += 1;
      if (e.feedingStatus === FEEDING_STATUS.BANNED) row.banned += 1;
      else if (e.feedingStatus === FEEDING_STATUS.RESTRICT) row.restrict += 1;
      else row.success += 1;
    }

    const ipBanned = [...ipMap.values()].filter((r) => r.banned > 0).length;
    const ipBannedEvents = [...ipMap.entries()]
      .filter(([, r]) => r.banned > 0)
      .reduce((sum, [, r]) => sum + r.banned, 0);

    const pct = (n) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

    return {
      totalFeedingVolume: total,
      bannedVolume: banned,
      bannedRate: pct(banned),
      restrictVolume: restrict,
      restrictRate: pct(restrict),
      successVolume: success,
      successRate: pct(success),
      ipBannedVolume: ipBannedEvents,
      ipBannedRate: pct(ipBannedEvents),
      uniqueIpsWithBan: ipBanned,
      byIp: [...ipMap.entries()].map(([ip, stats]) => ({
        ip,
        ...stats,
        bannedRate: pct(stats.banned),
      })),
    };
  }

  exportCsv() {
    const lines = [CSV_COLUMNS.join(',')];
    for (const e of this.entries) {
      lines.push(
        [
          csvEscape(e.dateTime || formatDateTime(e.ts)),
          csvEscape(formatAuditLocation(e.location)),
          csvEscape(e.accountName),
          csvEscape(e.feedingDays),
          csvEscape(e.feedingStatus),
          csvEscape(e.ipAddress),
        ].join(',')
      );
    }
    const summary = this.computeSummary();
    lines.push('');
    lines.push('Summary');
    lines.push(`${csvEscape('Total feeding volume')},${summary.totalFeedingVolume}`);
    lines.push(`${csvEscape('Banned volume')},${summary.bannedVolume}`);
    lines.push(`${csvEscape('Banned rate (%)')},${summary.bannedRate}`);
    lines.push(`${csvEscape('Restrict volume')},${summary.restrictVolume}`);
    lines.push(`${csvEscape('Restrict rate (%)')},${summary.restrictRate}`);
    lines.push(`${csvEscape('Success volume')},${summary.successVolume}`);
    lines.push(`${csvEscape('Success rate (%)')},${summary.successRate}`);
    lines.push(`${csvEscape('IP banned volume')},${summary.ipBannedVolume}`);
    lines.push(`${csvEscape('IP banned rate (%)')},${summary.ipBannedRate}`);

    return `\uFEFF${lines.join('\r\n')}`;
  }
}

module.exports = {
  AuditLogStore,
  FEEDING_STATUS,
  extractIpAddress,
  feedingDaysLabel,
  reasonToStatus,
  mapPolicyTypeToStatus,
};
