/**
 * MAIN world 注入函数。
 *
 * ⚠️ 约束（与 Stackpeek 记录的一致）：chrome.scripting.executeScript 会把函数
 * 的源码序列化后注入页面，模块作用域的任何引用都不会跟着过去。
 * 因此本文件里的每个导出函数**必须完全自包含**——所有常量和辅助函数都要
 * 声明在函数体内，不能引用模块级变量，也不能引用 import。
 * test/run-tests.mjs 里有专门检查这条约束的用例。
 */

/**
 * 采集页面级信号。
 * @param {string[]} probedGlobals 需要探测的 window 全局变量名
 * @param {number} maxHtml 页面 HTML 采样上限（字符）
 */
export async function collectSignals(probedGlobals, maxHtml) {
  const CAP = maxHtml || 400000;

  const scriptSrcs = [];
  for (const el of document.querySelectorAll('script[src]')) {
    try { if (el.src) scriptSrcs.push(el.src); } catch { /* 忽略不可解析的 URL */ }
  }

  // 只收资源型 <link>，排除 canonical / next / prev / alternate / shortlink /
  // amphtml —— 这几类会暴露「用户在看哪一页」，而我们要的是「店铺装了什么」。
  const EXCLUDED_REL = ['canonical', 'next', 'prev', 'alternate', 'shortlink', 'amphtml'];
  const linkHrefs = [];
  for (const el of document.querySelectorAll('link[href]')) {
    try {
      const rel = (el.getAttribute('rel') || '').toLowerCase();
      if (EXCLUDED_REL.some((r) => rel.split(/\s+/).includes(r))) continue;
      if (el.href) linkHrefs.push(el.href);
    } catch { /* 同上 */ }
  }

  let inlineScripts = '';
  for (const el of document.querySelectorAll('script:not([src])')) {
    if (inlineScripts.length >= 120000) break;
    inlineScripts += (el.textContent || '') + '\n';
  }
  inlineScripts = inlineScripts.slice(0, 120000);

  const windowGlobals = [];
  for (const name of (probedGlobals || [])) {
    try { if (typeof window[name] !== 'undefined') windowGlobals.push(name); } catch { /* 忽略 */ }
  }

  const metaTags = [];
  for (const el of document.querySelectorAll('meta[name], meta[property]')) {
    const name = el.getAttribute('name') || el.getAttribute('property') || '';
    const content = el.getAttribute('content') || '';
    if (name) metaTags.push({ name, content: content.slice(0, 300) });
  }

  // 只取 cookie 的名字，不取值——值里可能有购物车/会话令牌。
  const cookieNames = document.cookie
    ? document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean)
    : [];

  // Shopify 全局对象含循环引用和函数，不能整体序列化，只挑要用的字段。
  const sh = window.Shopify || null;
  const shopify = sh ? {
    shop: sh.shop || null,
    id: sh.id || null,
    permanent_domain: sh.permanent_domain || null,
    country: sh.country || null,
    locale: sh.locale || null,
    currency: sh.currency ? {
      active: sh.currency.active || null,
      active_currency: sh.currency.active_currency || null
    } : null,
    routes: sh.routes ? true : false
  } : null;

  let theme = null;
  if (sh && sh.theme) {
    const t = sh.theme;
    theme = {
      id: t.id ?? null,
      name: t.name ?? null,
      theme_store_id: t.theme_store_id ?? null,
      role: t.role ?? null,
      schema_name: t.schema_name ?? null,
      // schema_version 必须一起带出来：主题解析与界面都会用到它
      schema_version: t.schema_version ?? null
    };
  }

  // 主题名也可能出现在 <meta name="theme-name"> 或 Shopify.theme 之外的位置
  if (!theme && sh) {
    const metaTheme = document.querySelector('meta[name="theme-name"], meta[name="shopify-theme"]');
    if (metaTheme) theme = { name: metaTheme.getAttribute('content') };
  }

  const html = document.documentElement ? document.documentElement.outerHTML : '';

  // ---- Shopify 判定：多个独立信号投票，不靠单一特征 ----
  const evidence = [];
  let votes = 0;
  if (sh) { votes += 3; evidence.push('window.Shopify 存在'); }
  if (sh && sh.shop) { votes += 2; evidence.push(`Shopify.shop = ${sh.shop}`); }
  if (scriptSrcs.some((u) => /cdn\.shopify\.com|cdn\.shopifycdn\./i.test(u))) { votes += 2; evidence.push('引用 cdn.shopify.com 资源'); }
  if (document.querySelector('meta[name="shopify-checkout-api-token"]')) { votes += 3; evidence.push('存在 shopify-checkout-api-token'); }
  if (document.querySelector('meta[name="shopify-digital-wallet"]')) { votes += 3; evidence.push('存在 shopify-digital-wallet'); }
  if (document.querySelector('link[href*="cdn.shopify.com"]')) { votes += 1; evidence.push('引用 Shopify CDN 样式表'); }
  if (/Shopify\.theme\.id|var Shopify\s*=/.test(inlineScripts)) { votes += 1; evidence.push('内联脚本初始化 Shopify 对象'); }
  if (document.querySelector('script[id="shopify-features"], script[src*="shopifycloud"]')) { votes += 2; evidence.push('加载 shopifycloud 脚本'); }
  if (/\.myshopify\.com/i.test(location.hostname)) { votes += 3; evidence.push('主域名为 *.myshopify.com'); }

  return {
    ok: true,
    pageUrl: location.origin,
    host: location.hostname,
    path: location.pathname,
    isShopify: votes >= 3,
    shopifyScore: votes,
    shopifyEvidence: evidence,
    shopify,
    theme,
    scriptSrcs: scriptSrcs.slice(0, 400),
    linkHrefs: linkHrefs.slice(0, 300),
    inlineScripts,
    windowGlobals,
    metaTags: metaTags.slice(0, 150),
    cookieNames,
    htmlSample: html.slice(0, CAP),
    htmlLength: html.length,
    // 页面级可见的店铺信息
    title: document.title || '',
    currency: (sh && sh.currency && (sh.currency.active || sh.currency.active_currency)) || null,
    country: (sh && sh.country) || null,
    locale: (sh && sh.locale) || document.documentElement.getAttribute('lang') || null
  };
}

