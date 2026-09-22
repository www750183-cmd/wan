// 纯逻辑冒烟测试：node tests/smoke.mjs
// 所有模块都把 chrome.* 调用放在函数体内，因此可在 Node 下直接导入。
import assert from 'node:assert/strict';

import { parseCount, toCsv, uniqBy, truncate, clamp, jitterSleep } from '../src/lib/util.js';
import {
  PLATFORMS, PLATFORM_KEYS, detectPlatform, extractUrls,
  workIdFromUrl, workUrl, isWorkUrl, resolveSelectors, resolveState,
} from '../src/lib/platforms.js';
import { buildPlan } from '../src/lib/collect.js';
import { buildResultText, overallStatus, markForLike, markForComment, MARK } from '../src/lib/autoflow.js';
import { probeVerdict, selectorDot, selectorNote, SELECTOR_KEYS, SELECTOR_KIND } from '../src/lib/probe.js';
import { logsToCsv, logsToJson, logsToMarkdown, LOG_COLUMNS, fileName, STATUS_LABEL } from '../src/lib/export.js';
import { mergeSettings, DEFAULT_SETTINGS } from '../src/lib/store.js';
import { buildInsightPrompt, parseInsight, validateDrafts, pickDraft, fallbackDraft, similarity } from '../src/lib/insight.js';


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

console.log('\n[1] util');

await test('parseCount 解析中文/英文计数', () => {
  assert.equal(parseCount('1.2万'), 12000);
  assert.equal(parseCount('3.4w'), 34000);
  assert.equal(parseCount('12.5k'), 12500);
  assert.equal(parseCount('1,234'), 1234);
  assert.equal(parseCount('2亿'), 200000000);
  assert.equal(parseCount('999'), 999);
  assert.equal(parseCount(''), null);
  assert.equal(parseCount('赞'), null);
  assert.equal(parseCount(42), 42);
});

await test('toCsv / uniqBy / truncate / clamp 正常', () => {
  assert.equal(toCsv([['a', 'b,c'], ['1', '2']]), 'a,"b,c"\r\n1,2');
  assert.equal(uniqBy([{ u: 'a' }, { u: 'a' }, { u: 'b' }], (x) => x.u).length, 2);
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(clamp(999, 1, 10, 5), 10);
  assert.equal(clamp('x', 1, 10, 5), 5);
});

await test('jitterSleep 在范围内返回', async () => {
  const t0 = Date.now();
  await jitterSleep(60, 20);
  const dt = Date.now() - t0;
  assert.ok(dt >= 30 && dt < 400, `耗时 ${dt}ms 不合理`);
});

console.log('\n[2] platforms');

await test('detectPlatform 识别三平台（含子域）', () => {
  assert.equal(detectPlatform('https://www.douyin.com/video/123'), 'douyin');
  assert.equal(detectPlatform('https://v.douyin.com/abc/'), 'douyin');
  assert.equal(detectPlatform('https://www.xiaohongshu.com/explore/abc'), 'xhs');
  assert.equal(detectPlatform('http://xhslink.com/a/b'), 'xhs');
  assert.equal(detectPlatform('https://channels.weixin.qq.com/platform/post/list'), 'wxSph');
  assert.equal(detectPlatform('https://example.com/x'), null);
  assert.equal(detectPlatform('not a url'), null);
});

await test('extractUrls 从分享文案里抠链接', () => {
  const text = '7.68 复制打开抖音，看看【某某】https://v.douyin.com/iABC123/ 很有意思\nhttps://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f60718293a';
  const urls = extractUrls(text);
  assert.equal(urls.length, 2);
  assert.ok(urls[0].startsWith('https://v.douyin.com/'));
  assert.ok(urls[1].includes('xiaohongshu.com/explore/'));
});

await test('extractUrls 去掉句末标点', () => {
  const urls = extractUrls('看这个 https://www.douyin.com/video/7212345678901234567。');
  assert.equal(urls[0], 'https://www.douyin.com/video/7212345678901234567');
});

