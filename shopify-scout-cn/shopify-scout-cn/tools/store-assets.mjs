/**
 * Chrome 应用商店素材生成 —— 全部用真实浏览器渲染，不靠图像库。
 *
 * Chrome 商城对图片的要求：
 *   · 商店图标 128×128           —— 已由 tools/make-icons.mjs 生成
 *   · 截图 1280×800（最多 5 张） —— 本脚本抓真实界面
 *   · 小宣传图 440×280           —— 本脚本渲染（可选但强烈建议）
 *
 * 为什么用浏览器渲染而不是纯 Node 画图：宣传图要写中文，纯 Node 没有字体渲染，
 * 硬画只能画方块。用 HTML+CSS 交给 Chrome，文字排版直接就是对的。
 *
 * 用法：node tools/store-assets.mjs [店铺URL]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, '..', 'store');
const PORT = 9360;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => existsSync(p));

const STORE_URL = process.argv[2] || 'https://www.deathwishcoffee.com';

async function getJson(p, ms = 2500) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await (await fetch(`http://127.0.0.1:${PORT}${p}`, { signal: c.signal })).json(); }
  catch { return null; } finally { clearTimeout(t); }
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
  send(method, params = {}, ms = 90000) {
    const id = ++this.id;
    return new Promise((ok, bad) => {
      this.pending.set(id, { ok, bad });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); bad(new Error(method + ' 超时')); } }, ms);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* 忽略 */ } }
}

/* ── PNG 尺寸与内容自检（我无法肉眼看图，只能靠解码验证） ── */
function inspectPng(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return { valid: false, reason: 'PNG 签名错误' };
  let off = 8, idat = [], w = 0, h = 0, bitDepth = 0, colorType = 0;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    }
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') break;
    off += 12 + len;
  }
  // 解出像素做统计：确认不是纯色/空白，且明暗都有（说明确实渲染了内容）
  let stats = null;
  try {
    const raw = inflateSync(Buffer.concat(idat));
    const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
    const stride = w * channels;
    const bpp = channels;
    const prevRow = Buffer.alloc(stride);
    let dark = 0, light = 0, total = 0;
    const colors = new Set();
    for (let y = 0; y < h; y++) {
      const ft = raw[y * (stride + 1)];
      const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
      // 反滤波
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? row[x - bpp] : 0;
        const b = prevRow[x];
        const c = x >= bpp ? prevRow[x - bpp] : 0;
        switch (ft) {
          case 1: row[x] = (row[x] + a) & 0xff; break;
          case 2: row[x] = (row[x] + b) & 0xff; break;
          case 3: row[x] = (row[x] + ((a + b) >> 1)) & 0xff; break;
          case 4: {
            const p = a + b - c;
            const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            row[x] = (row[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
            break;
          }
        }
      }
      row.copy(prevRow);
      // 每 4 行采样一次，避免大图统计太慢
      if (y % 4) continue;
      for (let x = 0; x < w; x += 4) {
        const i = x * channels;
        const lum = channels >= 3 ? (row[i] * 0.299 + row[i + 1] * 0.587 + row[i + 2] * 0.114) : row[i];
        total++;
        if (lum < 80) dark++; else if (lum > 170) light++;
        if (colors.size < 4000) colors.add(`${row[i]},${row[i + 1]},${row[i + 2]}`);
      }
    }
    stats = { darkRatio: dark / total, lightRatio: light / total, distinctColors: colors.size };
  } catch (e) { stats = { error: e.message }; }
  return { valid: true, width: w, height: h, bitDepth, colorType, bytes: buf.length, stats };
}

