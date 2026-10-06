#!/usr/bin/env node
'use strict';

/*
 * 大肥狗AI 控制面板
 * 双击桌面快捷方式即可启动 / 停止服务、打开网页控制台。
 * 也支持命令行：node control.js status|start|stop|restart|open
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

const DIR = __dirname;
const PORT = 8787;
const SERVER = path.join(DIR, 'server.js');
const CONFIG = path.join(DIR, 'config.json');
const LOG = path.join(DIR, 'server.log');
const PIDFILE = path.join(DIR, 'server.pid');
const BASE = 'http://127.0.0.1:' + PORT;          // 本机服务，用于探活 / 启停
/*
 * 对外的公网地址从 config.json 的 publicUrl 读 —— 不写死在代码里，
 * 这样同一份代码给别人用、换域名都不用改源码。
 * 本机与公网是两个各自独立的进程和队列：本机控制台看不到公网的待回复请求。
 */
const _cfg0 = readConfig();
const PUBLIC_BASE = String((_cfg0 && _cfg0.publicUrl) || '').replace(/\/+$/, '');
const PUBLIC_ADMIN = PUBLIC_BASE ? PUBLIC_BASE + '/admin' : '';
const LOCAL_ADMIN = BASE + '/admin';              // 本机控制台（只有本机直连的请求才排到这里）
const URL = PUBLIC_ADMIN || LOCAL_ADMIN;          // 「打开控制台」优先开公网那个

process.title = '大肥狗AI 控制台';

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  purple: '\x1b[35m', cyan: '\x1b[36m'
};
const line = (ch) => ch.repeat(58);

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { return null; }
}

/* ---------------- 进程探测 ---------------- */

function healthz(timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(BASE + '/healthz', { timeout: timeoutMs || 1200 }, (res) => {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode === 200, info: JSON.parse(b) }); }
        catch (e) { resolve({ ok: res.statusCode === 200, info: null }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.on('error', () => resolve({ ok: false }));
  });
}

function pidFromFile() {
  try {
    const pid = parseInt(fs.readFileSync(PIDFILE, 'utf8').trim(), 10);
    if (!pid) return null;
    try { process.kill(pid, 0); return pid; } catch (e) { return null; }
  } catch (e) { return null; }
}

function pidFromPort() {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
    for (const l of out.split(/\r?\n/)) {
      if (!/LISTENING/.test(l)) continue;
      const m = l.trim().split(/\s+/);
      const local = m[1] || '';
      if (local.endsWith(':' + PORT)) {
        const pid = parseInt(m[m.length - 1], 10);
        if (pid) return pid;
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

async function getStatus() {
  const h = await healthz();
  const portPid = pidFromPort();      // 真正占着 8787 的进程
  const filePid = pidFromFile();      // 上次启动时记下的 PID
  // 以端口占用为权威依据，避免旧的 pid 文件把已死的进程误判成存活
  const running = h.ok || !!portPid;
  const pid = running ? (portPid || filePid) : null;
  return { running, pid: pid || null, pending: h.info ? h.info.pending : null };
}

/* ---------------- 动作 ---------------- */

function spawnServer() {
  const out = fs.openSync(LOG, 'a');
  fs.writeSync(out, '\n\n===== ' + new Date().toLocaleString('zh-CN') + ' 启动 =====\n');
  const child = spawn(process.execPath, [SERVER], {
    cwd: DIR,
    detached: true,
    windowsHide: true,   // 服务在后台静默跑，日志进 server.log
    stdio: ['ignore', out, out]
  });
  child.unref();
  try { fs.writeFileSync(PIDFILE, String(child.pid), 'utf8'); } catch (e) {}
  return child.pid;
}

async function start(quiet) {
  const st = await getStatus();
  if (st.running) {
    if (!quiet) console.log(C.yellow + '  服务已经在运行了（PID ' + st.pid + '）' + C.reset);
    return true;
  }
  const pid = spawnServer();
  if (!quiet) process.stdout.write('  正在启动服务…');
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const h = await healthz(600);
    if (h.ok) {
      if (!quiet) console.log(C.green + ' 好了。' + C.reset + '（PID ' + pid + '）');
      return true;
    }
    if (!quiet) process.stdout.write('.');
  }
  if (!quiet) console.log(C.red + ' 启动失败。' + C.reset + '看日志：' + LOG);
  return false;
}

function killTree(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch (e) { return false; }
}

async function stop(quiet) {
  const st = await getStatus();
  if (!st.running) {
    if (!quiet) console.log(C.dim + '  服务本来就没在跑。' + C.reset);
    return true;
  }
  const ok = killTree(st.pid);
  try { fs.unlinkSync(PIDFILE); } catch (e) {}
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const h = await healthz(500);
    if (!h.ok) {
      if (!quiet) console.log(C.green + '  已停止' + C.reset + '（PID ' + st.pid + '）');
      return true;
    }
  }
  if (!quiet) console.log(C.red + '  没停下来，可能权限不够，手动结束 PID ' + st.pid + C.reset);
  return !ok ? false : true;
}

async function restart(quiet) {
  if (!quiet) console.log(C.dim + '  重新启动…' + C.reset);
  await stop(true);
  await new Promise((r) => setTimeout(r, 800));
  return start(quiet);
}

function openBrowser() {
  try {
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', URL], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  } catch (e) {
    try {
      spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'start', '', URL], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return true;
    } catch (e2) { return false; }
  }
}

