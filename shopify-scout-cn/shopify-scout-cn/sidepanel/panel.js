/**
 * 侧边栏面板逻辑。
 * 只做展示与交互，所有采集与匹配都在 background 完成。
 */
import { fmtNumber, fmtMoney, fmtPercent, fmtDate, fmtAgo, productRows } from '../lib/export.js';
import { contactCardHtml, SUPPORT_QQ, SUPPORT_LINE } from '../lib/contact.js';

const $ = (sel) => document.querySelector(sel);
const content = $('#content');
const statusText = $('#statusText');
const statusMeta = $('#statusMeta');
const hostLabel = $('#hostLabel');

/* ───────────────────────── 基础设施 ───────────────────────── */

const send = (action, extra = {}) => chrome.runtime.sendMessage({ action, ...extra });

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const CONF_CN = { high: '高', medium: '中', low: '低' };

function setStatus(text, meta = '', busy = false) {
  statusText.innerHTML = (busy ? '<span class="spinner"></span>' : '') + esc(text);
  statusMeta.textContent = meta;
}

let state = {
  tabId: null,
  view: 'overview',
  result: null,
  appQuery: '',
  productQuery: '',
  productSort: 'default',
  productLimit: 60,
  history: [],
  favorites: [],
  settings: null
};

/* ───────────────────────── 扫描流程 ───────────────────────── */

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function doScan(deep) {
  const btn = $('#scanBtn');
  btn.disabled = true;
  setStatus('正在扫描…', '', true);
  try {
    const res = await send('scan', { tabId: state.tabId, deep });
    if (!res || !res.ok) {
      renderError(res && res.error ? res.error : '扫描失败');
      setStatus('扫描失败');
      return;
    }
    state.result = res;
    state.productLimit = 60;
    hostLabel.textContent = res.host + (res.isShopify ? ' · Shopify' : ' · 未识别为 Shopify');
    render();
    setStatus('扫描完成', `${res.apps.length} 应用 · ${res.pixels.length} 像素 · ${res.summary.count} 产品 · ${res.elapsedMs} ms`);
  } finally {
    btn.disabled = false;
  }
}

function renderError(msg) {
  content.innerHTML = `<div class="banner err">${esc(msg)}</div>
    <div class="card"><h3>怎么排查</h3>
      <ol style="margin:0;padding-left:18px;font-size:12px;color:var(--muted)">
        <li>先在普通网页（例如目标店铺页面）上点一下工具栏里的扩展图标，这会授予该页面的访问权限。</li>
        <li>再回到这个面板按「扫描当前店铺」。</li>
        <li>如果仍然失败，确认目标页面不是浏览器内部页面（chrome:// 、扩展页、新标签页）。</li>
      </ol>
      <p style="font-size:12px;margin:10px 0 0;padding-top:8px;border-top:1px solid var(--line)">
        还是不行？加 <b style="user-select:all">QQ ${esc(SUPPORT_QQ)}</b> 说一声，
        把这个提示原样发过去就行。
      </p>
    </div>`;
}

/* ───────────────────────── 渲染调度 ───────────────────────── */

const VIEWS = {
  overview: renderOverview,
  orders: renderOrders,
  apps: renderApps,
  pixels: renderPixels,
  products: renderProducts,
  winners: renderWinners,
  audit: renderAudit,
  export: renderExport
};

function render() {
  updateBadges();
  const fn = VIEWS[state.view] || renderOverview;
  content.innerHTML = fn();
  bindView();
}

function updateBadges() {
  const r = state.result;
  const counts = {
    apps: r ? r.apps.length : 0,
    pixels: r ? r.pixels.length : 0,
    products: r ? r.summary.count : 0,
    // 「店铺变化」的角标显示这次发现了几个变化，没有变化就不显示
    orders: (r && r.timeline && r.timeline.events) ? r.timeline.events.length : 0
  };
  for (const tab of document.querySelectorAll('.tab')) {
    const name = tab.dataset.tab;
    const n = counts[name];
    tab.innerHTML = tab.textContent.replace(/\s*\d*$/, '') + (n ? `<span class="badge">${n}</span>` : '');
  }
}

/* ───────────────────────── 概览 ───────────────────────── */

