/**
 * Does reading a **raw** file's thumbnail by hand give the same bytes as ExifTool?
 *
 * The chooser answers a JPEG in 0.165 ms by following two offsets, and fell back to ExifTool for
 * every raw file — measured on the user's card, **27.3 s of a 156 s run, 483 ARW files at 56 ms
 * each**, plus the 24MB of WebAssembly that only exists to serve them.
 *
 * The claim being tested is that no raw-specific parsing is needed at all: a TIFF/EP raw file *is*
 * the TIFF document that a JPEG carries inside its APP1 segment, so IFD0 links to IFD1 and IFD1
 * holds `0x0201` and `0x0202` in both. If that is true, the existing walk works on both with one
 * branch — and if it is subtly false, the failure is a wrong picture in a chooser, which is quiet
 * enough to deserve a loud check.
 *
 * Verified against **native ExifTool**, not the WASM build, because the point is to check our
 * reading against an independent implementation rather than against the thing we are replacing.
 *
 *   npm run raw-thumb --workspace spike
 */

import { execFile } from 'node:child_process';
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  embeddedThumbnail,
  inspectThumbnail,
  validJpeg,
  THUMBNAIL_LOCATE_BYTES,
} from '@snapmapper/core';

import { nextWindow } from '../../packages/ui/src/thumbnail-window.ts';

import { FIXTURES_DIR, isMain, note, result, section } from './support.mjs';

const run = promisify(execFile);

/** Windows installs per-user and only registers PATH in the registry, so an open shell misses it. */
function exifToolPath() {
  return process.env.EXIFTOOL
    ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'ExifTool', 'exiftool.exe');
}

async function head(file, bytes) {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    const take = Math.min(bytes, size);
    const buffer = new Uint8Array(take);
    await handle.read(buffer, 0, take, 0);
    return buffer;
  } finally {
    await handle.close();
  }
}

/** Exactly the bytes the app would fetch as its second read. */
async function range(file, start, length) {
  const handle = await open(file, 'r');
  try {
    const buffer = new Uint8Array(length);
    await handle.read(buffer, 0, length, start);
    return buffer;
  } finally {
    await handle.close();
  }
}

/** What native ExifTool says the thumbnail is, as raw bytes. */
async function nativeThumbnail(file) {
  const { stdout } = await run(
    exifToolPath(),
    ['-b', '-ThumbnailImage', file],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  return new Uint8Array(stdout);
}

const same = (a, b) => a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);

export async function verifyRawThumbnails() {
  section('Hand-read raw thumbnails against native ExifTool');

  const names = (await readdir(FIXTURES_DIR))
    .filter((name) => /\.(arw|nef|cr2|pef|srw|dng|orf|rw2)$/i.test(name));

  if (names.length === 0) {
    note('No raw fixtures in spike/fixtures/. Copy a real ARW in first.');
    return;
  }

  try {
    await run(exifToolPath(), ['-ver']);
  } catch {
    note('Native ExifTool not found — set EXIFTOOL to its absolute path.');
    return;
  }

  let checks = 0;
  let failures = 0;
  const check = (pass, text) => {
    checks += 1;
    if (!pass) failures += 1;
    result(pass, text);
  };

  for (const name of names) {
    const file = path.join(FIXTURES_DIR, name);
    const expected = await nativeThumbnail(file);
    note(`${name} — ExifTool reports a ${expected.byteLength}-byte thumbnail`);

    /*
     * Stage one: the convergence, which is the part that had to be designed rather than assumed.
     *
     * A raw file's IFD1 is nowhere near its IFD0 — on this camera, byte 122906 against byte 8, with
     * the full-size preview in between — so no sensible first read reaches it. The walk therefore
     * reports how far it *needed* to see, the window grows to that, and the second read succeeds.
     * Without that report the feed would read exactly as far as it did before, for ever.
     */
    let window = THUMBNAIL_LOCATE_BYTES;
    let located;
    let rounds = 0;

    while (rounds < 4) {
      rounds += 1;
      const lookup = inspectThumbnail(await head(file, window));
      if (lookup.range) { located = lookup.range; break; }
      if (lookup.needs === undefined) break;
      note(`  a ${Math.round(window / 1024)}KB head was not enough — it needs ${lookup.needs}`);
      window = nextWindow(window, lookup.needs, THUMBNAIL_LOCATE_BYTES);
    }

    check(
      located !== undefined,
      located
        ? `  located after ${rounds} read(s), at a ${Math.round(window / 1024)}KB window: `
          + `offset ${located.start}, length ${located.length}`
        : '  NOT located at all',
    );
    if (!located) continue;

    check(
      located.length === expected.byteLength,
      `  length matches ExifTool: ${located.length} against ${expected.byteLength}`,
    );

    // Stage two: the exact bytes, fetched the way the app fetches them.
    const exact = validJpeg(await range(file, located.start, located.length));
    check(exact !== undefined, '  those bytes are a whole JPEG, SOI to EOI');
    check(exact !== undefined && same(exact, expected), '  byte-identical to native ExifTool');

    /*
     * And the single-read path, which is what actually ships: one window large enough to hold the
     * whole thing. The window tunes itself to this, so what matters is that it agrees.
     */
    const settled = nextWindow(window, located.start + located.length, THUMBNAIL_LOCATE_BYTES);
    const inOne = embeddedThumbnail(await head(file, settled));
    check(
      inOne !== undefined && same(inOne, expected),
      `  identical again from a single ${Math.round(settled / 1024)}KB read`,
    );

    note(`  the window settles at ${Math.round(settled / 1024)}KB for this camera`);
  }

  note('');
  result(failures === 0, `${checks} checks, ${failures} failures`);
}

if (isMain(import.meta.url)) await verifyRawThumbnails();
