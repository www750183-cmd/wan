/**
 * 店铺规模与销量估算 —— 透明的启发式模型。
 *
 * 重要声明：Koala Inspector 的销量/流量数字来自其后台的第三方流量数据合作方，
 * 本扩展零后端，拿不到那种数据。因此这里不做「伪精确」，而是：
 *   1. 只用店铺自身可公开读取的量（产品数、SKU 数、价格结构、上新节奏、评论规模）；
 *   2. 公式全部写在界面上，任何数字都能被用户反推；
 *   3. 输出一个置信度等级，并在置信度低时明确提示。
 * 这样得到的是「量级判断」，足以用于选品比较，但不该被当作财报数字。
 */

/** 工具：安全取数 */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function median(arr) {
  const a = arr.filter((n) => typeof n === 'number' && Number.isFinite(n)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function percentile(arr, p) {
  const a = arr.filter((n) => typeof n === 'number' && Number.isFinite(n)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const idx = Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))));
  return a[idx];
}

/**
 * 汇总产品目录的统计特征。
 * @param {Array} products 归一化后的产品数组（lib/catalogue.js 产出）
 */
export function summarizeCatalogue(products) {
  const list = Array.isArray(products) ? products : [];
  if (!list.length) {
    return { count: 0, variants: 0, priceMin: null, priceMax: null, priceMedian: null,
      discountShare: 0, soldOutShare: 0, newLast30d: 0, ageDaysMedian: null,
      priceBands: {}, vendors: [], types: [] };
  }

  const prices = [];
  let variants = 0, discounted = 0, soldOut = 0, newLast30d = 0;
  const ages = [];
  const bands = { '¥0-10': 0, '¥10-25': 0, '¥25-50': 0, '¥50-100': 0, '¥100-200': 0, '¥200+': 0 };
  const vendorCount = new Map();
  const typeCount = new Map();
  const now = Date.now();

  for (const p of list) {
    const price = num(p.price);
    if (price > 0) prices.push(price);
    variants += num(p.variantCount) || 1;

    if (num(p.compareAtPrice) > price && price > 0) discounted++;
    if (num(p.availableVariants) === 0 && num(p.variantCount) > 0) soldOut++;

    const created = p.createdAt ? Date.parse(p.createdAt) : NaN;
    if (Number.isFinite(created)) {
      const ageDays = (now - created) / 86400000;
      ages.push(ageDays);
      if (ageDays <= 30) newLast30d++;
    }

    // 价格带用人民币近似刻度（仅用于分布可视化，非汇率换算）
    if (price > 0) {
      if (price < 10) bands['¥0-10']++;
      else if (price < 25) bands['¥10-25']++;
      else if (price < 50) bands['¥25-50']++;
      else if (price < 100) bands['¥50-100']++;
      else if (price < 200) bands['¥100-200']++;
      else bands['¥200+']++;
    }

    const v = (p.vendor || '未标注').trim();
    vendorCount.set(v, (vendorCount.get(v) || 0) + 1);
    const t = (p.productType || '未分类').trim();
    typeCount.set(t, (typeCount.get(t) || 0) + 1);
  }

  const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([name, count]) => ({ name, count }));

  return {
    count: list.length,
    variants,
    priceMin: prices.length ? Math.min(...prices) : null,
    priceMax: prices.length ? Math.max(...prices) : null,
    priceMedian: median(prices),
    priceP90: percentile(prices, 90),
    discountShare: list.length ? discounted / list.length : 0,
    soldOutShare: list.length ? soldOut / list.length : 0,
    newLast30d,
    ageDaysMedian: median(ages),
    priceBands: bands,
    vendors: top(vendorCount, 6),
    types: top(typeCount, 8)
  };
}

/**
 * 规模评分（0–100）：把可观测的规模信号压成一个可比较的分数。
 * 权重来自「哪个信号与 GMV 相关性更强」的经验判断，写在下面便于审计。
 */
