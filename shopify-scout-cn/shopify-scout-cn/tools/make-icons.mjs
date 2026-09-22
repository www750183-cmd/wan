/**
 * 生成扩展图标 PNG —— 纯 Node 实现，不依赖任何图形库。
 * 用法：node tools/make-icons.mjs
 *
 * 图形：圆角方块（品牌青绿）+ 白色放大镜。
 * 采用 3×3 超采样抗锯齿，直接写 16/32/48/128 四个尺寸。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'icons');

/* ── PNG 编码 ── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** @param {Uint8Array} rgba 长度 = w*h*4 */
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter type: None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ── 图形 ── */

const BRAND = [15, 157, 143];   // #0f9d8f
const WHITE = [255, 255, 255];

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** 点到圆角矩形的有符号距离（<0 在内部） */
function sdRoundRect(px, py, halfW, halfH, r) {
  const qx = Math.abs(px) - (halfW - r);
  const qy = Math.abs(py) - (halfH - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 点到线段的距离 */
function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
  return Math.hypot(wx - t * vx, wy - t * vy);
}

/** 采样单个点，返回 [r,g,b,a]（a 为 0–1 覆盖率） */
function sample(u, v) {
  const S = 1;                      // 归一化坐标空间
  const c = S / 2;

  // 底板：圆角方块，占满画布（留一点内边距让不同尺寸下都好看）
  const pad = 0.02;
  const dPlate = sdRoundRect(u - c, v - c, c - pad, c - pad, 0.24);
  if (dPlate > 0) return [0, 0, 0, 0];

  let col = BRAND;

  // 放大镜镜圈
  const cx = 0.43, cy = 0.41, R = 0.235, ring = 0.078;
  const dRing = Math.abs(Math.hypot(u - cx, v - cy) - R) - ring / 2;
  // 放大镜手柄
  const dHandle = sdSegment(u, v, 0.585, 0.575, 0.80, 0.79) - 0.056;

  const dGlass = Math.min(dRing, dHandle);
  if (dGlass < 0) {
    // 边缘 1px 硬过渡即可，超采样已经处理了锯齿
    col = WHITE;
  }

  return [col[0], col[1], col[2], 1];
}

function render(size) {
  const SS = 3;                      // 每个轴 3 次超采样
  const rgba = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const px = sample(u, v);
          r += px[0]; g += px[1]; b += px[2]; a += px[3];
        }
      }
      const n = SS * SS;
      const idx = (y * size + x) * 4;
      const alpha = a / n;                 // 覆盖率 0–1
      const denom = alpha > 0 ? alpha : 1; // 未覆盖的像素颜色无意义，避免除零
      rgba[idx] = Math.max(0, Math.min(255, Math.round(r / n / denom)));
      rgba[idx + 1] = Math.max(0, Math.min(255, Math.round(g / n / denom)));
      rgba[idx + 2] = Math.max(0, Math.min(255, Math.round(b / n / denom)));
      rgba[idx + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

/* ── 执行 ── */

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, size, render(size));
  const file = resolve(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, png);
  console.log(`生成 ${file}  (${png.length} 字节)`);
}
