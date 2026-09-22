// 平台适配表：URL 规则 + 选择器（含备选链）。选择器是从 AiToEarn 3.3.9 拆解结果里
// 提取的初值，全部可在控制台里改动，或用「选择器拾取器」在页面上点选后自动写入。

export const PLATFORMS = {
  douyin: {
    key: 'douyin',
    name: '抖音',
    hosts: ['douyin.com', 'iesdouyin.com'],
    webHost: 'www.douyin.com',
    shortHosts: ['v.douyin.com'],
    supports: { collect: true, like: true, favorite: true, comment: true, listScroll: true },
    workPath: '/video/{id}',
    note: '网页版功能完整。分享短链 v.douyin.com 会自动展开。',
    listUrl: {
      search: (kw) => `https://www.douyin.com/search/${encodeURIComponent(kw)}?type=video`,
      user: (u) => u,
    },
    selectors: {
      loginFlag: ['#douyin-login-new-id', '#login-panel-new', '[data-e2e="login-modal"]'],
      readyFlag: ['[data-e2e="detail-video-info"]', '.xg-video-container', '[data-e2e="feed-comment-icon"]'],
      // 抖音没有独立的 h1，视频标题就是文案本身
      // ★ 实测：详情页是 [data-e2e="detail-video-info"] 里的 h1；detail-video-desc 不存在
      title: ['[data-e2e="detail-video-info"] h1', '[data-e2e="detail-video-desc"]', '[data-e2e="video-desc"]', '.video-info-detail'],
      author: ['[data-e2e="video-author-name"]', '[data-e2e="user-info"] a span', '[data-e2e="video-detail"] [data-e2e="user-info"] a span'],
      authorLink: ['[data-e2e="video-author-name"] a', '[data-e2e="user-info"] a', '[data-e2e="video-detail"] [data-e2e="user-info"] a'],
      // 抖音用 data-e2e / data-e2e-state 标记（比混淆 class 稳定得多，实测确认）
      // ★ 2026-09-23 复核修正：同一按钮带 data-e2e="video-player-digg" 和
      //   data-e2e-state="video-player-no-digged"（未赞）/ "video-player-is-digged"（已赞）。
      //   注意是 is-digged，不是 digged —— 原写法在「已点赞的视频」上永远匹配不到，
      //   会报「无法判定当前状态（状态选择器失效）」。
      likeButton: [
        '[data-e2e-state="video-player-is-digged"]',
        '[data-e2e-state="video-player-no-digged"]',
        '[data-e2e="video-player-digg"]',
        '[data-e2e="detail-video-info"] > div:last-child > div:first-child > div:nth-child(1)',
      ],
      collectButton: [
        '[data-e2e="video-player-collect"]',
        '[data-e2e-state="video-player-no-collect"]',
        '[data-e2e-state="video-player-collected"]',
      ],
      // ★ 实测：feed-comment-icon 在详情页存在且文本就是评论数；列表页才是 no-comment
      commentButton: [
        '[data-e2e="feed-comment-icon"]',
        '[data-e2e-state="video-player-no-comment"]',
        '[data-e2e="detail-video-info"] > div:last-child > div:first-child > div:nth-child(2)',
      ],
      commentInput: [
        '.richtext-container [contenteditable="true"]',
        '[data-e2e="comment-input"] [contenteditable="true"]',
        '.public-DraftEditor-content',
        '[contenteditable="true"]',
      ],
      commentSubmit: [
        '.commentInput-right-ct > div > span:last-child',
        '[data-e2e="comment-publish"]',
        '.commentInput-right-ct > div > span:last-child',
      ],
      // 发送后的结果比对：评论列表第一条（AiToEarn 同款写法）
      commentResultItem: ['[data-e2e="comment-list"] .comment-item-info-wrap + div', '[data-e2e="comment-list"] > div > [data-e2e="comment-item"] .comment-item-info-wrap + div span'],
      // 出现这个说明触发了短信验证，需要人工
      smsVerification: ['.uc-ui-input_content'],
      commentSuccess: ['[data-e2e="comment-list"] .comment-item-info-wrap'],
      commentList: ['[data-e2e="comment-list"] > div > [data-e2e="comment-item"]', '[data-e2e="comment-list"] .comment-item-info-wrap + div'],
      collectLinks: ['a[href*="/video/"]'],
      collectSign: ['[data-e2e-state="video-player-is-digged"]', '[data-e2e-state="video-player-no-digged"]'],
      // ★ 实测计数：按钮的 innerText 直接就是数字（694 / 6 / 23），
      //   不需要再往子级 div 找。保留 div 写法做兜底。
      likeCount: ['[data-e2e="video-player-digg"]', '[data-e2e-state="video-player-no-digged"] div', '[data-e2e-state="video-player-is-digged"] div'],
      commentCount: ['[data-e2e="feed-comment-icon"]', '[data-e2e="feed-comment-icon"] div'],
      favoriteCount: ['[data-e2e="video-player-collect"]', '[data-e2e="video-player-collect"] div'],
      // —— 全自动：内容与评论区 ——
      // ★ 实测：详情页文案在 detail-video-info 的 h1 里；desc 复用同一路径
      desc: ['[data-e2e="detail-video-info"] h1', '[data-e2e="detail-video-desc"]', '[data-e2e="video-desc"]', '.video-info-detail'],
      tags: ['[data-e2e="detail-video-info"] h1 a[href*="search"]', '[data-e2e="detail-video-desc"] a[href*="search"]', '[data-e2e="detail-video-desc"] a[href*="hashtag"]'],
      // ★ AiToEarn 3.3.9 实测选择器（tmp/aitoearn，work.getComments）：
      //   列表 = comment-list 的直接子 div 下的 comment-item（只取一级，不取嵌套回复）
      //   正文 = comment-item-info-wrap 的下一个 div 里的 span
      //   作者 = comment-item-info-wrap 里的 div（不是 a）
      //   评论点赞数 = comment-item-stats-container div p span
      commentItem: [
        '[data-e2e="comment-list"] > div > [data-e2e="comment-item"]',
        '[data-e2e="comment-list"] [data-e2e="comment-item"]',
        '[data-e2e="comment-item"]',
        '.comment-mainContent',
      ],
      commentText: [
        '[data-e2e="comment-item"] .comment-item-info-wrap + div span',
        '.comment-item-info-wrap + div span',
        '[data-e2e="comment-item"] .comment-item-info-wrap + div',
        '.comment-item-info-wrap + div',
      ],
      commentAuthor: [
        '[data-e2e="comment-item"] .comment-item-info-wrap div',
        '.comment-item-info-wrap div',
        '[data-e2e="comment-item"] .comment-item-info-wrap a',
        '.comment-item-info-wrap a',
      ],
      commentLike: [
        '[data-e2e="comment-item"] .comment-item-stats-container div p span',
        '.comment-item-stats-container div p span',
        '[data-e2e="comment-item"] .comment-item-like-count',
        '.comment-item-like-count',
      ],
      // 滚动加载更多评论时滚的是 comment-list 的父级，不是 comment-list 本身
      // （AiToEarn work.loadMoreComments：commentList?.parentElement）
      commentScroll: ['[data-e2e="comment-list"]', '.comment-list-container', '.comment-mainContent'],
    },
    // 状态直接读 data-e2e-state：on 存在=已激活，off 存在=未激活
    likeState: { type: 'toggle', onSelector: '[data-e2e-state="video-player-is-digged"]', offSelector: '[data-e2e-state="video-player-no-digged"]' },
    collectState: { type: 'toggle', onSelector: '[data-e2e-state="video-player-collected"]', offSelector: '[data-e2e-state="video-player-no-collect"]' },
    // 抖音评论区默认收起，要先点评论图标才展开
    openCommentsBy: ['[data-e2e="feed-comment-icon"]', '[data-e2e-state="video-player-no-comment"]'],
    // ★ 关键：必须先点这个区域，编辑器才会渲染到 DOM 里（AiToEarn 实测的顺序）
    commentTrigger: ['.comment-input-inner-container', '[data-e2e="feed-comment-icon"]'],
    // 评论框是 Draft.js：用 ClipboardEvent('paste') 输入最可靠
    commentSubmitMode: 'auto',
    videoContainer: ['.xg-video-container'],
  },

  xhs: {
    key: 'xhs',
    name: '小红书',
    hosts: ['xiaohongshu.com', 'xhslink.com'],
    webHost: 'www.xiaohongshu.com',
    shortHosts: ['xhslink.com', 'www.xhslink.com'],
    supports: { collect: true, like: true, favorite: true, comment: true, listScroll: true },
    workPath: '/explore/{id}',
    note: '网页版功能完整。分享短链 xhslink.com 会自动展开。评论输入框是 contenteditable。',
    listUrl: {
      search: (kw) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(kw)}`,
      user: (u) => u,
    },
    selectors: {
      loginFlag: ['.login-container', '.login-box-container'],
      readyFlag: ['.interact-container', '.note-detail-mask'],
      title: ['#detail-title', '.title'],
      author: ['.author-wrapper .username', '.author-container .username'],
      authorLink: ['.author-wrapper a', '.author-container a'],
      likeButton: ['.interact-container .like-wrapper', '.like-wrapper'],
      collectButton: ['.interact-container #note-page-collect-board-guide', '#note-page-collect-board-guide'],
      commentInput: ['#content-textarea', '.comment-input [contenteditable="true"]'],
      commentSubmit: ['.right-btn-area .submit', '.comment-submit'],
      commentSuccess: ['.parent-comment .content', '.comment-list .content'],
      commentList: ['.parent-comment .content'],
      collectLinks: ['a[href*="/explore/"]', 'a[href*="/discovery/item/"]'],
      collectSign: ['.interact-container .like-wrapper .like-icon use'],
      likeCount: ['.interact-container .like-wrapper .count', '.like-wrapper .count'],
      commentCount: ['.interact-container .chat-wrapper .count', '.chat-wrapper .count'],
      favoriteCount: ['.interact-container #note-page-collect-board-guide .count', '.collect-wrapper .count'],
      // —— 全自动：内容与评论区 ——
      desc: ['#detail-desc', '.note-content', '.desc'],
      tags: ['#detail-desc .tag', '.note-content .tag', '.note-content a[href*="search_result"]'],
      commentItem: ['.parent-comment', '.comment-item', '.comment-inner-container'],
      commentText: ['.parent-comment .content', '.comment-item .content', '.comment-inner-container .content'],
      commentAuthor: ['.parent-comment .author .name', '.comment-item .author .name', '.author-wrapper .name'],
      commentLike: ['.parent-comment .like-wrapper .count', '.comment-item .like-wrapper .count'],
      commentScroll: ['.comment-list', '.comments-container', '.note-scroller'],
    },
    // 图标 <use> 的 href baseVal 等于 #liked / collected 即为已激活
    likeState: { type: 'useHref', selector: '.interact-container .like-wrapper .like-icon use', equals: '#liked' },
    collectState: { type: 'useHref', selector: '.interact-container #note-page-collect-board-guide use', equals: 'collected' },
  },

  wxSph: {
    key: 'wxSph',
    name: '视频号',
    hosts: ['channels.weixin.qq.com', 'weixin.qq.com'],
    webHost: 'channels.weixin.qq.com',
    shortHosts: [],
    supports: { collect: true, like: false, favorite: false, comment: false, listScroll: false },
    workPath: '',
    note: '微信未开放「浏览他人视频号并互动」的网页端，因此只支持收录自己账号的作品数据（创作者后台）。点赞/评论不可用。',
    listUrl: {
      search: (kw) => `https://channels.weixin.qq.com/platform/post/list`,
      user: () => 'https://channels.weixin.qq.com/platform/post/list',
    },
    selectors: {
      loginFlag: ['.login-wrap', '.login-container', '[class*="login"] canvas'],
      readyFlag: ['[class*="post-list"]', '[class*="content-list"]', '.post-item'],
      title: ['[class*="post-title"]', '[class*="title"]'],
      author: ['[class*="nickname"]', '[class*="account-name"]'],
      authorLink: [],
      likeButton: [],
      collectButton: [],
      commentInput: [],
      commentSubmit: [],
      commentSuccess: [],
      commentList: [],
      collectLinks: ['a[href*="post"]', '[class*="post-item"]'],
      collectSign: [],
      likeCount: ['[class*="like-count"]', '[class*="digg"]'],
      commentCount: ['[class*="comment-count"]'],
      favoriteCount: ['[class*="fav-count"]', '[class*="collect"]  [class*="count"]'],
      // 视频号没有公开的他人作品评论区，这几项留空（全自动对视频号只做内容收录）
      desc: ['[class*="post-desc"]', '[class*="description"]'],
      tags: [],
      commentItem: [],
      commentText: [],
      commentAuthor: [],
      commentLike: [],
      commentScroll: [],
    },
    likeState: { type: 'none' },
    collectState: { type: 'none' },
  },
};

