/**
 * 真实浏览器端到端测试。
 *
 * 用 CDP 驱动浏览器，把扩展真的加载起来，再从**扩展自己的侧边栏页面**发一条
 * 真实消息触发扫描 —— 也就是用户实际会走的那条路径：
 *
 *   侧边栏页面 → chrome.runtime.sendMessage({action:'scan'})
 *     → background.js scan() → scripting.executeScript(MAIN world) → collectSignals
 *     → matchApps / matchPixels / resolveTheme / estimate → 返回结果
 *
 * 为什么不用 Service Worker 上下文直接跑：**HTML 规范禁止在 ServiceWorker
 * 全局作用域使用动态 import()**（见 w3c/ServiceWorker#1356）。扩展自己的
 * background.js 用的是静态 import，不受影响；但测试脚本没法从 SW 里动态加载模块。
 * 走侧边栏页面反而更接近真实路径。
 *
 * 浏览器选择：**Chrome 优先**（目标浏览器）。Chrome 137+ 移除了 `--load-extension`
 * 命令行开关（实测 Chrome 153 下完全无效），但 CDP 的 `Extensions.loadUnpacked`
 * 可用，用它装载扩展。Edge 仍支持该开关，作为兜底。
 *
 * 用法：
 *   node tools/browser-test.mjs https://kuura.co/              # 真实 manifest（仅 activeTab）
 *   node tools/browser-test.mjs https://kuura.co/ --host-perm  # 临时副本补 host_permissions
 *
 * --host-perm 的意义：真实 manifest 只用 activeTab，而 activeTab 必须由用户点击工具栏
 * 授予，自动化启动给不了。该模式在临时副本的 manifest 里加上目标站点的 host_permissions，
 * 用来验证「授权之后」的整条管线。这个差异会在输出里明确标注，不混进结论。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9340;

const BROWSERS = [
  // Chrome 优先：目标浏览器。137+ 起 --load-extension 被移除，改用 CDP 的
  // Extensions.loadUnpacked 装载（实测 Chrome 153 可用，返回扩展 ID）。
  { name: 'Chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', loader: 'cdp' },
  // Edge 兜底：仍支持 --load-extension。
  { name: 'Edge', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', loader: 'flag' },
  { name: 'Edge', path: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', loader: 'flag' }
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function printSteps(steps) {
  console.log('─'.repeat(66));
  for (const s of (steps || [])) {
    if (s.name === '__done__') continue;
    const v = Array.isArray(s.value) ? s.value.map((x) => '        · ' + x).join('\n') : String(s.value);
    console.log(`  ${s.name}：`);
    console.log(`      ${v}`);
  }
  console.log('─'.repeat(66));
}

async function getJson(path, timeoutMs = 2500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { signal: ctrl.signal });
    return await res.json();
  } finally { clearTimeout(t); }
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.exceptions = []; }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, bad) => {
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', () => bad(new Error('WebSocket 连接失败')), { once: true });
    });
    const cdp = new Cdp(ws);
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && cdp.pending.has(msg.id)) {
        const { ok, bad } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        if (msg.error) bad(new Error(msg.error.message)); else ok(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        cdp.exceptions.push(String(msg.params?.exceptionDetails?.exception?.description || '').slice(0, 300));
      } else if (msg.method === 'Log.entryAdded') {
        const e = msg.params?.entry;
        if (e && (e.level === 'error' || e.level === 'warning')) cdp.exceptions.push(`[${e.level}] ${String(e.text).slice(0, 200)}`);
      }
    });
    return cdp;
  }

  send(method, params = {}, timeoutMs = 90000) {
    const id = ++this.id;
    return new Promise((ok, bad) => {
      this.pending.set(id, { ok, bad });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); bad(new Error(`${method} 超时`)); }
      }, timeoutMs);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  close() { try { this.ws.close(); } catch { /* 忽略 */ } }
}

/* ── 在扩展页面上下文里执行的测试主体（用真实消息协议） ── */