await test('workIdFromUrl 各平台的 ID 形态', () => {
  assert.equal(workIdFromUrl('douyin', 'https://www.douyin.com/video/7212345678901234567'), '7212345678901234567');
  assert.equal(workIdFromUrl('douyin', 'https://www.douyin.com/note/7212345678901234567'), '7212345678901234567');
  assert.equal(workIdFromUrl('douyin', 'https://www.douyin.com/?modal_id=7212345678901234567'), '7212345678901234567');
  assert.equal(workIdFromUrl('xhs', 'https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f60718293a'), '65f0a1b2c3d4e5f60718293a');
  assert.equal(workIdFromUrl('xhs', 'https://www.xiaohongshu.com/discovery/item/65f0a1b2c3d4e5f60718293a'), '65f0a1b2c3d4e5f60718293a');
  assert.equal(workIdFromUrl('douyin', 'https://www.douyin.com/user/MS4wLjABAAAA'), '');
});

await test('isWorkUrl / workUrl 往返一致', () => {
  const url = workUrl('douyin', '7212345678901234567');
  assert.equal(url, 'https://www.douyin.com/video/7212345678901234567');
  assert.equal(isWorkUrl('douyin', url), true);
  assert.equal(isWorkUrl('douyin', 'https://www.douyin.com/user/MS4wLjABAAAA'), false);
  assert.equal(workUrl('wxSph', 'x'), '');
});

await test('三平台都声明了能力矩阵，且视频号不支持互动', () => {
  for (const k of PLATFORM_KEYS) {
    const p = PLATFORMS[k];
    assert.ok(p.name, `${k} 缺 name`);
    assert.ok(p.supports && typeof p.supports === 'object', `${k} 缺 supports`);
    assert.ok(p.selectors && typeof p.selectors === 'object', `${k} 缺 selectors`);
    assert.ok(Array.isArray(p.selectors.loginFlag), `${k} 的 loginFlag 应为数组（备选链）`);
  }
  assert.equal(PLATFORMS.wxSph.supports.like, false, '视频号不应声明支持点赞');
  assert.equal(PLATFORMS.wxSph.supports.comment, false, '视频号不应声明支持评论');
  assert.equal(PLATFORMS.douyin.supports.like, true);
  assert.equal(PLATFORMS.xhs.supports.comment, true);
});

await test('resolveSelectors 把用户自定义放在备选链最前', () => {
  const s = resolveSelectors('douyin', { likeButton: ['.my-like'] });
  assert.equal(s.likeButton[0], '.my-like');
  assert.ok(s.likeButton.length > 1, '应保留内置备选');
  assert.ok(s.likeButton.includes('[data-e2e="video-player-digg"]'));
});

await test('resolveSelectors 支持字符串与去重', () => {
  const s = resolveSelectors('xhs', { likeButton: '.like-wrapper' });
  assert.equal(s.likeButton[0], '.like-wrapper');
  assert.equal(new Set(s.likeButton).size, s.likeButton.length, '不应有重复项');
});

await test('resolveState 支持覆盖', () => {
  const base = resolveState('douyin', 'likeState', {});
  assert.equal(base.type, 'toggle', '抖音应读 data-e2e-state 属性');
  assert.ok(base.onSelector.includes('digged'));
  assert.ok(base.offSelector.includes('no-digged'));
  const over = resolveState('douyin', 'likeState', { likeStateOverride: { type: 'useHref', selector: 'x', equals: 'y' } });
  assert.equal(over.type, 'useHref');
  assert.equal(resolveState('wxSph', 'likeState', {}).type, 'none');
});

console.log('\n[3] buildPlan');

const settings = mergeSettings({});

await test('buildPlan 区分链接 / 主页 / 搜索', () => {
  const plan = buildPlan({
    links: 'https://www.douyin.com/video/7212345678901234567\nhttps://www.douyin.com/user/MS4wLjABAAAA\nhttps://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f60718293a',
    keywords: '露营, 咖啡',
  }, settings);
  assert.equal(plan.links.length, 2, '两条作品链接');
  assert.equal(plan.userPages.length, 1, '一条主页');
  assert.ok(plan.searches.length >= 2, `搜索任务应 ≥2（抖音/小红书 × 2 关键词），实际 ${plan.searches.length}`);
  assert.ok(plan.searches.some((s) => s.platform === 'douyin' && s.keyword === '露营'));
  assert.ok(plan.searches.every((s) => s.platform !== 'wxSph'), '视频号不应生成搜索任务');
});

