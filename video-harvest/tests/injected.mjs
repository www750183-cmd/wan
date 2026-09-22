// 注入函数的逻辑测试：用一个极简 DOM 桩验证「登录检测 / 状态判定 / 跳过 / 演练 / 真点」这些关键分支。
// 这些函数本来跑在页面里，无法在真实浏览器里做单元测试；用桩可以把决策逻辑全部覆盖。
// 用法：node tests/injected.mjs
import assert from 'node:assert/strict';
import { injectProbe, injectExtractWork, injectInteract, injectHarvest } from '../src/injected.js';

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

/* ---------------- DOM 桩 ---------------- */
let lastFocused = null;

function makeEl(opts = {}) {
  const attrs = { ...(opts.attrs || {}) };
  const el = {
    tagName: opts.tagName || 'DIV',
    classList: Object.assign([], { length: opts.classCount ?? 0 }),
    innerText: opts.text ?? '',
    textContent: opts.text ?? '',
    value: opts.value ?? '',
    className: opts.className ?? '',
    isContentEditable: !!opts.editable,
    getAttribute_: null,
    // 普通 <a>：href 是字符串；SVG <use>：href 是 {baseVal}
    href: opts.hrefBaseVal !== undefined ? { baseVal: opts.hrefBaseVal } : (opts.href !== undefined ? opts.href : undefined),
    getAttribute(n) {
      if (n === 'href') {
        if (opts.hrefBaseVal !== undefined) return null;   // SVG use 读不到 attribute
        if (opts.href !== undefined) return opts.href;
      }
      return attrs[n] ?? null;
    },
    hasAttribute(n) { return n in attrs; },
    getBoundingClientRect: () => ({ width: opts.w ?? 24, height: opts.h ?? 24, top: 0, left: 0 }),
    scrollIntoView() { },
    parentElement: opts.parent || null,
    nextElementSibling: opts.next || null,
    previousElementSibling: opts.prev || null,
    content: opts.content,
    focus() { lastFocused = el; },
    click() { if (opts.onClick) opts.onClick(el); },
    dispatchEvent(ev) { el.__events = (el.__events || []).concat(ev); return true; },
    querySelector() { return null; },
    querySelectorAll: () => opts.qsaAll || [],
  };
  return el;
}

let registry = new Map();
function installDom(map, url = 'https://www.douyin.com/video/7212345678901234567') {
  registry = new Map();
  for (const [sel, val] of Object.entries(map)) {
    if (val === null || val === undefined) continue;
    registry.set(sel, Array.isArray(val) ? { all: val, single: val[0] } : { single: val, all: [val] });
  }
  lastFocused = null;
  globalThis.document = {
    title: 'Test Page',
    querySelector: (s) => registry.get(s)?.single ?? null,
    querySelectorAll: (s) => registry.get(s)?.all ?? [],
    body: { innerText: 'body 正文内容' },
    // 模拟 execCommand('insertText') 真的把文本写进当前聚焦的可编辑元素
    execCommand: (cmd, _x, val) => {
      if (cmd === 'insertText' && lastFocused) {
        lastFocused.innerText = String(val ?? '');
        return true;
      }
      return true;
    },
    addEventListener() { }, removeEventListener() { },
    createElement: () => makeEl(),
    documentElement: { appendChild() { } },
    getElementById: () => null,
  };
  globalThis.location = { href: url };
  globalThis.window = { scrollTo() { }, __vhPicking: false, __vhPicked: null };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  globalThis.InputEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
  globalThis.KeyboardEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); globalThis.__lastKeyEvent = this; } };
  globalThis.ClipboardEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
  globalThis.DataTransfer = class { setData() { } };
}

const S = (extra = {}) => ({
  loginFlag: ['.login-flag'],
  readyFlag: ['.ready'],
  likeButton: ['.like-btn'],
  collectButton: ['.collect-btn'],
  commentInput: ['.cmt-input'],
  commentSubmit: ['.cmt-submit'],
  commentSuccess: ['.cmt-item'],
  title: ['.title'],
  author: ['.author'],
  authorLink: ['.author-link'],
  collectCount: ['.like-count'],
  commentCount: ['.cmt-count'],
  ...extra,
});

/* ---------------- probe ---------------- */
console.log('\n[1] injectProbe');

await test('未登录时 loggedOut=true', async () => {
  installDom({ '.login-flag': makeEl(), '.ready': makeEl() });
  const r = await injectProbe({ selectors: S() });
  assert.equal(r.loggedOut, true);
  assert.equal(r.ok, true);
});

