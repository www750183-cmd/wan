// 用真实模型跑一遍「梗概 → 生成评论」链路，验证提示词能不能产出可用评论。
// Key 走环境变量，不写进任何文件。
//
// 用法（PowerShell）：
//   $env:AID_API_KEY="sk-..."; node tools/live-auto-test.mjs
// 可选：
//   $env:AID_BASE_URL / AID_MODEL 覆盖默认端点与模型
// 想用自己的素材：改下面的 SCENARIO 或设 AID_SCENARIO=2
import { mergeSettings } from '../src/lib/store.js';
import { buildInsightPrompt, parseInsight, validateDrafts, pickDraft, fallbackDraft } from '../src/lib/insight.js';
import { callLLM } from '../src/lib/llm.js';

const apiKey = process.env.AID_API_KEY;
if (!apiKey) {
  console.error('缺少 AID_API_KEY。用法：$env:AID_API_KEY="sk-..."; node tools/live-auto-test.mjs');
  process.exit(2);
}

const SCENARIOS = {
  1: {
    name: '书法作品 + 评论区问价（用户给的例子）',
    content: {
      platform: 'douyin', platformName: '抖音',
      title: '手写小楷《心经》扇面',
      desc: '写了三天的扇面，纸是半生熟宣，笔是狼毫小楷，落款盖了两方印。平时接定制的单子比较多，这幅是给自己写的。 #书法 #小楷 #手写扇面 #传统文化',
      tags: ['#书法', '#小楷', '#手写扇面'],
      author: '砚台边的小李',
      likeCount: 12000, commentCount: 345,
      url: 'https://www.douyin.com/video/7212345678901234567',
    },
    comments: [
      { author: '山间清风', text: '这个多少钱出？', like: 234 },
      { author: '书友老陈', text: '笔力很稳，一看就是练过的', like: 87 },
      { author: '小满', text: '能出教程吗', like: 45 },
      { author: '墨白', text: '这个纸是哪家的', like: 22 },
      { author: '张三', text: '师傅收徒弟吗', like: 12 },
    ],
  },
  2: {
    name: '露营装备分享 + 评论区求链接',
    content: {
      platform: 'xhs', platformName: '小红书',
      title: '两个人的轻量化露营装备清单（总重 12kg）',
      desc: '帐篷是双人超轻款，睡袋舒适温标 5 度，炉头选了分体式的更稳。整套下来一个人背完全没问题。',
      tags: ['#露营', '#轻量化', '#户外装备'],
      author: '背炉子的阿May',
      likeCount: 3400, commentCount: 156,
      url: 'https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f60718293a',
    },
    comments: [
      { author: '想去野的人', text: '求链接！', like: 120 },
      { author: '老驴', text: '这个炉头我在用，确实稳', like: 33 },
      { author: '新手小白', text: '总预算大概多少', like: 28 },
    ],
  },
};

const scenario = SCENARIOS[process.env.AID_SCENARIO || '1'];
const settings = mergeSettings({
  llm: {
    baseURL: process.env.AID_BASE_URL || undefined,
    model: process.env.AID_MODEL || undefined,
    apiKey,
  },
});

let failed = 0;
const step = (name, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `　${detail}` : ''}`);
  if (!ok) failed++;
};

console.log('=== 场景 ===');
console.log(`  ${scenario.name}`);
console.log(`  模型：${settings.llm.model} @ ${settings.llm.baseURL}`);
console.log(`  身份：${settings.auto.persona}`);
console.log(`  意图：${settings.auto.intent}`);
console.log(`  评论区样本：${scenario.comments.length} 条\n`);

// ---------- 1. 提示词 ----------
console.log('=== 1. 构建提示词 ===');
const prompt = buildInsightPrompt(settings, scenario.content, scenario.comments);
step('提示词构建', prompt.length > 500, `${prompt.length} 字符（约 ${Math.round(prompt.length / 2)} tokens）`);

// ---------- 2. 调模型 ----------
console.log('\n=== 2. 调用模型 ===');
const t0 = Date.now();
let out;
try {
  out = await callLLM(settings, prompt);
  step('模型返回', true, `${Date.now() - t0}ms，${out.text.length} 字符`);
  if (out.usage) console.log(`  usage：prompt=${out.usage.prompt_tokens} completion=${out.usage.completion_tokens} total=${out.usage.total_tokens}`);
  if (out.finishReason === 'length') console.log('  ⚠ finish_reason=length，输出被截断');
} catch (e) {
  step('模型返回', false, e.message);
  process.exit(1);
}

// ---------- 3. 解析 ----------
console.log('\n=== 3. 解析模型输出 ===');
const insight = parseInsight(out.text);
step('输出是合法 JSON', insight.ok);
if (!insight.ok) {
  console.log(`  原文前 300 字：${out.text.slice(0, 300)}`);
  process.exit(1);
}

console.log(`\n  📄 视频梗概：${insight.summary || '（空）'}`);
console.log(`  💬 评论区关注点：${insight.commentFocus || '（空）'}`);
console.log(`\n  ✍️ 模型给的 ${insight.drafts.length} 条候选：`);
insight.drafts.forEach((d, i) => {
  console.log(`    ${i + 1}. ${d.text}`);
  if (d.reason) console.log(`       ↳ ${d.reason}`);
});
step('有梗概', !!insight.summary);
step('有候选评论', insight.drafts.length > 0, `${insight.drafts.length} 条`);

// ---------- 4. 校验 ----------
console.log('\n=== 4. 校验（禁词/长度/与评论区重复）===');
const { valid, rejected } = validateDrafts(insight.drafts, settings, scenario.comments);
step('有通过校验的草稿', valid.length > 0, `通过 ${valid.length} / 被否 ${rejected.length}`);
if (rejected.length) {
  console.log('  被否掉的：');
  rejected.forEach((d) => console.log(`    ✗ ${d.text}  →  ${d.reason}`));
}

let chosen = pickDraft(valid, settings);
if (!chosen && settings.auto.useFallback) {
  const fb = fallbackDraft(settings, scenario.content, insight);
  if (fb) {
    const recheck = validateDrafts([{ text: fb }], settings, scenario.comments);
    if (recheck.valid.length) {
      chosen = recheck.valid[0];
      console.log('  使用兜底文案');
    }
  }
}

console.log('\n' + '─'.repeat(64));
if (chosen) {
  console.log(`【最终会发布的评论】${chosen.text}`);
  console.log(`（字数 ${chosen.text.replace(/[\u{1F300}-\u{1FAFF}]/gu, '').length}，身份 ${settings.auto.persona}）`);
} else {
  console.log('无法生成可用评论（全部未通过校验，且没有兜底）');
  failed++;
}
console.log('─'.repeat(64));

console.log(`\n${failed === 0 ? '✅ 全自动链路通过' : `❌ ${failed} 项未通过`}\n`);
process.exit(failed === 0 ? 0 : 1);
