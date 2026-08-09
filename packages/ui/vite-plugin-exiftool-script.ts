/**
 * Supply the ExifTool Perl script to the app as `virtual:exiftool-script`.
 *
 * The extraction itself, and the reasoning for extracting rather than vendoring, is in
 * `exiftool-script.ts`. This is only the delivery.
 *
 * ## Why a virtual module rather than an asset at the site root
 *
 * `vite-plugin-zeroperl.ts` serves the 24MB WASM by name, because zeroperl fetches it by name and
 * there is no choice. There is a choice here, and a module is the better half of it:
 *
 * - **It cannot 404.** An asset served by a plugin is one path mistake — or one base-URL
 *   difference between localhost and a GitHub Pages project site — away from arriving as HTML at
 *   the moment a user opens photographs. A module is resolved at build time or the build fails.
 * - **Offline needs no new arrangement.** The service worker precaches hashed assets and
 *   cache-firsts the rest; a chunk is already covered. A new root-level file would have needed
 *   its own case, and one that nobody would notice was missing until a phone was off the network.
 * - **It is lazily loaded anyway.** `batch-runner.ts` is reached through a dynamic import, so the
 *   100KB of Perl lands in its own chunk and is fetched when photographs are first read — the same
 *   moment the 24MB binary is, which makes it a rounding error rather than a cost.
 *
 * The size is the argument for the other side, and it does not survive contact with the numbers:
 * ~100KB of Perl compresses to about a quarter of that, against a WASM binary two hundred and
 * forty times larger fetched at the same instant.
 */

import type { Plugin } from 'vite';

import { readExifToolScript } from './exiftool-script.ts';

export const EXIFTOOL_SCRIPT_ID = 'virtual:exiftool-script';

/** Vite's convention: a resolved virtual id starts with a NUL so no other plugin claims it. */
const RESOLVED_ID = `\0${EXIFTOOL_SCRIPT_ID}`;

export function exifToolScript(): Plugin {
  let script: string | undefined;

  return {
    name: 'exiftool-script',

    resolveId(id) {
      return id === EXIFTOOL_SCRIPT_ID ? RESOLVED_ID : undefined;
    },

    async load(id) {
      if (id !== RESOLVED_ID) return undefined;

      /*
       * Extracted on first request rather than in `buildStart`, so a dev server that never reads a
       * photograph never pays for it — and, more usefully, so the error surfaces attached to the
       * import that wanted it rather than as a bare startup failure.
       *
       * Deliberately **not** caught. `readExifToolScript` throws with a message naming what
       * changed in the dependency, and that must stop the build: the alternative is shipping an
       * app whose batched reads silently do not exist, which is invisible until somebody times a
       * folder load. Batching does fall back at runtime, but falling back is for a browser that
       * cannot manage it, not for a build that could have caught this.
       */
      script ??= await readExifToolScript();

      // A string literal, not a template one: the script is full of backticks and `${`.
      return `export default ${JSON.stringify(script)};\n`;
    },
  };
}
