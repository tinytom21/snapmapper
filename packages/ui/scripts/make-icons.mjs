/**
 * Generate the app icons, so no binary needs hand-editing to change them.
 *
 * `node scripts/make-icons.mjs`
 *
 * Written by hand rather than with an image library because the icon is two circles and a
 * triangle, and a dependency that draws it would be larger than the encoder. PNG is a
 * signature, three chunks and a CRC; `zlib` is in Node.
 *
 * Android needs raster icons for an install prompt — an SVG is accepted inconsistently, and
 * "the install button did not appear" is a miserable thing to debug on a phone.
 *
 * Full-bleed and declared `maskable`: Android crops the icon to whatever shape the launcher
 * uses, so the artwork carries no rounded corners of its own and keeps the pin inside the
 * central 60% safe zone. A rounded square drawn into the file would be cropped again and
 * come out visibly clipped.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT = path.join(import.meta.dirname, '..', 'public', 'icons');

/** Matches `--accent` in styles.css. */
const ACCENT = [0x25, 0x63, 0xeb];
const WHITE = [0xff, 0xff, 0xff];

/**
 * A map pin, drawn in coordinates normalised to the icon's size.
 *
 * Resolution-independent so 192 and 512 are the same picture, not one resampled from the
 * other. Everything sits within the central 60%, which is the maskable safe zone.
 */
function pinColourAt(x, y) {
  // Head: a ring, centred a little above the middle.
  const headX = 0.5;
  const headY = 0.42;
  const outer = 0.185;
  const inner = 0.075;
  const dx = x - headX;
  const dy = y - headY;
  const distance = Math.hypot(dx, dy);

  if (distance <= inner) return ACCENT;
  if (distance <= outer) return WHITE;

  // Tail: a triangle from the head down to the point, so head and tail meet without a seam.
  const tipY = 0.78;
  if (y >= headY && y <= tipY) {
    const along = (y - headY) / (tipY - headY);
    const halfWidth = outer * (1 - along);
    if (Math.abs(dx) <= halfWidth) return WHITE;
  }

  return ACCENT;
}

function renderRgba(size) {
  // One filter byte (0, "none") per scanline, then RGBA pixels.
  const rows = Buffer.alloc(size * (1 + size * 4));

  for (let row = 0; row < size; row += 1) {
    const start = row * (1 + size * 4);
    rows[start] = 0;

    for (let column = 0; column < size; column += 1) {
      // Sample at pixel centres, so the shape is not biased half a pixel up and left.
      const [r, g, b] = pinColourAt((column + 0.5) / size, (row + 0.5) / size);
      const at = start + 1 + column * 4;
      rows[at] = r;
      rows[at + 1] = g;
      rows[at + 2] = b;
      rows[at + 3] = 0xff;
    }
  }

  return rows;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = ~0;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // 10..12 are compression, filter and interlace methods; 0 is the only valid value for each.

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(renderRgba(size), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of [192, 512]) {
  const file = path.join(OUT, `icon-${size}.png`);
  writeFileSync(file, png(size));
  console.log(`wrote ${file}`);
}
