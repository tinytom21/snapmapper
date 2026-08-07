/**
 * Emit the service worker with the built asset names baked into it.
 *
 * A precache list has to name the files it precaches, and Vite's filenames carry a content
 * hash that is not known until the bundle exists. So the list is collected from the bundle
 * and substituted into `sw-template.js`.
 *
 * Only in a build. In dev the modules are unbundled and served on demand, and a service
 * worker holding a cached shell in front of that is a reliable way to spend an afternoon
 * debugging a stale file. `main.tsx` registers it only when `import.meta.env.PROD`.
 *
 * Written by hand rather than with `vite-plugin-pwa` because what is wanted here is small and
 * unusual: precache 1.6MB of shell, deliberately *don't* precache a 24MB WASM binary, and cap
 * a tile cache. Expressing those exceptions through someone else's generator would be more
 * work than the 60 lines below, and this repository already prefers a plugin it can read.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

/** 24MB, fetched on first use instead. See the template's header comment. */
const NEVER_PRECACHE = new Set(['zeroperl.wasm', 'sw.js']);

export function serviceWorker(): Plugin {
  let template: string;
  let publicFiles: string[] = [];
  /** Always starts and ends with a slash; '/' at a domain root. */
  let base = '/';

  return {
    name: 'service-worker',
    // Dev is deliberately untouched: no `configureServer`.
    apply: 'build',

    async buildStart() {
      template = await readFile(
        path.join(import.meta.dirname, 'sw-template.js'),
        'utf8',
      );
    },

    /*
     * `public/` is copied verbatim and never appears in the bundle, so its contents have to be
     * enumerated from disk or they are silently left out of the precache. That was the first
     * version of this plugin: the manifest and both icons were missing, and the only symptom
     * was that installing offline did not offer an icon.
     *
     * Enumerated rather than listed, so adding a file to `public/` does not require also
     * remembering this file.
     */
    async configResolved(config) {
      base = config.base;
      // Resolves to '' when public asset copying is turned off.
      if (!config.publicDir) return;
      publicFiles = await listFiles(config.publicDir);
    },

    /*
     * `generateBundle` rather than `writeBundle`, so the worker is emitted as part of the
     * bundle and lands wherever the output directory is.
     *
     * It runs after the other plugins' `generateBundle` hooks only if ordered last, which
     * `enforce: 'post'` on the plugin object would guarantee — but the zeroperl plugin emits
     * by a fixed name that is excluded here regardless, so ordering does not matter. What
     * would matter is a *hashed* asset emitted after this hook; nothing does that.
     */
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((name) => !NEVER_PRECACHE.has(name))
        .sort();

      /*
       * Base-prefixed, every one of them.
       *
       * The base itself rather than `index.html`, because that is what a navigation actually
       * requests and what the worker answers it from. A precache list written for '/' on a site
       * served from '/snapmapper/' fails at install: `addAll` rejects on the first 404 and
       * nothing at all is cached, so the app simply has no offline support and says nothing.
       */
      const precache = [
        base,
        ...assets.map((name) => `${base}${name}`),
        ...publicFiles.map((url) => `${base}${url.replace(/^\//, '')}`),
      ].filter((url, index, all) => all.indexOf(url) === index);

      /*
       * The version is a hash of what is being cached.
       *
       * Not a timestamp and not the package version — a rebuild that changes nothing should
       * not invalidate a phone's cache, and a change to any asset must. Deriving it from the
       * content is the only way both hold.
       */
      const version = createHash('sha256')
        .update(precache.join('\n'))
        .digest('hex')
        .slice(0, 12);

      let source = replaceOnce(template, "'__VERSION__'", JSON.stringify(version));
      // The quotes are part of the token: the value is an array, not a string.
      source = replaceOnce(source, "'__PRECACHE__'", JSON.stringify(precache));
      source = replaceOnce(source, "'__BASE__'", JSON.stringify(base));

      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

/** Every file under a directory, as root-relative URLs with forward slashes. */
async function listFiles(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    const url = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...await listFiles(path.join(directory, entry.name), url));
    } else {
      found.push(url);
    }
  }

  return found.sort();
}

/**
 * Substitute exactly one occurrence, or fail the build.
 *
 * A silent no-op here would ship a service worker that precaches the literal string
 * `__PRECACHE__` and works perfectly on the machine that built it, because that machine has
 * everything in its HTTP cache already. This project has already lost time to a patch script
 * whose `replace` matched nothing.
 */
function replaceOnce(source: string, token: string, value: string): string {
  const parts = source.split(token);
  if (parts.length !== 2) {
    throw new Error(
      `sw-template.js must contain ${token} exactly once, found ${parts.length - 1}`,
    );
  }
  return parts.join(value);
}
