/**
 * Service Worker —— 唯一消息入口，负责编排扫描、缓存与导出。
 *
 * 设计要点：
 * - 不引入任何远程代码（MV3 硬约束）；所有逻辑都打包在扩展内。
 * - 不做常驻轮询；只在侧边栏请求时按需注入并执行。
 * - 采集在当前标签页的 MAIN world 执行（读 window.Shopify 只能在那里），
 *   匹配与估算在扩展上下文执行，两者用 executeScript 的返回值传递。
 */
import { PROBED_GLOBALS } from './lib/signatures.js';
import { collectSignals, collectCatalogue, collectThemeAssets, probeCatalogue } from './lib/injected.js';
import { matchApps, matchPixels, resolveTheme, assessPlus, siteProfile } from './lib/detect.js';
import { summarizeCatalogue, scaleScore, estimateSales } from './lib/estimate.js';
import { buildExport } from './lib/export.js';
import { buildTimeline, loadHistory, saveSnapshot, clearSnapshots } from './lib/timeline.js';

const SCAN_VERSION = 3;
const DEFAULT_SETTINGS = {
  maxPages: 12,
  bestSellerCollections: 3,
  maxHtml: 400000,
  includeCatalogue: true
};

/* ───────────────────────── 存储层 ───────────────────────── */

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

const cacheKey = (tabId) => `scan:${tabId}`;

async function readCache(tabId) {
  try {
    const k = cacheKey(tabId);
    const got = await chrome.storage.session.get(k);
    return got[k] || null;
  } catch { return null; }
}

async function writeCache(tabId, result) {
  try { await chrome.storage.session.set({ [cacheKey(tabId)]: result }); } catch { /* 会话存储可能被清理 */ }
}

async function pushHistory(result) {
  const { history = [] } = await chrome.storage.local.get('history');
  const entry = {
    host: result.host,
    title: result.pageTitle,
    at: Date.now(),
    isShopify: result.isShopify,
    themeName: result.theme && result.theme.name,
    appCount: result.apps.length,
    productCount: result.summary.count,
    revenue: result.estimate && result.estimate.monthlyRevenue
  };
  const next = [entry, ...history.filter((h) => h.host !== entry.host)].slice(0, 200);
  await chrome.storage.local.set({ history: next });
  return next;
}

/* ───────────────────────── 扫描编排 ───────────────────────── */

/** 不能注入的页面类型 */
const BLOCKED_SCHEME = /^(chrome|edge|about|devtools|chrome-extension|moz-extension|view-source|file):/i;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function runInMain(tabId, func, args) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func,
    args: args || []
  });
  if (!res) throw new Error('注入未返回结果');
  if (res.error) throw new Error(String((res.error && res.error.message) || res.error));
  return res.result;
}

/**
 * 执行一次完整扫描。
 * @param {number} tabId
 * @param {{deep?:boolean}} opts deep=false 时跳过产品目录抓取（更快）
 */
