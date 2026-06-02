const path = require('path');
const {
  getAppDataRoot,
  getEnvPath,
  getLoginPrefsPath,
  ensureAppDataLayout,
} = require('./src/app-paths');

ensureAppDataLayout();
require('dotenv').config({ path: getEnvPath() });
require('./src/silence-libsignal-logs');
if (process.env.AI_SDK_LOG_WARNINGS === undefined) {
  process.env.AI_SDK_LOG_WARNINGS = 'false';
}
const readline = require('readline');
const fs = require('fs');
const WhatsAppSession = require('./src/whatsapp-session');
const AIProvider = require('./src/ai-provider');
const ProxyManager = require('./src/proxy-manager');

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
const PAIR_COUNT = Math.max(1, parseInt(process.env.PAIR_COUNT || '1', 10));
const ACCOUNT_START = Math.max(1, parseInt(process.env.ACCOUNT_START || '1', 10));
const ACCOUNT_COUNT = PAIR_COUNT * 2;
const ACCOUNT_END = ACCOUNT_START + ACCOUNT_COUNT - 1;

function getAccountName(slotIndex) {
  return `account${ACCOUNT_START + slotIndex}`;
}

function getAccountLabel(slotIndex) {
  return `Account${ACCOUNT_START + slotIndex}`;
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

function logOut(pairNum, from, to, text, count, suffix = '') {
  const extra = suffix ? ` ${suffix}` : '';
  log(pairNum, `${from} → ${to}: ${oneLine(text)} ${msgCount(count)}${extra}`);
}

function logNudge(pairNum, from, to, text, nudgeNum) {
  log(pairNum, `${from} → ${to}: ${oneLine(text)} (nudge ${nudgeNum}/${PAIR_MAX_NUDGES})`);
}

function logTyping(pairNum, who, sec) {
  log(pairNum, `${who} typing... ${sec}s`);
}

function isNonInteractive() {
  return process.env.WA_NON_INTERACTIVE === '1' || process.env.WA_DESKTOP_MODE === '1';
}

function ask(question) {
  if (isNonInteractive()) {
    return Promise.resolve('');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const LOGIN_PREFS_PATH = getLoginPrefsPath();

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

  if (isNonInteractive()) {
    const forced = (process.env.WA_LOGIN_METHOD || 'qr').toLowerCase();
    return forced === 'pairing' ? 'pairing' : 'qr';
  }
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
 */
async function prepareLoginPlans() {
  const plans = new Map();
  const needLink = [];
  const prefs = readLoginPrefs();

  for (let i = 0; i < ACCOUNT_COUNT; i++) {
    const name = getAccountName(i);
    const probe = new WhatsAppSession(name);
    const auth = probe.getAuthStatus();

    if (auth.valid) {
      plans.set(name, { skipLogin: true, auth });
    } else {
      if (auth.saved && !auth.valid) {
        probe.deleteAuthFolder();
        console.log(`[LOGIN] ${name}: removed invalid auth — will ask login`);
      }
      const reason = !auth.saved ? 'no auth folder' : 'invalid session cleared';
      needLink.push({ name, reason });
    }
  }

  if (needLink.length === 0) {
    console.log('');
    console.log('[LOGIN] All accounts have valid saved sessions — no login prompts.');
    return plans;
  }

  console.log('');
  console.log(`[LOGIN] ${needLink.length} account(s) need linking:`);
  for (const { name, reason } of needLink) {
    console.log(`  - ${name} (${reason})`);
  }

  let defaultMethod = null;
  if (needLink.length > 1) {
    if (isNonInteractive()) {
      const forced = (process.env.WA_LOGIN_METHOD || 'qr').toLowerCase();
      defaultMethod = forced === 'pairing' ? 'pairing' : 'qr';
      console.log(`[LOGIN] Default method (auto): ${defaultMethod === 'pairing' ? 'pairing code' : 'QR scan'}`);
    } else {
      defaultMethod = await askLoginMethodChoice(
        `LOGIN — default for ${needLink.length} new account(s)`
      );
      console.log(`[LOGIN] Default method: ${defaultMethod === 'pairing' ? 'pairing code' : 'QR scan'}`);
    }
  }

  for (const { name } of needLink) {
    const options = await resolveLoginOptions(name, prefs, needLink.length > 1 ? defaultMethod : null);
    plans.set(name, options);
  }

  return plans;
}

async function selectLanguage() {
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

  const languages = { '1': 'Indonesia', '2': 'English', '3': 'Melayu', '4': 'Chinese' };
  let choice = '';
  if (isNonInteractive()) {
    const fromEnv = process.env.WA_LANGUAGE?.trim();
    if (fromEnv) {
      const selected = Object.values(languages).includes(fromEnv) ? fromEnv : 'Indonesia';
      console.log(`[OK] Language (auto): ${selected}`);
      return selected;
    }
    choice = process.env.WA_LANGUAGE_CHOICE || '1';
  } else {
    choice = await ask('Choose language (1-4): ');
  }

  const selected = languages[choice] || process.env.WA_LANGUAGE || 'Indonesia';
  console.log(`[OK] Language set to: ${selected}`);
  return selected;
}

async function askPostFeedingAction() {
  console.log('');
  console.log('='.repeat(50));
  console.log('FEEDING DONE — NEXT STEP');
  console.log('='.repeat(50));
  console.log('');
  console.log('  1. Continue (keep session, no QR)');
  console.log('  2. New session (logout all + link again)');
  console.log('  3. Exit');
  console.log('');

  let choice = '';
  if (isNonInteractive()) {
    const action = (process.env.WA_POST_FEEDING || 'exit').toLowerCase();
    if (action === 'new') return 'new';
    if (action === 'continue') return 'continue';
    return 'exit';
  }
  choice = await ask('Choose (1-3): ');

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

async function runPairSession(sessionA, sessionB, language, pairNum, labelA, labelB, controller, aiA, aiB) {
  const jidA = sessionA.getMyJid();
  const jidB = sessionB.getMyJid();
  sessionA.setExpectedPartner(jidB);
  sessionB.setExpectedPartner(jidA);

  // Cross-inject LIDs from creds.json so the bot sends to LID from the start
  // (no need to wait for a manual message to learn the partner's LID)
  const lidA = sessionA.getMyLid();  // Account A's own LID (as seen by B)
  const lidB = sessionB.getMyLid();  // Account B's own LID (as seen by A)
  if (lidA) {
    sessionB.learnPartnerLid(lidA, 'creds_seed');
    log(pairNum, `LID seed: ${labelA} → ${lidA}`);
  }
  if (lidB) {
    sessionA.learnPartnerLid(lidB, 'creds_seed');
    log(pairNum, `LID seed: ${labelB} → ${lidB}`);
  }

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
  let waitingForLabel = labelB;
  let replyingAsLabel = '';
  let finishPair = null;
  const chatTranscript = [];
  const recentOutbound = [];
  const messageQueue = [];
  const inboundCount = { A: 0, B: 0 };
  const ignoredInboundLog = { A: false, B: false };

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
      const waitingSession = waitingForLabel === labelA ? sessionA : sessionB;
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
          const waitingSide = waitingForLabel === labelA ? 'A' : 'B';
          if (
            lastChatTo === waitingForLabel &&
            lastChatFrom &&
            inboundCount[waitingSide] === 0 &&
            idleSec >= 45
          ) {
            if (!deliveryWarnShown) {
              deliveryWarnShown = true;
              log(
                pairNum,
                `[WARN] ${waitingForLabel} has not received ${lastChatFrom}'s message in bot ` +
                `(recv=0). Check chat on phone — nudge skipped until message arrives.`
              );
            }
            return;
          }

          const fromA = waitingForLabel === labelB;
          const nudgeSession = fromA ? sessionA : sessionB;
          const nudgeJid = fromA ? jidB : jidA;
          const fromLabel = fromA ? labelA : labelB;
          const toLabel = fromA ? labelB : labelA;

          lastNudgeAt = Date.now();
          log(
            pairNum,
            `No reply ${idleSec}s — nudge ${fromLabel} -> ${toLabel} ` +
            `(waiting for ${waitingForLabel}; recv ${labelA}=${recvA} ${labelB}=${recvB})`
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
              logNudge(pairNum, fromLabel, toLabel, nudge, nudgeCount);
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
          `wa-connected=${partnerConnected} recv(${labelA}=${recvA},${labelB}=${recvB})`
        );
      }
    }, 15000);
  };

  const stopPair = (reason) => {
    if (controller.isPairStopped(pairNum)) return;
    clearIdleWatch();
    log(pairNum, '');
    log(pairNum, `Stopped: ${reason}`);
    if (PAIR_COUNT > 1) log(pairNum, 'Other pairs keep running.');
    log(pairNum, '');
    controller.stopPair(pairNum, reason);
  };

  log(pairNum, `Started | ${language} | max ${MAX_MESSAGES} msgs`);
  log(pairNum, `${labelA}: ${sessionA.getPhone()} | ${labelB}: ${sessionB.getPhone()}`);

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

    onLoggedOutA = () => stopPair(`${labelA} logged out`);
    onLoggedOutB = () => stopPair(`${labelB} logged out`);
    sessionA.on('loggedOut', onLoggedOutA);
    sessionB.on('loggedOut', onLoggedOutB);

    const onPolicyAlert = (label) => (alert) => {
      if (alert.severity === 'critical') {
        stopPair(`${label}: ${alert.type} — check phone for WA restriction`);
      }
    };
    sessionA.on('policyAlert', onPolicyAlert(labelA));
    sessionB.on('policyAlert', onPolicyAlert(labelB));

    processInbound = async (side, sender, text) => {
      if (controller.isPairStopped(pairNum)) return;
      if (chatMessageCount >= MAX_MESSAGES) return;

      const isA = side === 'A';
      const recvLabel = isA ? labelB : labelA;
      const sendLabel = isA ? labelA : labelB;

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
        recordChat(recvLabel, text);
        nudgeCount = 0;

        const delay = randomDelay();
        logTyping(pairNum, sendLabel, Math.round(delay / 1000));
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
        logOut(pairNum, sendLabel, recvLabel, reply, chatMessageCount);

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
            `[WARN] ${side === 'A' ? labelA : labelB} ignored inbound ` +
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

    sessionA.on('message', onInbound('A', sessionA, jidB, labelB));
    sessionB.on('message', onInbound('B', sessionB, jidA, labelA));

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
        replyingAsLabel = labelA;
        const openerDelay = randomDelay();
        logTyping(pairNum, labelA, Math.round(Math.min(openerDelay, 15000) / 1000));
        await sleep(Math.min(openerDelay, 15000));

        const opener = await aiA.generateOpener(labelA, labelB);
        const topic = aiA.sessionTopic;
        aiB.setSessionTopic(topic);

        if (controller.isPairStopped(pairNum)) return;

        const sent = await sessionA.sendMessage(jidB, opener);
        if (!sent) {
          isReplying = false;
          replyingAsLabel = '';
          stopPair(`Opener send failed — ${labelB} may be logged out`);
          return;
        }

        isReplying = false;
        replyingAsLabel = '';

        chatMessageCount++;
        totalMessagesSent++;
        recordOutbound(labelA, opener);
        markWaitingFor(labelB);
        lastChatFrom = labelA;
        lastChatTo = labelB;
        recordChat(labelA, opener);
        logOut(pairNum, labelA, labelB, opener, chatMessageCount);
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

async function runAllPairs(sessions, language) {
  const controller = new PairChatController();
  const pairConfigs = [];

  console.log('');
  console.log(`[SESSION] ${PAIR_COUNT} pair(s) | ${language}`);

  for (let p = 0; p < PAIR_COUNT; p++) {
    const aiA = new AIProvider();
    const aiB = new AIProvider();
    aiA.language = language;
    aiB.language = language;

    const labelA = getAccountLabel(p * 2);
    const labelB = getAccountLabel(p * 2 + 1);
    aiA.setLogTag(`[Pair ${p + 1}] [${labelA}]`);
    aiB.setLogTag(`[Pair ${p + 1}] [${labelB}]`);

    pairConfigs.push({
      pairNum: p + 1,
      sessionA: sessions[p * 2],
      sessionB: sessions[p * 2 + 1],
      labelA,
      labelB,
      aiA,
      aiB,
    });
  }

  await Promise.all(
    pairConfigs.flatMap(({ aiA, aiB }) => [aiA.initialize(), aiB.initialize()])
  );

  for (const cfg of pairConfigs) {
    log(cfg.pairNum, `${cfg.labelA} <-> ${cfg.labelB}`);
  }
  console.log('');

  const tasks = pairConfigs.map(({ pairNum, sessionA, sessionB, labelA, labelB, aiA, aiB }) =>
    runPairSession(sessionA, sessionB, language, pairNum, labelA, labelB, controller, aiA, aiB)
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
  console.log(`[SESSION] Done: ${completed} | Stopped: ${stopped} | Total: ${PAIR_COUNT}`);

  return results;
}

async function assignAccountProxies(proxyManager) {
  const probeEnabled = process.env.PROXY_PROBE !== 'false';
  let accountProxies;

  if (probeEnabled) {
    accountProxies = await proxyManager.assignWorkingForAccounts(
      ACCOUNT_COUNT,
      (i) => getAccountName(i)
    );
  } else {
    accountProxies = proxyManager.assignForAccounts(ACCOUNT_COUNT);
    console.log('[PROXY] PROXY_PROBE=false — using fixed slot order (no rotation test)');
  }

  const n = proxyManager.proxies.length;

  if (n > 0 && n < ACCOUNT_COUNT && !probeEnabled) {
    console.log(`[PROXY] ${n} proxy(ies) for ${ACCOUNT_COUNT} accounts — slots reuse proxies round-robin`);
  }

  for (let p = 0; p < PAIR_COUNT; p++) {
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
  console.log('='.repeat(50));

  let ready = 0;
  let needLink = 0;

  for (let i = 0; i < ACCOUNT_COUNT; i++) {
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

/** direct = QR without proxy (recommended). rotate = try every proxy then direct. */
function getProxyQrLinkMode() {
  const mode = (process.env.PROXY_QR_LINK || 'direct').toLowerCase();
  return mode === 'rotate' ? 'rotate' : 'direct';
}

/**
 * New account: link via direct (default) or rotate proxies until QR works.
 * Returns proxy URL used for link, or null if direct.
 */
async function linkAccountWithProxyRotation(session, plan, sessionName, proxyManager, candidates) {
  const list = candidates.filter(Boolean);
  const probeTimeout = parseInt(process.env.PROXY_LINK_TRY_MS || '22000', 10);
  const qrMode = getProxyQrLinkMode();

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

async function connectAllSessions(hasProxies, proxyManager, accountProxies) {
  const sessions = [];
  const loginPlans = await prepareLoginPlans();

  for (let i = 0; i < ACCOUNT_COUNT; i++) {
    const sessionName = getAccountName(i);
    let plan = loginPlans.get(sessionName) || { method: 'qr' };

    console.log('');
    console.log('='.repeat(50));
    console.log(`STEP ${i + 1}/${ACCOUNT_COUNT}: Connect WhatsApp ${sessionName}`);
    console.log('='.repeat(50));

    const session = new WhatsAppSession(sessionName);
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
      console.log(`[LOGIN] ${sessionName}: saved session${phoneHint} — skipping login method`);
      if (proxyUrl) {
        session.setProxy(proxyUrl);
        console.log(`[PROXY] ${sessionName} → ${proxyManager.maskUrl(proxyUrl)}`);
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

    sessions.push(session);
  }

  return sessions;
}

async function reconnectSessionForContinue(session, proxyUrl, proxyManager) {
  session.resetForReconnect();
  session.clearReconnectTimer();

  const hasAuth = session.hasSavedAuth();
  if (!hasAuth) {
    console.log(`[RECONNECT] ${session.sessionName}: no saved session — scan QR`);
    if (proxyUrl) session.setProxy(proxyUrl);
    await session.connect({ method: 'qr' });
    return session.isConnected;
  }

  // Session linked or recovered on direct — never force proxy on Continue (avoids bad session + auth wipe)
  if (session.linkedViaDirect) {
    console.log(`[PROXY] ${session.sessionName}: reconnect on direct (session was linked without proxy)`);
    session.setProxy(null);
    await session.disconnect();
    await session.connect();
    return session.isConnected;
  }

  if (proxyUrl) {
    console.log(`[PROXY] ${session.sessionName} → ${proxyManager.maskUrl(proxyUrl)}`);
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

function printConnectedSummary(sessions, hasProxies, proxyManager, accountProxies) {
  const connected = sessions.filter((s) => s.isConnected && !s.isLoggedOut);
  const ready = connected.length;

  console.log('');
  console.log('='.repeat(50));
  if (ready === ACCOUNT_COUNT) {
    console.log(`All ${ACCOUNT_COUNT} accounts connected! (${PAIR_COUNT} pair${PAIR_COUNT > 1 ? 's' : ''})`);
  } else {
    console.log(`Connected: ${ready}/${ACCOUNT_COUNT} — fix failed accounts before feeding`);
  }
  console.log('='.repeat(50));

  for (let p = 0; p < PAIR_COUNT; p++) {
    const sessionA = sessions[p * 2];
    const sessionB = sessions[p * 2 + 1];
    const phoneA = sessionA.getPhone() || '(not linked)';
    const phoneB = sessionB.getPhone() || '(not linked)';
    const statusA = sessionA.isConnected ? 'ok' : 'OFFLINE';
    const statusB = sessionB.isConnected ? 'ok' : 'OFFLINE';
    let proxyInfo = '';
    if (hasProxies) {
      const slotA = p * 2;
      const slotB = p * 2 + 1;
      const liveA = sessionA.proxyUrl ? proxyManager.maskUrl(sessionA.proxyUrl) : 'direct';
      const liveB = sessionB.proxyUrl ? proxyManager.maskUrl(sessionB.proxyUrl) : 'direct';
      proxyInfo = ` | ${getAccountLabel(slotA)}: ${liveA} [${statusA}] | ${getAccountLabel(slotB)}: ${liveB} [${statusB}]`;
    } else {
      proxyInfo = ` | ${getAccountLabel(p * 2)} [${statusA}] | ${getAccountLabel(p * 2 + 1)} [${statusB}]`;
    }
    console.log(`  Pair ${p + 1}: ${phoneA} <-> ${phoneB}${proxyInfo}`);
  }

  if (!hasProxies) {
    console.log('  Proxy    : none (direct connection)');
  }
  console.log('='.repeat(50));

  if (ready < ACCOUNT_COUNT) {
    console.log('[WARN] Some accounts are offline — scan QR again or wait if account is on strict limit.');
  }
}

async function main() {
  if (!isNonInteractive()) {
    console.log(`[PATH] Data folder: ${getAppDataRoot()}`);
  }
  console.log('+===========================================+');
  console.log('|   WhatsApp Auto Chat - Terminal Edition   |');
  console.log('|   AI-Powered Conversation Generator      |');
  console.log('+===========================================+');
  console.log('');
  const aiPrimary = process.env.AI_PROVIDER_PRIMARY || 'openai';
  const aiFallback = process.env.AI_PROVIDER_FALLBACK || 'ollama';
  console.log(`AI Provider : ${aiPrimary} (fallback: ${aiFallback})`);
  console.log(`Pairs       : ${PAIR_COUNT} (account${ACCOUNT_START}–${ACCOUNT_END}, ${ACCOUNT_COUNT} accounts)`);
  console.log(`Delay       : ${process.env.MIN_DELAY || 30}s - ${process.env.MAX_DELAY || 90}s`);
  console.log(`Max Messages: ${MAX_MESSAGES} per pair per session`);
  console.log(`Idle stop   : ${PAIR_STOP_ON_IDLE ? `yes (${PAIR_IDLE_TIMEOUT_MS / 1000}s)` : 'no (keeps waiting)'}`);
  console.log('');

  const proxyManager = new ProxyManager();
  const hasProxies = proxyManager.load();
  const accountProxies = hasProxies ? await assignAccountProxies(proxyManager) : [];

  if (hasProxies) {
    const qrMode = getProxyQrLinkMode();
    console.log(
      `[PROXY] Probe = TCP check only. QR link mode: ${qrMode}` +
      (qrMode === 'direct' ? ' (recommended — WA blocks QR on proxy IPs)' : ' (tries all proxies, then direct)')
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

    console.log(`\n--- Session #${sessionNumber} (${PAIR_COUNT} pair${PAIR_COUNT > 1 ? 's' : ''} in parallel) ---\n`);
    totalMessagesSent = 0;
    await runAllPairs(sessions, language);

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
      if (ready < ACCOUNT_COUNT) {
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

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