function panelTestScript(storePattern, deep) {
  return `(async () => {
  const out = { steps: [], ok: false };
  const step = (name, value) => out.steps.push({ name, value });

  step('扩展 ID', chrome.runtime.id);
  const mf = chrome.runtime.getManifest();
  step('manifest 名称', mf.name + ' v' + mf.version);
  step('permissions', mf.permissions);
  step('host_permissions', mf.host_permissions || '(无 —— 只用 activeTab)');

  // 目标标签页。
  // 注意：扩展没有申请 tabs 权限，所以 chrome.tabs.query({url}) 在没有 host 权限时
  // 匹配不到任何东西（URL 被 Chrome 隐藏）。这里退化为「除了我自己以外的那个标签页」，
  // 用 chrome.tabs.getCurrent() 识别自身 —— 它不需要任何额外权限。
  let tab = (await chrome.tabs.query({ url: ${JSON.stringify(storePattern)} }))[0];
  if (!tab) {
    const me = await chrome.tabs.getCurrent();
    const all = await chrome.tabs.query({});
    tab = all.find(t => t.id !== (me && me.id));
    step('标签页定位方式', tab
      ? '无 host 权限，按「非自身标签页」定位（这正说明 tabs 权限未申请）'
      : '失败');
  } else {
    step('标签页定位方式', '按 URL 精确匹配（已具备该站点 host 权限）');
  }
  if (!tab) { step('目标标签页', '未找到'); return out; }

  for (let i = 0; i < 40 && tab.status !== 'complete'; i++) {
    await new Promise(r => setTimeout(r, 500));
    const t = await chrome.tabs.get(tab.id).catch(() => null);
    if (t) tab.status = t.status;
  }
  const urlShown = tab.url || '(Tab.url 不可见；扩展未申请 tabs 权限，仅凭 host 权限做 URL 过滤，不影响扫描)';
  step('目标标签页', urlShown + '（' + tab.status + '）');

  // 走真实消息协议调用 background.js 的 scan()
  let res;
  try {
    res = await chrome.runtime.sendMessage({ action: 'scan', tabId: tab.id, deep: ${deep} });
  } catch (e) {
    step('scan 消息', '发送失败：' + (e && e.message));
    return out;
  }
  step('scan 消息', '已返回');
  if (!res) { step('scan 结果', '空响应'); return out; }
  if (!res.ok) { step('scan 结果', '失败：' + res.error); out.error = res.error; return out; }

  step('扫描耗时', res.elapsedMs + ' ms');
  step('isShopify', res.isShopify + '（判定分 ' + res.shopifyScore + '）');
  step('判定依据', res.shopifyEvidence);
  step('页面标题', res.pageTitle);

  // 主题
  const t = res.theme;
  step('主题解析', t.label);
  step('主题详情', JSON.stringify({
    name: t.name, schemaName: t.schemaName, schemaVersion: t.schemaVersion,
    storeId: t.storeId, role: t.role, vendor: t.vendor, price: t.price, kind: t.kind,
    derivedFrom: t.derivedFrom, derivation: t.derivation
  }));

  // 应用与像素（含证据）
  step('应用数', res.apps.length);
  step('应用明细', res.apps.map(a => a.name + ' [' + a.category + '/' + a.confidence + '] ← ' + a.evidence.slice(0, 60)));
  step('像素数', res.pixels.length);
  step('像素明细', res.pixels.map(p => p.name + ' [' + p.kind + '] ← ' + p.evidence.slice(0, 60)));

  step('Plus 推测', res.plus.level + '｜' + res.plus.reasons.join('；'));
  step('站点画像', JSON.stringify(res.profile));

  // 规模与估算
  step('规模统计', JSON.stringify({
    count: res.summary.count, variants: res.summary.variants,
    priceMedian: res.summary.priceMedian, discountShare: res.summary.discountShare,
    newLast30d: res.summary.newLast30d
  }));
  step('规模评分', JSON.stringify(res.scale.parts.map(p => p.label + '=' + p.contribution.toFixed(1))));
  step('营收估算', res.estimate.available
    ? ('月订单≈' + res.estimate.monthlyOrders + '，月营收≈' + res.estimate.monthlyRevenue +
       '，客单价≈' + res.estimate.aov + '，置信度 ' + res.estimate.confidence)
    : ('未估算：' + res.estimate.reason));

  // 目录与爆款
  step('目录抓取', '产品 ' + res.catalogue.products.length + ' / 合集 ' + res.catalogue.collections.length +
       ' / 全店爆款 ' + res.catalogue.bestSellersAll.length + ' / 分类爆款组 ' + res.catalogue.bestSellers.length);
  if (res.catalogue.notes && res.catalogue.notes.length) step('目录备注', res.catalogue.notes);
  if (res.catalogue.bestSellersAll.length) {
    step('全店爆款 Top10', res.catalogue.bestSellersAll.slice(0, 10).map(x => '#' + x.rank + ' ' + x.title));
  }
  if (res.catalogue.bestSellers.length) {
    step('分类爆款', res.catalogue.bestSellers.map(c => c.collection + '：' +
      c.items.slice(0, 3).map(i => '#' + i.rank + ' ' + i.title).join('、')));
  }
  if ((res.catalogue.collectionMembers || []).length) {
    step('降级：合集成员（非销量排序）', res.catalogue.collectionMembers.map(c =>
      c.collection + '(' + c.items.length + ' 款)').join('、'));
  }
  step('主题资产', '资产文件 ' + res.themeAssets.assetCount + ' / section ' + res.themeAssets.sectionCount);

  // 店铺变化 / 店铺动态
  const tl = res.timeline;
  if (!tl) { step('店铺动态', '缺失'); }
  else if (tl.error) { step('店铺动态', '错误：' + tl.error); }
  else {
    step('观测基线', '快照 ' + tl.snapshotCount + ' 份｜窗口 ' + Math.round(tl.observationSpanMs / 60000) +
      ' 分钟｜首次扫描=' + (!tl.hasHistory) + '｜纳入追踪 ' + tl.baseline.trackedProducts + ' 款');
    step('变动事件', tl.events.length + ' 条' + (tl.events.length ?
      '：' + tl.events.slice(0, 8).map(e => e.icon + e.label + (e.title ? '(' + e.title.slice(0, 20) + ')' : '') + '[' + e.strength + ']').join(' ') : '（首次扫描无基线，符合预期）'));
    step('最近 30 天上架', tl.recentProducts.length + ' 款' +
      (tl.recentProducts.length ? '｜最新：' + tl.recentProducts.slice(0, 3).map(p => p.title.slice(0, 24)).join('、') : ''));
    step('当前断货', tl.soldOutNow.length + ' 款全部缺货｜' + tl.partlySoldOut.length + ' 款部分缺货' +
      (tl.soldOutNow.length ? '｜' + tl.soldOutNow.slice(0, 3).map(p => p.title.slice(0, 20)).join('、') : ''));
    step('上新节奏', '近 3 月 ' + tl.cadence.last3Months + ' 款 vs 前 3 月 ' + tl.cadence.prev3Months +
      ' 款｜趋势=' + tl.cadence.trend + '｜峰值 ' + (tl.cadence.peakMonth && tl.cadence.peakMonth.key) +
      ' (' + (tl.cadence.peakMonth && tl.cadence.peakMonth.count) + ' 款)');
    step('当前爆款榜', tl.topSellers.length + ' 条' +
      (tl.topSellers.length ? '｜Top3：' + tl.topSellers.slice(0, 3).map(x => '#' + x.rank + ' ' + String(x.title).slice(0, 22)).join('、') : ''));
    step('快照落盘', tl.snapshot ? ('产品 ' + Object.keys(tl.snapshot.products).length + ' / 排名 ' +
      Object.keys(tl.snapshot.ranks).length + ' / 主题指纹 ' + tl.snapshot.theme) : '无');
  }

  // 快照仓库（验证持久化确实生效）
  try {
    const snaps = await chrome.runtime.sendMessage({ action: 'snapshots', host: res.host });
    step('快照仓库', snaps.count + ' 份' + (snaps.count ? '｜最近：' + new Date(snaps.snapshots[snaps.count - 1].at).toLocaleString('zh-CN') : ''));
  } catch (e) { step('快照仓库', '读取失败：' + e.message); }

  // 缓存在浏览器里确实写进去了
  const cached = await chrome.runtime.sendMessage({ action: 'getCache', tabId: tab.id });
  step('会话缓存', cached && cached.cached ? '已写入（' + cached.cached.host + '）' : '未写入');

  out.result = res;
  // 暂存，供后续分阶段测试使用（不再把整个结果在每条消息里来回搬）
  globalThis.__scoutRes = res;
  out.steps.push({ name: '__done__', value: true });
  out.ok = true;
  return out;
})()`;
}

