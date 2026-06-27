const { DisconnectReason } = require('@whiskeysockets/baileys');

const POLICY_KEYWORDS = [
  'ban', 'banned', 'restrict', 'restricted', 'suspended', 'suspend',
  'spam', 'violation', 'policy', 'temporarily unavailable',
  'not authorized', 'forbidden', 'rate limit', 'too many',
  'strict', 'scan', 'compromised', 'unusual activity',
];

function extractErrorText(lastDisconnect) {
  const err = lastDisconnect?.error;
  const statusCode = err?.output?.statusCode ?? err?.statusCode;
  const message = err?.message || '';
  const data = err?.data || err?.output?.payload || {};
  let dataStr = '';
  try {
    dataStr = typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    dataStr = String(data);
  }
  const combined = `${message} ${dataStr}`.toLowerCase();
  return { statusCode, message, dataStr, combined, err };
}

function hasPolicyKeywords(text) {
  const lower = (text || '').toLowerCase();
  return POLICY_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Common WA handshake noise — not a ban/strict-scan signal. */
function isTransientHandshakeMessage(message) {
  return /connection\s*failure|connection\s*closed|connection\s*lost|timed\s*out|econnreset|network|stream\s*errored/i.test(
    message || '',
  );
}

/**
 * Classify disconnect / API errors into user-visible policy alerts.
 * Note: exact "strict scan 6 hours" text is usually shown only on the phone app.
 */
function classifyDisconnect(lastDisconnect) {
  const { statusCode, message, combined } = extractErrorText(lastDisconnect);
  const keywordHit = hasPolicyKeywords(combined);

  if (statusCode === DisconnectReason.forbidden || statusCode === 403) {
    return {
      type: 'BAN_OR_FORBIDDEN',
      severity: 'critical',
      statusCode,
      title: 'Account forbidden (403) — likely ban or restriction',
      detail: message || 'WhatsApp rejected this session (403 forbidden).',
      strictScanPossible: true,
      action: 'Stop automation. Open WhatsApp on phone and check for restrictions or ban notice.',
    };
  }

  if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
    if (isTransientHandshakeMessage(message)) {
      return null;
    }
    return {
      type: 'LOGGED_OUT_OR_RESTRICTED',
      severity: 'warning',
      statusCode,
      title: 'Logged out (401) — session ended by WhatsApp',
      detail: message || 'Session invalidated by WA server.',
      strictScanPossible: false,
      action: 'If linking fails repeatedly, wait a few minutes and try again. Check the phone app for restriction notices.',
    };
  }

  if (statusCode === DisconnectReason.connectionReplaced || statusCode === 440) {
    return {
      type: 'SESSION_REPLACED',
      severity: 'warning',
      statusCode,
      title: 'Session opened elsewhere (440)',
      detail: message || 'Another device or login replaced this session.',
      strictScanPossible: false,
      action: 'Use only one linked device for this account.',
    };
  }

  if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
    return {
      type: 'RESTART_REQUIRED',
      severity: 'warning',
      statusCode,
      title: 'Restart required (515)',
      detail: message || 'WhatsApp wants a fresh connection.',
      strictScanPossible: false,
      action: 'Restart script; if repeated, reduce automation and check phone.',
    };
  }

  if (statusCode === DisconnectReason.connectionClosed || statusCode === 428) {
    return {
      type: 'CONNECTION_CLOSED',
      severity: 'warning',
      statusCode,
      title: 'Connection closed (428)',
      detail: message || 'Server closed connection — can be rate limit or policy.',
      strictScanPossible: keywordHit,
      action: keywordHit
        ? 'Possible temporary limit — wait several hours; check phone app.'
        : 'May reconnect; if repeated, slow down messaging.',
    };
  }

  if (keywordHit) {
    return {
      type: 'POLICY_KEYWORD',
      severity: 'critical',
      statusCode,
      title: 'Policy / restriction keyword detected',
      detail: message || combined.slice(0, 200),
      strictScanPossible: true,
      action: 'Confirm on phone WhatsApp — look for strict scan or temporary ban.',
    };
  }

  return null;
}

function classifySendError(error) {
  const statusCode = error?.output?.statusCode ?? error?.status;
  const message = error?.message || '';
  const combined = `${message} ${JSON.stringify(error?.data || {})}`.toLowerCase();

  if (statusCode === 403 || statusCode === DisconnectReason.forbidden) {
    return {
      type: 'SEND_FORBIDDEN',
      severity: 'critical',
      statusCode,
      title: 'Cannot send — forbidden (403)',
      detail: message,
      strictScanPossible: true,
      action: 'Account may be restricted or banned. Check phone app immediately.',
    };
  }

  if (statusCode === 428 || /rate|limit|too many|slow down|blocked/.test(combined)) {
    return {
      type: 'SEND_RATE_LIMIT',
      severity: 'critical',
      statusCode,
      title: 'Send blocked — possible rate / strict limit',
      detail: message,
      strictScanPossible: true,
      action: 'Stop sending. Wait (often hours). Confirm "strict" notice on phone.',
    };
  }

  if (hasPolicyKeywords(combined)) {
    return {
      type: 'SEND_POLICY',
      severity: 'critical',
      statusCode,
      title: 'Send failed — policy signal',
      detail: message,
      strictScanPossible: true,
      action: 'Check WhatsApp on phone for restriction messages.',
    };
  }

  return null;
}

function formatPolicyAlert(sessionName, alert) {
  const lines = [
    '',
    '='.repeat(52),
    `[WA ALERT] ${sessionName}`,
    `  ${alert.title}`,
    `  Type   : ${alert.type}`,
    alert.statusCode != null ? `  Code   : ${alert.statusCode}` : null,
    `  Detail : ${alert.detail}`,
  ].filter(Boolean);

  if (alert.strictScanPossible) {
    lines.push('  Likely : temporary strict limit / ban (confirm on phone — e.g. "strict scan ~6h")');
  }
  lines.push(`  Action : ${alert.action}`);
  lines.push('='.repeat(52));
  lines.push('');
  return lines.join('\n');
}

/** True when WA likely enforced strict scan / ban — local session should be purged. */
function isStrictLogoutAlert(alert) {
  if (!alert) return false;
  if (alert.strictScanPossible) return true;
  const strictTypes = new Set([
    'BAN_OR_FORBIDDEN',
    'LOGGED_OUT_OR_RESTRICTED',
    'POLICY_KEYWORD',
    'SEND_FORBIDDEN',
    'SEND_RATE_LIMIT',
    'SEND_POLICY',
  ]);
  return strictTypes.has(alert.type);
}

module.exports = {
  classifyDisconnect,
  classifySendError,
  formatPolicyAlert,
  isStrictLogoutAlert,
  isTransientHandshakeMessage,
};
