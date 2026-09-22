import { DIST } from '../src/config.js';
import { probeVerdict, selectorDot, selectorNote, SELECTOR_KEYS, SELECTOR_KIND } from '../src/lib/probe.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

/** 必须与 src/sw.js 里的 PROTOCOL 保持一致 */
const EXPECT_PROTOCOL = 3;

let S = null;
let calTabId = null;
let pickTimer = null;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = (t) => (t ? new Date(t).toLocaleString('zh-CN') : '');
const dv = (v, dflt) => (v === undefined || v === null ? dflt : v);

/** 兜底默认值，与 src/lib/store.js 的 DEFAULT_SETTINGS 一致 */
const FALLBACK = {
  persona: '普通用户 / 潜在买家',
  intent: '表达对作品的兴趣，用「自己也买过/用过类似的」这种同好口吻，含蓄地引出购买或获取渠道；不要直接问价，不要留联系方式',
  bannedWords: '链接,私信,微信,加我,购买,淘宝,拼多多,优惠,代购,便宜出,要的私,同款出',
  llmBaseURL: DIST.defaultApiBase,
  llmModel: DIST.defaultModel,
};

/** 邀请链接：只在 src/config.js 里填了才显示，留空则界面里不出现任何服务商名字 */
function renderInvite() {
  const box = $('inviteBox');
  if (!box) return;
  const url = String(DIST.inviteUrl || '').trim();
  if (!url) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(DIST.inviteText || '点这里获取')}</a>`
    + (DIST.inviteNote ? `<div class="note">${esc(DIST.inviteNote)}</div>` : '');
}

function setStatus(text, kind = '') {
  const el = $('statusbar');
  if (!el) return;
  el.textContent = text;
  el.className = `statusbar ${kind}`;
}

/* ---------------- 全局兜底：宁可报错，也不要静默空白 ---------------- */
function reportFatal(where, err) {
  const msg = err?.message || String(err || '未知错误');
  let hint = '';
  if (/Receiving end does not exist|Could not establish connection|message port closed/i.test(msg)) {
    hint = '　→ 到 chrome://extensions 点本插件的「重新加载」，再刷新本页。';
  } else if (/未知消息类型|Unknown message type/i.test(msg)) {
    hint = '　→ 插件是旧版本：到 chrome://extensions 点「重新加载」更新。';
  }
  setStatus(`${where}失败：${msg}${hint}`, 'err');
  const sb = $('statusbar');
  if (sb) sb.title = err?.stack || msg;
  console.error(`[控制台] ${where}失败：`, err);
}

window.addEventListener('error', (e) => reportFatal('页面出错', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => reportFatal('通信', e.reason));

/** 面板开关：展开状态决定右上角按钮是灰底还是透明底 */
let modelPanelTouched = false;

function syncCornerButtons() {
  const m = $('panelModel');
  const a = $('panelAdv');
  const bm = $('btnModelPanel');
  const ba = $('btnAdvPanel');
  if (bm && m) bm.classList.toggle('active', !m.classList.contains('hidden'));
  if (ba && a) ba.classList.toggle('active', !a.classList.contains('hidden'));
}

function setPanel(id, show) {
  const el = $(id);
  if (!el) return;
  el.classList.toggle('hidden', !show);
  syncCornerButtons();
}

function togglePanel(id) {
  const el = $(id);
  if (!el) return;
  const willShow = el.classList.contains('hidden');
  setPanel(id, willShow);
  if (willShow) el.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
}

/** 进度条就显示在「开始」按钮下面，用户点完不用去别处找 */
function showProgress(text, kind = '') {
  const box = $('flowOut');
  if (!box) return;
  box.classList.remove('hidden', 'done', 'err');
  if (kind) box.classList.add(kind);
  box.textContent = text;
}

function hideProgress() {
  const box = $('flowOut');
  if (box) { box.classList.add('hidden'); box.textContent = ''; }
}

/* ---------------- 加载 ---------------- */
async function load() {
  let res;
  try {
    res = await send({ type: 'GET_STATUS' });
  } catch (e) {
    reportFatal('读取状态', e);
    return;
  }
  if (!res?.ok) {
    reportFatal('读取状态', new Error(res?.error || '插件没有返回状态'));
    return;
  }
  const versionSkew = res.protocol !== EXPECT_PROTOCOL;
  try {
    S = res;
    fillForm();
    renderInvite();
    renderLogs(res.logs || []);
    renderSelectorTable();
    updateQuickHint();
    updateRunningUi();
    // 第一次打开（还没配 Key）时，把大模型设置直接展开，省得用户到处找
    if (!modelPanelTouched) setPanel('panelModel', !res.settings?.llm?.apiKey);
    else syncCornerButtons();
  } catch (e) {
    reportFatal('渲染界面', e);
    return;
  }
  if (versionSkew) {
    setStatus(`插件代码是旧版本（需要 ${EXPECT_PROTOCOL}，实际 ${res.protocol ?? '未知'}）。请到 chrome://extensions 点「重新加载」，再刷新本页。`, 'err');
  }
}

