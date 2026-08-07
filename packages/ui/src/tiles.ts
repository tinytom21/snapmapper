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
 * Liberty: the colourful one, chosen for landmarks.
 *
 * Positron came first, on the reasoning that the photographs should be the only colourful thing on
 * screen. In use that was the wrong trade — a grey map is harder to *recognise*, and recognising
 * where a photograph was taken is the entire task. Liberty distinguishes woodland from farmland
 * from built-up area and draws points of interest, which is what you navigate by.
 *
 * The pins stay findable against it because they are not competing on colour: they are the only
 * things on the map with a white outline and a drop shadow.
 */
export const VECTOR_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

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
 * How much earlier each kind of label should appear, in zoom levels.
 *
 * A style's label layers are gated by `minzoom`, and Liberty's are tuned for a desktop map where a
 * viewport is wide. On a phone the same zoom covers a fraction of the ground, so the labels that
 * would have oriented you are simply not drawn yet — the map is legible and anonymous.
 *
 * Places get the larger shift because names are the point. Points of interest get less, because
 * they arrive with icons and a screenful of them is clutter rather than information. Road names
 * and shields get none at all: they are dense by nature and already appear at the zoom where a
 * road is worth naming.
 */
const DENSITY_SHIFTS: readonly { readonly match: RegExp; readonly zoomShift: number }[] = [
  { match: /^label_(city|town|village|other|state)/, zoomShift: 2 },
  { match: /^(poi_|airport)/, zoomShift: 1 },
  { match: /^(water_name|waterway_line_label)/, zoomShift: 1 },
];

/**
 * Tighter label collision padding.
 *
 * MapLibre rejects a label whose box, grown by this many pixels, hits one already placed. The
 * default is 2. At 1 noticeably more labels survive without any of them touching.
 */
export const LABEL_PADDING = 1;

export interface LayerDensity {
  readonly id: string;
  /** The new `minzoom`, never below 0. */
  readonly minzoom: number;
  readonly maxzoom: number | undefined;
  readonly textPadding: number;
}

/**
 * What to change, given the style's own layers.
 *
 * Returned as data rather than applied here so it can be tested without a GPU, a network or a
 * MapLibre instance — the caller does two imperative calls per entry and nothing else.
 *
 * Only symbol layers are touched, and only those the table above names. Everything else — one-way
 * arrows, highway shields, every fill and line in the style — is left exactly as the cartographers
 * drew it.
 */
export function labelDensity(
  layers: readonly { id: string; type: string; minzoom?: number; maxzoom?: number }[],
): LayerDensity[] {
  const adjustments: LayerDensity[] = [];

  for (const layer of layers) {
    if (layer.type !== 'symbol') continue;

    const rule = DENSITY_SHIFTS.find((candidate) => candidate.match.test(layer.id));
    if (!rule) continue;

    // A layer with no `minzoom` is already drawn from zoom 0; there is nothing to bring forward,
    // but the tighter padding still applies.
    const minzoom = Math.max(0, (layer.minzoom ?? 0) - rule.zoomShift);
    adjustments.push({
      id: layer.id,
      minzoom,
      maxzoom: layer.maxzoom,
      textPadding: LABEL_PADDING,
    });
  }

  return adjustments;
}

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
