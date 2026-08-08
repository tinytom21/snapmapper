/**
 * Confirming a write, by reading the file back.
 *
 * "The write returned successfully" and "the photograph now has the right location in it"
 * are different claims, and only the second one matters. This module makes the second one.
 *
 * It is the same discipline that made Phase 0 trustworthy. Q1 was only believable because
 * ExifTool-WASM's output was checked with a *separate* native ExifTool rather than with
 * itself, and Q5 caught `piexifjs` corrupting files precisely because something read the
 * result back afterwards. A per-save version of that check is cheap and guards irreplaceable
 * data, so it is on by default.
 *
 * ## What it checks, and why those things
 *
 *   - **The coordinates read back as intended.** Catches a write that silently did nothing,
 *     wrote to the wrong tag group, or lost a hemisphere.
 *   - **ExifTool raises no new structural warning.** This is the load-bearing one. It is the
 *     exact signal that exposed `piexifjs` — `Possibly incorrect maker notes offsets` — and
 *     it is invisible to any check that only looks at tag values, because the coordinates
 *     read back perfectly from a file whose maker notes have been wrecked.
 *
 * ## What it deliberately does not do
 *
 * It does not compare against the original file. That would need the original bytes kept in
 * memory for every photo in a batch, and the thorough version of that comparison — 184
 * checks including preview resolution and byte drift — belongs in
 * `spike/src/splice-write.mjs`, run against a native ExifTool. This is the fast check that
 * can afford to run on every save, not a replacement for that one.
 */

import type { Coordinates } from './gps.ts';
import type { TagValues } from './exiftool.ts';

/**
 * Tags to request when verifying. Group-prefixed with `-G`, family 0 only.
 *
 * `Composite:*` for coordinates because those are ExifTool's *signed* values; the raw EXIF
 * tags are unsigned with the hemisphere in a separate ref, and reading them as signed is the
 * bug that once made the spike's verifier report a false failure on every southern location.
 */
export const VERIFY_TAGS: readonly string[] = [
  'Composite:GPSLatitude',
  'Composite:GPSLongitude',
  'EXIF:GPSLatitudeRef',
  'EXIF:GPSLongitudeRef',
  'Warning',
];

/**
 * Arguments for a verification read.
 *
 * Note the absence of `-fast2`, which every other read here uses. `-fast2` stops before
 * parsing maker notes, and so never produces the maker-note warning that is the main reason
 * this check exists — measured: a corrupted file reports nothing under `-fast2` and
 * `[minor] Possibly incorrect maker notes offsets` without it. Since verification runs
 * against a ~100KB header stub rather than the whole photograph, the fuller parse is
 * affordable.
 */
export const VERIFY_ARGS: readonly string[] = ['-json', '-n', '-G', '-a', '-u'];

/**
 * How far a coordinate may drift and still count as correct.
 *
 * EXIF stores coordinates as three rationals, so a round trip is not bit-exact. 1e-6 degrees
 * is about 10cm — far tighter than any camera placement, and loose enough that rational
 * quantisation never trips it. The same tolerance the Phase 0 verifier used.
 */
export const COORD_TOLERANCE = 1e-6;

export interface WriteVerification {
  readonly ok: boolean;
  /** Human-readable reasons the file is not what was intended. Empty when ok. */
  readonly problems: readonly string[];
  /** Warnings ExifTool raised. Present in `problems` too when structural. */
  readonly warnings: readonly string[];
}

/**
 * Compare what a file now contains against what was meant to be written.
 *
 * `expected` is `null` for a location that was cleared, which has to be verified as
 * *absence* — a clear that silently did nothing would otherwise pass unnoticed.
 */
/**
 * `'unchanged'` checks the file's structure without checking its coordinates.
 *
 * For a write that staged place names and nothing else: the coordinates were not touched, so
 * neither "should equal these" nor "should be absent" is the right question. The half of this that
 * catches real damage — ExifTool's structural warning on the read-back — still runs, and that is
 * the half that would otherwise let a wrecked file through reporting perfect coordinates.
 */
