/**
 * Making the map work over ground you have already looked at.
 *
 * The app boots offline and photographs can be placed by typing coordinates, but the map is blank
 * anywhere that has never been loaded — which on a train, or in a field, is most places.
 *
 * ## Why the service worker cannot do this
 *
 * Measured and recorded in `CLAUDE.md`: MapLibre fetches tiles inside a **worker it creates from a
 * `blob:` URL**, and those requests never reach the service worker. Zero tile requests arrive.
 * A tile-caching branch was written against the service worker and deleted rather than shipped
 * looking plausible and never filling.
 *
 * `maplibregl.addProtocol` is the way through, and the reason is precisely that its handlers run on
 * the **main thread**. The worker asks the main thread to resolve any URL whose scheme has a
 * registered handler, so this sees every tile — and, as a happy side effect, it can be observed
 * from a test harness, which the worker's own fetches could not.
 *
 * ## How the style is redirected
 *
 * A handler only fires for its own scheme, so the style document's URLs have to name it. The style
 * is fetched on the main thread, every remote URL in it is rewritten from `https://…` to
 * `snapmapper-tiles://https://…`, and the rewritten object is handed to MapLibre. That covers
 * tiles, **glyphs and sprites** — and the glyphs matter as much as the tiles, because a vector map
 * with no glyphs renders every road and town silently unlabelled.
 */

/** The scheme MapLibre routes to us. Arbitrary, but it must not collide with a real one. */
export const TILE_PROTOCOL = 'snapmapper-tiles';

/**
 * Cache Storage, not IndexedDB.
 *
 * Tiles arrive as HTTP responses and Cache Storage stores responses — no serialising, no
 * re-wrapping, and the browser evicts it under storage pressure the way it does for any other
 * cache. Its own name so that clearing map tiles cannot touch the app shell or the 24MB WASM.
 */
export const TILE_CACHE = 'snapmapper-tiles-v1';

/** `snapmapper-tiles://https://tiles.example/1/2/3.pbf` → the real URL. */
export function realUrl(prefixed: string): string {
  const marker = `${TILE_PROTOCOL}://`;
  return prefixed.startsWith(marker) ? prefixed.slice(marker.length) : prefixed;
}

export function prefixUrl(url: string): string {
  // Only absolute remote URLs. A relative one would be ours to serve anyway, and prefixing it
  // would produce a scheme followed by a path that resolves to nothing.
  if (!/^https?:\/\//i.test(url)) return url;
  return `${TILE_PROTOCOL}://${url}`;
}

/**
 * Rewrite every remote URL in a style document so the handler sees it.
 *
 * Walks the whole object rather than picking known keys. A style's remote references live in
 * `sources[].tiles[]`, `sources[].url`, `glyphs` and `sprite` — but `sprite` may be a string or an
 * array of objects depending on the style version, and `sources[].url` is a TileJSON document that
 * itself contains tile URLs. Enumerating those shapes is how a style that is one version newer
 * quietly stops being cached.
 *
 * Pure, and exported for its own test: this is the part where a mistake means the map still works
 * perfectly online and caches nothing at all.
 */
export function redirectStyle<T>(style: T): T {
  return walk(style, false);
}

/**
 * Recurse everywhere; rewrite only under a key that holds URLs.
 *
 * The two have to be separate, and getting that wrong is how the first version of this failed. It
 * gated the *recursion* on the URL keys, so it stopped at `sources` — whose value is a map of
 * source names, none of which is a URL key — and never reached the `tiles` array inside. Every
 * style came back with its glyphs redirected and its tiles untouched, which caches the fonts and
 * nothing else while looking entirely correct.
 *
 * So: descend through every container, and turn rewriting on only when a key names a URL. Bare
 * strings elsewhere — layer ids, `text-field`, attribution HTML — are never touched, and a
 * rewritten attribution would be a broken credit link on a map whose licence requires one.
 */
function walk<T>(node: T, rewriting: boolean): T {
  // `prefixUrl` is the second guard: it only touches `http(s)://`, so an `id` sitting beside a
  // `url` inside a sprite entry passes through even with rewriting on.
  if (typeof node === 'string') return (rewriting ? prefixUrl(node) : node) as unknown as T;
  if (Array.isArray(node)) return node.map((item) => walk(item, rewriting)) as unknown as T;

  if (typeof node === 'object' && node !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = walk(value, rewriting || URL_KEYS.has(key));
    }
    return out as unknown as T;
  }

  return node;
}

/**
 * Style keys whose values are URLs.
 *
 * `sources` is deliberately **not** here. It is a container of sources, not a URL, and listing it
 * would turn rewriting on for everything beneath — including a source's own `attribution`, which
 * is a credit link that must stay pointing at OpenStreetMap.
 */
const URL_KEYS = new Set(['tiles', 'url', 'glyphs', 'sprite']);

/**
 * Fetch a style and point everything in it at the cache.
 *
 * The style document goes through `loadTile` like everything else, so it is cached too — a map
 * whose tiles are all present but whose style could not be fetched shows nothing at all, which
 * would make the whole feature look broken in exactly the situation it exists for.
 *
 * Returns the original URL untouched if anything fails. Losing offline caching is a shame; losing
 * the map is not acceptable, and the caller can hand a plain URL to MapLibre exactly as before.
 */