await test('正常页面：命中项被标记，未命中项被记录', async () => {
  installDom({ '.ready': makeEl(), '.title': makeEl({ text: '标题X' }) });
  const r = await injectProbe({ selectors: S() });
  assert.equal(r.loggedOut, false);
  assert.equal(r.ready, true);
  const byKey = Object.fromEntries(r.fields.map((f) => [f.key, f]));
  assert.equal(byKey.readyFlag.hit, true);
  assert.equal(byKey.title.hit, true);
  assert.equal(byKey.title.rows[0].sample, '标题X');
  assert.equal(byKey.likeButton.hit, false);
  assert.equal(byKey.likeButton.rows[0].count, 0);
});

await test('选择器写错（非法 CSS）不会抛异常', async () => {
  installDom({ '.ready': makeEl() });
  const r = await injectProbe({ selectors: { ...S(), title: [':not('] } });
  const row = r.fields.find((f) => f.key === 'title');
  assert.equal(row.hit, false, '非法选择器应当计为未命中而不是抛错');
});

/* ---------------- extract ---------------- */
console.log('\n[2] injectExtractWork');

await test('提取标题/作者/计数（中文单位）', () => {
  installDom({
    '.ready': makeEl(),
    '.title': makeEl({ text: '露营装备清单' }),
    '.author': makeEl({ text: '老王' }),
    '.author-link': makeEl({ href: 'https://www.douyin.com/user/abc' }),
    '.like-count': makeEl({ text: '1.2万' }),
    '.cmt-count': makeEl({ text: '345' }),
    '.like-btn': makeEl({ classCount: 1 }),
    '.collect-btn': makeEl({ classCount: 2 }),
  });
  const r = injectExtractWork({ selectors: S(), likeState: { type: 'classCount', min: 2, selectorKey: 'likeButton' }, collectState: { type: 'classCount', min: 2, selectorKey: 'collectButton' } });
  assert.equal(r.title, '露营装备清单');
  assert.equal(r.author, '老王');
  assert.equal(r.authorUrl, 'https://www.douyin.com/user/abc');
  assert.equal(r.like.value, 12000);
  assert.equal(r.comment.value, 345);
  assert.equal(r.isLiked, false, 'classCount=1 应为未点赞');
  assert.equal(r.isCollected, true, 'classCount=2 应为已收藏');
});

await test('useHref 状态判定（小红书形态：SVG use 的 href.baseVal）', () => {
  installDom({
    '.ready': makeEl(),
    '.like-btn': makeEl({ hrefBaseVal: '#liked' }),
    '.collect-btn': makeEl({ hrefBaseVal: 'collected' }),
  });
  const r = injectExtractWork({
    selectors: S(),
    likeState: { type: 'useHref', selector: '.like-btn', equals: '#liked' },
    collectState: { type: 'useHref', selector: '.collect-btn', equals: 'collected' },
  });
  assert.equal(r.isLiked, true);
  assert.equal(r.isCollected, true);
});

await test('useHref 未激活时判定为 false', () => {
  installDom({
    '.ready': makeEl(),
    '.like-btn': makeEl({ hrefBaseVal: '#like' }),
    '.collect-btn': makeEl({ hrefBaseVal: 'collect' }),
  });
  const r = injectExtractWork({
    selectors: S(),
    likeState: { type: 'useHref', selector: '.like-btn', equals: '#liked' },
    collectState: { type: 'useHref', selector: '.collect-btn', equals: 'collected' },
  });
  assert.equal(r.isLiked, false);
  assert.equal(r.isCollected, false);
});

await test('元素缺失时返回 null 而不是崩溃', () => {
  installDom({ '.ready': makeEl() });
  const r = injectExtractWork({ selectors: S(), likeState: { type: 'classCount', min: 2, selectorKey: 'likeButton' } });
  assert.equal(r.title, '');
  assert.equal(r.isLiked, null);
  assert.equal(r.like.value, null);
});

await test('未登录时 extract 也会给出标记', () => {
  installDom({ '.login-flag': makeEl(), '.ready': makeEl() });
  const r = injectExtractWork({ selectors: S() });
  assert.equal(r.loggedOut, true);
});

/* ---------------- interact ---------------- */
console.log('\n[3] injectInteract');

const baseCfg = (extra) => ({
  selectors: S(),
  likeState: { type: 'classCount', min: 2, selectorKey: 'likeButton' },
  collectState: { type: 'classCount', min: 2, selectorKey: 'collectButton' },
  actionTimeoutMs: 500,
  readyTimeoutMs: 600,
  ...extra,
});

await test('未登录直接中止并给出 needLogin', async () => {
  installDom({ '.login-flag': makeEl() });
  const r = await injectInteract(baseCfg({ action: 'like' }));
  assert.equal(r.needLogin, true);
  assert.ok(r.error.includes('未登录'));
});