/** 阶段二：导出链路。拆成独立 eval，卡住时不影响已拿到的扫描结果。 */
function exportTestScript() {
  return `(async () => {
  const steps = [];
  const res = globalThis.__scoutRes;
  if (!res) { steps.push({ name: '暂存结果', value: '缺失，阶段一未完成' }); return { steps, ok: false }; }

  steps.push({ name: '面板侧 URL.createObjectURL', value: typeof URL.createObjectURL === 'function'
    ? '可用（符合设计：落盘在页面上下文完成；SW 侧无此 API，故 background 只生成内容）'
    : '不可用 —— 导出会走 data URL 兜底' });

  for (const w of ['products', 'apps', 'pixels', 'collections', 'orders', 'full']) {
    const t0 = Date.now();
    try {
      const p = await chrome.runtime.sendMessage({ action: 'export', what: w, result: res });
      if (!p || !p.ok) { steps.push({ name: '导出 ' + w, value: '失败：' + (p && p.error) }); continue; }
      const blob = new Blob([p.content], { type: p.mime });
      const url = URL.createObjectURL(blob);
      const okBlob = typeof url === 'string' && url.startsWith('blob:');
      URL.revokeObjectURL(url);
      steps.push({ name: '导出 ' + w, value: p.filename + '｜' + (p.bytes / 1024).toFixed(1) + ' KB｜Blob URL ' +
        (okBlob ? 'OK' : 'FAIL') + '｜' + (Date.now() - t0) + ' ms' });
    } catch (e) {
      steps.push({ name: '导出 ' + w, value: '异常：' + (e && e.message) });
    }
  }
  steps.push({ name: '__done__', value: true });
  return { steps, ok: true };
})()`;
}