async function scan(tabId, opts = {}) {
  const started = Date.now();
  const settings = await getSettings();

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { ok: false, error: '找不到标签页，可能已关闭。' };
  if (BLOCKED_SCHEME.test(tab.url || '')) {
    return { ok: false, error: `浏览器不允许在这类页面上运行（${(tab.url || '').split(':')[0]}://）。请切换到任意网站后重试。` };
  }

  let signals;
  try {
    signals = await runInMain(tabId, collectSignals, [PROBED_GLOBALS, settings.maxHtml]);
  } catch (e) {
    return { ok: false, error: '无法读取页面：' + ((e && e.message) ? e.message : '未知错误') +
      '。若刚刚打开侧边栏，请点击工具栏上的扩展图标重新扫描，以授予当前页面的访问权限。' };
  }
  if (!signals || !signals.ok) return { ok: false, error: '页面信号采集失败。' };

  // 非 Shopify 站点：仍然返回，但明确告知，并给出判定依据
  const apps = matchApps(signals);
  const pixels = matchPixels(signals);
  const theme = resolveTheme(signals);
  const plus = assessPlus(signals);
  const profile = siteProfile(signals);
  const headless = signals.isShopify && theme.status === 'headless';

  let assets = { assets: [], assetCount: 0, sectionCount: 0, sections: [] };
  try { assets = await runInMain(tabId, collectThemeAssets, []); } catch { /* 非关键路径 */ }

  // ---- 产品目录（可选，深扫） ----
  const deep = opts.deep !== false && settings.includeCatalogue;
  let catalogue = {
    products: [], collections: [], bestSellers: [], bestSellersAll: [],
    collectionMembers: [],
    notes: [], productsAvailable: false, collectionsAvailable: false
  };
  if (deep && signals.isShopify) {
    try {
      const probe = await runInMain(tabId, probeCatalogue, []);
      if (probe && probe.available) {
        catalogue = await runInMain(tabId, collectCatalogue, [settings.maxPages, settings.bestSellerCollections]);
      } else {
        catalogue.notes.push(probe && probe.status
          ? `该店铺未公开 products.json（HTTP ${probe.status}），产品库与选品分析不可用。`
          : '该店铺未公开 products.json，产品库与选品分析不可用。');
      }
    } catch (e) {
      catalogue.notes.push('产品目录抓取失败：' + ((e && e.message) ? e.message : '未知错误'));
    }
  }

  const summary = summarizeCatalogue(catalogue.products);
  const scale = scaleScore(summary, { appCount: apps.length, pixelCount: pixels.length });
  const estimate = estimateSales(summary, { appCount: apps.length, pixelCount: pixels.length }, scale);

  const result = {
    ok: true,
    scanVersion: SCAN_VERSION,
    scannedAt: Date.now(),
    elapsedMs: Date.now() - started,
    host: signals.host,
    pageUrl: signals.pageUrl,
    pageTitle: signals.title,
    isShopify: signals.isShopify,
    shopifyScore: signals.shopifyScore,
    shopifyEvidence: signals.shopifyEvidence,
    headless,
    headlessEvidence: theme.headlessEvidence || [],
    theme,
    profile,
    plus,
    apps,
    pixels,
    summary,
    scale,
    estimate,
    catalogue: {
      products: catalogue.products,
      collections: catalogue.collections,
      bestSellers: catalogue.bestSellers,
      bestSellersAll: catalogue.bestSellersAll,
      collectionMembers: catalogue.collectionMembers || [],
      notes: catalogue.notes,
      productsAvailable: catalogue.productsAvailable,
      collectionsAvailable: catalogue.collectionsAvailable
    },
    themeAssets: assets,
    // 原始信号只保留「技术细节」标签页需要的部分，HTML 采样不入库
    signals: {
      scriptSrcs: signals.scriptSrcs,
      linkHrefs: (signals.linkHrefs || []).slice(0, 120),
      windowGlobals: signals.windowGlobals,
      metaTags: signals.metaTags,
      cookieNames: signals.cookieNames,
      htmlLength: signals.htmlLength
    }
  };

  // ---- 店铺动态（「最近订单」） ----
  // 先读历史快照（不含本次）→ 算时间线 → 再把本次快照落盘。
  // 顺序不能反，否则本次快照会被当成"上一次"，所有差分都会是零。
  let timeline = null;
  try {
    const history = await loadHistory(result.host);
    timeline = buildTimeline({ result, history, newWindowDays: 30 });
    result.timeline = timeline;
  } catch (e) {
    result.timeline = { error: '动态计算失败：' + ((e && e.message) ? e.message : '未知错误') };
  }
  try {
    if (timeline && timeline.snapshot) await saveSnapshot(result.host, timeline.snapshot);
  } catch { /* 快照写入失败只影响下次差分，不影响本次结果 */ }

  await writeCache(tabId, result);
  try { await pushHistory(result); } catch { /* 历史写入失败不影响本次结果 */ }
  return result;
}

/* ───────────────────────── 导出 ───────────────────────── */

/**
 * 只负责**生成**导出包，不负责落盘。
 *
 * MV3 的 Service Worker 里没有 Blob URL 下载能力：该 API 已从
 * ServiceWorkerGlobalScope 移除，实测在真浏览器里报 "is not a function"。
 * 这条只有真浏览器能测出来，单测和 Node 干跑都发现不了。
 *
 * 因此把落盘交给侧边栏页面（普通文档上下文，Blob API 齐全）：
 * 见 sidepanel/panel.js 的 doExport()。
 */
