// Service Worker：消息路由 + 固定流程编排 + 进度广播
import {
  DEFAULT_SETTINGS, getSettings, saveSettings, patchSelectors,
  getState, setState, getCollected, setCollected, appendCollected,
  getLogs, clearLogs, getDaily,
} from './lib/store.js';
import { PLATFORMS, detectPlatform, resolveSelectors, resolveState } from './lib/platforms.js';
import { buildPlan, runCollect } from './lib/collect.js';
import { runFixedFlow } from './lib/autoflow.js';
import { testLLM, listModels } from './lib/llm.js';
import { withPage, inject, waitForComplete, openPage, currentUrl } from './lib/tab.js';
import { injectProbe, injectPickStart, injectPickGet } from './injected.js';
import { logsToCsv, logsToJson, logsToMarkdown, fileName } from './lib/export.js';

/**
 * 协议版本：**任何会改变 GET_STATUS 返回结构或消息类型的改动都要 +1**。
 * 控制台页会拿它比对；不一致就提示重新加载扩展，避免
 * 「页面是新的、后台是旧的」导致看不懂的报错。
 */
const PROTOCOL = 3;

const run = { stopRequested: false, active: false };

function broadcast(msg) {
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === 'function') p.catch(() => { });
  } catch { /* 无接收端 */ }
}

function report(progress, extra = {}) {
  setState({ progress }).catch(() => { });
  broadcast({ type: 'VH_PROGRESS', progress, ...extra });
}

chrome.runtime.onInstalled.addListener(async () => {
  const bag = await chrome.storage.local.get('vh.settings');
  if (!bag['vh.settings']) await chrome.storage.local.set({ 'vh.settings': DEFAULT_SETTINGS });
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
  return true;
});

