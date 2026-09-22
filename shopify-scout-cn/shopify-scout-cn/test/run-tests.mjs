/**
 * 单元测试 —— 零依赖，直接用 Node 内置 test runner。
 * 用法：node --test test/  或  node test/run-tests.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSurfaces, matchApps, matchPixels, resolveTheme,
  lookupTheme, detectDerivation, assessPlus, siteProfile, headlessSignals
} from '../lib/detect.js';
import { APP_SIGNATURES, PIXEL_SIGNATURES, THEME_CATALOG } from '../lib/signatures.js';
import {
  median, percentile, summarizeCatalogue, scaleScore, estimateSales, compareStores
} from '../lib/estimate.js';
import {
  csvEscape, toCsv, BOM, productRows, buildExport, fmtNumber, fmtMoney, fmtPercent, fmtAgo
} from '../lib/export.js';
import { collectSignals, collectCatalogue, probeCatalogue, collectThemeAssets } from '../lib/injected.js';
import {
  makeSnapshot, diffSnapshots, buildTimeline, newProductCadence,
  EVENT_META, SNAPSHOT_PRODUCT_CAP
} from '../lib/timeline.js';

/* ────────────────── 测试夹具 ────────────────── */

/** 造一个「装了不少东西」的 Shopify 店铺信号 */
function shopifySignals(overrides = {}) {
  return {
    ok: true,
    host: 'demo-store.com',
    pageUrl: 'https://demo-store.com',
    isShopify: true,
    shopifyScore: 9,
    shopifyEvidence: ['window.Shopify 存在'],
    shopify: {
      shop: 'demo-store.myshopify.com',
      permanent_domain: 'demo-store.myshopify.com',
      country: 'US',
      locale: 'en',
      currency: { active: 'USD' },
      routes: true
    },
    theme: { id: 123456, name: 'Dawn', theme_store_id: 887, role: 'main' },
    scriptSrcs: [
      'https://cdn.shopify.com/s/files/1/0000/theme.js',
      'https://static.klaviyo.com/onsite/js/klaviyo.js',
      'https://cdn.judge.me/assets/widget.js',
      'https://loox.io/widget/loox.js',
      'https://connect.facebook.net/en_US/fbevents.js',
      'https://analytics.tiktok.com/i18n/pixel/events.js',
      'https://googletagmanager.com/gtag/js?id=G-XXXX',
      'https://widget.trustpilot.com/bootstrap.js',
      'https://cdn.shopify.com/shopifycloud/web-pixels-manager.js',
      'https://cdn.jsdelivr.net/npm/rebuy.js'
    ],
    linkHrefs: ['https://cdn.shopify.com/s/files/1/0000/theme.css'],
    inlineScripts: 'var Shopify = Shopify || {}; Shopify.theme = {"id":123456};',
    windowGlobals: ['Shopify', 'fbq', 'ttq', 'gtag', '_learnq', 'dataLayer'],
    metaTags: [
      { name: 'shopify-checkout-api-token', content: 'abc' },
      { name: 'description', content: '测试店铺' }
    ],
    cookieNames: ['_shopify_s', 'cart', '_fbp'],
    htmlSample: '<html><script src="https://cdn.judge.me/x.js"></script><div id="shopify-section-header"></div></html>',
    htmlLength: 5000,
    title: 'Demo Store',
    currency: 'USD',
    country: 'US',
    locale: 'en',
    ...overrides
  };
}

/* ────────────────── 指纹库自检 ────────────────── */

test('指纹库：ID 唯一、正则全部可编译、分类合法', () => {
  const ids = APP_SIGNATURES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, '应用 ID 必须唯一');
  for (const sig of APP_SIGNATURES) {
    assert.ok(sig.name && sig.category, `${sig.id} 缺少名称或分类`);
    assert.ok(sig.patterns.length > 0, `${sig.id} 没有 patterns`);
    for (const p of sig.patterns) {
      assert.doesNotThrow(() => new RegExp(p, 'i'), `${sig.id} 的正则不可编译: ${p}`);
    }
  }
  const pids = PIXEL_SIGNATURES.map((s) => s.id);
  assert.equal(new Set(pids).size, pids.length, '像素 ID 必须唯一');
  for (const sig of PIXEL_SIGNATURES) {
    for (const p of sig.patterns) {
      assert.doesNotThrow(() => new RegExp(p, 'i'), `${sig.id} 的正则不可编译: ${p}`);
    }
  }
  const themeNames = THEME_CATALOG.map((t) => t.name.toLowerCase());
  assert.equal(new Set(themeNames).size, themeNames.length, '主题名必须唯一');
});

/* ────────────────── 注入函数自包含性 ────────────────── */