export function scaleScore(summary, signals) {
  const s = summary || {};
  const sig = signals || {};
  const parts = [];

  const add = (label, raw, weight, cap) => {
    const v = Math.max(0, Math.min(1, raw / cap));
    parts.push({ label, raw, weight, normalized: v, contribution: v * weight });
  };

  add('产品数量', num(s.count), 30, 800);
  add('SKU 总数', num(s.variants), 20, 3000);
  const appCount = (sig.appCount || 0);
  add('已装应用数', appCount, 15, 25);
  const pixelCount = (sig.pixelCount || 0);
  add('投放像素数', pixelCount, 15, 8);
  // 上新节奏：30 天上新数，反映运营活跃度
  add('近 30 天上新', num(s.newLast30d), 10, 40);
  // 折扣率过高通常意味着清库存/低毛利打法，轻微减分
  const discountPenalty = Math.max(0, (s.discountShare || 0) - 0.3) * 30;
  parts.push({ label: '折扣依赖度（减分项）', raw: +(s.discountShare || 0).toFixed(2), weight: -10,
    normalized: Math.min(1, discountPenalty / 10), contribution: -Math.min(1, discountPenalty / 10) * 10 });

  const score = Math.max(0, Math.min(100, parts.reduce((a, b) => a + b.contribution, 0)));
  return { score: Math.round(score), parts };
}

/**
 * 月销量 / 月营收量级估算。
 * 公式（全部显式）：
 *   月订单量 ≈ 产品数^0.42 × 6 × 规模系数 × 上新活跃系数
 *   客单价   ≈ 价格中位数 × 1.25（购物车通常多于一件）
 *   月营收   ≈ 月订单量 × 客单价
 * 规模系数来自 scaleScore（0.4–1.6），上新活跃系数来自近 30 天上新占比（0.8–1.3）。
 */
export function estimateSales(summary, signals, scale) {
  const s = summary || {};
  const count = num(s.count);
  if (!count) {
    return { available: false, reason: '无法读取产品目录，未做估算' };
  }

  const score = (scale && scale.score) || 0;
  const scaleFactor = 0.4 + (score / 100) * 1.2;            // 0.4 – 1.6
  const freshShare = count ? num(s.newLast30d) / count : 0;
  const freshFactor = 0.8 + Math.min(1, freshShare * 4) * 0.5; // 0.8 – 1.3

  const monthlyOrders = Math.pow(count, 0.42) * 6 * scaleFactor * freshFactor;
  const aov = (num(s.priceMedian) || num(s.priceMin) || 0) * 1.25;
  const monthlyRevenue = monthlyOrders * aov;

  // 置信度：可观测信号越多越可信
  let confidence = '低';
  if (count >= 60 && (signals.appCount || 0) >= 5) confidence = '中';
  if (count >= 200 && (signals.appCount || 0) >= 10 && (signals.pixelCount || 0) >= 2) confidence = '中高';

  return {
    available: true,
    monthlyOrders: Math.round(monthlyOrders),
    monthlyRevenue: Math.round(monthlyRevenue),
    aov: Math.round(aov),
    confidence,
    formula: '月订单量 ≈ 产品数^0.42 × 6 × 规模系数 × 上新系数；月营收 ≈ 月订单量 × 客单价；客单价 ≈ 价格中位数 × 1.25',
    inputs: {
      productCount: count,
      scaleScore: score,
      scaleFactor: +scaleFactor.toFixed(2),
      freshFactor: +freshFactor.toFixed(2),
      freshShare: +freshShare.toFixed(3),
      priceMedian: s.priceMedian
    },
    disclaimer: '这是基于店铺公开可读信号（产品数、SKU、价格结构、上新节奏、应用规模）的启发式量级估算，不是真实财报数据。'
  };
}

/** 竞品对比打分：把多家店铺放到同一把尺子上 */
export function compareStores(entries) {
  const rows = (entries || []).filter(Boolean);
  const max = (fn) => Math.max(1, ...rows.map((r) => num(fn(r))));
  const m = {
    products: max((r) => r.summary && r.summary.count),
    apps: max((r) => r.signal && r.signal.appCount),
    pixels: max((r) => r.signal && r.signal.pixelCount),
    revenue: max((r) => r.estimate && r.estimate.monthlyRevenue),
    fresh: max((r) => r.summary && r.summary.newLast30d)
  };
  return rows.map((r) => {
    const sc = {
      产品规模: (num(r.summary && r.summary.count) / m.products) * 100,
      应用成熟度: (num(r.signal && r.signal.appCount) / m.apps) * 100,
      投放强度: (num(r.signal && r.signal.pixelCount) / m.pixels) * 100,
      营收量级: (num(r.estimate && r.estimate.monthlyRevenue) / m.revenue) * 100,
      上新活跃: (num(r.summary && r.summary.newLast30d) / m.fresh) * 100
    };
    const total = Object.values(sc).reduce((a, b) => a + b, 0) / Object.keys(sc).length;
    return { ...r, dimensions: sc, total: Math.round(total) };
  }).sort((a, b) => b.total - a.total);
}
