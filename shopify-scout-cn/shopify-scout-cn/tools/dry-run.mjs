/**
 * 真实站点干跑 —— 不打开浏览器，用扩展自己的检测管线打真实 Shopify 店铺。
 *
 * 作用：把「MAIN world 采集 → 指纹匹配 → 主题解析 → 目录抓取 → 估算」整条链路
 * 在 Node 下跑通一遍，验证签名库在真实站点上确实命中，而不是只在测试夹具上成立。
 *
 * 用法：node tools/dry-run.mjs https://store.example [https://store2.example ...]
 */
import { PROBED_GLOBALS } from '../lib/signatures.js';
import { matchApps, matchPixels, resolveTheme, assessPlus, siteProfile } from '../lib/detect.js';
import { summarizeCatalogue, scaleScore, estimateSales } from '../lib/estimate.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

/**
 * 用正则从 HTML 里还原 collectSignals 在浏览器里会采到的东西。
 * 这里刻意不复用 lib/injected.js —— 那是浏览器 API 写的，Node 里跑不了；
 * 但这个函数产出的 signals 结构必须与它完全一致，否则干跑就没意义。
 */
function signalsFromHtml(html, baseUrl) {
  const u = new URL(baseUrl);
  const abs = (h) => { try { return new URL(h, u.origin).href; } catch { return null; } };

  const scriptSrcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
    .map((m) => abs(m[1])).filter(Boolean).slice(0, 400);

  const EXCLUDED = ['canonical', 'next', 'prev', 'alternate', 'shortlink', 'amphtml'];
  const linkHrefs = [...html.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]*>/gi)]
    .filter((m) => {
      const tag = m[0].toLowerCase();
      return !EXCLUDED.some((r) => new RegExp(`rel=["'][^"']*\\b${r}\\b`).test(tag));
    })
    .map((m) => abs(m[1])).filter(Boolean).slice(0, 300);

  const inlineScripts = [...html.matchAll(/<script(?![^>]+src=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1]).join('\n').slice(0, 120000);

  const metaTags = [...html.matchAll(/<meta\s+([^>]+)>/gi)].map((m) => {
    const attrs = m[1];
    const name = (attrs.match(/(?:name|property)=["']([^"']+)["']/i) || [])[1] || '';
    const content = (attrs.match(/content=["']([^"']*)["']/i) || [])[1] || '';
    return { name, content: content.slice(0, 300) };
  }).filter((t) => t.name).slice(0, 150);

  // HTML 里能看到的全局变量赋值（浏览器里我们直接读 window，这里只能靠文本推断）
  const windowGlobals = PROBED_GLOBALS.filter((g) => {
    const re = new RegExp(`(?:var|let|const|window\\.)\\s*${g}\\b|window\\[[\"']${g}[\"']\\]|\\b${g}\\s*=\\s*`, 'i');
    return re.test(inlineScripts) || re.test(html);
  });

  // 主题对象：从内联脚本里还原 Shopify.theme。
  //
  // ⚠️ 这一步只在干跑里存在，且永远不如浏览器准：扩展在页面里直接读
  // window.Shopify.theme.name，那是权威值。这里只能靠文本猜，所以宁可
  // 返回 null 由调用方标注「无法判定」，也不能随便抓一个 "name" 字段冒充——
  // 实测过：不做锚定会抓到 "[DNAM Theme July 2026]"、"Sept 10, 2026" 这类
  // 完全无关的字符串，把干跑结论污染成假数据。
  let theme = null;
  for (const anchor of ['"theme_store_id"', '"theme_store_id":', 'theme_store_id']) {
    const i = inlineScripts.indexOf(anchor);
    if (i < 0) continue;
    const win = inlineScripts.slice(Math.max(0, i - 400), i + 400);
    const name = win.match(/"name"\s*:\s*"([^"]{1,60})"/);
    const id = win.match(/"id"\s*:\s*(\d+)/);
    const role = win.match(/"role"\s*:\s*"([^"]{1,20})"/);
    const storeId = win.match(/"theme_store_id"\s*:\s*(null|\d+)/);
    if (name) {
      const schema = win.match(/"schema_name"\s*:\s*"([^"]{1,60})"/);
      const schemaVer = win.match(/"schema_version"\s*:\s*"([^"]{1,20})"/);
      theme = {
        name: name[1],
        id: id ? Number(id[1]) : null,
        role: role ? role[1] : null,
        schema_name: schema ? schema[1] : null,
        schema_version: schemaVer ? schemaVer[1] : null,
        theme_store_id: storeId && storeId[1] !== 'null' ? Number(storeId[1]) : null
      };
    }
    break;
  }
  // 退一步：找 role:"main" 附近的名字（老版 Shopify 会省略 theme_store_id）
  if (!theme) {
    const i = inlineScripts.search(/"role"\s*:\s*"main"/);
    if (i >= 0) {
      const win = inlineScripts.slice(Math.max(0, i - 400), i + 400);
      const name = win.match(/"name"\s*:\s*"([^"]{1,60})"/);
      if (name) theme = { name: name[1], id: null, role: 'main', theme_store_id: null };
    }
  }

  const isShopify = /cdn\.shopify\.com|cdn\.shopifycdn\.|myshopify\.com|Shopify\.theme|shopify-checkout-api-token/i.test(html);

  return {
    ok: true,
    host: u.hostname,
    pageUrl: u.origin,
    isShopify,
    shopifyScore: isShopify ? 6 : 0,
    shopifyEvidence: isShopify ? ['HTML 中出现 Shopify 特征'] : [],
    shopify: { shop: (html.match(/Shopify\.shop\s*=\s*["']([^"']+)/) || [])[1] || null,
      country: null, locale: null, currency: null, permanent_domain: null },
    theme,
    scriptSrcs, linkHrefs, inlineScripts, windowGlobals, metaTags,
    cookieNames: [],
    htmlSample: html.slice(0, 400000),
    htmlLength: html.length,
    title: (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || '',
    currency: null, country: null, locale: (html.match(/<html[^>]+lang=["']([^"']+)/i) || [])[1] || null
  };
}

async function fetchText(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal, redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/json,*/*' }
    });
    return { ok: res.ok, status: res.status, text: res.ok ? await res.text() : '' };
  } finally { clearTimeout(timer); }
}

async function dryRun(baseUrl) {
  const origin = new URL(baseUrl).origin;
  console.log('\n' + '='.repeat(64));
  console.log(`店铺：${origin}`);
  console.log('='.repeat(64));

  let home;
  try { home = await fetchText(origin); }
  catch (e) { console.log(`  ✗ 首页抓取失败：${e.message}`); return { host: new URL(baseUrl).hostname, failed: true }; }

  if (!home.ok) { console.log(`  ✗ 首页返回 HTTP ${home.status}`); return { host: new URL(baseUrl).hostname, failed: true }; }
  console.log(`  首页 HTTP ${home.status}，${home.text.length} 字符`);

  const signals = signalsFromHtml(home.text, baseUrl);
  console.log(`  Shopify 判定：${signals.isShopify ? '是' : '否'}`);
  console.log(`  采集到：脚本 ${signals.scriptSrcs.length}、资源链接 ${signals.linkHrefs.length}、全局变量 ${signals.windowGlobals.length}`);

  const apps = matchApps(signals);
  const pixels = matchPixels(signals);
  const theme = resolveTheme(signals);

  console.log(`\n  ── 主题 ──`);
  if (theme.name) {
    console.log(`  ${theme.label}：${theme.name}` +
      (theme.vendor ? `（${theme.vendor} · ${theme.price} · ${theme.kind}）` : ''));
    if (theme.schemaName) console.log(`  schema：${theme.schemaName}${theme.schemaVersion ? ' v' + theme.schemaVersion : ''}`);
    if (theme.derivedFrom) console.log(`  底座血缘（确定）：${theme.derivedFrom.name} · 依据 ${theme.derivedFrom.source}`);
  } else {
    // 干跑拿不到 ≠ 扩展拿不到，必须把话说清楚，否则会误判成功能缺失
    console.log(`  ${theme.label}｜干跑无法判定主题名：HTML 里没有 Shopify.theme 的可靠文本形式。`);
    console.log(`  浏览器中扩展直接读 window.Shopify.theme.name，此处不代表扩展失效。`);
  }
  if (signals.isShopify && !signals.scriptSrcs.length) {
    console.log(`  ⚠ 未从 HTML 采到任何 script[src]：该店铺疑似 JS 渲染或做了脚本内联，`);
    console.log(`    应用/像素识别率会显著偏低，这一条不计入指纹库的评价。`);
  }
  if (theme.derivation?.length) console.log(`  血缘推测：${theme.derivation.map((d) => d.base).join('、')}`);

  console.log(`\n  ── 已装应用（${apps.length}）──`);
  const byCat = new Map();
  for (const a of apps) { if (!byCat.has(a.category)) byCat.set(a.category, []); byCat.get(a.category).push(a); }
  for (const [cat, items] of byCat) {
    console.log(`  [${cat}] ${items.map((a) => a.name + (a.confidence === 'high' ? '' : `(${a.confidence})`)).join('、')}`);
  }
  if (!apps.length) console.log('  （无命中）');

  console.log(`\n  ── 追踪像素（${pixels.length}）──`);
  console.log('  ' + (pixels.map((p) => `${p.name}[${p.kind}]`).join('、') || '（无命中）'));

  const plus = assessPlus(signals);
  console.log(`\n  ── Plus 推测：${plus.level} ──`);
  for (const r of plus.reasons) console.log('  · ' + r);

  // ---- 产品目录 ----
  let products = [];
  try {
    for (let page = 1; page <= 3; page++) {
      const r = await fetchText(`${origin}/products.json?limit=250&page=${page}`);
      if (!r.ok) { if (page === 1) console.log(`\n  ── 产品目录：HTTP ${r.status}（未公开）──`); break; }
      const batch = JSON.parse(r.text).products || [];
      products.push(...batch.map((p) => {
        const variants = p.variants || [];
        const prices = variants.map((v) => parseFloat(v.price)).filter(Number.isFinite);
        const cmp = variants.map((v) => parseFloat(v.compare_at_price)).filter(Number.isFinite);
        return {
          id: p.id, title: p.title, handle: p.handle, vendor: p.vendor, productType: p.product_type,
          createdAt: p.created_at, tags: p.tags || [],
          price: prices.length ? Math.min(...prices) : null,
          compareAtPrice: cmp.length ? Math.max(...cmp) : null,
          variantCount: variants.length,
          availableVariants: variants.filter((v) => v.available).length
        };
      }));
      if (batch.length < 250) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  } catch (e) { console.log(`\n  产品目录抓取异常：${e.message}`); }

  if (products.length) {
    const summary = summarizeCatalogue(products);
    const scale = scaleScore(summary, { appCount: apps.length, pixelCount: pixels.length });
    const est = estimateSales(summary, { appCount: apps.length, pixelCount: pixels.length }, scale);
    console.log(`\n  ── 目录与估算（前 ${products.length} 条采样）──`);
    console.log(`  产品数 ${summary.count}，SKU ${summary.variants}，价格中位 ${summary.priceMedian?.toFixed(2)}`);
    console.log(`  打折占比 ${(summary.discountShare * 100).toFixed(1)}%，近 30 天上新 ${summary.newLast30d}`);
    console.log(`  规模评分 ${scale.score}/100 → 月订单量≈${est.monthlyOrders}，月营收≈${est.monthlyRevenue}（置信度 ${est.confidence}）`);
  }

  return { host: new URL(baseUrl).hostname, apps: apps.length, pixels: pixels.length, theme: theme.name, products: products.length };
}

/* ── 入口 ── */
const urls = process.argv.slice(2);
if (!urls.length) {
  console.log('用法：node tools/dry-run.mjs https://store1.example https://store2.example');
  process.exit(1);
}

console.log('选品侦探 · 真实站点干跑');
console.log(`时间：${new Date().toISOString()}`);

const results = [];
for (const u of urls) {
  try { results.push(await dryRun(u)); }
  catch (e) { console.log(`\n  ✗ ${u} 处理失败：${e.message}`); results.push({ host: u, failed: true }); }
}

console.log('\n' + '='.repeat(64));
console.log('汇总');
console.log('='.repeat(64));
console.log('  站点'.padEnd(30) + '应用  像素  主题');
for (const r of results) {
  if (r.failed) { console.log(`  ${r.host.padEnd(28)} 失败`); continue; }
  console.log(`  ${r.host.padEnd(28)} ${String(r.apps).padStart(3)}  ${String(r.pixels).padStart(4)}  ${r.theme || '未识别'}`);
}
const totalApps = results.reduce((a, r) => a + (r.apps || 0), 0);
const totalPixels = results.reduce((a, r) => a + (r.pixels || 0), 0);
console.log(`\n  合计识别：${totalApps} 个应用、${totalPixels} 个像素`);