test('注入函数必须自包含：源码里不得出现模块级标识符', () => {
  // executeScript 只序列化函数源码本身，任何闭包引用都会在页面里 ReferenceError。
  const moduleLevel = ['APP_SIGNATURES', 'PIXEL_SIGNATURES', 'THEME_CATALOG',
    'THEME_DERIVATION_HINTS', 'PROBED_GLOBALS', 'buildSurfaces', 'matchApps', 'rx(', 'firstHit('];

  for (const fn of [collectSignals, collectCatalogue, probeCatalogue, collectThemeAssets]) {
    const src = fn.toString();
    for (const name of moduleLevel) {
      assert.ok(!src.includes(name), `${fn.name} 引用了模块级符号 ${name}，注入后会 ReferenceError`);
    }
    // 且不能有 import / require
    assert.ok(!/\bimport\s|\brequire\(/.test(src), `${fn.name} 含静态导入语句`);
  }
});

test('注入函数：入口函数体里没有裸的未声明 const', () => {
  // 粗检：所有 const/let 声明都出现在函数内部（本用例真正防的是
  // 「模块级常量在页面里变成 ReferenceError」这类回归）。
  const src = collectSignals.toString();
  const bodyStart = src.indexOf('{');
  assert.ok(bodyStart > 0 && src.lastIndexOf('}') > bodyStart);
  assert.ok(src.includes('const CAP'), 'collectSignals 的常量应声明在函数体内');
});

/* ────────────────── 应用 / 像素匹配 ────────────────── */

test('matchApps：识别出夹具里装的应用，并把高置信度排在前面', () => {
  const apps = matchApps(shopifySignals());
  const ids = apps.map((a) => a.id);
  for (const expect of ['klaviyo', 'judgeme', 'loox', 'trustpilot', 'shopify_web_pixels']) {
    assert.ok(ids.includes(expect), `应识别出 ${expect}，实际: ${ids.join(',')}`);
  }
  assert.equal(apps[0].confidence, 'high', '第一条应为高置信度');
  assert.ok(apps.every((a) => a.evidence && a.evidence.length > 0), '每条命中都要带证据');
});

test('matchApps：全局变量命中优先，且能作为独立证据', () => {
  const apps = matchApps(shopifySignals({ scriptSrcs: [], linkHrefs: [], htmlSample: '', inlineScripts: '' }));
  const klaviyo = apps.find((a) => a.id === 'klaviyo');
  assert.ok(klaviyo, '仅凭 window._learnq 也应识别出 Klaviyo');
  assert.equal(klaviyo.evidence, 'window._learnq');
  assert.equal(klaviyo.evidenceSurface, 'global');
});

test('matchApps：干净页面不误报', () => {
  const clean = shopifySignals({
    scriptSrcs: ['https://cdn.shopify.com/s/files/theme.js'],
    linkHrefs: [], inlineScripts: '', windowGlobals: ['Shopify'],
    metaTags: [], cookieNames: [], htmlSample: '<html><body>hello</body></html>'
  });
  const apps = matchApps(clean);
  assert.equal(apps.length, 0, '不该凭空识别出应用：' + apps.map((a) => a.id).join(','));
});

test('matchPixels：区分广告像素与分析工具', () => {
  const px = matchPixels(shopifySignals());
  const byId = Object.fromEntries(px.map((p) => [p.id, p]));
  assert.equal(byId.meta_pixel.kind, '广告像素');
  assert.equal(byId.tiktok_pixel.kind, '广告像素');
  assert.equal(byId.google_ga4.kind, '分析');
  assert.ok(px.every((p) => p.evidence));
});

/* ────────────────── 主题解析 ────────────────── */

test('lookupTheme：精确、前缀、包含三种匹配都成立', () => {
  assert.equal(lookupTheme('Dawn').name, 'Dawn');
  assert.equal(lookupTheme('  dawn ').name, 'Dawn');
  assert.equal(lookupTheme('Impulse Pro').name, 'Impulse');
  assert.equal(lookupTheme('我的自定义主题') , null);
});

test('resolveTheme：官方主题商店主题', () => {
  const t = resolveTheme(shopifySignals());
  assert.equal(t.status, 'official');
  assert.equal(t.name, 'Dawn');
  assert.equal(t.vendor, 'Shopify');
  assert.equal(t.price, '免费');
  assert.equal(t.storeId, 887);
  assert.equal(t.role, 'main');
});

test('resolveTheme：第三方付费主题', () => {
  const s = shopifySignals({ theme: { id: 9, name: 'Impulse', theme_store_id: null, role: 'main' } });
  const t = resolveTheme(s);
  assert.equal(t.status, 'thirdparty');
  assert.equal(t.vendor, 'Archetype Themes');
  assert.equal(t.price, '付费');
});

test('resolveTheme：自定义主题（不在参考库）', () => {
  const s = shopifySignals({ theme: { id: 9, name: 'BrandX Custom 2026', theme_store_id: null, role: 'main' } });
  const t = resolveTheme(s);
  assert.equal(t.status, 'custom');
  assert.equal(t.inCatalog, false);
});

test('resolveTheme：custom 主题靠 schema_name 确定底座血缘', () => {
  // 实测自 deathwishcoffee.com：商家把主题命名成日期，theme_store_id 为 null，
  // 但 schema_name 明确是 "Dawn" —— 这是事实，不是资产路径推测。
  const s = shopifySignals({
    theme: {
      name: 'Sept 10, 2026', id: 135654604855, schema_name: 'Dawn',
      schema_version: '10.0.0', theme_store_id: null, role: 'main'
    }
  });
  const t = resolveTheme(s);
  assert.equal(t.status, 'custom');
  assert.ok(t.label.includes('基于 Dawn'), '标签应写明底座：' + t.label);
  assert.equal(t.derivedFrom.name, 'Dawn');
  assert.equal(t.derivedFrom.confidence, '确定');
  assert.equal(t.derivedFrom.source, 'schema_name');
  assert.equal(t.schemaVersion, '10.0.0');
  assert.ok(t.vendor.includes('Archetype') || t.vendor.includes('Shopify'), '底座厂商应透出：' + t.vendor);
});

test('resolveTheme：schema_name 未收录时不硬套血缘', () => {
  const s = shopifySignals({
    theme: { name: '自研主题', schema_name: 'allbirds-theme', theme_store_id: null, role: 'main' }
  });
  const t = resolveTheme(s);
  assert.equal(t.status, 'custom');
  assert.equal(t.derivedFrom, null);
  assert.ok(t.label.includes('自定义'));
});

test('resolveTheme：资产路径血缘只是推测，不能覆盖 schema 结论', () => {
  const s = shopifySignals({
    theme: { name: 'Sept 10, 2026', schema_name: 'Dawn', theme_store_id: null, role: 'main' },
    scriptSrcs: ['https://cdn.shopify.com/s/files/1/0/t/1/assets/flex.min.js']
  });
  const t = resolveTheme(s);
  assert.equal(t.derivedFrom.source, 'schema_name', 'schema 结论优先');
  assert.equal(t.derivedFrom.name, 'Dawn');
  // 资产路径结论仍然保留，但只作为补充线索展示
  assert.ok(t.derivation.some((d) => d.base === 'Flex'));
});

test('resolveTheme：Headless 店面（无 theme 对象但有前端框架迹象）', () => {
  const s = shopifySignals({
    theme: null,
    htmlSample: '<html><script id="__NEXT_DATA__" type="application/json">{}</script></html>'
  });
  const t = resolveTheme(s);
  assert.equal(t.status, 'headless');
  assert.ok(t.headlessEvidence.includes('Next.js'));
});

test('resolveTheme：非 Shopify 站点直接判定', () => {
  const t = resolveTheme({ isShopify: false });
  assert.equal(t.status, 'not_shopify');
});

test('detectDerivation：从资产路径推测底座主题', () => {
  const s = shopifySignals({
    scriptSrcs: ['https://cdn.shopify.com/s/files/1/0/t/1/assets/dawn.js'],
    linkHrefs: ['https://cdn.shopify.com/s/files/1/0/t/1/assets/impulse.css']
  });
  const d = detectDerivation(s);
  const bases = d.map((x) => x.base);
  assert.ok(bases.includes('Dawn'));
  assert.ok(bases.includes('Impulse'));
  assert.ok(d.every((x) => x.evidence));
});

test('headlessSignals：识别多套前端框架', () => {
  const hits = headlessSignals({ htmlSample: '<div id="__remixContext"></div><script>window.__NUXT__={}</script>' });
  assert.ok(hits.includes('Remix / Hydrogen'));
  assert.ok(hits.includes('Nuxt'));
});

/* ────────────────── Plus / 画像 ────────────────── */

test('assessPlus：自定义结账域名 + Multipass 触发「较可能」', () => {
  const s = shopifySignals({
    htmlSample: '<a href="https://checkout.brand.com/x">结账</a>',
    inlineScripts: 'var multipass = true;',
    scriptSrcs: new Array(70).fill('https://cdn.shopify.com/a.js')
  });
  const p = assessPlus(s);
  assert.equal(p.level, '较可能');
  assert.ok(p.reasons.length >= 2);
});

test('assessPlus：小店铺判定为「未发现迹象」', () => {
  const p = assessPlus(shopifySignals({ htmlSample: '<html></html>', inlineScripts: '', scriptSrcs: [] }));
  assert.equal(p.level, '未发现迹象');
});

test('siteProfile：抽取域名、货币、国家', () => {
  const p = siteProfile(shopifySignals());
  assert.equal(p.domain, 'demo-store.myshopify.com');
  assert.equal(p.currency, 'USD');
  assert.equal(p.country, 'US');
});

/* ────────────────── 统计与估算 ────────────────── */

function makeProducts(n, opts = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const daysAgo = opts.fresh ? i % 25 : i * 10;
    out.push({
      id: i, title: `产品 ${i}`, handle: `p-${i}`,
      vendor: i % 3 === 0 ? '品牌A' : '品牌B',
      productType: i % 2 === 0 ? '玩具' : '家居',
      createdAt: new Date(Date.now() - daysAgo * 86400000).toISOString(),
      tags: ['t1'],
      price: 10 + (i % 50),
      compareAtPrice: i % 4 === 0 ? 40 + (i % 50) : null,
      priceMax: 10 + (i % 50) + 5,
      variantCount: (i % 5) + 1,
      availableVariants: i % 7 === 0 ? 0 : 2
    });
  }
  return out;
}