function openFolder() {
  try { spawn('explorer.exe', [DIR], { detached: true, stdio: 'ignore' }).unref(); } catch (e) {}
}
function openLog() {
  if (!fs.existsSync(LOG)) {
    fs.writeFileSync(LOG, '(还没有日志，服务启动后这里会有输出)\n', 'utf8');
  }
  try { spawn('notepad.exe', [LOG], { detached: true, stdio: 'ignore' }).unref(); } catch (e) {}
}

function showKeys() {
  const c = readConfig();
  if (!c) { console.log(C.red + '  读不到 config.json' + C.reset); return; }
  console.log('');
  console.log('  ' + C.bold + '管理密码' + C.reset + '  ' + C.purple + c.adminPassword + C.reset + C.dim + '   （登录 /admin 用）' + C.reset);
  console.log('  ' + C.dim + line('─') + C.reset);
  for (const k of c.apiKeys) {
    console.log('  ' + C.cyan + k.key + C.reset);
    console.log('  ' + C.dim + '       名字：' + k.name + C.reset);
  }
  console.log('  ' + C.dim + line('─') + C.reset);
  if (PUBLIC_BASE) {
    console.log('  ' + C.dim + '公网 Base URL：' + PUBLIC_BASE + '/k/<上面任一把 Key>/v1   模型 = ' + c.modelId + C.reset);
  } else {
    console.log('  ' + C.dim + '公网 Base URL：（未配置 publicUrl）' + C.reset);
  }
  console.log('  ' + C.dim + '本机 Base URL：' + BASE + '/v1   模型 = ' + c.modelId + '   （仅本机调用）' + C.reset);
  console.log('');
}

/* ---------------- 界面 ---------------- */

async function banner() {
  const st = await getStatus();
  const cfg = readConfig();
  const dot = st.running ? C.green + '●  运行中' + C.reset : C.dim + '○  未启动' + C.reset;
  console.log('');
  console.log('  ' + C.bold + '大肥狗AI' + C.reset + C.dim + '   你就是那个模型' + C.reset);
  console.log('  ' + C.dim + line('─') + C.reset);
  if (PUBLIC_ADMIN) {
    console.log('  回复用控制台  ' + C.purple + PUBLIC_ADMIN + C.reset);
    console.log('  ' + C.dim + '                dsh 与外部调用都排在公网那台，回复就点上面这个' + C.reset);
  } else {
    console.log('  回复用控制台  ' + C.dim + LOCAL_ADMIN + '   （还没配公网地址）' + C.reset);
    console.log('  ' + C.dim + '                部署到公网后，把域名填进 config.json 的 publicUrl' + C.reset);
  }
  console.log('  本机服务      ' + dot + (st.pid ? C.dim + '   PID ' + st.pid : '') + C.reset);
  console.log('  ' + C.dim + '本机控制台    ' + LOCAL_ADMIN +
    (st.pending != null ? '   （本机队列待回复 ' + st.pending + ' 条）' : '') + C.reset);
  if (cfg) console.log('  模型名        ' + C.dim + cfg.modelId + '    Key 数量 ' + cfg.apiKeys.length + C.reset);
  console.log('  ' + C.dim + line('─') + C.reset);
  return st;
}

