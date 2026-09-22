/**
 * 页面内 fetch 诊断 —— 查明「为什么同一个页面里 products.json 拿得到，
 * collections 页面却 Failed to fetch」。
 *
 * 用法：node tools/probe-fetch.mjs https://kuura.co/
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9342;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => existsSync(p));

const target = process.argv[2] || 'https://kuura.co/';
const udd = mkdtempSync(join(tmpdir(), 'fetch-'));
const proc = spawn(EXE, [
  `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', `--user-data-dir=${udd}`,
  '--no-first-run', '--disable-gpu', '--window-size=1300,900', target
], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });

const getJson = async (p) => { try { return await (await fetch(`http://127.0.0.1:${PORT}${p}`)).json(); } catch { return null; } };

try {
  for (let i = 0; i < 60; i++) { await sleep(500); if (await getJson('/json/version')) break; }
  await sleep(7000);

  let page = null;
  for (let i = 0; i < 30; i++) {
    const l = await getJson('/json/list');
    page = l && l.find((t) => t.type === 'page' && String(t.url).startsWith('http'));
    if (page) break;
    await sleep(400);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  const send = (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

  await send('Runtime.enable', {});

  const EXPR = `(async () => {
  const out = { origin: location.origin, href: location.href, pathname: location.pathname };

  // Shopify.routes.root 是主题里带 locale 前缀的根路径（例如 /en-us/）。
  // 店铺把不带前缀的路径 301 到 *.myshopify.com，而 HTML 的跨域响应没有 CORS 头，
  // 于是 fetch 直接 Failed to fetch —— 这是本店 collections 页抓不到的原因。
  try {
    out.routesRoot = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || null;
  } catch (e) { out.routesRoot = null; }
  const root = (out.routesRoot || '/').replace(/\\/$/, '');

  const tests = [
    ['/collections/all/products.json?limit=250', { credentials: 'omit' }],
    ['/collections/all/products.json?limit=250&sort_by=best-selling', { credentials: 'omit' }],
    ['/collections/teaware-accessories/products.json?limit=250&sort_by=best-selling', { credentials: 'omit' }],
    ['/collections/raw-puerh-tea/products.json?limit=250&sort_by=best-selling', { credentials: 'omit' }],
    ['/collections/raw-puerh-tea/products.json?limit=250&sort_by=created-descending', { credentials: 'omit' }],
    ['/collections/raw-puerh-tea/products.json?limit=250', { credentials: 'omit' }]
  ];

  out.results = [];
  for (const [u, opt] of tests) {
    const rec = { url: u, opt: JSON.stringify(opt) };
    const t0 = performance.now();
    try {
      const res = await fetch(u, opt);
      const txt = await res.text();
      rec.status = res.status;
      rec.finalUrl = res.url;
      rec.len = txt.length;
      rec.ms = Math.round(performance.now() - t0);
      rec.ctype = res.headers.get('content-type');
      if (/json/.test(rec.ctype || '')) {
        try {
          const j = JSON.parse(txt);
          rec.jsonKeys = Object.keys(j).join(',');
          const ps = j.products || (j.collection && j.collection.products) || [];
          rec.n = ps.length;
          // 前 3 个产品的 handle 顺序 —— 用来判断 sort_by 到底有没有生效
          rec.first3 = ps.slice(0, 3).map((x) => x.handle || x);
        } catch (e) { rec.parseErr = e.message; }
      }
    } catch (e) {
      rec.error = String((e && e.message) || e);
      rec.ms = Math.round(performance.now() - t0);
    }
    out.results.push(rec);
  }

  // 这些是已知会失败的对照项，保留一条便于确认"HTML 一律被 CORS 拦"
  for (const [u, opt] of [['/collections/all?sort_by=best-selling', { credentials: 'omit' }]]) {
    const rec = { url: u + '  ← 对照', opt: JSON.stringify(opt) };
    try { const res = await fetch(u, opt); await res.text(); rec.status = res.status; rec.note = '居然成功了'; }
    catch (e) { rec.error = String((e && e.message) || e); }
    out.results.push(rec);
  }

  try {
    out.swReg = navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).map((x) => x.scope) : [];
    out.swController = navigator.serviceWorker && navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null;
  } catch (e) { out.swReg = ['读取失败: ' + e.message]; }

  // CSP：如果是 connect-src 限制，这里能看到
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  out.metaCsp = meta ? meta.getAttribute('content') : null;
  return out;
})()`;

  const r = await send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) {
    console.log('页面内执行抛错：', JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  }
  const v = r.result && r.result.result ? r.result.result.value : null;
  if (!v) { console.log('无返回值：' + JSON.stringify(r).slice(0, 600)); }
  else {
    console.log('origin :', v.origin);
    console.log('href   :', v.href);
    console.log('routes.root :', v.routesRoot || '(未读到)');
    console.log('SW 注册 :', JSON.stringify(v.swReg));
    console.log('SW 控制 :', v.swController || '无');
    if (v.metaCsp) console.log('meta CSP:', v.metaCsp);
    console.log('');
    for (const x of v.results) {
      console.log(`${x.url}   ${x.opt}`);
      if (x.error) console.log(`   ✗ ${x.error}  (${x.ms}ms)`);
      else console.log(`   ✓ HTTP ${x.status}  len=${x.len}  n=${x.n ?? '-'}  ${x.ms}ms  ${x.ctype || ''}` +
        (x.jsonKeys ? `\n      JSON keys: ${x.jsonKeys}` : '') +
        (x.first3 ? `\n      前 3 个: ${x.first3.join(' , ')}` : ''));
      if (x.finalUrl && x.finalUrl !== v.origin && x.finalUrl !== v.origin + '/') console.log(`     最终 URL: ${x.finalUrl}`);
    }
  }
  ws.close();
} finally {
  try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* 忽略 */ }
  await sleep(1500);
  try { rmSync(udd, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
