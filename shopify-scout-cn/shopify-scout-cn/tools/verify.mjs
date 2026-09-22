/**
 * 打包门禁 —— 加载到 Chrome 之前先跑一遍。
 * 用法：node tools/verify.mjs
 *
 * 检查的是「会真的导致扩展装不上或跑不起来」的问题，不是风格问题：
 *   1. manifest 能解析、必需字段齐全、引用的文件都存在
 *   2. 没有远程代码（MV3 硬禁止）、没有 eval / new Function
 *   3. 所有本地 ES 模块 import 都能解析到真实文件
 *   4. 图标是合法 PNG，且尺寸与声明一致、确实画了东西（不是全透明）
 *   5. 源文件是 UTF-8，界面里的中文不会变成乱码
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];
const ok = (msg) => console.log('  \u2713 ' + msg);
const fail = (msg) => { errors.push(msg); console.log('  \u2717 ' + msg); };
const warn = (msg) => { warnings.push(msg); console.log('  ! ' + msg); };

const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');

/* ── 1. manifest ── */
console.log('\n[1/5] manifest.json');

const manifestPath = join(ROOT, 'manifest.json');
if (!existsSync(manifestPath)) { fail('manifest.json 不存在'); process.exit(1); }

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  ok('JSON 解析通过');
} catch (e) {
  fail('manifest.json 解析失败：' + e.message);
  process.exit(1);
}

for (const key of ['manifest_version', 'name', 'version', 'description', 'background', 'side_panel', 'action', 'icons']) {
  if (manifest[key] === undefined) fail(`缺少必需字段：${key}`);
}
if (manifest.manifest_version !== 3) fail('manifest_version 必须是 3');

// version 必须是 1-4 段数字
if (!/^\d+(\.\d+){0,3}$/.test(String(manifest.version))) {
  fail(`version 格式非法：${manifest.version}（必须是 1–4 段数字）`);
}

// default_locale 必须在 _locales 下有对应目录，否则 Chrome 直接拒绝加载
if (manifest.default_locale) {
  const loc = join(ROOT, '_locales', manifest.default_locale, 'messages.json');
  if (!existsSync(loc)) fail(`声明了 default_locale=${manifest.default_locale} 但缺少 ${rel(loc)}`);
  else ok('default_locale 对应的 messages.json 存在');
}
ok(`manifest_version=3，名称「${manifest.name}」，版本 ${manifest.version}`);

/* ── 2. 引用文件存在性 ── */
console.log('\n[2/5] 引用的文件是否都存在');

function checkFile(p, label) {
  if (!p) return;
  const abs = join(ROOT, p);
  if (existsSync(abs) && statSync(abs).isFile()) ok(`${label}: ${p}`);
  else fail(`${label} 指向不存在的文件：${p}`);
}

checkFile(manifest.background?.service_worker, 'background');
checkFile(manifest.side_panel?.default_path, 'side_panel');

for (const [size, p] of Object.entries(manifest.icons || {})) checkFile(p, `icons[${size}]`);
for (const [size, p] of Object.entries(manifest.action?.default_icon || {})) checkFile(p, `action.default_icon[${size}]`);

