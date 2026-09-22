// 标签页生命周期：开页 → 等加载 → 注入执行 → 关页。
// 两种模式：background（不激活，安静）与 window（小窗激活，渲染更可靠）。

import { sleep } from './util.js';

export async function waitForComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpd);
      chrome.tabs.onRemoved.removeListener(onRm);
      reject(new Error(`页面加载超时（${timeoutMs}ms）`));
    }, timeoutMs);

    const onUpd = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpd);
        chrome.tabs.onRemoved.removeListener(onRm);
        resolve();
      }
    };
    const onRm = (id) => {
      if (id !== tabId) return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpd);
      chrome.tabs.onRemoved.removeListener(onRm);
      reject(new Error('页面在加载完成前被关闭'));
    };
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.onRemoved.addListener(onRm);
    // 已经加载完的情况
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpd);
        chrome.tabs.onRemoved.removeListener(onRm);
        resolve();
      }
    }).catch(() => { });
  });
}

export async function openPage(url, settings) {
  const mode = settings?.tabMode || 'background';

  // 在你当前的标签页里跑：这样 DevTools 的设备模拟（平板/手机视图）才会生效
  if (mode === 'current') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('找不到当前标签页（请先切到要处理的那个页面）');
    const target = tab.url || '';
    // 已经在目标页面上就不动它；否则导航过去
    if (!target.startsWith(url.split('?')[0].slice(0, 40))) {
      await chrome.tabs.update(tab.id, { url });
    }
    return { tabId: tab.id, windowId: tab.windowId, isWindow: false, reuse: true };
  }

  if (mode === 'window') {
    const win = await chrome.windows.create({
      url,
      focused: true,
      type: 'popup',
      width: 480,
      height: 380,
      left: 20,
      top: 20,
    });
    const tab = win.tabs?.[0];
    if (!tab) throw new Error('无法创建渲染窗口');
    return { tabId: tab.id, windowId: win.id, isWindow: true };
  }
  const tab = await chrome.tabs.create({ url, active: false });
  return { tabId: tab.id, windowId: tab.windowId, isWindow: false };
}

export async function closePage(handle) {
  if (!handle) return;
  if (handle.reuse) return; // 复用了用户的标签页，不能替用户关掉
  try {
    if (handle.isWindow && handle.windowId) await chrome.windows.remove(handle.windowId);
    else if (handle.tabId) await chrome.tabs.remove(handle.tabId);
  } catch { /* 已经关了 */ }
}

/** 注入并执行一个自包含函数 */
export async function inject(tabId, func, args = []) {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
    world: 'ISOLATED',
  });
  const r = res?.[0]?.result;
  if (r === undefined || r === null) throw new Error('页面执行未返回结果');
  return r;
}

/** 读标签页当前 URL（用于展开短链后的最终地址） */
export async function currentUrl(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return t?.url || '';
  } catch {
    return '';
  }
}

/**
 * 打开页面 → 等加载 → 等渲染 → 执行 → 关页（保证关闭）
 * @param fn (ctx) => Promise<any>，ctx = {tabId, url}
 */
export async function withPage(url, settings, fn) {
  const handle = await openPage(url, settings);
  try {
    await waitForComplete(handle.tabId, settings?.pageTimeoutMs || 45000);
    await sleep(settings?.renderDelayMs ?? 2500);
    const finalUrl = await currentUrl(handle.tabId);
    return await fn({ tabId: handle.tabId, url: finalUrl || url });
  } finally {
    await closePage(handle);
  }
}

/** 只开页拿最终 URL（短链展开用），不执行脚本 */
export async function resolveShortUrl(url, settings) {
  const handle = await openPage(url, settings);
  try {
    await waitForComplete(handle.tabId, settings?.pageTimeoutMs || 45000);
    await sleep(800);
    return await currentUrl(handle.tabId);
  } catch {
    return url;
  } finally {
    await closePage(handle);
  }
}