await test('buildPlan 过滤未启用的平台', () => {
  const s2 = mergeSettings({ enabledPlatforms: { douyin: true, xhs: false, wxSph: false } });
  const plan = buildPlan({
    links: 'https://www.douyin.com/video/7212345678901234567\nhttps://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f60718293a',
    keywords: '露营',
  }, s2);
  assert.equal(plan.links.length, 1);
  assert.ok(plan.searches.every((x) => x.platform === 'douyin'));
});

await test('buildPlan 忽略注释行与非平台链接', () => {
  const plan = buildPlan({
    links: '# 这是注释\nhttps://example.com/x\nhttps://www.douyin.com/video/7212345678901234567',
    keywords: '',
  }, settings);
  assert.equal(plan.links.length, 1);
  assert.equal(plan.userPages.length, 0);
  assert.equal(plan.searches.length, 0);
});

await test('buildPlan 空输入不报错', () => {
  const plan = buildPlan({}, settings);
  assert.deepEqual(plan, { links: [], userPages: [], searches: [] });
});

console.log('\n[4] 固定流程的结果标记');

await test('buildResultText 拼出「点赞✅评论✅」', () => {
  assert.equal(buildResultText({ doLike: true, doComment: true, like: MARK.ok, comment: MARK.ok }), '点赞✅评论✅');
  assert.equal(buildResultText({ doLike: true, doComment: true, like: MARK.ok, comment: MARK.fail }), '点赞✅评论❌');
  assert.equal(buildResultText({ doLike: true, doComment: true, like: MARK.skip, comment: MARK.ok }), '点赞⏭评论✅');
  assert.equal(buildResultText({ doLike: false, doComment: true, like: MARK.fail, comment: MARK.ok }), '评论✅');
  assert.equal(buildResultText({ doLike: false, doComment: false, like: MARK.fail, comment: MARK.fail }), '未执行');
});

await test('overallStatus 判定整体状态', () => {
  assert.equal(overallStatus({ doLike: true, doComment: true, like: MARK.ok, comment: MARK.ok }, false), 'ok');
  assert.equal(overallStatus({ doLike: true, doComment: true, like: MARK.ok, comment: MARK.skip }, false), 'ok');
  assert.equal(overallStatus({ doLike: true, doComment: true, like: MARK.ok, comment: MARK.fail }, false), 'partial');
  assert.equal(overallStatus({ doLike: true, doComment: true, like: MARK.fail, comment: MARK.fail }, false), 'failed');
  assert.equal(overallStatus({ doLike: true, doComment: true, like: MARK.ok, comment: MARK.ok }, true), 'dry-run');
  assert.equal(overallStatus({ doLike: false, doComment: false, like: MARK.skip, comment: MARK.skip }, false), 'failed');
});

await test('「已提交未确证」不算失败，算部分成功', () => {
  assert.equal(overallStatus({ doLike: true, doComment: true, like: MARK.ok, comment: MARK.warn }, false), 'partial');
});

await test('回归：试跑模式下点赞也要显示 ✅（之前错误地显示 ⏭）', () => {
  assert.equal(markForLike({ ok: true, dryRun: true }), MARK.ok,
    '试跑走通却给了 ⏭，用户会以为没成功');
  assert.equal(markForComment({ ok: true, dryRun: true }), MARK.ok,
    '试跑走通却给了 ⏭，用户会以为没成功');
});

await test('回归：试跑成功时，整行结果就是「点赞✅评论✅」', () => {
  const like = markForLike({ ok: true, dryRun: true });
  const comment = markForComment({ ok: true, dryRun: true });
  assert.equal(buildResultText({ doLike: true, doComment: true, like, comment }), '点赞✅评论✅');
  assert.equal(overallStatus({ doLike: true, doComment: true, like, comment }, true), 'dry-run');
});

await test('markForLike：已点赞 → ⏭；失败 → ❌', () => {
  assert.equal(markForLike({ ok: true, alreadyInTarget: true }), MARK.skip);
  assert.equal(markForLike({ ok: true, alreadyInTarget: true, dryRun: true }), MARK.skip);
  assert.equal(markForLike({ ok: false, error: '找不到点赞按钮' }), MARK.fail);
  assert.equal(markForLike({ needLogin: true }), MARK.fail);
  assert.equal(markForLike(null), MARK.fail);
});

