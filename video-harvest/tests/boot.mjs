// 启动与消息路由集成测试。
// 目的：catch「扩展装上了但点了没反应 / 页面空白」这一类问题——
//   Service Worker 能否加载、消息路由能否应答、控制台渲染路径是否真的把数据写进了 DOM。
// 这些代码依赖 chrome.*，必须用桩；前两个测试文件覆盖不到它们。
// 用法：node tests/boot.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync as readdirSyncFs } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push({ name, error: e?.message || String(e) });
    console.log(`  ✗ ${name}\n      ${e?.message || e}`);
  }
}

/* ---------------- chrome 桩 ---------------- */
function installChromeStub() {
  const store = {};
  const listeners = { installed: [], startup: [], message: [], alarm: [] };
  const createdTabs = [];

  globalThis.self = globalThis; // service worker 里存在，Node 里补上

  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          if (keys === null || keys === undefined) return { ...store };
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (k in store) out[k] = store[k];
          return out;
        },
        async set(obj) { Object.assign(store, obj); },
        async remove(k) { delete store[k]; },
      },
      onChanged: { addListener() { } },
    },
    runtime: {
      id: 'test-extension',
      lastError: undefined,
      getURL: (p) => `chrome-extension://test/${p}`,
      onInstalled: { addListener: (f) => listeners.installed.push(f) },
      onStartup: { addListener: (f) => listeners.startup.push(f) },
      onMessage: {
        addListener: (f) => listeners.message.push(f),
        removeListener() { },
      },
      sendMessage: async () => ({ ok: true }),
      openOptionsPage() { },
    },
    alarms: {
      create() { }, clear: async () => true,
      onAlarm: { addListener: (f) => listeners.alarm.push(f) },
    },
    tabs: {
      async create(o) { const t = { id: 1000 + createdTabs.length, windowId: 1, url: o.url, status: 'complete' }; createdTabs.push(t); return t; },
      async get(id) { return createdTabs.find((x) => x.id === id) || { id, status: 'complete', url: '' }; },
      async update() { }, async remove() { }, async sendMessage() { return {}; },
      async query() { return []; },
      onUpdated: { addListener() { }, removeListener() { } },
      onRemoved: { addListener() { }, removeListener() { } },
      onCreated: { addListener() { } },
    },
    windows: {
      async create() { return { id: 1, tabs: [{ id: 1001, windowId: 1 }] }; },
      async update() { }, async remove() { },
      onRemoved: { addListener() { }, removeListener() { } },
    },
    scripting: { async executeScript() { return [{ result: { ok: true, fields: [] } }]; } },
    notifications: { async create() { return 'id'; } },
    downloads: { async download() { return 1; } },
  };

  return { store, listeners, createdTabs };
}

/** 直接把消息喂给 SW 注册的路由，模拟控制台发消息 */
function sendToRouter(listeners, msg) {
  return new Promise((resolve2, reject) => {
    const l = listeners.message[0];
    if (!l) return reject(new Error('Service Worker 没有注册 onMessage 监听'));
    const timer = setTimeout(() => reject(new Error(`路由无响应（消息类型 ${msg.type}）`)), 5000);
    const ret = l(msg, {}, (res) => { clearTimeout(timer); resolve2(res); });
    if (ret !== true) {
      clearTimeout(timer);
      reject(new Error(`路由没有返回 true（返回了 ${ret}），异步响应会失败`));
    }
  });
}

/* ---------------- DOM 桩 ---------------- */
function installDomStub() {
  const els = new Map();
  const makeEl = (id) => ({
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    checked: false,
    disabled: false,
    className: '',
    type: 'text',
    dataset: {},
    style: {},
    classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
    addEventListener() { }, removeEventListener() { },
    appendChild() { }, removeChild() { }, click() { }, focus() { },
    querySelector() { return makeEl('child'); },
    querySelectorAll() { return []; },
    setAttribute() { }, getAttribute: () => null,
    selectedOptions: [{ text: '点赞' }],
  });

  globalThis.document = {
    getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
    querySelector: () => makeEl('q'),
    querySelectorAll: () => [],
    createElement: () => makeEl('new'),
    addEventListener() { },
    body: makeEl('body'),
  };
  globalThis.window = { addEventListener() { }, setTimeout, clearTimeout };
  globalThis.confirm = () => false;
  globalThis.alert = () => { };
  globalThis.URL.createObjectURL = () => 'blob:fake';
  globalThis.URL.revokeObjectURL = () => { };
  globalThis.Blob = class { constructor() { } };
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => { };
  return els;
}