/**
 * 抓取产品目录、合集与爆款榜。
 * 全部走店铺自己的同源接口，不依赖任何第三方服务。
 * @param {number} maxPages products.json 最大翻页数
 * @param {number} bestSellerCollections 要抓爆款榜的合集数
 */
export async function collectCatalogue(maxPages, bestSellerCollections) {
  const PAGE_SIZE = 250;
  const PAGES = Math.max(1, Math.min(40, maxPages || 12));
  const TOP_COLLECTIONS = Math.max(0, Math.min(6, bestSellerCollections ?? 3));

  const out = {
    ok: true,
    products: [],
    collections: [],
    bestSellers: [],          // [{collection, rank, handle, title}] —— 真实销量排序
    bestSellersAll: [],       // 全店爆款榜
    collectionMembers: [],    // 降级数据：合集成员（不含销量排序，不可当爆款榜）
    productsAvailable: false,
    collectionsAvailable: false,
    notes: []
  };

  // ---- 产品目录 ----
  try {
    for (let page = 1; page <= PAGES; page++) {
      const res = await fetch(`/products.json?limit=${PAGE_SIZE}&page=${page}`, { credentials: 'omit' });
      if (!res.ok) { if (page === 1) out.notes.push(`products.json 返回 HTTP ${res.status}`); break; }
      const data = await res.json();
      const batch = (data && data.products) || [];
      if (!batch.length) { out.productsAvailable = true; break; }
      out.productsAvailable = true;

      for (const p of batch) {
        const variants = p.variants || [];
        const prices = variants.map((v) => parseFloat(v.price)).filter((n) => Number.isFinite(n) && n > 0);
        const compare = variants.map((v) => parseFloat(v.compare_at_price)).filter((n) => Number.isFinite(n) && n > 0);
        let available = 0;
        for (const v of variants) if (v.available) available++;

        out.products.push({
          id: p.id,
          title: p.title || '',
          handle: p.handle || '',
          vendor: p.vendor || '',
          productType: p.product_type || '',
          createdAt: p.created_at || null,
          publishedAt: p.published_at || null,
          updatedAt: p.updated_at || null,
          tags: Array.isArray(p.tags) ? p.tags.slice(0, 20) : String(p.tags || '').split(',').filter(Boolean).slice(0, 20),
          price: prices.length ? Math.min(...prices) : null,
          priceMax: prices.length ? Math.max(...prices) : null,
          compareAtPrice: compare.length ? Math.max(...compare) : null,
          variantCount: variants.length,
          availableVariants: available,
          image: (p.images && p.images[0] && (p.images[0].src || p.images[0])) || null
        });
      }
      if (batch.length < PAGE_SIZE) break;
    }
  } catch (e) {
    out.notes.push('产品目录读取失败：' + (e && e.message ? e.message : '未知错误'));
  }

  // ---- 合集 ----
  try {
    const res = await fetch('/collections.json?limit=250', { credentials: 'omit' });
    if (res.ok) {
      const data = await res.json();
      out.collections = ((data && data.collections) || []).map((c) => ({
        id: c.id, title: c.title || '', handle: c.handle || '',
        productsCount: c.products_count ?? null,
        publishedAt: c.published_at || null,
        updatedAt: c.updated_at || null
      })).filter((c) => c.handle);
      out.collectionsAvailable = true;
    } else {
      out.notes.push(`collections.json 返回 HTTP ${res.status}`);
    }
  } catch (e) {
    out.notes.push('合集读取失败：' + (e && e.message ? e.message : '未知错误'));
  }

  // ---- 爆款榜：用店铺自己的 best-selling 排序，就是商家认可的真实销量排序 ----
  //
  // 这里会记录每一步的失败原因到 out.notes，而不是静默返回空数组：
  // 用户看到「爆款榜 0 条」时必须能知道是店铺没有该合集、还是返回了非 HTML、
  // 还是页面里根本没有 /products/ 链接（多语言站点会把链接加上 /en-sea/ 前缀）。
  async function readBestSelling(collectionHandle) {
    try {
      const res = await fetch(`/collections/${collectionHandle}?sort_by=best-selling`, { credentials: 'omit' });
      if (!res.ok) return { handles: [], status: res.status };
      const html = await res.text();
      // 按出现顺序抽取产品 handle（首个出现位置即排名）
      const seen = new Set();
      const ordered = [];
      const re = /\/products\/([A-Za-z0-9][A-Za-z0-9._-]*)/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        const h = m[1];
        if (h === 'undefined' || seen.has(h)) continue;
        seen.add(h);
        ordered.push(h);
        if (ordered.length >= 24) break;
      }
      return { handles: ordered, status: res.status, htmlLen: html.length };
    } catch (e) {
      // fetch 抛错（而非返回非 2xx）几乎总是跨域/CORS 被拦：
      // 该店铺把 HTML 301 到 *.myshopify.com，而跨域 HTML 响应没有 CORS 头。
      // 把这个情况单独标出来，才能给出准确的诊断而不是一句"失败"。
      return { handles: [], status: 0, error: (e && e.message) ? e.message : 'fetch failed', blocked: true };
    }
  }

  /**
   * 降级路径：用 JSON 端点取合集成员。
   * ⚠️ 该端点**忽略 sort_by**（实测同一合集 best-selling / created-descending /
   * 不传排序，三者返回完全相同的顺序与字节数），所以它给的是成员列表而非销量排序。
   * 调用方必须按「合集成员」展示，不能当爆款榜。
   */
  async function readCollectionMembers(collectionHandle) {
    try {
      const res = await fetch(`/collections/${collectionHandle}/products.json?limit=250`, { credentials: 'omit' });
      if (!res.ok) return [];
      const data = await res.json();
      return ((data && data.products) || []).map((p) => p.handle).filter(Boolean).slice(0, 40);
    } catch { return []; }
  }

  const allRes = await readBestSelling('all');
  const titleByHandle = new Map();
  for (const p of out.products) titleByHandle.set(p.handle, p.title);
  out.bestSellersAll = allRes.handles.map((h, i) => ({ rank: i + 1, handle: h, title: titleByHandle.get(h) || h }));

  // HTML 排序榜读不到时，退一步用 JSON 端点拿「合集成员」。
  // 必须严格区分这两件事：JSON 端点会**忽略 sort_by**（实测同一合集三种排序返回
  // 完全相同的顺序与字节数），所以它给的是成员列表，不是销量排序，绝不能当爆款榜用。
  out.collectionMembers = [];

  if (!out.bestSellersAll.length) {
    out.notes.push(allRes.status
      ? `爆款榜不可读：/collections/all 返回 HTTP ${allRes.status}，未解析出产品链接。`
      : `爆款榜不可读：/collections/all 请求失败（${allRes.error || '未知'}）。`);
    if (allRes.blocked) {
      out.notes.push('原因：该店铺把 HTML 请求 301 到 *.myshopify.com，而跨域 HTML 响应不带 ' +
        'Access-Control-Allow-Origin，浏览器会直接拒绝 —— 页面上下文无法读取 collection 页面。' +
        'JSON 端点（/products.json、/collections/*/products.json）因为带 CORS 头所以仍然可用。');
    }
  }

  if (TOP_COLLECTIONS) {
    const ranked = out.collections
      .filter((c) => c.handle !== 'all' && (c.productsCount ?? 1) > 0)
      .sort((a, b) => (b.productsCount ?? 0) - (a.productsCount ?? 0))
      .slice(0, TOP_COLLECTIONS);

    const failures = [];
    for (const c of ranked) {
      const r = await readBestSelling(c.handle);
      if (r.handles.length) {
        out.bestSellers.push({
          collection: c.title || c.handle,
          handle: c.handle,
          items: r.handles.map((h, i) => ({ rank: i + 1, handle: h, title: titleByHandle.get(h) || h }))
        });
        continue;
      }
      failures.push(`${c.handle}(HTTP ${r.status}${r.error ? ' ' + r.error : ''})`);

      // 降级：用 JSON 端点取成员（明确标注不含销量排序）
      const members = await readCollectionMembers(c.handle);
      if (members.length) {
        out.collectionMembers.push({
          collection: c.title || c.handle,
          handle: c.handle,
          sorted: false,
          items: members.map((h) => ({ handle: h, title: titleByHandle.get(h) || h }))
        });
      }
    }
    if (!out.bestSellers.length && ranked.length) {
      out.notes.push(`按产品数取的前 ${ranked.length} 个合集都没解析出爆款榜：${failures.join('、')}`);
    }
  }

  return out;
}

