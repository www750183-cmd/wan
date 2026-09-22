// 收录流程：链接批量 / 关键词搜索 / 创作者主页
import { PLATFORMS, detectPlatform, extractUrls, workIdFromUrl, isWorkUrl, isShortLink, resolveSelectors, resolveState } from './platforms.js';
import { withPage, resolveShortUrl, inject } from './tab.js';
import { injectCollectList, injectExtractWork } from '../injected.js';
import { sleep, uniqBy, uid } from './util.js';

/** 把用户输入解析成任务清单 */
export function buildPlan(input, settings) {
  const urls = extractUrls(input.links || '');
  const keywords = String(input.keywords || '').split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
  const enabled = settings.enabledPlatforms || {};

  const links = [];
  const userPages = [];
  for (const u of urls) {
    const p = detectPlatform(u);
    if (!p || !enabled[p]) continue;
    if (isWorkUrl(p, u)) links.push({ platform: p, url: u, needsResolve: false });
    else if (isShortLink(p, u)) links.push({ platform: p, url: u, needsResolve: true });
    else userPages.push({ platform: p, url: u });
  }

  const searches = [];
  for (const kw of keywords) {
    for (const key of Object.keys(PLATFORMS)) {
      if (!enabled[key]) continue;
      if (!PLATFORMS[key].supports.listScroll) continue;
      const build = PLATFORMS[key].listUrl?.search;
      if (typeof build === 'function' && kw) searches.push({ platform: key, url: build(kw), keyword: kw });
    }
  }

  return { links, userPages, searches };
}

function selectorCfg(platformKey, settings, extra = {}) {
  const p = PLATFORMS[platformKey];
  return {
    selectors: resolveSelectors(platformKey, settings.selectorOverrides?.[platformKey]),
    likeState: resolveState(platformKey, 'likeState', settings.selectorOverrides?.[platformKey]),
    collectState: resolveState(platformKey, 'collectState', settings.selectorOverrides?.[platformKey]),
    ...extra,
  };
}

async function collectOneWork(task, settings, hooks) {
  const p = PLATFORMS[task.platform];
  const cfg = selectorCfg(task.platform, settings);
  return withPage(task.url, settings, async ({ tabId, url }) => {
    const data = await inject(tabId, injectExtractWork, [cfg]);
    if (data.loggedOut) throw new Error('未登录：请先在浏览器里登录该平台，再重跑');
    return {
      id: uid('item'),
      platform: task.platform,
      platformName: p.name,
      workId: workIdFromUrl(task.platform, url) || task.workId || '',
      url,
      title: data.title || task.title || '',
      author: data.author || '',
      authorUrl: data.authorUrl || '',
      likeCount: data.like?.value ?? null,
      likeCountRaw: data.like?.raw || '',
      commentCount: data.comment?.value ?? null,
      commentCountRaw: data.comment?.raw || '',
      isLiked: data.isLiked,
      isCollected: data.isCollected,
      source: task.source || '',
      keyword: task.keyword || '',
      collectedAt: new Date().toISOString(),
    };
  });
}