function fillForm() {
  const s = S.settings || {};
  const a = s.auto || {};
  const llm = s.llm || {};
  const enabled = s.enabledPlatforms || {};
  const gaps = Array.isArray(s.commentGapMs) ? s.commentGapMs : [20000, 45000];

  $('llmProvider').value = dv(llm.provider, 'openai-compatible');
  $('llmBaseURL').value = dv(llm.baseURL, FALLBACK.llmBaseURL);
  $('llmApiKey').value = dv(llm.apiKey, '');
  $('llmModel').value = dv(llm.model, FALLBACK.llmModel);

  $('doLike').checked = a.doLike !== false;
  $('doComment').checked = a.doComment !== false;
  $('maxPerRun').value = dv(a.maxPerRun, 3);
  $('persona').value = dv(a.persona, FALLBACK.persona);
  $('intent').value = dv(a.intent, FALLBACK.intent);
  $('extraRules').value = dv(a.extraRules, '');
  $('minLen').value = dv(a.minLen, 8);
  $('maxLen').value = dv(a.maxLen, 45);
  $('draftCount').value = dv(a.draftCount, 3);
  $('commentSampleCount').value = dv(a.commentSampleCount, 20);
  $('bannedWords').value = dv(a.bannedWords, FALLBACK.bannedWords);

  $('commentGapMin').value = Math.round(gaps[0] / 1000);
  $('commentGapMax').value = Math.round(gaps[1] / 1000);
  $('dailyLimit').value = dv(s.dailyLimit, 200);
  $('maxConsecutiveFailures').value = dv(s.maxConsecutiveFailures, 5);
  $('tabMode').value = dv(s.tabMode, 'background');
  $('renderDelayMs').value = dv(s.renderDelayMs, 2500);
  $('skipAlreadyDone').checked = s.skipAlreadyDone !== false;
  $('enDouyin').checked = enabled.douyin !== false;
  $('enXhs').checked = enabled.xhs !== false;

  if ($('quickDryRun')) $('quickDryRun').checked = s.dryRun !== false;
}