function renderOverview() {
  const r = state.result;
  if (!r) return emptyState();
  const t = r.theme;
  const p = r.profile || {};
  const s = r.summary;
  const e = r.estimate;

  const shopifyBanner = r.isShopify
    ? `<div class="banner ok">已确认为 Shopify 店铺（判定得分 ${r.shopifyScore}）</div>`
    : `<div class="banner err">未识别为 Shopify 店铺（判定得分 ${r.shopifyScore} / 阈值 3）。下面的结果仅供参考。</div>`;

  const themeBlock = `
    <div class="card">
      <h3>主题</h3>
      ${t.name ? `
        <div class="stat-row" style="margin-bottom:8px">
          <div class="stat" style="flex-basis:100%">
            <div class="v">${esc(t.name)}</div>
            <div class="k">${esc(t.label)}${t.role ? ' · ' + esc(t.role) : ''}</div>
          </div>
        </div>
        <dl class="kv">
          <dt>厂商</dt><dd>${esc(t.vendor)}</dd>
          <dt>价格</dt><dd>${esc(t.price)}</dd>
          <dt>类型</dt><dd>${esc(t.kind)}</dd>
          <dt>Schema 名</dt><dd>${esc(t.schemaName || '—')}${t.schemaVersion ? ` <span class="chip">v${esc(t.schemaVersion)}</span>` : ''}</dd>
          <dt>主题商店 ID</dt><dd>${t.storeId == null ? '无（非主题商店直接安装）' : esc(t.storeId)}</dd>
          <dt>主题 ID</dt><dd>${esc(t.id ?? '—')}</dd>
        </dl>
        ${t.derivedFrom ? `<div class="banner ok" style="margin:8px 0 0">
          确定基于 <b>${esc(t.derivedFrom.name)}</b>（${esc(t.derivedFrom.vendor)}）二次开发 —— 依据是主题 schema 名，商家改主题名也改不掉这个字段。
        </div>` : ''}
        ${t.likelyCustomized ? `<p class="muted" style="font-size:11px;margin:8px 0 0">
          ${t.status === 'official' ? '官方主题商店主题，绝大多数店铺会在此基础上做二次开发。' : '第三方商业主题，通常也经过二次开发。'}</p>` : ''}
        ${(t.derivation && t.derivation.length) ? `<details style="margin-top:8px"><summary>推测的主题血缘（${t.derivation.length}）</summary>
          ${t.derivation.map((d) => `<div class="item"><div class="main"><div class="title">可能基于 ${esc(d.base)}</div>
          <div class="evidence">${esc(d.evidence)}</div></div></div>`).join('')}</details>` : ''}
      ` : `
        <p class="muted" style="margin:0 0 6px">未能读取到主题信息 —— ${esc(t.label)}。</p>
        ${r.headlessEvidence && r.headlessEvidence.length
          ? `<div class="chip brand">前端框架迹象：${esc(r.headlessEvidence.join('、'))}</div>
             <p class="muted" style="font-size:11px;margin:6px 0 0">无头店面（Hydrogen / 自建前端）不渲染 Liquid 主题层，因此拿不到主题名，这是正常现象。</p>`
          : ''}
      `}
    </div>`;

  const plusBlock = r.plus && r.plus.reasons.length ? `
    <div class="card">
      <h3>Shopify Plus 推测 <span class="count">（置信度 ${esc(r.plus.level)}）</span></h3>
      <div class="list">${r.plus.reasons.map((x) => `<div class="item"><div class="main">${esc(x)}</div></div>`).join('')}</div>
      <p class="muted" style="font-size:11px;margin:8px 0 0">前端拿不到店铺套餐字段，这里是基于结账域名、Multipass 等迹象的推测，不是官方结论。</p>
    </div>` : '';

  const estimateBlock = e && e.available ? `
    <div class="card">
      <h3>规模量级估算 <span class="count">（置信度 ${esc(e.confidence)}）</span></h3>
      <div class="stat-row">
        <div class="stat"><div class="v">${fmtNumber(e.monthlyOrders)}</div><div class="k">月订单量（估）</div></div>
        <div class="stat"><div class="v">${fmtMoney(e.monthlyRevenue, p.currency)}</div><div class="k">月营收（估）</div></div>
        <div class="stat"><div class="v">${fmtMoney(e.aov, p.currency)}</div><div class="k">客单价（估）</div></div>
      </div>
      <div style="margin-top:10px">
        <div class="muted" style="font-size:11px;margin-bottom:4px">规模评分 ${e.inputs.scaleScore} / 100</div>
        <div class="bar"><i style="width:${e.inputs.scaleScore}%"></i></div>
      </div>
      <details style="margin-top:10px"><summary>估算公式与输入</summary>
        <pre>${esc(e.formula)}
输入：产品数 ${e.inputs.productCount}，规模系数 ${e.inputs.scaleFactor}，上新系数 ${e.inputs.freshFactor}，价格中位数 ${esc(String(e.inputs.priceMedian ?? '—'))}</pre>
        <p class="muted" style="font-size:11px;margin:6px 0 0">${esc(e.disclaimer)}</p>
      </details>
    </div>` : `
    <div class="card">
      <h3>规模量级估算</h3>
      <p class="muted" style="margin:0">${esc((e && e.reason) || '未做估算。')}</p>
    </div>`;

  return `
    ${shopifyBanner}
    ${themeBlock}
    <div class="card">
      <h3>规模概览</h3>
      <div class="stat-row">
        <div class="stat"><div class="v">${fmtNumber(s.count)}</div><div class="k">产品数</div></div>
        <div class="stat"><div class="v">${fmtNumber(s.variants)}</div><div class="k">SKU 数</div></div>
        <div class="stat"><div class="v">${fmtNumber(r.apps.length)}</div><div class="k">已装应用</div></div>
        <div class="stat"><div class="v">${fmtNumber(r.pixels.length)}</div><div class="k">追踪像素</div></div>
        <div class="stat"><div class="v">${fmtNumber(s.newLast30d)}</div><div class="k">近 30 天上新</div></div>
        <div class="stat"><div class="v">${fmtNumber(s.ageDaysMedian == null ? null : Math.round(s.ageDaysMedian))}</div><div class="k">产品中位年龄（天）</div></div>
      </div>
      <dl class="kv" style="margin-top:10px">
        <dt>价格区间</dt><dd>${fmtMoney(s.priceMin, p.currency)} – ${fmtMoney(s.priceMax, p.currency)}</dd>
        <dt>价格中位数</dt><dd>${fmtMoney(s.priceMedian, p.currency)}</dd>
        <dt>打折商品占比</dt><dd>${fmtPercent(s.discountShare)}</dd>
        <dt>售罄商品占比</dt><dd>${fmtPercent(s.soldOutShare)}</dd>
        <dt>合集数</dt><dd>${fmtNumber((r.catalogue.collections || []).length)}</dd>
      </dl>
      ${s.priceBands ? `<div style="margin-top:10px">
        <div class="muted" style="font-size:11px;margin-bottom:4px">价格分布</div>
        ${Object.entries(s.priceBands).map(([k, v]) => {
          const pct = s.count ? Math.round((v / s.count) * 100) : 0;
          return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
            <span class="muted" style="font-size:10px;width:58px;flex:none">${esc(k)}</span>
            <span class="bar" style="flex:1"><i style="width:${pct}%"></i></span>
            <span class="muted" style="font-size:10px;width:44px;text-align:right;flex:none">${v} (${pct}%)</span>
          </div>`;
        }).join('')}
      </div>` : ''}
    </div>
    ${estimateBlock}
    ${plusBlock}
    <div class="card">
      <h3>站点信息</h3>
      <dl class="kv">
        <dt>店铺域名</dt><dd>${esc(p.domain || r.host)}</dd>
        ${p.shop ? `<dt>Shopify shop</dt><dd>${esc(p.shop)}</dd>` : ''}
        <dt>货币</dt><dd>${esc(p.currency || '—')}</dd>
        <dt>国家</dt><dd>${esc(p.country || '—')}</dd>
        <dt>语言</dt><dd>${esc(p.locale || '—')}</dd>
      </dl>
    </div>
  `;
}

function emptyState() {
  return `<div class="placeholder">
    <p>还没有扫描结果。</p>
    <p class="muted">点击上方「扫描当前店铺」。如果提示权限不足，先点一下浏览器工具栏里的扩展图标。</p>
  </div>`;
}

/* ───────────────────────── 店铺变化 ───────────────────────── */

/** 三档分组的中文说法，与 lib/timeline.js 的 STRENGTH_LABEL 保持一致 */
const STRENGTH_CN = { strong: '确定的变化', medium: '看趋势', weak: '参考信息' };

/** 事件流：把一条事件渲染成一行 */
function eventRow(e, r) {
  const title = e.title ? esc(e.title) : (e.appId ? esc(appNameOf(e.appId, r)) : '（店铺级）');
  const detail = e.detail ? ` · ${esc(e.detail)}` : '';
  return `<div class="item">
    <div class="main">
      <div class="title">${esc(e.icon || '')} ${title}</div>
      <div class="sub">${esc(e.label)}${detail}</div>
    </div>
  </div>`;
}

function appNameOf(id, r) {
  const a = (r.apps || []).find((x) => x.id === id);
  return a ? a.name : id;
}

/** 12 个月上新柱状图 */
function cadenceChart(cadence) {
  const max = Math.max(1, ...cadence.buckets.map((b) => b.count));
  const trendCn = { accelerating: '近 3 个月在加速上新', slowing: '近 3 个月上新放缓', flat: '上新节奏平稳' };
  const colored = { accelerating: 'var(--ok)', slowing: 'var(--warn)', flat: 'var(--muted)' };
  return `
    <div class="card">
      <h3>上新速度（近 12 个月） <span class="count">共 ${cadence.total} 款</span></h3>
      <p class="muted" style="font-size:11px;margin:0 0 8px">
        这家店每个月上了多少新品。<b>扫一次就能看到，不用等第二次。</b>
        上新变密，通常说明在推新品或者备货旺季。
      </p>
      <div style="display:flex;align-items:flex-end;gap:2px;height:64px;margin-bottom:4px">
        ${cadence.buckets.map((b) => {
          const h = Math.round((b.count / max) * 60);
          return `<div title="${esc(b.key)}：${b.count} 款" style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%">
            <div style="height:${Math.max(b.count ? 3 : 1, h)}px;background:${b.count ? 'var(--brand)' : 'var(--chip)'};border-radius:2px"></div>
          </div>`;
        }).join('')}
      </div>
      <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--muted)">
        <span>${esc(cadence.buckets[0]?.key || '')}</span>
        <span>${esc(cadence.buckets[cadence.buckets.length - 1]?.key || '')}</span>
      </div>
      <div style="margin-top:8px;font-size:12px;color:${colored[cadence.trend]}">${esc(trendCn[cadence.trend])}
        <span class="muted">（近 3 月 ${cadence.last3Months} 款 vs 前 3 月 ${cadence.prev3Months} 款${cadence.peakMonth?.count ? `，峰值 ${cadence.peakMonth.key} 共 ${cadence.peakMonth.count} 款` : ''}）</span>
      </div>
    </div>`;
}

function renderOrders() {
  const r = state.result;
  if (!r) return emptyState();
  const t = r.timeline;
  if (!t) return `<div class="banner err">动态数据缺失（旧版本扫描结果缓存）。请重新扫描一次。</div>`;
  if (t.error) return `<div class="banner err">${esc(t.error)}</div>`;

  // ── 数据来源说明：这一块必须显眼，不能让用户误以为是真实订单 ──
  const provenance = `
    <div class="card" style="border-color:var(--brand)">
      <h3>这个页面在看什么 <span class="count">必读</span></h3>
      <p style="font-size:12px;margin:0 0 8px">
        <b>别人家的订单，任何插件都看不到。</b>Shopify 不公开订单接口，库存数量也不给。
      </p>
      <p style="font-size:12px;margin:0 0 8px">
        所以这里用的是另一个办法：<b>像给货架拍照。</b>
        你每扫一次，我记下这家店当时的样子；下次再扫，两张一比，就知道变了什么。
      </p>
      <div style="font-size:11px;color:var(--muted);line-height:1.8">
        <div><span class="chip high">确定的变化</span>卖光了 / 补货了 / 上了新品 / 下架了 / 改价了 —— 两次扫描之间的真实变化</div>
        <div><span class="chip medium">看趋势</span>在店铺销量排行榜上的名次挪动</div>
        <div><span class="chip low">参考信息</span>装了什么新应用、换没换店面模板</div>
      </div>
      <p style="font-size:11px;margin:8px 0 0;color:var(--warn)">
        注意：<b>卖光不等于一定是被买走的</b>（也可能是老板自己下架），排名上升也不等于一定有人买。
        这些是线索，不是订单。
      </p>
    </div>`;

  // ── 记录情况 ──
  const span = t.observationSpanMs;
  const spanText = !t.hasHistory ? '还没有'
    : span < 3600000 ? `${Math.max(1, Math.round(span / 60000))} 分钟`
      : span < 86400000 ? `${(span / 3600000).toFixed(1)} 小时`
        : `${(span / 86400000).toFixed(1)} 天`;

  const baseline = `
    <div class="card">
      <h3>你在这家店记录了多少</h3>
      <div class="stat-row">
        <div class="stat"><div class="v">${fmtNumber(t.snapshotCount)} 次</div><div class="k">已扫描</div></div>
        <div class="stat"><div class="v">${esc(spanText)}</div><div class="k">盯了多久</div></div>
        <div class="stat"><div class="v">${fmtNumber(t.baseline.trackedProducts)}</div><div class="k">记了多少商品</div></div>
        <div class="stat"><div class="v">${fmtNumber(t.events.length)}</div><div class="k">这次发现的变化</div></div>
      </div>
      ${t.hasHistory ? `<p class="muted" style="font-size:11px;margin:8px 0 0">
        这次是跟上次扫描（${esc(fmtAgo(new Date(t.prevSnapshotAt).toISOString()))}）比的。
        盯的时间越长，能看出的变化越多 —— 建议隔一两天扫一次同一家店。</p>`
        : `<div class="banner" style="margin:8px 0 0">
        <b>这是第一次扫描，还没有可对比的东西。</b>下面都是扫一次就能看到的内容。
        <b>隔一两天再扫一次同一家店</b>，这里就会出现「谁卖光了、谁补货了、上了什么新品、什么涨价了」。</div>`}
      ${t.snapshotCount > 1 ? `<div class="btn-row" style="margin-top:8px"><button class="ghost" id="clearSnaps">清空这家店的记录</button></div>` : ''}
    </div>`;

  // ── 变化清单 ──
  const eventsBlock = t.events.length ? `
    <div class="card">
      <h3>这次发现了什么变化 <span class="count">${t.events.length} 条</span></h3>
      ${['strong', 'medium', 'weak'].map((s) => {
        const list = t.events.filter((e) => e.strength === s);
        if (!list.length) return '';
        return `<div style="margin-bottom:10px">
          <div style="font-size:11px;color:var(--muted);margin-bottom:4px">
            ${esc(STRENGTH_CN[s])}（${list.length}）</div>
          <div class="list">${list.map((e) => eventRow(e, r)).join('')}</div>
        </div>`;
      }).join('')}
    </div>` : '';

  // ── 最近上架 ──
  const recentBlock = t.recentProducts.length ? `
    <div class="card">
      <h3>最近 ${t.newWindowDays} 天上了什么新品 <span class="count">${t.recentProducts.length} 款</span></h3>
      <p class="muted" style="font-size:11px;margin:0 0 8px">
        这家店最近在铺什么货。如果右边带 <b>#数字</b>，说明它已经进了店铺销量排行榜 ——
        <b>既是新品又上榜的，通常就是现在的主推款</b>。
      </p>
      <div class="list">${t.recentProducts.slice(0, 25).map((p) => {
        const rank = (r.catalogue.bestSellersAll || []).find((b) => b.handle === p.handle);
        return `<div class="item">
          <div class="main">
            <div class="title">${rank ? `<span class="chip brand">#${esc(rank.rank)}</span>` : ''}${esc(p.title)}</div>
            <div class="sub">${esc(p.vendor || '未标注品牌')}${p.productType ? ' · ' + esc(p.productType) : ''}</div>
            <div class="sub">${esc(fmtAgo(p.publishedAt || p.createdAt))}上架 · ${esc(p.variantCount)} 变体</div>
          </div>
          <div class="right">
            <div>${fmtMoney(p.price, r.profile.currency)}</div>
            <div>${p.availableVariants > 0 ? '有货' : '<span style="color:var(--danger)">缺货</span>'}</div>
          </div>
        </div>`;
      }).join('')}</div>
    </div>` : `<div class="card"><h3>最近 ${t.newWindowDays} 天上了什么新品</h3>
      <p class="muted" style="margin:0">这家店最近 ${t.newWindowDays} 天没有上新品。</p></div>`;

  // ── 卖光的款（卖光是最接近「有人下单」的公开证据）──
  const soldOutBlock = `
    <div class="card">
      <h3>现在卖光的款 <span class="count">${t.soldOutNow.length} 款全断货 · ${t.partlySoldOut.length} 款部分断货</span></h3>
      <p class="muted" style="font-size:11px;margin:0 0 8px">
        <b>所有规格都没货</b>，是最接近「卖光了」的公开证据。
        如果它同时又排在销量榜前面，基本可以认定是爆款。
      </p>
      ${t.soldOutNow.length ? `<div class="list">${t.soldOutNow.slice(0, 15).map((p) => `
        <div class="item">
          <div class="main">
            <div class="title">${p.rank ? `<span class="chip brand">#${esc(p.rank)}</span>` : ''}${esc(p.title)}</div>
            <div class="sub">${esc(p.vendor || '未标注品牌')} · ${esc(p.variantCount)} 个规格全都没货</div>
          </div>
          <div class="right">${fmtMoney(p.price, r.profile.currency)}</div>
        </div>`).join('')}</div>` : '<p class="muted" style="margin:0">没有全部卖光的款。</p>'}
      ${t.partlySoldOut.length ? `
        <div style="margin-top:10px">
          <div style="font-size:11px;color:var(--muted);margin-bottom:4px">部分规格断货（断得越多，说明那个规格越好卖）</div>
          <div class="list">${t.partlySoldOut.slice(0, 12).map((p) => `
            <div class="item">
              <div class="main">
                <div class="title">${p.rank ? `<span class="chip brand">#${esc(p.rank)}</span>` : ''}${esc(p.title)}</div>
                <div class="sub">${esc(p.availableVariants)}/${esc(p.variantCount)} 个规格有货</div>
              </div>
              <div class="right"><span class="chip danger">缺 ${Math.round(p.soldRatio * 100)}%</span></div>
            </div>`).join('')}</div>
        </div>` : ''}
    </div>`;

  // ── 销量排行榜 ──
  const rankBlock = t.topSellers.length ? `
    <div class="card">
      <h3>这家店的销量排行榜 <span class="count">Top ${Math.min(20, t.topSellers.length)}</span></h3>
      <p class="muted" style="font-size:11px;margin:0 0 8px">
        这个顺序是<b>店铺自己后台认的销量排序</b>，不是估算出来的。
        <b>再扫一次，名次挪动就会出现在上面的「排名上升/下降」里。</b>
      </p>
      <div class="list">${t.topSellers.slice(0, 20).map((b) => `
        <div class="item"><div class="main">
          <div class="title"><span class="chip brand">#${esc(b.rank)}</span>${esc(b.title)}</div>
        </div></div>`).join('')}</div>
    </div>` : `
    <div class="card">
      <h3>这家店的销量排行榜</h3>
      <div class="banner">这家店读不到排行榜，所以没有名次数据。</div>
      ${(r.catalogue.notes || []).length ? `<div class="list">${r.catalogue.notes.map((n) => `<div class="item"><div class="main"><div class="sub">${esc(n)}</div></div></div>`).join('')}</div>` : ''}
      <p class="muted" style="font-size:11px;margin:8px 0 0">
        没有排行榜不影响上面的「上了什么新品」「现在卖光的款」「上新速度」—— 那几项只要产品清单就能算。
      </p>
    </div>`;

  return provenance + baseline + eventsBlock + recentBlock + soldOutBlock + cadenceChart(t.cadence) + rankBlock;
}

/* ───────────────────────── 应用 ───────────────────────── */

function renderApps() {
  const r = state.result;
  if (!r) return emptyState();
  if (!r.isShopify) return `<div class="banner err">当前页面不是 Shopify 店铺，应用指纹匹配结果不可信。</div>` + appsBody(r);

  return `
    <input class="search-input" id="appQuery" placeholder="搜索应用名 / 厂商 / 分类…" value="${esc(state.appQuery)}">
    ${appsBody(r)}
  `;
}

function appsBody(r) {
  const q = state.appQuery.trim().toLowerCase();
  const list = r.apps.filter((a) => !q || `${a.name} ${a.vendor} ${a.category}`.toLowerCase().includes(q));
  if (!list.length) {
    return `<div class="card"><p class="muted" style="margin:0">${r.apps.length ? '没有匹配的应用。' : '未识别到已安装的第三方应用。'}</p></div>`;
  }
  const byCat = new Map();
  for (const a of list) {
    if (!byCat.has(a.category)) byCat.set(a.category, []);
    byCat.get(a.category).push(a);
  }
  return [...byCat.entries()].map(([cat, items]) => `
    <div class="card">
      <h3>${esc(cat)} <span class="count">${items.length}</span></h3>
      <div class="list">${items.map((a) => `
        <div class="item">
          <div class="main">
            <div class="title">${esc(a.name)}</div>
            <div class="sub">${esc(a.vendor)}${a.url ? ` · <a href="${esc(a.url)}" target="_blank" rel="noreferrer noopener">官网</a>` : ''}</div>
            <div class="evidence">${esc(a.evidence)}</div>
          </div>
          <div class="right"><span class="chip ${esc(a.confidence)}">${esc(CONF_CN[a.confidence] || a.confidence)}</span></div>
        </div>`).join('')}
      </div>
    </div>`).join('');
}

/* ───────────────────────── 像素 ───────────────────────── */

function renderPixels() {
  const r = state.result;
  if (!r) return emptyState();
  if (!r.pixels.length) return `<div class="card"><p class="muted" style="margin:0">未识别到追踪像素。可能是店铺把像素放在 GTM 容器里，或者使用了服务端埋点。</p></div>`;

  const byKind = new Map();
  for (const p of r.pixels) {
    if (!byKind.has(p.kind)) byKind.set(p.kind, []);
    byKind.get(p.kind).push(p);
  }
  const adPlatforms = r.pixels.filter((p) => p.kind === '广告像素').map((p) => p.platform);
  const insight = adPlatforms.length
    ? `<div class="banner ok">该店铺在 ${[...new Set(adPlatforms)].join('、')} 上投放过广告。对选品来说，这是它已经有付费流量经验的直接证据。</div>`
    : `<div class="banner">未识别到广告像素。要么没投广告，要么像素通过 GTM 或服务端转发，前端看不到。</div>`;

  return insight + [...byKind.entries()].map(([kind, items]) => `
    <div class="card">
      <h3>${esc(kind)} <span class="count">${items.length}</span></h3>
      <div class="list">${items.map((p) => `
        <div class="item">
          <div class="main">
            <div class="title">${esc(p.name)}</div>
            <div class="sub">${esc(p.platform)}</div>
            <div class="evidence">${esc(p.evidence)}</div>
          </div>
          <div class="right"><span class="chip ${esc(p.confidence)}">${esc(CONF_CN[p.confidence] || p.confidence)}</span></div>
        </div>`).join('')}
      </div>
    </div>`).join('');
}

/* ───────────────────────── 产品库 ───────────────────────── */

function sortedProducts() {
  const r = state.result;
  if (!r) return [];
  const rows = productRows(r);
  const rank = (x) => (x.rank === '' || x.rank == null ? 9999 : x.rank);
  const by = {
    default: (a, b) => rank(a) - rank(b) || (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0),
    newest: (a, b) => (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0),
    priceAsc: (a, b) => (a.price ?? 1e12) - (b.price ?? 1e12),
    priceDesc: (a, b) => (b.price ?? -1) - (a.price ?? -1),
    discount: (a, b) => (b.discountPct || 0) - (a.discountPct || 0)
  };
  return rows.sort(by[state.productSort] || by.default);
}

function renderProducts() {
  const r = state.result;
  if (!r) return emptyState();
  if (!r.catalogue.products.length) {
    return `<div class="banner">${esc(r.catalogue.notes[0] || '未读取到产品目录。')}</div>
      <div class="card"><h3>为什么读不到</h3>
        <p class="muted" style="margin:0;font-size:12px">产品库依赖店铺公开的 <code>/products.json</code>。部分店铺通过应用或主题设置关闭了该接口，此时产品库与选品分析不可用，但主题、应用、像素检测不受影响。</p>
      </div>`;
  }

  const q = state.productQuery.trim().toLowerCase();
  let rows = sortedProducts();
  if (q) rows = rows.filter((p) => `${p.title} ${p.handle} ${p.vendor} ${p.productType}`.toLowerCase().includes(q));

  const shown = rows.slice(0, state.productLimit);
  const sorts = [['default', '爆款排序'], ['newest', '最新上架'], ['priceAsc', '价格↑'], ['priceDesc', '价格↓'], ['discount', '折扣力度']];

  return `
    <input class="search-input" id="productQuery" placeholder="搜索产品标题 / 品牌 / 类型…" value="${esc(state.productQuery)}">
    <div class="btn-row" style="margin-bottom:8px">
      ${sorts.map(([k, label]) => `<button class="ghost ${state.productSort === k ? 'on' : ''}" data-sort="${k}"
        style="${state.productSort === k ? 'border-color:var(--brand);color:var(--brand)' : ''}">${label}</button>`).join('')}
    </div>
    <div class="muted" style="font-size:11px;margin-bottom:6px">共 ${rows.length} 条，显示前 ${shown.length} 条</div>
    <div class="list">${shown.map((p) => `
      <div class="item">
        <div class="main">
          <div class="title">${p.rank !== '' && p.rank != null ? `<span class="chip brand">#${esc(p.rank)}</span>` : ''}${esc(p.title)}</div>
          <div class="sub">${esc(p.vendor || '未标注品牌')}${p.productType ? ' · ' + esc(p.productType) : ''}</div>
          <div class="sub">${esc(p.handle)} · ${esc(fmtAgo(p.createdAt))}</div>
        </div>
        <div class="right">
          <div>${fmtMoney(p.price, r.profile.currency)}</div>
          ${p.discountPct !== '' ? `<div style="color:var(--danger)">-${esc(p.discountPct)}%</div>` : ''}
          <div>${esc(p.variantCount)} 变体</div>
          <div>${p.availableVariants > 0 ? '有货' : '缺货'}</div>
        </div>
      </div>`).join('')}</div>
    ${rows.length > shown.length ? `<div class="btn-row" style="margin-top:8px"><button class="ghost" id="loadMore">再加载 ${Math.min(60, rows.length - shown.length)} 条</button></div>` : ''}
  `;
}

/* ───────────────────────── 选品 ───────────────────────── */

/**
 * 选品打分：把「值不值得跟卖」拆成可解释的几个维度。
 * 权重是经验值，但每一项都写在界面上，用户可以自己判断。
 */
function scoreProduct(p, r) {
  const parts = [];
  const add = (label, value, weight, note) => parts.push({ label, value: Math.max(0, Math.min(1, value)), weight, note, contribution: Math.max(0, Math.min(1, value)) * weight });

  // 1. 爆款排名：上榜即强信号
  const hasRank = p.rank !== '' && p.rank != null;
  add('店铺销量排行', hasRank ? Math.max(0, 1 - (Number(p.rank) - 1) / 24) : 0, 35, hasRank ? `第 ${p.rank} 名` : '未上榜');

  // 2. 折扣策略：30–60% 折扣通常是主推款
  const d = (p.discountPct || 0) / 100;
  add('折扣力度', d >= 0.3 && d <= 0.6 ? 1 : d > 0 ? 0.5 : 0, 15, d ? `-${Math.round(d * 100)}%` : '无折扣');

  // 3. 上新：近期上架说明还在测款
  const age = p.createdAt ? (Date.now() - Date.parse(p.createdAt)) / 86400000 : null;
  add('上新时间', age == null ? 0 : age <= 60 ? 1 : age <= 180 ? 0.6 : 0.3, 15, age == null ? '未知' : `${Math.round(age)} 天前上架`);

  // 4. 变体丰富度：多规格说明是主推结构
  add('变体丰富度', (p.variantCount || 1) >= 8 ? 1 : (p.variantCount || 1) / 8, 15, `${p.variantCount || 0} 个变体`);

  // 5. 价格带：15–60 是冲动消费最舒服的区间
  const price = p.price || 0;
  add('价格带', price >= 15 && price <= 60 ? 1 : price > 0 && price < 15 ? 0.6 : price <= 120 ? 0.4 : 0.2, 20,
    price ? `${r.profile.currency || ''} ${price}` : '未知');

  const total = parts.reduce((a, b) => a + b.contribution, 0);
  return { total: Math.round(total), parts };
}

function renderWinners() {
  const r = state.result;
  if (!r) return emptyState();
  if (!r.catalogue.products.length) {
    return `<div class="banner">${esc(r.catalogue.notes[0] || '未读取到产品目录，无法做选品分析。')}</div>`;
  }

  const rows = productRows(r);
  const scored = rows.map((p) => ({ ...p, pick: scoreProduct(p, r) })).sort((a, b) => b.pick.total - a.pick.total);

  const top = scored.slice(0, 25);
  const byRank = [...rows].filter((p) => p.rank !== '' && p.rank != null).sort((a, b) => a.rank - b.rank).slice(0, 15);

  const rankBlock = byRank.length ? `
    <div class="card">
      <h3>店铺的销量排行榜 <span class="count">${byRank.length}</span></h3>
      <p class="muted" style="font-size:11px;margin:0 0 8px">数据来自店铺 collection 页面的 <code>sort_by=best-selling</code> 排序，是商家自己认可的真实销量排序，比任何外部估算都硬。</p>
      <div class="list">${byRank.map((p) => `
        <div class="item">
          <div class="main"><div class="title"><span class="chip brand">#${esc(p.rank)}</span>${esc(p.title)}</div>
          <div class="sub">${esc(p.vendor || '未标注品牌')}</div></div>
          <div class="right">${fmtMoney(p.price, r.profile.currency)}</div>
        </div>`).join('')}</div>
    </div>` : `
    <div class="card">
      <h3>店铺的销量排行榜</h3>
      <div class="banner">这家店读不到 best-selling 排序。</div>
      ${(r.catalogue.notes || []).length ? `<div class="list">${r.catalogue.notes.map((n) => `<div class="item"><div class="main"><div class="sub">${esc(n)}</div></div></div>`).join('')}</div>` : ''}
    </div>`;

  // 降级视图：JSON 端点给的合集成员。必须和历史销量排序严格分开显示，
  // 否则用户会把"合集里有什么"误读成"什么卖得好"。
  const membersBlock = (r.catalogue.collectionMembers || []).length ? `
    <div class="card">
      <h3>合集成员（非销量排序） <span class="count">${r.catalogue.collectionMembers.length} 个合集</span></h3>
      <div class="banner">
        下面这些来自 JSON 端点，<b>不含销量排序</b> —— 该端点会忽略 <code>sort_by</code>。
        仅用于看品类结构，<b>不能当作销量排行榜</b>。
      </div>
      ${r.catalogue.collectionMembers.map((c) => `
        <div style="margin-bottom:10px">
          <div style="font-size:12px;font-weight:600;margin-bottom:4px">${esc(c.collection)} <span class="muted" style="font-weight:400">（${c.items.length} 款）</span></div>
          <div class="list">${c.items.slice(0, 6).map((it) => `
            <div class="item"><div class="main">${esc(it.title)}</div></div>`).join('')}
            ${c.items.length > 6 ? `<div class="muted" style="font-size:11px">… 另 ${c.items.length - 6} 款</div>` : ''}
          </div>
        </div>`).join('')}
    </div>` : '';

  const collectionsBlock = (r.catalogue.bestSellers || []).length ? `
    <div class="card">
      <h3>各品类爆款 <span class="count">${r.catalogue.bestSellers.length} 个合集</span></h3>
      ${r.catalogue.bestSellers.map((c) => `
        <div style="margin-bottom:10px">
          <div style="font-size:12px;font-weight:600;margin-bottom:4px">${esc(c.collection)}</div>
          <div class="list">${c.items.slice(0, 6).map((it) => `
            <div class="item"><div class="main"><span class="chip brand">#${esc(it.rank)}</span>${esc(it.title)}</div></div>`).join('')}</div>
        </div>`).join('')}
    </div>` : '';

  return `
    ${rankBlock}
    <div class="card">
      <h3>高潜力选品打分 <span class="count">Top ${top.length}</span></h3>
      <p class="muted" style="font-size:11px;margin:0 0 8px">五个维度加权：销量排行 35、价格带 20、折扣 15、上新 15、变体 15。点开任意一条可看它为什么得分。</p>
      <div class="list">${top.map((p) => `
        <div class="item">
          <div class="main">
            <div class="title">${esc(p.title)}</div>
            <div class="sub">${esc(p.vendor || '未标注品牌')} · ${fmtMoney(p.price, r.profile.currency)}${p.discountPct !== '' ? ` · <span style="color:var(--danger)">-${esc(p.discountPct)}%</span>` : ''}</div>
            <details style="margin-top:4px"><summary style="font-size:11px">得分构成</summary>
              <table style="width:100%;font-size:11px;border-collapse:collapse;margin-top:4px">
                ${p.pick.parts.map((x) => `<tr>
                  <td style="color:var(--muted);padding:1px 0">${esc(x.label)}</td>
                  <td style="text-align:right;padding:1px 0">${esc(x.note)}</td>
                  <td style="text-align:right;padding:1px 0;width:44px">+${x.contribution.toFixed(1)}</td>
                </tr>`).join('')}
              </table>
            </details>
          </div>
          <div class="right"><span class="chip brand">${esc(p.pick.total)}</span></div>
        </div>`).join('')}</div>
    </div>
    ${collectionsBlock}
    ${membersBlock}
  `;
}

/* ───────────────────────── 技术审计 ───────────────────────── */

function renderAudit() {
  const r = state.result;
  if (!r) return emptyState();
  const sig = r.signals || {};
  const a = r.themeAssets || {};

  return `
    <div class="card">
      <h3>Shopify 判定依据</h3>
      <div class="list">${(r.shopifyEvidence || []).map((e) => `<div class="item"><div class="main">${esc(e)}</div></div>`).join('') || '<p class="muted" style="margin:0">无</p>'}</div>
    </div>
    <div class="card">
      <h3>主题资产</h3>
      <dl class="kv">
        <dt>资产文件数</dt><dd>${fmtNumber(a.assetCount)}</dd>
        <dt>section 数</dt><dd>${fmtNumber(a.sectionCount)}</dd>
      </dl>
      ${(a.assets || []).length ? `<details style="margin-top:8px"><summary>资产文件清单</summary>
        <pre>${esc((a.assets || []).join('\n'))}</pre></details>` : ''}
    </div>
    <div class="card">
      <h3>页面信号</h3>
      <dl class="kv">
        <dt>脚本数</dt><dd>${fmtNumber((sig.scriptSrcs || []).length)}</dd>
        <dt>样式/资源链接数</dt><dd>${fmtNumber((sig.linkHrefs || []).length)}</dd>
        <dt>探测到的全局变量</dt><dd>${fmtNumber((sig.windowGlobals || []).length)}</dd>
        <dt>HTML 大小</dt><dd>${fmtNumber(sig.htmlLength)} 字符</dd>
      </dl>
      ${(sig.windowGlobals || []).length ? `<div style="margin-top:8px">${sig.windowGlobals.map((g) => `<span class="chip">${esc(g)}</span>`).join('')}</div>` : ''}
    </div>
    <div class="card">
      <h3>Meta 标签 <span class="count">${(sig.metaTags || []).length}</span></h3>
      <details><summary>展开</summary>
        <pre>${esc((sig.metaTags || []).map((m) => `${m.name} = ${m.content}`).join('\n'))}</pre></details>
    </div>
    <div class="card">
      <h3>Cookie 名称 <span class="count">${(sig.cookieNames || []).length}</span></h3>
      <p class="muted" style="font-size:11px;margin:0 0 6px">只读取名字，不读取值 —— 值里可能有购物车令牌或会话凭据。</p>
      <div>${(sig.cookieNames || []).map((c) => `<span class="chip">${esc(c)}</span>`).join('') || '<span class="muted">无</span>'}</div>
    </div>
    <div class="card">
      <h3>第三方脚本来源 <span class="count">${fmtNumber((sig.scriptSrcs || []).length)}</span></h3>
      <details><summary>展开全部域名</summary>
        <pre>${esc([...new Set((sig.scriptSrcs || []).map((u) => { try { return new URL(u).hostname; } catch { return u; } }))].sort().join('\n'))}</pre></details>
    </div>
  `;
}

/* ───────────────────────── 导出 ───────────────────────── */

function renderExport() {
  const r = state.result;
  const s = state.settings || {};
  const exportBlock = r ? `
    <div class="card">
      <h3>导出当前店铺</h3>
      <div class="btn-row">
        <button class="ghost" data-export="products">产品库 CSV</button>
        <button class="ghost" data-export="apps">已装应用 CSV</button>
        <button class="ghost" data-export="pixels">追踪像素 CSV</button>
        <button class="ghost" data-export="collections">合集 CSV</button>
        <button class="ghost" data-export="orders">店铺变化 CSV</button>
        <button class="ghost" data-export="full">完整报告 JSON</button>
      </div>
      <p class="muted" style="font-size:11px;margin:8px 0 0">CSV 带 UTF-8 BOM，Excel 直接打开不乱码。</p>
    </div>` : '';

  const favBlock = state.favorites.length ? `
    <div class="card">
      <h3>收藏的店铺 <span class="count">${state.favorites.length}</span></h3>
      <div class="list">${state.favorites.map((f) => `
        <div class="item"><div class="main"><div class="title">${esc(f.label)}</div><div class="sub">${esc(f.host)}</div></div></div>`).join('')}</div>
    </div>` : '';

  const histBlock = state.history.length ? `
    <div class="card">
      <h3>扫描历史 <span class="count">${state.history.length}</span></h3>
      <div class="list">${state.history.slice(0, 20).map((h) => `
        <div class="item">
          <div class="main">
            <div class="title">${esc(h.host)}</div>
            <div class="sub">${h.isShopify ? 'Shopify' : '未识别'}${h.themeName ? ' · ' + esc(h.themeName) : ''} · ${h.appCount} 应用 · ${h.productCount} 产品</div>
          </div>
          <div class="right">${esc(fmtDate(new Date(h.at).toISOString()))}</div>
        </div>`).join('')}</div>
      <div class="btn-row" style="margin-top:8px"><button class="ghost" id="clearHistory">清空历史</button></div>
    </div>` : '';

  return `
    ${exportBlock}
    <div class="card settings">
      <h3>扫描设置</h3>
      <label>产品目录最多翻页：<input type="number" id="setPages" min="1" max="40" value="${esc(s.maxPages ?? 12)}"> 页（每页 250 条）</label>
      <p class="hint">翻页越多越慢。12 页 = 最多 3000 条产品，绝大多数店铺一次就到底了。</p>
      <label>销量排行榜抓集合集数：<input type="number" id="setCollections" min="0" max="6" value="${esc(s.bestSellerCollections ?? 3)}"> 个</label>
      <p class="hint">按产品数取最大的几个合集，逐个抓它们的 best-selling 排序。</p>
      <label style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" id="setCatalogue" ${s.includeCatalogue !== false ? 'checked' : ''}> 扫描时抓取产品目录
      </label>
      <div class="btn-row" style="margin-top:8px"><button class="ghost" id="saveSettings">保存设置</button></div>
    </div>
    ${contactCardHtml()}
    <div class="card">
      <h3>关于</h3>
      <p class="muted" style="font-size:12px;margin:0 0 6px">
        选品侦探是一个完全离线的 Shopify 店铺侦察工具：所有指纹匹配、主题识别、选品打分都在本机完成，不向任何服务器发送数据。
      </p>
      <p class="muted" style="font-size:12px;margin:0">
        权限只用 <code>activeTab</code> + <code>scripting</code>，即只在你主动扫描时才读取当前标签页。扩展不记录浏览历史，也不读取你不点的标签页。
      </p>
    </div>
    ${favBlock}
    ${histBlock}
  `;
}

/* ───────────────────────── 导出 ───────────────────────── */

/**
 * 导出落盘必须在**页面上下文**做，不能在 background 做：
 * MV3 Service Worker 里没有 `URL.createObjectURL`（已从 ServiceWorkerGlobalScope
 * 移除），实测报 `URL.createObjectURL is not a function`。
 * background 只生成内容，这里负责转 Blob、发下载。
 */
async function doExport(what) {
  setStatus('正在生成导出文件…', '', true);
  try {
    const pack = await send('export', { what, result: state.result });
    if (!pack || !pack.ok) {
      setStatus(`导出失败：${(pack && pack.error) || '未知错误'}`);
      return;
    }

    const blob = new Blob([pack.content], { type: pack.mime });
    let url;
    if (typeof URL.createObjectURL === 'function') {
      url = URL.createObjectURL(blob);
    } else {
      // 理论上走不到这里（面板是普通文档），但真无 Blob URL 时用 data URL 兜底，
      // 总比整个功能不可用强。data URL 有体积上限，大文件会在下载阶段报错。
      url = `data:${pack.mime},${encodeURIComponent(pack.content)}`;
    }

    await chrome.downloads.download({ url, filename: pack.filename, saveAs: true });
    if (typeof URL.revokeObjectURL === 'function' && url.startsWith('blob:')) {
      // 给下载器接管 blob 留时间，再释放
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    const kb = (pack.bytes / 1024).toFixed(1);
    setStatus(`已导出 ${pack.filename}`, `${kb} KB`);
  } catch (e) {
    setStatus('导出失败：' + ((e && e.message) || e));
  }
}

/* ───────────────────────── 事件绑定 ───────────────────────── */

function bindView() {
  const appQ = $('#appQuery');
  if (appQ) appQ.addEventListener('input', (e) => {
    state.appQuery = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const el = $('#appQuery'); if (el) { el.focus(); el.setSelectionRange(pos, pos); }
  });

  const prodQ = $('#productQuery');
  if (prodQ) prodQ.addEventListener('input', (e) => {
    state.productQuery = e.target.value;
    state.productLimit = 60;
    const pos = e.target.selectionStart;
    render();
    const el = $('#productQuery'); if (el) { el.focus(); el.setSelectionRange(pos, pos); }
  });

  for (const btn of document.querySelectorAll('[data-sort]')) {
    btn.addEventListener('click', () => { state.productSort = btn.dataset.sort; state.productLimit = 60; render(); });
  }

  const more = $('#loadMore');
  if (more) more.addEventListener('click', () => { state.productLimit += 60; render(); });

  for (const btn of document.querySelectorAll('[data-export]')) {
    btn.addEventListener('click', () => doExport(btn.dataset.export));
  }

  const clear = $('#clearHistory');
  if (clear) clear.addEventListener('click', async () => {
    await send('clearHistory');
    state.history = [];
    render();
    setStatus('历史已清空');
  });

  const clearSnaps = $('#clearSnaps');
  if (clearSnaps) clearSnaps.addEventListener('click', async () => {
    await send('clearSnapshots', { host: state.result && state.result.host });
    setStatus('这家店的记录已清空，下次扫描会重新开始记');
    if (state.result) { state.result.timeline = null; render(); }
  });

  const save = $('#saveSettings');
  if (save) save.addEventListener('click', async () => {
    const patch = {
      maxPages: Math.max(1, Math.min(40, Number($('#setPages').value) || 12)),
      bestSellerCollections: Math.max(0, Math.min(6, Number($('#setCollections').value) || 0)),
      includeCatalogue: $('#setCatalogue').checked
    };
    const res = await send('setSettings', { patch });
    state.settings = res.settings;
    render();
    setStatus('设置已保存');
  });
}

/* ───────────────────────── 启动 ───────────────────────── */

async function loadSide() {
  const [histRes, favRes, setRes] = await Promise.all([send('history'), send('favorites'), send('getSettings')]);
  state.history = histRes.history || [];
  state.favorites = favRes.favorites || [];
  state.settings = setRes.settings || {};
}

async function init() {
  const tab = await currentTab();
  state.tabId = tab ? tab.id : null;

  // 注意：扩展只申请了 activeTab，没有申请 tabs 权限，因此**在用户点击工具栏图标
  // 授予权限之前，tab.url 是 undefined**（Chrome 会主动隐藏 url/title）。
  // 这里必须把「拿不到 url」和「页面不支持扫描」区分开，否则在正常店铺页面上
  // 也会显示「当前页不支持扫描」，把用户引向错误的排查方向。
  const BROWSER_PAGE = /^(chrome|edge|about|devtools|chrome-extension|moz-extension|view-source|file):/i;
  if (tab && tab.url) {
    hostLabel.textContent = BROWSER_PAGE.test(tab.url)
      ? '当前页不支持扫描'
      : (new URL(tab.url).hostname || '当前标签页');
  } else {
    // 真正的域名会在扫描结果回来后由 doScan() 覆盖
    hostLabel.textContent = '点工具栏图标可自动扫描';
  }

  await loadSide();

  // 已有缓存先渲染，避免闪空
  if (state.tabId != null) {
    const cached = await send('getCache', { tabId: state.tabId });
    if (cached && cached.cached) {
      state.result = cached.cached;
      hostLabel.textContent = cached.cached.host + (cached.cached.isShopify ? ' · Shopify' : '');
      render();
      setStatus('已载入上次结果', `扫描于 ${fmtAgo(new Date(cached.cached.scannedAt).toISOString())}`);
    }
  }

  // 工具栏图标点击触发的待扫描标记
  try {
    const { pendingScan } = await chrome.storage.session.get('pendingScan');
    if (pendingScan && pendingScan.tabId === state.tabId && Date.now() - pendingScan.at < 15000) {
      await chrome.storage.session.remove('pendingScan');
      await doScan($('#deepToggle').checked);
    } else {
      render();
    }
  } catch { render(); }
}

$('#scanBtn').addEventListener('click', () => doScan($('#deepToggle').checked));

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.remove('active');
    tab.classList.add('active');
    state.view = tab.dataset.tab;
    render();
  });
}

$('#favBtn').addEventListener('click', async () => {
  if (!state.result) return;
  const res = await send('toggleFavorite', { host: state.result.host, label: state.result.pageTitle || state.result.host });
  state.favorites = res.favorites || [];
  $('#favBtn').classList.toggle('on', !!res.added);
  setStatus(res.added ? '已收藏' : '已取消收藏');
});

$('#themeBtn').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  chrome.storage.local.set({ theme: next });
});

// 侧边栏已经开着时，用户再点工具栏图标：background 会写入 pendingScan，面板必须响应。
// 否则用户点了图标却什么都没发生 —— 面板只在打开那一刻读一次 pendingScan。
chrome.storage.session.onChanged.addListener(async (changes) => {
  const p = changes.pendingScan && changes.pendingScan.newValue;
  if (!p || Date.now() - p.at > 15000) return;
  try { await chrome.storage.session.remove('pendingScan'); } catch { /* 忽略 */ }
  // 以当前活动标签页为准，而不是打开面板时记下的那个
  const tab = await currentTab();
  if (tab && tab.id != null) state.tabId = tab.id;
  await doScan($('#deepToggle').checked);
});

(async () => {
  const { theme } = await chrome.storage.local.get('theme');
  if (theme) document.documentElement.setAttribute('data-theme', theme);
  await init();
})();