export async function offlineStyle(styleUrl: string): Promise<unknown> {
  try {
    const { data } = await loadTile(styleUrl);
    const style: unknown = JSON.parse(new TextDecoder().decode(data));

    /*
     * Relative URLs are resolved against the style's own address, and that address is about to
     * stop being a real one. So they are made absolute here, before the rewrite, or a style using
     * `"sprite": "/sprites/liberty"` would resolve against `snapmapper-tiles://…` and fetch
     * nothing.
     */
    return redirectStyle(absolutise(style, styleUrl));
  } catch {
    return styleUrl;
  }
}

/**
 * Resolve every URL-bearing string in a style against the document it came from.
 *
 * Two things here are not optional:
 *
 * **An already-absolute URL is left completely alone.** Not "resolved against the base and
 * returned unchanged" — untouched. `new URL(…).toString()` percent-encodes `{` and `}`, which are
 * in the WHATWG path encode set, so a perfectly good `{z}/{x}/{y}.pbf` template comes back as
 * `%7Bz%7D/%7Bx%7D/%7By%7D.pbf` and every tile request 404s. The map would go blank with no error
 * that names the cause.
 *
 * **A relative one has its braces put back** after resolution, for the same reason.
 */
function absolutise<T>(style: T, base: string, rewriting = false): T {
  if (typeof style === 'string') {
    if (!rewriting) return style;
    if (/^[a-z][a-z\d+.-]*:/i.test(style)) return style;
    try {
      return new URL(style, base).toString()
        .replaceAll('%7B', '{')
        .replaceAll('%7D', '}') as unknown as T;
    } catch {
      return style;
    }
  }
  if (Array.isArray(style)) {
    return style.map((item) => absolutise(item, base, rewriting)) as unknown as T;
  }

  if (typeof style === 'object' && style !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(style)) {
      out[key] = absolutise(value, base, rewriting || URL_KEYS.has(key));
    }
    return out as unknown as T;
  }
  return style;
}

export interface TileCacheStats {
  readonly entries: number;
  /** Approximate bytes, from the browser's own estimate where it gives one. */
  readonly bytes: number;
}

function caches_(): CacheStorage | undefined {
  return typeof caches === 'undefined' ? undefined : caches;
}

/**
 * Serve a tile from the cache, falling back to the network and storing what comes back.
 *
 * Cache-first, and deliberately: a map tile for a fixed zoom and position does not change in any
 * timescale that matters here, and going to the network first would make the cache pointless for
 * the case it exists for — a slow or absent connection.
 *
 * Failures return the network's own error rather than an empty tile. A blank square is
 * indistinguishable from sea, and a map that silently draws the wrong thing is worse than one that
 * visibly fails to draw.
 */
export async function loadTile(
  url: string,
  signal?: AbortSignal,
): Promise<{ data: ArrayBuffer }> {
  const store = caches_();
  const cache = store ? await store.open(TILE_CACHE) : undefined;

  const hit = await cache?.match(url);
  if (hit) return { data: await hit.arrayBuffer() };

  const response = await fetch(url, { ...(signal ? { signal } : {}) });
  if (!response.ok) {
    throw new Error(`tile request failed: ${response.status}`);
  }

  // Stored before the body is read, because a Response body can only be consumed once — `put`
  // takes the clone and the caller gets the original.
  if (cache) {
    try {
      await cache.put(url, response.clone());
    } catch {
      // Quota, or a response the cache refuses (an opaque cross-origin one). The map still works;
      // only the offline case is poorer.
    }
  }

  return { data: await response.arrayBuffer() };
}

/**
 * Register the protocol with MapLibre. Idempotent.
 *
 * Takes the module rather than importing it, so this file stays testable and MapLibre stays out of
 * anything that does not need a WebGL context.
 */
export function registerTileProtocol(maplibre: {
  addProtocol: (
    scheme: string,
    handler: (params: { url: string }, abort?: AbortController) => Promise<{ data: ArrayBuffer }>,
  ) => void;
}): void {
  if (registered) return;
  registered = true;

  maplibre.addProtocol(TILE_PROTOCOL, (params, abort) =>
    loadTile(realUrl(params.url), abort?.signal));
}

let registered = false;

/** How much is stored, for a control that offers to clear it. */
export async function tileCacheStats(): Promise<TileCacheStats> {
  const store = caches_();
  if (!store) return { entries: 0, bytes: 0 };

  try {
    const cache = await store.open(TILE_CACHE);
    const keys = await cache.keys();

    /*
     * Summed from the responses rather than from `navigator.storage.estimate()`.
     *
     * The estimate covers *everything* the origin has stored — the 24MB WASM, the app shell, the
     * remembered folders — so reporting it beside a "clear map tiles" button would offer to free
     * ten times what clearing actually frees.
     */
    let bytes = 0;
    for (const key of keys) {
      const response = await cache.match(key);
      const length = response?.headers.get('content-length');
      if (length) bytes += Number(length) || 0;
      else if (response) bytes += (await response.clone().arrayBuffer()).byteLength;
    }

    return { entries: keys.length, bytes };
  } catch {
    return { entries: 0, bytes: 0 };
  }
}

export async function clearTileCache(): Promise<void> {
  try {
    await caches_()?.delete(TILE_CACHE);
  } catch {
    // Nothing depends on it having worked.
  }
}
