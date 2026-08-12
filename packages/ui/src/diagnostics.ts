/**
 * A report that can be pasted into a message, because the slow machine is never this one.
 *
 * Every performance question in this project so far has been answered on a desktop with the files
 * on an SSD, and then been wrong on a phone reading a card through a reader. Two of them were the
 * *same mistake* — awaiting a file access inside a loop — and both looked perfect here: `listFolder`
 * serialised 322 round trips, and `readThumbnails` did it again sixteen at a time, which is why
 * replacing a 700 ms ExifTool call with a 0.165 ms byte read made no difference anyone could feel.
 *
 * Guessing which stage dominates has now been wrong twice, so the timings are collected always
 * rather than behind a flag, split by stage, and made copyable. `readMs` is wall clock for
 * overlapped reads rather than their sum, which is the number that tells you whether the overlap
 * is working.
 */

import type { BatchTiming } from './read-thumbnails.ts';

export interface Totals {
  readonly batches: number;
  readonly files: number;
  readonly readMs: number;
  readonly parseMs: number;
  readonly exifMs: number;
  readonly fast: number;
  readonly slow: number;
  readonly bytesRead: number;
  readonly reads: number;
  /** The head windows the feed settled on, and the deepest each kind of file justified. */
  readonly windowPhoto: number;
  readonly windowRaw: number;
  readonly deepestPhoto: number;
  readonly deepestRaw: number;
}

export const NOTHING: Totals = {
  batches: 0, files: 0, readMs: 0, parseMs: 0, exifMs: 0, fast: 0, slow: 0,
  bytesRead: 0, reads: 0, windowPhoto: 0, windowRaw: 0, deepestPhoto: 0, deepestRaw: 0,
};

export function addBatch(totals: Totals, batch: BatchTiming): Totals {
  return {
    batches: totals.batches + 1,
    files: totals.files + batch.files,
    readMs: totals.readMs + batch.readMs,
    parseMs: totals.parseMs + batch.parseMs,
    exifMs: totals.exifMs + batch.exifMs,
    fast: totals.fast + batch.fast,
    slow: totals.slow + batch.slow,
    bytesRead: totals.bytesRead + batch.bytesRead,
    reads: totals.reads + batch.reads,
    // Maxima rather than sums: what is wanted is the size the feed settled on, not a total of
    // every window it tried on the way there.
    windowPhoto: Math.max(totals.windowPhoto, batch.windows.photo),
    windowRaw: Math.max(totals.windowRaw, batch.windows.raw),
    deepestPhoto: Math.max(totals.deepestPhoto, batch.deepest.photo),
    deepestRaw: Math.max(totals.deepestRaw, batch.deepest.raw),
  };
}

/**
 * The report, as plain text.
 *
 * Plain text on purpose: it goes into a chat message from a phone, where anything needing a file
 * or a console is not going to happen. Per-photograph figures as well as totals, because the
 * totals scale with how much was looked at and the per-photograph ones are what can be compared
 * against the numbers in `CLAUDE.md`.
 */
const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

export function report(totals: Totals, platform: PlatformFacts): string {
  const per = (ms: number) => (totals.files === 0 ? '—' : `${(ms / totals.files).toFixed(2)} ms`);
  const total = totals.readMs + totals.parseMs + totals.exifMs;

  return [
    'snapmapper thumbnail timings',
    `  platform      ${platform.summary}`,
    `  cores         ${platform.cores}`,
    `  memory        ${platform.memory}`,
    '',
    `  photographs   ${totals.files} in ${totals.batches} batch(es)`,
    `  by byte read  ${totals.fast}`,
    `  by ExifTool   ${totals.slow}`,
    '',
    `  bytes read    ${(totals.bytesRead / 1024 / 1024).toFixed(1)} MB total, `
      + `${totals.files === 0 ? '—' : Math.round(totals.bytesRead / totals.files / 1024)} KB each`,
    `  head window   ${kb(totals.windowPhoto)} jpeg, ${kb(totals.windowRaw)} raw`,
    `  deepest read  ${kb(totals.deepestPhoto)} jpeg, ${kb(totals.deepestRaw)} raw`,
    `  second reads  ${Math.max(0, totals.reads - totals.files)}`
      + ' — each one costs a whole extra round trip',
    `  reads         ${totals.reads} calls, `
      + `${totals.reads === 0 ? '—' : `${(totals.readMs / totals.reads).toFixed(1)} ms per call`}`,
    `  reading       ${Math.round(totals.readMs)} ms total, ${per(totals.readMs)} each`,
    `  parsing       ${Math.round(totals.parseMs)} ms total, ${per(totals.parseMs)} each`,
    `  ExifTool      ${Math.round(totals.exifMs)} ms total, ${per(totals.exifMs)} each`,
    `  all stages    ${Math.round(total)} ms total, ${per(total)} each`,
    '',
    // The one line that says whether the reads are actually overlapping: if reading dominates and
    // it is tens of milliseconds per photograph, they are being serialised somewhere.
    `  verdict       ${verdict(totals)}`,
  ].join('\n');
}

function verdict(totals: Totals): string {
  if (totals.files === 0) return 'nothing measured yet';

  const readEach = totals.readMs / totals.files;
  const exifEach = totals.exifMs / totals.files;

  if (exifEach > readEach && exifEach > 5) {
    return `ExifTool dominates at ${exifEach.toFixed(0)} ms each — raw, or the byte reader declining`;
  }
  /*
   * Second reads first, because it is the one cause with a fix that is known to work.
   *
   * A read is charged per round trip — 110 ms whether it carries 43KB or 128KB, measured on two
   * devices — so a head too small to hold the thumbnail nearly doubles that photograph. It is also
   * the only line here that says *which camera* the window is wrong for, and the window tunes
   * itself, so seeing this at the end of a run means the tuning did not converge.
   */
  const perFile = totals.reads / totals.files;
  if (readEach > 15 && perFile > 1.2) {
    return `reading dominates at ${readEach.toFixed(0)} ms each — and ${perFile.toFixed(2)} reads `
      + 'per photograph, so the head window is still too small for this camera';
  }
  if (readEach > 15) {
    return `reading dominates at ${readEach.toFixed(0)} ms each — the card, or reads not overlapping`;
  }
  return `reading ${readEach.toFixed(1)} ms each — as expected`;
}

export interface PlatformFacts {
  readonly summary: string;
  readonly cores: string;
  readonly memory: string;
}

/**
 * What machine this is, in the roughest terms.
 *
 * A user agent string rather than anything clever: the question being answered is only ever
 * "phone or desktop, and which browser", and every attempt to be more precise than that is a
 * different kind of wrong.
 */
export function platformFacts(): PlatformFacts {
  const nav = globalThis.navigator as Navigator & {
    deviceMemory?: number;
    hardwareConcurrency?: number;
  } | undefined;

  return {
    summary: nav?.userAgent ?? 'unknown',
    cores: nav?.hardwareConcurrency ? String(nav.hardwareConcurrency) : 'unknown',
    memory: nav?.deviceMemory ? `${nav.deviceMemory} GB or more` : 'not reported',
  };
}
