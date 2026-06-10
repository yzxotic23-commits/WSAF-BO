const CODEX_CHAT_MODEL_PRIORITY = [
  'gpt-5.4',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.2',
  'gpt-5.1',
  'gpt-5',
  'gpt-4o',
  'gpt-4o-mini',
];

const OPENAI_CHAT_MODEL_PRIORITY = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4-turbo',
  'gpt-4',
  'chatgpt-4o-latest',
  'gpt-3.5-turbo',
  'o3-mini',
  'o3',
  'o1-mini',
  'o1',
];

const OPENAI_MODEL_EXCLUDE_KEYWORDS = [
  'instruct', 'audio', 'realtime', 'transcribe', 'search', 'embedding',
  'whisper', 'dall-e', 'tts', 'moderation', 'davinci', 'babbage', 'legacy',
];

let openaiFallbackLogged = false;
let aiInitPromise = null;
let aiInitLogged = false;
let topicsEnvWarned = false;

function logOnce(message) {
  if (aiInitLogged) return;
  console.log(message);
}

const OLLAMA_MAX_PARALLEL = Math.max(1, parseInt(process.env.OLLAMA_PARALLEL || '4', 10));

const OLLAMA_MODEL_PRIORITY = [
  'llama3.2', 'llama3.1', 'llama3', 'qwen2.5', 'qwen2', 'gemma2', 'gemma',
  'mistral', 'phi3', 'phi', 'deepseek', 'tinyllama', 'orca-mini', 'vicuna',
];

const OLLAMA_MODEL_EXCLUDE = [
  'embed', 'embedding', 'bge', 'nomic-embed', 'mxbai-embed', 'vision', 'vl',
];
let ollamaActiveRequests = 0;
const ollamaWaitQueue = [];

async function acquireOllamaSlot() {
  if (ollamaActiveRequests < OLLAMA_MAX_PARALLEL) {
    ollamaActiveRequests++;
    return;
  }
  await new Promise((resolve) => ollamaWaitQueue.push(resolve));
  ollamaActiveRequests++;
}

function releaseOllamaSlot() {
  ollamaActiveRequests = Math.max(0, ollamaActiveRequests - 1);
  const next = ollamaWaitQueue.shift();
  if (next) next();
}

class AIProvider {
  constructor() {
    this.logTag = '';
    this.primaryProvider = process.env.AI_PROVIDER_PRIMARY || 'openai';
    this.fallbackProvider = process.env.AI_PROVIDER_FALLBACK || 'ollama';
    this.activeProvider = this.primaryProvider;
    this.language = process.env.LANGUAGE || 'Indonesia';
    this.conversationHistory = [];
    this.messagesSent = 0;
    this.openaiReady = false;
    this.openaiAuthMode = 'api_key';
    this.ollamaReady = false;
    this.ollamaModels = [];
    this.ollamaModelIndex = 0;
    this.ollamaFailedModels = new Set();
    this.sessionTopic = '';
  }

  setSessionTopic(topic) {
    this.sessionTopic = topic || '';
  }

  setLogTag(tag) {
    this.logTag = tag || '';
  }

  aiLog(message) {
    if (this.logTag) {
      console.log(`${this.logTag} ${message}`);
    }
  }

  applySharedInit(shared) {
    this.openaiReady = shared.openaiReady;
    this.openaiModel = shared.openaiModel;
    this.openaiClient = shared.openaiClient;
    this.ollamaReady = shared.ollamaReady;
    this.ollamaUrl = shared.ollamaUrl;
    this.ollamaModel = shared.ollamaModel;
    this.ollamaModels = [...shared.ollamaModels];
    this.ollamaModelIndex = shared.ollamaModelIndex;
    this.activeProvider = shared.activeProvider;
  }

  snapshotInit() {
    return {
      openaiReady: this.openaiReady,
      openaiModel: this.openaiModel,
      openaiClient: this.openaiClient,
      ollamaReady: this.ollamaReady,
      ollamaUrl: this.ollamaUrl,
      ollamaModel: this.ollamaModel,
      ollamaModels: [...this.ollamaModels],
      ollamaModelIndex: this.ollamaModelIndex,
      activeProvider: this.activeProvider,
    };
  }