async function collectListPage(task, settings, hooks) {
  const p = PLATFORMS[task.platform];
  const cfg = selectorCfg(task.platform, settings);
  const listCfg = {
    selectors: cfg.selectors.collectLinks || [],
    include: {
      douyin: ['douyin\\.com/(video|note)/'],
      xhs: ['xiaohongshu\\.com/(explore|discovery/item)/'],
      wxSph: ['channels\\.weixin\\.qq\\.com'],
    }[task.platform] || [],
    exclude: ['/search', '/user/', '/login'],
    scrolls: settings.scrolls,
    scrollDelayMs: settings.scrollDelayMs,
    maxItems: settings.maxItemsPerRun,
  };

  return withPage(task.url, settings, async ({ tabId, url }) => {
    const res = await inject(tabId, injectCollectList, [listCfg]);
    const links = [];
    for (const l of res.links || []) {
      const pid = detectPlatform(l.url);
      if (!pid || pid !== task.platform) continue;
      if (task.platform !== 'wxSph' && !isWorkUrl(task.platform, l.url)) continue;
      links.push({
        id: uid('item'),
        platform: task.platform,
        platformName: p.name,
        workId: workIdFromUrl(task.platform, l.url) || '',
        url: l.url,
        title: l.title || '',
        author: '',
        authorUrl: '',
        likeCount: null,
        likeCountRaw: '',
        commentCount: null,
        commentCountRaw: '',
        isLiked: null,
        isCollected: null,
        source: task.keyword ? `搜索:${task.keyword}` : (task.source || '列表页'),
        keyword: task.keyword || '',
        collectedAt: new Date().toISOString(),
      });
    }
    return links;
  });
}

/**
 * 执行收录
 * @param plan buildPlan 的结果
 * @param settings
 * @param hooks {onProgress, shouldStop}
 */
export async function runCollect(plan, settings, hooks = {}) {
  const report = hooks.onProgress || (() => { });
  const shouldStop = hooks.shouldStop || (() => false);

  const tasks = [
    ...plan.links.map((t) => ({ ...t, kind: 'work', source: '链接' })),
    ...plan.userPages.map((t) => ({ ...t, kind: 'list', source: '主页', keyword: '' })),
    ...plan.searches.map((t) => ({ ...t, kind: 'list', source: `搜索:${t.keyword}`, keyword: t.keyword })),
  ];

  if (tasks.length === 0) throw new Error('没有可执行的收录任务：请检查链接格式或平台开关');

  const items = [];
  const errors = [];
  let index = 0;

  for (const task of tasks) {
    if (shouldStop()) { report(`已停止（完成 ${index}/${tasks.length}）`); break; }
    index++;
    const label = task.kind === 'work' ? '详情页' : (task.keyword ? `搜索「${task.keyword}」` : '主页');
    report(`[${index}/${tasks.length}] ${PLATFORMS[task.platform].name} · ${label}`);

    try {
      // 短链或非常规链接：先展开
      let t = task;
      if (task.kind === 'work' && !isWorkUrl(task.platform, task.url)) {
        const finalUrl = await resolveShortUrl(task.url, settings);
        const pid = detectPlatform(finalUrl);
        if (!pid || !isWorkUrl(pid, finalUrl)) throw new Error(`无法从 ${task.url} 解析出作品页地址`);
        t = { ...task, platform: pid, url: finalUrl };
      }

      if (t.kind === 'work') {
        items.push(await collectOneWork(t, settings, hooks));
      } else {
        let links = await collectListPage(t, settings, hooks);
        links = uniqBy(links, (i) => i.url).slice(0, settings.maxItemsPerRun);
        report(`[${index}/${tasks.length}] ${PLATFORMS[t.platform].name} · ${label} → 收到 ${links.length} 条`);

        if (settings.deepCollect && t.platform !== 'wxSph') {
          const picked = links.slice(0, settings.maxItemsPerRun);
          for (let i = 0; i < picked.length; i++) {
            if (shouldStop()) break;
            report(`  深收录 ${i + 1}/${picked.length}`);
            try {
              items.push(await collectOneWork({ ...picked[i], kind: 'work' }, settings, hooks));
            } catch (e) {
              errors.push({ url: picked[i].url, error: e.message });
              items.push(picked[i]);
            }
            await sleep(1200);
          }
        } else {
          items.push(...links);
        }
      }
    } catch (e) {
      errors.push({ url: task.url, error: e?.message || String(e) });
      report(`[${index}/${tasks.length}] 失败：${e?.message || e}`);
    }

    if (index < tasks.length) await sleep(1500);
  }

  return { items: uniqBy(items, (i) => `${i.platform}:${i.workId || i.url}`), errors, tasks: tasks.length };
}