test('median / percentile 边界', () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(percentile([1, 2, 3, 4, 5], 0), 1);
  assert.equal(percentile([1, 2, 3, 4, 5], 100), 5);
  assert.equal(percentile([], 50), null);
});

test('summarizeCatalogue：空目录不崩，字段齐全', () => {
  const s = summarizeCatalogue([]);
  assert.equal(s.count, 0);
  assert.equal(s.priceMedian, null);
  assert.equal(s.discountShare, 0);
});

test('summarizeCatalogue：正确统计价格、折扣、售罄、上新', () => {
  const s = summarizeCatalogue(makeProducts(40, { fresh: true }));
  assert.equal(s.count, 40);
  assert.ok(s.priceMin >= 10 && s.priceMax <= 60);
  assert.ok(s.priceMedian > 0);
  assert.ok(s.discountShare > 0 && s.discountShare <= 1);
  assert.ok(s.soldOutShare > 0 && s.soldOutShare <= 1);
  assert.ok(s.newLast30d > 0, '近 30 天上新数应大于 0');
  assert.equal(s.vendors.length, 2);
  assert.equal(s.types.length, 2);
  assert.equal(Object.values(s.priceBands).reduce((a, b) => a + b, 0), 40);
});

test('scaleScore：大店的分数显著高于小店，且始终落在 0–100', () => {
  const small = summarizeCatalogue(makeProducts(8));
  const big = summarizeCatalogue(makeProducts(600));
  const sSmall = scaleScore(small, { appCount: 1, pixelCount: 0 });
  const sBig = scaleScore(big, { appCount: 20, pixelCount: 6 });
  assert.ok(sBig.score > sSmall.score, `大店 ${sBig.score} 应高于小店 ${sSmall.score}`);
  for (const s of [sSmall, sBig]) assert.ok(s.score >= 0 && s.score <= 100, '分数越界: ' + s.score);
  assert.ok(sBig.parts.length >= 6, '评分构成应逐项可审计');
});

test('scaleScore：重度折扣依赖会被扣分', () => {
  const normal = makeProducts(50);
  const deep = makeProducts(50).map((p) => ({ ...p, compareAtPrice: p.price * 4 }));
  const a = scaleScore(summarizeCatalogue(normal), { appCount: 5, pixelCount: 2 });
  const b = scaleScore(summarizeCatalogue(deep), { appCount: 5, pixelCount: 2 });
  assert.ok(b.score < a.score, '折扣依赖度高的店应拿更低分');
});

