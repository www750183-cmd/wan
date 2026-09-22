// 注入到页面里执行的函数。
// 重要：chrome.scripting.executeScript 会把函数 toString 后送进页面，
// 因此这些函数内部 **不能引用任何外部变量**，所有依赖都必须写在函数体里。

/* eslint-disable no-undef */

/**
 * 自检：逐个报告选择器命中情况。
 * 抖音这类平台的评论区是收起的，不点开的话评论相关项必然全红——所以先自动点开再测。
 */
export async function injectProbe(cfg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => { try { return document.querySelector(s); } catch { return null; } };
  const qa = (s) => { try { return document.querySelectorAll(s); } catch { return []; } };
  const txtOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '');
  // 必须判可见：站点会把登录弹窗留在 DOM 里但隐藏，只看「存在」会误报未登录
  // 但抖音互动按钮在某些渲染条件下 rect 为 0x0（父级折叠），文本和样式都正常。
  // 所以：有文本内容的元素放宽尺寸要求；没文本的才按尺寸卡。
  const visible = (el) => {
    if (!el) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || 1) <= 0.05) return false;
    const r = el.getBoundingClientRect();
    if (r.width >= 2 && r.height >= 2) return true;
    const t = (el.innerText || el.textContent || '').trim();
    return t.length > 0;
  };

  const probeOnce = () => {
    const out = [];
    for (const [key, list] of Object.entries(cfg.selectors || {})) {
      const arr = Array.isArray(list) ? list : [list];
      const rows = arr.map((s) => {
        const els = qa(s);
        const vis = Array.from(els).filter(visible);
        return { selector: s, hit: vis.length > 0, count: vis.length, sample: txtOf(vis[0] || els[0]) };
      });
      out.push({ key, hit: rows.some((r) => r.hit), rows });
    }
    return out;
  };

  let fields = probeOnce();
  let openedComments = false;

  // 评论相关项没命中时，先点开评论区再测——否则测的是「收起状态」，结论没有意义
  const commentKeys = ['commentItem', 'commentText', 'commentInput', 'commentSubmit'];
  const needOpen = commentKeys.some((k) => {
    const f = fields.find((x) => x.key === k);
    return f && !f.hit;
  });
  if (needOpen && Array.isArray(cfg.openCommentsBy) && cfg.openCommentsBy.length) {
    const btn = cfg.openCommentsBy.map(q).find(visible);
    if (btn) {
      try { btn.click(); } catch { }
      await sleep(cfg.openCommentsDelayMs || 1800);
      fields = probeOnce();
      openedComments = true;
    }
  }

  const loginHit = (cfg.selectors?.loginFlag || []).some((s) => visible(q(s)));
  const readyHit = (cfg.selectors?.readyFlag || []).some((s) => !!q(s));
  return {
    ok: true,
    url: location.href,
    title: document.title,
    loggedOut: loginHit,
    ready: readyHit || fields.length > 0,
    fields,
    openedComments,
    bodyTextLength: (document.body?.innerText || '').length,
  };
}