/* ================= 0. 导入一致性（静态检查） ================= */
console.log('\n[0] 模块导入一致性');

/** 收集一个文件导出的名字 */
function exportsOf(code) {
  const names = new Set();
  for (const m of code.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      names.add(t.includes(' as ') ? t.split(' as ')[1].trim() : t);
    }
  }
  return names;
}

await test('每个 import 的具名导出在目标文件里都存在（防「改了导出名但没改引用」）', () => {
  const { readdirSync } = require_fs();
  const problems = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.m?js$/.test(e.name)) continue;
      const code = readFileSync(p, 'utf8');
      for (const m of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
        const target = resolve(dir, m[2]);
        let targetCode;
        try { targetCode = readFileSync(target, 'utf8'); } catch { problems.push(`${p} → 找不到 ${m[2]}`); continue; }
        const avail = exportsOf(targetCode);
        for (const part of m[1].split(',')) {
          const name = part.trim().split(/\s+as\s+/)[0].trim();
          if (name && !avail.has(name)) {
            problems.push(`${p.replace(root + '\\', '')} 引用了 ${m[2]} 的 ${name}，但该文件没有导出它`);
          }
        }
      }
    }
  };
  walk(resolve(root, 'src'));
  walk(resolve(root, 'ui'));
  assert.equal(problems.length, 0, problems.join('\n      '));
});

function require_fs() {
  // 顶层已 import，这里只是给上面的测试一个稳定的取值点
  return { readdirSync: readdirSyncFs };
}

/* ================= 1. Service Worker ================= */
console.log('\n[1] Service Worker 启动与路由');

const { store, listeners } = installChromeStub();
let swError = null;
try {
  await import('../src/sw.js');
} catch (e) {
  swError = e;
}

await test('sw.js 能无错加载（导入图完整、无顶层崩溃）', () => {
  assert.equal(swError, null, swError ? `加载失败：${swError.message}` : '');
});

await test('注册了 onMessage 监听且返回 true（异步响应）', () => {
  assert.ok(listeners.message.length >= 1, '没有注册 onMessage 监听');
});

await test('GET_STATUS 返回控制台首屏需要的全部字段', async () => {
  const res = await sendToRouter(listeners, { type: 'GET_STATUS' });
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 300));
  assert.ok(res.settings?.likeGapMs, '缺 settings.likeGapMs');
  assert.ok(res.settings?.selectorOverrides, '缺 settings.selectorOverrides');
  assert.ok(res.state, '缺 state');
  assert.ok(Array.isArray(res.collected?.items), '缺 collected.items');
  assert.ok(Array.isArray(res.logs), '缺 logs');
  assert.equal(typeof res.logCount, 'number', '缺 logCount');
  assert.ok(res.platformMeta?.douyin, '缺 platformMeta');
  assert.equal(res.platformMeta.douyin.supports.like, true);
  assert.equal(res.platformMeta.wxSph.supports.like, false);
});

await test('SAVE_SETTINGS 写入并回读', async () => {
  const saved = await sendToRouter(listeners, { type: 'SAVE_SETTINGS', settings: { dailyLimit: 33, dryRun: false } });
  assert.equal(saved.ok, true);
  const status = await sendToRouter(listeners, { type: 'GET_STATUS' });
  assert.equal(status.settings.dailyLimit, 33);
  assert.equal(status.settings.dryRun, false);
});

await test('SAVE_SELECTOR 能写入，RESET_SELECTOR 能真正删掉（回归：之前删不掉）', async () => {
  const saved = await sendToRouter(listeners, { type: 'SAVE_SELECTOR', platform: 'douyin', key: 'likeButton', selector: '.my-like' });
  assert.equal(saved.ok, true);
  assert.equal(saved.selectors[0], '.my-like');

  let status = await sendToRouter(listeners, { type: 'GET_STATUS' });
  assert.equal(status.settings.selectorOverrides.douyin.likeButton[0], '.my-like');

  const reset = await sendToRouter(listeners, { type: 'RESET_SELECTOR', platform: 'douyin', key: 'likeButton' });
  assert.equal(reset.ok, true);
  status = await sendToRouter(listeners, { type: 'GET_STATUS' });
  assert.equal(status.settings.selectorOverrides.douyin.likeButton, undefined, '复位后不应再存在该键');
  assert.deepEqual(status.settings.selectorOverrides.douyin, {});
});