  logInitSummary() {
    if (aiInitLogged) return;
    aiInitLogged = true;

    if (this.openaiReady) {
      const label = this.openaiAuthMode === 'codex'
        ? `Codex OAuth (${this.openaiModel})`
        : `OpenAI API (${this.openaiModel})`;
      const fb = this.ollamaReady ? ` · fallback: Ollama ${this.ollamaModel}` : '';
      console.log(`[OK] AI active: ${label}${fb}`);
      return;
    }
    if (this.ollamaReady) {
      console.log(`[OK] AI active: Ollama ${this.ollamaModel} (OpenAI/Codex unavailable)`);
      return;
    }
    console.log('[WARN] AI: no provider ready');
  }

  async initialize() {
    if (aiInitPromise) {
      try {
        const shared = await aiInitPromise;
        this.applySharedInit(shared);
        return;
      } catch {
        aiInitPromise = null;
        aiInitLogged = false;
      }
    }

    aiInitPromise = this._initializeFirst();
    try {
      const shared = await aiInitPromise;
      this.applySharedInit(shared);
    } catch (err) {
      aiInitPromise = null;
      aiInitLogged = false;
      throw err;
    }
  }

  async _initializeFirst() {
    const authMode = (process.env.OPENAI_AUTH_MODE || 'api_key').trim().toLowerCase();

    if (authMode === 'codex') {
      await this.initOpenAICodex();
      if (!this.openaiReady) {
        logOnce('[WARN] Codex OAuth failed — trying API key if set');
        await this.initOpenAIApiKey();
      }
    } else {
      await this.initOpenAIApiKey();
      if (!this.openaiReady && authMode === 'auto') {
        logOnce('[..] No API key — trying Codex OAuth subscription');
        await this.initOpenAICodex();
      }
    }

    await this.initOllama();

    if (!this.openaiReady && !this.ollamaReady) {
      const codex = require('./codex-oauth');
      const hint = codex.getCodexLoginHint();
      const msg = `No AI provider available. ${hint.replace(/\n/g, ' ')} Or start Ollama (ollama serve).`;
      console.error(`[ERROR] ${msg}`);
      if (!process.versions?.electron && process.env.DESKTOP_FEEDING !== '1') {
        console.error(hint);
        console.error('Or start Ollama: ollama serve');
      }
      throw new Error(msg);
    }

    this.activeProvider = this.openaiReady ? 'openai' : 'ollama';
    this.logInitSummary();
    return this.snapshotInit();
  }

  isChatCapableOpenAIModel(modelId) {
    const id = modelId.toLowerCase();
    if (OPENAI_MODEL_EXCLUDE_KEYWORDS.some((kw) => id.includes(kw))) return false;
    return /^(gpt-|o\d|chatgpt-)/i.test(modelId);
  }

  filterChatModels(modelIds) {
    return modelIds.filter((id) => this.isChatCapableOpenAIModel(id));
  }

  resolveModelMatch(available, baseName) {
    if (available.includes(baseName)) return baseName;
    const matches = available.filter((id) => id === baseName || id.startsWith(`${baseName}-`));
    if (matches.length === 0) return null;
    matches.sort((a, b) => b.localeCompare(a));
    return matches[0];
  }

  parseEnvOpenAIModel() {
    const raw = process.env.OPENAI_MODEL?.trim();
    if (!raw || raw.toLowerCase() === 'auto') return null;

    const validPattern = /^(gpt-|o\d|chatgpt-)/i;
    if (validPattern.test(raw) && !raw.includes('/')) return raw;

    logOnce(`[WARN] OPENAI_MODEL "${raw}" invalid — auto-detect`);
    return null;
  }

  async fetchAvailableOpenAIModels(client) {
    const response = await client.models.list();
    return response.data.map((m) => m.id);
  }