test('estimateSales：无目录时不估算并给出原因', () => {
  const e = estimateSales(summarizeCatalogue([]), {}, { score: 0 });
  assert.equal(e.available, false);
  assert.ok(e.reason.includes('产品目录'));
});

test('estimateSales：量级合理，公式与输入全部外露', () => {
  const summary = summarizeCatalogue(makeProducts(300, { fresh: true }));
  const scale = scaleScore(summary, { appCount: 15, pixelCount: 5 });
  const e = estimateSales(summary, { appCount: 15, pixelCount: 5 }, scale);
  assert.equal(e.available, true);
  assert.ok(e.monthlyOrders > 0 && e.monthlyRevenue > 0);
  assert.ok(e.aov > 0);
  assert.ok(['低', '中', '中高'].includes(e.confidence));
  assert.ok(e.formula.length > 20);
  assert.ok(e.disclaimer.includes('启发式'));
  assert.equal(e.inputs.productCount, 300);
});

test('estimateSales：产品越多，估算营收越高（单调性）', () => {
  const mk = (n) => {
    const s = summarizeCatalogue(makeProducts(n));
    return estimateSales(s, { appCount: 5, pixelCount: 2 }, scaleScore(s, { appCount: 5, pixelCount: 2 }));
  };
  assert.ok(mk(400).monthlyRevenue > mk(20).monthlyRevenue);
});

test('compareStores：输出排名与五维得分', () => {
  const mk = (host, n) => {
    const summary = summarizeCatalogue(makeProducts(n));
    const signal = { appCount: Math.round(n / 20), pixelCount: 3 };
    return { host, summary, signal, estimate: estimateSales(summary, signal, scaleScore(summary, signal)) };
  };
  const out = compareStores([mk('small.com', 10), mk('big.com', 500)]);
  assert.equal(out[0].host, 'big.com', '大店应排在前面');
  assert.deepEqual(Object.keys(out[0].dimensions).sort(),
    ['产品规模', '上新活跃', '投放强度', '应用成熟度', '营收量级'].sort());
  assert.ok(out[0].total >= out[1].total);
});

/* ────────────────── 导出 ────────────────── */

test('csvEscape：逗号、引号、换行、公式注入都被处理', () => {
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('he said "hi"'), '"he said ""hi"""');
  assert.equal(csvEscape('line1\nline2'), '"line1\nline2"');
  assert.equal(csvEscape('=1+1'), "'=1+1", '必须阻止 Excel 公式执行');
  assert.equal(csvEscape('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape(undefined), '');
  assert.equal(csvEscape(0), '0');
});

test('toCsv：带 BOM、列标签正确、行数匹配', () => {
  const csv = toCsv([{ name: '甲', n: 1 }, { name: '乙', n: 2 }], [
    { key: 'name', label: '名称' }, { key: 'n', label: '数量' }
  ]);
  assert.ok(csv.startsWith(BOM), 'CSV 必须以 BOM 开头，否则 Excel 中文乱码');
  const lines = csv.slice(1).trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '名称,数量');
  assert.equal(lines[1], '甲,1');
});

test('productRows：合并爆款排名并算折扣百分比', () => {
  const result = {
    host: 'demo.com',
    catalogue: {
      products: [
        { title: 'A', handle: 'a', price: 30, compareAtPrice: 60, variantCount: 1, createdAt: '2026-01-01' },
        { title: 'B', handle: 'b', price: 20, compareAtPrice: null, variantCount: 1, createdAt: '2026-01-02' }
      ],
      bestSellersAll: [{ rank: 1, handle: 'a' }, { rank: 2, handle: 'b' }]
    }
  };
  const rows = productRows(result);
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[0].discountPct, 50);
  assert.equal(rows[1].discountPct, '');
  assert.equal(rows[0].url, 'https://demo.com/products/a');
});

test('buildExport：五种导出目标的文件名与格式', () => {
  const result = { host: 'demo.com', apps: [], pixels: [], catalogue: { products: [], collections: [], bestSellersAll: [] }, htmlSample: 'X'.repeat(100), inlineScripts: 'Y' };
  const cases = {
    products: ['.csv', 'text/csv'],
    apps: ['.csv', 'text/csv'],
    pixels: ['.csv', 'text/csv'],
    collections: ['.csv', 'text/csv'],
    full: ['.json', 'application/json']
  };
  for (const [what, [ext, mime]] of Object.entries(cases)) {
    const pack = buildExport(result, what);
    assert.ok(pack.filename.endsWith(ext), `${what} 扩展名应为 ${ext}，实际 ${pack.filename}`);
    assert.ok(pack.mime.includes(mime));
    assert.ok(pack.filename.includes('demo.com'));
  }
  // 完整报告必须剔除大字段
  const full = JSON.parse(buildExport(result, 'full').content);
  assert.equal(full.htmlSample, undefined, 'htmlSample 不该进导出报告');
  assert.equal(full.inlineScripts, undefined, 'inlineScripts 不该进导出报告');
});

test('buildExport：主机名含非法字符时文件名仍安全', () => {
  const pack = buildExport({ host: 'a b/c:d', catalogue: { products: [] } }, 'products');
  assert.ok(!/[/\\:\s]/.test(pack.filename), '文件名不得含路径分隔符或空格：' + pack.filename);
});

/* ────────────────── 格式化 ────────────────── */

test('格式化函数对空值统一返回破折号', () => {
  assert.equal(fmtNumber(null), '—');
  assert.equal(fmtMoney(null), '—');
  assert.equal(fmtPercent(null), '—');
  assert.equal(fmtAgo(null), '—');
  assert.equal(fmtMoney(12.5, 'USD'), 'USD 12.5');
  assert.equal(fmtPercent(0.1234), '12.3%');
  assert.equal(fmtAgo(new Date().toISOString()), '今天');
});

