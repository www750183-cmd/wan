// 打包前静态自检：manifest 字段、引用资源是否齐全、是否有残留内联脚本。
// 用法：node tools/verify.mjs
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let problems = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `　${detail}` : ''}`);
  if (!ok) problems++;
}

console.log('\n[manifest]');
const manifestPath = join(root, 'manifest.json');
let m = null;
try {
  m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  check('manifest.json 是合法 JSON', true, `v${m.version} · mv${m.manifest_version}`);
} catch (e) {
  check('manifest.json 是合法 JSON', false, e.message);
}

if (m) {
  check('名称/描述为非空字符串', typeof m.name === 'string' && m.name.length > 0 && !!m.description);
  check('service_worker 文件存在', existsSync(join(root, m.background?.service_worker || '')));
  check('SW 使用 module 类型', m.background?.type === 'module');
  check('popup 文件存在', existsSync(join(root, m.action?.default_popup || '')));
  check('options 文件存在', existsSync(join(root, m.options_ui?.page || '')));
  check('图标齐全', ['16', '48', '128'].every((s) => existsSync(join(root, m.icons?.[s] || ''))));
  check('无危险权限（无 eval 依赖的 CSP 放宽）', !m.content_security_policy);
  check('未申请 cookies 权限', !(m.permissions || []).includes('cookies'));
  check('未申请 debugger 权限', !(m.permissions || []).includes('debugger'));
  const perms = m.permissions || [];
  check('权限数量克制（≤ 8）', perms.length <= 8, `当前 ${perms.length}：${perms.join(', ')}`);
}

console.log('\n[html 资源引用]');
// 从 manifest 反推要检查的 HTML，避免硬编码文件名
const htmlFiles = Array.from(new Set([
  m?.options_ui?.page,
  m?.action?.default_popup,
].filter(Boolean)));
for (const htmlFile of htmlFiles) {
  const abs = join(root, htmlFile);
  if (!existsSync(abs)) { check(`${htmlFile} 存在`, false); continue; }
  const html = readFileSync(abs, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((x) => x[1]).filter((u) => !/^https?:|^#/.test(u));
  for (const r of refs) {
    check(`${htmlFile} → ${r}`, existsSync(join(dirname(abs), r)));
  }
  const inline = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(html);
  check(`${htmlFile} 无内联脚本（MV3 CSP 要求）`, !inline);
  const inlineHandler = /\son[a-z]+\s*=/i.test(html);
  check(`${htmlFile} 无内联事件处理器`, !inlineHandler);
}

console.log('\n[源码卫生]');
const jsFiles = [];
function walk(dir) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|mjs)$/.test(e.name)) jsFiles.push(p);
  }
}
walk(join(root, 'src'));
walk(join(root, 'ui'));

let hasEval = 0;
let hasRemote = 0;
for (const f of jsFiles) {
  const code = readFileSync(f, 'utf8');
  if (/\beval\s*\(|new Function\s*\(/.test(code)) { hasEval++; console.log(`    ⚠ 使用了 eval/new Function：${f}`); }
  if (/import\s*\(\s*['"]https?:/.test(code) || /[\w.]+\.src\s*=\s*['"]https?:/.test(code)) { hasRemote++; console.log(`    ⚠ 疑似远程脚本：${f}`); }
}
check('全部源码不使用 eval / new Function', hasEval === 0);
check('全部源码不加载远程脚本', hasRemote === 0);
check(`源码文件数合理（${jsFiles.length} 个 js/mjs）`, jsFiles.length > 0);

console.log(`\n${problems === 0 ? '✅ 静态自检全部通过' : `❌ 有 ${problems} 项未通过`}\n`);
process.exit(problems === 0 ? 0 : 1);
