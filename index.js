const path = require('path');
const { ensureAppRoot, getAppRoot } = require('./src/app-root');
ensureAppRoot();
require('./src/silence-deprecation-warnings');
require('dotenv').config({ path: path.join(getAppRoot(), '.env') });
require('./src/silence-libsignal-logs');
if (process.env.AI_SDK_LOG_WARNINGS === undefined) {
  process.env.AI_SDK_LOG_WARNINGS = 'false';
}
const readline = require('readline');
const fs = require('fs');
const WhatsAppSession = require('./src/whatsapp-session');
const AIProvider = require('./src/ai-provider');
const ProxyManager = require('./src/proxy-manager');
const {
  reportFeedingChat,
  reportFeedingPairResults,
  reportFeedingSessionStart,
  reportAuditEntry,
  reportFeedingComplete,
  reportProfileRefresh,
  reportStrictLogout,
} = require('./src/feeding-reporter');
const { readSlotDisplayLabel } = require('./src/slot-display-labels');
const { isStrictLogoutAlert } = require('./src/wa-policy-detector');

const MIN_DELAY = parseInt(process.env.MIN_DELAY || '30') * 1000;
const MAX_DELAY = parseInt(process.env.MAX_DELAY || '90') * 1000;
const MAX_MESSAGES = parseInt(process.env.MAX_MESSAGES || '20');
const FIRST_MSG_DELAY = 5000;
const PAIR_IDLE_TIMEOUT_MS = parseInt(process.env.PAIR_IDLE_TIMEOUT || '600', 10) * 1000;
const PAIR_NUDGE_AFTER_MS = parseInt(process.env.PAIR_NUDGE_AFTER || '90', 10) * 1000;
const PAIR_MAX_NUDGES = Math.max(0, parseInt(process.env.PAIR_MAX_NUDGES || '3', 10));
const PAIR_STOP_ON_IDLE = process.env.PAIR_STOP_ON_IDLE === 'true';
const ECHO_IGNORE_MS = parseInt(process.env.ECHO_IGNORE_MS || '60000', 10);
const DEBUG_MESSAGES = process.env.DEBUG_MESSAGES === 'true';
const {
  getPairCount,
  getAccountStart,
  getAccountCount,
  getAccountEnd,
} = require('./src/app-config');

function pairCount() {
  return getPairCount();
}
function accountCount() {
  return getAccountCount();
}
function accountStart() {
  return getAccountStart();
}
function accountEnd() {
  return getAccountEnd();
}

function getAccountName(slotIndex) {
  return `account${accountStart() + slotIndex}`;
}

function sessionSlotIndex(session) {
  const num = parseInt(String(session?.sessionName || '').replace(/\D/g, ''), 10);
  if (!Number.isFinite(num)) return null;
  return num - accountStart();
}

function getAccountLabel(slotIndex) {
  return `Account${accountStart() + slotIndex}`;
}

function resolveSessionLabel(session, slotIndex) {
  const fromWa = session?.getDisplayName?.() || session?.syncProfileNameFromDisk?.() || null;
  if (fromWa) return fromWa;
  const fromAms = readSlotDisplayLabel(getAppRoot(), slotIndex);
  if (fromAms) return fromAms;
  return getAccountLabel(slotIndex);
}

function attachSessionLabelSync(session, slotIndex, labels, key) {
  session.on('profileName', ({ profileName }) => {
    if (!profileName) return;
    labels[key] = profileName;
    reportProfileRefresh().catch(() => {});
  });
}

/**
 * Resolve phone number for an account — priority order:
 * 1. creds.json (account was connected before)
 * 2. auth/_login-prefs.json (pairing code was used before)
 * 3. null (unknown — will prompt user)
 */
function getAccountPhone(slotIndex) {
  const sessionName = getAccountName(slotIndex);

  // 1. From creds.json if previously connected
  try {
    const probe = new WhatsAppSession(sessionName);
    const auth = probe.getAuthStatus();
    if (auth.phone) return auth.phone;
  } catch { /* skip */ }

  // 2. From saved login prefs
  try {
    const prefs = readLoginPrefs();
    const saved = prefs[sessionName];
    if (saved?.phoneNumber) return saved.phoneNumber.replace(/[^0-9]/g, '');
  } catch { /* skip */ }

  return null;
}

/** Ask for phone number once, save to prefs so it auto-detects on next restart. */
async function askAndSavePhone(sessionName) {
  console.log('');
  console.log(`[PAIRING] Enter phone number for ${sessionName} (country code + number, e.g. 628123456789):`);
  const input = await ask('Phone number: ');
  const phone = (input || '').trim().replace(/[^0-9]/g, '');
  if (phone.length < 8) {
    console.log('[WARN] Number too short — skipped.');
    return null;
  }
  saveLoginPref(sessionName, { method: 'pairing', phoneNumber: phone });
  console.log(`[OK] Phone ${phone} saved — will be reused automatically on restart.`);
  return phone;
}

let totalMessagesSent = 0;
let activeSessions = [];
let isShuttingDown = false;

class PairChatController {
  constructor() {
    this.pairs = new Map();
  }

  registerPair(pairNum, resolve, sessionA, sessionB) {
    this.pairs.set(pairNum, {
      pairNum,
      stopped: false,
      resolve,
      sessionA,
      sessionB,
    });
  }

  isPairStopped(pairNum) {
    return this.pairs.get(pairNum)?.stopped ?? false;
  }

  stopPair(pairNum, reason) {
    const pair = this.pairs.get(pairNum);
    if (!pair || pair.stopped) return;

    pair.stopped = true;
    pair.sessionA.removeAllListeners('message');
    pair.sessionB.removeAllListeners('message');
    pair.resolve({ status: 'stopped', reason });
  }

  clear() {
    this.pairs.clear();
  }
}

function isPartnerAvailable(session) {
  return session.isConnected && !session.isLoggedOut;
}

function randomDelay() {
  const base = Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY)) + MIN_DELAY;
  if (totalMessagesSent < 4) {
    return base + Math.floor(Math.random() * 15000);
  }
  return base;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(pairNum, message) {
  console.log(`[Pair ${pairNum}] ${message}`);
}

function msgCount(n) {
  return `[${n}/${MAX_MESSAGES}]`;
}