async function handle(msg, sender) {
  switch (msg?.type) {
    case 'GET_STATUS': {
      const [settings, state, collected, logs, daily] = await Promise.all([
        getSettings(), getState(), getCollected(), getLogs(), getDaily(),
      ]);
      return {
        ok: true,
        protocol: PROTOCOL,
        settings,
        state: { ...state, running: run.active },
        collected: {
          items: collected.items || [],
          updatedAt: collected.updatedAt,
          history: (collected.history || []).slice(0, 10),
        },
        logs: logs.slice(0, 200),
        logCount: logs.length,
        daily,
        platformMeta: Object.fromEntries(Object.entries(PLATFORMS).map(([k, v]) => [k, {
          name: v.name, supports: v.supports, note: v.note, hosts: v.hosts,
        }])),
      };
    }

    case 'SAVE_SETTINGS':
      return { ok: true, settings: await saveSettings(msg.settings || {}) };

    case 'SAVE_SELECTOR': {
      const { platform, key, selector } = msg;
      if (!platform || !key || !selector) return { ok: false, error: '参数不完整' };
      const cur = await getSettings();
      const old = cur.selectorOverrides?.[platform]?.[key] || [];
      const next = [selector, ...old.filter((s) => s !== selector)];
      await patchSelectors(platform, key, next);
      return { ok: true, selectors: next };
    }

    case 'RESET_SELECTOR': {
      const { platform, key } = msg;
      if (!platform) return { ok: false, error: '缺少平台参数' };
      const cur = await getSettings();
      const ov = cur.selectorOverrides;
      if (key) delete ov[platform]?.[key];
      else ov[platform] = {};
      await saveSettings({ selectorOverrides: ov });
      return { ok: true };
    }

    case 'PREVIEW_PLAN': {
      const settings = await getSettings();
      const plan = buildPlan(msg.input || {}, settings);
      return {
        ok: true,
        plan: {
          links: plan.links.length,
          userPages: plan.userPages.length,
          searches: plan.searches.length,
          detail: {
            links: plan.links.map((l) => ({ platform: PLATFORMS[l.platform].name, url: l.url })),
            userPages: plan.userPages.map((l) => ({ platform: PLATFORMS[l.platform].name, url: l.url })),
            searches: plan.searches.map((s) => ({ platform: PLATFORMS[s.platform].name, keyword: s.keyword })),
          },
        },
      };
    }

    /* ---------------- 只收录（不点赞不评论） ---------------- */
    case 'RUN_COLLECT': {
      if (run.active) return { ok: false, error: '已有任务在运行' };
      const settings = await getSettings();
      const plan = buildPlan(msg.input || {}, settings);
      const total = plan.links.length + plan.userPages.length + plan.searches.length;
      if (total === 0) return { ok: false, error: '没有可执行的收录任务：请检查链接格式与平台开关' };

      run.active = true;
      run.stopRequested = false;
      setState({ running: true, kind: 'collect', stopRequested: false }).catch(() => {});

      (async () => {
        try {
          const res = await runCollect(plan, settings, {
            onProgress: (p) => report(p),
            shouldStop: () => run.stopRequested,
          });
          if (msg.append) await appendCollected(res.items);
          else await setCollected(res.items, { kind: 'replace' });
          report(`收录完成：${res.items.length} 条${res.errors.length ? `，${res.errors.length} 个源失败` : ''}`, { done: true });
          broadcast({ type: 'VH_DONE', kind: 'collect', count: res.items.length });
        } catch (e) {
          report(`失败：${e?.message || e}`, { error: true, done: true });
          broadcast({ type: 'VH_DONE', kind: 'collect', error: e?.message || String(e) });
        } finally {
          run.active = false;
          await setState({ running: false }).catch(() => {});
        }
      })();

      return { ok: true, started: true, total };
    }

    /* ---------------- 固定流程：抓取 → 点赞 → 评论 → 日志 ---------------- */
    case 'RUN_FLOW': {
      if (run.active) return { ok: false, error: '已有任务在运行' };
      let settings = await getSettings();
      // 「强制演练」：本次不真跑，但不改用户已保存的设置
      if (msg.forceDryRun) settings = { ...settings, dryRun: true };
      if (settings.auto.doLike === undefined) settings.auto.doLike = true;
      if (settings.auto.doComment === undefined) settings.auto.doComment = true;
      if (!settings.auto.doLike && !settings.auto.doComment) {
        return { ok: false, error: '点赞和评论都没勾，没事可做。请在设置里至少勾一个。' };
      }
      if (settings.auto.doComment && !settings.llm?.apiKey) {
        return { ok: false, error: '评论需要大模型 API Key：请展开「设置」填一次，或把评论关掉只点赞。' };
      }

      const input = msg.input || {};
      const plan = buildPlan(input, settings);
      const listTasks = plan.searches.length + plan.userPages.length;
      const directLinks = plan.links.length;
      if (directLinks === 0 && listTasks === 0) {
        return { ok: false, error: '没有可处理的输入：请粘贴作品链接/分享文案，或填关键词让它自动去搜' };
      }

      run.active = true;
      run.stopRequested = false;
      setState({ running: true, kind: 'flow', stopRequested: false }).catch(() => {});

      (async () => {
        try {
          let items = plan.links.map((l) => ({ platform: l.platform, url: l.url, workId: '', title: '' }));

          if (items.length === 0 && listTasks > 0) {
            report(`先去 ${listTasks} 个列表页找作品…`);
            const collected = await runCollect(
              { links: [], userPages: plan.userPages, searches: plan.searches },
              settings,
              { onProgress: (p) => report(`收录：${p}`), shouldStop: () => run.stopRequested }
            );
            items = collected.items;
            if (!items.length) throw new Error('自动收录没找到作品：换成直接粘贴作品链接，或到「收录」里先抓一批');
            await setCollected(items, { kind: 'flow-collect' });
          }

          const cap = Math.max(1, settings.auto.maxPerRun || 3);
          if (items.length > cap) {
            report(`找到 ${items.length} 条，按上限只处理前 ${cap} 条`);
            items = items.slice(0, cap);
          }

          const res = await runFixedFlow(items, settings, {
            onProgress: (p) => report(p),
            shouldStop: () => run.stopRequested,
          });
          await setState({ lastSummary: res.summary }).catch(() => {});
          const s = res.summary;
          report(
            `完成：成功 ${s.ok} / 部分成功 ${s.partial} / 失败 ${s.failed} / 演练 ${s.dryRunCount}`
            + (s.aborted ? ` · ⚠ ${s.abortReason}` : ''),
            { done: true }
          );
          broadcast({ type: 'VH_DONE', kind: 'flow', summary: s, logs: res.logs });
        } catch (e) {
          report(`失败：${e?.message || e}`, { error: true, done: true });
          broadcast({ type: 'VH_DONE', kind: 'flow', error: e?.message || String(e) });
        } finally {
          run.active = false;
          await setState({ running: false }).catch(() => {});
        }
      })();

      return { ok: true, started: true, total: Math.max(directLinks, Math.min(listTasks, settings.auto.maxPerRun || 3)) };
    }

    case 'STOP':
      run.stopRequested = true;
      await setState({ stopRequested: true });
      return { ok: true };

    case 'OPEN_PAGE': {
      const url = msg.url;
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: '请输入 http(s) 地址' };
      const settings = await getSettings();
      const handle = await openPage(url, settings);
      await waitForComplete(handle.tabId, settings.pageTimeoutMs).catch(() => {});
      await chrome.tabs.update(handle.tabId, { active: true }).catch(() => {});
      await chrome.windows.update(handle.windowId, { focused: true }).catch(() => {});
      const finalUrl = await currentUrl(handle.tabId);
      return { ok: true, tabId: handle.tabId, url: finalUrl };
    }

    case 'PROBE': {
      let { platform, tabId, url } = msg;
      const settings = await getSettings();
      const key = platform || detectPlatform(url || '');
      if (!key || !PLATFORMS[key]) return { ok: false, error: '无法识别平台' };

      // 没指定 tabId 时，自动找你**已经开着**的该平台标签页。
      // 这样配合 F12 设备模拟（平板/手机视图）时，能直接用它调好的那个页面，
      // 不用再另开一个新标签——设备模拟是按标签页生效的。
      let usedExisting = false;
      if (!tabId) {
        const hosts = PLATFORMS[key].hosts;
        const all = await chrome.tabs.query({});
        const cands = all.filter((t) => {
          if (!t.url) return false;
          try {
            const h = new URL(t.url).host.toLowerCase();
            return hosts.some((x) => h === x || h.endsWith('.' + x));
          } catch { return false; }
        }).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
        if (cands[0]?.id) {
          tabId = cands[0].id;
          url = cands[0].url;
          usedExisting = true;
        }
      }

      const cfg = {
        selectors: resolveSelectors(key, settings.selectorOverrides?.[key]),
        likeState: resolveState(key, 'likeState', settings.selectorOverrides?.[key]),
        collectState: resolveState(key, 'collectState', settings.selectorOverrides?.[key]),
        // 评论区收起的平台（抖音）：自检前先点开，否则评论相关项必然全红
        openCommentsBy: PLATFORMS[key].openCommentsBy || [],
        openCommentsDelayMs: 1800,
      };
      if (tabId) {
        try {
          const r = await inject(tabId, injectProbe, [cfg]);
          return { ok: true, probe: r, tabId, usedExisting };
        } catch (e) {
          return { ok: false, error: `在你打开的页面上自检失败：${e?.message || e}。如果是刚打开还没加载完，稍等两秒再点一次。` };
        }
      }
      let handle = null;
      try {
        handle = await openPage(url, settings);
        await waitForComplete(handle.tabId, settings.pageTimeoutMs);
        await new Promise((r) => setTimeout(r, settings.renderDelayMs));
        const r = await inject(handle.tabId, injectProbe, [cfg]);
        return { ok: true, probe: r, tabId: handle.tabId, usedExisting: false };
      } catch (e) {
        if (handle) await chrome.tabs.remove(handle.tabId).catch(() => {});
        return { ok: false, error: e?.message || String(e) };
      }
    }

    case 'PICK_START': {
      const { tabId } = msg;
      if (!tabId) return { ok: false, error: '请先打开目标页面' };
      return { ok: true, ...(await inject(tabId, injectPickStart, [])) };
    }

    case 'PICK_GET': {
      const { tabId } = msg;
      if (!tabId) return { ok: false, error: '缺少 tabId' };
      try {
        return { ok: true, ...(await inject(tabId, injectPickGet, [])) };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    }

    case 'CLOSE_TAB':
      if (msg.tabId) await chrome.tabs.remove(msg.tabId).catch(() => {});
      return { ok: true };

    case 'BUILD_EXPORT': {
      if (msg.what === 'collected') {
        const col = await getCollected();
        const items = msg.items || col.items || [];
        if (msg.format === 'json') {
          return { ok: true, content: JSON.stringify({ count: items.length, items }, null, 2), fileName: fileName('收录结果', 'json') };
        }
        const head = ['平台', '作品ID', '标题', '作者', '点赞数', '评论数', '链接'];
        const rows = [head, ...items.map((i) => [
          i.platformName || i.platform, i.workId || '', i.title || '', i.author || '',
          i.likeCount ?? '', i.commentCount ?? '', i.url || '',
        ])];
        return { ok: true, content: '\uFEFF' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n'), fileName: fileName('收录结果', 'csv') };
      }

      // 默认导出运行日志
      const logs = msg.logs || (await getLogs());
      if (msg.format === 'json') return { ok: true, content: logsToJson(logs), fileName: fileName('运行日志', 'json') };
      if (msg.format === 'markdown') return { ok: true, content: logsToMarkdown(logs, msg.summary), fileName: fileName('运行日志', 'md') };
      return { ok: true, content: logsToCsv(logs), fileName: fileName('运行日志', 'csv') };
    }

    case 'CLEAR_LOGS':
      await clearLogs();
      return { ok: true };

    case 'CLEAR_COLLECTED':
      await setCollected([], { kind: 'clear' });
      return { ok: true };

    case 'TEST_LLM': {
      const settings = await getSettings();
      try {
        return { ok: true, ...(await testLLM(settings)) };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    }

    case 'LIST_MODELS':
      return listModels(await getSettings());

    default:
      return { ok: false, error: `未知消息类型：${msg?.type}` };
  }
}

// 调试入口（service worker 里才有 self）
if (typeof self !== 'undefined') {
  self.__vhStatus = async () => handle({ type: 'GET_STATUS' });
}
