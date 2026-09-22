// 配置、日志、收录结果、去重索引的持久化。chrome.* 只在函数内使用。
import { DIST } from '../config.js';

const K = {
  settings: 'vh.settings',
  state: 'vh.state',
  collected: 'vh.collected',
  logs: 'vh.logs',
  done: 'vh.done',
  counter: 'vh.counter',
};

export const DEFAULT_SETTINGS = {
  // 运行环境
  tabMode: 'background',        // background=后台标签页；window=小窗渲染（更可靠但会弹窗）
  pageTimeoutMs: 45000,
  renderDelayMs: 2500,
  clickMode: 'dom',             // 预留：native 需要额外权限

  // 收录
  scrolls: 5,
  scrollDelayMs: 1800,
  maxItemsPerRun: 100,
  deepCollect: false,           // 是否逐条打开详情页抓数据（慢）

  // 互动风控
  dryRun: true,                 // 默认只演练不真点，必须手动关掉
  likeGapMs: [8000, 20000],
  commentGapMs: [20000, 45000],
  dailyLimit: 200,
  maxConsecutiveFailures: 5,
  skipAlreadyDone: true,

  // 评论
  commentTemplate: '这个内容很有参考价值，学到了，感谢分享～',

  // —— 全自动：梗概 → 评论采集 → AI 生成评论 → 发布 ——
  llm: {
    provider: 'openai-compatible',
    baseURL: DIST.defaultApiBase,
    apiKey: '',
    model: DIST.defaultModel,
    temperature: 0.85,
    maxTokens: 2000,
    timeoutMs: 120000,
  },
  auto: {
    doLike: true,             // 固定流程第 3 步：点赞
    doComment: true,          // 固定流程第 4 步：评论
    maxPerRun: 3,             // 每次运行最多处理几条作品
    autoCollectFirst: true,   // 只给关键词时，先自动收录再评论
    commentSampleCount: 20,   // 采集多少条评论喂给模型
    commentScrolls: 6,        // 评论区滚动次数
    commentScrollDelayMs: 1200,
    draftCount: 3,            // 让模型生成几条候选
    draftStrategy: 'first',   // first | random
    persona: '普通用户 / 潜在买家',
    intent: '表达对作品的兴趣，用「自己也买过/用过类似的」这种同好口吻，含蓄地引出购买或获取渠道；不要直接问价，不要留联系方式',
    extraRules: '',
    minLen: 8,
    maxLen: 45,
    similarityThreshold: 0.6,
    bannedWords: '链接,私信,微信,加我,购买,淘宝,拼多多,优惠,代购,便宜出,要的私,同款出',
    useFallback: true,        // 模型草稿全被否掉时，是否用兜底文案（会标注）
    commentOnNoSummary: false, // 没生成出梗概时是否仍然评论
  },


  // 平台开关
  enabledPlatforms: { douyin: true, xhs: true, wxSph: true },

  // 选择器覆盖（控制台里可改，或用拾取器写入）
  selectorOverrides: { douyin: {}, xhs: {}, wxSph: {} },
};

