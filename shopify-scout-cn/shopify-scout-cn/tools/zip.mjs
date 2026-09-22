/**
 * 极简 ZIP 打包器 —— 纯 Node 实现，不依赖任何三方库。
 *
 * 为什么自己写：本项目坚持零依赖（见 README 的技术选型），
 * 而打一个 Chrome 扩展包只需要 store + deflate + 三个固定头结构，
 * 引入一个 zip 库反而多一份供应链风险。
 *
 * 兼容性：使用 UTF-8 文件名标志位（0x0800），中文路径也能正确还原；
 * Windows 资源管理器、macOS 归档工具、Chrome 商城上传均验证可用。
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/* ── CRC32 ── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS 时间格式（ZIP 用的是 1980 纪元） */
function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/**
 * 递归收集目录下的文件。
 * @param {string} dir
 * @param {(absPath:string, relPath:string)=>boolean} [filter] 返回 false 则跳过
 * @returns {{abs:string, rel:string}[]}
 */
export function collectFiles(dir, filter) {
  const out = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const abs = join(d, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      const rel = relative(dir, abs).split(sep).join('/');   // ZIP 一律用正斜杠
      if (filter && !filter(abs, rel)) continue;
      out.push({ abs, rel });
    }
  })(dir);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * 把一组文件打成 ZIP。
 * @param {{abs:string, rel:string}[]} files
 * @param {{level?:number, onProgress?:(rel:string)=>void}} [opts]
 * @returns {Buffer}
 */
export function makeZip(files, opts = {}) {
  const level = opts.level ?? 9;
  const { time, date } = dosDateTime();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const raw = readFileSync(f.abs);
    const crc = crc32(raw);
    // ⚠️ 必须用 deflateRawSync：ZIP 的 method 8 要求**裸 deflate 流**，
    // 而 deflateSync 会加上 zlib 头（0x78 0x9C…），写出来的包任何解压器都打不开。
    // 这个坑是靠「打完包再读回来比对 CRC」的自检抓到的 —— 只看打包成功是看不出来的。
    const comp = deflateRawSync(raw, { level });

    const nameBuf = Buffer.from(f.rel, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // flag: UTF-8 文件名
    local.writeUInt16LE(8, 8);           // method: deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // extra length

    locals.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);        // extra
    central.writeUInt16LE(0, 32);        // comment
    central.writeUInt16LE(0, 34);        // disk start
    central.writeUInt16LE(0, 36);        // internal attrs
    central.writeUInt32LE(0, 38);        // external attrs
    central.writeUInt32LE(offset, 42);   // local header offset
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
    if (opts.onProgress) opts.onProgress(f.rel, raw.length, comp.length);
  }

  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cdBuf, eocd]);
}

/**
 * 读回 ZIP 的文件清单（只解析中央目录，用于自检）。
 * 打包完必须能读回来，否则「打包成功」只是自我感觉良好。
 */
export function readZipEntries(buf) {
  // 从尾部找 EOCD 签名
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是合法的 ZIP：找不到 EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`第 ${i} 个中央目录项签名错误`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, crc, compSize, rawSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 从 ZIP 里取出某个文件的内容（自检用，不做完整解压） */
export function readZipFile(buf, name) {
  const entry = readZipEntries(buf).find((e) => e.name === name);
  if (!entry) return null;
  const p = entry.localOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error('本地文件头签名错误');
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return Buffer.from(data);
  return inflateRawSync(data);
}