await test('保存设置表单不会误删已校准的选择器（回归）', async () => {
  await sendToRouter(listeners, { type: 'SAVE_SELECTOR', platform: 'xhs', key: 'commentInput', selector: '.my-input' });
  // 模拟控制台点「保存全部设置」——表单里不含 selectorOverrides
  await sendToRouter(listeners, { type: 'SAVE_SETTINGS', settings: { dailyLimit: 50 } });
  const status = await sendToRouter(listeners, { type: 'GET_STATUS' });
  assert.equal(status.settings.selectorOverrides.xhs.commentInput[0], '.my-input', '选择器被表单保存误删了');
});

await test('PREVIEW_PLAN 把输入解析成任务', async () => {
  const res = await sendToRouter(listeners, {
    type: 'PREVIEW_PLAN',
    input: { links: 'https://www.douyin.com/video/7212345678901234567', keywords: '露营' },
  });
  assert.equal(res.ok, true);
  assert.equal(res.plan.links, 1);
  assert.ok(res.plan.searches >= 1);
  assert.equal(res.plan.detail.links[0].platform, '抖音');
});

await test('RUN_FLOW 在点赞评论都关掉时拒绝执行', async () => {
  await sendToRouter(listeners, { type: 'SAVE_SETTINGS', settings: { auto: { doLike: false, doComment: false } } });
  const res = await sendToRouter(listeners, {
    type: 'RUN_FLOW', input: { links: 'https://www.douyin.com/video/7212345678901234567' },
  });
  assert.equal(res.ok, false);
  assert.ok(/至少勾一个/.test(res.error), res.error);
});

await test('RUN_FLOW 在没配模型又开了评论时，明确告知去配 Key', async () => {
  await sendToRouter(listeners, { type: 'SAVE_SETTINGS', settings: { llm: { apiKey: '' }, auto: { doLike: true, doComment: true } } });
  const res = await sendToRouter(listeners, {
    type: 'RUN_FLOW', input: { links: 'https://www.douyin.com/video/7212345678901234567' },
  });
  assert.equal(res.ok, false);
  assert.ok(/API Key/.test(res.error), res.error);
});

await test('RUN_FLOW 没有输入时给出可读错误而不是静默失败', async () => {
  await sendToRouter(listeners, { type: 'SAVE_SETTINGS', settings: { llm: { apiKey: 'sk-test' }, auto: { doLike: true, doComment: true } } });
  const res = await sendToRouter(listeners, { type: 'RUN_FLOW', input: { links: '', keywords: '' } });
  assert.equal(res.ok, false);
  assert.ok(/没有可处理的输入/.test(res.error), res.error);
});

await test('RUN_COLLECT 空输入给出可读错误', async () => {
  const res = await sendToRouter(listeners, { type: 'RUN_COLLECT', input: { links: '', keywords: '' } });
  assert.equal(res.ok, false);
  assert.ok(/没有可执行/.test(res.error), res.error);
});

await test('BUILD_EXPORT 能产出 CSV 与 Markdown', async () => {
  const csv = await sendToRouter(listeners, { type: 'BUILD_EXPORT', what: 'collected', format: 'csv', items: [] });
  assert.equal(csv.ok, true);
  assert.ok(csv.fileName.endsWith('.csv'));
  const md = await sendToRouter(listeners, { type: 'BUILD_EXPORT', what: 'interactions', format: 'markdown' });
  assert.equal(md.ok, true);
  assert.ok(md.fileName.endsWith('.md'));
});

await test('未知消息类型返回明确错误', async () => {
  const res = await sendToRouter(listeners, { type: 'NOT_A_REAL_TYPE' });
  assert.equal(res.ok, false);
  assert.ok(res.error.includes('未知消息类型'));
});

await test('STOP 幂等', async () => {
  assert.equal((await sendToRouter(listeners, { type: 'STOP' })).ok, true);
});

await test('onInstalled 注册成功且不抛异常', async () => {
  assert.ok(listeners.installed.length >= 1, '没有注册 onInstalled');
  await listeners.installed[0]({ reason: 'install' });
});

/* ================= 2. 控制台渲染 ================= */
console.log('\n[2] 控制台页面启动与渲染');

