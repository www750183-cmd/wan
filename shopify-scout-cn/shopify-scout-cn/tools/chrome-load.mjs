/**
 * 在 Chrome 里加载扩展 —— 寻找 Chrome 137+ 移除 `--load-extension` 之后的替代路径。
 *
 * 依次尝试：
 *   A. CDP `Extensions.loadUnpacked`（配合 --enable-unsafe-extension-debugging）
 *   B. 企业策略 ExtensionSettings（force-installed / allowlist）
 *   C. 命令行开关旧写法（预期失败，用于确认边界）
 *
 * 用法：node tools/chrome-load.mjs [扩展目录]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let PORT = 9350;
async function getJson(p, ms = 2500) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await (await fetch(`http://127.0.0.1:${PORT}${p}`, { signal: c.signal })).json(); }
  catch { return null; } finally { clearTimeout(t); }
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, bad) => {
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', () => bad(new Error('WS 连接失败')), { once: true });
    });
    const c = new Cdp(ws);
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        const { ok, bad } = c.pending.get(m.id); c.pending.delete(m.id);
        if (m.error) bad(new Error(m.error.message)); else ok(m.result);
      } else if (m.method) c.events.push(m);
    });
    return c;
  }
  send(method, params = {}, ms = 30000) {
    const id = ++this.id;
    return new Promise((ok, bad) => {
      this.pending.set(id, { ok, bad });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); bad(new Error(method + ' 超时')); } }, ms);
    });
  }
  close() { try { this.ws.close(); } catch { /* 忽略 */ } }
}

/** 启动一次 Chrome，返回 { proc, pid, udd } */
function launch(extraArgs, startUrl = 'about:blank') {
  const udd = mkdtempSync(join(tmpdir(), 'chrome-load-'));
  const args = [
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${udd}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-gpu',
    '--window-size=1300,900',
    ...extraArgs,
    startUrl
  ];
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  const errs = [];
  proc.stderr.on('data', (d) => errs.push(d.toString()));
  return { proc, pid: proc.pid, udd, errs };
}

async function waitReady(tries = 60) {
  for (let i = 0; i < tries; i++) { await sleep(500); if (await getJson('/json/version')) return true; }
  return false;
}

function kill(pid) {
  try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* 忽略 */ }
}

const EXT = process.argv[2] ? resolve(process.argv[2]) : ROOT;
console.log(`扩展目录：${EXT}\n`);

/* ── 方案 A：CDP Extensions.loadUnpacked ── */
console.log('═'.repeat(64));
console.log('方案 A：CDP Extensions.loadUnpacked');
console.log('═'.repeat(64));

async function tryMethod(label, extraArgs, useUnsafe) {
  PORT++;
  const { pid, udd, errs } = launch(extraArgs);
  let cdp = null;
  try {
    if (!await waitReady()) { console.log(`  ✗ ${label}：CDP 端口未就绪`); return null; }
    const version = await getJson('/json/version');
    console.log(`  Chrome ${version.Browser}`);

    cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    // 先看看这个 Chrome 支持哪些扩展相关命令
    try {
      const dom = await cdp.send('Schema.getDomains');
      const ext = dom.domains.find((d) => d.name === 'Extensions');
      console.log(`  Extensions CDP 域：${ext ? '存在' : '不存在'}`);
    } catch { /* 忽略 */ }

    try {
      const r = await cdp.send('Extensions.loadUnpacked', { path: EXT }, 20000);
      console.log(`  ✓ loadUnpacked 返回：${JSON.stringify(r)}`);
      return r;
    } catch (e) {
      console.log(`  ✗ loadUnpacked 失败：${e.message}`);
      const errLines = errs.join('').split('\n').filter((l) => /extension|Extension|unsafe/i.test(l));
      if (errLines.length) console.log('    Chrome stderr: ' + errLines.slice(-3).join(' | ').trim());
      return null;
    }
  } finally {
    if (cdp) cdp.close();
    kill(pid);
    await sleep(1200);
    try { rmSync(udd, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

await tryMethod('无额外开关', []);
await tryMethod('+ --enable-unsafe-extension-debugging', ['--enable-unsafe-extension-debugging']);

/* ── 方案 B：确认 target 列表里有没有扩展 ── */
console.log('\n' + '═'.repeat(64));
console.log('方案 B：带 --load-extension 旧写法（确认是否真的被移除）');
console.log('═'.repeat(64));
{
  PORT++;
  const { pid, udd } = launch([`--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`], 'about:blank');
  try {
    if (!await waitReady()) { console.log('  ✗ CDP 未就绪'); }
    else {
      await sleep(4000);
      const list = await getJson('/json/list') || [];
      const mine = list.filter((t) => String(t.url).endsWith('/background.js'));
      console.log(`  target 总数 ${list.length}，其中 background.js 的 SW：${mine.length} 个`);
      for (const t of list.filter((t) => String(t.url).startsWith('chrome-extension://'))) {
        console.log(`    [${t.type}] ${t.url}`);
      }
      console.log(mine.length ? '  ✓ --load-extension 仍然有效' : '  ✗ --load-extension 已失效（扩展未加载）');
    }
  } finally {
    kill(pid);
    await sleep(1200);
    try { rmSync(udd, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

console.log('\n完成。');
