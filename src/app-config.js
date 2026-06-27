require('dotenv').config();

function getPairCount() {
  return Math.max(1, parseInt(process.env.PAIR_COUNT || '1', 10));
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