function num(id, dflt, lo, hi) {
  const n = Number($(id).value);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

function collectForm() {
  const s = S?.settings || {};
  return {
    dryRun: $('quickDryRun') ? $('quickDryRun').checked : true,
    dailyLimit: num('dailyLimit', 200, 1, 2000),
    maxConsecutiveFailures: num('maxConsecutiveFailures', 5, 1, 50),
    tabMode: $('tabMode').value,
    renderDelayMs: num('renderDelayMs', 2500, 500, 15000),
    pageTimeoutMs: dv(s.pageTimeoutMs, 45000),
    skipAlreadyDone: $('skipAlreadyDone').checked,
    enabledPlatforms: { douyin: $('enDouyin').checked, xhs: $('enXhs').checked, wxSph: false },
    commentGapMs: [num('commentGapMin', 20, 5, 900) * 1000, num('commentGapMax', 45, 5, 1800) * 1000],
    likeGapMs: Array.isArray(s.likeGapMs) ? s.likeGapMs : [8000, 20000],
    scrolls: dv(s.scrolls, 5),
    maxItemsPerRun: dv(s.maxItemsPerRun, 100),
    deepCollect: false,
    llm: {
      provider: $('llmProvider').value,
      baseURL: $('llmBaseURL').value.trim(),
      apiKey: $('llmApiKey').value.trim(),
      model: $('llmModel').value.trim(),
      temperature: dv(s.llm?.temperature, 0.85),
      maxTokens: dv(s.llm?.maxTokens, 2000),
      timeoutMs: dv(s.llm?.timeoutMs, 120000),
    },
    auto: {
      doLike: $('doLike').checked,
      doComment: $('doComment').checked,
      maxPerRun: num('maxPerRun', 3, 1, 50),
      commentSampleCount: num('commentSampleCount', 20, 0, 80),
      commentScrolls: dv(s.auto?.commentScrolls, 6),
      commentScrollDelayMs: dv(s.auto?.commentScrollDelayMs, 1200),
      draftCount: num('draftCount', 3, 1, 8),
      draftStrategy: dv(s.auto?.draftStrategy, 'first'),
      persona: $('persona').value.trim(),
      intent: $('intent').value.trim(),
      extraRules: $('extraRules').value,
      minLen: num('minLen', 8, 2, 60),
      maxLen: num('maxLen', 45, 8, 200),
      similarityThreshold: dv(s.auto?.similarityThreshold, 0.6),
      bannedWords: $('bannedWords').value,
      useFallback: s.auto?.useFallback !== false,
      commentOnNoSummary: false,
    },
  };
}

async function saveSettings(where) {
  const res = await send({ type: 'SAVE_SETTINGS', settings: collectForm() });
  if (res?.ok) {
    S.settings = res.settings;
    const box = $(where);
    if (box) box.innerHTML = '<p class="ok-text">已保存</p>';
    setStatus('已保存', 'ok');
    return true;
  }
  setStatus(`保存失败：${res?.error || '未知错误'}`, 'err');
  return false;
}

/* ---------------- 运行日志 ---------------- */
function statusBadge(status) {
  const map = {
    ok: ['ok', '成功'], partial: ['warn', '部分成功'], failed: ['fail', '失败'],
    'dry-run': ['dry', '试跑'], skipped: ['skip', '跳过'],
  };
  const [cls, label] = map[status] || ['skip', status || '未知'];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function renderLogs(logs) {
  $('logMeta').textContent = logs.length
    ? `${S?.logCount ?? logs.length} 条，显示最近 ${logs.length} 条`
    : '还没有记录';

  const t = $('logTable');
  if (!logs.length) {
    t.innerHTML = '<tbody><tr><td class="muted">还没有记录。在上面粘贴一个视频链接，点「开始」。</td></tr></tbody>';
    return;
  }

  // 固定列宽，避免数字列被挤成竖排文字
  const cols = `
    <colgroup>
      <col style="width:132px"><col style="width:190px"><col style="width:150px">
      <col style="width:62px"><col style="width:62px"><col style="width:62px">
      <col style="width:150px"><col style="width:210px"><col style="width:170px">
    </colgroup>`;

  t.innerHTML = cols + `<thead><tr>
    <th class="nowrap">时间</th>
    <th>视频标题</th>
    <th>视频链接</th>
    <th class="nowrap num">点赞数</th>
    <th class="nowrap num">评论数</th>
    <th class="nowrap num">收藏数</th>
    <th>评论区关注点</th>
    <th>评论内容</th>
    <th class="nowrap">执行结果</th>
  </tr></thead><tbody>` + logs.map((l) => {
    const link = (l.url || '').replace(/^https?:\/\//, '');
    const numCell = (v) => (v === null || v === undefined || v === '' ? '<span class="muted">—</span>' : String(v));
    return `<tr>
    <td class="mono nowrap">${esc(l.at ? new Date(l.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '')}</td>
    <td class="clamp" title="${esc(l.title || '')}">${esc(l.title || '')}</td>
    <td class="clamp" title="${esc(l.url || '')}"><a href="${esc(l.url || '#')}" target="_blank" rel="noreferrer">${esc(link)}</a></td>
    <td class="num">${numCell(l.likeCount)}</td>
    <td class="num">${numCell(l.commentCount)}</td>
    <td class="num">${numCell(l.favoriteCount)}</td>
    <td class="clamp" title="${esc(l.commentFocus || '')}">${esc(l.commentFocus || '') || '<span class="muted">—</span>'}</td>
    <td class="clamp" title="${esc(l.comment || '')}">${esc(l.comment || '') || '<span class="muted">—</span>'}</td>
    <td class="nowrap">${statusBadge(l.status)} <span class="resulttext">${esc(l.result || '')}</span>
        ${l.message ? `<div class="muted clamp2" title="${esc(l.message)}">${esc(l.message)}</div>` : ''}</td>
  </tr>`;
  }).join('') + '</tbody>';

  applyRowMode();
}

/** 展开/收起：长文本默认截断成一行，点按钮看全文 */
let rowsExpanded = false;
function applyRowMode() {
  const t = $('logTable');
  if (t) t.classList.toggle('expanded', rowsExpanded);
  const btn = $('btnToggleRows');
  if (btn) btn.textContent = rowsExpanded ? '收起' : '展开全部';
}

function updateRunningUi() {
  const running = !!S?.state?.running;
  $('btnStop').disabled = !running;
  $('btnQuickRun').disabled = running;
  $('btnQuickRun').textContent = running ? '处理中…' : '开始';
  if (running) {
    setStatus('正在处理');
  } else if (S?.state?.lastSummary) {
    const x = S.state.lastSummary;
    setStatus(`就绪 · 上次：成功 ${x.ok} / 部分 ${x.partial} / 失败 ${x.failed}`, x.aborted ? 'err' : '');
  } else {
    setStatus('就绪');
  }
}

/* ---------------- 主流程 ---------------- */
function parseQuickInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const urls = text.match(/https?:\/\/[^\s"'<>()，。；、！？【】]+/g) || [];
  return urls.length ? { links: text, keywords: '' } : { links: '', keywords: text };
}

function updateQuickHint() {
  const el = $('quickHint');
  if (!el) return;
  const a = S?.settings?.auto || {};
  const needKey = a.doComment !== false && !S?.settings?.llm?.apiKey;
  if (needKey) {
    el.innerHTML = '<span class="err-text">还差一步：点右上角「大模型设置」，把 API Key 填进去（只填一次）</span>';
    return;
  }
  const input = parseQuickInput($('quickInput').value);
  const dry = $('quickDryRun')?.checked;
  if (!input) {
    el.innerHTML = `<span class="muted">粘贴视频链接即可。当前：${dry ? '试跑（只生成不执行）' : '⚠ 真实执行'}</span>`;
    return;
  }
  if (input.links) {
    const n = (input.links.match(/https?:\/\//g) || []).length;
    el.textContent = `将处理 ${n} 个视频${dry ? '（试跑，不会真的点赞评论）' : '（⚠ 会真的点赞和评论）'}`;
  } else {
    el.textContent = `关键词「${input.keywords}」→ 先搜索视频，再处理${dry ? '（试跑）' : '（⚠ 真实执行）'}`;
  }
}

async function runFlow() {
  const a = S?.settings?.auto || {};

  if (a.doComment !== false && !S?.settings?.llm?.apiKey) {
    setStatus('还差一步：点右上角「大模型设置」填 API Key', 'err');
    modelPanelTouched = true;
    setPanel('panelModel', true);
    $('panelModel').scrollIntoView?.({ block: 'start' });
    return;
  }

  const input = parseQuickInput($('quickInput').value);
  if (!input) {
    const msg = '先把视频链接粘到上面的框里';
    setStatus(msg, 'err');
    $('flowOut').innerHTML = `<div class="planout"><b class="err-text">无法开始</b><div>${esc(msg)}</div></div>`;
    $('quickInput').focus?.();
    return;
  }

  const dry = $('quickDryRun').checked;
  const storedDry = S.settings?.dryRun !== false;
  if (storedDry !== dry) {
    await send({ type: 'SAVE_SETTINGS', settings: { dryRun: dry } });
  }
  if (!dry) {
    const yes = confirm('这次会真的去点赞和评论。\n\n建议第一次先只处理 1–3 个视频。确定继续吗？');
    if (!yes) return;
  }
  if (!(await saveSettings())) return;

  $('flowOut').classList.remove('hidden');
  showProgress('正在启动…');
  const res = await send({ type: 'RUN_FLOW', input });
  if (!res?.ok) {
    setStatus(`无法开始：${res?.error}`, 'err');
    showProgress(`无法开始：${res?.error || '未知错误'}`, 'err');
    return;
  }
  setStatus('正在处理');
  startPolling();
}

let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    let res;
    try { res = await send({ type: 'GET_STATUS' }); } catch { return; }
    if (!res?.ok) return;
    S = res;
    updateRunningUi();
    if (!res.state.running) {
      clearInterval(pollTimer); pollTimer = null;
      await load();
    }
  }, 1500);
}

/* ---------------- 导出 ---------------- */
async function download(payload) {
  const blob = new Blob([payload.content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename: payload.fileName, saveAs: false });
    setStatus(`已导出 ${payload.fileName}`, 'ok');
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }
}

async function exportLogs(format) {
  const res = await send({ type: 'BUILD_EXPORT', what: 'logs', format, summary: S.state?.lastSummary });
  if (!res?.ok) { setStatus(`导出失败：${res?.error}`, 'err'); return; }
  await download(res);
}

/* ---------------- 大模型设置 ---------------- */
function applyImport() {
  const raw = $('quickImport').value.trim();
  const out = $('importOut');
  if (!raw) { out.innerHTML = '<span class="err-text">请先粘贴内容</span>'; return; }
  let key = '', url = '';
  try {
    if (raw.startsWith('{')) {
      const j = JSON.parse(raw);
      key = j.key || j.apiKey || j.api_key || '';
      url = j.url || j.baseURL || j.base_url || j.host || j.endpoint || '';
    } else if (/^https?:\/\//i.test(raw)) url = raw;
    else key = raw;
  } catch (e) {
    out.innerHTML = `<span class="err-text">解析失败：${esc(e.message)}</span>`;
    return;
  }
  if (url) {
    try {
      const u = new URL(url);
      let path = u.pathname.replace(/\/+$/, '');
      if (!path) path = '/v1';
      $('llmBaseURL').value = u.origin + path;
    } catch { out.innerHTML = '<span class="err-text">服务地址不合法</span>'; return; }
  }
  if (key) $('llmApiKey').value = key;
  out.innerHTML = `<span class="ok-text">已填入 —— 点下面「保存」</span>`;
  if (key) listModels();
}

async function listModels() {
  if (!(await saveSettings('importOut'))) return;
  $('llmTestOut').innerHTML = '<span class="err-text">正在获取模型列表…</span>';
  const res = await send({ type: 'LIST_MODELS' });
  if (!res?.ok) {
    $('llmTestOut').innerHTML = `<span class="err-text">获取失败：${esc(res?.error || '未知错误')}</span>`;
    return;
  }
  $('modelOptions').innerHTML = (res.models || []).map((m) => `<option value="${esc(m)}"></option>`).join('');
  if (res.models?.length === 1) $('llmModel').value = res.models[0];
  $('llmTestOut').innerHTML = res.models?.length
    ? `<span class="ok-text">可用模型：${esc(res.models.join('、'))}${res.models.length === 1 ? '（已自动填入）' : ''}</span>`
    : '<span class="err-text">没有拿到模型列表</span>';
}

async function testLLMConn() {
  if (!(await saveSettings('importOut'))) return;
  $('llmTestOut').innerHTML = '<span class="err-text">正在测试…</span>';
  const res = await send({ type: 'TEST_LLM' });
  $('llmTestOut').innerHTML = res?.ok
    ? `<span class="ok-text">连接成功（${res.ms}ms）</span>`
    : `<span class="err-text">连接失败：${esc(res?.error || '未知错误')}</span>`;
}

/* ---------------- 元素校准（藏在高级里） ---------------- */
let lastProbe = null;
const calPlatform = () => $('calPlatform').value;
const overrideFor = (p, k) => S.settings.selectorOverrides?.[p]?.[k] || [];

function renderSelectorTable() {
  if (!S) return;
  const platform = calPlatform();
  const probeMap = {};
  if (lastProbe?.fields) for (const f of lastProbe.fields) probeMap[f.key] = f;

  const overridden = Object.keys(S.settings.selectorOverrides?.[platform] || {});
  const allKeys = Array.from(new Set([...SELECTOR_KEYS, ...overridden]));

  $('pickKey').innerHTML = allKeys.map((k) => {
    const suffix = SELECTOR_KIND[k] === 'listOnly' ? '（仅列表页）' : '';
    return `<option value="${k}">${k}${suffix}</option>`;
  }).join('');

  const t = $('selectorTable');
  t.innerHTML = `<thead><tr><th>项目</th><th style="width:96px">检测</th><th>自定义</th><th style="width:120px">操作</th></tr></thead><tbody>` +
    allKeys.map((k) => {
      const ov = overrideFor(platform, k);
      const p = probeMap[k];
      let dot = '<span class="dot">·</span>';
      let note = '';
      if (p) {
        const cls = selectorDot(k, p.hit);
        dot = `<span class="dot${cls === 'ok' ? ' ok' : cls === 'bad' ? ' bad' : cls === 'meh' ? ' meh' : ''}"></span>`;
        note = selectorNote(k, p.hit);
      }
      return `<tr>
        <td class="mono">${k}</td>
        <td>${dot}${note ? `<span class="muted" style="font-size:11.5px"> ${esc(note)}</span>` : ''}</td>
        <td><input class="selinput mono" data-key="${k}" value="${esc(ov[0] || '')}" placeholder="留空用默认"></td>
        <td><button class="small btn-save-sel" data-key="${k}">保存</button>
            <button class="small btn-reset-sel" data-key="${k}">复位</button></td>
      </tr>`;
    }).join('') + '</tbody>';

  t.querySelectorAll('.btn-save-sel').forEach((b) => b.addEventListener('click', async () => {
    const key = b.dataset.key;
    const val = t.querySelector(`.selinput[data-key="${key}"]`).value.trim();
    if (!val) { setStatus('请先填写或拾取', 'err'); return; }
    const res = await send({ type: 'SAVE_SELECTOR', platform, key, selector: val });
    if (res?.ok) { setStatus(`已保存 ${key}`, 'ok'); await load(); }
  }));
  t.querySelectorAll('.btn-reset-sel').forEach((b) => b.addEventListener('click', async () => {
    const res = await send({ type: 'RESET_SELECTOR', platform, key: b.dataset.key });
    if (res?.ok) { setStatus('已恢复默认', 'ok'); await load(); }
  }));
}

async function openCalPage() {
  const url = $('calUrl').value.trim();
  if (!/^https?:\/\//i.test(url)) { setStatus('请填一个视频页地址', 'err'); return; }
  const res = await send({ type: 'OPEN_PAGE', url });
  if (!res?.ok) { setStatus(`打开失败：${res?.error}`, 'err'); return; }
  calTabId = res.tabId;
  $('calTabInfo').textContent = '已打开';
  setStatus('页面已打开，可以点「自检当前页」', 'ok');
}

async function probeCurrent() {
  // 不给 tabId：让后台自动找你**已经开着**的该平台标签页
  // （配合 F12 设备模拟时，用你调好的那个页面）
  $('probeOut').innerHTML = '<p class="muted">检测中…</p>';
  const res = await send({ type: 'PROBE', platform: calPlatform(), tabId: calTabId || undefined });
  if (!res?.ok) {
    $('probeOut').innerHTML = `<p class="err-text">检测失败：${esc(res?.error)}</p>`;
    return;
  }
  lastProbe = res.probe;
  const v = probeVerdict(res.probe);

  $('probeOut').innerHTML = `<div class="planout">
    ${res.usedExisting ? '<div class="muted">用的是你已经打开的那个页面</div>' : ''}
    <div class="verdict ${esc(v.level)}"><b>${esc(v.title)}</b>${v.detail ? `<div class="muted" style="margin-top:4px;white-space:pre-line">${esc(v.detail)}</div>` : ''}</div>
    ${v.level !== 'ok' && v.missing?.length ? `<div style="margin-top:8px">需要修的：${v.missing.map((m) => `<code>${esc(m)}</code>`).join(' ')}</div>` : ''}
  </div>`;

  // 自动把「要修哪个」切到第一个缺失项，省得用户自己找
  if (v.missing?.length) {
    const pick = $('pickKey');
    if (pick) pick.value = v.missing[0];
  }
  renderSelectorTable();
}

async function startPick() {
  if (!calTabId) { setStatus('请先点「打开页面」', 'err'); return; }
  const key = $('pickKey').value;
  const res = await send({ type: 'PICK_START', tabId: calTabId });
  if (!res?.ok) { setStatus(`无法开始拾取：${res?.error}`, 'err'); return; }
  $('pickInfo').innerHTML = `已开启：切到那个页面，点你要作为 <code>${esc(key)}</code> 的元素`;
  if (pickTimer) clearInterval(pickTimer);
  pickTimer = setInterval(async () => {
    const r = await send({ type: 'PICK_GET', tabId: calTabId });
    if (!r?.ok || !r.picked?.selector) return;
    clearInterval(pickTimer); pickTimer = null;
    const input = document.querySelector(`.selinput[data-key="${key}"]`);
    if (input) input.value = r.picked.selector;
    $('pickInfo').innerHTML = `已拾取：<code>${esc(r.picked.selector)}</code> —— 点该行「保存」生效`;
    setStatus('已拾取，记得点保存', 'ok');
  }, 800);
}

/* ---------------- 事件 ---------------- */
$('btnModelPanel').addEventListener('click', () => { modelPanelTouched = true; togglePanel('panelModel'); });
$('btnAdvPanel').addEventListener('click', () => { modelPanelTouched = true; togglePanel('panelAdv'); });
$('btnSaveModel').addEventListener('click', () => saveSettings('importOut'));
$('btnSaveAdv').addEventListener('click', () => saveSettings('saveOut'));

$('btnQuickRun').addEventListener('click', runFlow);
$('quickInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') runFlow(); });
$('quickInput').addEventListener('input', updateQuickHint);
$('quickDryRun').addEventListener('change', updateQuickHint);
$('btnStop').addEventListener('click', async () => {
  await send({ type: 'STOP' });
  setStatus('正在停止，会在当前这个视频结束后停下…', 'busy');
});

$('btnExportCsv').addEventListener('click', () => exportLogs('csv'));
$('btnExportMd').addEventListener('click', () => exportLogs('markdown'));
$('btnExportJson').addEventListener('click', () => exportLogs('json'));
$('btnToggleRows').addEventListener('click', () => {
  rowsExpanded = !rowsExpanded;
  applyRowMode();
});
$('btnClearLogs').addEventListener('click', async () => {
  if (!confirm('清空全部日志？')) return;
  await send({ type: 'CLEAR_LOGS' });
  await load();
});

$('btnImport').addEventListener('click', applyImport);
$('quickImport').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyImport(); });
$('btnListModels').addEventListener('click', listModels);
$('btnTestLLM').addEventListener('click', testLLMConn);
$('btnToggleKey').addEventListener('click', () => {
  const input = $('llmApiKey');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('btnToggleKey').textContent = show ? '隐藏' : '显示';
});

