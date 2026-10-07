#!/usr/bin/env node
'use strict';

/*
 * 大肥狗AI —— 把你自己伪装成一个 LLM 的 OpenAI 兼容网关
 *
 * 工作方式：
 *   客户端(Cline / Roo Code / Cherry Studio ...) 按标准 OpenAI 协议发请求
 *   -> 网关把请求挂起，推进待办队列
 *   -> 你在 /admin 控制台亲手打字、亲手挑工具调用
 *   -> 你敲的内容被拆成 SSE chunk，按模型流式输出的格式吐回去
 *
 * 零依赖，只用 Node 内置模块。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

const DEFAULT_CONFIG = {
  port: 8787,
  host: '0.0.0.0',
  productName: '大肥狗AI',        // 页面标题、品牌名都用它，想换名字改这里
  modelId: 'fat-dog',
  modelDisplayName: '大肥狗AI',
  adminPassword: '',             // 留空 = 首次运行随机生成（别用固定占位符：这代码是发给别人跑的）
  publicUrl: '',                 // 部署后的公网地址，如 https://xxx.app.workbuddy.host（本机跑可留空）
  apiKeys: [],
  rateLimitPerMinute: 30,
  maxPending: 50,
  requestTimeoutMinutes: 30,
  heartbeatSeconds: 15,
  maxBodyMB: 8,
  maxUploadMB: 10
};

function makeApiKey() {
  return 'sk-me-' + crypto.randomBytes(20).toString('hex');
}

function loadConfig() {
  const fresh = !fs.existsSync(CONFIG_PATH);
  let cfg = { ...DEFAULT_CONFIG };
  if (!fresh) {
    try {
      cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    } catch (e) {
      console.error('[warn] config.json 解析失败，使用默认配置:', e.message);
    }
  }
  let touched = fresh;

  // 首次运行随机生成管理密码。
  // 不用「change-this-...」这类固定占位符 —— 这份代码是给别人跑的，
  // 默认密码可猜就等于没有密码，而控制台是公网可达的。
  if (!cfg.adminPassword) {
    cfg.adminPassword = 'hm-' + crypto.randomBytes(9).toString('base64url');
    touched = true;
  }
  if (!Array.isArray(cfg.apiKeys) || cfg.apiKeys.length === 0) {
    cfg.apiKeys = [{ key: makeApiKey(), name: 'default', createdAt: Date.now() }];
    touched = true;
  }
  if (fresh || touched) {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
    } catch (e) {
      console.error('[warn] 无法写入 config.json:', e.message);
    }
  }
  return cfg;
}

let CONFIG = loadConfig();

// 部署平台会把端口注入 PORT 环境变量；本机跑则用 config.json 里的
const PORT = Number(process.env.PORT) || CONFIG.port;
const HOST = process.env.HOST || CONFIG.host;
const IS_HOSTED = !!process.env.PORT;

/**
 * 这次请求对外应该用的地址。
 *
 * **不能直接信 req.headers.host** —— 反代会把 Host 改写成内部地址。
 * 实测某平台的边缘网关会把 `https://你的域名/…` 转成
 * `https://3000-<沙箱id>.e2b.bj9.sandbox.cloudstudio.club/…`，
 * 直接拿它拼，教程页里就会印出一串对方根本打不开的内网地址。
 *
 * 优先级：
 *   1. config.publicUrl —— 操作员明确声明的对外地址，最可靠
 *   2. X-Forwarded-Host / X-Forwarded-Proto —— 反代的标准头
 *   3. Host —— 直连（本机跑就是这条）
 */
function requestOrigin(req) {
  const cfgUrl = String(CONFIG.publicUrl || '').replace(/\/+$/, '');
  if (cfgUrl) return cfgUrl;

  const xfHost = String((req && req.headers && req.headers['x-forwarded-host']) || '').split(',')[0].trim();
  const host = xfHost || (req && req.headers && req.headers.host) || ('127.0.0.1:' + PORT);

  let proto = String((req && req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim();
  if (proto !== 'http' && proto !== 'https') {
    proto = /^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(host) ? 'http' : 'https';
  }
  return proto + '://' + host;
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2), 'utf8');
  } catch (e) {
    console.error('[warn] 无法写入 config.json:', e.message);
  }
}

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

/** @type {Map<string, Task>} */
const tasks = new Map();
/** 已完成任务的环形日志，供控制台回看 */
const history = [];
const HISTORY_MAX = 300;

/*
 * 对话归档：每条结束的对话追加落盘，重启之后仍然翻得到。
 *
 * 用 JSONL（一行一条）而不是一个大 JSON —— 追加写只要 appendFileSync 一行，
 * 不需要每次把整个文件读出来重写，几百条记录也不会越写越慢。
 *
 * 图片**不存**：对方发来的图是几 MB 的 data URI，存进去文件会爆炸，
 * 正文里已经有「[图片 N]」占位，这里只额外记一个 imageCount。
 */
const ARCHIVE_FILE = path.join(ROOT, 'history.jsonl');
const ARCHIVE_MAX = 1000;
let archive = [];                 // 内存里的最近 ARCHIVE_MAX 条
let archiveWarned = false;        // 写失败只提示一次，别刷屏