/** 阶段三：缓存与会话状态 */
function stateTestScript() {
  return `(async () => {
  const steps = [];
  const res = globalThis.__scoutRes;
  const me = await chrome.tabs.getCurrent();
  const tabs = await chrome.tabs.query({});
  const target = tabs.find(t => t.id !== (me && me.id));
  if (target && res) {
    const cached = await chrome.runtime.sendMessage({ action: 'getCache', tabId: target.id });
    steps.push({ name: '会话缓存', value: cached && cached.cached
      ? '已写入（' + cached.cached.host + '，扫描于 ' + new Date(cached.cached.scannedAt).toLocaleTimeString('zh-CN') + '）'
      : '未写入' });
  }
  const hist = await chrome.runtime.sendMessage({ action: 'history' });
  steps.push({ name: '扫描历史', value: (hist.history || []).length + ' 条' +
    ((hist.history || []).length ? '｜最新：' + hist.history[0].host : '') });
  const fav = await chrome.runtime.sendMessage({ action: 'toggleFavorite', host: 'kuura.co', label: 'Kuura 测试' });
  steps.push({ name: '收藏写入', value: fav.added ? '成功（' + fav.favorites.length + ' 条）' : '未新增' });
  const fav2 = await chrome.runtime.sendMessage({ action: 'toggleFavorite', host: 'kuura.co', label: 'Kuura 测试' });
  steps.push({ name: '收藏撤销', value: fav2.added ? '未撤销' : '成功（' + fav2.favorites.length + ' 条）' });
  steps.push({ name: '__done__', value: true });
  return { steps, ok: true };
})()`;
}

/** 阶段四：人为构造一份「上次扫描」，再扫一次，验证差分真的产出事件。
 *
 *  这是「店铺变化」功能的核心验证：不构造基线就永远只有首次扫描的形态，
 *  差分逻辑等于没被测过。做法是把刚生成的快照改造成一个已知的过去状态，
 *  再按确定的方式让它与真实状态产生差异，然后检查事件是否精确匹配。
 */
