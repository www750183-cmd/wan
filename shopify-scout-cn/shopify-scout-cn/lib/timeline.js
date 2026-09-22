/**
 * 店铺动态引擎 —— 「最近订单」的数据层。
 *
 * ## 这个功能到底是什么（先把话说清楚）
 *
 * 任何浏览器扩展都拿不到别人店铺的订单。实测确认：
 *   - `/orders.json` → 404（需鉴权）
 *   - `/products.json` 的变体**不含 `inventory_quantity`**（实测 0/238、0/419、0/2525 个变体带该字段）
 *   - 变体 `updated_at` 每次同步被批量刷新成同一个时间（实测 100% 变体时间戳完全相同），**零信息量**
 *
 * Koala Inspector 自己的文档也证实了这一点。它的 Shop Tracking 原文是：
 *   "add a competitor and it re-checks that store for you and logs what moved,
 *    including apps added or removed, a theme swap, new or dropped products,
 *    price changes, and variant changes."
 * 它的 Live Trends 是 "which products were added recently and how current
 * bestsellers compare to last month"。
 *
 * 也就是说：**原版的「实时销量」是变更检测，不是订单数据。** 它的护城河是持续重扫
 * 攒下来的历史，不是某个订单接口。
 *
 * 因此本模块做的是同一件事，但更透明：把「店铺里发生了什么变化」逐条列出来并标注证据强度，
 * 让用户自己判断哪条是成交线索。
 *
 * ## 事件强度分级
 *
 *   strong   —— 直接的状态变化（售罄、补货、上新、下架、改价），观测事实
 *   medium   —— 相对变化（爆款榜排名升降），反映销量相对走势
 *   weak     —— 配置变化（应用增减、主题更换），说明运营动作
 */

/* ────────────────────────── 事件类型表 ────────────────────────── */

export const EVENT_META = {
  sold_out: { label: '卖光了', icon: '🔴', strength: 'strong', hint: '上次扫的时候还有货，现在全没了' },
  restocked: { label: '补货了', icon: '🟢', strength: 'strong', hint: '上次全没货，现在补上了' },
  new_product: { label: '上了新品', icon: '🆕', strength: 'strong', hint: '上次扫描时这家店还没有这个' },
  delisted: { label: '下架了', icon: '🗑️', strength: 'strong', hint: '上次扫的时候还在，现在找不到了' },
  price_drop: { label: '降价了', icon: '💰', strength: 'strong', hint: '最低价降了' },
  price_rise: { label: '涨价了', icon: '📈', strength: 'strong', hint: '最低价涨了' },
  part_sold_out: { label: '部分规格卖光', icon: '🟠', strength: 'medium', hint: '部分尺码/规格断货，断的那些通常是热销的' },
  rank_up: { label: '排名上升', icon: '⬆️', strength: 'medium', hint: '在店铺销量排行榜上往前挪了' },
  rank_down: { label: '排名下降', icon: '⬇️', strength: 'medium', hint: '在店铺销量排行榜上往后掉了' },
  new_to_rank: { label: '新进排行榜', icon: '⭐', strength: 'medium', hint: '上次没上榜，这次进了排行榜' },
  app_added: { label: '新装了应用', icon: '🧩', strength: 'weak', hint: '店铺新装了一个第三方工具' },
  app_removed: { label: '卸了应用', icon: '🧩', strength: 'weak', hint: '店铺卸掉了一个第三方工具' },
  theme_changed: { label: '换了主题', icon: '🎨', strength: 'weak', hint: '店铺换了店面模板' }
};

/** 分组标题：用大白话说这三档的区别 */
export const STRENGTH_LABEL = {
  strong: '确定的变化',
  medium: '看趋势',
  weak: '参考信息'
};

/* ────────────────────────── 快照 ────────────────────────── */

/** 快照里最多保留多少个产品（chrome.storage.local 容量有限） */
export const SNAPSHOT_PRODUCT_CAP = 1500;
/** 每个店铺最多保留多少份历史快照 */
export const SNAPSHOT_KEEP = 12;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * 把一次扫描结果压成可长期保存的快照。
 * 刻意用紧凑结构（产品只存 [价格, 可售变体数, 变体总数]），
 * 因为 3000 个产品 × 12 份快照会撑爆 storage。
 */
