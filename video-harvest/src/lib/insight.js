// 全自动评论：提示词构建、模型输出解析、草稿校验与挑选。纯逻辑，无 chrome 依赖。
import { truncate, extractJsonBlock, uniqBy } from './util.js';

const URL_RE = /(https?:\/\/|www\.)[^\s]+/i;
const AT_RE = /@[\w\u4e00-\u9fa5-]+/;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

export function buildInsightPrompt(settings, content, comments) {
  const a = settings.auto || {};
  const c = content || {};
  const list = (comments || []).slice(0, a.commentSampleCount || 20);

  const commentBlock = list.length
    ? list.map((x, i) => `${i + 1}.${x.like ? `[赞${x.like}]` : ''}${x.author || '匿名'}：${truncate(x.text || '', 120)}`).join('\n')
    : '（这个页面没有抓到评论，或评论区还没加载出来）';

  const extra = String(a.extraRules || '').trim();

  return `你在帮一个真实用户写一条短视频平台（${c.platformName || ''}）的评论。写出来的评论要像真人随手打的，能自然融进评论区，并且暗示对作品的兴趣。

【视频信息】
标题：${c.title || '（无标题）'}
正文/描述：${truncate(c.desc || '', 800) || '（没抓到描述）'}
话题标签：${(c.tags || []).join(' ') || '（无）'}
作者：${c.author || '（未知）'}
数据：点赞 ${c.likeCount ?? '未知'}，评论 ${c.commentCount ?? '未知'}
链接：${c.url || ''}

【评论区现状】（这些是别人已经说过的，你的评论不能跟它们重复、也不能是它们的改写）
${commentBlock}

【你的身份与意图】
身份：${a.persona || '普通用户'}
意图：${a.intent || '表达对作品的兴趣'}

【写作要求】
1. 长度 ${a.minLen || 8}–${a.maxLen || 45} 个汉字。像随口一说，不要写成广告文案或排比句。
2. 必须扣住这个视频的具体内容或评论区的具体关注点（比如别人在问价、在夸某个细节），不要写放之四海皆准的废话。
3. 禁词（绝对不能出现）：${a.bannedWords || ''}
4. 禁止出现链接、@某人、微信号、电话号。
5. 禁止用"求链接""怎么买""多少钱出吗""私我"这类直接索要的句式；要含蓄，靠"自己也买过/用过类似的"这种同好口吻带出来。
6. 不要照抄或改写评论区已有的说法。
7. emoji 最多 1 个，也可以不用。
${extra ? `8. 额外要求：${extra}\n` : ''}
【输出格式】只输出一个 JSON 对象，不要代码块，不要解释：
{
  "summary": "这个视频在讲什么，40 字以内的梗概",
  "commentFocus": "评论区主要在关心什么，30 字以内",
  "drafts": [
    {"text": "评论正文", "reason": "为什么这么写，一句话"}
  ]
}
drafts 输出 ${a.draftCount || 3} 条，风格要有区分度。`;
}

/** 解析模型输出 */
export function parseInsight(text) {
  const parsed = extractJsonBlock(text);
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, summary: '', commentFocus: '', drafts: [], raw: truncate(String(text || ''), 1000) };
  }
  const drafts = (Array.isArray(parsed.drafts) ? parsed.drafts : [])
    .map((d) => ({
      text: String(d?.text ?? d ?? '').replace(/\s+/g, ' ').trim(),
      reason: truncate(String(d?.reason || '').trim(), 120),
    }))
    .filter((d) => d.text);

  return {
    ok: true,
    summary: truncate(String(parsed.summary || '').trim(), 200),
    commentFocus: truncate(String(parsed.commentFocus || '').trim(), 200),
    drafts,
    raw: '',
  };
}

function bigrams(s) {
  const t = String(s || '').replace(/[\s\p{P}]/gu, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 两条文本相似度（二元组 Jaccard） */
export function similarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * 校验草稿：长度、禁词、链接/@、与评论区重复度。
 * 返回 { valid, rejected:[{text, reason}] }
 */
export function validateDrafts(drafts, settings, comments) {
  const a = settings.auto || {};
  const banned = String(a.bannedWords || '')
    .split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
  const minLen = a.minLen || 8;
  const maxLen = a.maxLen || 45;
  const threshold = a.similarityThreshold ?? 0.6;
  const existing = (comments || []).map((c) => c.text || '').filter(Boolean);

  const valid = [];
  const rejected = [];

  for (const d of drafts || []) {
    const text = String(d.text || '').trim();
    const plain = text.replace(EMOJI_RE, '');

    if (plain.length < minLen) { rejected.push({ ...d, reason: `太短（${plain.length} < ${minLen}）` }); continue; }
    if (plain.length > maxLen) { rejected.push({ ...d, reason: `太长（${plain.length} > ${maxLen}）` }); continue; }
    if (banned.length && banned.some((w) => text.includes(w))) {
      rejected.push({ ...d, reason: `含禁词：${banned.filter((w) => text.includes(w)).join('、')}` }); continue;
    }
    if (URL_RE.test(text)) { rejected.push({ ...d, reason: '含链接' }); continue; }
    if (AT_RE.test(text)) { rejected.push({ ...d, reason: '含 @ 提及' }); continue; }
    const dup = existing.find((c) => similarity(text, c) >= threshold || c.includes(text) || text.includes(c));
    if (dup) { rejected.push({ ...d, reason: `与评论区已有评论重复：${truncate(dup, 20)}` }); continue; }

    valid.push(d);
  }

  return { valid: uniqBy(valid, (d) => d.text), rejected };
}

/** 从合格草稿里挑一条 */
export function pickDraft(valid, settings) {
  if (!valid?.length) return null;
  const strategy = settings.auto?.draftStrategy || 'first';
  if (strategy === 'random') return valid[Math.floor(Math.random() * valid.length)];
  return valid[0];
}

/** 兜底：模型没给出可用草稿时，用评论区关注点 + 身份拼一条（保证流程不断） */
export function fallbackDraft(settings, content, insight) {
  const focus = insight?.commentFocus || '';
  const t = (content?.title || '').slice(0, 12);
  if (/价|多少|出|买/.test(focus)) return `同款我之前也买过一个，不知道和博主这个是不是一路的`;
  if (t) return `刷到这条，${t}这个细节做得挺用心`;
  return '';
}