function diffTestPrepareScript() {
  return `(async () => {
  const steps = [];
  const harness = globalThis.__diffHarness = { expect: [] };
  const host = globalThis.__scoutRes && globalThis.__scoutRes.host;
  if (!host) { steps.push({ name: '前置', value: '缺少阶段一结果' }); return { steps, ok: false }; }

  const key = 'snapshots';
  const got = await chrome.storage.local.get(key);
  const all = got[key] || {};
  const list = all[host] || [];
  if (!list.length) { steps.push({ name: '前置', value: '没有可用快照' }); return { steps, ok: false }; }

  // 取最新一份，改造成「三天前的一次扫描」
  const prev = JSON.parse(JSON.stringify(list[list.length - 1]));
  prev.at = Date.now() - 3 * 86400000;

  const handles = Object.keys(prev.products);
  steps.push({ name: '基线构造', value: '基于 ' + handles.length + ' 款产品，时间回拨到 3 天前' });

  // ① 制造「售罄」：找一个当前无货的产品，让基线里它有货
  const soldOutNow = (globalThis.__scoutRes.catalogue.products || [])
    .filter(p => p.variantCount > 0 && p.availableVariants === 0);
  if (soldOutNow.length) {
    const h = soldOutNow[0].handle;
    if (prev.products[h]) {
      prev.products[h][1] = prev.products[h][2] || 3;
      harness.expect.push({ kind: 'sold_out', handle: h, title: soldOutNow[0].title });
    }
  }

  // ② 制造「补货」：找一个当前有货的产品，让基线里它无货
  const inStock = (globalThis.__scoutRes.catalogue.products || [])
    .filter(p => p.variantCount > 0 && p.availableVariants > 0);
  if (inStock.length) {
    const h = inStock[0].handle;
    if (prev.products[h]) {
      prev.products[h][1] = 0;
      harness.expect.push({ kind: 'restocked', handle: h, title: inStock[0].title });
    }
  }

  // ③ 制造「涨价」：改动某个产品的基线价格
  if (inStock.length > 1) {
    const h = inStock[1].handle;
    if (prev.products[h] && prev.products[h][0] > 0) {
      prev.products[h][0] = Math.round(prev.products[h][0] * 0.5 * 100) / 100;
      harness.expect.push({ kind: 'price_rise', handle: h, title: inStock[1].title });
    }
  }

  // ④ 制造「新品」：从基线里删掉一个产品（当前存在、基线不存在）
  if (handles.length > 3) {
    const h = handles[handles.length - 1];
    delete prev.products[h];
    harness.expect.push({ kind: 'new_product', handle: h, title: '(基线中缺失)' });
  }

  // ⑤ 制造「下架」：往基线里塞一个当前不存在的产品
  {
    const fake = 'diff-test-ghost-product';
    prev.products[fake] = [9.99, 1, 1];
    harness.expect.push({ kind: 'delisted', handle: fake, title: '(构造的下架产品)' });
  }

  // ⑥ 制造排名变化
  // rh[0] 是插入顺序里的第一个，也就是第 1 名；交换前两名后：
  //   基线里 a=第2名，本次真实是第1名 → 名次前移，应报 rank_up
  //   基线里 b=第1名，本次真实是第2名 → 名次后移，应报 rank_down
  const ranks = prev.ranks || {};
  const rh = Object.keys(ranks);
  if (rh.length >= 2) {
    const a = rh[0], b = rh[1];
    const ra = ranks[a], rb = ranks[b];
    ranks[a] = rb; ranks[b] = ra;   // 互换前两名
    harness.expect.push({ kind: 'rank_up', handle: a });
    harness.expect.push({ kind: 'rank_down', handle: b });
  } else {
    steps.push({ name: '排名基线', value: '该店无排名数据，跳过排名差分' });
  }

  // ⑦ 制造应用变化
  if (!prev.appIds.includes('diff-test-app')) {
    prev.appIds = prev.appIds.concat(['diff-test-app']);
    harness.expect.push({ kind: 'app_removed', appId: 'diff-test-app' });
  }

  list.push(prev);            // 追加为「最近一次历史」
  all[host] = list;
  await chrome.storage.local.set({ [key]: all });

  steps.push({ name: '已构造的期望事件', value: harness.expect.map(e => e.kind + (e.handle ? ':' + String(e.title || e.handle).slice(0, 24) : ':' + e.appId)) });
  steps.push({ name: '快照总数', value: (all[host] || []).length + ' 份（含构造的基线）' });
  steps.push({ name: '__done__', value: true });
  return { steps, ok: true };
})()`;
}

/** 阶段四之二：重新扫描并核对事件 */
function diffTestVerifyScript(deep) {
  return `(async () => {
  const steps = [];
  const harness = globalThis.__diffHarness || { expect: [] };
  const me = await chrome.tabs.getCurrent();
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find(t => t.id !== (me && me.id));
  if (!tab) { steps.push({ name: '目标标签页', value: '未找到' }); return { steps, ok: false }; }

  const res = await chrome.runtime.sendMessage({ action: 'scan', tabId: tab.id, deep: ${deep} });
  if (!res || !res.ok) { steps.push({ name: '二次扫描', value: '失败：' + (res && res.error) }); return { steps, ok: false }; }
  const tl = res.timeline;
  steps.push({ name: '二次扫描', value: '成功，耗时 ' + res.elapsedMs + ' ms' });
  steps.push({ name: '快照份数', value: tl.snapshotCount + ' 份｜观测窗口 ' +
    (tl.observationSpanMs / 86400000).toFixed(2) + ' 天｜hasHistory=' + tl.hasHistory });
  steps.push({ name: '本次变动', value: tl.events.length + ' 条' });
  steps.push({ name: '强证据事件', value: tl.strongEvents.length + ' 条｜' +
    tl.strongEvents.slice(0, 12).map(e => e.label + ' ← ' + String(e.detail || '').slice(0, 40)).join(' ／ ') });

  // 逐条核对我构造的期望是否精确命中
  const got = tl.events.map(e => e.kind + '|' + (e.handle || e.appId || ''));
  const checks = harness.expect.map(x => {
    const key = x.kind + '|' + (x.handle || x.appId);
    return { expect: x.kind + ':' + String(x.title || x.handle || x.appId).slice(0, 22), hit: got.includes(key) };
  });
  const miss = checks.filter(c => !c.hit);
  steps.push({ name: '期望事件命中', value: (checks.length - miss.length) + '/' + checks.length +
    (miss.length ? '｜未命中：' + miss.map(m => m.expect).join('、') : '｜全部命中') });

  // 事件必须带上产品标题（handle → 标题的解析要正确）
  const titled = tl.events.filter(e => e.handle && e.title && e.title !== e.handle).length;
  const withHandle = tl.events.filter(e => e.handle).length;
  steps.push({ name: '事件标题解析', value: titled + '/' + withHandle + ' 条带 handle 的事件解析出中文标题' });

  // 有事件时导出「店铺变化」CSV，确认事件真的落进了文件
  try {
    const p = await chrome.runtime.sendMessage({ action: 'export', what: 'orders', result: res });
    if (p && p.ok) {
      const lines = p.content.replace(/^\\ufeff/, '').split('\\r\\n').filter(Boolean);
      const dataRows = lines.length - 1;
      steps.push({ name: '导出店铺变化 CSV', value: p.filename + '｜' + (p.bytes / 1024).toFixed(1) +
        ' KB｜数据行 ' + dataRows + '（事件 ' + tl.events.length + ' 条）' });
      if (dataRows !== tl.events.length) {
        steps.push({ name: '⚠ CSV 行数不一致', value: '数据行 ' + dataRows + ' ≠ 事件数 ' + tl.events.length });
      }
      steps.push({ name: 'CSV 前 3 行', value: lines.slice(0, 3).map(l => l.slice(0, 110)) });
    } else {
      steps.push({ name: '导出店铺变化 CSV', value: '失败：' + (p && p.error) });
    }
  } catch (e) { steps.push({ name: '导出店铺变化 CSV', value: '异常：' + e.message }); }

  globalThis.__diffResult = res;
  steps.push({ name: '__done__', value: true });
  return { steps, ok: true };
})()`;
}

