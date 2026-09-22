const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = (t) => (t ? new Date(t).toLocaleString('zh-CN') : '');

let currentTab = null;

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  $('curUrl').textContent = tab?.url ? tab.url.slice(0, 90) : '读不到当前标签页';

  const res = await send({ type: 'GET_STATUS' });
  if (!res?.ok) { $('banner').textContent = `读取失败：${res?.error}`; return; }
  render(res);
}

function render(res) {
  const running = !!res.state.running;
  $('banner').textContent = running ? `运行中：${res.state.progress || '处理中'}` : '空闲';
  $('banner').className = `statusbar ${running ? 'busy' : ''}`;
  $('btnStop').disabled = !running;

  const d = res.daily || { count: 0 };
  $('stat').innerHTML = [
    `收录 ${res.collected?.items?.length || 0} 条`,
    `互动记录 ${res.interactionCount || 0} 条`,
    `今日 ${d.count || 0}/${res.settings.dailyLimit}`,
    `模式：${res.settings.dryRun ? '演练' : '真实执行'}`,
  ].map((t) => `<span>${esc(t)}</span>`).join('');

  const last = (res.interactions || [])[0];
  $('last').innerHTML = last
    ? `<b>${esc(last.platformName || '')} · ${esc(last.action || '')}</b> ${esc(last.status || '')}<br>
       <span class="muted">${fmtTime(last.at)}　${esc((last.message || '').slice(0, 50))}</span>`
    : '<span class="muted">还没有执行记录。</span>';
}

$('btnConsole').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('btnStop').addEventListener('click', async () => {
  await send({ type: 'STOP' });
  $('banner').textContent = '已请求停止…';
});

$('btnQuickOpen').addEventListener('click', async () => {
  if (!currentTab?.id) return;
  const res = await send({ type: 'PROBE', tabId: currentTab.id, url: currentTab.url });
  if (!res?.ok) { $('banner').textContent = `自检失败：${res?.error}`; $('banner').className = 'statusbar err'; return; }
  const hit = (res.probe.fields || []).filter((f) => f.hit).length;
  const total = (res.probe.fields || []).length;
  $('banner').textContent = `自检：${hit}/${total} 组选择器命中${res.probe.loggedOut ? '（检测到未登录）' : ''}`;
  $('banner').className = `statusbar ${hit > total / 2 ? 'ok' : 'err'}`;
});

init();
