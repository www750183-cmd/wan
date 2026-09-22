/**
 * 匹配引擎 —— 纯函数，不依赖 chrome API，可在 Node 下直接单测。
 */
import {
  APP_SIGNATURES, PIXEL_SIGNATURES, THEME_CATALOG,
  THEME_DERIVATION_HINTS, PROBED_GLOBALS
} from './signatures.js';

/* ────────────────────────── 正则缓存 ────────────────────────── */

const regexCache = new Map();
function rx(source, flags = 'i') {
  const key = flags + '\u0000' + source;
  let r = regexCache.get(key);
  if (!r) {
    try { r = new RegExp(source, flags); } catch { r = null; }
    regexCache.set(key, r);
  }
  return r;
}

/* ────────────────────────── 证据面组装 ────────────────────────── */

/**
 * 把原始信号捏成一个「分面」的证据对象，便于按面精确匹配并回填命中证据。
 * @param {object} signals collectSignals 的产物
 */
export function buildSurfaces(signals) {
  const s = signals || {};
  const script = (s.scriptSrcs || []).join('\n');
  const link = (s.linkHrefs || []).join('\n');
  const inline = s.inlineScripts || '';
  const html = s.htmlSample || '';
  const global = (s.windowGlobals || []).join('\n');
  const meta = (s.metaTags || []).map((m) => `${m.name}=${m.content}`).join('\n');
  const cookie = (s.cookieNames || []).join('\n');

  return {
    // 逐个「面」单独保留文本，方便命中后回填人类可读的证据
    script, link, inline, html, global, meta, cookie,
    // 组合面：用于「任意位置命中」的宽松匹配
    all: [script, link, inline, html, global, meta, cookie].join('\n'),
    globals: new Set(s.windowGlobals || [])
  };
}

/** 在某个面上找第一个命中，返回命中片段用于展示证据。 */
function firstHit(surfaceText, source) {
  if (!surfaceText) return null;
  const r = rx(source);
  if (!r) return null;
  const m = surfaceText.match(r);
  if (!m) return null;
  const idx = m.index ?? 0;
  const start = Math.max(0, idx - 30);
  return (surfaceText.slice(start, idx + m[0].length + 30) || '').replace(/\s+/g, ' ').trim();
}

/* ────────────────────────── 应用匹配 ────────────────────────── */

/**
 * @returns {Array<{id,name,vendor,category,confidence,url,evidence,evidenceSurface}>}
 */
export function matchApps(signals) {
  const surf = buildSurfaces(signals);
  const out = [];

  for (const sig of APP_SIGNATURES) {
    let evidence = null;
    let evidenceSurface = null;

    // 全局变量命中优先级最高：说明 JS 确实执行过，而非只是引用了一个 CDN
    for (const g of sig.globals || []) {
      if (surf.globals.has(g)) {
        evidence = `window.${g}`;
        evidenceSurface = 'global';
        break;
      }
    }

    if (!evidence) {
      const surfaces = [['script', surf.script], ['link', surf.link], ['inline', surf.inline],
        ['html', surf.html], ['meta', surf.meta], ['cookie', surf.cookie]];
      for (const pattern of sig.patterns) {
        for (const [label, text] of surfaces) {
          const hit = firstHit(text, pattern);
          if (hit) { evidence = hit; evidenceSurface = label; break; }
        }
        if (evidence) break;
      }
    }

    if (evidence) {
      out.push({
        id: sig.id, name: sig.name, vendor: sig.vendor, category: sig.category,
        confidence: sig.confidence, url: sig.url || '',
        evidence: evidence.slice(0, 140), evidenceSurface
      });
    }
  }

  // 高置信度排在前面，同置信度按分类聚拢
  const rank = { high: 0, medium: 1, low: 2 };
  out.sort((a, b) => (rank[a.confidence] - rank[b.confidence]) || a.category.localeCompare(b.category, 'zh'));
  return out;
}

/* ────────────────────────── 像素匹配 ────────────────────────── */