await test('markForComment：真发成功 → ✅；未确证 → ⚠；失败 → ❌', () => {
  assert.equal(markForComment({ ok: true, verified: true }), MARK.ok);
  assert.equal(markForComment({ ok: true, verified: false }), MARK.warn);
  assert.equal(markForComment({ ok: false }), MARK.fail);
  assert.equal(markForComment(undefined), MARK.fail);
});

await test('试跑与真跑的标记语义一致（同一套 ✅/❌/⏭）', () => {
  // 同一个「按钮在、状态读得出」的正常页面，试跑与真跑都该是 ✅
  assert.equal(markForLike({ ok: true, dryRun: true }), markForLike({ ok: true, dryRun: false }));
});

console.log('\n[5] 日志导出');

const sampleLogs = [
  {
    at: '2026-09-21T02:00:00.000Z', platform: 'douyin', platformName: '抖音',
    title: '手写小楷《心经》扇面', url: 'https://www.douyin.com/video/721',
    likeCount: 12000, commentCount: 345, favoriteCount: 88,
    commentFocus: '大家在问价和求教程',
    comment: '去年在老师那儿收过一把差不多的，半生熟写小楷确实顺手',
    result: '点赞✅评论✅', status: 'ok', message: '',
  },
  {
    at: '2026-09-21T02:05:00.000Z', platform: 'xhs', platformName: '小红书',
    title: '轻量化露营装备清单', url: 'https://www.xiaohongshu.com/explore/abc',
    likeCount: 3400, commentCount: 156, favoriteCount: null,
    commentFocus: '求链接', comment: '这套配置我去年也用过，炉头确实稳',
    result: '点赞✅评论❌', status: 'partial', message: '评论失败：找不到评论输入框',
  },
];

await test('日志字段就是用户要的那 8 项，顺序固定', () => {
  const names = LOG_COLUMNS.map((c) => c[1]);
  assert.deepEqual(names, ['视频标题', '视频链接', '点赞数', '评论数', '收藏数', '评论区关注点', '评论内容', '执行结果']);
});

await test('logsToCsv 表头与内容正确、带 BOM、转义正确', () => {
  const csv = logsToCsv(sampleLogs);
  assert.ok(csv.startsWith('\uFEFF'), '应带 BOM 以便 Excel 打开');
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 3, '表头 + 2 行');
  assert.ok(lines[0].includes('视频标题'));
  assert.ok(lines[0].includes('执行结果'));
  assert.ok(lines[1].includes('点赞✅评论✅'));
  assert.ok(lines[1].includes('12000'));
  assert.ok(lines[2].includes('点赞✅评论❌'));
});

await test('logsToCsv 里空值不写成 null/undefined', () => {
  const csv = logsToCsv(sampleLogs);
  assert.ok(!csv.includes('null'), csv);
  assert.ok(!csv.includes('undefined'), csv);
});

await test('logsToJson 结构正确、含平台信息', () => {
  const obj = JSON.parse(logsToJson(sampleLogs));
  assert.equal(obj.count, 2);
  assert.equal(obj.logs[0]['视频标题'], '手写小楷《心经》扇面');
  assert.equal(obj.logs[0]['收藏数'], 88);
  assert.equal(obj.logs[1]['收藏数'], '', '空值应转成空字符串');
  assert.equal(obj.logs[0]['执行结果'], '点赞✅评论✅');
});

await test('logsToMarkdown 生成 8 列表格且标题带链接', () => {
  const md = logsToMarkdown(sampleLogs, {
    startedAt: '2026-09-21T02:00:00Z', finishedAt: '2026-09-21T02:10:00Z',
    doLike: true, doComment: true, dryRun: true, ok: 1, partial: 1, failed: 0, total: 2,
  });
  assert.ok(md.includes('# 运行日志'));
  assert.ok(md.includes('演练模式'));
  assert.ok(md.includes('抓取 → 点赞 → 评论'));
  const header = md.split('\n').find((l) => l.includes('视频标题'));
  assert.ok(header.includes('执行结果'));
  assert.equal((header.match(/\|/g) || []).length, LOG_COLUMNS.length + 1, '表头列数不对');
  assert.ok(md.includes('[手写小楷《心经》扇面](https://www.douyin.com/video/721)'), '标题应带链接');
});

