/**
 * Draws the app icon (a "Θ" on a dark rounded square) into build/icon.png, with no dependencies.
 * electron-builder turns the 512x512 PNG into the Windows .ico itself.
 *   pnpm --filter @theseus/desktop icon
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const N = 512;
const SS = 3; // supersampling per axis, for smooth edges
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../build/icon.png");

const BG = [15, 15, 15];
const FG = [233, 196, 106]; // warm gold
const R_SQ = 0.22 * N; // corner radius

function inRoundedSquare(x, y) {
  const m = 0; // full-bleed
  const cx = Math.min(Math.max(x, m + R_SQ), N - m - R_SQ);
  const cy = Math.min(Math.max(y, m + R_SQ), N - m - R_SQ);
  return (x - cx) ** 2 + (y - cy) ** 2 <= R_SQ ** 2;
}
function inTheta(x, y) {
  const d = Math.hypot(x - N / 2, y - N / 2);
  const ring = d <= 0.33 * N && d >= 0.33 * N - 0.085 * N;
  const bar = Math.abs(y - N / 2) <= 0.0425 * N && Math.abs(x - N / 2) <= 0.2 * N;
  return ring || bar;
}

const raw = Buffer.alloc(N * (N * 4 + 1));
for (let py = 0; py < N; py++) {
  raw[py * (N * 4 + 1)] = 0; // filter: none
  for (let px = 0; px < N; px++) {
    let cover = 0;
    let glyph = 0;
    for (let sy = 0; sy < SS; sy++)
      for (let sx = 0; sx < SS; sx++) {
        const x = px + (sx + 0.5) / SS;
        const y = py + (sy + 0.5) / SS;
        if (inRoundedSquare(x, y)) {
          cover++;
          if (inTheta(x, y)) glyph++;
        }
      }
    const total = SS * SS;
    const t = cover ? glyph / cover : 0;
    const o = py * (N * 4 + 1) + 1 + px * 4;
    for (let c = 0; c < 3; c++) raw[o + c] = Math.round(BG[c] * (1 - t) + FG[c] * t);
    raw[o + 3] = Math.round((255 * cover) / total);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