async function buildPackage(what, result) {
  const pack = buildExport(result, what);
  if (!pack || typeof pack.content !== 'string') {
    return { ok: false, error: '导出内容生成失败。' };
  }
  return {
    ok: true,
    filename: pack.filename,
    mime: pack.mime,
    content: pack.content,
    bytes: pack.content.length
  };
}

/* ───────────────────────── 消息路由 ───────────────────────── */

const handlers = {
  async ping() { return { ok: true, version: SCAN_VERSION }; },

  async scan(msg) {
    const tabId = msg.tabId ?? (await activeTab())?.id;
    if (!tabId) return { ok: false, error: '没有找到活动标签页。' };
    return scan(tabId, { deep: msg.deep });
  },

  async getCache(msg) {
    const tabId = msg.tabId ?? (await activeTab())?.id;
    if (!tabId) return { ok: false, error: '没有找到活动标签页。' };
    const cached = await readCache(tabId);
    return cached ? { ok: true, cached } : { ok: true, cached: null };
  },

  async export(msg) { return buildPackage(msg.what, msg.result); },

  /** 快照仓库：让用户能查看/清空「最近订单」赖以计算的历史 */
  async snapshots(msg) {
    const got = await chrome.storage.local.get('snapshots');
    const all = got.snapshots || {};
    if (msg.host) {
      const list = all[msg.host] || [];
      return {
        ok: true, host: msg.host, count: list.length,
        snapshots: list.map((s) => ({
          at: s.at,
          products: Object.keys(s.products || {}).length,
          ranks: Object.keys(s.ranks || {}).length,
          theme: s.theme,
          apps: (s.appIds || []).length
        }))
      };
    }
    return {
      ok: true,
      hosts: Object.entries(all).map(([host, list]) => ({ host, count: list.length, lastAt: list.length ? list[list.length - 1].at : null }))
    };
  },
  async clearSnapshots(msg) {
    await clearSnapshots(msg.host);
    return { ok: true };
  },

  async history() {
    const { history = [] } = await chrome.storage.local.get('history');
    return { ok: true, history };
  },
  async clearHistory() {
    await chrome.storage.local.set({ history: [] });
    return { ok: true };
  },

  async favorites() {
    const { favorites = [] } = await chrome.storage.local.get('favorites');
    return { ok: true, favorites };
  },
  async toggleFavorite(msg) {
    const { favorites = [] } = await chrome.storage.local.get('favorites');
    const exists = favorites.some((f) => f.host === msg.host);
    const next = exists
      ? favorites.filter((f) => f.host !== msg.host)
      : [{ host: msg.host, label: msg.label || msg.host, at: Date.now() }, ...favorites];
    await chrome.storage.local.set({ favorites: next });
    return { ok: true, favorites: next, added: !exists };
  },

  async getSettings() { return { ok: true, settings: await getSettings() }; },
  async setSettings(msg) { return { ok: true, settings: await setSettings(msg.patch || {}) }; }
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fn = handlers[msg && msg.action];
  if (!fn) { sendResponse({ ok: false, error: '未知操作：' + (msg && msg.action) }); return false; }
  fn(msg).then(sendResponse).catch((e) => {
    sendResponse({ ok: false, error: (e && e.message) ? e.message : String(e) });
  });
  return true; // 保持通道开启以支持异步响应
});

/* ───────────────────────── 生命周期 ───────────────────────── */

// 点击工具栏图标：打开侧边栏并立刻扫描当前页。
// 这一路是获取 activeTab 授权最可靠的方式，所以作为主路径。
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch { /* 侧边栏可能已经打开 */ }
  try {
    await chrome.storage.session.set({ pendingScan: { tabId: tab.id, at: Date.now() } });
  } catch { /* 忽略 */ }
});

// 页面开始加载时清掉该标签页的缓存，避免把上一页的结果当成本页的
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === 'loading') {
    try { await chrome.storage.session.remove(cacheKey(tabId)); } catch { /* 忽略 */ }
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }); } catch { /* 旧版浏览器不支持 */ }
});