async function menu() {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, r));

  let loop = true;
  while (loop) {
    const st = await banner();
    console.log('  ' + C.bold + '[1]' + C.reset + ' 启动服务');
    console.log('  ' + C.bold + '[2]' + C.reset + ' 停止服务');
    console.log('  ' + C.bold + '[3]' + C.reset + ' 重启服务');
    console.log('  ' + C.bold + '[4]' + C.reset + (PUBLIC_ADMIN ? ' 打开公网控制台' : ' 打开本机控制台')
      + C.dim + '   （别人调用你时在这里回复）' + C.reset);
    console.log('  ' + C.bold + '[5]' + C.reset + ' 查看 API Key 与管理密码');
    console.log('  ' + C.bold + '[6]' + C.reset + ' 查看服务日志');
    console.log('  ' + C.bold + '[7]' + C.reset + ' 打开项目文件夹');
    console.log('  ' + C.bold + '[0]' + C.reset + ' 退出' + C.dim + '   （退出不会停止服务）' + C.reset);
    console.log('  ' + C.dim + line('─') + C.reset);

    const ans = (await ask('  请选择 > ')).trim();

    if (ans === '0' || ans.toLowerCase() === 'q') { loop = false; break; }
    else if (ans === '1') await start();
    else if (ans === '2') await stop();
    else if (ans === '3') await restart();
    else if (ans === '4') {
      // 配了公网地址就直接开公网控制台（它跑在云端，不依赖本机服务）；没配就开本机的
      openBrowser();
      console.log(C.green + '  已在浏览器打开' + (PUBLIC_ADMIN ? '公网' : '本机') + '控制台'
        + C.reset + C.dim + '（记得用管理密码登录）' + C.reset);
      console.log('  ' + C.dim + URL + C.reset);
    }
    else if (ans === '5') showKeys();
    else if (ans === '6') openLog();
    else if (ans === '7') openFolder();
    else if (ans === '') { /* 直接回车 = 刷新状态 */ }
    else console.log(C.dim + '  没有这个选项' + C.reset);
  }
  rl.close();
  console.log('');
}

/* ---------------- 入口 ---------------- */

(async function main() {
  const cmd = (process.argv[2] || '').toLowerCase();
  if (cmd === 'status' || cmd === 'st') {
    const st = await getStatus();
    console.log(JSON.stringify(st));
    return;
  }
  if (cmd === 'start') { await start(); const s = await getStatus(); console.log(JSON.stringify(s)); return; }
  if (cmd === 'stop') { await stop(); const s = await getStatus(); console.log(JSON.stringify(s)); return; }
  if (cmd === 'restart') { await restart(); const s = await getStatus(); console.log(JSON.stringify(s)); return; }
  if (cmd === 'open') { openBrowser(); console.log('  opened ' + URL); return; }
  if (cmd === 'menu') { await menu(); return; }
  if (cmd === 'keys') { showKeys(); return; }

  if (!process.stdin.isTTY) {
    // 交互菜单需要真终端。被管道 / 重定向调用时**不要**擅自打开浏览器 ——
    // 那会在别人的机器上弹出意料之外的窗口（开发时就踩过一次）。
    // 这里只打印用法，把「打开控制台」留给显式的 open 子命令。
    console.log('');
    console.log('  大肥狗AI 控制面板需要交互终端才能显示菜单。');
    console.log('  可用命令：');
    console.log('    node control.js status    查状态（输出 JSON）');
    console.log('    node control.js start     启动本机服务');
    console.log('    node control.js stop      停止本机服务');
    console.log('    node control.js restart   重启本机服务');
    console.log('    node control.js open      在浏览器打开公网控制台');
    console.log('    node control.js keys      查看 API Key 与管理密码');
    console.log('');
    console.log('  控制台：' + URL);
    console.log('');
    process.exit(0);
  }
  await menu();
})();