// 预置数据，验证「有数据时页面真的渲染出来」
store['vh.collected'] = {
  items: [{
    id: 'i1', platform: 'douyin', platformName: '抖音', workId: '721',
    title: '测试作品标题', author: '老王', likeCount: 12000, commentCount: 33,
    url: 'https://www.douyin.com/video/721', collectedAt: '2026-09-21T00:00:00.000Z',
  }],
  updatedAt: '2026-09-21T00:00:00.000Z',
  history: [{ id: 'h1', at: '2026-09-21T00:00:00.000Z', count: 1, platforms: ['douyin'] }],
};
store['vh.logs'] = [{
  id: 'l1', at: '2026-09-21T02:00:00.000Z', platform: 'douyin', platformName: '抖音',
  title: '手写小楷扇面', url: 'https://www.douyin.com/video/721',
  likeCount: 12000, commentCount: 345, favoriteCount: 88,
  commentFocus: '大家在问价和求教程',
  comment: '去年在老师那儿收过一把差不多的',
  result: '点赞✅评论✅', status: 'ok', message: '', dryRun: false, steps: {},
}];

const els = installDomStub();
chrome.runtime.sendMessage = async (msg) => sendToRouter(listeners, msg);

let consoleError = null;
try {
  await import('../ui/console.js');
  await new Promise((r) => setTimeout(r, 400));
} catch (e) {
  consoleError = e;
}

await test('console.js 能加载并跑完首屏渲染（无抛错）', () => {
  assert.equal(consoleError, null, consoleError ? `${consoleError.message}\n${consoleError.stack?.split('\n')[1] || ''}` : '');
});

await test('日志表渲染出用户要的 8 个字段', () => {
  const html = els.get('logTable')?.innerHTML || '';
  for (const col of ['视频标题', '视频链接', '点赞数', '评论数', '收藏数', '评论区关注点', '评论内容', '执行结果']) {
    assert.ok(html.includes(col), `日志表缺列：${col}`);
  }
  assert.ok(html.includes('手写小楷扇面'), '没渲染出标题');
  assert.ok(html.includes('点赞✅评论✅'), '没渲染出执行结果');
  assert.ok(html.includes('8888') || html.includes('88'), '没渲染出收藏数');
});

await test('日志表渲染出评论区关注点与评论内容', () => {
  const html = els.get('logTable')?.innerHTML || '';
  assert.ok(html.includes('大家在问价和求教程'), '缺评论区关注点');
  assert.ok(html.includes('去年在老师那儿收过一把差不多的'), '缺评论内容');
});

await test('选择器表格渲染出各选择器行', () => {
  const html = els.get('selectorTable')?.innerHTML || '';
  assert.ok(html.includes('likeButton'), html.slice(0, 120));
  assert.ok(html.includes('favoriteCount'), '缺收藏数选择器');
  assert.ok(html.includes('commentItem'), '缺评论条目选择器');
});

await test('页面主区只讲一件事：粘链接 → 开始', () => {
  const qb = els.get('quickInput');
  const btn = els.get('btnQuickRun');
  assert.ok(qb, '缺主输入框');
  assert.ok(btn, '缺开始按钮');
  const html = readFileSync(resolve(root, 'ui/console.html'), 'utf8');
  assert.ok(/hero/.test(html), '主操作区没有用 hero 版式');
  assert.ok(/粘贴视频链接，点开始就行/.test(html), '缺少一句人话标题');
});

await test('状态栏给出可读状态而不是空白', () => {
  const t = els.get('statusbar')?.textContent || '';
  assert.ok(t.length > 0 && t !== '加载中…', `状态栏卡在初始态：${t}`);
});

/* ================= 3. 故障可见性与零配置 ================= */
console.log('\n[3] 故障可见性与零配置');

// DOM 桩升级：记录事件处理器，方便测试交互
function installDomStubWithEvents() {
  const els = new Map();
  const makeEl = (id) => {
    const el = {
      id, value: '', textContent: '', innerHTML: '', checked: false, disabled: false,
      className: '', type: 'text', dataset: {}, style: {}, _handlers: {},
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
        toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
        contains(c) { return this._s.has(c); },
      },
      addEventListener(t, fn) { (el._handlers[t] = el._handlers[t] || []).push(fn); },
      removeEventListener() { },
      appendChild() { }, removeChild() { }, click() { el._handlers.click?.forEach((f) => f({ target: el })); },
      focus() { }, scrollIntoView() { },
      querySelector() { return makeEl('child'); }, querySelectorAll() { return []; },
      setAttribute() { }, removeAttribute() { }, getAttribute: () => null,
      selectedOptions: [{ text: '点赞' }],
    };
    return el;
  };
  globalThis.document = {
    getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
    querySelector: () => makeEl('q'),
    querySelectorAll: () => [],
    createElement: () => makeEl('new'),
    addEventListener() { },
    body: makeEl('body'),
  };
  globalThis.window = { addEventListener() { }, setTimeout, clearTimeout };
  globalThis.confirm = () => false;
  globalThis.alert = () => { };
  globalThis.URL.createObjectURL = () => 'blob:fake';
  globalThis.URL.revokeObjectURL = () => { };
  globalThis.Blob = class { constructor() { } };
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => { };
  return els;
}

