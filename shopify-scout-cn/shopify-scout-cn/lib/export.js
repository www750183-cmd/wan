/**
 * 导出与格式化 —— 纯函数，可在 Node 下直接单测。
 * 导出一律带 UTF-8 BOM，否则 Excel 打开中文会乱码。
 */

export const BOM = '\ufeff';

/** CSV 字段转义：含分隔符、引号或换行时加引号并双写引号 */
export function csvEscape(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // 防止 Excel 把 =cmd 当公式执行
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * @param {Array<object>} rows
 * @param {Array<{key:string,label:string,get?:Function}>} columns
 * @param {{bom?:boolean}} opts
 */
export function toCsv(rows, columns, opts = {}) {
  const useBom = opts.bom !== false;
  const head = columns.map((c) => csvEscape(c.label)).join(',');
  const lines = [head];
  for (const row of rows || []) {
    lines.push(columns.map((c) => csvEscape(c.get ? c.get(row) : row[c.key])).join(','));
  }
  return (useBom ? BOM : '') + lines.join('\r\n') + '\r\n';
}

/* ───────────────────── 各视图的列定义 ───────────────────── */

export const PRODUCT_COLUMNS = [
  { key: 'rank', label: '排名' },
  { key: 'title', label: '产品标题' },
  { key: 'handle', label: 'Handle' },
  { key: 'vendor', label: '品牌/供应商' },
  { key: 'productType', label: '产品类型' },
  { key: 'price', label: '最低价' },
  { key: 'priceMax', label: '最高价' },
  { key: 'compareAtPrice', label: '划线价' },
  { key: 'discountPct', label: '折扣%', get: (r) => (r.discountPct == null ? '' : r.discountPct) },
  { key: 'variantCount', label: '变体数' },
  { key: 'availableVariants', label: '可售变体' },
  { key: 'createdAt', label: '上架时间' },
  { key: 'tags', label: '标签', get: (r) => (Array.isArray(r.tags) ? r.tags.join(' | ') : r.tags || '') },
  { key: 'url', label: '链接' }
];

export const APP_COLUMNS = [
  { key: 'name', label: '应用名称' },
  { key: 'category', label: '分类' },
  { key: 'vendor', label: '厂商' },
  { key: 'confidence', label: '置信度', get: (r) => ({ high: '高', medium: '中', low: '低' }[r.confidence] || r.confidence) },
  { key: 'evidenceSurface', label: '证据位置' },
  { key: 'evidence', label: '命中证据' },
  { key: 'url', label: '官网' }
];

export const PIXEL_COLUMNS = [
  { key: 'name', label: '像素名称' },
  { key: 'kind', label: '类型' },
  { key: 'platform', label: '平台' },
  { key: 'confidence', label: '置信度', get: (r) => ({ high: '高', medium: '中', low: '低' }[r.confidence] || r.confidence) },
  { key: 'evidence', label: '命中证据' }
];

export const COLLECTION_COLUMNS = [
  { key: 'title', label: '合集名称' },
  { key: 'handle', label: 'Handle' },
  { key: 'productsCount', label: '产品数' },
  { key: 'publishedAt', label: '发布时间' }
];

/** 「店铺变化」事件流。
 *  刻意把「什么时候发现的」和「这条有多确定」放在最前面两列，避免下游看的人
 *  把「排名挪了一位」当成「一定有人下单」。 */
export const ORDER_EVENT_COLUMNS = [
  { key: 'at', label: '发现时间', get: (r) => new Date(r.at).toISOString() },
  { key: 'strength', label: '有多确定', get: (r) => ({ strong: '确定的变化', medium: '看趋势', weak: '参考信息' }[r.strength] || r.strength) },
  { key: 'kind', label: '变化类型' },
  { key: 'label', label: '变化' },
  { key: 'title', label: '商品 / 对象' },
  { key: 'detail', label: '说明' },
  { key: 'url', label: '链接' }
];

/** 把扫描结果压成可导出的行 */
export function productRows(result) {
  const products = (result && result.catalogue && result.catalogue.products) || [];
  const bestRank = new Map();
  for (const item of (result && result.catalogue && result.catalogue.bestSellersAll) || []) {
    bestRank.set(item.handle, item.rank);
  }
  return products.map((p) => {
    let discountPct = '';
    if (p.compareAtPrice && p.price && p.compareAtPrice > p.price) {
      discountPct = Math.round((1 - p.price / p.compareAtPrice) * 100);
    }
    return {
      ...p,
      rank: bestRank.get(p.handle) ?? '',
      discountPct,
      url: p.handle ? `https://${(result && result.host) || ''}/products/${p.handle}` : ''
    };
  });
}

/** 导出数据包 */
export function buildExport(result, what) {
  const host = (result && result.host) || 'store';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const safe = String(host).replace(/[^a-z0-9.-]/gi, '_');

  if (what === 'products') {
    return { filename: `${safe}_产品库_${stamp}.csv`, mime: 'text/csv;charset=utf-8', content: toCsv(productRows(result), PRODUCT_COLUMNS) };
  }
  if (what === 'apps') {
    return { filename: `${safe}_已装应用_${stamp}.csv`, mime: 'text/csv;charset=utf-8', content: toCsv((result && result.apps) || [], APP_COLUMNS) };
  }
  if (what === 'pixels') {
    return { filename: `${safe}_追踪像素_${stamp}.csv`, mime: 'text/csv;charset=utf-8', content: toCsv((result && result.pixels) || [], PIXEL_COLUMNS) };
  }
  if (what === 'collections') {
    return { filename: `${safe}_合集_${stamp}.csv`, mime: 'text/csv;charset=utf-8', content: toCsv((result && result.catalogue && result.catalogue.collections) || [], COLLECTION_COLUMNS) };
  }
  if (what === 'orders') {
    const t = (result && result.timeline) || {};
    const host = (result && result.host) || '';
    const titleByHandle = new Map(((result && result.catalogue && result.catalogue.products) || []).map((p) => [p.handle, p.title]));
    const rows = (t.events || []).map((e) => ({
      at: t.currSnapshotAt || Date.now(),
      strength: e.strength,
      kind: e.kind,
      label: e.label,
      title: e.handle ? (titleByHandle.get(e.handle) || e.handle) : (e.appId || '店铺级'),
      detail: e.detail || '',
      url: e.handle ? `https://${host}/products/${e.handle}` : ''
    }));
    return { filename: `${safe}_店铺变化_${stamp}.csv`, mime: 'text/csv;charset=utf-8', content: toCsv(rows, ORDER_EVENT_COLUMNS) };
  }
  // full：完整报告，剔除体积最大且无分析价值的原始 HTML 采样
  const slim = JSON.parse(JSON.stringify(result || {}, (k, v) => (k === 'htmlSample' || k === 'inlineScripts' ? undefined : v)));
  return { filename: `${safe}_完整报告_${stamp}.json`, mime: 'application/json;charset=utf-8', content: JSON.stringify(slim, null, 2) };
}

/* ───────────────────── 展示格式化 ───────────────────── */

export function fmtNumber(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('zh-CN');
}

export function fmtMoney(n, currency) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  const cur = currency || '';
  return `${cur} ${Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`.trim();
}

export function fmtPercent(x) {
  if (x === null || x === undefined || !Number.isFinite(Number(x))) return '—';
  return (Number(x) * 100).toFixed(1) + '%';
}

export function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 相对时间，用于「上新」一栏 */
export function fmtAgo(s) {
  if (!s) return '—';
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return '—';
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days < 1) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}
