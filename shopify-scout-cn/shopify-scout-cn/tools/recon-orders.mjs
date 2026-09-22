/**
 * 最近订单数据源侦察。
 *
 * 目标：搞清楚「一个零后端的浏览器扩展，到底能从店铺公开接口里拿到什么」。
 * 逐项探测，只报实测结果，不猜。
 *
 * 用法：node tools/recon-orders.mjs https://store.example [...]
 */
import { PROBED_GLOBALS } from '../lib/signatures.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

async function fetchText(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 15000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal, redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept': opts.accept || 'text/html,application/json,*/*', ...(opts.headers || {}) }
    });
    const body = opts.head ? '' : await res.text();
    return { ok: res.ok, status: res.status, body, headers: res.headers };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  } finally { clearTimeout(t); }
}

const line = (s) => console.log(s);
const sec = (s) => { console.log('\n' + '─'.repeat(70)); console.log(s); console.log('─'.repeat(70)); };

/* ── 1. 页面里有哪些「销售通知 / 社交证明 / 评论」应用 ── */
const ORDER_APP_MARKERS = [
  ['Sales Pop (CareCart)', /sales-pop\.carecart\.io|salespop|carecart/i],
  ['Fomo', /\bfomo\b.*(api|widget)|api\.fomo\.com|fomo\.com\/api/i],
  ['ProveSource', /provesrc\.com|provesource/i],
  ['Nudgify', /nudgify/i],
  ['Sales Notification', /sales-?notification|salesnotification/i],
  ['Beeketing', /beeketing|beside/i],
  ['Recent Sales Popup', /recent-?sales|recent-sales-popup/i],
  ['Proof (social proof)', /social-?proof|proof\.js|useproof/i],
  ['Judge.me', /judge\.me|jdgm/i],
  ['Loox', /loox\.io/i],
  ['Yotpo', /yotpo/i],
  ['Stamped', /stamped\.io/i],
  ['Okendo', /okendo/i],
  ['Junip', /junip\.co/i],
  ['Ryviu', /ryviu/i],
  ['Fera', /fera\.ai/i]
];

function findMarkers(html) {
  const hits = [];
  for (const [name, re] of ORDER_APP_MARKERS) {
    const m = html.match(re);
    if (m) hits.push({ name, sample: m[0].slice(0, 60), idx: m.index });
  }
  return hits;
}

/** 从页面里抽出应用配置（api key / token / shop domain 等） */
function extractConfigs(html) {
  const out = {};

  // Judge.me：widget 脚本带 shop_domain + api_token
  const jdgm = html.match(/judge\.me\/api\/v1\/widgets[^"'\s]*/i) ||
    html.match(/jdgm[^"']{0,200}?shop_domain[^"']{0,200}/i);
  if (jdgm) out.judgeMeUrl = jdgm[0].slice(0, 300);

  const shopDomain = html.match(/shop_domain["']?\s*[:=]\s*["']([^"']+)["']/i);
  if (shopDomain) out.shopDomain = shopDomain[1];
  const apiToken = html.match(/api_token["']?\s*[:=]\s*["']([^"']+)["']/i);
  if (apiToken) out.apiToken = apiToken[1];

  // Loox
  const loox = html.match(/loox\.io\/widget\/(?:v\d\/)?[^"'\s]+/i);
  if (loox) out.loox = loox[0];
  const looxId = html.match(/loox[^"']{0,80}?shop[_-]?id["']?\s*[:=]\s*["']([^"']+)["']/i);
  if (looxId) out.looxShopId = looxId[1];

  // Yotpo app key
  const yotpoKey = html.match(/yotpo[^"']{0,120}?["']([a-zA-Z0-9]{20})["']/i);
  if (yotpoKey) out.yotpoKey = yotpoKey[1];
  const yotpoAppKey = html.match(/app_key["']?\s*[:=]\s*["']([a-zA-Z0-9]{20})["']/i);
  if (yotpoAppKey) out.yotpoAppKey = yotpoAppKey[1];

  // Stamped
  const stamped = html.match(/stamped\.io\/api\/widget[^"'\s]*/i);
  if (stamped) out.stamped = stamped[0];
  const stampedKey = html.match(/stamped[^"']{0,80}?["'](pubkey|apiKey|storeHash)["']\s*[:=]\s*["']([^"']+)["']/i);

  // Sales Pop / Fomo key
  const fomoKey = html.match(/fomo[^"']{0,120}?["']([a-zA-Z0-9]{16,32})["']/i);
  if (fomoKey) out.fomoKey = fomoKey[1];
  const carecart = html.match(/carecart[^"']{0,120}?["']([a-zA-Z0-9]{16,40})["']/i);
  if (carecart) out.carecartKey = carecart[1];

  return out;
}

/* ── 2. 库存数据是否存在 ── */
async function probeInventory(origin) {
  const r = await fetchText(`${origin}/products.json?limit=5`);
  if (!r.ok) return { available: false, status: r.status };
  let data;
  try { data = JSON.parse(r.body); } catch { return { available: false, error: 'JSON 解析失败' }; }
  const products = data.products || [];
  const variants = products.flatMap((p) => p.variants || []);
  const withQty = variants.filter((v) => typeof v.inventory_quantity === 'number');
  const nonZero = withQty.filter((v) => v.inventory_quantity > 0);
  const withMgmt = variants.filter((v) => v.inventory_management);
  const policy = variants.map((v) => v.inventory_policy).filter(Boolean);
  return {
    available: true,
    products: products.length,
    variants: variants.length,
    inventoryQuantityField: withQty.length,
    inventoryQuantityNonZero: nonZero.length,
    inventoryManagementField: withMgmt.length,
    inventoryPolicySamples: [...new Set(policy)].slice(0, 3),
    availableFlag: variants.filter((v) => v.available === true).length,
    sampleVariant: variants[0] ? JSON.stringify(variants[0]).slice(0, 400) : null
  };
}

/* ── 3. 评论接口（订单的代理指标） ── */
async function probeReviewApis(origin, configs, html) {
  const results = [];
  const host = new URL(origin).hostname;

  // Judge.me 公开 widget API
  if (/judge\.me|jdgm/i.test(html)) {
    const dom = configs.shopDomain || host;
    const token = configs.apiToken;
    if (token) {
      const url = `https://judge.me/api/v1/reviews?shop_domain=${encodeURIComponent(dom)}&api_token=${encodeURIComponent(token)}&per_page=5`;
      const r = await fetchText(url, { accept: 'application/json' });
      results.push({ api: 'Judge.me reviews', url: url.replace(token, 'TOKEN'), ok: r.ok, status: r.status, body: (r.body || '').slice(0, 400) });
    } else {
      results.push({ api: 'Judge.me reviews', ok: false, note: '页面未找到 api_token' });
    }
  }

  // Yotpo 公开 widget
  if (configs.yotpoAppKey) {
    const url = `https://api-cdn.yotpo.com/v1/widget/${configs.yotpoAppKey}/products/refs.json`;
    const r = await fetchText(url, { accept: 'application/json' });
    results.push({ api: 'Yotpo widget', ok: r.ok, status: r.status, body: (r.body || '').slice(0, 300) });
  }

  // 通用：商品页的 reviews.json / JSON-LD
  const r2 = await fetchText(`${origin}/products.json?limit=1`);
  if (r2.ok) {
    try {
      const p = JSON.parse(r2.body).products?.[0];
      if (p && p.handle) {
        const pr = await fetchText(`${origin}/products/${p.handle}.json`, { accept: 'application/json' });
        results.push({ api: 'product.json (单商品)', ok: pr.ok, status: pr.status, keys: pr.ok ? Object.keys(JSON.parse(pr.body).product || {}).join(',') : '' });
      }
    } catch { /* 忽略 */ }
  }

  return results;
}

/* ── 4. Shopify 侧还有没有别的「订单」入口 ── */
async function probeOrderEndpoints(origin) {
  const candidates = [
    ['/orders.json', 'shopify orders (通常需鉴权)'],
    ['/checkouts.json', 'checkouts'],
    ['/cart.js', '购物车'],
    ['/collections/all?sort_by=best-selling', 'best-selling 排序'],
    ['/collections/all?sort_by=created-descending', '新品排序'],
    ['/search/suggest.json?q=a&resources[type]=product', '搜索建议'],
    ['/recommendations/products.json?product_id=1&limit=4', '推荐接口'],
    ['/apps/sales-pop/orders', 'Sales Pop 应用路径']
  ];
  const out = [];
  for (const [path, label] of candidates) {
    const r = await fetchText(origin + path, { accept: 'application/json,text/html', timeout: 12000 });
    out.push({ path, label, status: r.status, ok: r.ok, snippet: r.ok ? (r.body || '').slice(0, 160).replace(/\s+/g, ' ') : '' });
  }
  return out;
}

/* ── 主流程 ── */
const urls = process.argv.slice(2);
if (!urls.length) { console.log('用法：node tools/recon-orders.mjs https://store.example [...]'); process.exit(1); }

for (const u of urls) {
  const origin = new URL(u).origin;
  sec(`店铺：${origin}`);

  const home = await fetchText(origin);
  if (!home.ok) { line(`  ✗ 首页抓取失败 HTTP ${home.status} ${home.error || ''}`); continue; }
  const html = home.body;
  line(`  首页 ${html.length} 字符`);

  console.log('\n[1] 页面里的订单/评论类应用标记');
  const markers = findMarkers(html);
  if (!markers.length) line('  （无）');
  for (const m of markers) line(`  · ${m.name}  ← ${m.sample}`);

  console.log('\n[2] 页面里可提取的接口配置');
  const configs = extractConfigs(html);
  if (!Object.keys(configs).length) line('  （无）');
  for (const [k, v] of Object.entries(configs)) line(`  · ${k} = ${String(v).slice(0, 90)}`);

  console.log('\n[3] 库存字段实测（决定能否做库存变化追踪）');
  const inv = await probeInventory(origin);
  line('  ' + JSON.stringify(inv, null, 2).split('\n').join('\n  '));

  console.log('\n[4] 评论接口实测（订单的代理指标）');
  const rev = await probeReviewApis(origin, configs, html);
  if (!rev.length) line('  （无可用评论接口）');
  for (const r of rev) line(`  · ${r.api}  ok=${r.ok} status=${r.status} ${r.note || ''}\n      ${String(r.body || r.keys || '').replace(/\s+/g, ' ').slice(0, 220)}`);

  console.log('\n[5] Shopify 侧其它「订单」入口');
  const eps = await probeOrderEndpoints(origin);
  for (const e of eps) line(`  · ${e.path.padEnd(52)} → ${e.status}  ${e.snippet.slice(0, 70)}`);
}