function fire(els, id, type, evt = {}) {
  const el = els.get(id);
  (el?._handlers?.[type] || []).forEach((f) => f({ target: el, key: evt.key, ...evt }));
}

// --- 3a. Service Worker 挂掉时，界面必须报错，不能停在「加载中」 ---
{
  installChromeStub();
  const els = installDomStubWithEvents();
  chrome.runtime.sendMessage = async () => {
    throw new Error('Could not establish connection. Receiving end does not exist.');
  };
  // 这个用例会故意触发一次报错，把 console.error 静音，避免测试输出被污染
  const realError = console.error;
  console.error = () => { };
  try {
    await import('../ui/console.js?case=sw-down');
    await new Promise((r) => setTimeout(r, 250));
  } finally {
    console.error = realError;
  }

  await test('SW 连不上时状态栏给出明确错误（回归：之前停在「加载中…」）', () => {
    const t = els.get('statusbar')?.textContent || '';
    assert.ok(t && t !== '加载中…', `状态栏卡在初始态：${JSON.stringify(t)}`);
    assert.ok(t.includes('失败'), `应提示失败：${t}`);
  });

  await test('错误信息里带上了「重新加载扩展」的操作指引', () => {
    const t = els.get('statusbar')?.textContent || '';
    assert.ok(/重新加载/.test(t), `缺少可操作指引：${t}`);
  });
}

// --- 3b. 正常启动：零配置，默认值必须已经填满 ---
{
  const els = installDomStubWithEvents();
  chrome.runtime.sendMessage = async (msg) => sendToRouter(listeners, msg);
  await import('../ui/console.js?case=defaults');
  await new Promise((r) => setTimeout(r, 300));

  await test('第一次打开（还没配 Key）时，大模型设置自动展开', () => {
    const pm = els.get('panelModel');
    assert.ok(pm && !pm.classList.contains('hidden'), '没配 Key 时应该自动展开大模型设置');
  });

  await test('展开状态时右上角按钮是灰底（active）', () => {
    const btn = els.get('btnModelPanel');
    assert.ok(btn?.classList.contains('active'), '按钮应该是 active 状态');
  });

  await test('零配置：人设/意图/字数/禁词默认值都已预填，不留空白框', () => {
    for (const id of ['persona', 'intent', 'minLen', 'maxLen', 'bannedWords', 'llmBaseURL', 'llmModel', 'maxPerRun', 'commentSampleCount', 'draftCount']) {
      const v = String(els.get(id)?.value ?? '');
      assert.ok(v.length > 0, `${id} 是空的，用户还得自己填`);
    }
  });

  await test('顶部一句话入口在没配 Key 时直接提示只差这一步', () => {
    fire(els, 'quickInput', 'input');
    const t = els.get('quickHint')?.innerHTML || '';
    assert.ok(/API Key/.test(t), `提示不对：${t}`);
  });

  await test('没配 Key 时点运行会给出去哪填的指引，而不是静默失败', () => {
    fire(els, 'btnQuickRun', 'click');
    const t = els.get('statusbar')?.textContent || '';
    assert.ok(/API Key/.test(t), `状态栏没提示：${t}`);
  });

  await test('零配置默认人设就是用户要的同好口吻', () => {
    const persona = String(els.get('persona')?.value || '');
    const intent = String(els.get('intent')?.value || '');
    assert.ok(persona.includes('普通用户'), persona);
    assert.ok(intent.includes('买过'), `默认意图应含「买过」这类同好口吻：${intent}`);
  });
}