/* ────────────────── 误报回归 ────────────────── */
/* 以下每条都来自真实店铺干跑暴露的问题。误报比漏报更糟：
   它把噪声伪装成结论，用户据此下单会真金白银亏钱。 */

test('回归：只有 gtag 的店铺不得被误判为装了 GTM', () => {
  const s = shopifySignals({
    scriptSrcs: ['https://googletagmanager.com/gtag/js?id=G-XXX'],
    linkHrefs: [], inlineScripts: 'window.dataLayer=window.dataLayer||[];', htmlSample: '',
    windowGlobals: ['gtag', 'dataLayer']
  });
  const ids = matchPixels(s).map((p) => p.id);
  assert.ok(ids.includes('google_ga4'), '应识别出 GA4');
  assert.ok(!ids.includes('google_gtm'), '不得凭 dataLayer 就认定装了 GTM');
});

test('回归：Dawn 默认的 localization-form 不得被误判为 Shopify Markets', () => {
  const s = shopifySignals({
    scriptSrcs: [], linkHrefs: [], windowGlobals: ['Shopify'],
    htmlSample: '<form class="localization-form"><select name="country_code"></select></form>'
  });
  const ids = matchApps(s).map((a) => a.id);
  assert.ok(!ids.includes('shopify_markets'), 'localization-form 是所有 Dawn 店铺的默认结构');
});

test('回归：名为 analytics.js 的普通文件不得被误判为 Segment', () => {
  const s = shopifySignals({
    scriptSrcs: ['https://cdn.shopify.com/s/files/1/0/t/1/assets/analytics.js'],
    linkHrefs: [], inlineScripts: '', htmlSample: '', windowGlobals: ['Shopify']
  });
  const ids = matchApps(s).map((a) => a.id);
  assert.ok(!ids.includes('segment'), 'analytics.js 是通用文件名，不是 Segment 指纹');
});

test('回归：CSS 类名 flex-row / grid-cols 不得触发主题血缘推测', () => {
  const s = shopifySignals({
    scriptSrcs: [], linkHrefs: [],
    htmlSample: '<div class="flex-row flex-grow grid-cols-3 local-pickup craft-section"></div>'
  });
  const d = detectDerivation(s);
  assert.equal(d.length, 0, '整页 HTML 里的 CSS 类名不该被当主题血缘：' + JSON.stringify(d));
});

test('回归：真正的底座主题资产路径仍能推出血缘', () => {
  const s = shopifySignals({
    scriptSrcs: ['https://cdn.shopify.com/s/files/1/0/t/1/assets/flex.min.js'],
    linkHrefs: ['https://cdn.shopify.com/s/files/1/0/t/1/assets/theme.css'],
    htmlSample: ''
  });
  assert.ok(detectDerivation(s).map((x) => x.base).includes('Flex'));
});

test('回归：裸词类指纹（shippo / rivo / aw- / ea-）不得乱命中', () => {
  const noise = shopifySignals({
    scriptSrcs: [
      'https://example.com/aw-123.js', 'https://example.com/isp-bundle.js',
      'https://example.com/ea-main.js', 'https://example.com/gem-core.js',
      'https://example.com/om-track.js', 'https://reroute.com/x.js',
      'https://example.com/ae-polyfill.js', 'https://example.com/bold-setup.js'
    ],
    linkHrefs: [], inlineScripts: '', htmlSample: '', windowGlobals: ['Shopify']
  });
  const ids = matchApps(noise).map((a) => a.id);
  for (const bad of ['shippo', 'rivo', 'essentialapps', 'gempages', 'optinmonster', 'route', 'aliexpress', 'bold']) {
    assert.ok(!ids.includes(bad), `裸词指纹 ${bad} 在噪声页面上误命中`);
  }
});

test('回归：CSS 变量 --sticky-header-height 不得误判为 CookieYes', () => {
  // `cky-` 会命中 "sti|cky-|header"。实测于 kuura.co（真实浏览器端到端测试暴露）。
  const s = shopifySignals({
    scriptSrcs: [], linkHrefs: [], windowGlobals: ['Shopify'],
    htmlSample: '<style>:root{--sticky-header-height:0}</style>'
  });
  const ids = matchApps(s).map((a) => a.id);
  assert.ok(!ids.includes('cookieyes'), 'cky- 命中了 sticky-header');
});

test('回归：压缩 JS 里的 zE( 调用不得误判为 Zendesk', () => {
  // 实测命中过 `Object.freeze(w[L][y]),function(t,e,n,w,h` 这类无关片段。
  const s = shopifySignals({
    scriptSrcs: [], linkHrefs: [], htmlSample: '',
    inlineScripts: 'var x=Object.freeze(w[L][y]),zE(1,2);function zE(a,b){}',
    windowGlobals: ['Shopify']
  });
  const ids = matchApps(s).map((a) => a.id);
  assert.ok(!ids.includes('zendesk'), 'zE( 只是普通函数调用');
});

test('回归：Zendesk 仍能通过 window.zE 与 zdassets 域名识别', () => {
  const viaGlobal = shopifySignals({ scriptSrcs: [], linkHrefs: [], inlineScripts: '', htmlSample: '', windowGlobals: ['zE'] });
  assert.ok(matchApps(viaGlobal).map((a) => a.id).includes('zendesk'), 'window.zE 应识别出 Zendesk');
  const viaDomain = shopifySignals({ scriptSrcs: ['https://static.zdassets.com/ekr/snippet.js'], linkHrefs: [], inlineScripts: '', htmlSample: '' });
  assert.ok(matchApps(viaDomain).map((a) => a.id).includes('zendesk'), 'zdassets.com 应识别出 Zendesk');
});