await test('fileName 合法', () => {
  assert.ok(/^运行日志_\d{8}_\d{4}\.csv$/.test(fileName('运行日志', 'csv')));
});

await test('STATUS_LABEL 覆盖全部状态', () => {
  for (const k of ['ok', 'partial', 'failed', 'dry-run', 'skipped']) assert.ok(STATUS_LABEL[k], k);
});

console.log('\n[6] 默认配置自洽');

await test('默认设置安全（dryRun 默认开、限速合理）', () => {
  const s = mergeSettings(null);
  assert.equal(s.dryRun, true, '默认必须是演练模式');
  assert.ok(s.likeGapMs[0] >= 5000, '点赞间隔下限不应太低');
  assert.ok(s.commentGapMs[0] >= 10000, '评论间隔下限不应太低');
  assert.ok(s.likeGapMs[1] > s.likeGapMs[0]);
  assert.ok(s.commentGapMs[1] > s.commentGapMs[0]);
  assert.ok(s.dailyLimit > 0 && s.dailyLimit <= 2000);
  assert.ok(s.maxConsecutiveFailures >= 1);
  assert.equal(s.skipAlreadyDone, true);
});

await test('默认设置里没有任何真实凭据', () => {
  const json = JSON.stringify(DEFAULT_SETTINGS);
  assert.ok(!/sk-[A-Za-z0-9]{10,}/.test(json), '默认设置里出现了疑似 Key 的值');
  assert.equal(DEFAULT_SETTINGS.llm.apiKey, '', 'llm.apiKey 默认必须是空字符串');
  // 允许存在 apiKey / token 这类**字段名**（空值占位），但不允许有非空默认值
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS.llm || {})) {
    if (/^(api_?key|token|secret|password|cookie)$/i.test(k)) assert.equal(v, '', `llm.${k} 默认值必须为空`);
  }
});

console.log('\n[7] 全自动评论：提示词、解析与校验');

const autoSettings = mergeSettings({});
const sampleContent = {
  platform: 'douyin', platformName: '抖音',
  title: '手写小楷《心经》扇面',
  desc: '写了三天的扇面，纸是宣纸，笔是狼毫，喜欢的可以看看 #书法 #小楷 #手写',
  tags: ['#书法', '#小楷', '#手写'],
  author: '砚台边的小李', likeCount: 12000, commentCount: 345,
  url: 'https://www.douyin.com/video/7212345678901234567',
};
const sampleComments = [
  { author: '张三', text: '这个多少钱出？', like: 234 },
  { author: '李四', text: '字写得真好', like: 87 },
  { author: '王五', text: '求教程', like: 12 },
];

await test('buildInsightPrompt 把视频信息、评论区、身份意图都写进了提示词', () => {
  const p = buildInsightPrompt(autoSettings, sampleContent, sampleComments);
  assert.ok(p.includes('手写小楷'), '缺标题');
  assert.ok(p.includes('#书法'), '缺标签');
  assert.ok(p.includes('这个多少钱出？'), '缺评论区原文');
  assert.ok(p.includes('身份：'), '缺身份');
  assert.ok(p.includes('意图：'), '缺意图');
  assert.ok(p.includes('禁词'), '缺禁词约束');
  assert.ok(/drafts 输出 \d+ 条/.test(p), '缺 drafts 数量要求');
  assert.ok(p.includes('commentFocus'), '缺输出结构');
});

await test('buildInsightPrompt 在没抓到评论时也能生成（不崩）', () => {
  const p = buildInsightPrompt(autoSettings, sampleContent, []);
  assert.ok(p.includes('没有抓到评论'));
});

await test('parseInsight 解析标准 JSON', () => {
  const r = parseInsight(JSON.stringify({
    summary: '博主展示手写小楷扇面',
    commentFocus: '大家在问价格和求教程',
    drafts: [{ text: '我买过同款的不知道是不是博主这种', reason: '同好口吻' }],
  }));
  assert.equal(r.ok, true);
  assert.equal(r.summary, '博主展示手写小楷扇面');
  assert.equal(r.drafts.length, 1);
  assert.equal(r.drafts[0].text, '我买过同款的不知道是不是博主这种');
});

