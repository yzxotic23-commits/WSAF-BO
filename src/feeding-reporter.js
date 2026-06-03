/**
 * Kirim pesan feeding ke desktop UI (bukan hanya terminal).
 */
function getApiBase() {
  const port = process.env.DESKTOP_API_PORT || '47821';
  return `http://127.0.0.1:${port}`;
}

async function reportFeedingChat(fromLabel, toLabel, text, kind = 'message') {
  if (process.env.DESKTOP_FEEDING !== '1') return;
  const body = JSON.stringify({
    fromLabel: String(fromLabel || ''),
    toLabel: String(toLabel || ''),
    text: String(text || ''),
    kind,
  });
  try {
    await fetch(`${getApiBase()}/api/feeding/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch {
    /* desktop API may be busy */
  }
}

async function reportAuditEntry(entry) {
  if (process.env.DESKTOP_FEEDING !== '1') return null;
  try {
    const res = await fetch(`${getApiBase()}/api/audit/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
    return res.json().catch(() => ({}));
  } catch {
    return null;
  }
}

async function reportFeedingPairResults(results, sessions, accountProxies) {
  if (process.env.DESKTOP_FEEDING !== '1' || !Array.isArray(results)) return;
  const runId = process.env.FEEDING_RUN_ID || null;

  for (const r of results) {
    const pairIndex = (r.pairNum || 1) - 1;
    const slotA = pairIndex * 2;
    const slotB = slotA + 1;
    const completed = r.status === 'completed';
    const reason = r.reason || (completed ? 'completed' : 'stopped');

    for (const slot of [slotA, slotB]) {
      const session = sessions[slot];
      if (!session) continue;
      const accountName =
        session.getDisplayName?.() || getAccountLabelFromSlot(slot);
      await reportAuditEntry({
        runId,
        slot,
        sessionName: session.sessionName,
        accountName,
        feedingStatus: completed ? 'Success' : undefined,
        reason,
        proxyUrl: session.proxyUrl || accountProxies[slot] || null,
        pairIndex,
      });
    }
  }
}

function getAccountLabelFromSlot(slot) {
  try {
    const { getAccountStart } = require('./app-config');
    return `Account${getAccountStart() + slot}`;
  } catch {
    return `Account${slot + 1}`;
  }
}

async function reportProfileRefresh() {
  if (process.env.DESKTOP_FEEDING !== '1') return null;
  try {
    const res = await fetch(`${getApiBase()}/api/profile/refresh`, { method: 'POST' });
    return res.json().catch(() => ({}));
  } catch {
    return null;
  }
}

async function reportFeedingComplete(summary) {
  if (process.env.DESKTOP_FEEDING !== '1') return null;
  try {
    const res = await fetch(`${getApiBase()}/api/feeding/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(summary || {}),
    });
    return res.json().catch(() => ({}));
  } catch {
    return null;
  }
}

async function reportStrictLogout(slot, alert) {
  if (process.env.DESKTOP_FEEDING !== '1') return null;
  try {
    const res = await fetch(`${getApiBase()}/api/sessions/strict-logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot, alert }),
    });
    return res.json().catch(() => ({}));
  } catch {
    return null;
  }
}

module.exports = {
  reportFeedingChat,
  reportAuditEntry,
  reportFeedingPairResults,
  reportProfileRefresh,
  reportFeedingComplete,
  reportStrictLogout,
};
