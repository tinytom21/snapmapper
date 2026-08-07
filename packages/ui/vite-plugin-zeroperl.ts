/**
 * Serve `zeroperl.wasm` at the site root, in dev and in a build.
 *
 * In a browser, zeroperl loads its binary with `fetch('./zeroperl.wasm')`. A relative URL
 * in a bundled module resolves against the **document**, not the module, so the request
 * always arrives at the site root however deep the package actually sits. Under Vite the
 * file lives in `node_modules/@6over3/zeroperl-ts/dist/esm/`, so without this every write
 * fails on a 404 — and it fails at the moment the user presses Save, not at startup.
 *
 * Handled with a plugin rather than by copying 24MB into `public/`, which would mean
 * committing a binary to the repository or relying on a setup step nobody remembers.
 *
 * Phase 0 hit exactly this in `spike/src/serve-browser.mjs`. Recording it here as well
 * because it is a packaging requirement for any shell: **the WASM has to sit next to the
 * page.** Android will need the same arrangement.
 */

import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';

const WASM_URL = '/zeroperl.wasm';

function resolveWasm(): string {
  const require = createRequire(import.meta.url);
  // require.resolve lands on the CJS entry; the browser build uses the ESM copy, and
  // they are byte-identical.
  const entry = require.resolve('@6over3/zeroperl-ts');
  return path.join(path.dirname(path.dirname(entry)), 'esm', 'zeroperl.wasm');
}

export function zeroperlWasm(): Plugin {
  let wasmPath: string;

  return {
    name: 'zeroperl-wasm',

    configResolved() {
      wasmPath = resolveWasm();
    },

    // Dev: stream it straight off disk. 24MB is not worth loading into memory.
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith(WASM_URL)) return next();

        stat(wasmPath).then(
          (info) => {
            response.setHeader('Content-Type', 'application/wasm');
            response.setHeader('Content-Length', info.size);
            createReadStream(wasmPath).pipe(response);
          },
          () => {
            response.statusCode = 404;
            response.end(
              `zeroperl.wasm not found at ${wasmPath} — run npm install at the repo root`,
            );
          },
        );
      });
    },

    // Build: emit it as an asset with its name preserved, since the fetch is by name.
    async generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'zeroperl.wasm',
        source: await readFile(wasmPath),
      });
    },
  };
}