function loadArchive() {
  try {
    if (!fs.existsSync(ARCHIVE_FILE)) return 0;
    const out = [];
    for (const line of fs.readFileSync(ARCHIVE_FILE, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      const r = parseJsonLoose(s);
      if (r && r.id) out.push(r);
    }
    archive = out.slice(-ARCHIVE_MAX);
    // 顺手把「最近完成」侧栏也喂上 —— 否则重启后侧栏是空的，
    // 但打开历史却又看得到记录，会显得自相矛盾。
    // 只放摘要字段：历史记录里的 messages 有几十 KB，塞进列表接口会把响应撑大。
    for (const r of archive.slice(-HISTORY_MAX)) {
      history.push({
        id: r.id, createdAt: r.createdAt, closedAt: r.closedAt,
        source: r.source, model: r.model, status: r.status,
        finishReason: r.finishReason, text: r.text,
        toolCalls: r.toolCalls, lastMessage: r.lastMessage
      });
    }
    console.log('[归档] 载入 ' + archive.length + ' 条历史记录');
    return archive.length;
  } catch (e) {
    console.error('[归档] 读取失败：' + e.message);
    return 0;
  }
}

function archiveTask(task) {
  if (task.archived) return;      // 同一任务只归档一次
  task.archived = true;
  const rec = {
    id: task.id,
    createdAt: task.createdAt,
    closedAt: task.closedAt || Date.now(),
    source: task.source,
    model: task.model,
    keyName: task.keyName,
    stream: task.stream,
    status: task.status,
    finishReason: task.finishReason,
    text: task.text || '',
    toolCalls: task.toolCalls.map((tc) => ({ name: tc.name, arguments: tc.arguments })),
    lastMessage: taskSummary(task).lastMessage,
    messageCount: task.messages.length,
    toolCount: task.tools.length,
    imageCount: task.messages.reduce((a, m) => a + ((m.images && m.images.length) || 0), 0),
    messages: task.messages.map((m) => ({
      role: m.role,
      text: m.text,
      name: m.name,
      tool_call_id: m.tool_call_id,
      imageCount: (m.images && m.images.length) || 0
    }))
  };
  archive.push(rec);
  while (archive.length > ARCHIVE_MAX) archive.shift();
  try {
    fs.appendFileSync(ARCHIVE_FILE, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) {
    if (!archiveWarned) {
      archiveWarned = true;
      console.error('[归档] 写入失败（后续不再重复提示）：' + e.message);
    }
  }
}
/** 每个 key 的调用时间戳，用于限流 */
const rateBuckets = new Map();

let consoleRevision = 0; // 每次状态变化 +1，控制台长轮询用
function bump() { consoleRevision++; }

function nowSec() { return Math.floor(Date.now() / 1000); }

function uid(prefix) {
  return prefix + '_' + crypto.randomBytes(12).toString('hex');
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function json(res, code, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS'
  }, extraHeaders || {}));
  res.end(body);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 读请求体，返回 Buffer —— 图片这类二进制内容不能用上面那个字符串版 */
function readBodyBuffer(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonLoose(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

function splitChunks(s, n) {
  if (!s) return [];
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 把 messages 压成控制台能直接渲染的结构。
 *
 * 图片不能只留一个字面量 '[image]' —— 操作员要靠截图、图表、报错画面来判断怎么回，
 * 所以这里把 image_url 单独收进 message.images，交给控制台渲染成 <img>。
 * 文本里只留一个「[图片 N]」占位，方便和图片列表对上号。
 */
function summarizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => {
    const role = m.role || '?';
    let text = '';
    const images = [];
    if (typeof m.content === 'string') {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      const parts = [];
      for (const p of m.content) {
        if (!p) continue;
        if (p.type === 'text') { parts.push(p.text); continue; }
        if (p.type === 'image_url' || p.type === 'input_image' || p.type === 'image') {
          const u = (p.image_url && (p.image_url.url || p.image_url)) ||
                    p.url || p.data || p.source || '';
          if (u && typeof u === 'string') {
            images.push(u);
            parts.push('[图片 ' + images.length + ']');
          } else {
            parts.push('[图片]');
          }
          continue;
        }
        parts.push('[' + (p.type || 'part') + ']');
      }
      text = parts.join('\n');
    }
    if (m.tool_calls) {
      text += '\n[tool_calls] ' + JSON.stringify(m.tool_calls.flatMap((t) => [t.function && t.function.name]));
    }
    if (m.tool_call_id) text = '[tool_result ' + m.tool_call_id + ']\n' + text;
    const out = { role, text, name: m.name, tool_call_id: m.tool_call_id };
    if (images.length) out.images = images;
    return out;
  });
}

/* ------------------------------------------------------------------ */
/* SSE 输出                                                            */
/* ------------------------------------------------------------------ */

function chunkEnvelope(task, extra) {
  return {
    id: task.completionId,
    object: 'chat.completion.chunk',
    created: task.created,
    model: task.model,
    ...extra
  };
}

function sseRaw(task, payload) {
  // 非流式请求绝不能走这里：正文由 closeTask 一次性给出。
  // 一旦提前往 res 里写了 SSE 帧，closeTask 里的 writeHead 会抛
  // ERR_HTTP_HEADERS_SENT，响应永远不结束，客户端就挂死在那儿。
  if (!task.stream) return;
  if (!task.res || task.aborted || task.res.writableEnded) return;
  try {
    task.res.write('data: ' + JSON.stringify(payload) + '\n\n');
  } catch (e) { /* 客户端已断开 */ }
}

function sseDelta(task, delta, finishReason) {
  sseRaw(task, chunkEnvelope(task, {
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason || null }]
  }));
}

function sseUsage(task) {
  if (!task.includeUsage) return;
  const completion = task.text.length + task.toolCalls.reduce((a, t) => a + t.arguments.length + t.name.length, 0);
  sseRaw(task, chunkEnvelope(task, {
    choices: [],
    usage: {
      prompt_tokens: task.promptChars,
      completion_tokens: completion,
      total_tokens: task.promptChars + completion
    }
  }));
}

/** 开场：先吐一个 role:assistant 的空 delta，符合真实 OpenAI 行为 */
function startStream(task) {
  if (!task.stream || task.started) return;
  task.started = true;
  sseDelta(task, { role: 'assistant', content: '' }, null);
}

/**
 * 把控制台当前的全文同步给客户端。
 *
 * 关键约束：SSE 的 content 增量在客户端那边是**只往后接**的，
 * 不存在「整段重发会覆盖显示」这回事。所以只有「新文本是已发文本的延长」时才发后缀。
 *
 * 控制台一旦把内容改短或改乱（输入法把拼音/候选数字临时塞进输入框、或者退格），
 * 这里就什么都不发 —— 宁可让客户端停在已经发出去的那一段，也不能把整段重发，
 * 否则客户端会把旧内容再拼一遍，出现 `okok啊啊` 这种重复。
 * 这种情况把 task.diverged 置位，由控制台提示操作员。
 */
function pushText(task, fullText) {
  const next = String(fullText == null ? task.text : fullText);
  if (next === task.text) return 0;
  const sent = task.sentText || '';
  let delta = '';
  if (next.startsWith(sent)) {
    delta = next.slice(sent.length);
  } else if (!sent) {
    delta = next;                 // 还一个字都没发过，整段发是安全的
  }
  task.text = next;
  if (delta) {
    if (!task.started) startStream(task);
    sseDelta(task, { content: delta }, null);
    task.sentText = sent + delta;
    task.flushed = task.sentText.length;
    task.diverged = false;
  } else if (next !== sent) {
    task.diverged = true;         // 客户端已经收到的内容回不去，只能标记
  }
  bump();
  return delta.length;
}

