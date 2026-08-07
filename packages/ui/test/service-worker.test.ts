/**
 * The service worker's build-time wiring.
 *
 * The worker itself runs in a browser and is verified there — registration, precache, and a
 * load with the server stopped. What is testable here is the part that fails *silently*: a
 * template whose placeholders no longer match, which would ship a worker that precaches the
 * literal string `__PRECACHE__` and still works perfectly on the machine that built it,
 * because that machine has everything in its HTTP cache already.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const TEMPLATE = path.join(import.meta.dirname, '..', 'sw-template.js');

const template = await readFile(TEMPLATE, 'utf8');

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('sw-template.js', () => {
  it('carries each placeholder exactly once, quotes included', () => {
    // The quotes are part of the token: the precache value is an array, not a string, so the
    // substitution has to consume them. The build throws if either count is not 1.
    assert.equal(occurrences(template, "'__VERSION__'"), 1);
    assert.equal(occurrences(template, "'__PRECACHE__'"), 1);
    assert.equal(occurrences(template, "'__BASE__'"), 1);
  });

  it('resolves every URL against the base, not the domain root', () => {
    /*
     * A GitHub Pages project site is served from `/<repo>/`. A worker written for '/' there is a
     * quiet failure, not a loud one: it registers, reports itself active, and matches nothing,
     * because `addAll` 404s on the first entry and caches none of them.
     *
     * So no absolute path may be hard-coded. These are the three places one would creep back in.
     */
    assert.match(template, /new Request\(BASE\b/);
    assert.match(template, /\$\{BASE\}zeroperl\.wasm/);
    assert.match(template, /startsWith\(BASE\)/);
    assert.doesNotMatch(template, /['"`]\/zeroperl\.wasm['"`]/);
  });

  it('is valid JavaScript once substituted', () => {
    const substituted = template
      .replace("'__VERSION__'", '"abc123"')
      .replace("'__PRECACHE__'", '["/","/assets/app.js"]');

    // Parses without evaluating: the worker's globals do not exist here.
    assert.doesNotThrow(() => new Function(substituted));
  });

  it('ignores Vary when matching the cache', () => {
    /*
     * Pinned because it is invisible until you pull the plug. Vite's preview server answers
     * assets with `Vary: Origin`; precached entries are stored by `addAll` with no `Origin`
     * header while the page's module-script request has one, so a Vary-respecting match misses
     * and the app fails to boot offline. Measured: the document loaded, the JavaScript did not.
     */
    assert.match(template, /cache\.match\(request, \{ ignoreVary: true \}\)/);
  });

  it('does not precache the 24MB binary', () => {
    // It is fetched on first use instead. Precaching it would mean a 24MB download at install
    // time for somebody who may only want to look at the map.
    assert.doesNotMatch(template, /SHELL.*zeroperl/);
    assert.match(template, /WASM_CACHE/);
  });

  it('never claims a page mid-session', () => {
    // `skipWaiting()` would swap the assets under a running page, which is how staged edits
    // that have not reached disk get lost. A new version takes over on the next launch.
    // The comment explaining the choice says the word, so this looks for the call.
    assert.doesNotMatch(template, /self\.skipWaiting\(\)/);
  });
});