/** Collapse whitespace/newlines so each log line stays on one terminal row. */
function oneLine(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function logOut(pairNum, from, to, text, count, suffix = '', slots = {}) {
  if (process.env.DESKTOP_FEEDING === '1') {
    reportFeedingChat(from, to, oneLine(text), 'message', slots);
    return;
  }
  const extra = suffix ? ` ${suffix}` : '';
  log(pairNum, `${from} → ${to}: ${oneLine(text)} ${msgCount(count)}${extra}`);
}

function logNudge(pairNum, from, to, text, nudgeNum, slots = {}) {
  if (process.env.DESKTOP_FEEDING === '1') {
    reportFeedingChat(from, to, oneLine(text), 'nudge', slots);
    return;
  }
  log(pairNum, `${from} → ${to}: ${oneLine(text)} (nudge ${nudgeNum}/${PAIR_MAX_NUDGES})`);
}

function logTyping(pairNum, who, sec, slots = {}) {
  if (process.env.DESKTOP_FEEDING === '1') {
    reportFeedingChat(who, '', `typing… ${sec}s`, 'typing', slots);
    return;
  }
  log(pairNum, `${who} typing... ${sec}s`);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const LOGIN_PREFS_PATH = path.join(getAppRoot(), 'auth', '_login-prefs.json');

function isDesktopFeeding() {
  return process.env.DESKTOP_FEEDING === '1' || !process.stdin.isTTY;
}

/** 0-based pair index when desktop starts one pair only; null = all pairs. */
function getFeedingPairIndex() {
  const raw = process.env.FEEDING_PAIR_INDEX;
  if (raw === undefined || raw === '') return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function getPairsToRun() {
  const single = getFeedingPairIndex();
  if (single !== null) {
    if (single >= pairCount()) {
      throw new Error(`Invalid FEEDING_PAIR_INDEX=${single} (only ${pairCount()} pair(s) configured)`);
    }
    return [single];
  }
  return Array.from({ length: pairCount() }, (_, p) => p);
}

function getFeedingSlotIndices() {
  const single = getFeedingPairIndex();
  if (single === null) return null;
  return [single * 2, single * 2 + 1];
}

/** Push profile name updates to desktop sidebar while CLI feeding runs. */
function attachDesktopProfileSync(session) {
  if (!isDesktopFeeding()) return;
  session.on('profileName', () => {
    reportProfileRefresh().catch(() => {});
  });
}

function readLoginPrefs() {
  if (!fs.existsSync(LOGIN_PREFS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(LOGIN_PREFS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveLoginPref(sessionName, loginOptions) {
  const prefs = readLoginPrefs();
  prefs[sessionName] = {
    method: loginOptions.method,
    phoneNumber: loginOptions.phoneNumber || null,
  };
  fs.mkdirSync(path.dirname(LOGIN_PREFS_PATH), { recursive: true });
  fs.writeFileSync(LOGIN_PREFS_PATH, JSON.stringify(prefs, null, 2));
}

function clearLoginPrefs() {
  if (fs.existsSync(LOGIN_PREFS_PATH)) {
    fs.unlinkSync(LOGIN_PREFS_PATH);
  }
}

async function askLoginMethodChoice(title) {
  console.log('');
  console.log('='.repeat(50));
  console.log(title);
  console.log('='.repeat(50));
  console.log('');
  console.log('  1. QR scan (show QR in terminal)');
  console.log('  2. Phone number + pairing code (8-digit code on phone)');
  console.log('');

  const choice = await ask('Choose login method (1-2): ');
  return choice === '2' ? 'pairing' : 'qr';
}

async function askPairingPhone(sessionName) {
  console.log('');
  console.log(`Phone for ${sessionName} — country code + number, digits only`);
  console.log('Example: 60123456789 (MY) | 8613800138000 (CN)');
  const phone = await ask('Enter phone number: ');
  const phoneNumber = phone.replace(/\D/g, '');
  if (phoneNumber.length < 8) {
    console.log('[WARN] Number too short — using QR scan instead.');
    return null;
  }
  return phoneNumber;
}

async function resolveLoginOptions(sessionName, prefs, defaultMethod) {
  const saved = prefs[sessionName];
  if (saved?.method === 'pairing' && saved.phoneNumber) {
    console.log(`[LOGIN] ${sessionName}: reuse pairing (${saved.phoneNumber})`);
    return { method: 'pairing', phoneNumber: saved.phoneNumber };
  }
  if (saved?.method === 'qr' && defaultMethod !== 'pairing') {
    console.log(`[LOGIN] ${sessionName}: reuse QR preference`);
    return { method: 'qr' };
  }

  let method = defaultMethod;
  if (!method) {
    method = await askLoginMethodChoice(`LOGIN — ${sessionName}`);
  }

  if (method === 'pairing') {
    const phoneNumber = await askPairingPhone(sessionName);
    if (!phoneNumber) {
      return { method: 'qr' };
    }
    const options = { method: 'pairing', phoneNumber };
    saveLoginPref(sessionName, options);
    return options;
  }

  const options = { method: 'qr' };
  saveLoginPref(sessionName, options);
  return options;
}

/**
 * Build login plan per account: skip prompt when valid session exists.
 * @param {{ onlySlots?: number[] }} options — desktop per-pair feeding checks only those slots
 */
async function prepareLoginPlans(options = {}) {
  const plans = new Map();
  const needLink = [];
  const prefs = readLoginPrefs();
  const slotIndices = options.onlySlots || Array.from({ length: accountCount() }, (_, i) => i);

  for (const i of slotIndices) {
    const name = getAccountName(i);
    const probe = new WhatsAppSession(name);
    const auth = probe.getAuthStatus();

    if (auth.valid && auth.registered) {
      plans.set(name, { skipLogin: true, auth });
    } else {
      if (auth.saved && !auth.valid) {
        probe.deleteAuthFolder();
        console.log(`[LOGIN] ${name}: removed invalid auth — will ask login`);
      }
      let reason = !auth.saved ? 'no auth folder' : 'invalid session cleared';
      if (auth.saved && auth.valid && !auth.registered) {
        reason = 'session not registered — finish linking in desktop app';
      }
      needLink.push({ name, reason });
    }
  }

  if (needLink.length === 0) {
    console.log('');
    console.log('[LOGIN] All accounts have valid saved sessions — no login prompts.');
    return plans;
  }

  if (isDesktopFeeding()) {
    console.log('');
    console.log(`[LOGIN] ${needLink.length} account(s) not linked. Use the desktop app first:`);
    console.log(`  Auth folder: ${path.join(getAppRoot(), 'auth')}`);
    for (const { name, reason } of needLink) {
      console.log(`  - ${name} (${reason})`);
    }
    console.log('[LOGIN] Link each account from the desktop app sidebar, then click Start feeding.');
    process.exit(1);
  }

  console.log('');
  console.log(`[LOGIN] ${needLink.length} account(s) need linking:`);
  for (const { name, reason } of needLink) {
    console.log(`  - ${name} (${reason})`);
  }

  let defaultMethod = null;
  if (needLink.length > 1) {
    defaultMethod = await askLoginMethodChoice(
      `LOGIN — default for ${needLink.length} new account(s)`
    );
    console.log(`[LOGIN] Default method: ${defaultMethod === 'pairing' ? 'pairing code' : 'QR scan'}`);
  }

  for (const { name } of needLink) {
    const options = await resolveLoginOptions(name, prefs, needLink.length > 1 ? defaultMethod : null);
    plans.set(name, options);
  }

  return plans;
}

async function selectLanguage() {
  if (isDesktopFeeding()) {
    const selected = process.env.LANGUAGE || 'English';
    console.log(`[OK] Language: ${selected} (from .env / desktop feeding)`);
    return selected;
  }

  console.log('');
  console.log('='.repeat(50));
  console.log('SELECT LANGUAGE FOR THIS SESSION');
  console.log('='.repeat(50));
  console.log('');
  console.log('  1. Indonesia');
  console.log('  2. English');
  console.log('  3. Melayu');
  console.log('  4. Chinese (Simplified)');
  console.log('');

  const choice = await ask('Choose language (1-4): ');

  const languages = { '1': 'Indonesia', '2': 'English', '3': 'Melayu', '4': 'Chinese' };
  const selected = languages[choice] || 'Indonesia';
  console.log(`[OK] Language set to: ${selected}`);
  return selected;
}

async function askPostFeedingAction() {
  if (isDesktopFeeding()) return 'exit';

  console.log('');
  console.log('='.repeat(50));
  console.log('FEEDING DONE — NEXT STEP');
  console.log('='.repeat(50));
  console.log('');
  console.log('  1. Continue (keep session, no QR)');
  console.log('  2. New session (logout all + link again)');
  console.log('  3. Exit');
  console.log('');

  const choice = await ask('Choose (1-3): ');

  if (choice === '2') return 'new';
  if (choice === '3') return 'exit';
  return 'continue';
}

async function resetAllSessionsNew(sessions, hasProxies, proxyManager, accountProxies) {
  console.log('');
  console.log('='.repeat(50));
  console.log('NEW SESSION — Logout & clear all auth');
  console.log('='.repeat(50));

  for (const session of sessions) {
    await session.logoutAndClear();
  }

  clearLoginPrefs();
  await sleep(3000);

  console.log('');
  console.log('Reconnecting all accounts (QR or pairing code if needed)...');
  console.log('');

  if (hasProxies) {
    const fresh = await assignAccountProxies(proxyManager);
    for (let i = 0; i < accountProxies.length; i++) {
      accountProxies[i] = fresh[i];
    }
  }

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    session.resetForReconnect();

    if (hasProxies && accountProxies[i]) {
      session.setProxy(accountProxies[i]);
    }

    session.removeAllListeners('loggedOut');
    session.removeAllListeners('qrBlockedByProxy');
    session.on('loggedOut', () => {
      console.log(`[SYSTEM] ${session.sessionName} logged out — scan QR when prompted.`);
    });
    session.on('qrBlockedByProxy', () => {
      console.log(`[SYSTEM] ${session.sessionName}: QR blocked by proxy — restart and choose PAIRING CODE (option 2).`);
    });

    console.log(`[RECONNECT] ${session.sessionName}...`);
    await session.connect();
  }

  printAuthStatusSummary();
  await sleep(3000);
}

async function runPairSession(
  sessionA,
  sessionB,
  language,
  pairNum,
  pairLabels,
  controller,
  aiA,
  aiB,
  accountProxies = []
) {
  attachDesktopProfileSync(sessionA);
  attachDesktopProfileSync(sessionB);

  const slotA = (pairNum - 1) * 2;
  const slotB = slotA + 1;
  const chatSlots = (fromSide) => ({
    pairIndex: pairNum - 1,
    fromSlot: fromSide === 'A' ? slotA : slotB,
    toSlot: fromSide === 'A' ? slotB : slotA,
  });
  const typingSlots = (label) => ({
    pairIndex: pairNum - 1,
    fromSlot: label === pairLabels.A ? slotA : slotB,
  });

  const jidA = sessionA.getMyJid();
  const jidB = sessionB.getMyJid();
  sessionA.partnerLidJid = null;
  sessionB.partnerLidJid = null;
  sessionA.setExpectedPartner(jidB, { loadSavedLid: false });
  sessionB.setExpectedPartner(jidA, { loadSavedLid: false });

  log(
    pairNum,
    `Phone lock: ${sessionA.getPhone() || '?'} (${pairLabels.A}) ↔ ${sessionB.getPhone() || '?'} (${pairLabels.B})`
  );

  // Creds seed overwrites any stale partner-lid.json from mis-identified contacts.
  // (no need to wait for a manual message to learn the partner's LID)
  const refreshPartnerLids = (reason = 'creds_seed') => {
    const lidA = sessionA.getMyLid();
    const lidB = sessionB.getMyLid();
    let changed = false;
    if (lidA && sessionB.partnerLidJid !== lidA) {
      sessionB.learnPartnerLid(lidA, reason);
      changed = true;
      log(pairNum, `LID seed: ${pairLabels.A} → ${lidA}${reason !== 'creds_seed' ? ` (${reason})` : ''}`);
    }
    if (lidB && sessionA.partnerLidJid !== lidB) {
      sessionA.learnPartnerLid(lidB, reason);
      changed = true;
      log(pairNum, `LID seed: ${pairLabels.B} → ${lidB}${reason !== 'creds_seed' ? ` (${reason})` : ''}`);
    }
    return { lidA, lidB, changed };
  };

  refreshPartnerLids('creds_seed');

  let chatMessageCount = 0;
  let nudgeCount = 0;
  let settled = false;
  let isReplying = false;
  let isNudging = false;
  let waitingSince = Date.now();
  let idleCheckInterval = null;
  let lastNudgeAt = 0;
  let lastIdleWarnAt = 0;
  let lastWaitLogAt = 0;
  let lastNudgeLimitLogAt = 0;
  let deliveryWarnShown = false;
  let lastChatFrom = '';
  let lastChatTo = '';
  let waitingForLabel = pairLabels.B;
  let replyingAsLabel = '';
  let finishPair = null;
  /** Partner sent OK but waiting side still recv=0 — bridge after delay. */
  let lastPendingDelivery = null;
  let deliveryBridgeUsed = false;
  const chatTranscript = [];
  const recentOutbound = [];
  const messageQueue = [];
  const inboundCount = { A: 0, B: 0 };
  const ignoredInboundLog = { A: false, B: false };

  const notePendingDelivery = (waitingSide, waitingLabel, text) => {
    lastPendingDelivery = {
      waitingSide,
      waitingLabel,
      text: oneLine(text),
      at: Date.now(),
    };
    deliveryBridgeUsed = false;
  };

  const recordChat = (from, text, { skipTranscript = false } = {}) => {
    if (skipTranscript || !text?.trim()) return;
    chatTranscript.push({ from, text: text.trim() });
    if (chatTranscript.length > 24) chatTranscript.splice(0, chatTranscript.length - 24);
  };

  const recordOutbound = (fromLabel, text) => {
    const trimmed = oneLine(text);
    if (!trimmed || !fromLabel) return;
    recentOutbound.push({ from: fromLabel, text: trimmed, at: Date.now() });
    if (recentOutbound.length > 16) recentOutbound.shift();
  };

  /** Ignore when this session receives its own outbound text back (sync echo). */
  const isEchoText = (text, ownLabel) => {
    const trimmed = oneLine(text);
    if (!trimmed || !ownLabel) return false;
    const now = Date.now();
    return recentOutbound.some(
      (entry) =>
        entry.from === ownLabel &&
        entry.text === trimmed &&
        now - entry.at < ECHO_IGNORE_MS
    );
  };

  const markWaitingFor = (label) => {
    waitingForLabel = label;
    waitingSince = Date.now();
    lastWaitLogAt = 0;
  };

  const clearIdleWatch = () => {
    if (idleCheckInterval) {
      clearInterval(idleCheckInterval);
      idleCheckInterval = null;
    }
  };

  const getNudgeText = () => {
    const nudges = {
      Indonesia: ['eh masih ongkir?', 'woi masih ada gak?'],
      English: ['hey you there?', 'yo still around?'],
      Melayu: ['wei masih ada?', 'eh masih ongkir?'],
      Chinese: ['在吗？', '嘿，还在吗？'],
    };
    const list = nudges[language] || nudges.Indonesia;
    return list[Math.floor(Math.random() * list.length)];
  };

  let processInbound = null;

  const drainMessageQueue = async () => {
    if (!processInbound) return;
    while (messageQueue.length > 0 && !settled && !controller.isPairStopped(pairNum)) {
      const next = messageQueue.shift();
      await processInbound(next.side, next.sender, next.text);
    }
  };

  const startIdleWatch = () => {
    clearIdleWatch();

    idleCheckInterval = setInterval(async () => {
      if (settled || controller.isPairStopped(pairNum)) {
        clearIdleWatch();
        return;
      }

      if (chatMessageCount >= MAX_MESSAGES) {
        clearIdleWatch();
        if (finishPair) finishPair({ status: 'completed', pairNum });
        return;
      }

      const idleSec = Math.floor((Date.now() - waitingSince) / 1000);
      const waitingSession = waitingForLabel === pairLabels.A ? sessionA : sessionB;
      const partnerConnected = isPartnerAvailable(waitingSession);
      const recvA = inboundCount.A;
      const recvB = inboundCount.B;

      if (idleSec >= PAIR_IDLE_TIMEOUT_MS / 1000) {
        if (PAIR_STOP_ON_IDLE) {
          stopPair(
            `${waitingForLabel} no reply for ${PAIR_IDLE_TIMEOUT_MS / 1000}s ` +
            `(${chatMessageCount}/${MAX_MESSAGES}, wa-connected: ${partnerConnected})`
          );
          return;
        }
        if (Date.now() - lastIdleWarnAt > 120000) {
          lastIdleWarnAt = Date.now();
          log(pairNum, `Still waiting for ${waitingForLabel} (${idleSec}s) — not stopping (PAIR_STOP_ON_IDLE=false)`);
        }
      }

      const waitingSide = waitingForLabel === pairLabels.A ? 'A' : 'B';

      // Partner send succeeded in bot, but waiting linked session never got upsert (recv=0).
      // Bridge the last outbound text so feeding can continue (common after LID/proxy asymmetry).
      if (
        !deliveryBridgeUsed
        && !isReplying
        && !isNudging
        && lastPendingDelivery
        && lastPendingDelivery.waitingLabel === waitingForLabel
        && inboundCount[waitingSide] === 0
        && idleSec >= 55
        && lastPendingDelivery.text
      ) {
        deliveryBridgeUsed = true;
        const bridged = lastPendingDelivery;
        lastPendingDelivery = null;
        log(
          pairNum,
          `[RECOVERY] Delivery bridge → ${bridged.waitingLabel} ` +
          `(recv still 0 after ${idleSec}s; continuing from partner's last send)`
        );
        try {
          await processInbound(bridged.waitingSide, 'delivery-bridge', bridged.text);
        } catch (err) {
          log(pairNum, `[ERROR] Delivery bridge failed: ${err.message}`);
          deliveryBridgeUsed = false;
        }
        return;
      }

      if (
        PAIR_MAX_NUDGES > 0
        && nudgeCount >= PAIR_MAX_NUDGES
        && inboundCount[waitingSide] === 0
        && idleSec >= Math.max(PAIR_IDLE_TIMEOUT_MS / 1000, 180)
      ) {
        stopPair(
          `${waitingForLabel} never received partner message in bot ` +
          `(recv=0 after ${nudgeCount} nudges / ${idleSec}s)`
        );
        return;
      }

      if (
        chatMessageCount > 0 &&
        chatMessageCount < MAX_MESSAGES &&
        !isReplying &&
        !isNudging &&
        idleSec >= PAIR_NUDGE_AFTER_MS / 1000 &&
        Date.now() - lastNudgeAt >= PAIR_NUDGE_AFTER_MS &&
        idleSec >= Math.floor(MIN_DELAY / 1000)
      ) {
        if (PAIR_MAX_NUDGES > 0 && nudgeCount >= PAIR_MAX_NUDGES) {
          if (Date.now() - lastNudgeLimitLogAt > 120000) {
            lastNudgeLimitLogAt = Date.now();
            log(pairNum, `Nudge limit reached (${PAIR_MAX_NUDGES}) — waiting for ${waitingForLabel} only`);
          }
        } else if (PAIR_MAX_NUDGES === 0) {
          // nudges disabled
        } else {
          if (
            lastChatTo === waitingForLabel &&
            lastChatFrom &&
            inboundCount[waitingSide] === 0 &&
            idleSec >= 45
          ) {
            // Often LID mismatch (inbound dropped), not missing WA delivery.
            // Re-seed live LIDs then continue to nudge so recovery is possible.
            const { changed } = refreshPartnerLids('recv0_reseed');
            if (!deliveryWarnShown) {
              deliveryWarnShown = true;
              log(
                pairNum,
                `[WARN] ${waitingForLabel} has not received ${lastChatFrom}'s message in bot ` +
                `(recv=0). LID ${changed ? 're-seeded' : 'unchanged'} — check phone; nudge will retry.`
              );
            }
            // Do not return — allow nudge after reseed.
          }

          const fromA = waitingForLabel === pairLabels.B;
          const nudgeSession = fromA ? sessionA : sessionB;
          const nudgeJid = fromA ? jidB : jidA;
          const fromLabel = fromA ? pairLabels.A : pairLabels.B;
          const toLabel = fromA ? pairLabels.B : pairLabels.A;

          lastNudgeAt = Date.now();
          log(
            pairNum,
            `No reply ${idleSec}s — nudge ${fromLabel} -> ${toLabel} ` +
            `(waiting for ${waitingForLabel}; recv ${pairLabels.A}=${recvA} ${pairLabels.B}=${recvB})`
          );
          try {
            isNudging = true;
            replyingAsLabel = fromLabel;
            await sleep(3000 + Math.floor(Math.random() * 5000));
            const nudge = getNudgeText();
            const sent = await nudgeSession.sendMessage(nudgeJid, nudge);
            if (sent) {
              nudgeCount++;
              totalMessagesSent++;
              recordOutbound(fromLabel, nudge);
              notePendingDelivery(waitingSide, waitingForLabel, nudge);
              logNudge(pairNum, fromLabel, toLabel, nudge, nudgeCount, chatSlots(fromA ? 'A' : 'B'));
            }
          } finally {
            isNudging = false;
            replyingAsLabel = '';
            await drainMessageQueue();
          }
        }
      }

      if (
        !isReplying &&
        !isNudging &&
        chatMessageCount < MAX_MESSAGES &&
        idleSec >= 45 &&
        Date.now() - lastWaitLogAt > 60000
      ) {
        lastWaitLogAt = Date.now();
        log(
          pairNum,
          `Waiting for ${waitingForLabel}... ${idleSec}s ${msgCount(chatMessageCount)} ` +
          `wa-connected=${partnerConnected} recv(${pairLabels.A}=${recvA},${pairLabels.B}=${recvB})`
        );
      }
    }, 15000);
  };

  const stopPair = (reason) => {
    if (controller.isPairStopped(pairNum)) return;
    clearIdleWatch();
    log(pairNum, '');
    log(pairNum, `Stopped: ${reason}`);
    if (pairCount() > 1) log(pairNum, 'Other pairs keep running.');
    log(pairNum, '');
    controller.stopPair(pairNum, reason);
  };

  log(pairNum, `Started | ${language} | max ${MAX_MESSAGES} msgs`);
  log(pairNum, `${pairLabels.A}: ${sessionA.getPhone()} | ${pairLabels.B}: ${sessionB.getPhone()}`);

  if (!isPartnerAvailable(sessionA) || !isPartnerAvailable(sessionB)) {
    stopPair('Account not connected at session start');
    return { status: 'stopped', pairNum };
  }

  return new Promise((resolve) => {
    let onLoggedOutA;
    let onLoggedOutB;

    const complete = (result) => {
      if (settled) return;
      settled = true;
      clearIdleWatch();
      sessionA.removeAllListeners('message');
      sessionB.removeAllListeners('message');
      if (onLoggedOutA) sessionA.removeListener('loggedOut', onLoggedOutA);
      if (onLoggedOutB) sessionB.removeListener('loggedOut', onLoggedOutB);

      if (result.status === 'completed') {
        log(pairNum, `Done ${chatMessageCount}/${MAX_MESSAGES} chat messages — pair finished.`);
      }

      resolve(result);
    };

    finishPair = complete;

    controller.registerPair(pairNum, (result) => {
      complete(
        result.status === 'stopped'
          ? { status: 'stopped', pairNum, reason: result.reason }
          : { status: 'completed', pairNum }
      );
    }, sessionA, sessionB);

    onLoggedOutA = () => stopPair(`${pairLabels.A} logged out`);
    onLoggedOutB = () => stopPair(`${pairLabels.B} logged out`);
    sessionA.on('loggedOut', onLoggedOutA);
    sessionB.on('loggedOut', onLoggedOutB);

    const onPolicyAlert = (label, session) => (alert) => {
      if (
        isDesktopFeeding()
        && (alert.severity === 'critical' || isStrictLogoutAlert(alert))
      ) {
        const slot = sessionSlotIndex(session);
        reportAuditEntry({
          runId: process.env.FEEDING_RUN_ID || null,
          slot,
          sessionName: session.sessionName,
          accountName: session.getDisplayName?.() || label,
          policyType: alert.type,
          strictScanPossible: alert.strictScanPossible,
          reason: alert.title || alert.type,
          proxyUrl: session.proxyUrl || accountProxies[slot] || null,
          pairIndex: pairNum - 1,
        }).catch(() => {});
      }
      if (alert.severity === 'critical' && isStrictLogoutAlert(alert)) {
        stopPair(`${label}: ${alert.type} — check phone for WA restriction`);
      }
    };
    sessionA.on('policyAlert', onPolicyAlert(pairLabels.A, sessionA));
    sessionB.on('policyAlert', onPolicyAlert(pairLabels.B, sessionB));

    const onStrictLogout = (label, session) => ({ alert }) => {
      if (!isDesktopFeeding()) return;
      const slot = sessionSlotIndex(session);
      if (isStrictLogoutAlert(alert)) {
        reportStrictLogout(slot, alert).catch(() => {});
        stopPair(`${label}: strict logout confirmed — session removed; check phone for WA limit`);
      } else {
        stopPair(`${label}: connection lost — not a confirmed strict scan`);
      }
    };
    sessionA.on('strictLogout', onStrictLogout(pairLabels.A, sessionA));
    sessionB.on('strictLogout', onStrictLogout(pairLabels.B, sessionB));

    processInbound = async (side, sender, text) => {
      if (controller.isPairStopped(pairNum)) return;
      if (chatMessageCount >= MAX_MESSAGES) return;

      const isA = side === 'A';
      const recvLabel = isA ? pairLabels.B : pairLabels.A;
      const sendLabel = isA ? pairLabels.A : pairLabels.B;

      if (isEchoText(text, sendLabel)) {
        if (DEBUG_MESSAGES) {
          log(pairNum, `[echo] skipped (${sendLabel}): ${oneLine(text).slice(0, 60)}`);
        }
        return;
      }

      if (isReplying) {
        messageQueue.push({ side, sender, text });
        if (DEBUG_MESSAGES) {
          log(pairNum, `[debug] queued message (${messageQueue.length} waiting)`);
        }
        return;
      }

      isReplying = true;
      replyingAsLabel = sendLabel;
      const partnerSession = isA ? sessionB : sessionA;
      const sendSession = isA ? sessionA : sessionB;
      const ai = isA ? aiA : aiB;

      try {
        if (!isPartnerAvailable(partnerSession)) {
          stopPair(`${recvLabel} unavailable (logged out / disconnected)`);
          return;
        }

        inboundCount[side]++;
        deliveryWarnShown = false;
        if (lastPendingDelivery?.waitingSide === side) lastPendingDelivery = null;
        recordChat(recvLabel, text);
        nudgeCount = 0;

        const delay = randomDelay();
        logTyping(pairNum, sendLabel, Math.round(delay / 1000), typingSlots(sendLabel));
        await sleep(delay);

        if (controller.isPairStopped(pairNum)) return;
        if (!isPartnerAvailable(partnerSession)) {
          stopPair(`${recvLabel} unavailable while replying`);
          return;
        }

        const reply = await ai.generateReply(text, sendLabel, recvLabel, [...chatTranscript]);
        const destJid = isA ? jidB : jidA;
        const sent = await sendSession.sendMessage(destJid, reply);
        if (!sent) {
          stopPair(`Send failed — ${recvLabel} may be logged out`);
          return;
        }

        chatMessageCount++;
        totalMessagesSent++;
        recordOutbound(sendLabel, reply);
        markWaitingFor(recvLabel);
        lastChatFrom = sendLabel;
        lastChatTo = recvLabel;
        recordChat(sendLabel, reply);
        notePendingDelivery(isA ? 'B' : 'A', recvLabel, reply);
        logOut(pairNum, sendLabel, recvLabel, reply, chatMessageCount, '', chatSlots(isA ? 'A' : 'B'));

        if (chatMessageCount >= MAX_MESSAGES) {
          complete({ status: 'completed', pairNum });
        }
      } finally {
        isReplying = false;
        replyingAsLabel = '';
        await drainMessageQueue();
      }
    };

    sessionA.removeAllListeners('message');
    sessionB.removeAllListeners('message');

    const onInbound = (side, session, partnerJid, partnerLabel) => ({ sender, remoteJid, text, senderPn }) => {
      if (!session.isPartnerMessage(sender, remoteJid, partnerJid, { senderPn })) {
        if (!ignoredInboundLog[side]) {
          ignoredInboundLog[side] = true;
          log(
            pairNum,
            `[WARN] ${side === 'A' ? pairLabels.A : pairLabels.B} ignored inbound ` +
            `(sender=${sender || '?'} chat=${remoteJid || '?'} expected=${partnerJid})`
          );
        }
        return;
      }
      ignoredInboundLog[side] = false;
      processInbound(side, sender, text).catch((err) => {
        log(pairNum, `[ERROR] Inbound handler: ${err.message}`);
      });
    };

    sessionA.on('message', onInbound('A', sessionA, jidB, pairLabels.B));
    sessionB.on('message', onInbound('B', sessionB, jidA, pairLabels.A));

    (async () => {
      try {
        const startDelay = FIRST_MSG_DELAY + Math.floor(Math.random() * 3000);
        log(pairNum, `Starting in ${Math.round(startDelay / 1000)}s`);
        await sleep(startDelay);

        if (controller.isPairStopped(pairNum)) return;
        if (!isPartnerAvailable(sessionA) || !isPartnerAvailable(sessionB)) {
          stopPair('Partner unavailable before chat start');
          return;
        }

        isReplying = true;
        replyingAsLabel = pairLabels.A;
        const openerDelay = randomDelay();
        logTyping(pairNum, pairLabels.A, Math.round(Math.min(openerDelay, 15000) / 1000), typingSlots(pairLabels.A));
        await sleep(Math.min(openerDelay, 15000));

        const opener = await aiA.generateOpener(pairLabels.A, pairLabels.B);
        const topic = aiA.sessionTopic;
        aiB.setSessionTopic(topic);

        if (controller.isPairStopped(pairNum)) return;

        const sent = await sessionA.sendMessage(jidB, opener);
        if (!sent) {
          isReplying = false;
          replyingAsLabel = '';
          stopPair(`Opener send failed — ${pairLabels.B} may be logged out`);
          return;
        }

        isReplying = false;
        replyingAsLabel = '';

        chatMessageCount++;
        totalMessagesSent++;
        recordOutbound(pairLabels.A, opener);
        markWaitingFor(pairLabels.B);
        lastChatFrom = pairLabels.A;
        lastChatTo = pairLabels.B;
        recordChat(pairLabels.A, opener);
        notePendingDelivery('B', pairLabels.B, opener);
        logOut(pairNum, pairLabels.A, pairLabels.B, opener, chatMessageCount, '', chatSlots('A'));
        // LID often appears in creds only after first traffic — refresh before waiting for reply.
        refreshPartnerLids('post_opener');
        startIdleWatch();
      } catch (err) {
        isReplying = false;
        replyingAsLabel = '';
        log(pairNum, `[ERROR] Opener failed: ${err.message}`);
        stopPair(err.message);
      }
    })();
  });
}

async function runAllPairs(sessions, language, accountProxies = []) {
  const controller = new PairChatController();
  const pairConfigs = [];
  const pairsToRun = getPairsToRun();

  console.log('');
  if (pairsToRun.length === 1) {
    console.log(`[SESSION] Pair ${pairsToRun[0] + 1} only | ${language}`);
  } else {
    console.log(`[SESSION] ${pairCount()} pair(s) | ${language}`);
  }

  for (const p of pairsToRun) {
    const aiA = new AIProvider();
    const aiB = new AIProvider();
    aiA.language = language;
    aiB.language = language;

    const sessionA = sessions[p * 2];
    const sessionB = sessions[p * 2 + 1];
    const labels = {
      A: resolveSessionLabel(sessionA, p * 2),
      B: resolveSessionLabel(sessionB, p * 2 + 1),
    };
    attachSessionLabelSync(sessionA, p * 2, labels, 'A');
    attachSessionLabelSync(sessionB, p * 2 + 1, labels, 'B');
    const labelA = labels.A;
    const labelB = labels.B;
    aiA.setLogTag(`[Pair ${p + 1}] [${labelA}]`);
    aiB.setLogTag(`[Pair ${p + 1}] [${labelB}]`);

    pairConfigs.push({
      pairNum: p + 1,
      sessionA,
      sessionB,
      labels,
      labelA,
      labelB,
      aiA,
      aiB,
    });
  }

  if (isDesktopFeeding()) {
    await reportFeedingSessionStart(sessions, accountProxies);
  }

  await Promise.all(
    pairConfigs.flatMap(({ aiA, aiB }) => [aiA.initialize(), aiB.initialize()])
  );

  for (const cfg of pairConfigs) {
    log(cfg.pairNum, `${cfg.labelA} <-> ${cfg.labelB}`);
  }
  console.log('');

  const tasks = pairConfigs.map(({ pairNum, sessionA, sessionB, labels, aiA, aiB }) =>
    runPairSession(
      sessionA,
      sessionB,
      language,
      pairNum,
      labels,
      controller,
      aiA,
      aiB,
      accountProxies
    )
      .catch((err) => {
        log(pairNum, `[ERROR] ${err.message}`);
        controller.stopPair(pairNum, err.message);
        return { status: 'stopped', pairNum, reason: err.message };
      })
  );

  const results = await Promise.all(tasks);
  controller.clear();

  const completed = results.filter((r) => r?.status === 'completed').length;
  const stopped = results.filter((r) => r?.status === 'stopped').length;

  console.log('');
  console.log(`[SESSION] Done: ${completed} | Stopped: ${stopped} | Total: ${pairsToRun.length}`);

  if (isDesktopFeeding()) {
    await reportFeedingPairResults(results, sessions, accountProxies);
  }

  return results;
}

async function assignAccountProxies(proxyManager, options = {}) {
  const onlySlots = options.onlySlots || null;
  const probeEnabled = process.env.PROXY_PROBE !== 'false';
  let accountProxies;

  // Bridge injects the exact slot→proxy map so CLI cannot miss auth/proxies.txt on Railway.
  if (process.env.FEEDING_ACCOUNT_PROXIES) {
    try {
      const parsed = JSON.parse(process.env.FEEDING_ACCOUNT_PROXIES);
      if (Array.isArray(parsed)) {
        accountProxies = new Array(accountCount()).fill(null);
        for (let i = 0; i < accountCount(); i++) {
          accountProxies[i] = parsed[i] || null;
        }
        console.log(
          `[PROXY] Using FEEDING_ACCOUNT_PROXIES from bridge (${accountProxies.filter(Boolean).length} assigned)`
        );
        const slotsChecked = onlySlots || Array.from({ length: accountCount() }, (_, i) => i);
        for (const i of slotsChecked) {
          const url = accountProxies[i];
          console.log(
            `[PROXY] ${getAccountName(i)} → ${url ? proxyManager.maskUrl(url) : 'direct (missing)'}`
          );
        }
        if (accountProxies[0]) proxyManager.currentProxy = accountProxies[0];
        return accountProxies;
      }
    } catch (err) {
      console.log(`[PROXY] FEEDING_ACCOUNT_PROXIES parse failed: ${err.message}`);
    }
  }

  if (probeEnabled) {
    if (onlySlots?.length) {
      accountProxies = await proxyManager.assignWorkingForSlotIndices(
        accountCount(),
        onlySlots,
        (i) => getAccountName(i)
      );
    } else {
      accountProxies = await proxyManager.assignWorkingForAccounts(
        accountCount(),
        (i) => getAccountName(i)
      );
    }
  } else {
    accountProxies = new Array(accountCount()).fill(null);
    const slots = onlySlots || Array.from({ length: accountCount() }, (_, i) => i);
    for (const i of slots) {
      accountProxies[i] = proxyManager.getProxyAt(i);
    }
    console.log('[PROXY] PROXY_PROBE=false — using fixed slot order (no rotation test)');
  }

  const n = proxyManager.proxies.length;
  const slotsChecked = onlySlots || Array.from({ length: accountCount() }, (_, i) => i);

  if (n > 0 && n < slotsChecked.length && !probeEnabled) {
    console.log(`[PROXY] ${n} proxy(ies) for ${slotsChecked.length} account slot(s) — round-robin reuse`);
  }

  const pairsToLog = onlySlots?.length === 2
    ? [Math.floor(onlySlots[0] / 2)]
    : Array.from({ length: pairCount() }, (_, p) => p);

  for (const p of pairsToLog) {
    const slotA = p * 2;
    const slotB = p * 2 + 1;
    const proxyA = accountProxies[slotA];
    const proxyB = accountProxies[slotB];
    if (!proxyA || !proxyB) continue;

    const labelA = getAccountLabel(slotA);
    const labelB = getAccountLabel(slotB);
    console.log(`[PROXY] Pair ${p + 1}: ${labelA} → ${proxyManager.maskUrl(proxyA)} | ${labelB} → ${proxyManager.maskUrl(proxyB)}`);

    if (proxyA === proxyB) {
      console.log(
        `[WARN] Pair ${p + 1}: ${labelA} and ${labelB} share the SAME proxy IP. ` +
        'Bot-to-bot messages often fail to arrive — add a second proxy in proxies.txt (one per account).'
      );
    }
  }

  if (accountProxies[0]) {
    proxyManager.currentProxy = accountProxies[0];
  }
  return accountProxies;
}

async function reassignAccountProxies(proxyManager) {
  return assignAccountProxies(proxyManager);
}

function printAuthStatusSummary() {
  console.log('');
  console.log('='.repeat(50));
  console.log('SESSION STATUS (auth/ folder)');
  console.log(`  Data folder: ${getAppRoot()}`);
  console.log(`  Auth path:   ${path.join(getAppRoot(), 'auth')}`);
  console.log('='.repeat(50));

  let ready = 0;
  let needLink = 0;

  for (let i = 0; i < accountCount(); i++) {
    const name = getAccountName(i);
    const auth = new WhatsAppSession(name).getAuthStatus();
    if (auth.valid) {
      ready++;
      console.log(`  ${name}: ready (${auth.phone || 'linked'}) — auto connect, no login prompt`);
    } else if (auth.saved) {
      needLink++;
      console.log(`  ${name}: invalid session — will ask login on connect`);
    } else {
      needLink++;
      console.log(`  ${name}: not linked — will ask login on connect`);
    }
  }

  console.log('');
  if (needLink === 0) {
    console.log(`All ${ready} account(s) ready — startup skips login method.`);
  } else {
    console.log(`${ready} ready, ${needLink} need linking (login asked only for those).`);
  }
  console.log('='.repeat(50));
}

/** Ordered list: assigned proxy first, then every proxy in proxies.txt. */
function getLinkProxyCandidates(slotIndex, proxyManager, assignedUrl) {
  const ordered = [];
  if (assignedUrl) ordered.push(assignedUrl);
  for (const url of proxyManager.proxies) {
    if (url && !ordered.includes(url)) ordered.push(url);
  }
  return ordered;
}

/** direct | rotate | sticky (Railway defaults to sticky). */
function getProxyQrLinkMode() {
  const raw = String(process.env.PROXY_QR_LINK || '').toLowerCase().trim();
  if (raw === 'direct' || raw === 'rotate' || raw === 'sticky') return raw;
  if (
    process.env.RAILWAY_ENVIRONMENT
    || process.env.RAILWAY_PROJECT_ID
    || process.env.WSAF_STICKY_PROXY === '1'
  ) {
    return 'sticky';
  }
  return 'direct';
}

/**
 * New account: link via direct (default) or rotate proxies until QR works.
 * Returns proxy URL used for link, or null if direct.
 */
async function linkAccountWithProxyRotation(session, plan, sessionName, proxyManager, candidates) {
  const list = candidates.filter(Boolean);
  const probeTimeout = parseInt(process.env.PROXY_LINK_TRY_MS || '22000', 10);
  const qrMode = getProxyQrLinkMode();

  if (qrMode === 'sticky') {
    const url = list[0] || null;
    if (!url) {
      throw new Error(
        `${sessionName}: sticky proxy mode requires a proxies.txt / AMS proxy line — refusing Railway direct IP`
      );
    }
    console.log('');
    console.log(`[PROXY] Sticky: QR/link via ${proxyManager.maskUrl(url)} (no direct fallback)`);
    console.log('');
    session.setProxy(url);
    session.linkedViaDirect = false;
    await session.connect(plan);
    if (plan.method !== 'qr') {
      await session.waitUntilConnected();
    }
    return url;
  }

  if (qrMode === 'direct') {
    console.log('');
    console.log('[PROXY] New device QR: using DIRECT connection (WhatsApp blocks QR on datacenter IPs).');
    console.log('[PROXY] After link, saved session may reconnect via proxy on next run if PROXY_QR_LINK stays direct.');
    console.log('');
    session.setProxy(null);
    session.linkedViaDirect = true;
    await session.connect(plan);
    await session.waitUntilConnected();
    return null;
  }

  if (list.length === 0) {
    session.setProxy(null);
    session.linkedViaDirect = true;
    console.log(`[PROXY] ${sessionName}: no proxy — linking on direct connection`);
    await session.connect(plan);
    await session.waitUntilConnected();
    return null;
  }

  const saveWorking = (url) => {
    const store = proxyManager.loadWorkingStore();
    store[sessionName] = url;
    proxyManager.saveWorkingStore(store);
  };

  for (let idx = 0; idx < list.length; idx++) {
    const url = list[idx];
    await session.disconnect();
    session.setProxy(url);
    session.proxyLinkFallbackDone = false;
    session.reconnectAttempts = 0;

    console.log(`[PROXY] ${sessionName}: link try ${idx + 1}/${list.length} → ${proxyManager.maskUrl(url)}`);

    if (plan.method === 'pairing') {
      try {
        await session.connect(plan);
        const ok = await session.waitUntilConnected(180000);
        if (ok) {
          session.linkedViaDirect = false;
          console.log(`[PROXY] ${sessionName}: paired via ${proxyManager.maskUrl(url)}`);
          saveWorking(url);
          return url;
        }
      } catch (err) {
        console.log(`[PROXY] ${sessionName}: pairing failed on ${proxyManager.maskUrl(url)} — ${err.message}`);
      }
      continue;
    }

    const outcome = await session.connectUntilReady(plan, probeTimeout);

    if (outcome === 'connected') {
      session.linkedViaDirect = false;
      console.log(`[PROXY] ${sessionName}: connected via ${proxyManager.maskUrl(url)}`);
      saveWorking(url);
      return url;
    }

    if (outcome === 'qr_waiting') {
      session.linkedViaDirect = false;
      console.log(`[PROXY] ${sessionName}: QR ready via ${proxyManager.maskUrl(url)} — scan on phone`);
      const ok = await session.waitUntilConnected();
      if (ok) {
        saveWorking(url);
        return url;
      }
      console.log(`[PROXY] ${sessionName}: scan timeout on ${proxyManager.maskUrl(url)}`);
    } else {
      console.log(`[PROXY] ${sessionName}: no QR on ${proxyManager.maskUrl(url)} (${outcome})`);
    }
  }

  console.log('');
  console.log('[PROXY] All proxies failed QR link (bad session = WA rejects datacenter IP for new devices).');
  await fallbackToDirectLink(session, plan, sessionName, proxyManager, list[0]);
  await session.waitUntilConnected();
  return null;
}

/** Proxy tried first; if WA blocks linking, retry QR/pairing on direct (keeps session after link). */
async function fallbackToDirectLink(session, plan, sessionName, proxyManager, proxyUrl) {
  if (session.proxyLinkFallbackDone) return;
  session.proxyLinkFallbackDone = true;
  session.clearReconnectTimer?.();

  if (session.hasSavedAuth() && !session.isConnected) {
    session.deleteAuthFolder();
  }

  session.setProxy(null);
  session.linkedViaDirect = true;
  session.reconnectAttempts = 0;
  session.isLoggedOut = false;

  console.log('');
  console.log(`[PROXY] ${sessionName}: proxy ${proxyManager.maskUrl(proxyUrl)} cannot link new device.`);
  console.log(`[PROXY] ${sessionName}: continuing with ${plan.method === 'pairing' ? 'pairing code' : 'QR'} on direct connection...`);
  console.log('');

  await session.connect(plan);
}

async function connectAllSessions(hasProxies, proxyManager, accountProxies, options = {}) {
  const slotIndices = options.onlySlots || Array.from({ length: accountCount() }, (_, i) => i);
  const sessions = new Array(accountCount()).fill(null);
  const loginPlans = await prepareLoginPlans({ onlySlots: slotIndices });

  for (const i of slotIndices) {
    const sessionName = getAccountName(i);
    let plan = loginPlans.get(sessionName) || { method: 'qr' };

    console.log('');
    console.log('='.repeat(50));
    console.log(`STEP ${i + 1}/${accountCount()}: Connect WhatsApp ${sessionName}`);
    console.log('='.repeat(50));

    const session = new WhatsAppSession(sessionName);
    attachDesktopProfileSync(session);
    const proxyUrl = hasProxies ? accountProxies[i] : null;
    const linkCandidates = hasProxies
      ? getLinkProxyCandidates(i, proxyManager, proxyUrl)
      : [];

    session.on('loggedOut', () => {
      console.log(`[SYSTEM] ${sessionName} disconnected from WhatsApp — pair feeding stopped.`);
      console.log(`[SYSTEM] Link ${sessionName} again on next connect (QR or pairing code).`);
    });

    if (plan.skipLogin) {
      const phoneHint = plan.auth?.phone ? ` (${plan.auth.phone})` : '';
      const regHint = plan.auth?.registered ? 'registered' : 'valid, finishing registration';
      console.log(`[LOGIN] ${sessionName}: saved session${phoneHint} (${regHint}) — skipping login prompt`);
      if (proxyUrl) {
        session.setProxy(proxyUrl);
        console.log(`[PROXY] ${sessionName} assigned → ${proxyManager.maskUrl(proxyUrl)}`);
      } else if (hasProxies) {
        console.log(`[PROXY] ${sessionName}: probe found no working proxy — will connect direct`);
      } else {
        console.log(`[PROXY] ${sessionName}: no proxies.txt — connecting direct`);
      }
      await session.connect();
    } else if (hasProxies && linkCandidates.length > 0) {
      const used = await linkAccountWithProxyRotation(
        session,
        plan,
        sessionName,
        proxyManager,
        linkCandidates
      );
      accountProxies[i] = used;
    } else {
      session.setProxy(null);
      await session.connect(plan);
      if (!plan.skipLogin) {
        await session.waitUntilConnected();
      }
    }

    sessions[i] = session;
    session.syncProfileNameFromDisk?.();
    session.captureProfileName?.('post-connect');
  }

  return sessions;
}

async function reconnectSessionForContinue(session, proxyUrl, proxyManager) {
  session.resetForReconnect();
  session.clearReconnectTimer();

  const hasAuth = session.hasSavedAuth();
  if (!hasAuth) {
    console.log(`[RECONNECT] ${session.sessionName}: no saved session — scan QR`);
    if (proxyUrl) {
      session.setProxy(proxyUrl);
      console.log(`[PROXY] ${session.sessionName} assigned → ${proxyManager.maskUrl(proxyUrl)}`);
    } else {
      console.log(`[PROXY] ${session.sessionName}: reconnect direct (no proxy slot)`);
    }
    await session.connect({ method: 'qr' });
    return session.isConnected;
  }

  // Sticky: ignore linkedViaDirect — always stay on the operator proxy IP.
  if (session.linkedViaDirect && getProxyQrLinkMode() !== 'sticky') {
    console.log(
      `[PROXY] ${session.sessionName}: reconnect on direct — linkedViaDirect=true (linked without proxy earlier)`
    );
    console.log(
      `[PROXY] ${session.sessionName}: feeding rounds still use proxy from proxies.txt when CLI starts`
    );
    session.setProxy(null);
    await session.disconnect();
    await session.connect();
    return session.isConnected;
  }
  if (session.linkedViaDirect && getProxyQrLinkMode() === 'sticky' && proxyUrl) {
    console.log(
      `[PROXY] ${session.sessionName}: sticky override — was linkedViaDirect, forcing proxy ${proxyManager.maskUrl(proxyUrl)}`
    );
    session.linkedViaDirect = false;
  }

  if (proxyUrl) {
    console.log(`[PROXY] ${session.sessionName} assigned → ${proxyManager.maskUrl(proxyUrl)}`);
    await session.reconnectWithProxy(proxyUrl);
    if (!session.isConnected) {
      await session.waitForConnection(20000);
    }
    return session.isConnected;
  }

  await session.connect();
  return session.isConnected;
}

async function reconnectAllSessions(sessions, proxyManager, accountProxies) {
  console.log('[PROXY] Reconnecting accounts for next feeding (same proxy slot, no auth wipe on bad session)...');

  for (let i = 0; i < sessions.length; i++) {
    const proxyUrl = accountProxies[i] || null;
    await reconnectSessionForContinue(sessions[i], proxyUrl, proxyManager);
  }
}

function formatLiveRoute(session, assignedProxy, proxyManager) {
  if (session?.proxyUrl) {
    return { route: proxyManager.maskUrl(session.proxyUrl), mode: 'proxy', source: 'live socket' };
  }
  if (assignedProxy) {
    return {
      route: proxyManager.maskUrl(assignedProxy),
      mode: 'proxy',
      source: 'assigned but socket is direct',
    };
  }
  return {
    route: 'direct',
    mode: 'direct',
    source: session?.linkedViaDirect ? 'linkedViaDirect' : 'no proxy',
  };
}

function printConnectedSummary(sessions, hasProxies, proxyManager, accountProxies) {
  const connected = sessions.filter((s) => s && s.isConnected && !s.isLoggedOut);
  const ready = connected.length;
  const expected = sessions.filter(Boolean).length || accountCount();

  console.log('');
  console.log('='.repeat(50));
  if (ready === expected && expected === accountCount()) {
    console.log(`All ${accountCount()} accounts connected! (${pairCount()} pair${pairCount() > 1 ? 's' : ''})`);
  } else if (ready === expected) {
    console.log(`Selected ${ready}/${expected} account(s) connected for this feeding run`);
  } else {
    console.log(`Connected: ${ready}/${expected} — fix failed accounts before feeding`);
  }
  console.log('='.repeat(50));

  for (let p = 0; p < pairCount(); p++) {
    const sessionA = sessions[p * 2];
    const sessionB = sessions[p * 2 + 1];
    if (!sessionA && !sessionB) continue;
    const slotA = p * 2;
    const slotB = p * 2 + 1;
    const phoneA = sessionA?.getPhone() || '(not linked)';
    const phoneB = sessionB?.getPhone() || '(not linked)';
    const nameA = sessionA?.getDisplayName?.() || getAccountLabel(slotA);
    const nameB = sessionB?.getDisplayName?.() || getAccountLabel(slotB);
    const statusA = sessionA?.isConnected ? 'ok' : 'OFFLINE';
    const statusB = sessionB?.isConnected ? 'ok' : 'OFFLINE';
    const routeA = formatLiveRoute(sessionA, accountProxies[slotA], proxyManager);
    const routeB = formatLiveRoute(sessionB, accountProxies[slotB], proxyManager);
    console.log(`  Pair ${p + 1}: ${phoneA} <-> ${phoneB}`);
    console.log(
      `    ${nameA}: route=${routeA.route} [${statusA}] (${routeA.source})`
    );
    console.log(
      `    ${nameB}: route=${routeB.route} [${statusB}] (${routeB.source})`
    );
  }

  if (!hasProxies) {
    console.log('  Proxy    : none (all accounts on direct / local IP)');
  } else {
    console.log('  Note     : route=proxy means WA traffic exits via that SOCKS IP');
    console.log('             direct during link is normal; feeding should show route=proxy above');
  }
  console.log('='.repeat(50));

  if (ready < accountCount()) {
    console.log('[WARN] Some accounts are offline — scan QR again or wait if account is on strict limit.');
  }
}

async function main() {
  console.log('+===========================================+');
  console.log('|   WhatsApp Auto Chat - Terminal Edition   |');
  console.log('|   AI-Powered Conversation Generator      |');
  console.log('+===========================================+');
  console.log('');
  const aiPrimary = process.env.AI_PROVIDER_PRIMARY || 'openai';
  const aiFallback = process.env.AI_PROVIDER_FALLBACK || 'ollama';
  console.log(`AI Provider : ${aiPrimary} (fallback: ${aiFallback})`);
  console.log(`Pairs       : ${pairCount()} (account${accountStart()}–${accountEnd()}, ${accountCount()} accounts)`);
  console.log(`Delay       : ${process.env.MIN_DELAY || 30}s - ${process.env.MAX_DELAY || 90}s`);
  console.log(`Max Messages: ${MAX_MESSAGES} per pair per session`);
  console.log(`Idle stop   : ${PAIR_STOP_ON_IDLE ? `yes (${PAIR_IDLE_TIMEOUT_MS / 1000}s)` : 'no (keeps waiting)'}`);
  console.log('');

  const proxyManager = new ProxyManager();
  const hasProxies = proxyManager.load();
  const accountProxies = hasProxies ? await assignAccountProxies(proxyManager) : [];

  if (isDesktopFeeding()) {
    console.log('[FEEDING] Desktop mode — detailed proxy logs appear in System log');
    console.log(`[FEEDING] Data folder: ${getAppRoot()}`);
    console.log('');
  }

  if (hasProxies) {
    const qrMode = getProxyQrLinkMode();
    console.log(
      `[PROXY] Probe = TCP to web.whatsapp.com / g.whatsapp.net (routing check only).`
    );
    console.log(
      `[PROXY] QR link mode: ${qrMode}` +
      (qrMode === 'direct' ? ' — new QR uses local IP; feeding uses proxy from assignment above' : ' — tries proxies for QR, then direct')
    );
    console.log('');
  }

  printAuthStatusSummary();

  const sessions = await connectAllSessions(hasProxies, proxyManager, accountProxies);
  activeSessions = sessions;

  console.log('');
  console.log('Waiting for stable connection...');
  await sleep(5000);

  printConnectedSummary(sessions, hasProxies, proxyManager, accountProxies);

  let sessionNumber = 1;
  while (true) {
    const language = await selectLanguage();

    console.log(`\n--- Session #${sessionNumber} (${pairCount()} pair${pairCount() > 1 ? 's' : ''} in parallel) ---\n`);
    totalMessagesSent = 0;
    await runAllPairs(sessions, language, accountProxies);

    console.log('');
    console.log('='.repeat(50));
    console.log(`Feeding #${sessionNumber} done (${totalMessagesSent} messages sent)`);
    console.log('='.repeat(50));

    const action = await askPostFeedingAction();

    if (action === 'exit') break;

    if (action === 'new') {
      await resetAllSessionsNew(sessions, hasProxies, proxyManager, accountProxies);
      printConnectedSummary(sessions, hasProxies, proxyManager, accountProxies);
      sessionNumber = 1;
      continue;
    }

    sessionNumber++;

    if (hasProxies) {
      console.log('');
      await reconnectAllSessions(sessions, proxyManager, accountProxies);
      printConnectedSummary(sessions, hasProxies, proxyManager, accountProxies);
      const ready = sessions.filter((s) => s.isConnected && !s.isLoggedOut).length;
      if (ready < accountCount()) {
        console.log('[WARN] Not all accounts reconnected — fix offline accounts before the next feeding round.');
      }
      await sleep(3000);
    }
  }

  await gracefulShutdown('exit');
}

async function gracefulShutdown(reason) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('');
  console.log('='.repeat(50));
  if (reason === 'SIGINT') {
    console.log('Ctrl+C — shutting down...');
  } else {
    console.log('Closing app...');
  }
  console.log(`Total messages sent: ${totalMessagesSent}`);
  console.log('Sessions kept (auth/ not deleted, no logout).');
  console.log('Disconnecting WhatsApp...');
  console.log('='.repeat(50));

  for (const session of activeSessions) {
    await session.shutdown();
  }

  try {
    const { stopCodexProxy } = require('./src/codex-oauth');
    await stopCodexProxy();
  } catch {
    // ignore
  }

  process.exit(0);
}

process.on('SIGINT', () => {
  gracefulShutdown('SIGINT');
});

process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM');
});

/** Single feeding run for desktop app (no terminal menus). */
async function runDesktopFeedingOnce() {
  console.log('+===========================================+');
  console.log('|   WhatsApp Auto Feeding — Desktop CLI    |');
  console.log('+===========================================+');
  console.log('');

  const proxyManager = new ProxyManager();
  const hasProxies = proxyManager.load();
  console.log(`[PROXY] proxies file: ${proxyManager.filePath} (loaded=${hasProxies})`);
  const singlePair = getFeedingPairIndex();
  const onlySlots = getFeedingSlotIndices();
  const accountProxies = hasProxies || process.env.FEEDING_ACCOUNT_PROXIES
    ? await assignAccountProxies(proxyManager, { onlySlots })
    : [];
  const effectivelyHasProxies = accountProxies.some(Boolean);
  if (!effectivelyHasProxies && (process.env.WSAF_STICKY_PROXY === '1' || process.env.PROXY_QR_LINK === 'sticky')) {
    console.error('[PROXY] Sticky mode but no proxy assigned — refusing Railway direct connect (logout risk).');
    console.error(`[PROXY] Expected proxies at: ${proxyManager.filePath}`);
    process.exit(1);
  }

  printAuthStatusSummary();

  const sessions = await connectAllSessions(effectivelyHasProxies || hasProxies, proxyManager, accountProxies, {
    onlySlots,
  });
  activeSessions = sessions.filter(Boolean);

  console.log('');
  console.log('Waiting for stable connection...');
  await sleep(5000);

  printConnectedSummary(sessions, hasProxies, proxyManager, accountProxies);

  if (singlePair !== null) {
    const slotA = singlePair * 2;
    const slotB = slotA + 1;
    const readyA = sessions[slotA]?.isConnected && !sessions[slotA]?.isLoggedOut;
    const readyB = sessions[slotB]?.isConnected && !sessions[slotB]?.isLoggedOut;
    if (!readyA || !readyB) {
      console.error(
        `[FEEDING] Pair ${singlePair + 1} not connected (${readyA ? 1 : 0}/2 accounts). Link both accounts first.`
      );
      process.exit(1);
    }
  } else {
    const ready = sessions.filter((s) => s?.isConnected && !s?.isLoggedOut).length;
    if (ready < accountCount()) {
      console.error(
        `[FEEDING] Only ${ready}/${accountCount()} accounts connected. Link all accounts in the desktop app first.`
      );
      process.exit(1);
    }
  }

  const language = process.env.LANGUAGE || 'English';
  console.log(`[OK] Language: ${language} (from .env)`);
  const pairsToRun = getPairsToRun();
  const feedingLabel = pairsToRun.length === 1
    ? `Pair ${pairsToRun[0] + 1}`
    : `${pairCount()} pair${pairCount() > 1 ? 's' : ''}`;
  console.log(`\n--- Desktop feeding (${feedingLabel}) ---\n`);
  totalMessagesSent = 0;
  const results = await runAllPairs(sessions, language, accountProxies);

  const completed = results.filter((r) => r?.status === 'completed').length;
  const stopped = results.filter((r) => r?.status === 'stopped').length;

  await reportFeedingComplete({
    completed,
    stopped,
    totalPairs: pairsToRun.length,
    messagesSent: totalMessagesSent,
    success: stopped === 0,
  });

  console.log('');
  console.log('='.repeat(50));
  console.log(`Feeding done (${totalMessagesSent} messages sent)`);
  console.log('='.repeat(50));

  for (const session of sessions) {
    if (session) await session.shutdown();
  }
  process.exit(0);
}

if (isDesktopFeeding()) {
  runDesktopFeedingOnce().catch((err) => {
    console.error('[FEEDING]', err.message || err);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