await test('parseInsight 兼容代码块包裹与前后废话', () => {
  const r = parseInsight('好的，结果如下：\n```json\n{"summary":"S","commentFocus":"F","drafts":[{"text":"一句评论内容"}]}\n```\n以上。');
  assert.equal(r.ok, true);
  assert.equal(r.drafts[0].text, '一句评论内容');
});

await test('parseInsight 在模型胡说时安全降级', () => {
  const r = parseInsight('抱歉我无法完成这个请求。');
  assert.equal(r.ok, false);
  assert.deepEqual(r.drafts, []);
  assert.ok(r.raw.length > 0);
});

await test('parseInsight 容忍 drafts 是字符串数组', () => {
  const r = parseInsight('{"summary":"s","drafts":["第一句评论内容","第二句评论内容"]}');
  assert.equal(r.drafts.length, 2);
  assert.equal(r.drafts[0].text, '第一句评论内容');
});

await test('validateDrafts 拦掉太短/太长/禁词/链接/@/重复', () => {
  const s = mergeSettings({ auto: { minLen: 4, maxLen: 30, bannedWords: '微信,私信', similarityThreshold: 0.6 } });
  const { valid, rejected } = validateDrafts([
    { text: '太短' },
    { text: '这条评论故意写得非常非常非常非常非常非常长超过三十个字看看会不会被拦下来' },
    { text: '想要的加我微信细聊' },
    { text: '看这里 https://example.com/x' },
    { text: '@张三 你觉得呢这件作品' },
    { text: '这个多少钱出？' },                 // 与已有评论完全一致
    { text: '我买过同款的不知道是不是博主这种' },   // 应该通过
  ], s, sampleComments);
  assert.equal(valid.length, 1, JSON.stringify(valid));
  assert.equal(valid[0].text, '我买过同款的不知道是不是博主这种');
  assert.equal(rejected.length, 6);
  assert.ok(rejected.some((x) => x.reason.includes('太短')), JSON.stringify(rejected));
  assert.ok(rejected.some((x) => x.reason.includes('太长')));
  assert.ok(rejected.some((x) => x.reason.includes('含禁词')));
  assert.ok(rejected.some((x) => x.reason.includes('含链接')));
  assert.ok(rejected.some((x) => x.reason.includes('@')));
  assert.ok(rejected.some((x) => x.reason.includes('重复')));
});

await test('validateDrafts 对近似改写的评论也能识别为重复', () => {
  const s = mergeSettings({ auto: { minLen: 4, maxLen: 60, bannedWords: '', similarityThreshold: 0.5 } });
  const { valid, rejected } = validateDrafts([{ text: '这个多少钱出？?' }], s, sampleComments);
  assert.equal(valid.length, 0);
  assert.ok(rejected[0].reason.includes('重复'));
});

await test('similarity 单调合理', () => {
  assert.ok(similarity('我买过同款的', '我买过同款的') > 0.9);
  assert.ok(similarity('今天天气不错', '完全不相干的内容') < 0.1);
});

await test('pickDraft 支持 first / random', () => {
  const drafts = [{ text: 'A' }, { text: 'B' }, { text: 'C' }];
  assert.equal(pickDraft(drafts, mergeSettings({ auto: { draftStrategy: 'first' } })).text, 'A');
  const r = pickDraft(drafts, mergeSettings({ auto: { draftStrategy: 'random' } }));
  assert.ok(['A', 'B', 'C'].includes(r.text));
  assert.equal(pickDraft([], autoSettings), null);
});

await test('fallbackDraft 在评论区问价时给出同好口吻的兜底', () => {
  const fb = fallbackDraft(autoSettings, sampleContent, { commentFocus: '大家在问多少钱出' });
  assert.ok(fb.includes('买过'), fb);
  assert.ok(fb.length >= 8);
});

await test('全自动相关默认值安全且自洽', () => {
  const s = mergeSettings(null);
  assert.equal(s.dryRun, true, '全自动默认必须是演练模式');
  assert.ok(s.auto.maxPerRun >= 1 && s.auto.maxPerRun <= 50);
  assert.ok(s.auto.minLen < s.auto.maxLen);
  assert.ok(s.auto.maxLen <= 60, '评论太长容易被当广告');
  assert.ok(s.auto.bannedWords.includes('微信'), '默认禁词应包含联系方式类');
  assert.equal(s.llm.apiKey, '', '不得内置 Key');
  assert.ok(/manbouapi|openai|deepseek/.test(s.llm.baseURL));
});

