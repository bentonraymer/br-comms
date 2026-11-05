// Rasterizes the app icon (same geometry as web/public/icon.svg) to PNGs with no dependencies.
import fs from 'node:fs';
import zlib from 'node:zlib';

const BG = [13, 15, 18];
const RED = [255, 77, 79];

function render(size, { rounded }) {
  const s = size / 512;
  const px = Buffer.alloc(size * size * 4);
  const SS = 4; // supersampling
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const X = (x + (sx + 0.5) / SS) / s, Y = (y + (sy + 0.5) / SS) / s;
          if (rounded && !inRoundRect(X, Y, 512, 112)) continue;
          const d = Math.hypot(X - 256, Y - 256);
          const c = d <= 78 || Math.abs(d - 150) <= 18 ? RED : BG;
          r += c[0]; g += c[1]; b += c[2]; a += 255;
        }
      }
      const n = SS * SS, i = (y * size + x) * 4;
      const cov = a / 255;
      px[i] = cov ? r / cov : 0; px[i + 1] = cov ? g / cov : 0; px[i + 2] = cov ? b / cov : 0; px[i + 3] = a / n;
    }
  }
  return png(size, px);
}

function inRoundRect(x, y, w, rad) {
  const cx = Math.min(Math.max(x, rad), w - rad), cy = Math.min(Math.max(y, rad), w - rad);
  return Math.hypot(x - cx, y - cy) <= rad;
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const out = 'web/public';
fs.writeFileSync(`${out}/icon-192.png`, render(192, { rounded: true }));
fs.writeFileSync(`${out}/icon-512.png`, render(512, { rounded: true }));
fs.writeFileSync(`${out}/icon-maskable-512.png`, render(512, { rounded: false }));
fs.writeFileSync(`${out}/apple-touch-icon.png`, render(180, { rounded: false }));
console.log('icons written');
