// 网页元素自检的判定逻辑（纯函数，可单测）。
//
// 核心：**不是所有选择器「没命中」都是问题**，分四类语义：
//   reverse  : 不命中才是好事（loginFlag 命中=检测到未登录标记）
//   listOnly : 只在列表页/搜索页用，详情页本来就抓不到
//   optional : 只影响日志的丰富度，不影响能不能跑（作者名、标签、评论数等）
//   required : 真的会影响主流程的（点赞按钮、评论输入框…）
// 把 optional 和 reverse 混进「需要修」里，用户会看到一堆假红点，得出「插件坏了」的错误结论。

export const SELECTOR_KIND = {
  loginFlag: 'reverse',
  collectLinks: 'listOnly',
  // 只影响日志丰富度，缺了也能正常点赞评论
  author: 'optional',
  authorLink: 'optional',
  tags: 'optional',
  commentAuthor: 'optional',
  commentLike: 'optional',
  commentScroll: 'optional',
  commentSuccess: 'optional',
  commentList: 'optional',
};

/** 详情页需要关注的选择器（显示顺序） */
export const SELECTOR_KEYS = [
  'loginFlag', 'readyFlag', 'title', 'desc',
  'likeButton', 'collectButton', 'commentButton',
  'likeCount', 'commentCount', 'favoriteCount',
  'commentItem', 'commentText', 'commentAuthor', 'commentLike', 'commentScroll', 'commentList',
  'commentInput', 'commentSubmit', 'commentSuccess',
  'author', 'authorLink', 'tags',
  'collectLinks',
];

const isRequired = (key) => !SELECTOR_KIND[key];

/**
 * 根据自检结果给出结论
 * @param probe { loggedOut, fields:[{key, hit}], openedComments }
 * @returns { level, title, detail, missing?, optional?, ready?, total? }
 */
export function probeVerdict(probe) {
  if (!probe) return { level: 'warn', title: '没有拿到检测结果', detail: '请重新点一次「自检当前页」。' };

  if (probe.loggedOut) {
    return {
      level: 'err',
      title: '这个页面没有登录',
      detail: '请先在浏览器里登录该平台，再回来重新自检。',
      missing: ['loginFlag'],
    };
  }

  const fields = probe.fields || [];
  const scored = fields.filter((f) => isRequired(f.key));
  const missing = scored.filter((f) => !f.hit).map((f) => f.key);
  const optionalMissing = fields
    .filter((f) => SELECTOR_KIND[f.key] === 'optional' && !f.hit)
    .map((f) => f.key);
  const ready = scored.filter((f) => f.hit).length;
  const total = scored.length;
  const opened = probe.openedComments ? '（评论区是收起的，已自动点开后再测）' : '';

  if (missing.length === 0) {
    return {
      level: 'ok', ready, total,
      optional: optionalMissing,
      title: '这个页面该有的元素全都能找到',
      detail: `必需的 ${total} 项全部命中${opened}。可以回上面粘贴视频链接，点「开始」了。`
        + (optionalMissing.length ? `\n另有 ${optionalMissing.length} 项可选信息没抓到（${optionalMissing.join('、')}），只影响日志里这几列，不影响点赞评论。` : ''),
    };
  }

  return {
    level: 'warn',
    ready, total, missing,
    optional: optionalMissing,
    title: `有 ${missing.length} 项会影响运行，需要修${opened}`,
    detail: `必需的 ${total} 项命中 ${ready} 项。把下面「要修哪个」切到红点那一项，点「开始拾取」，再到页面上点正确的元素，然后保存。`
      + (optionalMissing.length ? `\n（另有 ${optionalMissing.length} 项可选信息没抓到，不影响运行）` : ''),
  };
}

/** 表格里某一项该显示什么颜色 */
export function selectorDot(key, hit) {
  const kind = SELECTOR_KIND[key];
  if (kind === 'reverse') return hit ? 'bad' : 'ok';
  if (kind === 'listOnly') return hit ? 'ok' : 'skip';
  if (kind === 'optional') return hit ? 'ok' : 'meh';
  return hit ? 'ok' : 'bad';
}

/** 表格里某一项的补充说明 */
export function selectorNote(key, hit) {
  const kind = SELECTOR_KIND[key];
  if (kind === 'reverse') return hit ? '检测到未登录标记' : '已登录';
  if (kind === 'listOnly') return hit ? '' : '详情页不需要';
  if (kind === 'optional') return hit ? '' : '可选，不影响运行';
  return '';
}