console.log('\n[9] 网页元素自检的判定');

/** 复刻用户真实截图里的自检结果 */
const realFields = [
  { key: 'loginFlag', hit: false },
  { key: 'readyFlag', hit: true },
  { key: 'title', hit: true },
  { key: 'desc', hit: true },
  { key: 'likeButton', hit: true },
  { key: 'collectButton', hit: true },
  { key: 'likeCount', hit: true },
  { key: 'commentCount', hit: true },
  { key: 'favoriteCount', hit: true },
  { key: 'commentItem', hit: true },
  { key: 'commentText', hit: true },
  { key: 'commentAuthor', hit: true },
  { key: 'commentScroll', hit: true },
  { key: 'commentInput', hit: true },
  { key: 'commentSubmit', hit: true },
  { key: 'collectLinks', hit: false },
];

await test('回归：loginFlag 没命中不算问题（它是反向语义：不命中=已登录）', () => {
  const v = probeVerdict({ loggedOut: false, fields: realFields });
  assert.equal(v.level, 'ok', JSON.stringify(v));
  assert.ok(!(v.missing || []).includes('loginFlag'), 'loginFlag 不该出现在「需要修」里');
});

await test('回归：collectLinks 没命中不算问题（它只在列表页用）', () => {
  const v = probeVerdict({ loggedOut: false, fields: realFields });
  assert.ok(!(v.missing || []).includes('collectLinks'), 'collectLinks 不该出现在「需要修」里');
});

await test('用户真实数据 → 结论是「可以开跑」', () => {
  const v = probeVerdict({ loggedOut: false, fields: realFields });
  assert.equal(v.level, 'ok');
  assert.ok(/全都能找到|全部命中/.test(v.title + v.detail), v.title);
  assert.equal(v.missing, undefined);
});

await test('真有选择器失效时 → 明确列出要修哪个', () => {
  const fields = realFields.map((f) => (f.key === 'likeButton' ? { key: 'likeButton', hit: false } : f));
  const v = probeVerdict({ loggedOut: false, fields });
  assert.equal(v.level, 'warn');
  assert.deepEqual(v.missing, ['likeButton']);
  assert.ok(v.title.includes('1 项'), v.title);
});

await test('未登录时优先报未登录，而不是列一堆选择器', () => {
  const v = probeVerdict({ loggedOut: true, fields: realFields });
  assert.equal(v.level, 'err');
  assert.ok(v.title.includes('没有登录'), v.title);
});

await test('selectorDot：loginFlag 反着显示，collectLinks 未命中不标红', () => {
  assert.equal(selectorDot('loginFlag', false), 'ok', '已登录应该显示绿色');
  assert.equal(selectorDot('loginFlag', true), 'bad', '检测到未登录标记才该红');
  assert.equal(selectorDot('collectLinks', false), 'skip', '详情页不需要，不该标红');
  assert.equal(selectorDot('likeButton', false), 'bad', '真正失效的要标红');
  assert.equal(selectorDot('likeButton', true), 'ok');
});

await test('selectorNote 给出人话说明', () => {
  assert.ok(selectorNote('loginFlag', false).includes('已登录'));
  assert.ok(selectorNote('loginFlag', true).includes('未登录'));
  assert.ok(selectorNote('collectLinks', false).includes('详情页不需要'));
  assert.equal(selectorNote('likeButton', true), '');
});

await test('SELECTOR_KEYS 与语义分类自洽', () => {
  assert.ok(SELECTOR_KEYS.includes('loginFlag'));
  assert.ok(SELECTOR_KEYS.includes('favoriteCount'));
  for (const k of Object.keys(SELECTOR_KIND)) {
    assert.ok(SELECTOR_KEYS.includes(k), `${k} 有语义分类但不在键列表里`);
  }
});

console.log('\n[10] 抖音选择器（按真实 DOM 校准）');