/** 把已经累积的正文按小片吐出去，模拟打字机（用于「整段粘贴后发送」） */
async function flushAccumulated(task, sliceSize, delayMs) {
  if (!task.started) startStream(task);
  const full = task.text;
  const sent = task.sentText || '';
  if (!full.startsWith(sent)) { task.diverged = true; return; }
  let i = sent.length;
  while (i < full.length) {
    const next = Math.min(i + sliceSize, full.length);
    sseDelta(task, { content: full.slice(i, next) }, null);
    i = next;
    task.sentText = full.slice(0, i);
    task.flushed = i;
    await sleep(delayMs);
    if (task.aborted) return;
  }
}

/*
 * 工具调用参数的分片节奏。
 *
 * 小参数按 24 字符一块吐，看起来像模型在「写」参数；但参数可能非常大
 * （把一张图 base64 内嵌进写文件调用，能到 MB 级），固定 24 字符 + 12ms
 * 会变成几万帧、耗时十几分钟 —— 实际根本发不出去。
 * 所以按总长度反推分片大小和间隔，把整体耗时压在一个预算内。
 */
const TOOL_ARG_MAX_FRAMES = 120;
const TOOL_ARG_MAX_CHUNK = 8192;
const TOOL_ARG_BUDGET_MS = 1500;

function toolArgChunking(len) {
  const frames = Math.max(1, Math.min(TOOL_ARG_MAX_FRAMES, Math.ceil(len / 24)));
  const size = Math.min(TOOL_ARG_MAX_CHUNK, Math.max(24, Math.ceil(len / frames)));
  const actualFrames = Math.max(1, Math.ceil(len / size));
  const delay = Math.max(0, Math.min(12, Math.round(TOOL_ARG_BUDGET_MS / actualFrames)));
  return { size, delay };
}

/** 一次性把某个工具调用按 OpenAI 的 delta 结构吐出去 */
async function emitToolCall(task, name, argsJson) {
  if (!task.started) startStream(task);
  const index = task.toolCalls.length;
  const id = uid('call');
  const rec = { id, name, arguments: argsJson, index };
  task.toolCalls.push(rec);

  sseDelta(task, {
    tool_calls: [{
      index,
      id,
      type: 'function',
      function: { name, arguments: '' }
    }]
  }, null);

  const { size, delay } = toolArgChunking(argsJson.length);
  for (const piece of splitChunks(argsJson, size)) {
    sseDelta(task, {
      tool_calls: [{ index, function: { arguments: piece } }]
    }, null);
    if (delay) await sleep(delay);
    if (task.aborted) return;
  }
  bump();
}

/* ------------------------------------------------------------------ */
/* 任务生命周期                                                        */
/* ------------------------------------------------------------------ */

function createTask(opts) {
  const task = {
    id: uid('req'),
    completionId: uid('chatcmpl'),
    created: nowSec(),
    createdAt: Date.now(),
    model: opts.model,
    stream: opts.stream,
    includeUsage: opts.includeUsage,
    messages: summarizeMessages(opts.messages),
    rawMessages: opts.messages,
    systemPrompt: (opts.messages || []).filter((m) => m.role === 'system').map((m) => (
      typeof m.content === 'string' ? m.content : ''
    )).join('\n\n---\n\n'),
    tools: opts.tools || [],
    toolChoice: opts.toolChoice,
    source: opts.source,
    keyName: opts.keyName,
    host: opts.host || '',
    origin: opts.origin || '',
    promptChars: JSON.stringify(opts.messages || []).length,
    status: 'pending',       // pending | done | abandoned
    text: '',
    flushed: 0,
    sentText: '',            // 已经真正发给客户端的正文（增量只能往后接，用它做基准）
    diverged: false,         // 控制台改动过已发出的内容 → 客户端与输入框不再一致
    started: false,
    toolCalls: [],
    finishReason: null,
    res: null,
    heartbeat: null,
    expiryTimer: null,
    closedAt: null
  };
  tasks.set(task.id, task);
  bump();
  notifyConsole(task);
  return task;
}

/** 新请求到达时给控制台一个醒目的提示（服务端侧只记日志，声音在浏览器里做） */
function notifyConsole(task) {
  console.log('\n' + '='.repeat(66));
  console.log('[新请求] ' + task.id);
  console.log('  来源   : ' + task.source);
  console.log('  模型   : ' + task.model + (task.stream ? '  (stream)' : '  (non-stream)'));
  console.log('  消息数 : ' + task.messages.length + '   工具数: ' + task.tools.length);
  const last = task.messages[task.messages.length - 1];
  if (last) {
    console.log('  最后一条 [' + last.role + ']: ' + String(last.text).replace(/\s+/g, ' ').slice(0, 160));
  }
  // 请求是从哪个地址进来的，就该去哪个控制台回复 ——
  // 本机和公网是两个独立的队列，写死 127.0.0.1 会把人引到没东西的那个控制台。
  console.log('  -> 回复请打开 ' + (task.origin || requestOrigin(null)) + '/admin');
  console.log('='.repeat(66) + '\n');
}

function taskSummary(t) {
  return {
    id: t.id,
    createdAt: t.createdAt,
    ageMs: Date.now() - t.createdAt,
    model: t.model,
    stream: t.stream,
    status: t.status,
    source: t.source,
    keyName: t.keyName,
    messageCount: t.messages.length,
    toolCount: t.tools.length,
    textLength: t.text.length,
    sentLength: (t.sentText || '').length,
    diverged: !!t.diverged,
    toolCallCount: t.toolCalls.length,
    finishReason: t.finishReason,
    lastMessage: (() => {
      const last = t.messages[t.messages.length - 1];
      if (!last) return '';
      return String(last.text).replace(/\s+/g, ' ').slice(0, 120);
    })()
  };
}

function closeTask(task, finishReason) {
  if (task.status === 'done' || task.status === 'abandoned') return;
  task.status = 'done';
  task.finishReason = finishReason || task.finishReason || 'stop';
  task.closedAt = Date.now();
  if (task.heartbeat) { clearInterval(task.heartbeat); task.heartbeat = null; }
  if (task.expiryTimer) { clearTimeout(task.expiryTimer); task.expiryTimer = null; }

  const usagePrompt = task.promptChars;
  const usageCompletion = task.text.length + task.toolCalls.reduce((a, t) => a + t.name.length + t.arguments.length, 0);

  if (task.res && !task.res.writableEnded) {
    if (task.stream) {
      if (!task.started) startStream(task);
      sseUsage(task);
      sseDelta(task, {}, task.finishReason);
      try {
        task.res.write('data: [DONE]\n\n');
        task.res.end();
      } catch (e) { /* ignore */ }
    } else {
      let message;
      if (task.toolCalls.length) {
        message = {
          role: 'assistant',
          content: task.text || null,
          tool_calls: task.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments }
          }))
        };
      } else {
        message = { role: 'assistant', content: task.text };
      }
      json(task.res, 200, {
        id: task.completionId,
        object: 'chat.completion',
        created: task.created,
        model: task.model,
        choices: [{ index: 0, message, logprobs: null, finish_reason: task.finishReason }],
        usage: {
          prompt_tokens: usagePrompt,
          completion_tokens: usageCompletion,
          total_tokens: usagePrompt + usageCompletion
        }
      });
    }
  }

  history.push({
    id: task.id,
    createdAt: task.createdAt,
    closedAt: task.closedAt,
    source: task.source,
    model: task.model,
    status: task.status,
    finishReason: task.finishReason,
    text: task.text,
    toolCalls: task.toolCalls.map((tc) => ({ name: tc.name, arguments: tc.arguments })),
    lastMessage: taskSummary(task).lastMessage
  });
  while (history.length > HISTORY_MAX) history.shift();
  archiveTask(task);          // 落盘，重启后仍能翻看
  bump();
}

