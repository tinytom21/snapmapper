/**
 * Work around an upstream bug that stops @6over3/zeroperl-ts loading its own
 * WASM under Node.
 *
 * The loader resolves the binary like this:
 *
 *   let t = new URL("./zeroperl.wasm", import.meta.url).pathname;
 *   // ... await readFile(t)
 *
 * `.pathname` on a `file:` URL is not a filesystem path, and it fails two ways:
 *
 *   1. It keeps the leading slash before a Windows drive letter, so the path
 *      reads `/C:/…`. Node then resolves that against the current drive and
 *      tries to open `C:\C:\…`. This breaks on every Windows machine.
 *   2. It leaves percent-encoding in place, so any directory containing a space
 *      arrives as `photo%20geotagging`. That breaks on Linux and macOS too.
 *
 * `fileURLToPath()` exists precisely to do this correctly, and is what the fix
 * substitutes.
 *
 * This patches node_modules in place, which is not a way to ship anything — it
 * is here so Phase 0 can be measured at all. The finding itself is recorded in
 * spike/README.md, and the decision about how to carry the fix into a real build
 * (vendor the file, patch on install, or upstream it) belongs to Phase 1.
 *
 * Idempotent, and re-run automatically by the spike scripts. `npm install`
 * overwrites node_modules, so expect to need it again after one.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const BROKEN = 'let t=new URL(q,import.meta.url).pathname;';
const FIXED = 'let t=(await import("node:url")).fileURLToPath(new URL(q,import.meta.url));';

/** The CJS build has the same defect, spelled slightly differently. */
const BROKEN_CJS = 'new URL(q,require("url").pathToFileURL(__filename)).pathname';

export async function patchZeroperl() {
  const require = createRequire(import.meta.url);

  let entry;
  try {
    entry = require.resolve('@6over3/zeroperl-ts');
  } catch {
    return { patched: false, reason: 'package not installed — run npm install' };
  }

  // require.resolve lands on the CJS entry; the spike imports the ESM one.
  const esm = path.join(path.dirname(path.dirname(entry)), 'esm', 'index.js');

  let source;
  try {
    source = await readFile(esm, 'utf8');
  } catch (error) {
    return { patched: false, reason: `could not read ${esm}: ${error.message}` };
  }

  if (source.includes(FIXED)) {
    return { patched: false, alreadyPatched: true, file: esm };
  }

  if (!source.includes(BROKEN)) {
    // The upstream code changed. Better to say so than to silently do nothing
    // and let the failure surface 200 lines later as an ENOENT.
    return {
      patched: false,
      reason:
        'the known-broken loader line is not present — @6over3/zeroperl-ts has changed. '
        + 'Check whether it now resolves the WASM correctly, and delete this patch if so.',
      file: esm,
    };
  }

  await writeFile(esm, source.replace(BROKEN, FIXED));
  return { patched: true, file: esm };
}

/** True when the CJS build is also affected — informational only. */
export async function cjsAlsoBroken() {
  const require = createRequire(import.meta.url);
  try {
    const source = await readFile(require.resolve('@6over3/zeroperl-ts'), 'utf8');
    return source.includes(BROKEN_CJS) || source.includes('.pathname');
  } catch {
    return null;
  }
}