export type ExpectedLocation = Coordinates | null | 'unchanged';

export function verifyWrittenLocation(
  tags: TagValues,
  expected: ExpectedLocation,
): WriteVerification {
  const problems: string[] = [];
  const warnings = collectWarnings(tags);

  // Any warning at all is worth reporting, but only structural ones fail the write: a file
  // whose maker notes no longer add up is damaged, whatever its coordinates say.
  for (const warning of warnings) {
    if (isStructural(warning)) problems.push(`ExifTool reports: ${warning}`);
  }

  const latitude = numberOf(tags['Composite:GPSLatitude']);
  const longitude = numberOf(tags['Composite:GPSLongitude']);

  // Structure only. The warnings above have already been collected and judged.
  if (expected === 'unchanged') return { ok: problems.length === 0, problems, warnings };

  if (expected === null) {
    if (latitude !== undefined || longitude !== undefined) {
      problems.push(
        `location should have been removed but still reads ${latitude}, ${longitude}`,
      );
    }
    return { ok: problems.length === 0, problems, warnings };
  }

  if (latitude === undefined || longitude === undefined) {
    problems.push('no coordinates could be read back from the file');
    return { ok: false, problems, warnings };
  }

  if (Math.abs(latitude - expected.latitude) > COORD_TOLERANCE) {
    problems.push(`latitude reads ${latitude}, expected ${expected.latitude}`);
  }
  if (Math.abs(longitude - expected.longitude) > COORD_TOLERANCE) {
    problems.push(`longitude reads ${longitude}, expected ${expected.longitude}`);
  }

  // The refs are checked separately because they are stored separately. A file with the
  // right magnitude and the wrong ref puts the photo in the wrong hemisphere, and
  // Composite:* would hide that by combining them before we ever see it.
  const latitudeRef = tags['EXIF:GPSLatitudeRef'];
  const longitudeRef = tags['EXIF:GPSLongitudeRef'];
  const wantLatitudeRef = expected.latitude < 0 ? 'S' : 'N';
  const wantLongitudeRef = expected.longitude < 0 ? 'W' : 'E';

  if (latitudeRef !== undefined && latitudeRef !== wantLatitudeRef) {
    problems.push(`latitude ref reads ${String(latitudeRef)}, expected ${wantLatitudeRef}`);
  }
  if (longitudeRef !== undefined && longitudeRef !== wantLongitudeRef) {
    problems.push(`longitude ref reads ${String(longitudeRef)}, expected ${wantLongitudeRef}`);
  }

  return { ok: problems.length === 0, problems, warnings };
}

/**
 * Warnings that mean the file's structure is wrong, rather than merely unusual.
 *
 * Deliberately narrow and explicit. A broad "any warning fails" rule would reject files over
 * harmless remarks and train people to ignore the result, which is worse than not checking.
 * The first entry is the one that caught `piexifjs`.
 */
const STRUCTURAL_WARNINGS: readonly RegExp[] = [
  /maker ?note/i,
  /possibly incorrect/i,
  /truncated/i,
  /corrupt/i,
  /bad (ifd|header|offset)/i,
  /invalid (ifd|exif|tiff)/i,
];

function isStructural(warning: string): boolean {
  return STRUCTURAL_WARNINGS.some((pattern) => pattern.test(warning));
}

/**
 * Every warning in the output.
 *
 * ExifTool reports these as `ExifTool:Warning`, and with `-a` a file with several produces
 * numbered variants like `ExifTool:Warning (1)`, so this matches on the prefix rather than
 * an exact key.
 */
function collectWarnings(tags: TagValues): string[] {
  const warnings: string[] = [];

  for (const [key, value] of Object.entries(tags)) {
    if (!/(^|:)Warning( |$|\s*\()/i.test(key)) continue;
    if (typeof value === 'string' && value.trim() !== '') warnings.push(value.trim());
  }

  return warnings;
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