// side panel 页面引用的资源
const panelHtml = join(ROOT, manifest.side_panel.default_path);
if (existsSync(panelHtml)) {
  const html = readFileSync(panelHtml, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
    .filter((u) => !/^(https?:|data:|#)/.test(u));
  if (!refs.length) warn('sidepanel HTML 没有引用任何本地资源');
  for (const r of refs) checkFile(join(dirname(manifest.side_panel.default_path), r), 'panel 资源');
}

/* ── 3. 无远程代码 / 无 eval ── */
console.log('\n[3/5] MV3 硬约束：无远程代码、无 eval');

const csp = manifest.content_security_policy?.extension_pages || '';
if (/unsafe-eval|unsafe-inline|https?:/i.test(csp)) fail(`CSP 含被禁止的来源：${csp}`);
else ok(`CSP 干净：${csp || '(未声明，用 MV3 默认值)'}`);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|html|css)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const shipped = walk(ROOT).filter((p) => !rel(p).startsWith('tools/') && !rel(p).startsWith('test/'));

for (const f of shipped) {
  const src = readFileSync(f, 'utf8');
  if (/\beval\s*\(/.test(src)) fail(`${rel(f)} 含 eval( —— MV3 下会被 CSP 拦截`);
  if (/new\s+Function\s*\(/.test(src)) fail(`${rel(f)} 含 new Function( —— MV3 下会被 CSP 拦截`);
  if (/import\s*\(?\s*['"]https?:/.test(src)) fail(`${rel(f)} 从远程 URL 导入模块`);
  for (const m of src.matchAll(/<(?:script|link)[^>]+(?:src|href)="(https?:[^"]+)"/g)) {
    fail(`${rel(f)} 引用了远程资源：${m[1]}`);
  }
}
ok(`已扫描 ${shipped.length} 个运行时文件，未发现远程代码或 eval`);

// Service Worker 侧的 API 白名单检查。
// 实测踩过的坑：MV3 SW 里没有 URL.createObjectURL，导出功能在真浏览器中直接报
// 「URL.createObjectURL is not a function」，而单测与 Node 干跑都发现不了。
// 这里把「不能出现在 SW 侧代码里」的 API 固化成静态门禁。
/**
 * 提取「纯代码」视图：去掉注释，并把字符串/模板串的内容清空。
 *
 * 两个都必须做，否则会自伤：
 *   - 注释：本项目大量注释在解释「为什么不能用 URL.createObjectURL」；
 *   - 字符串：detect.js 里有 `window.${g}` 这种**用来展示证据文本**的模板串，
 *     它并不是真的在访问 window。
 * 清空字符串后剩下的才是真正会被执行的标识符。
 */
function codeOnly(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      out += '""';   // 占位，内容丢弃
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const SW_FILES = ['background.js', 'lib/signatures.js', 'lib/detect.js', 'lib/estimate.js',
  'lib/export.js', 'lib/injected.js', 'lib/timeline.js'];
const SW_FORBIDDEN = [
  ['URL.createObjectURL', 'MV3 Service Worker 已移除该 API，Blob 下载必须放页面上下文（见 panel.js 的 doExport）'],
  ['URL.revokeObjectURL', '同上'],
  ['document.', 'Service Worker 里没有 document'],
  ['window.', 'Service Worker 里没有 window（注入函数体内的引用除外，见下）'],
  ['localStorage', 'Service Worker 里没有 localStorage，请用 chrome.storage']
];
for (const f of SW_FILES) {
  const p = join(ROOT, f);
  if (!existsSync(p)) { fail(`SW 侧文件缺失：${f}`); continue; }
  const code = codeOnly(readFileSync(p, 'utf8'));
  for (const [needle, why] of SW_FORBIDDEN) {
    // injected.js 的函数会被注入到页面里跑，那里有 window/document，是合法的
    if (f === 'lib/injected.js' && (needle === 'window.' || needle === 'document.')) continue;
    if (code.includes(needle)) fail(`${f} 使用了 ${needle} —— ${why}`);
  }
}
ok(`${SW_FILES.length} 个 Service Worker 侧文件通过 API 白名单检查（已剥离注释）`);

/* ── 4. ES 模块 import 解析 ── */
console.log('\n[4/5] 本地 ES 模块 import 解析');

let importCount = 0;
for (const f of shipped.filter((p) => /\.(js|mjs)$/.test(p))) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/^\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/gm)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    importCount++;
    const target = resolve(dirname(f), spec);
    if (!existsSync(target)) fail(`${rel(f)} 导入了不存在的模块：${spec}`);
  }
}
ok(`解析了 ${importCount} 处本地 import，全部命中真实文件`);

/* ── 5. 图标 PNG 结构 + 实际内容 ── */
console.log('\n[5/5] 图标 PNG 结构');

function readPng(file) {
  const buf = readFileSync(file);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return { valid: false, reason: 'PNG 签名错误' };
  // 第一个 chunk 必须是 IHDR
  const type = buf.toString('ascii', 12, 16);
  if (type !== 'IHDR') return { valid: false, reason: '首个 chunk 不是 IHDR，实际是 ' + type };
  return {
    valid: true,
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
    bytes: buf.length
  };
}

for (const [size, p] of Object.entries(manifest.icons || {})) {
  const abs = join(ROOT, p);
  if (!existsSync(abs)) continue;
  const info = readPng(abs);
  if (!info.valid) { fail(`${p}: ${info.reason}`); continue; }

  const want = Number(size);
  if (info.width !== want || info.height !== want) {
    fail(`${p}: 声明 ${want}×${want}，实际 ${info.width}×${info.height}`);
  } else if (info.colorType !== 6) {
    fail(`${p}: 颜色类型应为 6 (RGBA)，实际 ${info.colorType} —— 图标需要透明背景`);
  } else if (info.bitDepth !== 8) {
    fail(`${p}: 位深应为 8，实际 ${info.bitDepth}`);
  } else if (info.bytes < 100) {
    fail(`${p}: 文件过小 (${info.bytes} 字节)，疑似空白图`);
  } else {
    ok(`${p}: ${info.width}×${info.height} RGBA8，${info.bytes} 字节`);
  }
}

// 解码 128 图标，确认真的画了图案（而不是一张全透明或纯色的图）
try {
  const { inflateSync } = await import('node:zlib');
  const buf = readFileSync(join(ROOT, 'icons', 'icon-128.png'));
  let off = 8, idat = [];
  let w = 0, h = 0;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4 + 1;
  let opaque = 0, transparent = 0;
  const colors = new Set();
  for (let y = 0; y < h; y++) {
    const rowStart = y * stride + 1;
    for (let x = 0; x < w; x++) {
      const i = rowStart + x * 4;
      const a = raw[i + 3];
      if (a > 200) { opaque++; colors.add(`${raw[i]},${raw[i + 1]},${raw[i + 2]}`); }
      else if (a < 40) transparent++;
    }
  }
  const total = w * h;
  if (opaque < total * 0.2) fail(`icon-128.png 几乎全透明（不透明像素 ${opaque}/${total}）`);
  else if (transparent < total * 0.02) fail('icon-128.png 没有透明背景，圆角外应留空');
  else if (colors.size < 2) fail('icon-128.png 只有一种颜色，放大镜没画出来');
  else ok(`icon-128.png 内容检查通过：不透明 ${opaque} px、透明 ${transparent} px、${colors.size} 种颜色`);
} catch (e) {
  warn('无法解码图标验证内容：' + e.message);
}

// 界面中文编码自检
console.log('\n[附加] 中文编码自检');
for (const f of shipped.filter((p) => /\.(html|js|css)$/.test(p))) {
  const raw = readFileSync(f);
  const text = raw.toString('utf8');
  if (text.includes('\uFFFD')) fail(`${rel(f)} 含替换字符 U+FFFD，编码已损坏`);
}
ok('所有界面文件均为合法 UTF-8，无乱码');

// 语法检查 + BOM 检测。
//
// 这两条是被真实事故逼出来的：曾用 PowerShell 的 `Get-Content -Raw` /
// `Set-Content -Encoding utf8` 备份还原 background.js，中文经 ANSI 码页往返后
// 全变成乱码，一个字符串字面量被截断 → 整个 Service Worker 注册失败 →
// 扩展在浏览器里根本不加载。当时门禁全绿，因为乱码本身是合法 UTF-8。
// 语法检查能立刻抓到这一类损坏；BOM 检测则直接指向"被 PowerShell 覆写过"。
console.log('\n[新增] JS 语法检查与编码完整性');

const jsFiles = walk(ROOT).filter((p) => /\.(js|mjs)$/.test(p));
let syntaxOk = 0;
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    syntaxOk++;
  } catch (e) {
    const msg = String(e.stderr || e.message).split('\n').filter((l) => l.trim()).slice(0, 3).join(' ');
    fail(`${rel(f)} 语法检查失败：${msg}`);
  }
}
ok(`${syntaxOk}/${jsFiles.length} 个 JS 文件语法检查通过（含 tools/ 与 test/，不只是扩展本体）`);

for (const f of shipped) {
  const buf = readFileSync(f);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    fail(`${rel(f)} 带 UTF-8 BOM —— 通常是 PowerShell Set-Content 覆写留下的，随后必然出现中文乱码`);
  }
}
ok('无文件带 UTF-8 BOM');

// 文档完整性：ASCII 逗号紧邻中文，几乎一定是批量替换事故的残留。
//
// 真实事故：用一行 `['导出']`（数组只有 1 个元素）去做字符串替换，解构出 b=undefined，
// 而 `Array.join(undefined)` 等价于 `join()`、分隔符默认是逗号 ——
// 于是 4 个文档里所有「导出」两个字被悄悄换成了逗号，
// 拼出「五种,在生产环境 100% 失败」这种句子。语法检查抓不到，只能靠这条。
console.log('\n[新增] 文档完整性（批量替换事故检测）');

const mdFiles = [];
function walkMd(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkMd(p);
    else if (e.name.endsWith('.md')) mdFiles.push(p);
  }
}
walkMd(ROOT);