await test('页面元素没出现时报「选择器可能失效」', async () => {
  installDom({});
  const r = await injectInteract(baseCfg({ action: 'like' }));
  assert.ok(r.error.includes('选择器'), r.error);
  assert.equal(r.ok, false);
});

await test('已是目标状态 → 跳过且不点击', async () => {
  let clicked = false;
  installDom({ '.ready': makeEl(), '.like-btn': makeEl({ classCount: 2, onClick: () => { clicked = true; } }) });
  const r = await injectInteract(baseCfg({ action: 'like' }));
  assert.equal(r.alreadyInTarget, true);
  assert.equal(r.ok, true);
  assert.equal(clicked, false, '不应发生点击');
});

await test('演练模式：会点击前的所有检查都做，但不真点', async () => {
  let clicked = false;
  installDom({ '.ready': makeEl(), '.like-btn': makeEl({ classCount: 1, onClick: () => { clicked = true; } }) });
  const r = await injectInteract(baseCfg({ action: 'like', dryRun: true }));
  assert.equal(r.dryRun, true);
  assert.equal(r.ok, true);
  assert.equal(clicked, false, '演练模式不能点击');
});

await test('真实点赞：点击后状态翻转 → ok', async () => {
  const btn = makeEl({ classCount: 1, onClick: (el) => { el.classList.length = 2; } });
  installDom({ '.ready': makeEl(), '.like-btn': btn });
  const r = await injectInteract(baseCfg({ action: 'like' }));
  assert.equal(r.before, false);
  assert.equal(r.after, true);
  assert.equal(r.ok, true);
});

await test('取消点赞：从已点赞回到未点赞', async () => {
  const btn = makeEl({ classCount: 2, onClick: (el) => { el.classList.length = 1; } });
  installDom({ '.ready': makeEl(), '.like-btn': btn });
  const r = await injectInteract(baseCfg({ action: 'unlike' }));
  assert.equal(r.before, true);
  assert.equal(r.after, false);
  assert.equal(r.ok, true);
});

await test('点击了但状态没变 → 报告「未能确认」，不算成功', async () => {
  installDom({ '.ready': makeEl(), '.like-btn': makeEl({ classCount: 1 }) });
  const r = await injectInteract(baseCfg({ action: 'like' }));
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('未在超时内确认'));
});

await test('状态无法判定时跳过（按钮在但状态元素读不到）', async () => {
  installDom({ '.ready': makeEl(), '.like-btn': makeEl() });
  const r = await injectInteract({
    ...baseCfg({ action: 'like' }),
    // 小红书形态：按钮存在，但用于判态的 <use> 不在
    likeState: { type: 'useHref', selector: '.like-icon use', equals: '#liked' },
  });
  assert.equal(r.skipped, true, JSON.stringify(r));
  assert.ok(r.error.includes('无法判定'));
});

await test('平台未定义状态判定（视频号形态 type:none）也会跳过', async () => {
  installDom({ '.ready': makeEl(), '.like-btn': makeEl() });
  const r = await injectInteract({
    ...baseCfg({ action: 'like' }),
    likeState: { type: 'none' },
  });
  assert.equal(r.skipped, true);
});

await test('收藏动作走收藏按钮与收藏状态', async () => {
  const btn = makeEl({ classCount: 0, onClick: (el) => { el.classList.length = 2; } });
  installDom({ '.ready': makeEl(), '.collect-btn': btn });
  const r = await injectInteract(baseCfg({ action: 'favorite' }));
  assert.equal(r.ok, true);
  assert.equal(r.after, true);
});

await test('评论：输入框缺失时明确报错', async () => {
  installDom({ '.ready': makeEl(), '.like-btn': makeEl({ classCount: 1 }) });
  const r = await injectInteract(baseCfg({ action: 'comment', content: '不错的分享' }));
  assert.ok(r.error.includes('评论输入框'), r.error);
});

await test('评论：提交按钮缺失时改用回车提交，而不是报错（行为已变更）', async () => {
  installDom({ '.ready': makeEl(), '.cmt-input': makeEl({ editable: true }) });
  const r = await injectInteract(baseCfg({ action: 'comment', content: '不错的分享' }));
  assert.ok(!/找不到评论提交按钮/.test(r.error || ''), '不该再因为缺按钮而失败：' + r.error);
});

await test('评论：内容为空时拒绝执行', async () => {
  installDom({ '.ready': makeEl(), '.cmt-input': makeEl({ editable: true }), '.cmt-submit': makeEl() });
  const r = await injectInteract(baseCfg({ action: 'comment', content: '   ' }));
  assert.ok(r.error.includes('为空'), r.error);
});