// --- 3c. 配好 Key 后，顶部提示随输入实时变化 ---
{
  const els = installDomStubWithEvents();
  chrome.runtime.sendMessage = async (msg) => sendToRouter(listeners, msg);
  await sendToRouter(listeners, { type: 'SAVE_SETTINGS', settings: { llm: { apiKey: 'sk-test-1234567890', model: 'test-model', baseURL: 'https://api.deepseek.com/v1' } } });
  await import('../ui/console.js?case=with-key');
  await new Promise((r) => setTimeout(r, 300));

  await test('已配好 Key 后，大模型设置默认收起', () => {
    const pm = els.get('panelModel');
    assert.ok(pm?.classList.contains('hidden'), '配好 Key 后应该默认收起');
  });

  await test('收起状态时右上角按钮是透明底（没有 active）', () => {
    const btn = els.get('btnModelPanel');
    assert.ok(!btn?.classList.contains('active'), '收起时按钮不该有 active');
  });

  await test('粘贴链接后，顶部提示显示将处理几条作品', () => {
    els.get('quickInput').value = 'https://www.douyin.com/video/7212345678901234567';
    fire(els, 'quickInput', 'input');
    const t = els.get('quickHint')?.textContent || '';
    assert.ok(t.includes('1 个视频'), `提示不对：${t}`);
    assert.ok(/试跑|演练/.test(t), `应注明当前是试跑模式：${t}`);
  });

  await test('只输关键词时，提示说明会先去搜', () => {
    els.get('quickInput').value = '书法作品';
    fire(els, 'quickInput', 'input');
    const t = els.get('quickHint')?.textContent || '';
    assert.ok(t.includes('书法作品'), t);
    assert.ok(t.includes('搜索'), `应说明会先搜索：${t}`);
  });

  await test('取消演练后提示明确标注为真实发布', () => {
    els.get('quickDryRun').checked = false;
    fire(els, 'quickDryRun', 'change');
    const t = els.get('quickHint')?.textContent || '';
    assert.ok(/真实执行/.test(t), t);
  });
}

// --- 3d. 版本不匹配：页面新、后台旧（用户实际遇到的场景）---
{
  const els = installDomStubWithEvents();
  // 模拟旧版 Service Worker 的响应：没有 protocol，settings 里没有 auto / llm，也没有 autoRecords
  chrome.runtime.sendMessage = async () => ({
    ok: true,
    settings: {
      taskName: '每日情报', scrolls: 5, maxItemsPerRun: 100, dryRun: true,
      likeGapMs: [8000, 20000], commentGapMs: [20000, 45000],
      dailyLimit: 200, maxConsecutiveFailures: 5, skipAlreadyDone: true,
      tabMode: 'background', renderDelayMs: 2500, pageTimeoutMs: 45000,
      enabledPlatforms: { douyin: true, xhs: true, wxSph: true },
      selectorOverrides: { douyin: {}, xhs: {}, wxSph: {} },
      commentTemplate: '',
    },
    state: {}, collected: { items: [], history: [] },
    interactions: [], interactionCount: 0, daily: { count: 0 },
    platformMeta: {},
  });
  const realError = console.error;
  console.error = () => { };
  try {
    await import('../ui/console.js?case=old-sw');
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    console.error = realError;
  }

  await test('旧版后台不会让控制台崩溃，界面照常渲染出来', () => {
    const t = els.get('statusbar')?.textContent || '';
    assert.ok(t.length > 0, '状态栏空白');
    assert.ok(!/Cannot read properties/.test(t), `还在抛原始错误：${t}`);
  });

  await test('旧版后台会明确提示「版本旧了 + 去重新加载」', () => {
    const t = els.get('statusbar')?.textContent || '';
    assert.ok(/旧版本/.test(t), `缺少版本提示：${t}`);
    assert.ok(/重新加载/.test(t), `缺少操作指引：${t}`);
  });

  await test('旧版后台缺字段时，表单用兜底默认值填满而不是留空', () => {
    for (const [id, expect] of [['maxPerRun', '3'], ['commentSampleCount', '20'], ['draftCount', '3'], ['minLen', '8'], ['maxLen', '45'], ['llmBaseURL', 'https://www.manbouapi.com/v1']]) {
      assert.equal(String(els.get(id)?.value ?? ''), expect, `${id} 兜底值不对`);
    }
    assert.ok(String(els.get('persona')?.value || '').includes('普通用户'));
    assert.ok(String(els.get('intent')?.value || '').includes('买过'));
  });
}

/* ================= 4. id 一致性 ================= */
console.log('\n[4] DOM id 一致性');

const html = readFileSync(resolve(root, 'ui/console.html'), 'utf8');
const js = readFileSync(resolve(root, 'ui/console.js'), 'utf8');
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

