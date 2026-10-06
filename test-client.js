#!/usr/bin/env node
'use strict';

/*
 * 模拟一个 harness（比如 Cline）向 大肥狗AI 发请求，把流式返回原样打印。
 * 用法：
 *   node test-client.js                      普通聊天
 *   node test-client.js --tools              带 tools，看工具调用
 *   node test-client.js --no-stream          非流式
 *   node test-client.js --key sk-me-xxx
 */

const http = require('http');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

const KEY = val('--key', process.env.DOGLLM_API_KEY || '');
const PORT = val('--port', '8787');
const HOST = val('--host', '127.0.0.1');
const STREAM = !has('--no-stream');
const WITH_TOOLS = has('--tools');

const body = {
  model: val('--model', 'fat-dog'),
  stream: STREAM,
  messages: [
    { role: 'system', content: '你是 CodeBuddy，一个会写代码的助手。回答要简短。' },
    { role: 'user', content: val('--prompt', '你好，请用一句话介绍你自己。') }
  ]
};

if (WITH_TOOLS) {
  body.tools = [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取指定路径的文件内容',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件绝对路径' },
            limit: { type: 'integer', description: '最多读取多少行' }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: '在 shell 中执行一条命令',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string', description: '要执行的命令' } },
          required: ['command']
        }
      }
    }
  ];
  body.tool_choice = 'auto';
}

const payload = Buffer.from(JSON.stringify(body), 'utf8');
const req = http.request({
  host: HOST, port: Number(PORT), path: '/v1/chat/completions', method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': payload.length,
    'Authorization': 'Bearer ' + KEY,
    'User-Agent': 'test-harness/1.0'
  }
}, (res) => {
  console.log('<- HTTP ' + res.statusCode + '  ' + (res.headers['content-type'] || ''));
  if (res.statusCode !== 200) {
    let b = '';
    res.on('data', (c) => b += c);
    res.on('end', () => console.log(b));
    return;
  }

  if (!STREAM) {
    let b = '';
    res.on('data', (c) => b += c);
    res.on('end', () => {
      console.log('\n--- 非流式响应 ---');
      try {
        const j = JSON.parse(b);
        const msg = j.choices[0].message;
        console.log('finish_reason:', j.choices[0].finish_reason);
        if (msg.content) console.log('content:\n' + msg.content);
        if (msg.tool_calls) console.log('tool_calls:\n' + JSON.stringify(msg.tool_calls, null, 2));
        console.log('usage:', JSON.stringify(j.usage));
      } catch (e) { console.log(b); }
    });
    return;
  }

  let buf = '';
  const state = { text: '', toolCalls: {}, finish: null, done: false };
  const t0 = Date.now();
  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (line.startsWith(':')) { continue; }
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          state.done = true;
          console.log('\n<- [DONE]  总耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
          continue;
        }
        let j;
        try { j = JSON.parse(data); } catch (e) { continue; }
        if (j.usage) console.log('\n<- usage: ' + JSON.stringify(j.usage));
        const ch = j.choices && j.choices[0];
        if (!ch) continue;
        const d = ch.delta || {};
        if (d.content) { process.stdout.write(d.content); state.text += d.content; }
        if (d.tool_calls) {
          for (const tc of d.tool_calls) {
            const i = tc.index != null ? tc.index : 0;
            state.toolCalls[i] = state.toolCalls[i] || { id: '', name: '', arguments: '' };
            if (tc.id) state.toolCalls[i].id = tc.id;
            if (tc.function) {
              if (tc.function.name) state.toolCalls[i].name += tc.function.name;
              if (tc.function.arguments) state.toolCalls[i].arguments += tc.function.arguments;
            }
            if (tc.function && tc.function.name) {
              process.stdout.write('\n[tool_call] -> ' + tc.function.name + ' ');
            } else if (tc.function && tc.function.arguments) {
              process.stdout.write(tc.function.arguments);
            }
          }
        }
        if (ch.finish_reason) state.finish = ch.finish_reason;
      }
    }
  });
  res.on('end', () => {
    console.log('\n\n--- 解析结果 ---');
    console.log('finish_reason :', state.finish);
    console.log('正文长度      :', state.text.length);
    const tcs = Object.values(state.toolCalls).filter((x) => x.name);
    if (tcs.length) {
      console.log('tool_calls    :');
      for (const tc of tcs) {
        let ok = '合法 JSON';
        try { JSON.parse(tc.arguments); } catch (e) { ok = '非法 JSON: ' + e.message; }
        console.log('  ' + tc.name + ' (' + tc.id + ') args=' + ok);
        console.log('    ' + tc.arguments);
      }
    }
    console.log(state.done ? '[DONE] 已收到，协议完整' : '[!] 未收到 [DONE]，可能被中断');
  });
});

req.on('error', (e) => { console.error('请求失败:', e.message); process.exit(1); });
req.write(payload);
req.end();
console.log('-> POST http://' + HOST + ':' + PORT + '/v1/chat/completions  (stream=' + STREAM + ', tools=' + WITH_TOOLS + ')');
console.log('-> 现在去 http://127.0.0.1:' + PORT + '/admin 回复这条请求\n');
