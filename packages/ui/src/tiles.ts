/**
 * Where the map's tiles come from.
 *
 * ## Why vector, now
 *
 * The MVP used raster OSM tiles, on the reasoning that a vector style needs an API key and this
 * should run for anyone who clones the repository. That was right about the key and wrong about
 * the outcome on a phone: a raster tile is a **256px bitmap sized for a 96dpi monitor**, and a
 * modern phone has a device pixel ratio of 3. Every label was being upscaled threefold — hence
 * "slightly blurry, as though it were called for a different pixel density", which is exactly
 * what was happening. The same arithmetic is why so few placenames fit: at 3x you are looking at
 * a third of the map area a desktop would show at that zoom.
 *
 * Vector tiles fix both. Labels are glyphs rendered by the GPU at the device's real resolution,
 * so they are crisp at any ratio, and the styles carry far more names than the raster rendering.
 *
 * ## Why OpenFreeMap
 *
 * No API key, no registration, no request limit — the one property that made raster attractive in
 * the first place, without the cost. It is donation-funded with no uptime guarantee, so the raster
 * style stays as a fallback and `PhotoMap` switches to it if the style fails to load. A map that
 * is briefly ugly beats a map that is briefly absent.
 *
 * ## What this does not fix
 *
 * Offline. MapLibre fetches tiles inside a worker it creates from a `blob:` URL, so the service
 * worker cannot see those requests either way — see `sw-template.js`. The plan's answer for
 * offline remains PMTiles, and this seam is where it would go.
 */

import type { StyleSpecification } from 'maplibre-gl';

/**
 * Positron: quiet greys and greens, which is the point.
 *
 * The photographs are the colourful thing on this screen and the pins have to be findable against
 * whatever is underneath them. Liberty and Bright are livelier and fight both.
 */
export const VECTOR_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

/**
 * The fallback, used only if the vector style will not load.
 *
 * Deliberately the same raster source the app shipped with: no key, and a tile server that has
 * been up since 2004. `tileSize: 256` is honest here — pretending otherwise by asking for a
 * deeper zoom and packing it into fewer CSS pixels would sharpen the image at the cost of four
 * times the requests to a service whose usage policy asks precisely that you do not.
 */
export const RASTER_FALLBACK: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

/**
 * Which source to use, allowing `?tiles=raster` to force the old one.
 *
 * Not a debug leftover — a diagnostic that can be reached from a phone. If the vector map ever
 * misbehaves on a device, the difference between "the tiles are wrong" and "the app is wrong" is
 * one query parameter away, and neither a rebuild nor a console is needed to find out.
 */
export function tileChoiceFrom(search: string): 'vector' | 'raster' {
  return new URLSearchParams(search).get('tiles') === 'raster' ? 'raster' : 'vector';
}

/**
 * Credit shown whatever happens.
 *
 * The style's own attribution arrives with its TileJSON, which means it is absent while the style
 * is loading and absent entirely if the style fails. OpenStreetMap's licence does not have a
 * loading state, so this is passed to the attribution control directly.
 */
export const ATTRIBUTION = [
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">'
  + '© OpenStreetMap contributors</a>',
  '<a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a>',
].join(' · ');

/**
 * Whether a MapLibre error means the style itself could not be loaded.
 *
 * Narrow on purpose. MapLibre reports a great many things through `error` — a single tile that
 * 404s, a font that is slow, a source that hiccups — and falling back to raster on any of them
 * would throw away a working vector map because one tile was missing. Only a failure to fetch the
 * style document is unrecoverable.
 */
export function isStyleLoadFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const url = (error as { url?: unknown }).url;
  const target = typeof url === 'string' ? url : error.message;
  return target.includes(VECTOR_STYLE_URL) && !target.includes('/tiles/');
}