export function matchPixels(signals) {
  const surf = buildSurfaces(signals);
  const out = [];

  for (const sig of PIXEL_SIGNATURES) {
    let evidence = null;
    let evidenceSurface = null;

    for (const g of sig.globals || []) {
      if (surf.globals.has(g)) { evidence = `window.${g}`; evidenceSurface = 'global'; break; }
    }
    if (!evidence) {
      for (const pattern of sig.patterns) {
        for (const [label, text] of [['script', surf.script], ['inline', surf.inline], ['html', surf.html]]) {
          const hit = firstHit(text, pattern);
          if (hit) { evidence = hit; evidenceSurface = label; break; }
        }
        if (evidence) break;
      }
    }
    if (evidence) {
      out.push({
        id: sig.id, name: sig.name, kind: sig.kind, platform: sig.platform,
        confidence: sig.confidence, evidence: evidence.slice(0, 140), evidenceSurface
      });
    }
  }
  return out;
}

/* ────────────────────────── 主题解析 ────────────────────────── */

function normalizeName(n) {
  return String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 主题名 → 参考库条目（模糊：忽略大小写、去掉 "theme" 后缀、包含匹配） */
export function lookupTheme(name) {
  const n = normalizeName(name);
  if (!n) return null;
  let hit = THEME_CATALOG.find((t) => normalizeName(t.name) === n);
  if (hit) return hit;
  hit = THEME_CATALOG.find((t) => n.startsWith(normalizeName(t.name)));
  if (hit) return hit;
  return THEME_CATALOG.find((t) => n.includes(normalizeName(t.name))) || null;
}

/**
 * 从资产 URL 推测底座主题血缘。
 *
 * 只扫 script / link 两类资源 URL，**绝不扫页面 HTML**：
 * 底座主题名是普通英文词（Flex、Grid、Local、Craft…），扫 HTML 会命中
 * CSS 类名和正文——`flex-row`、`grid-cols-3`、`local-pickup` 遍地都是，
 * 实测会把任何用了 Tailwind 的店铺都判成「基于 Flex 开发」。
 */
export function detectDerivation(signals) {
  const surf = buildSurfaces(signals);
  const hay = surf.script + '\n' + surf.link;
  const hits = [];
  for (const hint of THEME_DERIVATION_HINTS) {
    for (const pattern of hint.patterns) {
      const hit = firstHit(hay, pattern);
      if (hit) { hits.push({ base: hint.base, evidence: hit.slice(0, 120) }); break; }
    }
  }
  return hits;
}

/**
 * 主题解析结果。
 * Shopify 会在 window.Shopify.theme 暴露：
 *   { name, id, schema_name, schema_version, theme_store_id, role }
 *
 * - theme_store_id 非空  → 官方主题商店主题（可能被二次开发）
 * - theme_store_id 为空 + schema_name 命中参考库 → 自定义主题，但**确定**基于该底座二开
 * - theme_store_id 为空 + schema_name 未收录 → 完全自研
 * - Shopify 存在但无 theme → 很可能是 Headless（Hydrogen / 自建前端）
 *
 * schema_name 是最硬的底座信号：它是主题 schema 的标识，商家改名（例如把主题
 * 命名成「Sept 10, 2026」）也不会改它。实测 deathwishcoffee.com 的 theme.name
 * 是日期，而 schema_name 明确写着 "Dawn"。靠资产路径猜血缘是猜，这个是事实。
 */
export function resolveTheme(signals) {
  const s = signals || {};
  const raw = s.theme || (s.shopify && s.shopify.theme) || null;

  if (!s.isShopify) {
    return { status: 'not_shopify', label: '非 Shopify 站点', name: null };
  }
  if (!raw || !raw.name) {
    const headless = headlessSignals(s);
    return headless.length
      ? { status: 'headless', label: 'Headless 无头店面', name: null, headlessEvidence: headless }
      : { status: 'unknown', label: '主题未知', name: null };
  }

  const catalog = lookupTheme(raw.name);
  const schemaName = raw.schema_name ?? null;
  const schemaBase = schemaName ? lookupTheme(schemaName) : null;
  const derivation = detectDerivation(s);
  const storeId = raw.theme_store_id ?? raw.themeStoreId ?? null;
  const official = storeId != null || (catalog && catalog.official);

  let status, label;
  if (official) {
    status = 'official'; label = '官方主题商店主题';
  } else if (schemaBase) {
    // 商家改了主题名，但 schema 还留着底座的名字 —— 这是确定性的血缘，不是推测
    status = 'custom';
    label = `自定义主题（基于 ${schemaBase.name} 二次开发）`;
  } else if (catalog) {
    status = 'thirdparty'; label = '第三方主题';
  } else {
    status = 'custom'; label = '自定义 / 私有主题';
  }

  return {
    status, label,
    name: raw.name,
    id: raw.id ?? null,
    storeId,
    role: raw.role ?? null,
    schemaName,
    schemaVersion: raw.schema_version ?? null,
    // 底座主题：来源是 schema_name 时置信度最高，退而求其次才是资产路径推测
    derivedFrom: schemaBase ? { name: schemaBase.name, vendor: schemaBase.vendor, confidence: '确定', source: 'schema_name' } : null,
    vendor: schemaBase ? `${schemaBase.vendor}（二开）` : (catalog ? catalog.vendor : (official ? 'Shopify' : '未收录')),
    price: catalog ? catalog.price : (official ? '免费' : '未知'),
    kind: catalog ? catalog.kind : (schemaBase ? `${schemaBase.kind} 系` : '未知'),
    inCatalog: Boolean(catalog),
    likelyCustomized: Boolean(official || catalog || schemaBase),
    derivation
  };
}

/** Headless / 自建前端迹象 */
export function headlessSignals(signals) {
  const s = signals || {};
  const hay = [s.htmlSample || '', s.inlineScripts || '',
    (s.scriptSrcs || []).join('\n'), (s.linkHrefs || []).join('\n')].join('\n');
  const marks = [
    ['__NEXT_DATA__', 'Next.js'], ['_nuxt', 'Nuxt'], ['__remixContext', 'Remix / Hydrogen'],
    ['__sveltekit', 'SvelteKit'], ['__NUXT__', 'Nuxt'], ['data-reactroot', 'React 自建'],
    ['/api/2024-', 'Storefront API 调用'], ['storefront\\.api', 'Storefront GraphQL API']
  ];
  const hits = [];
  for (const [pattern, name] of marks) if (firstHit(hay, pattern)) hits.push(name);
  return [...new Set(hits)];
}

/* ────────────────────────── 站点画像 ────────────────────────── */

/** Shopify Plus 概率评估（明确标注为推测，因为前端拿不到套餐字段） */
export function assessPlus(signals) {
  const s = signals || {};
  const reasons = [];
  let score = 0;

  // 搜索面必须包含内联脚本：Multipass 之类的标记常常只写在 <script> 里，
  // 既不进外链也不进 HTML 属性，漏掉这一面会永远判不出来。
  const hay = [s.htmlSample || '', s.inlineScripts || '',
    (s.scriptSrcs || []).join('\n'), (s.linkHrefs || []).join('\n')].join('\n');
  if (firstHit(hay, 'checkout\\.[a-z0-9-]+\\.com')) { score += 2; reasons.push('使用自定义结账域名（Plus 专属）'); }
  if (firstHit(hay, 'multipass')) { score += 3; reasons.push('检测到 Multipass 单点登录'); }
  if (firstHit(hay, 'shopify-?plus')) { score += 2; reasons.push('页面出现 Shopify Plus 字样'); }
  if (s.shop && /\.myshopify\.com$/i.test(s.shop)) { score += 1; reasons.push('店铺主域名仍为 *.myshopify.com（规模偏小）'); }
  if ((s.scriptSrcs || []).length > 60) { score += 1; reasons.push(`脚本数量较多（${(s.scriptSrcs || []).length} 个），通常对应中大型店铺`); }

  let level;
  if (score >= 4) level = '较可能';
  else if (score >= 2) level = '可能';
  else level = '未发现迹象';

  return { level, score, reasons };
}

/** 站点国家 / 货币 / 多语言，来自 Shopify 全局对象 */
export function siteProfile(signals) {
  const s = signals || {};
  const sh = s.shopify || {};
  return {
    shop: sh.shop || s.shop || null,
    domain: sh.permanent_domain || sh.shop || s.shop || null,
    currency: (sh.currency && (sh.currency.active || sh.currency.active_currency)) || s.currency || null,
    country: sh.country || s.country || null,
    locale: sh.locale || s.locale || null,
    shopId: sh.id || null,
    routes: sh.routes ? Object.keys(sh.routes).length : 0
  };
}
