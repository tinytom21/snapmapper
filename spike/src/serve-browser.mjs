/**
 * Static server for the webview measurement page.
 *
 * Binds to all interfaces so the tablet can reach it — the Android numbers are
 * the ones that decide whether this backend is viable, and a desktop browser
 * will flatter it.
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_DIR = path.join(here, '..', 'browser');
const REPO_ROOT = path.resolve(here, '..', '..');
const PORT = Number(process.env.PORT ?? 8080);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * `.ts` served to a browser has its types stripped on the way out.
 *
 * The splice now lives in `packages/core/src/jpeg.ts`, because it is shipping code
 * rather than spike code, and the measurement page imports it from there. A browser
 * cannot parse type annotations, and standing up a bundler for one static page is not
 * worth it — Node strips them itself, which keeps the phone measuring the exact code
 * that ships instead of a copy that will drift from it.
 */
async function readMaybeStrippingTypes(filePath) {
  const source = await readFile(filePath, 'utf8');
  if (!filePath.endsWith('.ts')) return null;

  const { stripTypeScriptTypes } = await import('node:module');
  return stripTypeScriptTypes(source, { mode: 'strip' });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  // SharedArrayBuffer needs cross-origin isolation. Sent unconditionally
  // because whether zeroperl requires it is one of the things being measured.
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  const filePath = resolvePath(url.pathname);

  if (!filePath) {
    response.writeHead(403).end('Refused');
    return;
  }

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) {
      response.writeHead(404).end('Not found');
      return;
    }

    const stripped = await readMaybeStrippingTypes(filePath);
    if (stripped !== null) {
      const body = Buffer.from(stripped, 'utf8');
      response.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': body.byteLength,
      });
      response.end(body);
      return;
    }

    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
      'Content-Length': info.size,
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404).end(`Not found: ${url.pathname}`);
  }
});

/**
 * Map a URL onto disk, refusing anything that escapes the two roots we serve.
 */
function resolvePath(pathname) {
  const decoded = decodeURIComponent(pathname);

  if (decoded === '/' || decoded === '') {
    return path.join(BROWSER_DIR, 'index.html');
  }

  // In a browser, zeroperl fetches './zeroperl.wasm' — and a relative URL in a
  // bundled module resolves against the *document*, not the module, so the
  // request arrives at the site root however deep the package really is. Serving
  // it here is what makes the browser path work at all.
  //
  // The same applies to a real build: the 24MB WASM has to sit next to the page,
  // not merely somewhere in the bundle.
  if (decoded === '/zeroperl.wasm') {
    return path.join(
      REPO_ROOT, 'node_modules', '@6over3', 'zeroperl-ts', 'dist', 'esm', 'zeroperl.wasm',
    );
  }

  // The measurement page imports the splice implementation from spike/src, so the
  // phone times exactly the code the Node run verified against a native ExifTool.
  // Two copies of this algorithm would make the measurement meaningless.
  if (decoded.startsWith('/src/')) {
    return contain(path.join(REPO_ROOT, 'spike', 'src'), decoded.slice('/src/'.length));
  }

  // spike/src/splice-core.mjs re-exports packages/core/src/jpeg.ts, so the relative
  // import resolves up to here. Types are stripped on the way out.
  if (decoded.startsWith('/packages/')) {
    return contain(REPO_ROOT, decoded.slice(1));
  }

  // The page imports the package straight out of node_modules.
  if (decoded.startsWith('/vendor/exiftool/')) {
    const rest = decoded.slice('/vendor/exiftool/'.length);
    const base = path.join(REPO_ROOT, 'node_modules', '@uswriting', 'exiftool');
    return contain(base, rest);
  }

  if (decoded.startsWith('/node_modules/')) {
    return contain(REPO_ROOT, decoded.slice(1));
  }

  return contain(BROWSER_DIR, decoded.slice(1));
}

function contain(root, relative) {
  const resolved = path.resolve(root, relative);
  return resolved.startsWith(path.resolve(root)) ? resolved : null;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
  Serving the webview measurement page on port ${PORT}.

    desktop   http://localhost:${PORT}/`);

  for (const address of lanAddresses()) {
    console.log(`    tablet    http://${address}:${PORT}/`);
  }

  console.log(`
  Run it on the tablet, not just here — that is the number that decides whether
  ExifTool-WASM is viable on Android.

  If the page loads but the WASM module fails on the tablet, it is likely
  demanding a secure context. Plug the device in and forward the port so it
  arrives as localhost, which counts as secure:

    adb reverse tcp:${PORT} tcp:${PORT}

  Then open http://localhost:${PORT}/ on the device itself.
`);
});

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}