/** 列表页 / 搜索页：滚动若干次并收集作品链接 */
export async function injectCollectList(cfg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const qa = (s) => { try { return Array.from(document.querySelectorAll(s)); } catch { return []; } };
  const sel = Array.isArray(cfg.selectors) ? cfg.selectors : [];
  const include = (cfg.include || []).map((p) => new RegExp(p, 'i'));
  const exclude = (cfg.exclude || []).map((p) => new RegExp(p, 'i'));
  const seen = new Map();
  const grab = () => {
    for (const s of sel) {
      for (const a of qa(s)) {
        const href = a.href || a.getAttribute('href') || '';
        if (!/^https?:/.test(href)) continue;
        if (include.length && !include.some((r) => r.test(href))) continue;
        if (exclude.some((r) => r.test(href))) continue;
        const key = href.split('?')[0];
        if (seen.has(key)) continue;
        const title = (a.innerText || a.textContent || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        seen.set(key, { url: href.split('?')[0], title });
        if (seen.size >= (cfg.maxItems || 200)) return;
      }
    }
  };
  grab();
  let scrolls = 0;
  for (let i = 0; i < (cfg.scrolls || 0); i++) {
    if (seen.size >= (cfg.maxItems || 200)) break;
    const before = seen.size;
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(cfg.scrollDelayMs || 1800);
    grab();
    scrolls++;
    if (seen.size === before && i >= 2) break; // 连续两次没新增就停
  }
  return { ok: true, url: location.href, scrolls, links: Array.from(seen.values()) };
}

/** 详情页：提取作品信息与互动状态 */
export function injectExtractWork(cfg) {
  const pick = (list) => {
    const arr = Array.isArray(list) ? list : [list];
    for (const s of arr) { try { const el = document.querySelector(s); if (el) return el; } catch { } }
    return null;
  };
  const pickAll = (list) => {
    const arr = Array.isArray(list) ? list : [list];
    for (const s of arr) { try { const els = document.querySelectorAll(s); if (els.length) return Array.from(els); } catch { } }
    return [];
  };
  const txt = (list) => { const el = pick(list); return el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : ''; };

  const parseCount = (input) => {
    if (!input) return null;
    const s = String(input).replace(/\s|,/g, '');
    const m = /^([0-9]*\.?[0-9]+)\s*(万|亿|w|W|k|K|m|M)?/.exec(s);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return null;
    const f = { '万': 1e4, w: 1e4, '亿': 1e8, k: 1e3, m: 1e6 }[(m[2] || '').toLowerCase()] ?? 1;
    return Math.round(n * f);
  };

  const stateOf = (state) => {
    if (!state || state.type === 'none') return null;
    try {
      if (state.type === 'classCount') {
        const list = cfg.selectors?.[state.selectorKey];
        const el = pick(list);
        if (!el) return null;
        return el.classList.length >= (state.min || 2);
      }
      if (state.type === 'useHref') {
        const el = pick(state.selector);
        if (!el) return null;
        const href = el.getAttribute('href') || el.href?.baseVal || '';
        return String(href).includes(String(state.equals || '').replace('#', ''));
      }
      if (state.type === 'toggle') {
        const on = document.querySelector(state.onSelector);
        const off = document.querySelector(state.offSelector);
        if (!on && !off) return null;
        return !!on;
      }
      if (state.type === 'ariaPressed') {
        const el = pick(state.selector);
        return el ? el.getAttribute('aria-pressed') === 'true' : null;
      }
      if (state.type === 'classContains') {
        const el = pick(state.selector);
        return el ? el.className.includes(state.contains || '') : null;
      }
    } catch { return null; }
    return null;
  };

  const s = cfg.selectors || {};
  const title = txt(s.title);
  const authorEl = pick(s.author);
  const author = authorEl ? (authorEl.innerText || authorEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
  const authorLinkEl = pick(s.authorLink);
  const countFrom = (list, label) => {
    const els = pickAll(list);
    for (const el of els) {
      const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      const n = parseCount(t);
      if (n !== null) return { raw: t, value: n, label };
    }
    return { raw: '', value: null, label };
  };

  const loginHit = (s.loginFlag || []).some((x) => { try { return !!document.querySelector(x); } catch { return false; } });

  return {
    ok: true,
    url: location.href,
    loggedOut: loginHit,
    title,
    author,
    authorUrl: authorLinkEl ? (authorLinkEl.href || '') : '',
    like: countFrom(s.collectCount),
    comment: countFrom(s.commentCount),
    isLiked: stateOf(cfg.likeState),
    isCollected: stateOf(cfg.collectState),
    desc: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
  };
}

/**
 * 全自动第一步：一次性抓「内容 + 评论区」。
 * 只开一次页面，减少风控暴露面。
 */
export async function injectHarvest(cfg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pick = (list) => {
    const arr = Array.isArray(list) ? list : [list];
    for (const s of arr) { try { const el = document.querySelector(s); if (el) return el; } catch { } }
    return null;
  };
  const pickAll = (list) => {
    const arr = Array.isArray(list) ? list : [list];
    for (const s of arr) {
      try { const els = document.querySelectorAll(s); if (els.length) return Array.from(els); } catch { }
    }
    return [];
  };
  const txtOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const txt = (list) => txtOf(pick(list));
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || 1) > 0.05;
  };
  const parseCount = (input) => {
    if (!input) return null;
    const m = /([0-9]*\.?[0-9]+)\s*(万|亿|w|W|k|K|m|M)?/.exec(String(input).replace(/\s|,/g, ''));
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return null;
    const f = { '万': 1e4, w: 1e4, '亿': 1e8, k: 1e3, m: 1e6 }[(m[2] || '').toLowerCase()] ?? 1;
    return Math.round(n * f);
  };

  const s = cfg.selectors || {};
  // 登录判定必须带可见性：很多站点把登录弹窗留在 DOM 里但隐藏
  const loginHit = (s.loginFlag || []).some((x) => { try { return visible(document.querySelector(x)); } catch { return false; } });

  // 评论正文里常夹表情包图片：照搬 AiToEarn 的做法——克隆一份，
  // 把 img 换成它的 alt 文字，再取 textContent。否则图片会把句子截成两半。
  const readCommentText = (el) => {
    if (!el) return '';
    let clone;
    try { clone = el.cloneNode(true); } catch { return txtOf(el); }
    try {
      clone.querySelectorAll?.('img').forEach((img) => {
        try { img.replaceWith(img.alt || ''); } catch { }
      });
    } catch { }
    return (clone.textContent || clone.innerText || txtOf(el) || '').replace(/\s+/g, ' ').trim();
  };

  // ★ 抖音评论区加载很慢（实测：打开后 30 秒才渲染出真实评论）。
  //   在此之前 DOM 里是「加载中」「服务异常，刷新拉取数据」这类占位，
  //   它们也带 data-e2e="comment-item"，会被当成真评论收进来。
  //   所以：评论区场景要等「真正有内容的条目」出现，不能只等列表出现。
  const isPlaceholder = (t) => /^(加载中|加载更多|暂无评论|服务异常|刷新拉取|查看更多评论|没有更多)/.test(t || '');

  /** 数一条评论是否「有真内容」：正文非空且不是占位 */
  const commentReady = () => {
    try {
      const list = pickAll(s.commentItem);
      if (!list.length) return false;
      let real = 0;
      for (const node of list) {
        const textEl = (s.commentText || []).length ? (() => {
          for (const sel of s.commentText) { try { const e = node.querySelector(sel); if (e) return e; } catch { } }
          return node;
        })() : node;
        const t = readCommentText(textEl);
        if (t.length >= 2 && !isPlaceholder(t)) real++;
      }
      return real >= 1;
    } catch { return false; }
  };

  // 等页面渲染。
  // ★ 抖音冷启动极慢（无头环境实测：60 秒后正文与评论才渲染），
  //   readyFlag 迟迟不出现时，退一步用「页面里有正文/任何 e2e 元素」判定「页面活了」。
  const readyList = [...(s.readyFlag || []), ...(s.title || []), ...(s.commentItem || [])];
  const pageAlive = () => {
    for (const x of readyList) { try { if (document.querySelector(x)) return true; } catch { } }
    try { if ((document.body?.innerText || '').length > 200) return true; } catch { }
    try { if (document.querySelectorAll('[data-e2e]').length > 10) return true; } catch { }
    return false;
  };
  const t0 = Date.now();
  while (Date.now() - t0 < (cfg.readyTimeoutMs || 15000)) {
    if (pageAlive()) break;
    await sleep(400);
  }

  // 等评论真正加载完。只在「评论列表已经出现、但还没有真内容」时等：
  //   桩测试/非评论页（列表压根不存在）直接跳过，不会白等 35 秒。
  const scrollSel = (s.commentScroll || []).concat(s.commentItem || []);
  if (cfg.commentReady !== false && pick(scrollSel)) {
    const tc = Date.now();
    const commentBudget = cfg.commentReadyTimeoutMs || 35000;
    while (Date.now() - tc < commentBudget) {
      if (commentReady()) break;
      await sleep(500);
    }
  }

  /* ---------- 自动发现兜底：选择器失效时在页面上找长得像的 ---------- */

  /** 从按钮自身/兄弟/父级里抠出数字（抖音的计数常贴在图标旁边） */
  const countNear = (buttonList) => {
    const btn = pick(buttonList);
    if (!btn) return { raw: '', value: null };
    const tryText = (el) => {
      if (!el) return null;
      const t = txtOf(el);
      if (!t || t.length > 12) return null;
      if (!/^[\d.,]+\s*(万|亿|w|k)?$/i.test(t)) return null;
      return t;
    };
    let node = btn;
    for (let up = 0; up < 4 && node; up++) {
      const own = tryText(node);
      if (own) return { raw: own, value: parseCount(own) };
      const sib = node.nextElementSibling;
      const st = tryText(sib);
      if (st) return { raw: st, value: parseCount(st) };
      const prev = node.previousElementSibling;
      const pt = tryText(prev);
      if (pt) return { raw: pt, value: parseCount(pt) };
      // 容器里找第一个纯数字的叶子
      const numeric = Array.from(node.querySelectorAll('span,div')).find((el) => tryText(el));
      const nt = tryText(numeric);
      if (nt) return { raw: nt, value: parseCount(nt) };
      node = node.parentElement;
    }
    return { raw: '', value: null };
  };

  /** 从整页文本里找「数字 + 关键词」 */
  const countByKeyword = (keyword) => {
    try {
      const m = new RegExp(`([0-9]+(?:\\.[0-9]+)?)\\s*(万|亿|w|k)?\\s*(?:条)?\\s*${keyword}`).exec(document.body.innerText || '');
      if (m) return { raw: m[0], value: parseCount(m[0]) };
    } catch { }
    return { raw: '', value: null };
  };

  const countFrom = (list, buttonList, keyword) => {
    for (const el of pickAll(list)) {
      const t = txtOf(el);
      const n = parseCount(t);
      if (n !== null) return { raw: t, value: n };
    }
    const near = countNear(buttonList || []);
    if (near.value !== null) return near;
    if (keyword) {
      const byKw = countByKeyword(keyword);
      if (byKw.value !== null) return byKw;
    }
    return { raw: '', value: null };
  };

  /** 找不到配置里的评论条目选择器时，自己找一组「重复出现、文本像评论」的元素 */
  const discoverComments = (max) => {
    const groups = new Map();
    for (const el of document.querySelectorAll('[class*="comment" i],[data-e2e*="comment" i]')) {
      const cls = typeof el.className === 'string' ? el.className : '';
      for (const key of cls.split(/\s+/)) {
        if (!key || !/comment/i.test(key)) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(el);
      }
    }
    let best = null;
    for (const [, els] of groups) {
      const good = els.filter((el) => {
        const t = txtOf(el);
        // 下限放到 3：中文两三个字的短评很常见（如「求教程」）
        // 占位文本（加载中/服务异常）不算评论
        return t.length >= 3 && t.length <= 400 && visible(el) && !isPlaceholder(t);
      });
      if (good.length >= 2 && (!best || good.length > best.length)) best = good;
    }
    if (!best) return [];
    return best.slice(0, max).map((el) => ({
      author: '', like: null,
      text: txtOf(el).slice(0, 300),
      raw: txtOf(el).slice(0, 300),
    }));
  };

  // ---- A. 内容 ----
  let title = txt(s.title);
  if (!title) {
    // 兜底：og:title / twitter:title / 文档标题（去掉“- 抖音”之类后缀）
    const meta = document.querySelector('meta[property="og:title"],meta[name="twitter:title"]');
    title = (meta?.content || document.title || '').replace(/\s*[-|·]\s*(抖音|小红书|Douyin).*$/i, '').trim();
  }
  const desc = txt(s.desc);
  const tags = Array.from(new Set(pickAll(s.tags).map(txtOf).filter((t) => t && t.length <= 30))).slice(0, 12);
  const authorEl = pick(s.author);
  const authorLinkEl = pick(s.authorLink);

  const content = {
    url: location.href,
    title,
    desc: desc.slice(0, 1500),
    tags,
    author: txtOf(authorEl),
    authorUrl: authorLinkEl ? (authorLinkEl.href || '') : '',
    likeCount: countFrom(s.likeCount, s.likeButton, '点赞').value,
    commentCount: countFrom(s.commentCount, s.commentButton, '评论').value,
    favoriteCount: countFrom(s.favoriteCount, s.collectButton, '收藏').value,
    isLiked: (() => {
      const st = cfg.likeState;
      if (!st || st.type === 'none') return null;
      try {
        if (st.type === 'classCount') {
          const el = pick(cfg.selectors?.[st.selectorKey]);
          return el ? el.classList.length >= (st.min || 2) : null;
        }
        if (st.type === 'useHref') {
          const el = pick(st.selector);
          if (!el) return null;
          const href = el.getAttribute('href') || el.href?.baseVal || '';
          return String(href).includes(String(st.equals || '').replace('#', ''));
        }
        if (state.type === 'toggle') {
          const on = document.querySelector(state.onSelector);
          const off = document.querySelector(state.offSelector);
          if (!on && !off) return null;
          return !!on;
        }
        if (st.type === 'ariaPressed') {
          const el = pick(st.selector);
          return el ? el.getAttribute('aria-pressed') === 'true' : null;
        }
        if (st.type === 'classContains') {
          const el = pick(st.selector);
          return el ? el.className.includes(st.contains || '') : null;
        }
      } catch { }
      return null;
    })(),
  };

  // ---- B. 评论区 ----
  const max = cfg.commentMax || 20;
  const scrolls = cfg.commentScrolls ?? 6;
  const seen = new Map();

  const grab = () => {
    const configured = pickAll(s.commentItem);
    if (configured.length) {
      for (const node of configured) {
        const textEl = (s.commentText || []).length ? (() => {
          for (const sel of s.commentText) { try { const e = node.querySelector(sel); if (e) return e; } catch { } }
          return node;
        })() : node;
        const text = readCommentText(textEl).slice(0, 300);
        if (!text || text.length < 2) continue;
        if (isPlaceholder(text)) continue; // 加载中 / 服务异常 这类占位不收
        let author = '';
        for (const sel of (s.commentAuthor || [])) { try { const e = node.querySelector(sel); if (e) { author = txtOf(e); break; } } catch { } }
        let like = null;
        for (const sel of (s.commentLike || [])) {
          try { const e = node.querySelector(sel); if (e) { like = parseCount(txtOf(e)); break; } } catch { }
        }
        const key = `${author}|${text.slice(0, 40)}`;
        if (!seen.has(key)) seen.set(key, { author, text, like, raw: txtOf(node).slice(0, 300) });
        if (seen.size >= max) return;
      }
      return;
    }
    // 配置的选择器没命中 → 自动发现
    for (const c of discoverComments(max)) {
      const key = `|${c.text.slice(0, 40)}`;
      if (!seen.has(key)) seen.set(key, c);
      if (seen.size >= max) return;
    }
  };

  grab();

  // 有的平台评论区默认是收起的（抖音），先点评论图标把它展开再抓
  let openedComments = false;
  if (seen.size === 0 && Array.isArray(cfg.openCommentsBy) && cfg.openCommentsBy.length) {
    const openBtn = pick(cfg.openCommentsBy);
    if (openBtn && visible(openBtn)) {
      try { openBtn.click(); } catch { }
      await sleep(cfg.openCommentsDelayMs || 1500);
      grab();
      openedComments = true;
    }
  }

  let done = 0;
  for (let i = 0; i < scrolls; i++) {
    if (seen.size >= max) break;
    const before = seen.size;
    // 照搬 AiToEarn 的 loadMoreComments：滚动的不是评论列表本身，而是它的父级容器
    const box = pick(s.commentScroll);
    try {
      const target = box?.parentElement || box;
      if (target && target.scrollHeight > target.clientHeight + 10) {
        target.scrollTop = target.scrollHeight;
      }
      if (window && document.documentElement) window.scrollTo(0, document.documentElement.scrollHeight);
    } catch { }
    await sleep(cfg.commentScrollDelayMs || 1200);
    grab();
    done++;
    if (seen.size === before && i >= 1) break; // 连续两次没有新增就停
  }

  return {
    ok: true,
    url: location.href,
    loggedOut: loginHit,
    content,
    comments: Array.from(seen.values()).slice(0, max),
    scrolls: done,
    openedComments,
    discovered: {
      comments: pickAll(s.commentItem).length === 0,
      title: !txt(s.title),
      counts: {
        like: content.likeCount === null,
        comment: content.commentCount === null,
        favorite: content.favoriteCount === null,
      },
    },
  };
}

