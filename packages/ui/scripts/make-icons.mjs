/**
 * Generate the app icons, so no binary needs hand-editing to change them.
 *
 * `node scripts/make-icons.mjs`
 *
 * Written by hand rather than with an image library because the icon is a handful of shapes, and
 * a dependency that drew it would be larger than the encoder. PNG is a signature, three chunks
 * and a CRC; `zlib` is in Node.
 *
 * Android needs raster icons for an install prompt — an SVG is accepted inconsistently, and "the
 * install button did not appear" is a miserable thing to debug on a phone.
 *
 * The drawing is the same mark as `Wordmark.tsx`: a landscape photo frame with a pin's point
 * dropping out of its base, a horizon and a sun inside it. Filled here rather than stroked,
 * because at 48px on a launcher a 1.7px stroke disappears.
 *
 * Full-bleed and declared `maskable`: Android crops the icon to whatever shape the launcher uses,
 * so the artwork carries no rounded corners of its own and keeps the glyph inside the central
 * safe zone. A rounded square drawn into the file would be cropped again and come out clipped.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT = path.join(import.meta.dirname, '..', 'public', 'icons');

/** The light theme's accent, from styles.css. The launcher shows this behind the glyph. */
const GROUND = [0x1a, 0x63, 0x5b];
const GLYPH = [0xff, 0xff, 0xff];

/* --- shapes, in the same 24-unit space the SVG uses ---------------------------------------- */

const roundedRect = (x, y, left, top, right, bottom, r) => {
  if (x < left || x > right || y < top || y > bottom) return false;

  // Only the four corner boxes need the radius test; everything else is inside.
  const cx = x < left + r ? left + r : x > right - r ? right - r : x;
  const cy = y < top + r ? top + r : y > bottom - r ? bottom - r : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (cx === x && cy === y);
};

const circle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

/** Point-in-triangle by barycentric sign, which needs no winding assumptions. */
const triangle = (x, y, [ax, ay], [bx, by], [cx, cy]) => {
  const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  const u = ((bx - x) * (cy - y) - (cx - x) * (by - y)) / d;
  const v = ((cx - x) * (ay - y) - (ax - x) * (cy - y)) / d;
  return u >= 0 && v >= 0 && u + v <= 1;
};

/**
 * The mark, sampled at a point in 0..24 space.
 *
 * A pin, with the photograph inside its head: a hill and a sun in the negative space of a ring.
 *
 * The first attempt hung the pin's point off the base of a rounded rectangle, which read as a
 * speech bubble rather than a photograph — a rounded box with a tail is a tooltip in every
 * interface anyone has ever used. A pin silhouette cannot be mistaken for anything else, and it
 * echoes the markers already dropped on the map.
 */
function markAt(x, y) {
  const head = circle(x, y, 12, 9.8, 6.7);
  const tail = triangle(x, y, [6.9, 13.4], [17.1, 13.4], [12, 21.8]);
  const inside = circle(x, y, 12, 9.8, 4.9);

  if (!head && !tail) return false;
  // The ring, and the tail below the head's own circle.
  if (!inside) return true;

  // Inside the head: the picture, in glyph colour on the ground showing through.
  const hill = triangle(x, y, [7.6, 13.0], [11.1, 8.2], [14.6, 13.0]);
  const sun = circle(x, y, 14.6, 7.6, 1.25);
  return hill || sun;
}

/**
 * Render with 3x3 supersampling.
 *
 * Without it the diagonals of the point and the hill come out as staircases at 192px, which is
 * exactly the size a launcher shows.
 */
function renderRgba(size) {
  const rows = Buffer.alloc(size * (1 + size * 4));
  const scale = 24 / size;
  const offsets = [1 / 6, 3 / 6, 5 / 6];

  for (let row = 0; row < size; row += 1) {
    const start = row * (1 + size * 4);
    rows[start] = 0; // filter: none

    for (let column = 0; column < size; column += 1) {
      let hits = 0;
      for (const dy of offsets) {
        for (const dx of offsets) {
          if (markAt((column + dx) * scale, (row + dy) * scale)) hits += 1;
        }
      }

      const coverage = hits / 9;
      const at = start + 1 + column * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        rows[at + channel] = Math.round(
          GROUND[channel] + (GLYPH[channel] - GROUND[channel]) * coverage,
        );
      }
      rows[at + 3] = 0xff;
    }
  }

  return rows;
}

/* --- PNG ---------------------------------------------------------------------------------- */

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
  // 10..12 are compression, filter and interlace; 0 is the only valid value for each.

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
