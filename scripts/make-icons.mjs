#!/usr/bin/env node
// Draw the app icons (a page with a folded corner) and write PNGs to public/icons/.
// Pure node: shapes are tested per pixel with 4x4 supersampling, then PNG-encoded with zlib.
//   node scripts/make-icons.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

const BG = [0x6b, 0x4a, 0x2b, 255];     // cover
const PAGE = [0xf6, 0xef, 0xdc, 255];   // paper
const FOLD = [0xd8, 0xc3, 0x93, 255];   // the turned-down corner
const INK = [0xa9, 0x8a, 0x5c, 255];    // text lines

const CUT = 0.14; // size of the folded corner, in icon units

// Page outline with the top-right corner cut off, in unit coordinates.
const pageInside = (x, y) =>
  x >= 0.3 && x <= 0.7 && y >= 0.22 && y <= 0.78 && !(x - (0.7 - CUT) > 0 && y - 0.22 < x - (0.7 - CUT));
const foldInside = (x, y) =>
  x >= 0.7 - CUT && x <= 0.7 && y >= 0.22 && y <= 0.22 + CUT && y - 0.22 >= x - (0.7 - CUT);
const lineInside = (x, y) =>
  [[0.4, 0.64], [0.5, 0.64], [0.6, 0.52]].some(([ly, right]) => Math.abs(y - ly) <= 0.012 && x >= 0.36 && x <= right);

function roundedSquare(x, y, r) {
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

// color of one sample; transparent when `withBg` is false and nothing is drawn there
function sample(x, y, withBg) {
  if (lineInside(x, y) && pageInside(x, y)) return INK;
  if (foldInside(x, y)) return FOLD;
  if (pageInside(x, y)) return PAGE;
  if (withBg && roundedSquare(x, y, 0.2)) return BG;
  return [0, 0, 0, 0];
}

function render(size, withBg, scale = 1) {
  const SS = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // `scale` shrinks the drawing toward the center (maskable safe zone)
          const x = ((i + (sx + 0.5) / SS) / size - 0.5) / scale + 0.5;
          const y = ((j + (sy + 0.5) / SS) / size - 0.5) / scale + 0.5;
          const c = sample(x, y, withBg);
          // premultiplied accumulation
          acc[0] += c[0] * c[3]; acc[1] += c[1] * c[3]; acc[2] += c[2] * c[3]; acc[3] += c[3];
        }
      }
      const n = SS * SS;
      const o = (j * size + i) * 4;
      px[o + 3] = Math.round(acc[3] / n);
      if (acc[3] > 0) {
        px[o] = Math.round(acc[0] / acc[3]);
        px[o + 1] = Math.round(acc[1] / acc[3]);
        px[o + 2] = Math.round(acc[2] / acc[3]);
      }
    }
  }
  return px;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(out, { recursive: true });
const write = (name, size, withBg, scale) => {
  writeFileSync(join(out, name), png(size, render(size, withBg, scale)));
  console.log(`wrote ${name}`);
};
write("icon-512.png", 512, true, 1);
write("icon-192.png", 192, true, 1);
write("icon-180.png", 180, true, 1);
write("mark.png", 128, false, 1.25); // transparent, the heading and toolbar mark