  async detectOpenAIModel(client, options = {}) {
    const envPreference = this.parseEnvOpenAIModel();
    const priority = options.codex ? CODEX_CHAT_MODEL_PRIORITY : OPENAI_CHAT_MODEL_PRIORITY;
    let available = [];

    try {
      available = await this.fetchAvailableOpenAIModels(client);
    } catch (err) {
      logOnce(`[WARN] OpenAI model list failed: ${err.message}`);
      if (options.requireLive) return null;
      if (options.codex) return envPreference || 'gpt-5.3-codex';
      return envPreference || 'gpt-4o-mini';
    }

    const chatModels = options.codex
      ? available.filter((id) => !OPENAI_MODEL_EXCLUDE_KEYWORDS.some((kw) => id.toLowerCase().includes(kw)))
      : this.filterChatModels(available);

    if (chatModels.length === 0) {
      logOnce('[WARN] No supported chat models from provider');
      return null;
    }

    if (envPreference) {
      const preferred = this.resolveModelMatch(chatModels, envPreference)
        || chatModels.find((id) => id.startsWith(envPreference));
      if (preferred) {
        logOnce(`[OK] Model: ${preferred}`);
        return preferred;
      }
      logOnce(`[WARN] OPENAI_MODEL "${envPreference}" not in account — auto-detect`);
    }

    for (const base of priority) {
      const match = this.resolveModelMatch(chatModels, base);
      if (match) {
        logOnce(`[OK] Model: ${match}`);
        return match;
      }
    }

    const fallback = [...chatModels].sort((a, b) => b.localeCompare(a))[0];
    logOnce(`[OK] Model: ${fallback}`);
    return fallback;
  }

  async initOpenAICodex() {
    const codex = require('./codex-oauth');
    const result = await codex.startCodexProxy();
    if (!result.ok) {
      logOnce(`[WARN] ${result.message}`);
      return;
    }

    try {
      const OpenAI = require('openai');
      const baseURL = codex.normalizeBaseURL(result.baseURL);
      this.openaiClient = new OpenAI({
        apiKey: 'codex-oauth',
        baseURL,
      });
      const model = await this.detectOpenAIModel(this.openaiClient, { codex: true, requireLive: true });
      if (!model) return;

      this.openaiModel = model;
      this.openaiAuthMode = 'codex';
      this.openaiReady = true;
      if (result.external) {
        logOnce(`[OK] Codex OAuth via shared proxy ${baseURL}`);
      } else {
        logOnce(`[OK] Codex OAuth proxy ${baseURL} (auth: ${result.authFile})`);
      }
    } catch (err) {
      logOnce(`[WARN] Codex OAuth init failed: ${err.message}`);
    }
  }

  async initOpenAIApiKey() {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      logOnce('[WARN] OPENAI_API_KEY not set — API key mode disabled');
      return;
    }