function abandonTask(task, why) {
  if (task.status !== 'pending') return;
  task.status = 'abandoned';
  task.finishReason = why || 'abandoned';
  task.closedAt = Date.now();
  if (task.heartbeat) { clearInterval(task.heartbeat); task.heartbeat = null; }
  if (task.expiryTimer) { clearTimeout(task.expiryTimer); task.expiryTimer = null; }
  console.log('[断开] ' + task.id + ' (' + why + ')');
  archiveTask(task);          // 被拒 / 超时也要留下记录
  bump();
}

/* ------------------------------------------------------------------ */
/* 鉴权 / 限流                                                         */
/* ------------------------------------------------------------------ */

function extractKey(req) {
  const auth = (req.headers['authorization'] || '').toString().trim();
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    return (m ? m[1] : auth).trim();
  }
  return (req.headers['x-api-key'] || req.headers['api-key'] || '').toString().trim() || null;
}

/** 把所有可能承载 key 的地方都收上来，任何一个命中就算通过。
 *  公网部署时反向代理可能往 Authorization 里塞自己的令牌，所以不能只认它一个。 */
function candidateKeys(req) {
  const out = [];
  if (req._pathKey) out.push(req._pathKey);   // /k/<key>/v1 里的那段
  const auth = (req.headers['authorization'] || '').toString().trim();
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    out.push(m ? m[1].trim() : auth);
  }
  for (const h of ['x-api-key', 'api-key', 'openai-api-key', 'x-dafeigou-key']) {
    const v = req.headers[h];
    if (v) out.push(String(v).trim());
  }
  try {
    const q = new URL(req.url, 'http://x').searchParams;
    for (const k of ['api_key', 'api-key', 'key']) {
      if (q.get(k)) out.push(q.get(k).trim());
    }
  } catch (e) { /* ignore */ }
  return [...new Set(out.filter(Boolean))];
}

function checkApiKey(req) {
  const cands = candidateKeys(req);
  if (!cands.length) return { ok: false, code: 401, msg: 'Missing API key. Send: Authorization: Bearer sk-me-...' };
  for (const c of cands) {
    const hit = CONFIG.apiKeys.find((k) => k.key === c);
    if (hit) return { ok: true, entry: hit, via: c };
  }
  return { ok: false, code: 401, msg: 'Invalid API key' };
}

/** 给「客户端到底发了什么 header」用的诊断信息（管理端可见） */
function headersBrief(req) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const s = Array.isArray(v) ? v.join(',') : String(v);
    h[k] = s.length > 120 ? s.slice(0, 60) + '…' + s.slice(-20) : s;
  }
  return h;
}

function checkRate(keyStr) {
  const limit = CONFIG.rateLimitPerMinute || 0;
  if (!limit) return true;
  const now = Date.now();
  const bucket = (rateBuckets.get(keyStr) || []).filter((t) => now - t < 60000);
  if (bucket.length >= limit) { rateBuckets.set(keyStr, bucket); return false; }
  bucket.push(now);
  rateBuckets.set(keyStr, bucket);
  return true;
}

/* ------------------------------------------------------------------ */
/* 登录失败限流                                                        */
/*                                                                     */
/* 控制台是公网可达的，而管理密码同时是登录口令和 x-admin-token 的值。   */
/* 一旦密码取得短、好猜，无限次重试就等于没有防护。这里按失败次数阶梯    */
/* 封禁来源 IP —— 越试越久，字典爆破很快会撞墙。                        */
/* ------------------------------------------------------------------ */

const AUTH_FAIL_RESET_MS = 60 * 60 * 1000;   // 这么久没再失败就把计数清零
const AUTH_FAIL_LADDER = [                   // 累计失败次数 → 封禁时长（从高到低匹配）
  { fails: 8, blockMs: 30 * 60 * 1000 },
  { fails: 6, blockMs: 5 * 60 * 1000 },
  { fails: 4, blockMs: 60 * 1000 }
];
const authFails = new Map();                 // ip -> { count, lastAt, blockedUntil }

/* 平台的反代会在 x-forwarded-for 里带上真实来源；拿不到就退回 socket 地址。 */
function adminClientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** 剩余封禁毫秒数；0 表示没被拦 */
function authBlockRemaining(ip) {
  const rec = authFails.get(ip);
  if (!rec) return 0;
  const now = Date.now();
  if (rec.blockedUntil > now) return rec.blockedUntil - now;
  if (now - rec.lastAt > AUTH_FAIL_RESET_MS) authFails.delete(ip);
  return 0;
}

function noteAuthFail(ip) {
  const now = Date.now();
  let rec = authFails.get(ip);
  if (!rec || now - rec.lastAt > AUTH_FAIL_RESET_MS) rec = { count: 0, lastAt: now, blockedUntil: 0 };
  rec.count++;
  rec.lastAt = now;
  for (const rung of AUTH_FAIL_LADDER) {
    if (rec.count >= rung.fails) { rec.blockedUntil = now + rung.blockMs; break; }
  }
  authFails.set(ip, rec);
  return rec;
}

function clearAuthFails(ip) { authFails.delete(ip); }

/** 已被封禁就直接回 429 并返回 true，调用方应立即 return */
function rejectIfAuthBlocked(req, res) {
  const left = authBlockRemaining(adminClientIp(req));
  if (!left) return false;
  json(res, 429, {
    ok: false,
    error: '密码错误次数过多，已暂时锁定，约 ' + Math.ceil(left / 60000) + ' 分钟后再试'
  }, { 'Retry-After': String(Math.ceil(left / 1000)) });
  return true;
}

