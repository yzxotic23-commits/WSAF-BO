require('dotenv').config();

function getPairCount() {
  return Math.max(1, parseInt(process.env.PAIR_COUNT || '1', 10));
}

/**
 * Ceiling for add-pair (accounts = pairs × 2).
 * MAX_PAIRS=0 / unlimited / none → no practical limit (add pairs freely).
 * Otherwise a positive integer cap.
 */
function getMaxPairs() {
  const raw = String(process.env.MAX_PAIRS ?? '0').trim().toLowerCase();
  if (
    !raw
    || raw === '0'
    || raw === 'unlimited'
    || raw === 'none'
    || raw === 'inf'
    || raw === 'infinity'
  ) {
    return Number.MAX_SAFE_INTEGER;
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return Number.MAX_SAFE_INTEGER;
  return n;
}

function isMaxPairsUnlimited() {
  return getMaxPairs() >= Number.MAX_SAFE_INTEGER;
}

function getAccountStart() {
  return Math.max(1, parseInt(process.env.ACCOUNT_START || '1', 10));
}

function getAccountCount() {
  return getPairCount() * 2;
}

function getAccountName(slotIndex) {
  return `account${getAccountStart() + slotIndex}`;
}

function getAccountLabel(slotIndex) {
  return `Account${getAccountStart() + slotIndex}`;
}

module.exports = {
  getPairCount,
  getMaxPairs,
  isMaxPairsUnlimited,
  getAccountStart,
  getAccountCount,
  getAccountEnd: () => getAccountStart() + getAccountCount() - 1,
  getAccountName,
  getAccountLabel,
  getMinDelayMs: () => parseInt(process.env.MIN_DELAY || '30', 10) * 1000,
  getMaxDelayMs: () => parseInt(process.env.MAX_DELAY || '90', 10) * 1000,
  getMaxMessages: () => parseInt(process.env.MAX_MESSAGES || '20', 10),
  // Legacy aliases (evaluated at require time — prefer getters in new code)
  get PAIR_COUNT() {
    return getPairCount();
  },
  get MAX_PAIRS() {
    return getMaxPairs();
  },
  get ACCOUNT_COUNT() {
    return getAccountCount();
  },
  get ACCOUNT_START() {
    return getAccountStart();
  },
  MIN_DELAY: parseInt(process.env.MIN_DELAY || '30', 10) * 1000,
  MAX_DELAY: parseInt(process.env.MAX_DELAY || '90', 10) * 1000,
  MAX_MESSAGES: parseInt(process.env.MAX_MESSAGES || '20', 10),
};