    try {
      const OpenAI = require('openai');
      this.openaiClient = new OpenAI({ apiKey });
      const model = await this.detectOpenAIModel(this.openaiClient);
      if (!model) return;

      this.openaiModel = model;
      this.openaiAuthMode = 'api_key';
      this.openaiReady = true;
    } catch (err) {
      logOnce(`[WARN] OpenAI init failed: ${err.message}`);
    }
  }

  isChatCapableOllamaModel(name) {
    const id = (name || '').toLowerCase();
    if (OLLAMA_MODEL_EXCLUDE.some((kw) => id.includes(kw))) return false;
    return true;
  }

  rankOllamaModels(installed) {
    const chat = installed.filter((m) => this.isChatCapableOllamaModel(m));
    const score = (name) => {
      const base = name.split(':')[0].toLowerCase();
      const idx = OLLAMA_MODEL_PRIORITY.findIndex((p) => base === p || base.startsWith(p));
      return idx >= 0 ? idx : 999;
    };
    return [...chat].sort((a, b) => {
      const diff = score(a) - score(b);
      if (diff !== 0) return diff;
      return a.localeCompare(b);
    });
  }

  buildOllamaModelList(installed) {
    const envRaw = (process.env.OLLAMA_MODEL || 'llama3.2').trim();
    if (envRaw.toLowerCase() === 'auto') {
      return this.rankOllamaModels(installed);
    }

    const preferred = envRaw.split(',').map((s) => s.trim()).filter(Boolean);
    const list = [];
    for (const pref of preferred) {
      const match = installed.find((m) => m === pref || m.startsWith(`${pref}:`));
      if (match && !list.includes(match)) list.push(match);
    }
    for (const m of this.rankOllamaModels(installed)) {
      if (!list.includes(m)) list.push(m);
    }
    return list;
  }

  async initOllama() {
    this.ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';

    try {
      const res = await fetch(`${this.ollamaUrl}/api/tags`);
      if (!res.ok) throw new Error('Ollama not responding');
      const data = await res.json();
      const installed = data.models?.map((m) => m.name) || [];

      this.ollamaModels = this.buildOllamaModelList(installed);
      if (this.ollamaModels.length === 0) {
        const primary = (process.env.OLLAMA_MODEL || 'llama3.2').split(',')[0].trim();
        console.log(`[..] No Ollama chat models found — pulling ${primary}...`);
        await this.pullOllamaModel(primary);
        const res2 = await fetch(`${this.ollamaUrl}/api/tags`);
        const data2 = await res2.json();
        const installed2 = data2.models?.map((m) => m.name) || [];
        this.ollamaModels = this.buildOllamaModelList(installed2);
      }

      if (this.ollamaModels.length === 0) {
        throw new Error('No usable Ollama models after pull');
      }

      this.ollamaModel = this.ollamaModels[0];
      this.ollamaModelIndex = 0;
      this.ollamaReady = true;

    } catch (err) {
      logOnce(`[WARN] Ollama unavailable at ${this.ollamaUrl}`);
    }
  }

  async pullOllamaModel(name) {
    const modelName = name || this.ollamaModel;
    const res = await fetch(`${this.ollamaUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName, stream: false }),
    });
    if (!res.ok) {
      throw new Error(`Failed to pull model ${modelName}`);
    }
    console.log(`[OK] Model ${modelName} downloaded successfully!`);
  }

  isOllamaModelSwitchError(error) {
    const msg = (error?.message || '').toLowerCase();
    const retryable = [
      '429', 'rate', 'limit', 'overload', 'busy', 'memory', 'cuda', 'gpu',
      'runner', 'timeout', '503', '502', '500', 'load failed', 'unable to load',
      'not found', 'does not exist', 'resource', 'exhausted', 'oom',
    ];
    return retryable.some((kw) => msg.includes(kw));
  }

  switchOllamaModel(reason) {
    if (this.ollamaModels.length <= 1) return false;

    const failed = this.ollamaModel;
    this.ollamaFailedModels.add(failed);

    for (let i = 1; i <= this.ollamaModels.length; i++) {
      const idx = (this.ollamaModelIndex + i) % this.ollamaModels.length;
      const next = this.ollamaModels[idx];
      if (!this.ollamaFailedModels.has(next)) {
        this.ollamaModelIndex = idx;
        this.ollamaModel = next;
        console.log(`[AI] Ollama: ${failed} failed (${reason}) — trying ${next}`);
        return true;
      }
    }

    this.ollamaFailedModels.clear();
    return false;
  }

  isConnectionError(error) {
    const message = (error?.message || '').toLowerCase();
    const code = String(error?.code || '').toLowerCase();
    return (
      message.includes('connection error')
      || message.includes('econnrefused')
      || message.includes('fetch failed')
      || message.includes('socket hang up')
      || message.includes('network')
      || code === 'econnrefused'
      || code === 'und_err_connect_timeout'
    );
  }

  isOpenAIRetryableError(error) {
    const status = error?.status || error?.response?.status;
    const code = error?.code || error?.error?.code;
    const message = (error?.message || '').toLowerCase();

    if (this.isConnectionError(error)) return true;
    if (status === 429 || status === 408) return true;
    if (status >= 500 && status < 600) return true;
    if (code === 'rate_limit_exceeded') return true;
    return message.includes('rate limit') || message.includes('timeout') || message.includes('econnreset');
  }

  isOpenAIFallbackError(error) {
    if (this.isConnectionError(error)) return true;

    const status = error?.status || error?.response?.status;
    const code = error?.code || error?.error?.code;
    const message = (error?.message || '').toLowerCase();

    if (this.isOpenAIRetryableError(error)) return true;
    if (status === 400 || status === 404) return true;

    const fallbackCodes = [
      'insufficient_quota',
      'billing_hard_limit_reached',
      'invalid_api_key',
      'model_not_found',
      'invalid_model',
    ];
    if (fallbackCodes.includes(code)) return true;

    const fallbackMessages = [
      'insufficient_quota',
      'quota',
      'billing',
      'invalid api key',
      'incorrect api key',
      'unauthorized',
      'invalid model',
      'model_not_found',
    ];
    return fallbackMessages.some((kw) => message.includes(kw));
  }

  formatOpenAIError(error) {
    const status = error?.status || error?.response?.status;
    const code = error?.code || error?.error?.code;
    const msg = error?.message || String(error);
    const base = [status && `HTTP ${status}`, code, msg].filter(Boolean).join(' — ');
    if (this.isConnectionError(error)) {
      return `${base} — token mungkin expired (login Codex ulang), cek internet/VPN, atau install Ollama sebagai fallback`;
    }
    return base;
  }

  async refreshCodexClient() {
    if (this.openaiAuthMode !== 'codex') return false;
    try {
      let baseURL = null;

      if (process.env.DESKTOP_FEEDING === '1') {
        const port = process.env.DESKTOP_API_PORT || '47821';
        const res = await fetch(`http://127.0.0.1:${port}/api/auth/codex/restart`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = await res.json().catch(() => ({}));
        if (!data.ok || !data.baseURL) return false;
        baseURL = data.baseURL;
        process.env.CODEX_PROXY_BASE_URL = baseURL;
      } else {
        const codex = require('./codex-oauth');
        await codex.stopCodexProxy();
        delete process.env.CODEX_PROXY_BASE_URL;
        const result = await codex.startCodexProxy();
        if (!result.ok) return false;
        baseURL = codex.normalizeBaseURL(result.baseURL);
        process.env.CODEX_PROXY_BASE_URL = baseURL;
      }

      const OpenAI = require('openai');
      this.openaiClient = new OpenAI({
        apiKey: 'codex-oauth',
        baseURL: baseURL.endsWith('/v1') ? baseURL : `${baseURL.replace(/\/+$/, '')}/v1`,
      });
      return true;
    } catch {
      return false;
    }
  }

  formatFallbackReason(reason) {
    const msg = (reason || '').toLowerCase();
    if (msg.includes('429') || msg.includes('quota') || msg.includes('billing')) {
      return 'OpenAI quota exceeded — using Ollama for this session';
    }
    if (msg.includes('invalid model')) return 'invalid OpenAI model — using Ollama';
    return reason;
  }

  switchToFallback(reason, error = null) {
    if (!this.ollamaReady) {
      console.error(`[AI] OpenAI failed and Ollama is off: ${this.formatFallbackReason(reason)}`);
      if (error) console.error(`[AI] Detail: ${this.formatOpenAIError(error)}`);
      return false;
    }
    if (this.activeProvider !== 'ollama') {
      this.activeProvider = 'ollama';
    }
    console.warn(`[AI] OpenAI failed — using Ollama for this session (${this.formatFallbackReason(reason)})`);
    if (error) console.warn(`[AI] OpenAI error: ${this.formatOpenAIError(error)}`);
    openaiFallbackLogged = true;
    return true;
  }

  getTopics() {
    const byLanguage = {
      Indonesia: [
        'teknologi terbaru', 'resep masakan', 'film dan series', 'olahraga', 'traveling',
        'bisnis dan startup', 'kesehatan', 'musik', 'hobi unik', 'berita terkini',
        'game', 'investasi', 'AI dan masa depan',
      ],
      English: [
        'latest tech', 'cooking recipes', 'movies and series', 'sports', 'travel',
        'startups', 'health', 'music', 'hobbies', 'news', 'gaming', 'investing', 'AI',
      ],
      Melayu: [
        'teknologi terkini', 'resepi masakan', 'filem dan series', 'sukan', 'travel',
        'perniagaan', 'kesihatan', 'muzik', 'hobi', 'berita', 'game', 'pelaburan',
      ],
      Chinese: [
        '科技新闻', '美食菜谱', '影视剧', '运动健身', '旅行',
        '创业商业', '健康养生', '音乐', '兴趣爱好', '时事新闻', '游戏', '投资理财', '人工智能',
      ],
    };

    const topicsEnv = (process.env.TOPICS || '').trim();
    if (topicsEnv && this.language === 'Indonesia') {
      return topicsEnv.split(',').map((t) => t.trim()).filter(Boolean);
    }
    if (topicsEnv && this.language !== 'Indonesia' && !topicsEnvWarned) {
      topicsEnvWarned = true;
      console.log(`[WARN] TOPICS in .env ignored — using ${this.language} topic list`);
    }

    return byLanguage[this.language] || byLanguage.English;
  }

  getStrictLanguageRule() {
    const rules = {
      Indonesia:
        'ATURAN WAJIB: Balas HANYA bahasa Indonesia casual. Dilarang pakai English, Melayu, atau Chinese.',
      English:
        'MANDATORY: Reply ONLY in casual English. Do NOT use Indonesian, Malay, or Chinese.',
      Melayu:
        'WAJIB: Balas HANYA bahasa Melayu casual. Jangan guna Indonesia, English, atau Chinese.',
      Chinese:
        '硬性规定：只用简体中文回复。禁止使用印尼语、马来语、英语（网络梗如666、lol可以）。',
    };
    return rules[this.language] || rules.English;
  }

  getRandomTopic() {
    const topics = this.getTopics();
    return topics[Math.floor(Math.random() * topics.length)];
  }

  buildSystemPrompt(accountName, partnerName) {
    const lock = this.getStrictLanguageRule();

    const prompts = {
      Indonesia: `${lock}

Kamu ${accountName}, chat WhatsApp santai dengan ${partnerName}.
Bahasa Indonesia gaul (gw, lu, wkwk). 1-3 kalimat pendek. Jangan bilang kamu AI.`,
      English: `${lock}

You are ${accountName}, casually chatting on WhatsApp with ${partnerName}.
Informal English (lol, btw, ngl). 1-3 short sentences. Never say you are AI.`,
      Melayu: `${lock}

Kau ${accountName}, bersembang santai di WhatsApp dengan ${partnerName}.
Melayu casual (lah, kan, wei). 1-3 ayat pendek. Jangan katakan kau AI.`,
      Chinese: `${lock}

你是${accountName}，在WhatsApp上和好友${partnerName}闲聊。
简体中文口语（哈哈、666、yyds）。1-3句，简短自然。不要说你是AI。`,
    };

    return prompts[this.language] || prompts.English;
  }

  generateGreeting() {
    const greetings = {
      'Indonesia': [
        'Heyy', 'Woi', 'Bro', 'Eh', 'Halo bro', 'Hey bro',
        'Woy haha', 'Eh bro', 'Halo2', 'Yo'
      ],
      'English': [
        'Hey', 'Yo', 'Sup', 'Hey man', 'Heyy', 'Bro',
        'What\'s up', 'Yoo', 'Hey dude', 'Heyyy'
      ],
      'Melayu': [
        'Wei', 'Eh bro', 'Helo', 'Weh', 'Hey', 'Bro',
        'Yo', 'Hoi', 'Eh', 'Assalamualaikum'
      ],
      'Chinese': [
        '嘿', '在吗', '哈喽', '嘿嘿', '兄弟', '哥们',
        '在不在', '嗨', '你好呀', '喂'
      ]
    };

    const list = greetings[this.language] || greetings['Indonesia'];
    return list[Math.floor(Math.random() * list.length)];
  }

  async generateOpener(accountName, partnerName) {
    const topic = this.getRandomTopic();
    const greeting = this.generateGreeting();

    const langOpen = {
      'Indonesia': `${this.getStrictLanguageRule()}
Mulai chat ke teman. Topik: ${topic}. Satu kalimat Indonesia casual, contoh: "${greeting}, apa kabar?"`,
      'English': `${this.getStrictLanguageRule()}
Start a chat with your friend. Topic: ${topic}. One casual English sentence, e.g. "${greeting}, how's it going?"`,
      'Melayu': `${this.getStrictLanguageRule()}
Mula borak dengan kawan. Topik: ${topic}. Satu ayat Melayu casual, contoh: "${greeting}, apa khabar?"`,
      'Chinese': `${this.getStrictLanguageRule()}
你想和朋友开始聊天。话题：${topic}。
只用简体中文写1句话，例如："${greeting}，最近怎么样？"或"${greeting}，在干嘛？"。禁止印尼语/英语。`
    };

    const prompt = langOpen[this.language] || langOpen.English;
    this.sessionTopic = topic;
    this.messagesSent = 1;
    return this.generate(prompt, accountName, partnerName, true);
  }

  formatTranscript(transcript) {
    return transcript
      .slice(-14)
      .map((entry) => `${entry.from}: ${entry.text}`)
      .join('\n');
  }

  isPingMessage(text) {
    const t = (text || '').trim().toLowerCase();
    if (t.length > 40) return false;
    return /^(hey|yo|sup|wei|eh|hello|hi|bro|嘿|在吗|哈喽)/.test(t)
      && /(there|around|still|ada|on|在|吗|\?)/.test(t);
  }

  buildReplyPrompt(incomingMessage, accountName, partnerName, transcript = []) {
    const lock = this.getStrictLanguageRule();
    const topicLine = this.sessionTopic
      ? `Topic / 话题: ${this.sessionTopic}\n`
      : '';

    const coherenceRules = {
      Indonesia: 'Jawab sesuai konteks. Jangan ganti topik. Jawab pertanyaan yang belum dijawab.',
      English: 'Stay in context. Do not change topic. Answer unanswered questions first.',
      Melayu: 'Ikut konteks. Jangan tukar topik. Jawab soalan yang belum dijawab.',
      Chinese: '根据上下文回复。不要换话题。先回答未回复的问题。',
    };
    const rule = coherenceRules[this.language] || coherenceRules.English;

    if (transcript.length > 0) {
      const log = this.formatTranscript(transcript);
      const pingNotes = {
        Indonesia: '\n(Dia cek kamu masih online — jawab singkat, tetap satu bahasa Indonesia.)',
        English: '\n(They check if you are still there — brief reply, stay in English only.)',
        Melayu: '\n(Dia tanya masih ada — jawab ringkas, kekal Melayu sahaja.)',
        Chinese: '\n(对方确认你是否还在 — 简短回复，保持简体中文。)',
      };
      const pingNote = this.isPingMessage(incomingMessage)
        ? (pingNotes[this.language] || pingNotes.English)
        : '';

      const replyHeader = {
        Indonesia: `Hanya tulis balasan ${accountName} (1-3 kalimat, bahasa Indonesia):`,
        English: `Write ONLY ${accountName}'s reply (1-3 sentences, English):`,
        Melayu: `Hanya balasan ${accountName} (1-3 ayat, bahasa Melayu):`,
        Chinese: `只写${accountName}的回复（1-3句，简体中文）：`,
      };

      return `${lock}
${topicLine}
Chat:
${log}
${partnerName}: ${incomingMessage}

${replyHeader[this.language] || replyHeader.English}
${rule}${pingNote}`;
    }

    const langReply = {
      Indonesia: `${lock}\n${partnerName} bilang: "${incomingMessage}"\nBalas 1-3 kalimat, topik: ${this.sessionTopic || 'ngobrol santai'}.`,
      English: `${lock}\n${partnerName} said: "${incomingMessage}"\nReply in 1-3 sentences, topic: ${this.sessionTopic || 'casual chat'}.`,
      Melayu: `${lock}\n${partnerName} cakap: "${incomingMessage}"\nBalas 1-3 ayat, topik: ${this.sessionTopic || 'borak santai'}.`,
      Chinese: `${lock}\n${partnerName}说："${incomingMessage}"\n用1-3句简体中文回复，话题：${this.sessionTopic || '闲聊'}。`,
    };

    return langReply[this.language] || langReply.English;
  }

  async generateReply(incomingMessage, accountName, partnerName, transcript = []) {
    this.messagesSent++;
    const prompt = this.buildReplyPrompt(incomingMessage, accountName, partnerName, transcript);
    const useFreshContext = transcript.length > 0;
    return this.generate(prompt, accountName, partnerName, useFreshContext);
  }

  async generate(userPrompt, accountName, partnerName, isNew) {
    const systemPrompt = this.buildSystemPrompt(accountName, partnerName);

    if (isNew) {
      this.conversationHistory = [];
    }

    this.conversationHistory.push({ role: 'user', content: userPrompt });

    if (this.conversationHistory.length > 20) {
      this.conversationHistory = this.conversationHistory.slice(-10);
    }

    const openaiAttempts = this.openaiReady ? 2 : 0;
    let lastError = null;

    for (let attempt = 0; attempt <= openaiAttempts; attempt++) {
      try {
        if (this.activeProvider === 'openai' && this.openaiReady) {
          return await this.generateOpenAI(systemPrompt);
        }
        if (this.ollamaReady) {
          return await this.generateOllama(systemPrompt);
        }
        throw new Error('No AI provider available');
      } catch (error) {
        lastError = error;

        if (
          this.activeProvider === 'openai'
          && this.openaiReady
          && attempt < openaiAttempts
          && (this.isOpenAIRetryableError(error) || this.isConnectionError(error))
        ) {
          if (this.isConnectionError(error) && attempt === 0) {
            const refreshed = await this.refreshCodexClient();
            if (refreshed) {
              console.log('[AI] Codex proxy refreshed — retrying…');
            }
          }
          console.log(`[AI] OpenAI retry (${attempt + 2}/${openaiAttempts + 1}): ${error.message}`);
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }

        if (this.activeProvider === 'openai' && this.isOpenAIFallbackError(error)) {
          const switched = this.switchToFallback(error.message, error);
          if (switched) {
            try {
              return await this.generateOllama(systemPrompt);
            } catch (ollamaErr) {
              console.error(`[AI Error] Ollama also failed: ${ollamaErr.message}`);
            }
          }
          return this.getFallbackReply();
        }

        console.error(`[AI Error] ${this.formatOpenAIError(error)}`);
        return this.getFallbackReply();
      }
    }

    if (lastError) console.error(`[AI Error] ${this.formatOpenAIError(lastError)}`);
    return this.getFallbackReply();
  }

  async generateOpenAI(systemPrompt) {
    const params = {
      model: this.openaiModel,
      messages: [
        { role: 'system', content: systemPrompt },
        ...this.conversationHistory,
      ],
      max_tokens: 100,
    };
    // Codex/reasoning models (gpt-5.x) do not support temperature — skip to avoid AI SDK warning
    const isReasoning = /^gpt-5/i.test(this.openaiModel || '');
    if (this.openaiAuthMode !== 'codex' && !isReasoning) {
      params.temperature = 0.9;
    }

    const response = await this.openaiClient.chat.completions.create(params);

    const reply = response.choices[0].message.content.trim();
    this.conversationHistory.push({ role: 'assistant', content: reply });
    return reply;
  }

  async generateOllama(systemPrompt) {
    await acquireOllamaSlot();
    try {
      const errors = [];
      const attempts = this.ollamaModels.length || 1;

      for (let i = 0; i < attempts; i++) {
        const model = this.ollamaModel;
        try {
          return await this._generateOllamaRequest(systemPrompt, model);
        } catch (err) {
          errors.push(`${model}: ${err.message}`);
          if (!this.isOllamaModelSwitchError(err) || !this.switchOllamaModel(err.message)) {
            break;
          }
        }
      }

      throw new Error(errors.join(' | ') || 'Ollama request failed');
    } finally {
      releaseOllamaSlot();
    }
  }

  async _generateOllamaRequest(systemPrompt, modelName) {
    const model = modelName || this.ollamaModel;
    const messages = [
      { role: 'system', content: systemPrompt },
      ...this.conversationHistory
    ];

    const response = await fetch(`${this.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: {
          temperature: this.language === 'Chinese' ? 0.75 : 0.85,
          num_predict: 100,
        }
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Ollama ${model} ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    const reply = data.message?.content?.trim();
    if (!reply) {
      throw new Error(`Ollama ${model} returned empty reply`);
    }
    this.conversationHistory.push({ role: 'assistant', content: reply });
    return reply;
  }

  getFallbackReply() {
    const fallbacks = {
      'Indonesia': ['wkwk iya bener banget', 'oh gitu ya, menarik sih', 'hmm bisa jadi sih', 'wah keren tuh', 'haha iya juga ya', 'btw lu lagi ngapain?'],
      'English': ['lol yeah totally', 'oh really? thats cool', 'hmm makes sense', 'no way thats awesome', 'haha true', 'btw what are you up to?'],
      'Melayu': ['haha betul la tu', 'eh serious? best la', 'hmm boleh jadi jugak', 'weh gempak la', 'haha kan', 'wei kau tengah buat apa?'],
      'Chinese': ['哈哈对对对', '真的吗？厉害了', '嗯有道理', '666太强了', '哈哈确实', '话说你在干嘛？']
    };

    const list = fallbacks[this.language] || fallbacks.English;
    return list[Math.floor(Math.random() * list.length)];
  }
}

module.exports = AIProvider;