// 定期清掉过期记录，避免 Map 无限增长
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of authFails) {
    if (rec.blockedUntil < now && now - rec.lastAt > AUTH_FAIL_RESET_MS) authFails.delete(ip);
  }
}, 10 * 60 * 1000).unref();

function checkAdmin(req) {
  const t = req.headers['x-admin-token'] || '';
  return t && t === CONFIG.adminPassword;
}

/* ------------------------------------------------------------------ */
/* 图片附件                                                            */
/*                                                                     */
/* 操作员要把图发给对方时，控制台先把图传到网关，换回一个短链接；        */
/* 回复里带上这个链接，对方（或 harness 的界面）点开 / 渲染就能看到。    */
/* 注意：存在内存里 —— pod 重启（重新发布）就没了，这点要跟用户讲清楚。 */
/* ------------------------------------------------------------------ */

const attachments = new Map();      // id -> { buf, mime, name, createdAt }

const ATTACH_MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg'
};
const ATTACH_MAX_KEEP = 40;                         // 最多同时留这么多张
const ATTACH_TTL_MS = 6 * 60 * 60 * 1000;           // 6 小时后自动清掉

function attachSweep() {
  const now = Date.now();
  for (const [id, a] of attachments) {
    if (now - a.createdAt > ATTACH_TTL_MS) attachments.delete(id);
  }
  while (attachments.size > ATTACH_MAX_KEEP) {
    attachments.delete(attachments.keys().next().value);   // Map 保持插入序，删最早的
  }
}

function guessSource(req) {
  const ua = (req.headers['user-agent'] || '').toString();
  if (/cline/i.test(ua)) return 'Cline';
  if (/roo/i.test(ua)) return 'Roo Code';
  if (/cursor/i.test(ua)) return 'Cursor';
  if (/cherry/i.test(ua)) return 'Cherry Studio';
  if (/continue/i.test(ua)) return 'Continue';
  if (/node|axios|openai|python|httpx|okhttp|curl/i.test(ua)) return 'SDK/CLI (' + ua.slice(0, 40) + ')';
  return ua ? ua.slice(0, 48) : '未知客户端';
}

/* ------------------------------------------------------------------ */
/* 路由：OpenAI 兼容 API                                               */
/* ------------------------------------------------------------------ */

function handleModels(req, res) {
  const auth = checkApiKey(req);
  if (!auth.ok) return json(res, auth.code, { error: { message: auth.msg, type: 'invalid_request_error' } });
  json(res, 200, {
    object: 'list',
    data: [
      { id: CONFIG.modelId, object: 'model', created: nowSec(), owned_by: '大肥狗AI' },
      { id: 'gpt-4o', object: 'model', created: nowSec(), owned_by: '大肥狗AI' },
      { id: 'gpt-4o-mini', object: 'model', created: nowSec(), owned_by: '大肥狗AI' },
      { id: 'claude-sonnet-4', object: 'model', created: nowSec(), owned_by: '大肥狗AI' }
    ]
  });
}

async function handleChatCompletions(req, res) {
  const auth = checkApiKey(req);
  if (!auth.ok) return json(res, auth.code, { error: { message: auth.msg, type: 'invalid_request_error', code: 'invalid_api_key' } });
  if (!checkRate(auth.via || extractKey(req) || 'unknown')) {
    return json(res, 429, { error: { message: 'Rate limit exceeded', type: 'rate_limit_error' } });
  }

  let body;
  try {
    const raw = await readBody(req, (CONFIG.maxBodyMB || 8) * 1024 * 1024);
    body = JSON.parse(raw);
  } catch (e) {
    return json(res, 400, { error: { message: 'Bad JSON body: ' + e.message, type: 'invalid_request_error' } });
  }

  const pendingCount = [...tasks.values()].filter((t) => t.status === 'pending').length;
  if (pendingCount >= (CONFIG.maxPending || 50)) {
    return json(res, 503, { error: { message: '大肥狗AI is busy: too many pending requests', type: 'server_error' } });
  }

  const wantStream = body.stream !== false; // 默认按流式处理
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) {
    return json(res, 400, { error: { message: 'messages is required', type: 'invalid_request_error' } });
  }

  const task = createTask({
    model: body.model || CONFIG.modelId,
    messages,
    tools: Array.isArray(body.tools) ? body.tools : [],
    toolChoice: body.tool_choice,
    stream: wantStream,
    includeUsage: !!(body.stream_options && body.stream_options.include_usage),
    source: guessSource(req),
    keyName: auth.entry.name,
    host: req.headers.host || '',
    origin: requestOrigin(req)
  });

  if (wantStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*'
    });
    res.flushHeaders && res.flushHeaders();
    res.write(': ' + (CONFIG.productName || 'human-as-llm') + ' connected\n\n');
  }
  task.res = res;

  // SSE 心跳只对流式请求有意义。非流式请求的 res 还一个字都没写，
  // 在这里写任何东西都会让 closeTask 的 writeHead 抛 ERR_HTTP_HEADERS_SENT，
  // 响应永远不结束 —— 非流式客户端（Cherry Studio 那类）会直接挂死。
  // 而且非流式必然要等真人回复，超过 15 秒是常态，所以这个坑一定会踩到。
  if (task.stream) {
    task.heartbeat = setInterval(() => {
      if (task.res && !task.res.writableEnded) {
        try { task.res.write(': keepalive\n\n'); } catch (e) { /* ignore */ }
      }
    }, Math.max(5, CONFIG.heartbeatSeconds || 15) * 1000);
  }

  task.expiryTimer = setTimeout(() => {
    if (task.status === 'pending') {
      pushText(task, task.text || '[超时未回复]');
      closeTask(task, 'stop');
    }
  }, Math.max(1, CONFIG.requestTimeoutMinutes || 30) * 60000);

  res.on('close', () => {
    if (!res.writableEnded && task.status === 'pending') {
      abandonTask(task, '客户端提前断开');
    }
  });
}

/* ------------------------------------------------------------------ */
/* 路由：管理端 API                                                    */
/* ------------------------------------------------------------------ */

function requireAdmin(req, res) {
  if (rejectIfAuthBlocked(req, res)) return false;
  if (!checkAdmin(req)) {
    noteAuthFail(adminClientIp(req));
    json(res, 401, { error: '管理密码错误或未提供' });
    return false;
  }
  clearAuthFails(adminClientIp(req));
  return true;
}

function getTaskOr404(res, id) {
  const t = tasks.get(id);
  if (!t) { json(res, 404, { error: '任务不存在' }); return null; }
  return t;
}

