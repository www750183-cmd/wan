/**
 * 真实浏览器页面探针 —— 用来搞清楚「页面运行时到底暴露了什么」。
 *
 * 静态 HTML 抓取看不到的东西，这里全都能看到：
 *   - 应用运行时写入的全局配置（jdgm / yotpo / okendo / sales pop …）
 *   - performance API 里页面自己发过的所有请求（含被动态注入的 API 地址）
 *   - 销售通知类组件的实际 DOM 结构
 *
 * 用法：node tools/probe-page.mjs https://store.example
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9341;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
];

async function getJson(path) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try { return await (await fetch(`http://127.0.0.1:${PORT}${path}`, { signal: ctrl.signal })).json(); }
  finally { clearTimeout(t); }
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
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
      }
    });
    return c;
  }
  send(method, params = {}, timeoutMs = 60000) {
    const id = ++this.id;
    return new Promise((ok, bad) => {
      this.pending.set(id, { ok, bad });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); bad(new Error(method + ' 超时')); } }, timeoutMs);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* 忽略 */ } }
}

const target = process.argv[2];
const waitMs = Number(process.argv[3] || 9000);
if (!target) { console.log('用法：node tools/probe-page.mjs <url> [等待毫秒]'); process.exit(1); }

const exe = BROWSERS.find((p) => existsSync(p));
const udd = mkdtempSync(join(tmpdir(), 'probe-'));
const proc = spawn(exe, [
  `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', `--user-data-dir=${udd}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1400,950', target
], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
const pid = proc.pid;

let cdp = null;
try {
  for (let i = 0; i < 60; i++) { await sleep(500); try { await getJson('/json/version'); break; } catch { /* 等 */ } }

  let page = null;
  for (let i = 0; i < 40; i++) {
    const list = await getJson('/json/list').catch(() => []);
    page = list.find((t) => t.type === 'page' && t.url.startsWith('http'));
    if (page) break;
    await sleep(400);
  }
  if (!page) throw new Error('未找到页面 target');

  cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  console.log(`页面：${page.url}`);
  console.log(`等待 ${waitMs} ms 让组件的动态脚本加载完成…\n`);
  await sleep(waitMs);

  const out = await cdp.eval(`(() => {
  const R = {};

  // 1. 关注的应用运行时全局
  const WANT = ['jdgm','JudgeMe','yotpo','Yotpo','okendo','Okendo','looxReviewWidget','loox',
    'stampedFn','Stamped','Ryviu','ryviu','fera','Fera',
    'Fomo','fomo','ProveSource','provesource','Nudgify','nudgify','carecart','SalesPop',
    'Shopify','ShopifyAnalytics'];
  R.globals = {};
  for (const k of WANT) {
    try {
      if (typeof window[k] !== 'undefined') {
        const v = window[k];
        R.globals[k] = (typeof v === 'object' && v !== null)
          ? Object.keys(v).slice(0, 25)
          : String(v).slice(0, 120);
      }
    } catch (e) { /* 忽略 */ }
  }

  // 2. 页面自己发过的所有请求（这是静态抓取永远看不到的）
  const res = performance.getEntriesByType('resource');
  R.resourceCount = res.length;
  R.interesting = res
    .map(e => e.name)
    .filter(u => /api|review|order|sales|pop|fomo|judge|yotpo|okendo|loox|stamped|ryviu|provesrc|nudgify|carecart|widget|graphql|\\.json/i.test(u))
    .filter((u, i, a) => a.indexOf(u) === i)
    .slice(0, 60);

  // 3. 销售通知类组件的 DOM
  const SEL = ['[class*="sales-pop" i]','[class*="salespop" i]','[id*="sales-pop" i]',
    '[class*="fomo" i]','[id*="fomo" i]','[class*="provesource" i]','[class*="provesrc" i]',
    '[class*="nudgify" i]','[class*="social-proof" i]','[class*="recent-sale" i]',
    '[class*="notification" i]','[class*="purchase-notification" i]'];
  R.notificationNodes = [];
  for (const s of SEL) {
    try {
      for (const el of document.querySelectorAll(s)) {
        const txt = (el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (txt.length > 8 && txt.length < 400) {
          R.notificationNodes.push({ sel: s, tag: el.tagName, cls: String(el.className).slice(0, 90), text: txt.slice(0, 220) });
        }
      }
    } catch (e) { /* 忽略 */ }
  }
  R.notificationNodes = R.notificationNodes.slice(0, 20);

  // 4. 评论容器的存在性
  R.reviewContainers = [];
  for (const s of ['#judgeme_product_reviews','.jdgm-widget','.yotpo','#yotpo-bottomline',
    '.oke-reviews','.loox-rating','.stamped-container','#stamped-main-widget','.ryviu-widget']) {
    const el = document.querySelector(s);
    if (el) R.reviewContainers.push(s);
  }

  // 5. 页面上有没有「刚刚购买 / 人正在浏览」这类文案
  const body = document.body ? document.body.innerText : '';
  R.socialProofText = (body.match(/[^\\n]{0,60}(just bought|recently purchased|someone in|人正在浏览|刚刚购买|已购买|sold in the last|purchased)[^\\n]{0,80}/gi) || []).slice(0, 10);

  return R;
})()`);

  console.log('── 运行时全局 ──');
  if (!Object.keys(out.globals).length) console.log('  （无关注的应用全局）');
  for (const [k, v] of Object.entries(out.globals)) {
    console.log(`  ${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
  }

  console.log(`\n── 关注的应用容器 ──`);
  console.log(out.reviewContainers.length ? '  ' + out.reviewContainers.join('  ') : '  （无）');

  console.log(`\n── 销售通知类 DOM（${out.notificationNodes.length}）──`);
  for (const n of out.notificationNodes) console.log(`  [${n.sel}] <${n.tag} class="${n.cls}">\n      ${n.text}`);

  console.log(`\n── 社交证明文案 ──`);
  console.log(out.socialProofText.length ? out.socialProofText.map((t) => '  · ' + t).join('\n') : '  （无）');

  console.log(`\n── 页面发出的相关请求（共 ${out.resourceCount} 条资源）──`);
  for (const u of out.interesting) console.log('  ' + u.slice(0, 170));
} finally {
  if (cdp) cdp.close();
  try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* 忽略 */ }
  await sleep(1500);
  try { rmSync(udd, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