test('回归：data-facebook-capi-enabled="false" 不得判为「已启用服务端转化」', () => {
  // 属性字面意思就是「未启用」，用 capi- 前缀匹配会把否定语境读成肯定。
  const s = shopifySignals({
    scriptSrcs: [], linkHrefs: [], inlineScripts: '', windowGlobals: ['Shopify'],
    htmlSample: '<div data-facebook-capi-enabled="false" data-theme="x"></div>'
  });
  const ids = matchPixels(s).map((p) => p.id);
  assert.ok(!ids.includes('pinterest_capi'), '否定语境被读成了肯定');
});

test('结构：采集器不得漏掉 resolveTheme 需要的任何 theme 字段', () => {
  // 真实浏览器测试暴露过：collectSignals 带了 schema_name 却漏了 schema_version，
  // 导致界面上的 schema 版本永远是空。这条用例守住「加字段只加一半」。
  const src = collectSignals.toString();
  const block = src.slice(src.indexOf('theme = {'), src.indexOf('};', src.indexOf('theme = {')));
  const collected = [...block.matchAll(/(\w+)\s*:/g)].map((m) => m[1]);

  for (const field of ['id', 'name', 'theme_store_id', 'role', 'schema_name', 'schema_version']) {
    assert.ok(collected.includes(field), `collectSignals 漏采集 theme.${field}（已采集：${collected.join(',')}）`);
  }

  // resolveTheme 消费的字段也必须都被采集到。
  // 驼峰别名（themeStoreId ↔ theme_store_id）归一化后再比，否则会把有意的
  // 大小写兜底读成「漏字段」。
  const normalize = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
  const collectedNorm = new Set(collected.map(normalize));
  const detectSrc = resolveTheme.toString();
  const consumed = [...detectSrc.matchAll(/raw\.(\w+)/g)].map((m) => m[1]);
  for (const field of new Set(consumed)) {
    assert.ok(collectedNorm.has(normalize(field)),
      `resolveTheme 读取 raw.${field}，但采集器没带出来（已采集：${collected.join(',')}）`);
  }
});

/* ────────────────── 店铺动态 / 店铺变化 ────────────────── */

/** 造一份扫描结果，用于时间线与快照测试 */
function makeResult(overrides = {}) {
  const products = overrides.products || makeProducts(20, { fresh: true });
  const ranks = overrides.ranks || products.slice(0, 5).map((p, i) => ({ rank: i + 1, handle: p.handle, title: p.title }));
  return {
    scannedAt: overrides.scannedAt || Date.now(),
    host: overrides.host || 'demo.com',
    theme: overrides.theme || { name: 'Dawn', schemaName: 'Dawn', storeId: 887 },
    apps: overrides.apps || [{ id: 'klaviyo', name: 'Klaviyo' }, { id: 'judgeme', name: 'Judge.me' }],
    pixels: overrides.pixels || [{ id: 'meta_pixel', name: 'Meta 像素' }],
    summary: overrides.summary || summarizeCatalogue(products),
    profile: { currency: 'USD' },
    catalogue: {
      products,
      collections: overrides.collections || [],
      bestSellersAll: ranks,
      bestSellers: []
    }
  };
}

test('makeSnapshot：紧凑结构、保留排名、主题指纹包含 schema', () => {
  const r = makeResult();
  const s = makeSnapshot(r);
  assert.equal(s.v, 1);
  assert.equal(s.host, 'demo.com');
  assert.ok(Object.keys(s.products).length > 0);
  // 产品值是三元组 [价格, 可售变体, 变体总数]
  const v = Object.values(s.products)[0];
  assert.ok(Array.isArray(v) && v.length === 3, '产品应存为紧凑三元组');
  assert.equal(Object.keys(s.ranks).length, 5);
  assert.equal(s.theme, 'Dawn|Dawn', '主题指纹要带上 schema 名');
  assert.deepEqual(s.appIds, ['judgeme', 'klaviyo'], '应用 ID 应排序，保证差分稳定');
});

test('makeSnapshot：产品数超过上限时截断（防止撑爆 storage）', () => {
  const many = makeProducts(SNAPSHOT_PRODUCT_CAP + 500);
  const s = makeSnapshot(makeResult({ products: many }));
  assert.equal(Object.keys(s.products).length, SNAPSHOT_PRODUCT_CAP);
});

/**
 * 把产品全部设为有货。
 * makeProducts 自带「每 7 个售罄一个」，会让差分测试的初始状态不确定 ——
 * 售罄/补货类用例必须先归一化，否则测的是夹具的巧合而不是逻辑。
 */
const allAvailable = (list) => list.map((p) => {
  const n = p.variantCount || 2;
  return { ...p, variantCount: n, availableVariants: n };
});

test('diffSnapshots：无历史快照时返回空（首次扫描必须安全）', () => {
  assert.deepEqual(diffSnapshots(null, makeSnapshot(makeResult())), []);
  assert.deepEqual(diffSnapshots(undefined, makeSnapshot(makeResult())), []);
});

test('diffSnapshots：识别售罄、补货、新品、下架', () => {
  const base = allAvailable(makeProducts(10));
  const prev = makeSnapshot(makeResult({ products: base }));

  const next = base.map((p) => ({ ...p }));
  next[0].availableVariants = 0;                       // 售罄
  const curr = makeSnapshot(makeResult({ products: next }));

  const ev = diffSnapshots(prev, curr);
  const kinds = ev.map((e) => e.kind);
  assert.ok(kinds.includes('sold_out'), '应识别出售罄，实际事件：' + kinds.join(','));
  const so = ev.find((e) => e.kind === 'sold_out');
  assert.equal(so.handle, base[0].handle);
  assert.ok(so.detail.includes('→'));
});

