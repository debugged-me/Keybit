// Generates icons/icon{16,32,48,128}.png for PeekBit — no dependencies.
// Draws a green rounded square with two overlapping "peek" cards and an eye.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "icons");
mkdirSync(outDir, { recursive: true });

const S = 4; // supersample factor for anti-aliasing

const GREEN = [40, 91, 70, 255]; // #285B46 (Keybit brand)
const MINT = [184, 220, 196, 255]; // #B8DCC4
const WHITE = [255, 255, 255, 255];

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function render(size) {
  const n = size * S;
  const px = new Float32Array(n * n * 4);

  function blend(x, y, [r, g, b, a], cov) {
    if (x < 0 || y < 0 || x >= n || y >= n || cov <= 0) return;
    const i = (y * n + x) * 4;
    const sa = (a / 255) * cov;
    const da = px[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    px[i] = (r * sa + px[i] * da * (1 - sa)) / oa;
    px[i + 1] = (g * sa + px[i + 1] * da * (1 - sa)) / oa;
    px[i + 2] = (b * sa + px[i + 2] * da * (1 - sa)) / oa;
    px[i + 3] = oa * 255;
  }

  function rrect(x0, y0, w, h, rad, col) {
    const x1 = x0 + w;
    const y1 = y0 + h;
    for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
      for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
        const cx = clamp(x + 0.5, x0 + rad, x1 - rad);
        const cy = clamp(y + 0.5, y0 + rad, y1 - rad);
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        blend(x, y, col, clamp(rad - d + 0.5, 0, 1));
      }
    }
  }

  // stroke>0 renders a ring whose thickness is `stroke` as a fraction of rx.
  function ellipse(cx, cy, rx, ry, col, stroke = 0) {
    const avg = (rx + ry) / 2;
    for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) {
      for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        const d = Math.sqrt(dx * dx + dy * dy);
        const outer = clamp((1 - d) * avg + 0.5, 0, 1);
        const inner = stroke > 0 ? clamp((d - (1 - stroke)) * avg + 0.5, 0, 1) : 1;
        blend(x, y, col, Math.min(outer, inner));
      }
    }
  }

  // background
  rrect(0, 0, n, n, 0.22 * n, GREEN);
  // back card peeking out top-right
  rrect(0.4 * n, 0.16 * n, 0.42 * n, 0.34 * n, 0.055 * n, MINT);
  // front card
  rrect(0.18 * n, 0.34 * n, 0.52 * n, 0.44 * n, 0.06 * n, WHITE);
  // eye: ring + pupil
  ellipse(0.44 * n, 0.56 * n, 0.135 * n, 0.088 * n, GREEN, 0.32);
  ellipse(0.44 * n, 0.56 * n, 0.045 * n, 0.045 * n, GREEN);

  // downsample SxS blocks with alpha-weighted averaging
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let dy = 0; dy < S; dy++) {
        for (let dx = 0; dx < S; dx++) {
          const i = ((y * S + dy) * n + x * S + dx) * 4;
          const aa = px[i + 3];
          r += px[i] * aa;
          g += px[i + 1] * aa;
          b += px[i + 2] * aa;
          a += aa;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / (S * S));
    }
  }
  return out;
}

const CRC_TABLE = new Int32Array(256).map((_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = ~0;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const name = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([len, name, data, crc]);
}

function png(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(outDir, `icon${size}.png`), png(size, render(size)));
}
console.log(`Icons written to ${outDir}`);