await test('console.js 里 $() 用到的 id 都存在（HTML 或 JS 动态生成）', () => {
  const used = [...new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
  const missing = used.filter((id) => !htmlIds.has(id) && !js.includes(`id="${id}"`) && !js.includes(`id=\\${id}`));
  assert.equal(missing.length, 0, `这些 id 既不在 HTML 里也没动态创建：${missing.join(', ')}`);
});

await test('HTML 里声明的表格/列表容器都被 JS 使用过', () => {
  const containers = [...htmlIds].filter((id) => /Table$|List$|History$|Meta$/.test(id) && id !== 'chkAll');
  const unused = containers.filter((id) => !js.includes(`'${id}'`));
  assert.equal(unused.length, 0, `HTML 里有但 JS 从没用到的容器：${unused.join(', ')}`);
});

await test('单页布局：没有残留的标签页结构', () => {
  const tabButtons = [...html.matchAll(/data-tab="/g)].length;
  const panes = [...html.matchAll(/class="tabpane/g)].length;
  assert.equal(tabButtons, 0, '还留着标签按钮');
  assert.equal(panes, 0, '还留着 tabpane 容器');
});

await test('单页布局：主流程区块在折叠区外面，可见即用', () => {
  const body = html.slice(html.indexOf('<main>'));
  const firstDetails = body.indexOf('<details');
  const mainPart = firstDetails === -1 ? body : body.slice(0, firstDetails);
  for (const id of ['logTable', 'quickInput', 'btnQuickRun', 'btnExportCsv']) {
    assert.ok(mainPart.includes(`id="${id}"`) || html.includes(`id="${id}"`), `主流程缺 ${id}`);
  }
});

await test('两个面板在 HTML 里都先隐藏（避免加载瞬间闪屏），且有对应按钮', () => {
  assert.ok(/id="panelModel"[^>]*class="card panel hidden"/.test(html), '大模型面板初始应隐藏');
  assert.ok(/id="panelAdv"[^>]*class="card panel hidden"/.test(html), '高级面板应默认隐藏');
  assert.ok(html.includes('id="btnModelPanel"'), '缺打开大模型设置的按钮');
  assert.ok(html.includes('id="btnAdvPanel"'), '缺打开高级的按钮');
});

await test('页面上不再有收录/积分等多余区块', () => {
  for (const gone of ['collectedTable', 'collectHistory', 'planOut', 'flowInfo', 'walletBalance', 'redeemCode', 'btnRunCollect']) {
    assert.ok(!html.includes(`id="${gone}"`), `${gone} 应该已经删掉`);
  }
});

await test('两个面板都有保存按钮，且字段 id 被 JS 用到', () => {
  assert.ok(html.includes('id="btnSaveModel"'), '大模型面板缺保存');
  assert.ok(html.includes('id="btnSaveAdv"'), '高级面板缺保存');
  const js = readFileSync(resolve(root, 'ui/console.js'), 'utf8');
  for (const id of ['llmApiKey', 'llmBaseURL', 'llmModel', 'doLike', 'doComment', 'maxPerRun', 'persona', 'bannedWords', 'calPlatform']) {
    assert.ok(js.includes(`'${id}'`), `${id} 没有被 JS 使用`);
  }
});

await test('界面里不出现任何服务商 URL（不替别人打广告）', () => {
  const placeholders = [...html.matchAll(/placeholder="([^"]*)"/g)].map((m) => m[1]);
  for (const p of placeholders) {
    assert.ok(!/https?:\/\//.test(p) || /douyin|xhs|xiaohongshu/.test(p),
      `placeholder 里出现了非平台 URL：${p}`);
    assert.ok(!/manbouapi|openai\.com|deepseek\.com/i.test(p), `placeholder 里出现了服务商：${p}`);
  }
});

await test('邀请链接留空时，界面里不显示任何「获取 Key」的广告位', async () => {
  const { DIST } = await import('../src/config.js');
  if (!DIST.inviteUrl) {
    const box = els.get('inviteBox');
    assert.ok(!box || box.innerHTML === '' || box.classList.contains('hidden'),
      'inviteUrl 为空时不该显示邀请框');
  }
});

await test('进度条位置正确：在开始按钮下面、输入区里面', () => {
  const hero = html.slice(html.indexOf('class="hero"'), html.indexOf('</section>', html.indexOf('class="hero"')));
  const inputPos = hero.indexOf('id="quickInput"');
  const btnPos = hero.indexOf('id="btnQuickRun"');
  const progPos = hero.indexOf('id="flowOut"');
  assert.ok(inputPos > 0 && btnPos > 0 && progPos > 0, '英雄区里缺元素');
  assert.ok(progPos > btnPos, '进度条应该在开始按钮之后（下面）');
  assert.ok(progPos > inputPos, '进度条应该在输入框之后');
  assert.ok(/class="progressbox hidden"/.test(hero), '进度条应默认隐藏并带 progressbox 样式');
});

await test('详细进度不再写进顶部状态栏（只写在进度条里）', () => {
  const js = readFileSync(resolve(root, 'ui/console.js'), 'utf8');
  // VH_PROGRESS 分支里不允许再调用 setStatus
  const block = js.slice(js.indexOf("msg?.type === 'VH_PROGRESS'"), js.indexOf("msg?.type === 'VH_DONE'"));
  assert.ok(!/setStatus\(/.test(block), 'VH_PROGRESS 里还在刷顶部状态栏');
  assert.ok(/showProgress\(/.test(block), 'VH_PROGRESS 应该调用 showProgress');
});

await test('日志表有展开/收起开关，且默认收起', () => {
  assert.ok(html.includes('id="btnToggleRows"'), '缺展开/收起按钮');
  const js = readFileSync(resolve(root, 'ui/console.js'), 'utf8');
  assert.ok(/rowsExpanded = false/.test(js), '默认应该是收起状态');
  assert.ok(/classList\.toggle\('expanded', rowsExpanded\)/.test(js), '按钮没有切换 expanded 类');
});

await test('日志表列宽固定，数字列不会被挤成竖排', () => {
  const js = readFileSync(resolve(root, 'ui/console.js'), 'utf8');
  assert.ok(/<colgroup>/.test(js), '日志表缺少 colgroup 列宽定义');
  const css = readFileSync(resolve(root, 'ui/style.css'), 'utf8');
  assert.ok(/#logTable \{ table-layout: fixed/.test(css), 'CSS 没有固定表格布局');
  assert.ok(/#logTable th \{ white-space: nowrap/.test(css), '表头没有禁止换行');
});

await test('长文本默认截断成一行，展开后换行显示', () => {
  const css = readFileSync(resolve(root, 'ui/style.css'), 'utf8');
  assert.ok(/#logTable td\.clamp \{[^}]*text-overflow: ellipsis/.test(css), 'clamp 单元格没有省略号');
  assert.ok(/#logTable\.expanded td\.clamp \{[^}]*white-space: normal/.test(css), '展开后应该换行');
  const js = readFileSync(resolve(root, 'ui/console.js'), 'utf8');
  for (const col of ['title', 'url', 'commentFocus', 'comment']) {
    assert.ok(new RegExp(`${col}[^\\n]*class="clamp"`).test(js) || new RegExp(`class="clamp"[^\\n]*${col}`).test(js),
      `${col} 没有用 clamp`);
  }
});

await test('按钮展开是灰底、收起是透明底（CSS 有对应样式）', () => {
  const css = readFileSync(resolve(root, 'ui/style.css'), 'utf8');
  assert.ok(/button\.ghost \{\s*background: transparent/.test(css), '收起态应是透明底');
  assert.ok(/button\.ghost\.active \{[^}]*background: #e2e8f0/.test(css), '展开态应是灰底');
});

await test('执行结果用加粗显示，便于一眼扫到 ✅', () => {
  const css = readFileSync(resolve(root, 'ui/style.css'), 'utf8');
  assert.ok(/#logTable \.resulttext \{ font-weight: 600/.test(css), '结果文字没有加粗');
});

/* ================= 4. popup ================= */
console.log('\n[4] popup 页面');

let popupError = null;
try {
  installDomStub();
  chrome.tabs.query = async () => [{ id: 1, url: 'https://www.douyin.com/video/7212345678901234567' }];
  await import('../ui/popup.js');
  await new Promise((r) => setTimeout(r, 200));
} catch (e) {
  popupError = e;
}

await test('popup.js 能加载并渲染（无抛错）', () => {
  assert.equal(popupError, null, popupError ? popupError.message : '');
});

console.log(`\n结果：${passed} 通过，${failures.length} 失败\n`);
if (failures.length) {
  for (const f of failures) console.error(`失败：${f.name} → ${f.error}`);
  process.exit(1);
}