async function handleAdmin(req, res, url) {
  const p = url.pathname;

  if (p === '/admin/api/login' && req.method === 'POST') {
    if (rejectIfAuthBlocked(req, res)) return;
    const body = parseJsonLoose(await readBody(req, 1e6)) || {};
    if (body.password === CONFIG.adminPassword) {
      clearAuthFails(adminClientIp(req));
      return json(res, 200, { ok: true, modelId: CONFIG.modelId });
    }
    noteAuthFail(adminClientIp(req));
    return json(res, 401, { ok: false, error: '密码不对' });
  }

  if (!requireAdmin(req, res)) return;

  /* 诊断：看看反向代理到底把请求原封不动转发了没 */
  if (p === '/admin/api/debug-headers' && req.method === 'GET') {
    return json(res, 200, {
      method: req.method,
      url: req.url,
      headers: headersBrief(req),
      candidates: candidateKeys(req).map((c) => c.slice(0, 14) + '…'),
      env: {
        PORT: process.env.PORT || null,
        hostname: require('os').hostname()
      }
    });
  }

  /* 任务列表 */
  if (p === '/admin/api/tasks' && req.method === 'GET') {
    const all = [...tasks.values()];
    const pending = all.filter((t) => t.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
    const recent = all.filter((t) => t.status !== 'pending').sort((a, b) => b.closedAt - a.closedAt).slice(0, 30);
    return json(res, 200, {
      revision: consoleRevision,
      serverTime: Date.now(),
      pending: pending.map(taskSummary),
      recent: recent.map(taskSummary),
      stats: {
        pendingCount: pending.length,
        totalToday: history.filter((h) => Date.now() - h.createdAt < 864e5).length
      },
      config: { modelId: CONFIG.modelId, heartbeatSeconds: CONFIG.heartbeatSeconds },
      history: history.slice(-30).reverse()
    });
  }

  /* 单个任务详情 */
  let m = /^\/admin\/api\/tasks\/([^/]+)$/.exec(p);
  if (m && req.method === 'GET') {
    const t = getTaskOr404(res, m[1]);
    if (!t) return;
    return json(res, 200, {
      ...taskSummary(t),
      systemPrompt: t.systemPrompt,
      messages: t.messages,
      tools: t.tools,
      toolChoice: t.toolChoice,
      text: t.text,
      sentText: t.sentText || '',
      diverged: !!t.diverged,
      toolCalls: t.toolCalls.map((tc) => ({ name: tc.name, arguments: tc.arguments }))
    });
  }

  /* 打字即流式：提交完整当前文本，服务端只发增量 */
  m = /^\/admin\/api\/tasks\/([^/]+)\/type$/.exec(p);
  if (m && req.method === 'POST') {
    const t = getTaskOr404(res, m[1]);
    if (!t) return;
    if (t.status !== 'pending') return json(res, 409, { error: '任务已结束' });
    const body = parseJsonLoose(await readBody(req, 4e6)) || {};
    const n = pushText(t, body.text);
    return json(res, 200, {
      ok: true, appended: n, totalLength: t.text.length,
      sentLength: (t.sentText || '').length, diverged: !!t.diverged
    });
  }

  /* 整段发送：把累积文本按打字机节奏补吐出去 */
  m = /^\/admin\/api\/tasks\/([^/]+)\/flush$/.exec(p);
  if (m && req.method === 'POST') {
    const t = getTaskOr404(res, m[1]);
    if (!t) return;
    if (t.status !== 'pending') return json(res, 409, { error: '任务已结束' });
    const body = parseJsonLoose(await readBody(req, 4e6)) || {};
    if (typeof body.text === 'string') t.text = body.text;
    if (body.sliceSize) {
      await flushAccumulated(t, Math.max(1, body.sliceSize), Math.max(0, body.delayMs || 12));
    } else {
      // 一次补齐剩余正文。基准是「已经真正发出去的 sentText」，不是 t.text ——
      // 拿 t.text 和它自己比是比不出增量的（那正是之前吞掉整条回复的 bug）。
      if (!t.started) startStream(t);
      const sent = t.sentText || '';
      if (t.text.startsWith(sent)) {
        const rest = t.text.slice(sent.length);
        if (rest) {
          sseDelta(t, { content: rest }, null);
          t.sentText = t.text;
          t.flushed = t.text.length;
          t.diverged = false;
          bump();
        }
      } else {
        t.diverged = true;      // 客户端已经收到的内容回不去
      }
    }
    return json(res, 200, {
      ok: true, totalLength: t.text.length,
      sentLength: (t.sentText || '').length, diverged: !!t.diverged
    });
  }

  /* 发送工具调用 */
  m = /^\/admin\/api\/tasks\/([^/]+)\/tool$/.exec(p);
  if (m && req.method === 'POST') {
    const t = getTaskOr404(res, m[1]);
    if (!t) return;
    if (t.status !== 'pending') return json(res, 409, { error: '任务已结束' });
    const body = parseJsonLoose(await readBody(req, 4e6)) || {};
    const name = String(body.name || '').trim();
    if (!name) return json(res, 400, { error: '缺少 name' });
    let args = body.arguments;
    if (typeof args !== 'string') args = JSON.stringify(args == null ? {} : args);
    const parsed = parseJsonLoose(args);
    if (parsed === null) return json(res, 400, { error: 'arguments 不是合法 JSON' });
    await emitToolCall(t, name, args);
    if (body.finish !== false) closeTask(t, 'tool_calls');
    return json(res, 200, { ok: true, toolCalls: t.toolCalls.length, closed: body.finish !== false });
  }

  /* 结束本轮回复 */
  m = /^\/admin\/api\/tasks\/([^/]+)\/finish$/.exec(p);
  if (m && req.method === 'POST') {
    const t = getTaskOr404(res, m[1]);
    if (!t) return;
    const body = parseJsonLoose(await readBody(req, 1e6)) || {};
    let fr = body.finishReason || (t.toolCalls.length ? 'tool_calls' : 'stop');
    // 兜底：粘贴一大段后直接点「结束回复」时，正文可能一个字节都没吐出去。
    // 关流前把「已发前缀」之后的剩余部分补完，避免回复被静默丢弃。
    if (t.stream && t.res && !t.res.writableEnded && t.text) {
      const sent = t.sentText || '';
      if (t.text.startsWith(sent) && t.text.length > sent.length) {
        if (!t.started) startStream(t);
        sseDelta(t, { content: t.text.slice(sent.length) }, null);
        t.sentText = t.text;
        t.flushed = t.text.length;
      }
    }
    if (!t.text && !t.toolCalls.length) t.text = '';
    closeTask(t, fr);
    return json(res, 200, { ok: true, finishReason: fr });
  }

  /* 放弃/取消 */
  m = /^\/admin\/api\/tasks\/([^/]+)\/cancel$/.exec(p);
  if (m && req.method === 'POST') {
    const t = getTaskOr404(res, m[1]);
    if (!t) return;
    if (t.status === 'pending') {
      abandonTask(t, '操作员取消');
      if (t.res && !t.res.writableEnded) {
        try {
          if (t.stream) {
            t.res.write('data: [DONE]\n\n');
            t.res.end();
          } else {
            // 非流式必须回一个合法的 chat.completion。
            // 直接 end() 会让客户端拿到空 body，JSON.parse 直接炸。
            json(t.res, 200, {
              id: t.completionId,
              object: 'chat.completion',
              created: t.created,
              model: t.model,
              choices: [{
                index: 0,
                message: { role: 'assistant', content: '' },
                logprobs: null,
                finish_reason: 'stop'
              }],
              usage: { prompt_tokens: t.promptChars, completion_tokens: 0, total_tokens: t.promptChars }
            });
          }
        } catch (e) { /* ignore */ }
      }
    }
    return json(res, 200, { ok: true });
  }

  /* 删除任务记录 */
  m = /^\/admin\/api\/tasks\/([^/]+)\/delete$/.exec(p);
  if (m && req.method === 'POST') {
    const t = tasks.get(m[1]);
    if (t) {
      if (t.heartbeat) clearInterval(t.heartbeat);
      if (t.expiryTimer) clearTimeout(t.expiryTimer);
      tasks.delete(m[1]);
      bump();
    }
    return json(res, 200, { ok: true });
  }

  /* Key 管理 */
  if (p === '/admin/api/keys' && req.method === 'GET') {
    return json(res, 200, {
      keys: CONFIG.apiKeys.map((k) => ({
        key: k.key.slice(0, 12) + '...' + k.key.slice(-4),
        full: k.key,
        name: k.name,
        createdAt: k.createdAt
      }))
    });
  }
  if (p === '/admin/api/keys' && req.method === 'POST') {
    const body = parseJsonLoose(await readBody(req, 1e6)) || {};
    const entry = { key: makeApiKey(), name: String(body.name || 'key-' + (CONFIG.apiKeys.length + 1)), createdAt: Date.now() };
    CONFIG.apiKeys.push(entry);
    saveConfig();
    return json(res, 200, { ok: true, key: entry.key, name: entry.name });
  }
  if (p === '/admin/api/keys' && req.method === 'DELETE') {
    const body = parseJsonLoose(await readBody(req, 1e6)) || {};
    const before = CONFIG.apiKeys.length;
    CONFIG.apiKeys = CONFIG.apiKeys.filter((k) => k.key !== body.key && k.name !== body.name);
    saveConfig();
    return json(res, 200, { ok: true, removed: before - CONFIG.apiKeys.length });
  }

  /* 历史归档：列表（支持关键词搜索 + 分页） */
  if (p === '/admin/api/history' && req.method === 'GET') {
    const qs = new URL(req.url, 'http://x').searchParams;
    const kw = (qs.get('q') || '').trim().toLowerCase();
    const limit = Math.min(200, Math.max(1, parseInt(qs.get('limit') || '50', 10) || 50));
    const offset = Math.max(0, parseInt(qs.get('offset') || '0', 10) || 0);

    let list = archive.slice().reverse();            // 新的在前
    if (kw) {
      list = list.filter((r) =>
        String(r.lastMessage || '').toLowerCase().includes(kw) ||
        String(r.text || '').toLowerCase().includes(kw) ||
        (Array.isArray(r.messages) && r.messages.some((m) => String(m.text || '').toLowerCase().includes(kw)))
      );
    }
    return json(res, 200, {
      total: list.length,
      offset: offset,
      limit: limit,
      items: list.slice(offset, offset + limit).map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        closedAt: r.closedAt,
        source: r.source,
        model: r.model,
        status: r.status,
        finishReason: r.finishReason,
        lastMessage: r.lastMessage,
        text: String(r.text || '').slice(0, 300),
        messageCount: r.messageCount,
        toolCount: r.toolCount,
        imageCount: r.imageCount,
        toolCallCount: (r.toolCalls || []).length
      }))
    });
  }

  /* 历史归档：清空（放单条之前，免得被 :id 规则抢走） */
  if (p === '/admin/api/history' && req.method === 'DELETE') {
    const n = archive.length;
    archive = [];
    try { if (fs.existsSync(ARCHIVE_FILE)) fs.unlinkSync(ARCHIVE_FILE); } catch (e) { /* ignore */ }
    return json(res, 200, { ok: true, removed: n });
  }

  /* 历史归档：单条全文 */
  m = /^\/admin\/api\/history\/([^/]+)$/.exec(p);
  if (m && req.method === 'GET') {
    const rec = archive.find((r) => r.id === m[1]);
    if (!rec) return json(res, 404, { error: '没有这条历史记录' });
    return json(res, 200, rec);
  }

  /* 上传图片附件：请求体就是图片原始字节，Content-Type 用图片的 mime */
  if (p === '/admin/api/upload' && req.method === 'POST') {
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = ATTACH_MIME_EXT[mime];
    if (!ext) {
      return json(res, 415, { error: '只收图片：png / jpg / gif / webp / bmp / svg，收到的是 ' + (mime || '未标注') });
    }
    const maxBytes = Math.max(1, CONFIG.maxUploadMB || 10) * 1024 * 1024;
    let buf;
    try {
      buf = await readBodyBuffer(req, maxBytes);
    } catch (e) {
      return json(res, 413, { error: '图片太大了，上限 ' + Math.round(maxBytes / 1048576) + ' MB' });
    }
    if (!buf || !buf.length) return json(res, 400, { error: '空内容' });

    const id = crypto.randomBytes(9).toString('hex');
    let name = String(req.headers['x-file-name'] || '');
    try { name = decodeURIComponent(name); } catch (e) { /* 原样用 */ }
    name = name.slice(0, 80) || ('image.' + ext);
    attachments.set(id, { buf, mime, name, createdAt: Date.now() });
    attachSweep();

    const path = '/att/' + id + '.' + ext;
    return json(res, 200, {
      ok: true, id, path, mime, name, bytes: buf.length,
      // 控制台把它插进回复框时，会把 path 拼成绝对地址
      markdown: '![' + name.replace(/[[\]]/g, '') + '](' + path + ')'
    });
  }

  return json(res, 404, { error: 'no such admin route: ' + p });
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png'
};