/**
 * 轻量探测：不拉全量目录，只判断 products.json 是否公开可读。
 * 用于用户只想快速确认「这家店能不能拆」的场景。
 */
export async function probeCatalogue() {
  try {
    const res = await fetch('/products.json?limit=1', { credentials: 'omit' });
    if (!res.ok) return { available: false, status: res.status };
    const data = await res.json();
    const n = (data && data.products && data.products.length) || 0;
    return { available: n > 0, status: res.status };
  } catch (e) {
    return { available: false, status: 0, error: e && e.message ? e.message : 'fetch failed' };
  }
}

/**
 * 主题文件清单：从 HTML 里抽出 CDN 上的主题资产名，
 * 用于证明「主题被二次开发过」（原始主题不该有这些文件名）。
 */
export async function collectThemeAssets() {
  const assets = new Set();
  for (const el of document.querySelectorAll('script[src], link[href]')) {
    const url = el.src || el.href || '';
    const m = url.match(/\/t\/\d+\/assets\/([^?#]+)/) || url.match(/\/assets\/([^?#]+\.(?:js|css))/);
    if (m && m[1]) assets.add(m[1]);
  }
  const sections = [];
  for (const el of document.querySelectorAll('[id^="shopify-section-"]')) sections.push(el.id);
  return {
    assets: [...assets].slice(0, 200),
    assetCount: assets.size,
    sectionCount: sections.length,
    sections: sections.slice(0, 60)
  };
}