/* ── 宣传图 HTML（440×280） ── */
function promoHtml() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0}
  html,body{width:440px;height:280px;overflow:hidden;font-family:"Microsoft YaHei","Segoe UI",sans-serif}
  body{background:radial-gradient(120% 120% at 12% 0%,#164e49 0%,#0f1b1a 55%,#0b1113 100%);color:#e8eaee;
       display:flex;flex-direction:column;justify-content:center;padding:26px 26px 22px;position:relative}
  .glow{position:absolute;right:-70px;top:-70px;width:230px;height:230px;border-radius:50%;
        background:radial-gradient(circle,#0f9d8f55,transparent 68%)}
  .row{display:flex;align-items:center;gap:13px;margin-bottom:16px;position:relative}
  .icon{width:52px;height:52px;border-radius:14px;background:#0f9d8f;display:grid;place-items:center;flex:none;
        box-shadow:0 6px 20px #0f9d8f66}
  .icon svg{width:30px;height:30px}
  h1{font-size:26px;line-height:1.15;letter-spacing:.5px;font-weight:700}
  .sub{font-size:12px;color:#7fd8cd;margin-top:3px;letter-spacing:.6px}
  ul{list-style:none;position:relative}
  li{font-size:13.5px;line-height:1.85;color:#c9d2da;display:flex;align-items:center;gap:7px}
  li b{color:#fff;font-weight:600}
  .dot{width:5px;height:5px;border-radius:50%;background:#2dd4bf;flex:none}
  .tag{position:absolute;right:24px;bottom:20px;font-size:11px;color:#5f7a77;letter-spacing:.4px}
</style></head><body>
  <div class="glow"></div>
  <div class="row">
    <div class="icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round">
        <circle cx="10.2" cy="10.2" r="6.2"/><path d="M14.8 14.8 L19.6 19.6"/>
      </svg>
    </div>
    <div>
      <h1>选品侦探</h1>
      <div class="sub">Shopify 店铺侦察兵</div>
    </div>
  </div>
  <ul>
    <li><span class="dot"></span>主题 · 应用 · 像素 <b>一眼看穿</b></li>
    <li><span class="dot"></span>销量排行榜 <b>直接读商家后台排序</b></li>
    <li><span class="dot"></span>店铺变化 <b>卖光 / 补货 / 上新 / 改价</b></li>
  </ul>
  <div class="tag">完全离线 · 不上传任何数据</div>
</body></html>`;
}

/* ── 截图外框 CSS：把侧边栏放进 1280×800 画布里 ── */
const FRAME_CSS = `
  html,body{height:100%;margin:0;overflow:hidden}
  body{background:radial-gradient(120% 120% at 50% -10%,#164e49 0%,#101a1c 52%,#0a0f11 100%);
       display:flex;align-items:center;justify-content:center;position:relative;
       font-family:"Microsoft YaHei","Segoe UI",sans-serif}
  body::before{content:"选品侦探 · Shopify 店铺侦察兵";position:absolute;top:26px;left:0;right:0;
       text-align:center;color:#7fd8cd;font-size:16px;letter-spacing:1px}
  body::after{content:"完全离线运行 · 不向任何服务器发送数据";position:absolute;bottom:24px;left:0;right:0;
       text-align:center;color:#4d6b68;font-size:12.5px;letter-spacing:.5px}
  #shotFrame{width:430px;height:720px;display:flex;flex-direction:column;overflow:hidden;
       border-radius:14px;background:var(--bg);border:1px solid rgba(255,255,255,.10);
       box-shadow:0 26px 70px rgba(0,0,0,.6);position:relative;z-index:2}
  #shotFrame::-webkit-scrollbar{width:0}
`;

/**
 * 抓一张 1280×800 截图。
 * @param {Cdp} page 面板页面的 CDP
 * @param {Cdp} browser 浏览器级 CDP
 */
async function capture(page, browser, tabName, file) {
  // 切到目标标签页
  await page.eval(`(() => {
    const t = [...document.querySelectorAll('.tab')].find(x => x.textContent.includes(${JSON.stringify(tabName)}));
    if (t) t.click();
    return !!t;
  })()`);
  await sleep(500);

  // 注入外框（幂等）
  await page.eval(`(() => {
    if (document.getElementById('shotFrame')) return;
    const css = document.createElement('style');
    css.textContent = ${JSON.stringify(FRAME_CSS)};
    document.head.appendChild(css);
    const wrap = document.createElement('div');
    wrap.id = 'shotFrame';
    while (document.body.firstChild) wrap.appendChild(document.body.firstChild);
    document.body.appendChild(wrap);
  })()`);
  await sleep(400);

  const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 20000);
  const buf = Buffer.from(shot.data, 'base64');
  writeFileSync(file, buf);
  return inspectPng(buf);
}

/* ── 主流程 ── */
console.log('选品侦探 · 商城素材生成');
console.log(`输出目录：${OUT}\n`);
mkdirSync(OUT, { recursive: true });

const userDataDir = mkdtempSync(join(tmpdir(), 'store-assets-'));
const promoFile = join(userDataDir, 'promo.html');
writeFileSync(promoFile, promoHtml(), 'utf8');

const args = [
  `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', `--user-data-dir=${userDataDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-gpu',
  '--window-size=1280,800', '--window-position=0,0',
  `file:///${promoFile.replace(/\\/g, '/')}`
];
const proc = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
const childPid = proc.pid;

let browserCdp = null, pageCdp = null;
let shotExt = null;
try {
  for (let i = 0; i < 60; i++) { await sleep(500); if (await getJson('/json/version')) break; }
  const version = await getJson('/json/version');
  console.log(`浏览器：${version.Browser}`);
  browserCdp = await Cdp.connect(version.webSocketDebuggerUrl);

  // ── 1. 宣传图 440×280 ──
  console.log('\n[1/3] 小宣传图 440×280');
  let promo = null;
  for (let i = 0; i < 30; i++) {
    const all = await getJson('/json/list');
    promo = all && all.find((t) => t.type === 'page' && String(t.url).startsWith('file:'));
    if (promo) break;
    await sleep(300);
  }
  if (!promo) throw new Error('宣传图页面未就绪');
  const promoPage = await Cdp.connect(promo.webSocketDebuggerUrl);
  await promoPage.send('Emulation.setDeviceMetricsOverride', {
    width: 440, height: 280, deviceScaleFactor: 1, mobile: false
  });
  await sleep(1200);
  const promoShot = await promoPage.send('Page.captureScreenshot', { format: 'png' });
  const promoBuf = Buffer.from(promoShot.data, 'base64');
  const promoPath = join(OUT, '小宣传图-440x280.png');
  writeFileSync(promoPath, promoBuf);
  const pi = inspectPng(promoBuf);
  console.log(`  尺寸 ${pi.width}×${pi.height}｜${pi.bytes} 字节｜暗部 ${(pi.stats.darkRatio * 100).toFixed(0)}%／亮部 ${(pi.stats.lightRatio * 100).toFixed(0)}%｜${pi.stats.distinctColors} 种颜色`);
  console.log(`  ✓ ${promoPath.split('\\').pop()}`);
  // 注意：这里**不关**宣传图标签页。
  // 实测把浏览器里最后一个页面关掉会导致后续 Target.createTarget 卡死。
  // 正确做法是复用同一个标签页，直接导航到店铺页面（见下面 promoPage.navigate）。

  // ── 2. 装扩展并扫描 ──
  console.log('\n[2/3] 装载扩展并扫描真实店铺');
  // 截图需要真实数据，而真实 manifest 只用 activeTab（必须真人点图标授权，自动化给不了）。
  // 因此用临时副本补上目标站点的 host 权限 —— 只影响「怎么授权」，界面与代码路径完全相同。
  shotExt = mkdtempSync(join(tmpdir(), 'store-ext-'));
  cpSync(ROOT, shotExt, {
    recursive: true,
    filter: (src) => !/[/\\](test|tools|docs|node_modules|store|dist)[/\\]?$/.test(src)
  });
  {
    const mfPath = join(shotExt, 'manifest.json');
    const mf = JSON.parse(readFileSync(mfPath, 'utf8'));
    mf.host_permissions = [new URL(STORE_URL).origin + '/*'];
    writeFileSync(mfPath, JSON.stringify(mf, null, 2));
    console.log(`  ⚠ 截图用临时副本，补了 host_permissions:["${mf.host_permissions[0]}"]（仅授权方式不同）`);
  }

  let r = null;
  for (let attempt = 1; attempt <= 3 && !r; attempt++) {
    try {
      r = await browserCdp.send('Extensions.loadUnpacked', { path: shotExt }, 30000);
    } catch (e) {
      console.log(`  第 ${attempt} 次装载失败：${e.message}`);
      await sleep(1500);
    }
  }
  if (!r) throw new Error('扩展装载失败（重试 3 次）');
  console.log(`  ✓ 扩展 ${r.id}`);

  // 复用同一个标签页导航到店铺：这样全浏览器只有「店铺页 + 面板页」两个标签，
  // 扩展靠「除我以外的那个标签页」就能准确定位目标（它读不到 tab.url）。
  await promoPage.send('Page.navigate', { url: STORE_URL });
  await sleep(2500);

  let extId = r.id;
  let sw = null;
  for (let i = 0; i < 40; i++) {
    const all = await getJson('/json/list');
    sw = all && all.find((t) => t.type === 'service_worker' && String(t.url).endsWith('/background.js'));
    if (sw) break;
    await sleep(400);
  }
  if (sw) extId = new URL(sw.url).host;
  console.log(`  ✓ Service Worker 已注册：${extId}`);

  await browserCdp.send('Target.createTarget', { url: `chrome-extension://${extId}/sidepanel/index.html` });
  await sleep(1500);
  const all2 = await getJson('/json/list');
  const panelT = all2.find((t) => t.type === 'page' && t.url === `chrome-extension://${extId}/sidepanel/index.html`);
  const storeT = all2.find((t) => t.type === 'page' && String(t.url).startsWith('https://'));
  if (!panelT) throw new Error('面板页面未就绪');

  pageCdp = await Cdp.connect(panelT.webSocketDebuggerUrl);
  await pageCdp.send('Page.enable', {}).catch(() => {});
  await pageCdp.send('Runtime.enable', {});

  // 侧边栏不是标签页，活动标签必须是店铺页
  if (storeT) await browserCdp.send('Target.activateTarget', { targetId: storeT.id }).catch(() => {});
  await sleep(600);

  // 打开面板后它自己会读一次缓存；这里直接让它扫描。
  // 注意不能靠 tab.url 找店铺页：扩展没申请 tabs 权限，url 会被隐藏。
  // 用「除我自己以外的那个标签页」定位（chrome.tabs.getCurrent 不需要额外权限）。
  const scanRes = await pageCdp.eval(`(async () => {
    const me = await chrome.tabs.getCurrent();
    const tabs = await chrome.tabs.query({});
    const store = tabs.find(t => t.id !== (me && me.id));
    if (!store) return { ok: false, error: '找不到店铺标签页（标签数 ' + tabs.length + '）' };
    const r = await chrome.runtime.sendMessage({ action: 'scan', tabId: store.id, deep: true });
    return r && r.ok ? { ok: true, host: r.host, apps: r.apps.length, products: r.summary.count } : { ok: false, error: r && r.error };
  })()`);
  if (!scanRes.ok) throw new Error('扫描失败：' + scanRes.error);
  console.log(`  ✓ 已扫描 ${scanRes.host}：${scanRes.apps} 应用 / ${scanRes.products} 产品`);

  // 重载面板，让它把缓存结果渲染出来
  await pageCdp.send('Page.reload', { ignoreCache: false });
  await sleep(3200);

  // ── 3. 1280×800 截图 ──
  console.log('\n[3/3] 截图 1280×800（最多 5 张）');
  await pageCdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false
  });
  await sleep(600);

  const TABS = ['概览', '店铺变化', '选品', '应用', '导出'];
  let n = 0;
  for (const tab of TABS) {
    n++;
    const file = join(OUT, `截图${n}-${tab}-1280x800.png`);
    try {
      // 把面板标签页切到前台再截。
      // 实测对**后台标签页**调 captureScreenshot 会一直挂住直到超时 ——
      // 前面几次成功、中间几次失败，就是因为活动标签页被切去店铺页了。
      await browserCdp.send('Target.activateTarget', { targetId: panelT.id }).catch(() => { /* 忽略 */ });
      await sleep(350);
      const info = await capture(pageCdp, browserCdp, tab, file);
      const okSize = info.width === 1280 && info.height === 800;
      const hasContent = info.stats && info.stats.darkRatio > 0.05 && info.stats.distinctColors > 200;
      console.log(`  ${okSize ? '✓' : '✗'} ${tab.padEnd(6)} ${info.width}×${info.height}｜` +
        `${(info.bytes / 1024).toFixed(0)} KB｜暗 ${(info.stats?.darkRatio * 100 || 0).toFixed(0)}%／亮 ${(info.stats?.lightRatio * 100 || 0).toFixed(0)}%｜` +
        `${info.stats?.distinctColors || 0} 色 ${hasContent ? '' : '⚠ 内容似乎过少'}`);
    } catch (e) {
      // 失败重试一次：截图偶发超时是已知的浏览器行为，不是内容问题
      try {
        await sleep(800);
        await browserCdp.send('Target.activateTarget', { targetId: panelT.id }).catch(() => {});
        const info = await capture(pageCdp, browserCdp, tab, file);
        console.log(`  ✓ ${tab.padEnd(6)} ${info.width}×${info.height}（重试后成功）`);
      } catch (e2) {
        console.log(`  ✗ ${tab} 截图失败：${e2.message}`);
      }
    }
  }

  // ── 素材清单 ──
  const files = ['小宣传图-440x280.png', ...TABS.map((t, i) => `截图${i + 1}-${t}-1280x800.png`)];
  const rows = files.filter((f) => existsSync(join(OUT, f))).map((f) => {
    const b = readFileSync(join(OUT, f));
    const i = inspectPng(b);
    return `  ${f.padEnd(34)} ${i.width}×${i.height}  ${(b.length / 1024).toFixed(0)} KB`;
  });
  console.log('\n产出清单：');
  rows.forEach((r2) => console.log(r2));
  console.log('\n⚠ 我无法肉眼看图。上面只做了程序化校验（尺寸正确、非纯色、颜色数合理），');
  console.log('  请你打开 store/ 目录自己确认一眼观感。');
} catch (e) {
  console.log('\n✗ 失败：' + e.message);
  process.exitCode = 1;
} finally {
  if (pageCdp) pageCdp.close();
  if (browserCdp) browserCdp.close();
  try { spawn('taskkill', ['/PID', String(childPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* 忽略 */ }
  await sleep(1500);
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  try { if (shotExt) rmSync(shotExt, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