export function makeSnapshot(result) {
  const catalogue = (result && result.catalogue) || {};
  const products = catalogue.products || [];
  const sorted = products.slice().sort((a, b) => {
    const ra = a._rank ?? 9999; const rb = b._rank ?? 9999;
    return ra - rb;
  }).slice(0, SNAPSHOT_PRODUCT_CAP);

  const p = {};
  for (const item of sorted) {
    if (!item.handle) continue;
    p[item.handle] = [num(item.price), num(item.availableVariants), num(item.variantCount)];
  }

  const ranks = {};
  for (const b of catalogue.bestSellersAll || []) {
    if (b && b.handle) ranks[b.handle] = num(b.rank);
  }

  const t = result.theme || {};
  return {
    v: 1,
    at: result.scannedAt || Date.now(),
    host: result.host,
    // 主题指纹：名称 + schema 名一起存，改名也能识别出"换了主题"
    theme: t.name ? `${t.name}|${t.schemaName || ''}` : null,
    appIds: (result.apps || []).map((a) => a.id).sort(),
    pixelIds: (result.pixels || []).map((x) => x.id).sort(),
    count: products.length,
    variants: (result.summary && result.summary.count) ? (result.summary.variants || 0) : 0,
    products: p,
    ranks
  };
}

/* ────────────────────────── 差分 ────────────────────────── */

function pushEvent(out, kind, data) {
  const meta = EVENT_META[kind] || {};
  out.push({ kind, label: meta.label || kind, icon: meta.icon || '', strength: meta.strength || 'weak', ...data });
}

/**
 * 对比两份快照，产出事件流（按时间倒序由调用方负责）。
 * @param {object|null} prev 较早的快照
 * @param {object} curr 当前快照
 */
export function diffSnapshots(prev, curr) {
  const events = [];
  if (!curr) return events;
  if (!prev) return events; // 首次扫描没有可比对象

  const prevP = prev.products || {};
  const currP = curr.products || {};

  for (const [handle, cv] of Object.entries(currP)) {
    const pv = prevP[handle];
    const [cPrice, cAvail, cTotal] = cv;
    if (!pv) {
      pushEvent(events, 'new_product', { handle, detail: '上次快照中不存在' });
      continue;
    }
    const [pPrice, pAvail, pTotal] = pv;

    // 全部售罄 / 恢复供货（只关心"从有到无"和"从无到有"这两个翻转）
    if (pAvail > 0 && cAvail === 0 && cTotal > 0) {
      pushEvent(events, 'sold_out', { handle, detail: `可售变体 ${pAvail} → 0（共 ${cTotal} 个）` });
    } else if (pAvail === 0 && cAvail > 0) {
      pushEvent(events, 'restocked', { handle, detail: `可售变体 0 → ${cAvail}` });
    } else if (cAvail < pAvail && cTotal > 1) {
      pushEvent(events, 'part_sold_out', { handle, detail: `可售变体 ${pAvail} → ${cAvail}（共 ${cTotal} 个）` });
    }

    if (pPrice > 0 && cPrice > 0 && cPrice !== pPrice) {
      const pct = ((cPrice - pPrice) / pPrice) * 100;
      // 小于 1% 的波动视为噪声（汇率/四舍五入）
      if (Math.abs(pct) >= 1) {
        pushEvent(events, pct < 0 ? 'price_drop' : 'price_rise', {
          handle, detail: `${pPrice} → ${cPrice}（${pct > 0 ? '+' : ''}${pct.toFixed(1)}%）`
        });
      }
    }
  }

  for (const handle of Object.keys(prevP)) {
    if (!currP[handle]) pushEvent(events, 'delisted', { handle, detail: '当前快照中已读不到' });
  }

  // 爆款榜位次变化
  // 降噪规则不是简单的一刀切阈值：榜单中段的 1 位浮动基本是噪声，
  // 但头部（前三）换位是实打实的销量反转，必须报出来。
  const prevR = prev.ranks || {};
  const currR = curr.ranks || {};
  for (const [handle, cr] of Object.entries(currR)) {
    const pr = prevR[handle];
    if (pr == null) { pushEvent(events, 'new_to_rank', { handle, detail: `进入榜单第 ${cr} 名` }); continue; }
    const delta = pr - cr;                  // 正数 = 名次前移
    const inTop = Math.min(pr, cr) <= 3;    // 变动发生在头部
    const meaningful = Math.abs(delta) >= 2 || (inTop && Math.abs(delta) >= 1);
    if (!meaningful) continue;
    if (delta > 0) pushEvent(events, 'rank_up', { handle, detail: `第 ${pr} 名 → 第 ${cr} 名（上升 ${delta}）` });
    else pushEvent(events, 'rank_down', { handle, detail: `第 ${pr} 名 → 第 ${cr} 名（下降 ${-delta}）` });
  }

  // 应用增减
  const prevApps = new Set(prev.appIds || []);
  const currApps = new Set(curr.appIds || []);
  for (const id of currApps) if (!prevApps.has(id)) pushEvent(events, 'app_added', { appId: id });
  for (const id of prevApps) if (!currApps.has(id)) pushEvent(events, 'app_removed', { appId: id });

  // 主题更换
  if (prev.theme && curr.theme && prev.theme !== curr.theme) {
    pushEvent(events, 'theme_changed', { detail: `${prev.theme} → ${curr.theme}` });
  }

  return events;
}