/** 阶段五：UI 文案实测 —— 点开每个标签页，把真实渲染出来的文字抓回来。
 *  这一层只有真浏览器能测：模板串拼错了、变量名写错了，Node 层完全发现不了。 */
function uiTextScript() {
  return `(async () => {
  const steps = [];
  const tabs = [...document.querySelectorAll('.tab')];
  steps.push({ name: '标签页', value: tabs.map(t => t.textContent.trim()).join(' / ') });

  for (const tab of tabs) {
    const name = tab.textContent.replace(/\\s*\\d+\\s*$/, '').trim();
    tab.click();
    await new Promise(r => setTimeout(r, 140));
    const el = document.querySelector('#content');
    const text = (el.innerText || '').replace(/\\n{2,}/g, '\\n').trim();
    const heads = [...el.querySelectorAll('h3')].map(h => h.textContent.trim().replace(/\\s+/g, ' '));
    steps.push({ name: '「' + name + '」渲染', value: text.length + ' 字｜小标题：' + (heads.join(' | ') || '（无）') });
    if (/undefined|NaN|\\[object Object\\]|\\$\\{/.test(text)) {
      steps.push({ name: '⚠ 「' + name + '」模板可能有错', value: (text.match(/[^\\n]{0,60}(undefined|NaN|\\[object Object\\]|\\$\\{)[^\\n]{0,60}/g) || []).slice(0, 3) });
    }
  }

  const ordersTab = tabs.find(t => t.textContent.includes('店铺变化'));
  if (ordersTab) {
    ordersTab.click();
    await new Promise(r => setTimeout(r, 180));
    const text = document.querySelector('#content').innerText || '';
    steps.push({ name: '「店铺变化」开头说明（实际渲染）', value: text.slice(0, 500).split('\\n').filter(Boolean) });
  }

  // 联系方式必须在界面上真实可见（这是用户明确要求的功能，不能只写在代码里）
  const exportTab = tabs.find(t => t.textContent.includes('导出'));
  if (exportTab) {
    exportTab.click();
    await new Promise(r => setTimeout(r, 220));
    const t = document.querySelector('#content').innerText || '';
    const hasQQ = t.includes('1611744064');
    steps.push({ name: '联系方式（QQ 1611744064）', value: hasQQ
      ? '✓ 已出现在「导出 → 联系与更新」卡片，且说明了两条用途'
      : '✗ 界面上找不到 QQ 号' });
    if (!hasQQ) steps.push({ name: '⚠ 联系方式缺失', value: t.slice(0, 300) });
    const roles = ['负责调整 BUG', '新版本发布的第一通知号'].filter(k => t.includes(k));
    steps.push({ name: 'QQ 用途说明', value: roles.length + '/2 条已展示：' + roles.join('、') });
  }

  steps.push({ name: '__done__', value: true });
  return { steps, ok: true };
})()`;
}

/* ── 主流程 ── */

