/**
 * Get the ExifTool Perl script out of `@uswriting/exiftool`, at build time.
 *
 * ## Why this exists
 *
 * Reading metadata costs about a second **per ExifTool invocation** and almost nothing per byte —
 * sixty-eight times the data made no measurable difference (`spike/src/load-cost.mjs`). So the
 * single biggest thing that can happen to loading is several photographs sharing one invocation,
 * and it was measured at **8–14x**: 43 ms per photo in a batch of 28 against 354–592 ms alone.
 *
 * The wrapper this app uses takes exactly one file. But it is a thin layer over zeroperl: it mounts
 * the input into a virtual filesystem with `addFile`, appends the path to an **argument list**, and
 * runs `/exiftool`. Running several is a matter of mounting several and appending several paths —
 * except that `/exiftool` is the Perl script, and the wrapper holds it as a template literal
 * assigned to a minified binding that it does not export.
 *
 * ## Why extraction rather than vendoring
 *
 * Copying 101KB of someone else's Perl into this repository would freeze it at today's version:
 * `npm update` would move the wrapper and the script would stay behind, so the app would be
 * reading with one ExifTool and writing with another. Extracting keeps it **derived** — an upgrade
 * flows through with no action — and this is the same shape as `vite-plugin-zeroperl.ts`, which
 * already serves the WASM binary out of the dependency rather than committing it.
 *
 * The price is a dependence on the bundle's shape, and the mitigation is that **every failure here
 * is a loud build failure**. There is no fallback to a stale copy and no silent empty string: a
 * wrapper that stops embedding the script this way stops the build, with a message saying what to
 * look at. Loading falls back to the one-at-a-time path at runtime if the script never arrives,
 * so the worst case is the speed the app has today.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Where the template literal starts. The script opens with Perl's own preamble. */
const MARKER = '=`use strict;use warnings;';

/**
 * Sanity checks on what came out.
 *
 * Extraction is string handling against a minified bundle, and the failure mode worth guarding
 * against is not "throws" but "returns something plausible and wrong" — a truncated script would
 * still be tens of kilobytes of real Perl and would fail at the moment a user opens photographs,
 * not at the moment somebody built the app.
 */
const MUST_CONTAIN = [
  'Image::ExifTool',
  // The script's own argument handling. If this is missing, the tail was lost.
  'ARGV',
];

/** Below this it cannot be the whole thing; it measured 101KB against wrapper 1.0.9. */
const MIN_BYTES = 60_000;

/**
 * Pull the script out of the wrapper's bundled source.
 *
 * Exported separately from the file reading so it can be tested against a synthetic bundle as well
 * as the real one — the unescaping is the subtle part and deserves cases that do not depend on
 * whatever the installed version happens to contain.
 */
export function extractExifToolScript(source: string): string {
  const start = source.indexOf(MARKER);
  if (start < 0) {
    throw new Error(
      'could not find the ExifTool script in @uswriting/exiftool: no template literal starting '
      + `with ${JSON.stringify(MARKER.slice(1))}. The package has changed shape — look at its `
      + 'dist/esm/index.js and update MARKER, or drop batched reads if it no longer embeds one.',
    );
  }

  const open = start + MARKER.length - 'use strict;use warnings;'.length;
  const end = findClose(source, open);
  if (end < 0) {
    throw new Error(
      'the ExifTool script in @uswriting/exiftool has no closing backtick — the bundle is '
      + 'truncated or is not what this expects.',
    );
  }

  const script = unescapeTemplate(source.slice(open, end));

  if (script.length < MIN_BYTES) {
    throw new Error(
      `the ExifTool script extracted from @uswriting/exiftool is only ${script.length} bytes, `
      + `which cannot be the whole of it (expected at least ${MIN_BYTES}).`,
    );
  }
  for (const needle of MUST_CONTAIN) {
    if (!script.includes(needle)) {
      throw new Error(
        `the ExifTool script extracted from @uswriting/exiftool does not contain ${needle} — `
        + 'it is not the script, or extraction cut it short.',
      );
    }
  }

  return script;
}

/** The first backtick not preceded by an escaping backslash. */
function findClose(source: string, from: number): number {
  let at = from;
  while (at < source.length) {
    const char = source[at];
    if (char === '\\') { at += 2; continue; }
    if (char === '`') return at;
    at += 1;
  }
  return -1;
}

/**
 * Undo JavaScript template-literal escaping, one pass, left to right.
 *
 * A single left-to-right pass rather than a series of `replaceAll` calls, and the difference is
 * not stylistic. Replacing `\\` after `` \` `` means the second pass can see backslashes the first
 * pass produced, so an input like `\\\`` — a literal backslash followed by a literal backtick —
 * comes out of a chained implementation by luck rather than by construction. Perl is a language
 * where backslashes are everywhere, in regular expressions especially, so getting this wrong
 * silently changes what ExifTool does.
 *
 * The named escapes are handled although a bundler emitting this writes real newlines rather than
 * `\n` — verified against 1.0.9. Turning a `\n` it *did* emit into the letter `n` would break the
 * Perl in a way no assertion here would catch.
 */
export function unescapeTemplate(text: string): string {
  const out: string[] = [];
  let at = 0;

  while (at < text.length) {
    const char = text[at];
    if (char !== '\\') { out.push(char as string); at += 1; continue; }

    const next = text[at + 1];
    at += 2;

    switch (next) {
      case 'n': out.push('\n'); break;
      case 'r': out.push('\r'); break;
      case 't': out.push('\t'); break;
      case 'b': out.push('\b'); break;
      case 'f': out.push('\f'); break;
      case 'v': out.push('\v'); break;
      case '0':
        // `\0` is NUL only when not the start of a longer octal-looking run; JSON-safe bundlers
        // do not emit legacy octal, so this is the plain case.
        out.push('\0');
        break;
      case 'x': {
        const hex = text.slice(at, at + 2);
        out.push(String.fromCharCode(parseInt(hex, 16)));
        at += 2;
        break;
      }
      case 'u': {
        if (text[at] === '{') {
          const close = text.indexOf('}', at);
          out.push(String.fromCodePoint(parseInt(text.slice(at + 1, close), 16)));
          at = close + 1;
        } else {
          out.push(String.fromCharCode(parseInt(text.slice(at, at + 4), 16)));
          at += 4;
        }
        break;
      }
      case undefined: break;
      // Everything else stands for itself: a backtick, a dollar, a backslash, a quote.
      default: out.push(next); break;
    }
  }

  return out.join('');
}

/** Read the installed wrapper's bundle and extract from it. */
export async function readExifToolScript(): Promise<string> {
  const require = createRequire(import.meta.url);

  /*
   * Navigated from the entry point rather than resolved directly.
   *
   * `require.resolve` lands on the CJS build — `dist/cjs/index.cjs` — because that is what the
   * `exports` map offers a CommonJS resolver, and the package exposes nothing else: asking for
   * `@uswriting/exiftool/dist/esm/index.js` fails with ERR_PACKAGE_PATH_NOT_EXPORTED, which is
   * exactly the door this is going around. The ESM build is the one the app itself imports, so it
   * is the one whose script must be used.
   */
  const entry = require.resolve('@uswriting/exiftool');
  const file = path.join(path.dirname(path.dirname(entry)), 'esm', 'index.js');

  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(
      `could not read ${file} to extract the ExifTool script: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return extractExifToolScript(source);
}