await test('抖音用 data-e2e 系列属性，而不是混淆 class', () => {
  const d = PLATFORMS.douyin.selectors;
  const flat = JSON.stringify(d);
  assert.ok(d.likeButton.some((x) => /data-e2e-state="video-player-no-digged"/.test(x)), '点赞按钮应含 no-digged');
  assert.ok(d.likeButton.some((x) => /data-e2e-state="video-player-is-digged"/.test(x)), '点赞按钮应含 is-digged（2026-09-23 实测修正）');
  assert.ok(d.collectButton.some((x) => /data-e2e="video-player-collect"/.test(x)), '收藏按钮应含 video-player-collect');
  assert.ok(d.commentButton.some((x) => /data-e2e="feed-comment-icon"/.test(x)), '评论按钮应含 feed-comment-icon');
  assert.ok(!/DSx9bBDr|Lr3jEZec|tJr1fTDq/.test(flat), '不该用随时会变的混淆 class');
});

await test('抖音点赞状态读 data-e2e-state，不再数 class 个数', () => {
  const st = PLATFORMS.douyin.likeState;
  assert.equal(st.type, 'toggle');
  assert.equal(st.onSelector, '[data-e2e-state="video-player-is-digged"]');
  assert.equal(st.offSelector, '[data-e2e-state="video-player-no-digged"]');
});

await test('抖音收藏状态同样读属性', () => {
  const st = PLATFORMS.douyin.collectState;
  assert.equal(st.type, 'toggle');
  assert.ok(st.offSelector.includes('no-collect'));
});

await test('抖音声明了展开评论区的入口（评论默认收起）', () => {
  assert.ok(Array.isArray(PLATFORMS.douyin.openCommentsBy), '缺 openCommentsBy');
  assert.ok(PLATFORMS.douyin.openCommentsBy.some((x) => /feed-comment-icon/.test(x)));
});

await test('三个计数都能从对应按钮容器里取', () => {
  const d = PLATFORMS.douyin.selectors;
  assert.ok(d.likeCount.some((x) => /digged|digg/.test(x)));
  assert.ok(d.commentCount.some((x) => /feed-comment-icon/.test(x)));
  assert.ok(d.favoriteCount.some((x) => /video-player-collect/.test(x)));
});

// —— 2026-09-22 实测校准（CDP 连真实抖音详情页 /video/{id}）——
await test('实测：详情页标题在 detail-video-info h1 里，desc 选择器跟着改', () => {
  const d = PLATFORMS.douyin.selectors;
  assert.ok(d.title.some((x) => x === '[data-e2e="detail-video-info"] h1'), '标题首选 detail-video-info h1');
  assert.ok(d.desc.some((x) => x === '[data-e2e="detail-video-info"] h1'), 'desc 也走同一路径');
});

await test('实测：计数首选按钮自身（video-player-digg / feed-comment-icon / video-player-collect）', () => {
  const d = PLATFORMS.douyin.selectors;
  assert.ok(d.likeCount[0] === '[data-e2e="video-player-digg"]', '点赞数首选 video-player-digg');
  assert.ok(d.commentCount[0] === '[data-e2e="feed-comment-icon"]', '评论数首选 feed-comment-icon');
  assert.ok(d.favoriteCount[0] === '[data-e2e="video-player-collect"]', '收藏数首选 video-player-collect');
});

await test('实测：评论区选择器对齐 AiToEarn（comment-list > div > comment-item）', () => {
  const d = PLATFORMS.douyin.selectors;
  assert.ok(d.commentItem[0] === '[data-e2e="comment-list"] > div > [data-e2e="comment-item"]', '评论条目首选 AiToEarn 路径');
  assert.ok(d.commentText.some((x) => x.includes('.comment-item-info-wrap + div span')), '正文取 info-wrap 的下一级 div span');
  assert.ok(d.commentAuthor.some((x) => x.includes('.comment-item-info-wrap div')), '作者取 info-wrap 里的 div');
  assert.ok(d.commentLike.some((x) => x.includes('comment-item-stats-container')), '点赞数取 stats-container');
});

console.log(`\n结果：${passed} 通过，${failures.length} 失败\n`);
if (failures.length) {
  for (const f of failures) console.error(`失败：${f.name} → ${f.error}`);
  process.exit(1);
}