await test('评论：演练模式不填不点', async () => {
  let submitted = false;
  installDom({
    '.ready': makeEl(),
    '.cmt-input': makeEl({ editable: true }),
    '.cmt-submit': makeEl({ onClick: () => { submitted = true; } }),
  });
  const r = await injectInteract(baseCfg({ action: 'comment', content: '不错的分享', dryRun: true }));
  assert.equal(r.dryRun, true);
  assert.equal(submitted, false);
});

await test('评论：真实提交，输入框被清空即判定成功', async () => {
  const input = makeEl({ editable: true });
  const submit = makeEl({ onClick: () => { input.innerText = ''; } });
  installDom({ '.ready': makeEl(), '.cmt-input': input, '.cmt-submit': submit });
  const r = await injectInteract(baseCfg({ action: 'comment', content: '不错的分享' }));
  assert.equal(r.ok, true);
  assert.equal(r.verified, true);
  assert.ok(r.message.includes('确认'));
});

await test('评论：提交后未被清空 → 报告「未能确证」', async () => {
  const input = makeEl({ editable: true });
  installDom({ '.ready': makeEl(), '.cmt-input': input, '.cmt-submit': makeEl() });
  const r = await injectInteract(baseCfg({ action: 'comment', content: '不错的分享' }));
  assert.equal(r.ok, true);
  assert.equal(r.verified, false);
  assert.ok(r.message.includes('未能确证'), r.message);
});

await test('评论：输入被站点静默丢弃时拒绝提交（不谎报成功）', async () => {
  const input = makeEl({ editable: true });
  const submit = makeEl();
  installDom({ '.ready': makeEl(), '.cmt-input': input, '.cmt-submit': submit });
  // 让 execCommand 假装成功但什么都不写
  globalThis.document.execCommand = () => true;
  const r = await injectInteract(baseCfg({ action: 'comment', content: '不错的分享' }));
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.ok(r.error.includes('未能真正写入'), r.error);
});

await test('未知动作被拒绝', async () => {
  installDom({ '.ready': makeEl() });
  const r = await injectInteract(baseCfg({ action: 'share' }));
  assert.ok(r.error.includes('不支持的动作'));
});

/* ---------------- 平台改版时的自动发现兜底 ---------------- */
console.log('\n[4] 自动发现兜底（选择器失效时）');

const CE_SEL = '[contenteditable="true"],.public-DraftEditor-content,textarea,[role="textbox"]';
const BTN_SEL = 'button,[role="button"],span,div';
const CM_SEL = '[class*="comment" i],[data-e2e*="comment" i]';

await test('登录弹窗存在但隐藏时，不再误判为「未登录」', async () => {
  installDom({
    '.ready': makeEl(),
    '.like-btn': makeEl({ classCount: 1, onClick: (el) => { el.classList.length = 2; } }),
    '.login-flag': makeEl({ w: 0, h: 0 }),   // 隐藏在 DOM 里的登录弹窗
  });
  const r = await injectInteract(baseCfg({ action: 'like' }));
  assert.ok(!r.needLogin, '隐藏的登录弹窗不应触发未登录');
  assert.equal(r.ok, true, JSON.stringify(r));
});

await test('评论输入框选择器失效时，自动找到页面上的可编辑框', async () => {
  const input = makeEl({ editable: true, attrs: { placeholder: '说点什么…' } });
  const submit = makeEl({ text: '发送' });
  input.parentElement = makeEl({ qsaAll: [submit] });
  installDom({
    '.ready': makeEl(),
    [CE_SEL]: input,
  });
  const r = await injectInteract(baseCfg({ action: 'comment', content: '不错的分享' }));
  assert.ok(!/找不到评论输入框/.test(r.error || ''), r.error);
  const step = (r.steps || []).find((x) => x.step === 'discoverInput');
  assert.ok(step?.ok, '应该走了自动发现');
});

await test('提交按钮也失效时，自动在输入框附近找到「发送」', async () => {
  const input = makeEl({ editable: true, attrs: { placeholder: '说点什么…' } });
  const submit = makeEl({ text: '发送' });
  input.parentElement = makeEl({ qsaAll: [submit] });
  installDom({ '.ready': makeEl(), [CE_SEL]: input });
  const r = await injectInteract(baseCfg({ action: 'comment', content: '不错的分享' }));
  const step = (r.steps || []).find((x) => x.step === 'discoverSubmit');
  assert.ok(step?.ok, '应该自动找到了提交按钮：' + JSON.stringify(r.steps));
});

await test('页面上真的没有输入框时，给出明确原因而不是含糊报错', async () => {
  installDom({ '.ready': makeEl() });
  const r = await injectInteract(baseCfg({ action: 'comment', content: 'x' }));
  assert.ok(/找不到评论输入框/.test(r.error), r.error);
  assert.ok(/自动查找/.test(r.error), '要说明自动查找也试过了：' + r.error);
});