// 交付文档在上一级目录（docs/ 与顶层 README），也要一起扫 ——
// 事故正是发生在那几个文件里，只扫扩展目录等于没扫。
const DELIVERY_ROOT = resolve(ROOT, '..');
walkMd(join(DELIVERY_ROOT, 'docs'));
if (existsSync(join(DELIVERY_ROOT, 'README.md'))) mdFiles.push(join(DELIVERY_ROOT, 'README.md'));

const uniqueMd = [...new Set(mdFiles)];
let commaHits = 0;
for (const f of uniqueMd) {
  const lines = readFileSync(f, 'utf8').split(/\r?\n/);
  let inFence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) { inFence = !inFence; return; }
    if (inFence) return;                                   // 代码块里的逗号是正常的
    if (/^\s*(\/\/|import |const |function |\{ id:|\|? ?[a-zA-Z_$]+:)/.test(l)) return; // 代码样例行
    for (const m of l.matchAll(/,/g)) {
      const before = l.slice(Math.max(0, m.index - 3), m.index);
      const after = l.slice(m.index + 1, m.index + 4);
      if (/[\u4e00-\u9fa5]/.test(before) || /[\u4e00-\u9fa5]/.test(after)) {
        commaHits++;
        fail(`${rel(f)}:${i + 1} ASCII 逗号紧邻中文，疑似批量替换事故：…${l.slice(Math.max(0, m.index - 18), m.index + 18)}…`);
      }
    }
  });
}
if (!commaHits) ok(`${uniqueMd.length} 个 Markdown 文件未发现逗号替换残留`);

/* ── 汇总 ── */
console.log('\n' + '─'.repeat(56));
if (errors.length) {
  console.log(`门禁未通过：${errors.length} 个错误，${warnings.length} 个警告`);
  for (const e of errors) console.log('  ✗ ' + e);
  process.exit(1);
}
console.log(`门禁通过：0 个错误，${warnings.length} 个警告`);
for (const w of warnings) console.log('  ! ' + w);