$('btnOpenCal').addEventListener('click', openCalPage);
$('btnProbe').addEventListener('click', probeCurrent);
$('btnCloseCal').addEventListener('click', async () => {
  if (calTabId) await send({ type: 'CLOSE_TAB', tabId: calTabId });
  calTabId = null; lastProbe = null;
  $('calTabInfo').textContent = '';
  $('probeOut').innerHTML = '';
});
$('btnPickStart').addEventListener('click', startPick);
$('btnResetSelectors').addEventListener('click', async () => {
  if (!confirm(`把 ${calPlatform()} 的自定义元素设置清空（恢复默认）？`)) return;
  const ov = S.settings.selectorOverrides;
  ov[calPlatform()] = {};
  await send({ type: 'SAVE_SETTINGS', settings: { selectorOverrides: ov } });
  setStatus('已恢复默认', 'ok');
  await load();
});
$('calPlatform').addEventListener('change', () => { lastProbe = null; $('probeOut').innerHTML = ''; renderSelectorTable(); });

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'VH_PROGRESS') {
    // 详细进度只写在开始按钮下面那块，顶部状态栏不再刷屏
    showProgress(msg.progress || '处理中…', msg.error ? 'err' : '');
  }
  if (msg?.type === 'VH_DONE') {
    if (msg.error) {
      setStatus(`处理失败：${msg.error}`, 'err');
      showProgress(`处理失败：${msg.error}`, 'err');
    } else if (msg.kind === 'flow' && msg.summary) {
      const s = msg.summary;
      setStatus(`完成：成功 ${s.ok} / 部分 ${s.partial} / 失败 ${s.failed}`, s.aborted ? 'err' : 'ok');
      showProgress(
        `完成：成功 ${s.ok} 个，部分成功 ${s.partial} 个，失败 ${s.failed} 个`
        + (s.aborted ? `　（${s.abortReason}）` : '　结果见下面的日志')
        + (s.dryRun ? '　这是试跑，没有真的点赞评论' : ''),
        s.aborted ? 'err' : 'done'
      );
      if (msg.logs?.length) renderLogs(msg.logs);
    } else {
      setStatus('完成', 'ok');
      hideProgress();
    }
  }
});

load();