await test('评论区选择器失效时，自己按 class 找出一组评论', async () => {
  const c1 = makeEl({ className: 'comment-item', text: '这个多少钱出？' });
  const c2 = makeEl({ className: 'comment-item', text: '字写得真好' });
  const c3 = makeEl({ className: 'comment-item', text: '求个教程' });
  installDom({ '.ready': makeEl(), [CM_SEL]: [c1, c2, c3] });
  const r = await injectHarvest({
    selectors: S(),
    commentMax: 10,
    commentScrolls: 0,
    readyTimeoutMs: 100,
  });
  assert.equal(r.comments.length, 3, JSON.stringify(r.comments));
  assert.ok(r.comments[0].text.includes('多少钱'), r.comments[0].text);
  assert.equal(r.discovered.comments, true, '应标记为走了自动发现');
});

await test('标题选择器失效时，用 og:title 兜底', async () => {
  installDom({
    '.ready': makeEl(),
    'meta[property="og:title"],meta[name="twitter:title"]': makeEl({ content: '手写小楷扇面 - 抖音' }),
  });
  const r = await injectHarvest({ selectors: S(), commentMax: 1, commentScrolls: 0, readyTimeoutMs: 100 });
  assert.ok(/手写小楷扇面/.test(r.content.title), r.content.title);
  assert.ok(!/抖音/.test(r.content.title), '应去掉平台后缀：' + r.content.title);
});

await test('计数拿不到时，从点赞/收藏按钮附近抠数字', async () => {
  const countEl = makeEl({ text: '1.2万' });
  const likeBtn = makeEl({ classCount: 1, next: countEl });
  installDom({ '.ready': makeEl(), '.like-btn': likeBtn });
  const r = await injectHarvest({ selectors: S(), commentMax: 1, commentScrolls: 0, readyTimeoutMs: 100 });
  assert.equal(r.content.likeCount, 12000, JSON.stringify(r.content));
});

await test('回归：自检时评论相关项没命中，会先自动点开评论区再测', async () => {
  const openBtn = makeEl({ className: 'feed-comment-icon' });
  let clicked = false;
  openBtn.click = () => { clicked = true; };
  installDom({ '.open-comments': openBtn });
  const r = await injectProbe({
    selectors: { loginFlag: ['.none'], commentItem: ['.none'], commentInput: ['.none'] },
    openCommentsBy: ['.open-comments'],
    openCommentsDelayMs: 10,
  });
  assert.equal(clicked, true, '应该点了评论图标');
  assert.equal(r.openedComments, true, '应标记为「已自动展开」');
});

await test('回归：评论区本来就没收起时，不去点它（避免多余副作用）', async () => {
  const openBtn = makeEl({ className: 'feed-comment-icon' });
  let clicked = false;
  openBtn.click = () => { clicked = true; };
  installDom({ '.open-comments': openBtn, '.cmt-item': makeEl({ text: '一条评论' }) });
  const r = await injectProbe({
    selectors: { loginFlag: ['.none'], commentItem: ['.cmt-item'], commentInput: ['.cmt-item'] },
    openCommentsBy: ['.open-comments'],
    openCommentsDelayMs: 10,
  });
  assert.equal(clicked, false, '评论已经能抓到，不该再去点');
  assert.equal(r.openedComments, false);
});

await test('回归：没有配 openCommentsBy 时也能正常自检', async () => {
  installDom({ '.ready': makeEl() });
  const r = await injectProbe({ selectors: { loginFlag: ['.none'], commentItem: ['.none'] } });
  assert.equal(r.ok, true);
  assert.equal(r.openedComments, false);
});

/* ---------------- 抖音式：Draft.js 评论框 + 纯图标发送按钮 ---------------- */
console.log('\n[5] 抖音评论区结构');

const DRAFT_CONTENT = '.public-DraftEditor-content';
const DRAFT_SEL = CE_SEL;

await test('Draft.js 评论框：内层块元素能往上找到真正可编辑的容器', async () => {
  const innerBlock = makeEl({ className: 'public-DraftStyleDefault-block', editable: false });
  const editor = makeEl({ className: 'public-DraftEditor-content', editable: true });
  innerBlock.parentElement = editor;
  installDom({ '.ready': makeEl(), [DRAFT_SEL]: editor });
  const r = await injectInteract(baseCfg({ action: 'comment', content: '不错的分享' }));
  assert.ok(!/找不到评论输入框/.test(r.error || ''), r.error);
});