/*
 * 静态文件。HTML 会做一次占位符替换：
 *   {{PRODUCT}} → config.json 里的 productName
 *   {{ORIGIN}}  → 这次请求实际用的地址（https://你的域名 或 http://127.0.0.1:8787）
 *
 * 这样同一份代码落在谁手里、挂在哪个域名下都能直接用 ——
 * 页面里的 API 地址和品牌名不用手工改，也不会把别人的域名带出去。
 */
function serveStatic(res, filePath, req) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    let body = buf;
    if (/\.html?$/i.test(filePath)) {
      const tpl = {
        PRODUCT: CONFIG.productName || 'human-as-llm',
        ORIGIN: requestOrigin(req),
        PUBLIC: String(CONFIG.publicUrl || '').replace(/\/+$/, ''),
        MODEL: CONFIG.modelId || 'me-1'
      };
      body = Buffer.from(buf.toString('utf8').replace(/\{\{(\w+)\}\}/g, (all, k) => (k in tpl ? tpl[k] : all)), 'utf8');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache'
    });
    res.end(body);
  });
}

/* ------------------------------------------------------------------ */
/* 主服务                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS'
    });
    return res.end();
  }

  try {
    // 支持把 key 写在路径里：/k/<key>/v1/chat/completions
    // 某些公网反向代理会覆盖 Authorization 头并剥掉 x-api-key，路径是唯一可靠的载体
    let p = url.pathname;
    req._pathKey = null;
    const km = /^\/k\/([^/]+)(\/.*)?$/.exec(p);
    if (km) {
      req._pathKey = decodeURIComponent(km[1]);
      p = km[2] || '/';
      url.pathname = p;
    }

    if (p === '/healthz') return json(res, 200, { ok: true, pending: [...tasks.values()].filter((t) => t.status === 'pending').length });

    if (p.startsWith('/admin/api/')) return await handleAdmin(req, res, url);

    /*
     * 防呆：有人把「教程页的地址」当成 API 地址填进客户端了。
     *
     * 表现：客户端 POST 到 /guide 或 /quick，拿到一坨 HTML（HTTP 200），
     * 解析不出 SSE，最后报一句「Stream ended without finish_reason」——
     * 完全看不出问题在哪。这坑真实发生过：邀请链接就在浏览器地址栏里，
     * 顺手就抄进「API 地址」了。
     *
     * 这里直接回一条能看懂的 JSON，让客户端把话原样显示出来。
     */
    const PAGE_PATHS = ['/', '/index.html', '/quick', '/quick/', '/guide', '/guide/', '/admin', '/admin/'];
    if (req.method === 'POST' && PAGE_PATHS.indexOf(p) >= 0) {
      return json(res, 400, {
        error: {
          message: '这个地址是「教程页」，不是 API 接口 —— 你多半是把浏览器地址栏里那条链接'
            + '直接填进客户端的「API 地址」了。正确的是 ' + requestOrigin(req) + '/k/<你的密钥>/v1'
            + '，路径里必须有 /k/<密钥>/v1 这一段。',
          type: 'invalid_request_error'
        }
      });
    }

    if (p === '/admin' || p === '/admin/') return serveStatic(res, path.join(PUBLIC_DIR, 'console.html'), req);

    if (p === '/guide' || p === '/guide/') return serveStatic(res, path.join(PUBLIC_DIR, 'guide.html'), req);

    // 单屏版的调用教程 —— 发给朋友用这个，完整手册留给想细看的人
    if (p === '/quick' || p === '/quick/') return serveStatic(res, path.join(PUBLIC_DIR, 'quick.html'), req);

    if (p === '/v1/models' && req.method === 'GET') return handleModels(req, res);

    if (p === '/v1/chat/completions' && req.method === 'POST') return await handleChatCompletions(req, res);

    // 图片附件：控制台上传后换回的短链接就是这里读的。
    // 故意不校验 API Key —— 它的用途就是发给对端打开。
    const am = /^\/att\/([a-f0-9]{6,32})\.([a-z0-9]{2,5})$/.exec(p);
    if (am && req.method === 'GET') {
      const a = attachments.get(am[1]);
      if (!a) return json(res, 404, { error: { message: '附件不存在或已过期', type: 'invalid_request_error' } });
      res.writeHead(200, {
        'Content-Type': a.mime,
        'Content-Length': a.buf.length,
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(a.buf);
    }

    if (p === '/' ) return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'), req);

    // 其它静态资源
    const safe = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
    const fp = path.join(PUBLIC_DIR, safe);
    if (fp.startsWith(PUBLIC_DIR) && fs.existsSync(fp) && fs.statSync(fp).isFile()) return serveStatic(res, fp, req);

    return json(res, 404, { error: { message: 'Not found: ' + p, type: 'invalid_request_error' } });
  } catch (e) {
    console.error('[error]', e);
    if (!res.headersSent) return json(res, 500, { error: { message: e.message, type: 'server_error' } });
    try { res.end(); } catch (_) { /* ignore */ }
  }
});

