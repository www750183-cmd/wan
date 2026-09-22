/**
 * Chrome 应用商店打包 —— 产出可直接上传的 ZIP。
 *
 * 用法：
 *   node tools/package.mjs             # 打包
 *   node tools/package.mjs --check     # 只做上架前自检，不产出文件
 *
 * Chrome 商城的硬性要求（脚本逐条自检）：
 *   1. ZIP 根目录必须直接是 manifest.json，不能套一层文件夹
 *   2. 不能包含远程代码（商城明令禁止，扩展也不能远程拉脚本）
 *   3. 必须带 128×128 图标
 *   4. manifest 字段合法、version 符合规范
 *   5. 不能把测试/构建产物/开发脚本塞进去（不是硬性要求，但会被审核追问）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip, collectFiles, readZipEntries, readZipFile, crc32 } from './zip.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DELIVERY = resolve(ROOT, '..');
const DIST = join(DELIVERY, 'dist');
const CHECK_ONLY = process.argv.includes('--check');

const errors = [];
const warnings = [];
const ok = (m) => console.log('  \u2713 ' + m);
const bad = (m) => { errors.push(m); console.log('  \u2717 ' + m); };
const warn = (m) => { warnings.push(m); console.log('  ! ' + m); };

/** 只打运行时需要的东西 —— 这条清单就是「扩展本体」的定义 */
const INCLUDE_DIRS = ['lib', 'sidepanel', 'icons'];
const INCLUDE_FILES = ['manifest.json', 'background.js'];
/** 明确排除（即便在 include 目录里也不打包） */
const EXCLUDE = [
  /\.map$/i, /\.ts$/i, /(^|\/)\./, /(^|\/)node_modules(\/|$)/,
  /^tools(\/|$)/, /^test(\/|$)/, /^docs(\/|$)/, /\.md$/i, /^package(-lock)?\.json$/
];

console.log('选品侦探 · Chrome 应用商店打包');
console.log(`源目录：${ROOT}\n`);

/* ── 1. manifest 自检 ── */
console.log('[1/5] manifest 校验');
const manifestPath = join(ROOT, 'manifest.json');
if (!existsSync(manifestPath)) { bad('缺少 manifest.json'); process.exit(1); }
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
ok(`名称：${manifest.name}`);
ok(`版本：${manifest.version}`);

if (manifest.manifest_version !== 3) bad('manifest_version 必须是 3');
if (!/^\d+(\.\d+){0,3}$/.test(String(manifest.version))) bad(`version 格式非法：${manifest.version}`);
if (!manifest.description || manifest.description.length > 132) {
  if (!manifest.description) bad('缺少 description');
  else warn(`description ${manifest.description.length} 字符，商城上限 132`);
}
if (!manifest.icons || !manifest.icons['128']) bad('商城要求提供 128×128 图标');
if (manifest.update_url) warn('存在 update_url：自托管更新，商城上传时通常需要移除');
if (manifest.key) warn('manifest 含 key 字段：会锁定扩展 ID，确认是有意为之');

// 权限逐条说明（商城审核会问「为什么要这个权限」）
const PERMISSION_REASONS = {
  activeTab: '用户点击图标时读取当前标签页，替代 <all_urls>，避免申请全网访问',
  scripting: '向当前标签页注入只读的采集脚本（lib/injected.js）',
  storage: '本地保存设置、收藏、扫描历史与店铺变化记录',
  sidePanel: '在浏览器右侧显示操作面板',
  downloads: '导出 CSV / JSON 文件到本地'
};
console.log('  权限逐条说明：');
for (const p of manifest.permissions || []) {
  const why = PERMISSION_REASONS[p];
  if (why) console.log(`    · ${p} —— ${why}`);
  else warn(`权限 ${p} 没有写说明，审核可能追问`);
}
if (manifest.host_permissions && manifest.host_permissions.length) {
  warn(`含 host_permissions：${JSON.stringify(manifest.host_permissions)} —— 商城会重点审核，确认必要`);
} else {
  ok('未申请任何 host_permissions（只用 activeTab）—— 审核友好');
}

/* ── 2. 收集文件 ── */
console.log('\n[2/5] 收集运行时文件');
const all = collectFiles(ROOT, (_abs, rel) => {
  if (EXCLUDE.some((re) => re.test(rel))) return false;
  if (INCLUDE_FILES.includes(rel)) return true;
  return INCLUDE_DIRS.some((d) => rel.startsWith(d + '/'));
});

if (!all.length) { bad('没有收集到任何文件'); process.exit(1); }
let totalRaw = 0;
for (const f of all) {
  const size = statSync(f.abs).size;
  totalRaw += size;
  console.log(`    ${f.rel.padEnd(38)} ${(size / 1024).toFixed(1)} KB`);
}
ok(`共 ${all.length} 个文件，原始 ${(totalRaw / 1024).toFixed(1)} KB`);