await test('发送按钮是纯图标（没有文字）时，改用回车提交而不是报错', async () => {
  const editor = makeEl({ className: 'public-DraftEditor-content', editable: true });
  installDom({ '.ready': makeEl(), [DRAFT_SEL]: editor });
  const r = await injectInteract(baseCfg({ action: 'comment', content: '不错的分享' }));
  assert.ok(!/找不到评论提交按钮/.test(r.error || ''), '不该因为找不到按钮就失败：' + r.error);
  const step = (r.steps || []).find((x) => x.step === 'submit');
  assert.equal(step?.detail, '用回车提交（没找到发送按钮）', JSON.stringify(r.steps));
  assert.ok(editor.__events?.some((e) => e.key === 'Enter'), '应该派发了回车事件');
});

await test('能找到发送按钮时，优先点按钮而不是回车', async () => {
  const editor = makeEl({ className: 'public-DraftEditor-content', editable: true });
  const btn = makeEl({ text: '发送' });
  editor.parentElement = makeEl({ qsaAll: [btn] });
  installDom({ '.ready': makeEl(), [DRAFT_SEL]: editor });
  const r = await injectInteract(baseCfg({ action: 'comment', content: '不错的分享' }));
  const step = (r.steps || []).find((x) => x.step === 'submit');
  assert.equal(step?.detail, '点击发送按钮');
});

await test('抖音的 commentInput 选择器包含 Draft.js 的稳定 class', async () => {
  const { PLATFORMS } = await import('../src/lib/platforms.js');
  const list = PLATFORMS.douyin.selectors.commentInput;
  assert.ok(list.some((x) => x.includes('public-DraftEditor-content')), '应含 Draft.js 的 contenteditable 容器');
  assert.ok(list.some((x) => x.includes('contenteditable')), '应保留通用 contenteditable 兜底');
});

await test('抖音声明了回车提交模式', async () => {
  const { PLATFORMS } = await import('../src/lib/platforms.js');
  assert.equal(PLATFORMS.douyin.commentSubmitMode, 'auto');
});

/* ---------------- AiToEarn 实测顺序：先点评论区，编辑器才渲染 ---------------- */
console.log('\n[6] 评论输入框：先点再找（照搬 AiToEarn 的顺序）');

await test('回归：编辑器不在 DOM 里时，先点评论区域把它叫出来', async () => {
  const editor = makeEl({ className: 'richtext', editable: true });
  let clicked = false;
  const trigger = makeEl({ className: 'comment-input-inner-container' });
  trigger.click = () => {
    clicked = true;
    // 真实站点上：点击之后编辑器才被挂进 DOM
    registry.set('.rt [contenteditable="true"]', { single: editor, all: [editor] });
  };
  installDom({ '.ready': makeEl(), '.cmt-trigger': trigger });
  const r = await injectInteract({
    ...baseCfg({ action: 'comment', content: '不错的分享' }),
    selectors: { ...S(), commentInput: ['.rt [contenteditable="true"]'], commentSubmit: ['.none'] },
    commentTrigger: ['.cmt-trigger'],
    commentTriggerDelayMs: 10,
  });
  assert.equal(clicked, true, '应该点了评论区域');
  assert.ok(!/找不到评论输入框/.test(r.error || ''), '点完之后应能找到输入框：' + r.error);
  assert.ok((r.steps || []).some((x) => x.step === 'trigger'), '应记录 trigger 步骤');
});

await test('输入方式优先用粘贴事件（Draft.js 对 execCommand 支持差）', async () => {
  const editor = makeEl({ editable: true });
  installDom({ '.ready': makeEl(), '.cmt-input': editor });
  // 让粘贴事件真的把文本写进去
  editor.dispatchEvent = (ev) => {
    if (ev.type === 'paste' && ev.clipboardData) editor.innerText = '不错的分享';
    return true;
  };
  const r = await injectInteract(baseCfg({ action: 'comment', content: '不错的分享' }));
  const fill = (r.steps || []).find((x) => x.step === 'fill');
  assert.ok(/paste/.test(fill?.detail || ''), '应该用粘贴：' + fill?.detail);
});

await test('回归：出现短信验证弹窗时，报告 needHumanAssist 而不是假装成功', async () => {
  const editor = makeEl({ editable: true });
  const submit = makeEl();
  installDom({
    '.ready': makeEl(), '.cmt-input': editor, '.cmt-submit': submit,
    '.uc-ui-input_content': makeEl({ text: '请输入验证码' }),
  });
  editor.dispatchEvent = () => true;
  const r = await injectInteract({
    ...baseCfg({ action: 'comment', content: '不错的分享', actionTimeoutMs: 60 }),
    selectors: { ...S(), smsVerification: ['.uc-ui-input_content'] },
  });
  assert.equal(r.needHumanAssist, true, JSON.stringify(r.steps));
  assert.equal(r.verified, false);
  assert.ok(/验证/.test(r.message), r.message);
});

