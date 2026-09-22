// 日志导出：CSV / Markdown / JSON。字段就是用户要的那 8 项。
import { toCsv } from './util.js';

/** 用户指定的日志字段（顺序固定） */
export const LOG_COLUMNS = [
  ['title', '视频标题'],
  ['url', '视频链接'],
  ['likeCount', '点赞数'],
  ['commentCount', '评论数'],
  ['favoriteCount', '收藏数'],
  ['commentFocus', '评论区关注点'],
  ['comment', '评论内容'],
  ['result', '执行结果'],
];

function cell(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

/** 给 Excel 用；首列加「时间」便于对账（可去掉） */
export function logsToCsv(logs) {
  const rows = [['时间', ...LOG_COLUMNS.map((c) => c[1])]];
  for (const l of logs) {
    rows.push([
      l.at ? new Date(l.at).toLocaleString('zh-CN') : '',
      ...LOG_COLUMNS.map((c) => cell(l[c[0]])),
    ]);
  }
  return '\uFEFF' + toCsv(rows);
}

export function logsToJson(logs) {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    count: logs.length,
    columns: ['时间', ...LOG_COLUMNS.map((c) => c[1])],
    logs: logs.map((l) => ({
      时间: l.at ? new Date(l.at).toLocaleString('zh-CN') : '',
      平台: l.platformName || '',
      ...Object.fromEntries(LOG_COLUMNS.map((c) => [c[1], l[c[0]] ?? ''])),
    })),
  }, null, 2);
}

const STATUS_LABEL = {
  ok: '成功', partial: '部分成功', failed: '失败', 'dry-run': '演练', skipped: '跳过',
};

export function logsToMarkdown(logs, summary) {
  const L = [];
  L.push('# 运行日志');
  L.push('');
  if (summary) {
    L.push(`- 时间：${new Date(summary.startedAt).toLocaleString('zh-CN')} → ${new Date(summary.finishedAt).toLocaleString('zh-CN')}`);
    L.push(`- 流程：抓取 → ${summary.doLike ? '点赞' : '（未点赞）'} → ${summary.doComment ? '评论' : '（未评论）'}${summary.dryRun ? '（演练模式，未真实执行）' : ''}`);
    L.push(`- 结果：成功 ${summary.ok} / 部分成功 ${summary.partial} / 失败 ${summary.failed} / 共 ${summary.total}`);
    if (summary.aborted) L.push(`- ⚠ 提前中止：${summary.abortReason}`);
    L.push('');
  }
  L.push('| ' + LOG_COLUMNS.map((c) => c[1]).join(' | ') + ' |');
  L.push('| ' + LOG_COLUMNS.map(() => '---').join(' | ') + ' |');
  for (const l of logs) {
    L.push('| ' + LOG_COLUMNS.map((c) => {
      const v = cell(l[c[0]]).replace(/\|/g, '\\|').replace(/\n/g, ' ');
      if (c[0] === 'title' && l.url) return `[${v}](${l.url})`;
      return v;
    }).join(' | ') + ' |');
  }
  return L.join('\n');
}

export function fileName(prefix, ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}

export { STATUS_LABEL };