async function run(target, useHostPerm) {
  let browser = null;
  for (const b of BROWSERS) if (existsSync(b.path)) { browser = b; break; }
  if (!browser) throw new Error('找不到 Chrome 或 Edge');

  const userDataDir = mkdtempSync(join(tmpdir(), 'scout-cdp-'));
  let tempExt = null;
  let extDir = ROOT;

  if (useHostPerm) {
    tempExt = mkdtempSync(join(tmpdir(), 'scout-ext-'));
    cpSync(ROOT, tempExt, {
      recursive: true,
      filter: (src) => !/[/\\](test|tools|docs|node_modules)[/\\]?$/.test(src)
    });
    const mfPath = join(tempExt, 'manifest.json');
    const mf = JSON.parse(readFileSync(mfPath, 'utf8'));
    const host = new URL(target).origin + '/*';
    mf.host_permissions = [host];
    writeFileSync(mfPath, JSON.stringify(mf, null, 2));
    extDir = tempExt;
    console.log(`\n⚠ 测试模式：临时副本的 manifest 追加了 host_permissions: ["${host}"]`);
    console.log('  真实 manifest 不含此项（只用 activeTab）。该差异只影响「权限授予方式」，');
    console.log('  被测的检测/匹配/估算/导出代码路径完全相同。\n');
  } else {
    console.log('\n模式：真实 manifest（仅 activeTab，无 host_permissions）\n');
  }

  const args = [
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-gpu',
    '--window-size=1400,950', '--window-position=0,0',
    target
  ];
  // Chrome 137+ 移除了 --load-extension，改用 CDP 的 Extensions.loadUnpacked 装载；
  // Edge 仍支持该开关，走老路。
  if (browser.loader === 'flag') {
    args.splice(4, 0, `--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`);
  }

  console.log(`启动 ${browser.name}（装载方式：${browser.loader === 'cdp' ? 'CDP Extensions.loadUnpacked' : '--load-extension'}）…`);
  const proc = spawn(browser.path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  const childPid = proc.pid;
  const stderrChunks = [];
  proc.stderr.on('data', (d) => stderrChunks.push(d.toString()));

  let browserCdp = null, pageCdp = null;
  try {
    let version = null;
    for (let i = 0; i < 80; i++) {
      await sleep(500);
      try { version = await getJson('/json/version'); break; } catch { /* 继续等 */ }
    }
    if (!version) throw new Error('CDP 端口未就绪');
    console.log(`${version.Browser} 已就绪`);

    browserCdp = await Cdp.connect(version.webSocketDebuggerUrl);

    if (browser.loader === 'cdp') {
      console.log(`正在装载扩展：${extDir}`);
      const r = await browserCdp.send('Extensions.loadUnpacked', { path: extDir }, 30000);
      console.log(`✓ Extensions.loadUnpacked 返回 ${JSON.stringify(r)}`);
    }

    // 找扩展自己的 Service Worker —— 用 manifest 里的文件名精确匹配，
    // 避免误抓浏览器内置扩展（实测 Chrome/Edge 各带若干内置 SW）。
    let sw = null;
    for (let i = 0; i < 60; i++) {
      const list = await getJson('/json/list').catch(() => []);
      sw = list.find((t) => t.type === 'service_worker' &&
        t.url.startsWith('chrome-extension://') && t.url.endsWith('/background.js'));
      if (sw) break;
      await sleep(500);
    }
    if (!sw) {
      console.log('\n✗ 未找到扩展的 Service Worker（background.js 未注册）。');
      const list = await getJson('/json/list').catch(() => []);
      console.log('\n当前全部 target：');
      for (const t of list) console.log(`  [${t.type}] ${String(t.url).slice(0, 120)}`);
      const errs = stderrChunks.join('').split('\n').filter((l) => /extension|manifest|load|error/i.test(l));
      console.log('\n浏览器 stderr 相关行：');
      console.log(errs.length ? errs.slice(-20).join('\n') : '(无)');
      console.log(`\n临时扩展目录：${extDir}`);
      return { failed: '扩展未注册' };
    }

    const extId = new URL(sw.url).host;
    console.log(`✓ 扩展已加载并注册 Service Worker：${extId}`);

    // 打开扩展自己的侧边栏页面，从那里发真实消息（走用户路径）
    const panelUrl = `chrome-extension://${extId}/sidepanel/index.html`;
    await browserCdp.send('Target.createTarget', { url: panelUrl });
    console.log('✓ 已打开侧边栏页面（作为标签页）');

    let panelTarget = null;
    for (let i = 0; i < 40; i++) {
      const list = await getJson('/json/list').catch(() => []);
      panelTarget = list.find((t) => t.type === 'page' && t.url === panelUrl);
      if (panelTarget) break;
      await sleep(400);
    }
    if (!panelTarget) throw new Error('侧边栏页面未出现');

    pageCdp = await Cdp.connect(panelTarget.webSocketDebuggerUrl);
    await pageCdp.send('Runtime.enable');
    await pageCdp.send('Log.enable');

    // UI 冒烟：panel.js 是否无错渲染
    await sleep(1500);
    const ui = await pageCdp.eval(`(() => {
      const c = document.querySelector('#content');
      return {
        title: document.title,
        tabs: [...document.querySelectorAll('.tab')].map(t => t.textContent.trim()),
        hasScanBtn: !!document.querySelector('#scanBtn'),
        contentLen: c ? c.innerHTML.length : 0,
        hostLabel: document.querySelector('#hostLabel') ? document.querySelector('#hostLabel').textContent : null
      };
    })()`);
    console.log('\n── UI 冒烟 ──');
    console.log('  标题：' + ui.title);
    console.log('  标签页：' + ui.tabs.join(' / '));
    console.log('  扫描按钮：' + (ui.hasScanBtn ? '存在' : '缺失') + '｜内容区渲染 ' + ui.contentLen + ' 字符');
    console.log('  店铺标签：' + ui.hostLabel);

    console.log('\n── 阶段一：通过真实消息触发扫描 ──\n');
    const result = await pageCdp.eval(panelTestScript(`${new URL(target).origin}/*`, true));
    printSteps(result.steps);

    if (result.ok) {
      console.log('\n── 阶段二：导出链路（background 生成 → 面板转 Blob）──\n');
      try {
        const exp = await pageCdp.eval(exportTestScript());
        printSteps(exp.steps);
      } catch (e) {
        console.log(`  ✗ 导出阶段未完成：${e.message}`);
      }

      console.log('\n── 阶段三：缓存与设置 ──\n');
      try {
        const st = await pageCdp.eval(stateTestScript());
        printSteps(st.steps);
      } catch (e) {
        console.log(`  ✗ 状态阶段未完成：${e.message}`);
      }

      console.log('\n── 阶段四：差分验证（构造历史基线 → 重扫 → 核对事件）──\n');
      try {
        const prep = await pageCdp.eval(diffTestPrepareScript());
        printSteps(prep.steps);
        if (prep.ok) {
          const ver = await pageCdp.eval(diffTestVerifyScript(true));
          printSteps(ver.steps);
        }
      } catch (e) {
        console.log(`  ✗ 差分阶段未完成：${e.message}`);
      }

      console.log('\n── 阶段五：界面文案实测（每个标签页的真实渲染）──\n');
      try {
        // 关键：真实侧边栏不是标签页，活动标签是店铺页。
        // 本测试把面板开成了标签页，所以必须先把店铺页切回活动标签，
        // 否则面板的 currentTab() 会拿到它自己，缓存自然查不到。
        const all = await getJson('/json/list').catch(() => []);
        const storeT = all.find((t) => t.type === 'page' && String(t.url).startsWith(new URL(target).origin));
        if (storeT) await browserCdp.send('Target.activateTarget', { targetId: storeT.id }).catch(() => { /* 忽略 */ });
        await sleep(600);

        // 面板只在打开那一刻读一次缓存，所以要重载一次来复现「用户点图标后打开面板」
        await pageCdp.send('Page.enable', {}).catch(() => { /* 部分版本无需 enable */ });
        await pageCdp.send('Page.reload', { ignoreCache: false });
        await sleep(3200);

        const ui2 = await pageCdp.eval(uiTextScript());
        printSteps(ui2.steps);
      } catch (e) {
        console.log(`  ✗ 界面阶段未完成：${e.message}`);
      }
    }

    const errs = [...pageCdp.exceptions, ...(browserCdp.exceptions || [])];
    if (errs.length) {
      console.log('\n页面控制台错误：');
      for (const e of [...new Set(errs)].slice(0, 8)) console.log('  ' + e);
    } else {
      console.log('\n✓ 无页面控制台错误');
    }

    return result;
  } finally {
    if (pageCdp) pageCdp.close();
    if (browserCdp) browserCdp.close();
    // 只结束后台任务自己启动的浏览器进程树
    if (childPid) {
      try { spawn('taskkill', ['/PID', String(childPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* 忽略 */ }
    }
    await sleep(1500);
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    if (tempExt) { try { rmSync(tempExt, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  }
}

const target = process.argv[2];
const useHostPerm = process.argv.includes('--host-perm');
if (!target) { console.log('用法：node tools/browser-test.mjs <url> [--host-perm]'); process.exit(1); }

console.log('选品侦探 · 真实浏览器端到端测试');
console.log(`目标：${target}`);
console.log(`时间：${new Date().toISOString()}`);

const result = await run(target, useHostPerm);
console.log(`\n结果：${result && result.ok ? '管线在真实浏览器中跑通' : '未跑通'}`);
process.exit(result && result.ok ? 0 : 1);