await test('回归：评论列表第一条等于我们发的内容 → 判定成功', async () => {
  const editor = makeEl({ editable: true });
  const submit = makeEl();
  const firstItem = makeEl({ text: '不错的分享' });
  installDom({
    '.ready': makeEl(), '.cmt-input': editor, '.cmt-submit': submit,
    '.cmt-result': firstItem,
  });
  editor.dispatchEvent = () => true;
  const r = await injectInteract({
    ...baseCfg({ action: 'comment', content: '不错的分享', actionTimeoutMs: 200 }),
    selectors: { ...S(), commentResultItem: ['.cmt-result'] },
  });
  assert.equal(r.verified, true, JSON.stringify(r.steps));
  const v = (r.steps || []).find((x) => x.step === 'verify');
  assert.ok(/第一条/.test(v?.detail || ''), v?.detail);
});

await test('抖音声明了 commentTrigger 与短信验证选择器', async () => {
  const { PLATFORMS } = await import('../src/lib/platforms.js');
  const d = PLATFORMS.douyin;
  assert.ok(d.commentTrigger?.some((x) => x.includes('comment-input-inner-container')), '缺 commentTrigger');
  assert.ok(d.selectors.smsVerification?.some((x) => x.includes('uc-ui-input_content')), '缺短信验证选择器');
  assert.ok(d.selectors.commentResultItem?.some((x) => x.includes('comment-list')), '缺评论结果比对选择器');
  assert.equal(d.selectors.commentSubmit[0], '.commentInput-right-ct > div > span:last-child', '发送按钮首选应来自 AiToEarn 实测');
  assert.equal(d.selectors.commentInput[0], '.richtext-container [contenteditable="true"]', '输入框首选应来自 AiToEarn 实测');
});

/* ---------------- 真实抖音 DOM 形状（2026-09-22 CDP 实测） ---------------- */
console.log('\n[7] 抖音评论条目：AiToEarn 结构（comment-list > div > comment-item）');

// 按真实 DOM 造一条评论：
//   comment-item
//   ├─ .comment-item-info-wrap  （作者头像/昵称）
//   │    └─ div  （昵称）
//   ├─ div                       （正文容器，紧邻 info-wrap）
//   │    └─ span                 （正文）
//   └─ .comment-item-stats-container
//        └─ div > p > span       （点赞数）
function makeDouyinComment({ author, text, like }) {
  const nick = makeEl({ text: author });
  const info = makeEl({ className: 'comment-item-info-wrap', qsaAll: [nick] });
  info.querySelector = (sel) => (sel === 'div' ? nick : null);
  const span = makeEl({ text });
  const body = makeEl({ className: 'comment-item-body', qsaAll: [span] });
  body.querySelector = (sel) => (sel === 'span' ? span : null);
  const likeSpan = makeEl({ text: String(like) });
  const likeP = makeEl({ qsaAll: [likeSpan] });
  likeP.querySelector = (sel) => (sel === 'span' ? likeSpan : null);
  const likeDiv = makeEl({ qsaAll: [likeP] });
  likeDiv.querySelector = (sel) => (sel === 'p' ? likeP : null);
  const stats = makeEl({ className: 'comment-item-stats-container', qsaAll: [likeDiv] });
  stats.querySelector = (sel) => (sel === 'div' ? likeDiv : null);
  const item = makeEl({
    attrs: { 'data-e2e': 'comment-item' },
    className: 'comment-item',
    qsaAll: [info, body, stats],
  });
  item.querySelector = (sel) => {
    if (sel === '.comment-item-info-wrap + div span') return span;
    if (sel === '.comment-item-info-wrap + div') return body;
    if (sel === '.comment-item-info-wrap div') return nick;
    if (sel === '.comment-item-stats-container div p span') return likeSpan;
    return null;
  };
  return item;
}

const DY_SEL = {
  commentItem: ['[data-e2e="comment-list"] > div > [data-e2e="comment-item"]'],
  commentText: ['[data-e2e="comment-item"] .comment-item-info-wrap + div span', '.comment-item-info-wrap + div span'],
  commentAuthor: ['[data-e2e="comment-item"] .comment-item-info-wrap div', '.comment-item-info-wrap div'],
  // 桩按纯 class 逐级查找；platforms.js 里带 [data-e2e] 前缀的首选项在真实页面上才生效
  commentLike: ['.comment-item-stats-container div p span'],
  commentScroll: ['[data-e2e="comment-list"]'],
};