test('diffSnapshots：补货（0 → 有货）与"本来就有货"不可混淆', () => {
  const base = allAvailable(makeProducts(3));
  base[0].availableVariants = 0;                       // 起点：无货
  const prev = makeSnapshot(makeResult({ products: base }));
  const next = base.map((p) => ({ ...p }));
  next[0].availableVariants = 2;                       // 补货
  const ev = diffSnapshots(prev, makeSnapshot(makeResult({ products: next })));
  assert.equal(ev.filter((e) => e.kind === 'restocked').length, 1);
  assert.equal(ev.find((e) => e.kind === 'restocked').handle, base[0].handle);
  assert.equal(ev.filter((e) => e.kind === 'sold_out').length, 0, '有货的产品不该被判售罄');
});

test('diffSnapshots：新品与下架', () => {
  const base = allAvailable(makeProducts(5));
  const prev = makeSnapshot(makeResult({ products: base }));
  const next = base.slice(0, 4).concat([{ ...base[0], handle: 'brand-new-1', title: '全新产品' }]);
  const ev = diffSnapshots(prev, makeSnapshot(makeResult({ products: next })));
  assert.ok(ev.some((e) => e.kind === 'new_product' && e.handle === 'brand-new-1'));
  assert.ok(ev.some((e) => e.kind === 'delisted' && e.handle === base[4].handle));
});

test('diffSnapshots：价格变化阈值 —— 1% 以下视为噪声', () => {
  const base = allAvailable(makeProducts(3));
  base[0].price = 100; base[1].price = 100;
  const prev = makeSnapshot(makeResult({ products: base }));
  const next = base.map((p) => ({ ...p }));
  next[0].price = 70;    // -30% → 降价
  next[1].price = 100.5; // +0.5% → 应被忽略
  const ev = diffSnapshots(prev, makeSnapshot(makeResult({ products: next })));
  assert.equal(ev.filter((e) => e.kind === 'price_drop').length, 1);
  assert.equal(ev.filter((e) => e.kind === 'price_rise').length, 0, '0.5% 波动应被过滤');
});

test('diffSnapshots：爆款榜排名升降与新进榜', () => {
  const base = allAvailable(makeProducts(6));
  const prev = makeSnapshot(makeResult({ products: base, ranks: [
    { rank: 1, handle: base[0].handle }, { rank: 2, handle: base[1].handle }, { rank: 5, handle: base[2].handle }
  ] }));
  const curr = makeSnapshot(makeResult({ products: base, ranks: [
    { rank: 1, handle: base[1].handle },   // 2 → 1，头部换位，报
    { rank: 2, handle: base[0].handle },   // 1 → 2，头部换位，报
    { rank: 3, handle: base[3].handle }    // 新进榜
  ] }));
  const ev = diffSnapshots(prev, curr);
  assert.ok(ev.some((e) => e.kind === 'rank_up' && e.handle === base[1].handle));
  assert.ok(ev.some((e) => e.kind === 'rank_down' && e.handle === base[0].handle));
  assert.ok(ev.some((e) => e.kind === 'new_to_rank' && e.handle === base[3].handle));
});

test('diffSnapshots：榜单中段浮动 1 位不报（降噪），头部换位要报', () => {
  const base = allAvailable(makeProducts(4));
  // 中段：10 → 9，delta=1 且不在头部 → 应静默
  const mid = diffSnapshots(
    makeSnapshot(makeResult({ products: base, ranks: [{ rank: 10, handle: base[0].handle }] })),
    makeSnapshot(makeResult({ products: base, ranks: [{ rank: 9, handle: base[0].handle }] })));
  assert.equal(mid.filter((e) => e.kind === 'rank_up' || e.kind === 'rank_down').length, 0,
    '中段 1 位浮动属噪声');

  // 头部：2 → 1，delta=1 但在前三 → 应报出
  const top = diffSnapshots(
    makeSnapshot(makeResult({ products: base, ranks: [{ rank: 2, handle: base[0].handle }] })),
    makeSnapshot(makeResult({ products: base, ranks: [{ rank: 1, handle: base[0].handle }] })));
  assert.equal(top.filter((e) => e.kind === 'rank_up').length, 1, '头部换位必须报出来');
});

test('diffSnapshots：应用增减与主题更换', () => {
  const prev = makeSnapshot(makeResult({ apps: [{ id: 'a' }, { id: 'b' }], theme: { name: 'Dawn', schemaName: 'Dawn' } }));
  const curr = makeSnapshot(makeResult({ apps: [{ id: 'b' }, { id: 'c' }], theme: { name: 'Impulse', schemaName: 'Impulse' } }));
  const ev = diffSnapshots(prev, curr);
  assert.ok(ev.some((e) => e.kind === 'app_added' && e.appId === 'c'));
  assert.ok(ev.some((e) => e.kind === 'app_removed' && e.appId === 'a'));
  assert.ok(ev.some((e) => e.kind === 'theme_changed'));
});

test('diffSnapshots：每个事件都带证据强度，且只用合法档位', () => {
  const base = allAvailable(makeProducts(8));
  const prev = makeSnapshot(makeResult({ products: base }));
  const next = base.map((p) => ({ ...p }));
  next[0].availableVariants = 0;
  const ev = diffSnapshots(prev, makeSnapshot(makeResult({ products: next })));
  assert.ok(ev.length > 0);
  for (const e of ev) {
    assert.ok(['strong', 'medium', 'weak'].includes(e.strength), `非法强度：${e.strength}`);
    assert.ok(e.label, '事件必须有中文标签');
  }
});

test('newProductCadence：分桶、峰值与趋势判定', () => {
  const now = new Date();
  const mk = (monthsAgo, n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 5);
      out.push({ handle: `h-${monthsAgo}-${i}`, publishedAt: d.toISOString(), price: 10, variantCount: 1, availableVariants: 1 });
    }
    return out;
  };
  const products = [...mk(0, 10), ...mk(1, 8), ...mk(2, 6), ...mk(4, 1), ...mk(5, 1)];
  const c = newProductCadence(products, 12);
  assert.equal(c.buckets.length, 12);
  assert.equal(c.last3Months, 24, '近 3 个月应为 10+8+6');
  assert.equal(c.prev3Months, 2);
  assert.equal(c.trend, 'accelerating');
  assert.equal(c.peakMonth.count, 10);
});