export const PLATFORM_KEYS = Object.keys(PLATFORMS);

export function detectPlatform(url) {
  let host = '';
  try { host = new URL(url).host.toLowerCase(); } catch { return null; }
  for (const key of PLATFORM_KEYS) {
    if (PLATFORMS[key].hosts.some((h) => host === h || host.endsWith('.' + h))) return key;
  }
  return null;
}

/** 从任意文本里抠出所有 URL（用户通常直接粘贴分享文案） */
export function extractUrls(text) {
  const out = [];
  const re = /https?:\/\/[^\s"'<>()，。；、！？【】]+/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    out.push(m[0].replace(/[.,;:!?)\]}]+$/, ''));
  }
  return Array.from(new Set(out));
}

/** 从作品 URL 里取作品 ID */
export function workIdFromUrl(platformKey, url) {
  if (!url) return '';
  const rules = {
    douyin: [/\/video\/(\d+)/, /\/note\/(\d+)/, /modal_id=(\d+)/, /aweme_id=(\d+)/],
    xhs: [/\/explore\/([0-9a-f]{16,})/i, /\/discovery\/item\/([0-9a-f]{16,})/i, /\/note\/([0-9a-f]{16,})/i],
    wxSph: [/[?&]id=([\w-]+)/, /\/([A-Za-z0-9_-]{10,})(?:\?|$)/],
  }[platformKey] || [];
  for (const r of rules) {
    const m = r.exec(url);
    if (m) return m[1];
  }
  return '';
}