/** 详情页：执行点赞 / 取消点赞 / 收藏 / 评论 */
export async function injectInteract(cfg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pick = (list) => {
    const arr = Array.isArray(list) ? list : [list];
    for (const s of arr) { try { const el = document.querySelector(s); if (el) return el; } catch { } }
    return null;
  };
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && st.display !== 'none' && st.visibility !== 'hidden';
  };
  const pickAll = (list) => {
    const arr = Array.isArray(list) ? list : [list];
    for (const s of arr) {
      try { const els = document.querySelectorAll(s); if (els.length) return Array.from(els); } catch { }
    }
    return [];
  };
  const stateOf = (state) => {
    if (!state || state.type === 'none') return null;
    try {
      if (state.type === 'classCount') {
        const el = pick(cfg.selectors?.[state.selectorKey]);
        return el ? el.classList.length >= (state.min || 2) : null;
      }
      if (state.type === 'useHref') {
        const el = pick(state.selector);
        if (!el) return null;
        const href = el.getAttribute('href') || el.href?.baseVal || '';
        return String(href).includes(String(state.equals || '').replace('#', ''));
      }
      if (state.type === 'toggle') {
        const on = document.querySelector(state.onSelector);
        const off = document.querySelector(state.offSelector);
        if (!on && !off) return null;
        return !!on;
      }
      if (state.type === 'ariaPressed') {
        const el = pick(state.selector);
        return el ? el.getAttribute('aria-pressed') === 'true' : null;
      }
      if (state.type === 'classContains') {
        const el = pick(state.selector);
        return el ? el.className.includes(state.contains || '') : null;
      }
    } catch { return null; }
    return null;
  };
  const waitFor = async (test, timeoutMs, stepMs = 300) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (test()) return true; } catch { }
      await sleep(stepMs);
    }
    return false;
  };

  const s = cfg.selectors || {};
  const result = { ok: false, action: cfg.action, steps: [] };

  // 1) 登录与就绪检查（登录判定必须带可见性：站点常把登录弹窗留在 DOM 里但隐藏）
  const loginHit = (s.loginFlag || []).some((x) => { try { return visible(document.querySelector(x)); } catch { return false; } });
  if (loginHit) return { ...result, needLogin: true, error: '页面显示未登录，已中止本次操作' };

  const readyList = [...(s.readyFlag || []), ...(s.likeButton || []), ...(s.commentInput || [])];
  const ready = await waitFor(() => readyList.some((x) => { try { return !!document.querySelector(x); } catch { return false; } }), cfg.readyTimeoutMs || 15000, 400);
  result.steps.push({ step: 'waitReady', ok: ready });
  if (!ready) return { ...result, error: '页面元素未在超时内出现（选择器可能已失效，请用自检面板校准）' };

  // 2) 点赞 / 收藏
  if (cfg.action === 'like' || cfg.action === 'unlike' || cfg.action === 'favorite') {
    const isLike = cfg.action !== 'favorite';
    const btnList = isLike ? s.likeButton : s.collectButton;
    const state = isLike ? cfg.likeState : cfg.collectState;
    const target = cfg.action === 'unlike' ? false : true;

    const btn = pick(btnList);
    if (!btn) return { ...result, error: `找不到${isLike ? '点赞' : '收藏'}按钮，选择器可能已失效` };
    const before = stateOf(state);
    result.before = before;
    result.steps.push({ step: 'readState', ok: before !== null, detail: String(before) });

    if (before === null) {
      result.steps.push({ step: 'stateUnknown', ok: false, detail: '无法判定当前状态，为避免重复操作已跳过' });
      return { ...result, skipped: true, error: '无法判定当前状态（状态选择器失效）' };
    }
    if (before === target) {
      return { ...result, ok: true, alreadyInTarget: true, after: before, message: '已经是目标状态，跳过' };
    }
    if (cfg.dryRun) return { ...result, ok: true, dryRun: true, message: `dry-run：本应${target ? '点亮' : '取消'}${isLike ? '点赞' : '收藏'}` };

    if (!visible(btn)) {
      btn.scrollIntoView({ block: 'center' });
      await sleep(400);
    }
    btn.click();
    result.steps.push({ step: 'click', ok: true });

    const changed = await waitFor(() => stateOf(state) === target, cfg.actionTimeoutMs || 8000, 300);
    const after = stateOf(state);
    result.after = after;
    result.steps.push({ step: 'verify', ok: changed, detail: String(after) });
    return { ...result, ok: changed, message: changed ? '操作成功' : '已点击，但状态未在超时内确认变化' };
  }

  // 3) 评论
  if (cfg.action === 'comment') {
    /** 找到元素后往上找到真正带 contenteditable 的容器（Draft.js 的焦点元素常在内层） */
    const editableAncestor = (el) => {
      let n = el;
      for (let i = 0; i < 8 && n; i++) {
        if (n.isContentEditable || n.getAttribute?.('contenteditable') === 'true') return n;
        n = n.parentElement;
      }
      return el;
    };

    // 配置的选择器优先；没命中就在页面上自动找（平台改版时靠这层兜底）
    const discoverCommentInput = () => {
      const cands = Array.from(document.querySelectorAll('[contenteditable="true"],.public-DraftEditor-content,textarea,[role="textbox"]'))
        .map(editableAncestor)
        .filter(visible);
      if (!cands.length) return null;
      const hintOf = (el) => (el.getAttribute?.('placeholder') || el.getAttribute?.('aria-label') || el.getAttribute?.('data-placeholder') || el.innerText || '').trim();
      const byHint = cands.find((el) => /评论|说点|善语|写下|有什么|友善/.test(hintOf(el)));
      if (byHint) return byHint;
      // 没提示词就取页面上最靠下的那个（评论区通常在底部）
      return cands.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
    };

    const discoverSubmit = (input) => {
      let node = input;
      for (let up = 0; up < 6 && node; up++) {
        const btns = Array.from(node.querySelectorAll('button,[role="button"],span,div'))
          .filter(visible)
          .filter((el) => {
            const t = (el.innerText || '').trim();
            return t.length <= 5 && /^(发送|发布|评论|提交|确定|回复)$/.test(t);
          });
        if (btns.length) return btns[0];
        node = node.parentElement;
      }
      return null;
    };

    /** 纯图标发送按钮的场景：直接按回车（评论框基本都支持） */
    const pressEnter = (el) => {
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      try { el.dispatchEvent(new KeyboardEvent('keydown', opts)); } catch { }
      try { el.dispatchEvent(new KeyboardEvent('keypress', opts)); } catch { }
      try { el.dispatchEvent(new KeyboardEvent('keyup', opts)); } catch { }
      return true;
    };

    let input = pick(s.commentInput);

    // ★ 关键一步（照搬 AiToEarn 实测的顺序）：
    //   评论区收起时编辑器的 DOM 根本不存在，必须先点一下输入区域把编辑器"叫出来"
    //   真实页面实测：点击后编辑器要 1~2 秒才渲染，等待不够会接着失败
    if (Array.isArray(cfg.commentTrigger) && cfg.commentTrigger.length) {
      const trigger = pick(cfg.commentTrigger);
      if (trigger && visible(trigger)) {
        try { trigger.click(); } catch { }
        result.steps.push({ step: 'trigger', ok: true, detail: '点击评论区域，等编辑器渲染' });
        // 分段等：编辑器渲染是异步的，第一次没等到就再等
        for (let i = 0; i < 3 && !pick(s.commentInput); i++) {
          await sleep((cfg.commentTriggerDelayMs || 800) / (i === 0 ? 1 : 2));
        }
        if (!pick(s.commentInput)) await sleep(cfg.commentTriggerDelayMs || 800);
        input = pick(s.commentInput);
      } else {
        result.steps.push({ step: 'trigger', ok: false, detail: trigger ? '评论区域不可见' : '没找到可点击的评论区域' });
      }
    }

    if (input) input = editableAncestor(input);
    if (input && !visible(input)) input = null;
    if (!input) {
      input = discoverCommentInput();
      result.steps.push({ step: 'discoverInput', ok: !!input, detail: input ? '自动找到了输入框' : '没找到' });
    }
    if (!input) return { ...result, error: '找不到评论输入框（配置选择器、点击展开、自动查找都试过了），请用自检面板校准' };

    let submit = pick(s.commentSubmit);
    if (submit && !visible(submit)) submit = null;
    if (!submit) {
      submit = discoverSubmit(input);
      result.steps.push({ step: 'discoverSubmit', ok: !!submit, detail: submit ? '自动找到了提交按钮' : '没找到，将用回车提交' });
    }
    if (!submit) {
      // 有些站点的提交按钮在输入框所在容器的同级，再往外找一层
      let node = input.parentElement;
      for (let up = 0; up < 6 && !submit && node; up++) {
        submit = Array.from(node.querySelectorAll('button,[role="button"]')).filter(visible).pop() || null;
        node = node.parentElement;
      }
    }
    // 仍然没有：不报错，改用回车提交（抖音的发送按钮是纯图标，没有文字可匹配）
    const useEnter = !submit;

    const text = String(cfg.content || '').trim();
    if (!text) return { ...result, error: '评论内容为空' };
    if (cfg.dryRun) return { ...result, ok: true, dryRun: true, message: `dry-run：本应评论「${text.slice(0, 40)}」` };

    const readInput = (el) => (el ? (el.isContentEditable ? (el.innerText || el.textContent || '') : (el.value || '')).trim() : '');

    input.scrollIntoView({ block: 'center' });
    await sleep(300);
    try { input.click(); input.focus(); } catch { }
    await sleep(200);

    // 填入文本。顺序照搬 AiToEarn 的实测做法：
    //   Draft.js 这类富文本编辑器对 execCommand 支持不好，**粘贴事件最可靠**
    let filled = false;
    let fillMethod = '';
    try {
      if (input.isContentEditable) {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
        filled = true;
        fillMethod = 'paste';
        await sleep(300);
        // 粘贴没生效时再用 execCommand 补一次
        if (!readInput(input).includes(text.slice(0, 4))) {
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
          document.execCommand('insertText', false, text);
          fillMethod = 'paste+insertText';
          try { input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' })); } catch { }
        }
      } else {
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        filled = true;
        fillMethod = 'value';
      }
    } catch (e) {
      result.steps.push({ step: 'fill', ok: false, detail: String(e) });
    }

    // 关键校验：DOM 里是否真的写进去了。很多站点会用自己的编辑器接管，静默丢弃输入。
    await sleep(150);
    const mark = text.slice(0, 6);
    const afterFill = readInput(input);
    const fillVerified = afterFill.includes(mark);
    result.steps.push({ step: 'fill', ok: filled, detail: fillVerified ? `已写入（${fillMethod}）` : `未确认写入（${fillMethod}）` });
    if (!filled) return { ...result, error: '无法把评论写进输入框' };
    if (!fillVerified) {
      result.steps.push({ step: 'fillCheck', ok: false, detail: afterFill.slice(0, 40) });
      return { ...result, error: '评论未能真正写入输入框（站点编辑器可能拒绝了本次输入），已中止提交' };
    }

    // 等提交按钮可用
    await waitFor(() => {
      const el = pick(s.commentSubmit);
      if (!el) return false;
      const dis = el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled');
      const cls = String(el.className || '');
      return !dis && !/disabled/i.test(cls);
    }, 5000, 250);

    if (useEnter) {
      pressEnter(input);
      result.steps.push({ step: 'submit', ok: true, detail: '用回车提交（没找到发送按钮）' });
    } else {
      const submitEl = pick(s.commentSubmit) || submit;
      if (!submitEl) return { ...result, error: '提交按钮消失了' };
      if (!visible(submitEl)) { submitEl.scrollIntoView({ block: 'center' }); await sleep(300); }
      submitEl.click();
      result.steps.push({ step: 'submit', ok: true, detail: '点击发送按钮' });
    }

    // 判定结果。照搬 AiToEarn 的验证方式：轮询 5 秒，
    //   ① 先看有没有弹短信验证 → 需要人工
    //   ② 再比对评论列表第一条的内容是否等于我们发出去的文本
    let needHumanAssist = false;
    let verifyReason = '';
    let okMatched = false;
    let okClear = false;

    const rounds = Math.max(4, Math.round((cfg.actionTimeoutMs || 10000) / 500));
    for (let i = 0; i < Math.min(rounds, 12); i++) {
      await sleep(500);

      // ① 短信验证码弹窗
      const sms = pick(s.smsVerification);
      if (sms && visible(sms)) {
        needHumanAssist = true;
        verifyReason = 'sms_verification_required';
        result.steps.push({ step: 'verify', ok: false, detail: '触发短信验证，需要人工处理' });
        return {
          ...result, ok: false, verified: false, needHumanAssist: true, verificationReason: verifyReason,
          message: '平台要求短信验证，本条未完成，请人工处理',
        };
      }

      // ② 评论列表第一条是否就是我们发的内容
      const items = pickAll(s.commentResultItem);
      const first = items[0];
      if (first) {
        const t = (first.innerText || first.textContent || '').trim();
        if (t === text || t.includes(text)) { okMatched = true; break; }
      }

      // ③ 输入框被清空也是强信号
      const el = pick(s.commentInput);
      if (readInput(el).length === 0) { okClear = true; break; }
    }

    // 再给一次兜底机会：评论区里出现了带我们文本的条目
    let okAppeared = false;
    if (!okMatched && !okClear) {
      okAppeared = await waitFor(() => {
        try {
          const nodes = document.querySelectorAll((s.commentResultItem || s.commentSuccess || ['.comment']).join(','));
          return Array.from(nodes).some((n) => (n.innerText || '').includes(mark));
        } catch { return false; }
      }, 2500, 400);
    }

    const verified = okMatched || okClear || okAppeared;
    result.steps.push({
      step: 'verify', ok: verified,
      detail: okMatched ? '评论区第一条就是我们发的内容' : okClear ? '输入框已清空' : okAppeared ? '评论区出现该条内容' : '未确证',
    });
    return {
      ...result,
      ok: true,
      verified,
      needHumanAssist,
      verificationReason: verifyReason,
      message: verified ? '评论已提交并确认' : '评论已提交，但未能确证（请人工抽查）',
    };
  }

  return { ...result, error: `不支持的动作：${cfg.action}` };
}

