// 通用工具。chrome.* 全部放在函数体内，便于 Node 单测。
export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 带随机抖动的等待，用于模拟人类节奏，降低被风控的概率 */
export function jitterSleep(baseMs, spreadMs = 0) {
  const ms = Math.max(0, baseMs + (spreadMs ? Math.round((Math.random() * 2 - 1) * spreadMs) : 0));
  return sleep(ms);
}

export function nowIso() { return new Date().toISOString(); }

export function dateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function truncate(s, max) {
  if (typeof s !== 'string') return '';
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/** "1.2万" / "3.4w" / "1,234" / "12.5k" → 整数 */
export function parseCount(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input) : null;
  let s = String(input).trim().replace(/\s|,/g, '');
  if (!s) return null;
  const m = /^([0-9]*\.?[0-9]+)\s*(万|亿|w|W|k|K|m|M)?/.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || '').toLowerCase();
  const factor = { '万': 1e4, 'w': 1e4, '亿': 1e8, 'k': 1e3, 'm': 1e6 }[unit] ?? 1;
  return Math.round(n * factor);
}

export function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const k = keyFn(item);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

export function safeHost(url) {
  try { return new URL(url).host; } catch { return ''; }
}

/** 并发池 */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(new Array(size).fill(0).map(async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (e) {
        results[i] = { ok: false, error: e?.message || String(e) };
      }
    }
  }));
  return results;
}

export function uid3(seed = '') {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

export function clamp(n, lo, hi, dflt) {
  const v = Number(n);
  if (!Number.isFinite(v)) return dflt;
  return Math.max(lo, Math.min(hi, v));
}

/** 归一化 baseURL，得到真正要 POST 的地址 */
export function joinEndpoint(baseURL, suffix) {
  const base = String(baseURL || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (base.endsWith(suffix)) return base;
  if (/\/(v1|v1beta|openai|api)$/i.test(base)) return base + suffix;
  return base + suffix;
}

/** 从任意文本里抠出 JSON 对象（兼容 ```json 包裹、前后废话、尾随逗号） */
export function extractJsonBlock(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const body = s.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    try {
      return JSON.parse(body.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}
