// 生成扩展图标（无第三方依赖的极简 PNG 编码器）
// 用法：node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'icons');
mkdirSync(outDir, { recursive: true });

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

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 画一个圆角方块 + 三条横线（代表「简报」） */
function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const R = size * 0.22;
  const bg = [37, 99, 235];    // #2563eb
  const fg = [255, 255, 255];

  const inRounded = (x, y) => {
    const r = R, w = size - 1;
    const cx = Math.min(Math.max(x, r), w - r);
    const cy = Math.min(Math.max(y, r), w - r);
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= r * r + 0.5;
  };

  const lineTop = size * 0.30;
  const lineGap = size * 0.16;
  const thickness = Math.max(1, size * 0.085);
  const lineLeft = size * 0.26;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let color = null;

      if (inRounded(x + 0.5, y + 0.5)) color = bg;

      for (let k = 0; k < 3; k++) {
        const ly = lineTop + k * lineGap;
        const right = k === 2 ? size * 0.62 : size * 0.74;
        if (color && y >= ly && y <= ly + thickness && x >= lineLeft && x <= right) color = fg;
      }

      if (!color) { buf[i + 3] = 0; continue; }
      buf[i] = color[0]; buf[i + 1] = color[1]; buf[i + 2] = color[2]; buf[i + 3] = 255;
    }
  }
  return buf;
}

for (const size of [16, 48, 128]) {
  const png = encodePng(size, size, drawIcon(size));
  const file = resolve(outDir, `icon${size}.png`);
  writeFileSync(file, png);
  console.log(`已生成 ${file}（${png.length} 字节）`);
}