export function workUrl(platformKey, id) {
  const p = PLATFORMS[platformKey];
  if (!p || !p.workPath || !id) return '';
  return `https://${p.webHost || p.hosts[0]}${p.workPath.replace('{id}', id)}`;
}

/** 短链（需要先展开才能确定是不是作品页） */
export function isShortLink(platformKey, url) {
  const p = PLATFORMS[platformKey];
  if (!p?.shortHosts?.length) return false;
  try {
    const host = new URL(url).host.toLowerCase();
    return p.shortHosts.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
}

/** 判断是不是标准作品详情页（用于决定要不要先展开短链） */
export function isWorkUrl(platformKey, url) {
  return !!workIdFromUrl(platformKey, url);
}

/** 合并用户自定义选择器与默认值 */
export function resolveSelectors(platformKey, custom) {
  const base = PLATFORMS[platformKey]?.selectors || {};
  const out = {};
  for (const [k, v] of Object.entries(base)) out[k] = Array.isArray(v) ? [...v] : v;
  if (custom && typeof custom === 'object') {
    for (const [k, v] of Object.entries(custom)) {
      const list = Array.isArray(v) ? v : [v];
      const clean = list.map((s) => String(s || '').trim()).filter(Boolean);
      if (clean.length) out[k] = Array.from(new Set([...clean, ...(out[k] || [])]));
    }
  }
  return out;
}

export function resolveState(platformKey, key, custom) {
  const base = PLATFORMS[platformKey]?.[key] || { type: 'none' };
  const c = custom?.[`${key}Override`];
  if (c && c.type) return c;
  return base;
}
