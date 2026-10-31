// 生成托盘图标 tray.png（32x32，机器人黑脸 + 白色菱形眼）
// 手写 PNG 编码：RGBA -> filter 0 扫描线 -> zlib deflate -> IHDR/IDAT/IEND
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 32, H = 32;
const px = Buffer.alloc(W * H * 4, 0); // RGBA，全透明起点

function setPx(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  // 简单的 source-over 混合，保证抗锯齿边缘平滑
  const sa = a / 255;
  const da = px[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / oa);
  px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa);
  px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa);
  px[i + 3] = Math.round(oa * 255);
}

function fillRoundRect(x0, y0, x1, y1, rad, c) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let dx = 0, dy = 0;
      if (x < x0 + rad) dx = x0 + rad - x;
      if (x > x1 - rad) dx = x - (x1 - rad);
      if (y < y0 + rad) dy = y0 + rad - y;
      if (y > y1 - rad) dy = y - (y1 - rad);
      const d = Math.hypot(dx, dy);
      if (d <= rad - 0.5) setPx(x, y, c[0], c[1], c[2], 255);
      else if (d <= rad + 0.5) {
        const t = 1 - (d - (rad - 0.5));
        setPx(x, y, c[0], c[1], c[2], Math.round(255 * Math.max(0, Math.min(1, t))));
      }
    }
  }
}

function fillDiamond(cx, cy, r, c) {
  for (let y = Math.floor(cy - r) - 1; y <= Math.ceil(cy + r) + 1; y++) {
    for (let x = Math.floor(cx - r) - 1; x <= Math.ceil(cx + r) + 1; x++) {
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      if (d <= r - 0.5) setPx(x, y, c[0], c[1], c[2], 255);
      else if (d <= r + 0.5) {
        const t = 1 - (d - (r - 0.5));
        setPx(x, y, c[0], c[1], c[2], Math.round(255 * Math.max(0, Math.min(1, t))));
      }
    }
  }
}

// 黑色圆角方块 = 屏幕脸
const DARK = [24, 29, 34];
fillRoundRect(2, 2, 29, 29, 7, DARK);
// 顶部小高光
fillRoundRect(5, 4, 27, 6, 3, [40, 47, 54]);
// 两颗白色菱形眼
const WHITE = [245, 250, 246];
fillDiamond(11.5, 16.5, 4.2, WHITE);
fillDiamond(20.5, 16.5, 4.2, WHITE);

/* ---------- PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
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
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // color type RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0; // filter none
  px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const out = path.join(__dirname, '..', 'tray.png');
fs.writeFileSync(out, png);
console.log('written', out, png.length, 'bytes');