server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) { /* ignore */ }
});

const archivedCount = loadArchive();      // 先把历史捞回内存

server.listen(PORT, HOST, () => {
  const line = '─'.repeat(66);
  console.log('\n' + line);
  console.log('  ' + (CONFIG.productName || 'human-as-llm') + ' 已启动 —— 现在你本人就是那个模型');
  console.log(line);
  console.log('  监听地址              : ' + HOST + ':' + PORT + (IS_HOSTED ? '   (平台注入的 PORT)' : ''));
  console.log('  控制台（你回复的地方）: ' + (IS_HOSTED ? '(公开域名)/admin' : 'http://127.0.0.1:' + PORT + '/admin'));
  console.log('  管理密码              : ' + CONFIG.adminPassword);
  console.log('  API Base URL          : ' + (IS_HOSTED ? '(公开域名)/v1' : 'http://127.0.0.1:' + PORT + '/v1'));
  console.log('  模型名                : ' + CONFIG.modelId);
  console.log('  可用 API Key          :');
  for (const k of CONFIG.apiKeys) console.log('    ' + k.name.padEnd(12) + ' ' + k.key);
  console.log('  历史归档              : ' + archivedCount + ' 条（' + ARCHIVE_FILE + '）');
  console.log(line);
  if (CONFIG.adminPassword.length < 8) {
    console.log('  [!] 管理密码只有 ' + CONFIG.adminPassword.length + ' 个字符 —— 控制台是公网可达的，');
    console.log('      暴露到公网前建议在 config.json 里换长一点。');
  }
  console.log('');
});

// 兜底：任何未捕获异常都不该让整个服务倒下（公网常驻场景尤为重要）
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException] ' + (e && e.stack || e));
});
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection] ' + (e && e.stack || e));
});