/** 选择器拾取：进入拾取模式（拦截点击，不影响页面自身行为） */export function injectPickStart() {
  if (window.__vhPicking) return { ok: true, already: true };
  window.__vhPicking = true;
  window.__vhPicked = null;
  const style = document.createElement('style');
  style.id = '__vh_pick_style';
  style.textContent = '*:hover{outline:2px solid #2563eb !important;outline-offset:-2px;}';
  document.documentElement.appendChild(style);

  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
      let sel = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) { parts.unshift('#' + node.id); break; }
      const cls = (typeof node.className === 'string' ? node.className : '').trim().split(/\s+/)
        .filter((c) => /^[A-Za-z][\w-]*$/.test(c) && !/^(active|hover|selected)$/.test(c)).slice(0, 2);
      if (cls.length) sel += '.' + cls.join('.');
      const parent = node.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      }
      parts.unshift(sel);
      try { if (document.querySelectorAll(parts.join(' > ')).length === 1) break; } catch { }
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  const onClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const el = e.target;
    let selector = '';
    try { selector = cssPath(el); } catch { }
    let count = 0;
    try { count = selector ? document.querySelectorAll(selector).length : 0; } catch { }
    window.__vhPicked = {
      selector,
      count,
      tag: el.tagName,
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      at: Date.now(),
    };
    window.__vhPicking = false;
    document.removeEventListener('click', onClick, true);
    try { document.getElementById('__vh_pick_style')?.remove(); } catch { }
  };
  document.addEventListener('click', onClick, true);
  return { ok: true, started: true };
}

/** 读取拾取结果 */
export function injectPickGet() {
  const picked = window.__vhPicked || null;
  return { ok: true, picking: !!window.__vhPicking, picked };
}