test('newProductCadence：无上架时趋势为 flat 且不崩', () => {
  const c = newProductCadence([], 12);
  assert.equal(c.total, 0);
  assert.equal(c.trend, 'flat');
  assert.equal(c.last3Months, 0);
  assert.equal(c.buckets.length, 12);
});

test('newProductCadence：缺时间的产品计入 undated 而不是静默丢弃', () => {
  const c = newProductCadence([{ handle: 'x' }, { handle: 'y', publishedAt: 'not-a-date' }], 12);
  assert.equal(c.undated, 2);
  assert.equal(c.total, 0);
});

test('buildTimeline：首次扫描无历史时仍能给出单次可得的内容', () => {
  const products = makeProducts(30, { fresh: true });
  const t = buildTimeline({ result: makeResult({ products }), history: [] });
  assert.equal(t.hasHistory, false);
  assert.equal(t.events.length, 0, '没有基线时不该编造变动');
  assert.equal(t.snapshotCount, 1);
  assert.ok(t.recentProducts.length > 0, '最近上架不依赖历史');
  assert.ok(t.cadence.buckets.length === 12);
  assert.ok(t.topSellers.length > 0);
  assert.ok(t.snapshot, '应把快照一并返回供落盘');
});

test('buildTimeline：有历史时产出事件并标注观测窗口', () => {
  const products = allAvailable(makeProducts(12));
  const prevResult = makeResult({ products, scannedAt: Date.now() - 86400000 });
  const prevSnap = makeSnapshot(prevResult);

  const next = products.map((p) => ({ ...p }));
  next[0].availableVariants = 0;
  next[1].price = next[1].price * 2;

  const t = buildTimeline({
    result: makeResult({ products: next, scannedAt: Date.now() }),
    history: [prevSnap]
  });
  assert.equal(t.hasHistory, true);
  assert.equal(t.snapshotCount, 2);
  assert.ok(t.events.length >= 2, '应至少有售罄与涨价两条，实际：' + t.events.map((e) => e.kind).join(','));
  assert.ok(t.strongEvents.length >= 2);
  assert.ok(t.observationSpanMs > 80000000, '观测窗口约 1 天');
  assert.ok(t.prevSnapshotAt < t.currSnapshotAt);
});

test('buildTimeline：断货产品按「全部缺货 / 部分缺货」正确分类', () => {
  const products = makeProducts(10);
  products[0].availableVariants = 0; products[0].variantCount = 3;   // 全部缺货
  products[1].availableVariants = 1; products[1].variantCount = 4;   // 部分缺货
  products[2].availableVariants = 4; products[2].variantCount = 4;   // 正常
  const t = buildTimeline({ result: makeResult({ products }), history: [] });
  assert.ok(t.soldOutNow.some((p) => p.handle === products[0].handle));
  assert.ok(!t.soldOutNow.some((p) => p.handle === products[1].handle), '部分缺货不该算全部缺货');
  assert.ok(t.partlySoldOut.some((p) => p.handle === products[1].handle));
  assert.ok(!t.partlySoldOut.some((p) => p.handle === products[2].handle));
});

test('buildTimeline：断货产品按缺货比例排序，缺得多的在前', () => {
  const products = makeProducts(6);
  products[0].availableVariants = 3; products[0].variantCount = 4; // 缺 25%
  products[1].availableVariants = 1; products[1].variantCount = 4; // 缺 75%
  const t = buildTimeline({ result: makeResult({ products }), history: [] });
  const idx0 = t.partlySoldOut.findIndex((p) => p.handle === products[0].handle);
  const idx1 = t.partlySoldOut.findIndex((p) => p.handle === products[1].handle);
  assert.ok(idx1 < idx0, '缺货比例高的应排在前面');
});

test('店铺变化导出：CSV 首两列是发现时间与「有多确定」', () => {
  const products = allAvailable(makeProducts(5));
  const prev = makeSnapshot(makeResult({ products, scannedAt: Date.now() - 3600000 }));
  const next = products.map((p) => ({ ...p }));
  next[0].availableVariants = 0;
  const result = makeResult({ products: next });
  result.timeline = buildTimeline({ result, history: [prev] });

  const pack = buildExport(result, 'orders');
  assert.ok(pack.filename.endsWith('.csv'));
  assert.ok(pack.filename.includes('店铺变化'), '文件名应为「店铺变化」：' + pack.filename);
  const header = pack.content.replace(BOM, '').split('\r\n')[0];
  assert.ok(header.startsWith('发现时间,有多确定'), '首两列必须是发现时间与确定程度：' + header);
  const body = pack.content.replace(BOM, '').split('\r\n').slice(1).filter(Boolean);
  assert.ok(body.length >= 1);
  assert.ok(body[0].includes('确定的变化'), '事件行应写出中文的确定程度：' + body[0]);
});

test('店铺变化导出：无时间线数据时不崩，输出只有表头', () => {
  const pack = buildExport({ host: 'demo.com', catalogue: { products: [] } }, 'orders');
  assert.ok(pack.content.includes('发现时间'));
  assert.equal(pack.content.replace(BOM, '').split('\r\n').filter(Boolean).length, 1);
});

/* ────────────────── 证据面 ────────────────── */

test('buildSurfaces：六个面各自独立，且 globals 为集合', () => {
  const surf = buildSurfaces(shopifySignals());
  assert.ok(surf.script.includes('klaviyo'));
  assert.ok(surf.html.includes('judge.me'));
  assert.ok(surf.meta.includes('shopify-checkout-api-token'));
  assert.ok(surf.cookie.includes('_shopify_s'));
  assert.ok(surf.globals instanceof Set);
  assert.ok(surf.globals.has('fbq'));
});