/** 过滤掉 undefined，避免「显式传 undefined」把默认值覆盖成空 */
function definedOnly(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function mergeSettings(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  return {
    ...DEFAULT_SETTINGS,
    ...definedOnly(s),
    llm: { ...DEFAULT_SETTINGS.llm, ...definedOnly(s.llm) },
    auto: { ...DEFAULT_SETTINGS.auto, ...definedOnly(s.auto) },
    likeGapMs: Array.isArray(s.likeGapMs) && s.likeGapMs.length === 2 ? s.likeGapMs : DEFAULT_SETTINGS.likeGapMs,
    commentGapMs: Array.isArray(s.commentGapMs) && s.commentGapMs.length === 2 ? s.commentGapMs : DEFAULT_SETTINGS.commentGapMs,
    enabledPlatforms: { ...DEFAULT_SETTINGS.enabledPlatforms, ...definedOnly(s.enabledPlatforms) },
    selectorOverrides: {
      douyin: { ...(s.selectorOverrides?.douyin || {}) },
      xhs: { ...(s.selectorOverrides?.xhs || {}) },
      wxSph: { ...(s.selectorOverrides?.wxSph || {}) },
    },
  };
}

export async function getSettings() {
  const bag = await chrome.storage.local.get(K.settings);
  return mergeSettings(bag[K.settings]);
}

/**
 * 归一化选择器覆盖表：过滤掉空数组，保证结构完整。
 * 注意语义——**传了 selectorOverrides 就是整体替换**，不传则保持原样。
 * 因为「删除某个键」无法用深合并表达（合并永远保留旧键），复位功能会失效。
 * 需要只改一个键的调用方（SAVE_SELECTOR）请自己先算出完整表再传。
 */
function normalizeOverrides(ov) {
  const out = { douyin: {}, xhs: {}, wxSph: {} };
  for (const key of Object.keys(out)) {
    const src = ov?.[key] || {};
    for (const [k, v] of Object.entries(src)) {
      const list = (Array.isArray(v) ? v : [v]).map((s) => String(s || '').trim()).filter(Boolean);
      if (list.length) out[key][k] = list;
    }
  }
  return out;
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = mergeSettings({
    ...cur,
    ...patch,
    llm: { ...cur.llm, ...(patch.llm || {}) },
    auto: { ...cur.auto, ...(patch.auto || {}) },
    enabledPlatforms: { ...cur.enabledPlatforms, ...(patch.enabledPlatforms || {}) },
    selectorOverrides: patch.selectorOverrides
      ? normalizeOverrides(patch.selectorOverrides)
      : cur.selectorOverrides,
  });
  await chrome.storage.local.set({ [K.settings]: next });
  return next;
}

export async function patchSelectors(platformKey, key, selectors) {
  const cur = await getSettings();
  const overrides = { ...cur.selectorOverrides, [platformKey]: { ...cur.selectorOverrides[platformKey], [key]: selectors } };
  return saveSettings({ selectorOverrides: overrides });
}

export async function getState() {
  const bag = await chrome.storage.local.get(K.state);
  return { running: false, kind: '', progress: '', stopRequested: false, paused: false, ...(bag[K.state] || {}) };
}

export async function setState(patch) {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.local.set({ [K.state]: next });
  return next;
}

// ---- 收录结果 ----
export async function getCollected() {
  const bag = await chrome.storage.local.get(K.collected);
  return bag[K.collected] || { items: [], updatedAt: '', history: [] };
}

export async function setCollected(items, meta = {}) {
  const cur = await getCollected();
  const entry = {
    id: `col_${Date.now().toString(36)}`,
    at: new Date().toISOString(),
    count: items.length,
    kind: meta.kind || '',
    platforms: Array.from(new Set(items.map((i) => i.platform))),
  };
  const next = {
    items,
    updatedAt: entry.at,
    history: [entry, ...(cur.history || [])].slice(0, 30),
  };
  await chrome.storage.local.set({ [K.collected]: next });
  return next;
}

export async function appendCollected(items) {
  const cur = await getCollected();
  const merged = [...cur.items, ...items];
  const seen = new Set();
  const dedup = merged.filter((i) => {
    const k = `${i.platform}:${i.workId || i.url}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return setCollected(dedup, { kind: 'append' });
}

// ---- 运行日志（固定流程每次执行写一条）----
export async function getLogs() {
  const bag = await chrome.storage.local.get(K.logs);
  return Array.isArray(bag[K.logs]) ? bag[K.logs] : [];
}

export async function appendLog(log) {
  const list = await getLogs();
  const next = [log, ...list].slice(0, 1000);
  await chrome.storage.local.set({ [K.logs]: next });
  return next;
}

export async function clearLogs() {
  await chrome.storage.local.set({ [K.logs]: [], [K.done]: {} });
}

// ---- 去重索引：platform:workId:action ----
export async function getDone() {
  const bag = await chrome.storage.local.get(K.done);
  return bag[K.done] && typeof bag[K.done] === 'object' ? bag[K.done] : {};
}

export async function markDone(key, info = {}) {
  const done = await getDone();
  done[key] = { at: Date.now(), ...info };
  const keys = Object.keys(done);
  if (keys.length > 5000) {
    keys.sort((a, b) => (done[a].at || 0) - (done[b].at || 0));
    for (const k of keys.slice(0, keys.length - 5000)) delete done[k];
  }
  await chrome.storage.local.set({ [K.done]: done });
}

// ---- 每日计数（风控） ----
export async function bumpDaily(n = 1) {
  const today = new Date().toISOString().slice(0, 10);
  const bag = await chrome.storage.local.get(K.counter);
  const cur = bag[K.counter] && bag[K.counter].date === today ? bag[K.counter] : { date: today, count: 0 };
  cur.count += n;
  await chrome.storage.local.set({ [K.counter]: cur });
  return cur;
}

export async function getDaily() {
  const today = new Date().toISOString().slice(0, 10);
  const bag = await chrome.storage.local.get(K.counter);
  return bag[K.counter] && bag[K.counter].date === today ? bag[K.counter] : { date: today, count: 0 };
}