/* ────────────────────────── 上新节奏 ────────────────────────── */

/**
 * 从产品上架时间重建上新曲线 —— **单次扫描就能得到**，不依赖历史快照。
 * 商家什么时候密集上新，就是什么时候在推新品，这是选品里最有用的时间维度之一。
 * @param {Array} products
 * @param {number} months 回溯月数
 */
export function newProductCadence(products, months = 12) {
  const list = Array.isArray(products) ? products : [];
  const now = new Date();
  const buckets = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, count: 0, at: d.getTime() });
  }
  const index = new Map(buckets.map((b) => [b.key, b]));
  let undated = 0;

  for (const p of list) {
    const raw = p.publishedAt || p.createdAt;
    if (!raw) { undated++; continue; }
    const t = Date.parse(raw);
    if (!Number.isFinite(t)) { undated++; continue; }
    const d = new Date(t);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const b = index.get(key);
    if (b) b.count++;
    else if (t < buckets[0].at) undated++;   // 早于窗口
  }

  const total = buckets.reduce((a, b) => a + b.count, 0);
  const last3 = buckets.slice(-3).reduce((a, b) => a + b.count, 0);
  const prev3 = buckets.slice(-6, -3).reduce((a, b) => a + b.count, 0);

  return {
    buckets,
    total,
    undated,
    last3Months: last3,
    prev3Months: prev3,
    // 近 3 个月 vs 前 3 个月，判断上新是在加速还是放缓
    trend: prev3 === 0 ? (last3 > 0 ? 'accelerating' : 'flat')
      : last3 > prev3 * 1.25 ? 'accelerating' : last3 < prev3 * 0.75 ? 'slowing' : 'flat',
    peakMonth: buckets.reduce((a, b) => (b.count > a.count ? b : a), buckets[0] || { key: null, count: 0 })
  };
}

/* ────────────────────────── 时间线汇总 ────────────────────────── */

/** 事件涉及的产品 handle 换成标题 */
function decorate(events, titleByHandle) {
  return events.map((e) => ({
    ...e,
    title: e.handle ? (titleByHandle.get(e.handle) || e.handle) : undefined
  }));
}

/**
 * 汇总成「最近订单」视图需要的一切。
 *
 * @param {object} opts
 * @param {object} opts.result        本次扫描结果
 * @param {Array}  opts.history       该店铺的历史快照（旧 → 新，不含本次）
 * @param {number} opts.newWindowDays 判定「最近上架」的窗口天数
 */