await test('AiToEarn 结构的三条评论：正文/作者/点赞数全都能抓到', async () => {
  const items = [
    makeDouyinComment({ author: '书法爱好者', text: '字写得真好，求教程', like: 12 }),
    makeDouyinComment({ author: '老李', text: '这个多少钱出？', like: 3 }),
    makeDouyinComment({ author: '阿珍', text: '同款求链接', like: 0 }),
  ];
  installDom({ '.ready': makeEl(), '[data-e2e="comment-list"] > div > [data-e2e="comment-item"]': items });
  const r = await injectHarvest({
    selectors: DY_SEL,
    commentMax: 10,
    commentScrolls: 0,
    readyTimeoutMs: 100,
  });
  assert.equal(r.comments.length, 3, JSON.stringify(r.comments));
  assert.equal(r.comments[0].text, '字写得真好，求教程', '正文应取 span 而非整个条目');
  assert.equal(r.comments[0].author, '书法爱好者', '作者应取 info-wrap 里的 div');
  assert.equal(r.comments[0].like, 12, '点赞数应取 stats-container 里的 span');
  assert.equal(r.discovered.comments, false, '配置选择器命中了，不该走自动发现');
});

await test('正文里夹了表情图片：克隆后把 img 换成 alt，句子不被截断', async () => {
  // 真实情况：span 里混着文字和 <img alt="[大笑]">
  const span = makeEl({ text: '好看[大笑]' });
  const body = makeEl({ qsaAll: [span] });
  body.querySelector = () => span;
  const info = makeEl({ qsaAll: [makeEl({ text: '网友A' })] });
  info.querySelector = () => makeEl({ text: '网友A' });
  const item = makeEl({ qsaAll: [info, body] });
  item.querySelector = (sel) => (sel.includes('span') ? span : sel.includes('div') && !sel.includes('stats') ? body : null);
  installDom({ '.ready': makeEl(), '[data-e2e="comment-list"] > div > [data-e2e="comment-item"]': [item] });
  const r = await injectHarvest({ selectors: DY_SEL, commentMax: 5, commentScrolls: 0, readyTimeoutMs: 100 });
  assert.equal(r.comments.length, 1);
  assert.ok(/好看/.test(r.comments[0].text), '正文要完整：' + r.comments[0].text);
});

await test('回归：评论区还在「加载中」时，不会把占位当成评论收进来', async () => {
  // 抖音实测：评论加载完之前，DOM 里是「加载中」「服务异常，刷新拉取数据」占位
  const placeholder = makeDouyinComment({ author: '', text: '加载中', like: 0 });
  const broken = makeDouyinComment({ author: '', text: '服务异常，刷新拉取数据', like: 0 });
  installDom({ '.ready': makeEl(), '[data-e2e="comment-list"] > div > [data-e2e="comment-item"]': [placeholder, broken] });
  const r = await injectHarvest({
    selectors: DY_SEL,
    commentMax: 10,
    commentScrolls: 0,
    readyTimeoutMs: 100,
    commentReadyTimeoutMs: 200, // 占位永远不算「就绪」，会等满这个时间
  });
  assert.equal(r.comments.length, 0, '占位不该被当成评论：' + JSON.stringify(r.comments));
});

await test('回归：占位之后真实评论渲染出来了，能等到并抓到', async () => {
  // 模拟真实时序：先返回占位，200ms 后 registry 换成真评论
  const placeholder = makeDouyinComment({ author: '', text: '加载中', like: 0 });
  const real = makeDouyinComment({ author: '书法爱好者', text: '字写得真好，求教程', like: 12 });
  const key = '[data-e2e="comment-list"] > div > [data-e2e="comment-item"]';
  installDom({ '.ready': makeEl(), [key]: [placeholder] });
  setTimeout(() => registry.set(key, { single: real, all: [real] }), 200);
  const r = await injectHarvest({
    selectors: DY_SEL,
    commentMax: 10,
    commentScrolls: 0,
    readyTimeoutMs: 100,
    commentReadyTimeoutMs: 5000,
  });
  assert.equal(r.comments.length, 1, '应该等到真评论：' + JSON.stringify(r.comments));
  assert.equal(r.comments[0].author, '书法爱好者');
});

await test('回归：没配 commentTrigger 时也不会卡住（自动发现兜底）', async () => {
  const editor = makeEl({ className: 'richtext', editable: true });
  installDom({ '.ready': makeEl(), '.cmt-input': editor });
  const r = await injectInteract({
    ...baseCfg({ action: 'comment', content: '不错的分享' }),
    // ★ 故意不传 commentTrigger（模拟旧的 selectorCfg 漏带平台级字段的 bug）
    selectors: { ...S(), commentTrigger: undefined },
  });
  assert.ok(!/找不到评论输入框/.test(r.error || ''), '没 trigger 也该能走自动发现：' + r.error);
});

console.log(`\n结果：${passed} 通过，${failures.length} 失败\n`);
if (failures.length) {
  for (const f of failures) console.error(`失败：${f.name} → ${f.error}`);
  process.exit(1);
}