const hasManifest = all.some((f) => f.rel === 'manifest.json');
if (!hasManifest) bad('manifest.json 不在包根目录 —— 商城会直接拒绝');
else ok('manifest.json 位于 ZIP 根目录（商城硬性要求）');

for (const banned of ['tools/', 'test/', 'docs/']) {
  if (all.some((f) => f.rel.startsWith(banned))) bad(`包内含 ${banned}，不应上传`);
}
if (!all.some((f) => f.rel.startsWith('icons/'))) bad('缺少 icons/ 目录');
if (!all.some((f) => f.rel === 'background.js')) bad('缺少 background.js');

/* ── 3. 远程代码扫描（商城明令禁止） ── */
console.log('\n[3/5] 远程代码扫描');
let remoteHits = 0;
for (const f of all.filter((x) => /\.(js|html|css|json)$/.test(x.rel))) {
  const src = readFileSync(f.abs, 'utf8');
  if (/\beval\s*\(/.test(src)) { bad(`${f.rel} 含 eval()，商城禁止`); remoteHits++; }
  if (/new\s+Function\s*\(/.test(src)) { bad(`${f.rel} 含 new Function()，商城禁止`); remoteHits++; }
  for (const m of src.matchAll(/<(?:script|link)[^>]+(?:src|href)="(https?:[^"]+)"/g)) {
    bad(`${f.rel} 引用远程资源 ${m[1]}，商城禁止`); remoteHits++;
  }
  if (/import\s*\(\s*['"]https?:/.test(src)) { bad(`${f.rel} 从远程 URL 导入模块`); remoteHits++; }
}
if (!remoteHits) ok('未发现远程代码 / eval / 远程资源引用（符合商城要求）');

/* ── 4. 打包 ── */
console.log('\n[4/5] 生成 ZIP');
if (CHECK_ONLY) {
  console.log('  （--check 模式，跳过产出）');
} else {
  mkdirSync(DIST, { recursive: true });
  const zipName = `shopify-scout-cn-v${manifest.version}.zip`;
  const zipPath = join(DIST, zipName);

  const buf = makeZip(all);
  writeFileSync(zipPath, buf);

  // 自检：打出来的包必须能读回来，且内容与预期一致
  const entries = readZipEntries(buf);
  if (entries.length !== all.length) bad(`ZIP 内条目数 ${entries.length} ≠ 源文件数 ${all.length}`);
  const readBack = readZipFile(buf, 'manifest.json');
  if (!readBack) bad('ZIP 内读不到 manifest.json');
  else {
    const parsed = JSON.parse(readBack.toString('utf8'));
    if (parsed.version !== manifest.version) bad('ZIP 内 manifest 版本与源不一致');
    else ok('回读校验：manifest.json 可解析且版本一致');
  }

  // 内容校验：解压后逐个比对 CRC
  let crcMismatch = 0;
  for (const f of all) {
    const e = entries.find((x) => x.name === f.rel);
    if (!e) { bad(`ZIP 内缺少 ${f.rel}`); continue; }
    if (e.crc !== crc32(readFileSync(f.abs))) { bad(`${f.rel} CRC 不一致`); crcMismatch++; }
  }
  if (!crcMismatch) ok(`回读校验：${all.length} 个文件 CRC 全部一致`);

  const kb = (buf.length / 1024).toFixed(1);
  ok(`产出：${relative(DELIVERY, zipPath).split('\\').join('/')}（${kb} KB，压缩率 ${((1 - buf.length / totalRaw) * 100).toFixed(0)}%）`);

  // 给上传时填表用的清单
  const listing = {
    '扩展名称': manifest.name,
    '版本': manifest.version,
    '简介（≤132 字符）': manifest.description,
    '简介长度': manifest.description.length,
    '包文件名': zipName,
    '包大小（KB）': Number(kb),
    '文件数': all.length,
    '权限': manifest.permissions || [],
    'host_permissions': manifest.host_permissions || [],
    '最低 Chrome 版本': manifest.minimum_chrome_version || '未声明',
    '打包时间': new Date().toISOString()
  };
  writeFileSync(join(DIST, '包信息.json'), JSON.stringify(listing, null, 2));
  ok('产出：dist/包信息.json（上传填表用）');

  const fileList = all.map((f) => `${f.rel}\t${statSync(f.abs).size}`).join('\n');
  writeFileSync(join(DIST, '包内文件清单.txt'), fileList + '\n');
  ok('产出：dist/包内文件清单.txt');
}

/* ── 5. 汇总 ── */
console.log('\n[5/5] 结果');
console.log('─'.repeat(60));
if (errors.length) {
  console.log(`未通过：${errors.length} 个错误，${warnings.length} 个警告`);
  for (const e of errors) console.log('  ✗ ' + e);
  process.exit(1);
}
console.log(`通过：0 个错误，${warnings.length} 个警告`);
for (const w of warnings) console.log('  ! ' + w);