export function buildTimeline({ result, history = [], newWindowDays = 30 }) {
  const catalogue = (result && result.catalogue) || {};
  const products = catalogue.products || [];
  const titleByHandle = new Map(products.map((p) => [p.handle, p.title]));

  const curr = makeSnapshot(result);
  const prev = history.length ? history[history.length - 1] : null;

  const diff = decorate(diffSnapshots(prev, curr), titleByHandle);

  // ---- 不需要历史就能算的部分 ----

  // 1. 最近上架产品（按上架时间倒序）
  const now = Date.now();
  const windowMs = newWindowDays * 86400000;
  const recentProducts = products
    .map((p) => {
      const t = Date.parse(p.publishedAt || p.createdAt || '');
      return { ...p, ageDays: Number.isFinite(t) ? (now - t) / 86400000 : null, ts: Number.isFinite(t) ? t : 0 };
    })
    .filter((p) => p.ageDays != null && p.ageDays <= windowMs)
    .sort((a, b) => b.ts - a.ts);

  // 2. 当前全部售罄的产品 —— 卖断货是最接近"订单"的公开证据
  const soldOutNow = products
    .filter((p) => num(p.variantCount) > 0 && num(p.availableVariants) === 0)
    .map((p) => ({ ...p, rank: curr.ranks[p.handle] ?? null }));

  // 3. 部分规格断货 —— 通常是热销规格
  const partlySoldOut = products
    .filter((p) => {
      const a = num(p.availableVariants); const t = num(p.variantCount);
      return t > 1 && a > 0 && a < t;
    })
    .map((p) => ({ ...p, soldRatio: 1 - num(p.availableVariants) / num(p.variantCount), rank: curr.ranks[p.handle] ?? null }))
    .sort((a, b) => b.soldRatio - a.soldRatio);

  // 4. 当前爆款榜
  const topSellers = (catalogue.bestSellersAll || []).map((b) => ({
    ...b, title: titleByHandle.get(b.handle) || b.title || b.handle
  }));

  // 5. 上新节奏
  const cadence = newProductCadence(products, 12);

  // ---- 需要历史的部分 ----
  const hasHistory = history.length > 0;
  const byStrength = { strong: [], medium: [], weak: [] };
  for (const e of diff) (byStrength[e.strength] || byStrength.weak).push(e);

  const firstAt = history.length ? Math.min(...history.map((h) => h.at)) : curr.at;
  const lastAt = history.length ? Math.max(...history.map((h) => h.at)) : curr.at;
  const span = Math.max(0, curr.at - Math.min(firstAt, lastAt));

  return {
    generatedAt: Date.now(),
    host: result.host,
    // 把本次快照一并返回，调用方直接落盘即可，不必重算一遍
    snapshot: curr,
    currSnapshotAt: curr.at,
    prevSnapshotAt: prev ? prev.at : null,
    snapshotCount: history.length + 1,
    // 观测窗口：从最早一份快照到现在。
    // 用 min(at) 而不是 history[0].at —— 快照正常情况下按时间递增，
    // 但导入/手工构造（测试就是这么做的）可能乱序，取最小值才不会算成 0。
    observationSpanMs: hasHistory ? span : 0,
    hasHistory,
    events: diff,
    strongEvents: byStrength.strong,
    mediumEvents: byStrength.medium,
    weakEvents: byStrength.weak,
    recentProducts,
    recentProductCount: recentProducts.length,
    newWindowDays,
    soldOutNow,
    partlySoldOut,
    topSellers,
    cadence,
    // 快照基线：用于说明"这些数字是从什么时候开始观测的"
    baseline: {
      productCount: Object.keys(curr.products).length,
      previousProductCount: prev ? Object.keys(prev.products).length : null,
      trackedProducts: Object.keys(curr.products).length
    }
  };
}

/* ────────────────────────── 快照仓库 ────────────────────────── */

/** 读取某店铺的历史快照（旧 → 新） */
export async function loadHistory(host) {
  const key = `snapshots`;
  const got = await chrome.storage.local.get(key);
  const all = got[key] || {};
  return Array.isArray(all[host]) ? all[host] : [];
}

/** 追加一份快照，保留最近 SNAPSHOT_KEEP 份 */
export async function saveSnapshot(host, snapshot) {
  const key = `snapshots`;
  const got = await chrome.storage.local.get(key);
  const all = got[key] || {};
  const list = Array.isArray(all[host]) ? all[host] : [];

  // 同一分钟内重复扫描不算新快照，避免刷一下就把历史挤掉
  const last = list[list.length - 1];
  if (last && snapshot.at - last.at < 60000) {
    list[list.length - 1] = snapshot;
  } else {
    list.push(snapshot);
  }
  all[host] = list.slice(-SNAPSHOT_KEEP);
  await chrome.storage.local.set({ [key]: all });
  return all[host];
}

/** 清空某店铺（或全部）的历史快照 */
export async function clearSnapshots(host) {
  const key = `snapshots`;
  if (!host) { await chrome.storage.local.remove(key); return; }
  const got = await chrome.storage.local.get(key);
  const all = got[key] || {};
  delete all[host];
  await chrome.storage.local.set({ [key]: all });
}
