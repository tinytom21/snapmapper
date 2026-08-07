/**
 * The service worker, so the app runs on a phone with no server anywhere.
 *
 * Not shipped as written: `vite-plugin-service-worker.ts` substitutes __VERSION__, __PRECACHE__
 * and __BASE__ at build time and emits the result beside `index.html`. It has to sit there
 * because a worker's scope cannot rise above its own directory, and this one must control the
 * whole app — which on a GitHub Pages project site is `/<repo>/` rather than `/`.
 *
 * Plain JavaScript rather than TypeScript for the same reason `zeroperl.wasm` is emitted by
 * name: the file must arrive at a fixed URL, unhashed and unbundled, and the less machinery
 * between the source and that URL the fewer ways it can silently not be there.
 *
 * ## What is cached, and why differently
 *
 * - **The app shell** — HTML, JS, CSS, icons, manifest — is precached on install. Small
 *   (~1.6MB) and needed before anything works.
 * - **`zeroperl.wasm`** is *not* precached. It is 24MB, and precaching it would mean a
 *   24MB download at install time for a user who may only want to look at the map. It is
 *   cached the first time it is fetched, which is the first time a photo is read.
 *
 * **Map tiles are not cached, and cannot be from here.** MapLibre fetches them inside a worker
 * it creates from a `blob:` URL, and requests from such a worker do not reach this service
 * worker — measured: with the worker active and controlling the page, zero tile requests arrive,
 * and none appear in the page's resource timing either. So offline the app opens and every photo
 * can still be placed by coordinates, but the map is blank over ground never loaded online.
 *
 * Fixing that means routing tiles through the main thread with `maplibregl.addProtocol`, whose
 * handlers do run there. That is a change to the map's critical loading path and is worth doing
 * deliberately, not as a side effect of adding a cache. The plan's real offline answer is PMTiles.
 *
 * ## Photographs are never cached
 *
 * They never travel over HTTP in the first place — the File System Access API hands them
 * over as bytes. There is nothing here for a cache to see, and this comment exists so that
 * nobody later adds a catch-all handler that changes that.
 */

const VERSION = '__VERSION__';
const SHELL = '__PRECACHE__';

/*
 * Where the app is served from: '/' at a domain root, '/snapmapper/' on a GitHub Pages project
 * site. Everything below is relative to this.
 *
 * A worker cannot see `import.meta.env`, and `self.registration.scope` is an absolute URL that
 * would need parsing, so the build substitutes it. Getting this wrong is quiet: the worker
 * registers, reports itself active, and answers nothing, because the URLs it is watching for do
 * not exist on this host.
 */
const BASE = '__BASE__';

const SHELL_CACHE = `shell-${BASE}-${VERSION}`;
/*
 * Deliberately unversioned, so it survives an app update.
 *
 * 24MB re-downloaded to ship a CSS fix would be a punishing way to release. The risk is the
 * mirror image: the binary is fetched by a fixed name, so a zeroperl upgrade would be served
 * the old bytes from here forever. Bump this cache's name when that dependency changes.
 */
const WASM_CACHE = `wasm-${BASE}`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  /*
   * No `skipWaiting()`, on purpose.
   *
   * A new version takes over on the next launch rather than mid-session. Swapping the assets
   * under a running page is how you lose staged edits that have not been written to disk yet,
   * and this app's whole premise is that unsaved work is held in memory until Save.
   */
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      // Old shells go; the wasm cache is meant to outlive a version. Scoped to this base, so a
      // sibling app on the same github.io origin is left alone.
      if (name.startsWith(`shell-${BASE}-`) && name !== SHELL_CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  /*
   * A navigation is answered from the cached shell.
   *
   * `index.html` is not content-hashed, so a stale copy would pin the app to an old version
   * forever if the service worker itself never updated. It does update: the browser
   * revalidates this file on navigation, installs the new shell, and the next launch uses it.
   */
  if (request.mode === 'navigate') {
    event.respondWith(cacheFirst(SHELL_CACHE, new Request(BASE, { credentials: 'same-origin' })));
    return;
  }

  // Anything on another host — map tiles — is left entirely alone. So is anything on this host
  // outside the app's own base, which on a shared domain like github.io is somebody else's site.
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;

  if (url.pathname === `${BASE}zeroperl.wasm`) {
    event.respondWith(cacheFirst(WASM_CACHE, request));
    return;
  }

  // Everything else under the base is a hashed asset: immutable, so cache-first is safe and a
  // miss simply goes to the network.
  event.respondWith(cacheFirst(SHELL_CACHE, request));
});

async function cacheFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  /*
   * `ignoreVary` is load-bearing, and cost an offline test to find.
   *
   * Vite's preview server answers assets with `Vary: Origin`. Precached entries are stored by
   * `addAll`, whose requests carry no `Origin` header, while the page's own request for a module
   * script does carry one — so a Vary-respecting match misses, falls through to the network, and
   * the app fails to boot with the server off. The document loaded; the JavaScript did not.
   *
   * Safe because of what is in these caches: same-origin static files, one entry per URL, put
   * there by this worker. There is no second variant of any of them for Vary to choose between.
   */
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;

  const response = await fetch(request);
  // Only store a real success. Caching a 404 or a 500 would make a transient failure
  // permanent, which is the worst bug a cache can have.
  if (response.ok && response.status === 200) await cache.put(request, response.clone());
  return response;
}
