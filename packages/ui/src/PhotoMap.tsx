/**
 * The map. MapLibre GL, one pin per located photo, click to place.
 *
 * MapLibre is imperative and React is declarative, so the map instance lives in a ref
 * and effects push state into it. Markers are reconciled against a keyed map rather than
 * torn down and rebuilt each render — rebuilding 200 DOM markers on every selection
 * change is visibly slow on a laptop and worse on a tablet.
 *
 * Tiles come from `tiles.ts`, which is the seam the plan wanted: vector tiles from OpenFreeMap,
 * with the old raster source kept as a fallback, and the place a PMTiles file would be wired in
 * for offline.
 *
 * Placement is select-then-click, and only that. Dragging a thumbnail onto the map was tried
 * and removed: an HTML5 drag over a canvas MapLibre is already tracking pointer events on
 * made the interface misbehave, and select-then-click turned out to be the better gesture
 * anyway — it handles one photo and fifty identically.
 */

import { useEffect, useMemo, useRef } from 'react';
import maplibregl, {
  type GeoJSONSource,
  type Map as MapLibreMap,
  type Marker,
} from 'maplibre-gl';
import type { Feature, LineString } from 'geojson';

import { boundsOf, selectionFocus } from './map-focus.ts';
import { trackLine, type LinePoint } from './track-line.ts';
import { offlineStyle, registerTileProtocol } from './offline-tiles.ts';
import {
  ATTRIBUTION,
  RASTER_FALLBACK,
  VECTOR_STYLE_URL,
  isStyleLoadFailure,
  labelDensity,
  tileChoiceFrom,
} from './tiles.ts';
import type { Coordinates, GpxTrack } from '@snapmapper/core';

/** Ids for the track line. Named constants because they are referenced from three effects. */
const TRACK_SOURCE = 'snapmapper-track';
const TRACK_LAYER = 'snapmapper-track-line';

export interface MapPin {
  readonly name: string;
  readonly coordinates: Coordinates;
  /** Staged edits look different from what is already on disk. */
  readonly pending: boolean;
  readonly selected: boolean;
}

export interface PhotoMapProps {
  readonly pins: readonly MapPin[];
  readonly onPlace: (coordinates: Coordinates) => void;
  readonly onSelectPin: (name: string) => void;
  readonly onMovePin: (name: string, coordinates: Coordinates) => void;
  /** True when clicking the map would assign a location. Drives the cursor. */
  readonly armed: boolean;
  /**
   * How many photos a tap would place.
   *
   * Shown over the map because on a narrow screen the list is below the fold, and "what am I
   * about to move" is the one thing you must know before tapping.
   */
  readonly selectedCount: number;
  /**
   * Whether the map is on screen.
   *
   * Load-bearing, not cosmetic. Below the breakpoint the map is hidden rather than unmounted, and
   * `fitBounds` on a `display: none` container measures a zero-sized viewport — it would compute a
   * nonsense zoom and apply it silently. So framing waits until the map can see itself.
   */
  readonly visible: boolean;
  /** Drawn as a line, so you can see whether the right track is loaded. */
  readonly track: GpxTrack | null;
}

export function PhotoMap({
  pins, onPlace, onSelectPin, onMovePin, armed, selectedCount, visible, track,
}: PhotoMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef(new Map<string, Marker>());

  // Handlers are read through a ref so the map's listeners never go stale, without
  // tearing the map down and rebuilding it whenever a prop identity changes.
  const handlers = useRef({ onPlace, onSelectPin, onMovePin });
  handlers.current = { onPlace, onSelectPin, onMovePin };

  /** The track as `[lng, lat]` pairs, held in a ref so `style.load` can redraw it. */
  const line = useRef<readonly LinePoint[]>([]);

  useEffect(() => {
    if (!container.current || map.current) return;

    /*
     * Built asynchronously, because the style has to be fetched and rewritten before the map is
     * constructed — see `offline-tiles.ts`. Handing MapLibre the plain URL and swapping the style
     * afterwards would work, but it loads the whole style twice and flashes an unstyled map on the
     * slow connections this feature is for.
     */
    let cancelled = false;
    let built: MapLibreMap | null = null;

    registerTileProtocol(maplibregl);

    void (async () => {
      const wanted = tileChoiceFrom(window.location.search) === 'raster'
        ? RASTER_FALLBACK
        : await offlineStyle(VECTOR_STYLE_URL);
      if (cancelled || !container.current) return;
      built = create(wanted);
    })();

    return () => {
      cancelled = true;
      built?.remove();
      map.current = null;
      markers.current.clear();
    };

    function create(style: unknown): MapLibreMap {
    const instance = new maplibregl.Map({
      container: container.current as HTMLDivElement,
      style: style as maplibregl.StyleSpecification,
      center: [-0.0015, 51.4778],
      zoom: 3,
      /*
       * Sharpen labels on a high-density screen.
       *
       * MapLibre renders at `devicePixelRatio` by default, which is right. This caps it at 2 on
       * the phones that report 3 or more: past 2 the difference is invisible at arm's length and
       * the GPU is filling nine times the pixels of a 1x screen, which on a mid-range phone costs
       * frames while panning. Text stays glyph-sharp either way — that is the whole point of
       * vector tiles.
       */
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    });

    instance.addControl(new maplibregl.NavigationControl(), 'top-right');
    instance.addControl(new maplibregl.ScaleControl({ unit: 'metric' }));
    // Credit that does not depend on the style having loaded. See ATTRIBUTION.
    instance.addControl(new maplibregl.AttributionControl({
      compact: true,
      customAttribution: ATTRIBUTION,
    }));

    /*
     * Fall back to raster if the vector style will not load at all.
     *
     * OpenFreeMap is donation-funded with no uptime guarantee, and a geotagging tool with no map
     * is useless in a way that a geotagging tool with an ugly map is not. Guarded so a single
     * failed tile or font cannot trigger it — see `isStyleLoadFailure`.
     */
    /*
     * Bring the labels forward once the style is in.
     *
     * Applied to the loaded style rather than by fetching and rewriting the JSON first: no extra
     * round trip, no flash of an unstyled map, and it re-applies if the style is ever swapped —
     * `style.load` fires again after `setStyle`, including the raster fallback below, where it
     * simply finds no symbol layers to adjust.
     */
    instance.on('style.load', () => {
      // A style swap wipes every source and layer the app added, so the track goes back on here
      // as well as when it changes. Without this, falling back to raster loses the line silently.
      drawTrack(instance, line.current);

      for (const layer of labelDensity(instance.getStyle().layers ?? [])) {
        instance.setLayerZoomRange(layer.id, layer.minzoom, layer.maxzoom ?? 24);
        instance.setLayoutProperty(layer.id, 'text-padding', layer.textPadding);
      }
    });

    let fellBack = false;
    instance.on('error', (event) => {
      if (fellBack || !isStyleLoadFailure(event.error)) return;
      fellBack = true;
      console.warn('snapmapper: vector tiles unavailable, falling back to raster');
      instance.setStyle(RASTER_FALLBACK);
    });

    instance.on('click', (event) => {
      handlers.current.onPlace({ latitude: event.lngLat.lat, longitude: event.lngLat.lng });
    });

    map.current = instance;
    return instance;
    }
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    instance.getCanvas().style.cursor = armed ? 'crosshair' : '';
  }, [armed]);

  // Reconcile markers: update in place, add what is new, remove what is gone.
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;

    const seen = new Set<string>();

    for (const pin of pins) {
      seen.add(pin.name);
      const existing = markers.current.get(pin.name);

      if (existing) {
        existing.setLngLat([pin.coordinates.longitude, pin.coordinates.latitude]);
        paint(existing.getElement(), pin);
        continue;
      }

      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'pin';
      element.title = pin.name;
      paint(element, pin);

      element.addEventListener('click', (event) => {
        // Without this the map's own click handler also fires and re-places the photo.
        event.stopPropagation();
        handlers.current.onSelectPin(pin.name);
      });

      const marker = new maplibregl.Marker({ element, draggable: true })
        .setLngLat([pin.coordinates.longitude, pin.coordinates.latitude])
        .addTo(instance);

      marker.on('dragend', () => {
        const { lat, lng } = marker.getLngLat();
        handlers.current.onMovePin(pin.name, { latitude: lat, longitude: lng });
      });

      markers.current.set(pin.name, marker);
    }

    for (const [name, marker] of markers.current) {
      if (!seen.has(name)) {
        marker.remove();
        markers.current.delete(name);
      }
    }
  }, [pins]);

  useEffect(() => {
    line.current = trackLine(track);
    const instance = map.current;
    // Before the style is in there is nowhere to put a layer; `style.load` draws it instead.
    if (instance?.isStyleLoaded()) drawTrack(instance, line.current);
  }, [track]);

  // A hidden map never learns it was resized, so it comes back with the container size it had
  // when it was hidden. Cheap to ask; wrong-looking if not asked.
  useEffect(() => {
    if (visible) map.current?.resize();
  }, [visible]);

  // Frame the photos once there is something to frame, so the user is not left staring
  // at the mid-Atlantic wondering where their pins went.
  const bounds = useMemo(() => boundsOf(pins), [pins]);
  const framed = useRef(false);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !bounds || framed.current || !visible) return;
    framed.current = true;
    instance.fitBounds(bounds, { padding: 80, maxZoom: 14, duration: 0 });
  }, [bounds, visible]);

  /*
   * Move to whatever is selected, when the selection changes.
   *
   * Keyed on the selected names rather than on the pins, so dragging a pin does not yank the
   * viewport back — the selection is the same, only its position moved, and fighting the drag
   * would be worse than doing nothing.
   *
   * Photos with no location contribute nothing: selecting an unplaced photo leaves the map where
   * it is, which is right, because where it is is where you are about to place them.
   */
  const focus = useMemo(() => selectionFocus(pins), [pins]);
  const focused = useRef<string | null>(null);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !focus || !visible || focused.current === focus.key) return;
    focused.current = focus.key;
    framed.current = true;

    if (focus.single) {
      // A degenerate box makes fitBounds jump to maximum zoom. Keep the scale the user chose,
      // only closer if they were looking at a whole continent.
      const [[longitude, latitude]] = focus.bounds;
      instance.easeTo({ center: [longitude, latitude], zoom: Math.max(instance.getZoom(), 13) });
      return;
    }
    instance.fitBounds(focus.bounds, { padding: 80, maxZoom: 15 });
  }, [focus, visible]);

  return (
    <div className="map-wrap">
      <div className="map" ref={container} />
      {armed && (
        <div className="map-hint">
          {selectedCount} selected — tap the map to place {selectedCount === 1 ? 'it' : 'them'}
        </div>
      )}
    </div>
  );
}

/**
 * Put the line on the map, or take it off.
 *
 * Below every symbol layer would be ideal, but the id to insert before differs by style and the
 * raster fallback has none at all. On top is the honest choice anyway: the track is a temporary
 * working overlay, not part of the map, and it is drawn translucent so the ground stays readable
 * underneath it.
 */
function drawTrack(
  instance: MapLibreMap,
  coordinates: readonly LinePoint[],
): void {
  const data: Feature<LineString> = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: coordinates.map(([lng, lat]) => [lng, lat]) },
  };

  const existing = instance.getSource(TRACK_SOURCE);
  if (existing) {
    (existing as GeoJSONSource).setData(data);
    return;
  }
  if (coordinates.length === 0) return;

  instance.addSource(TRACK_SOURCE, { type: 'geojson', data });
  instance.addLayer({
    id: TRACK_LAYER,
    type: 'line',
    source: TRACK_SOURCE,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      // The interface's accent would put the line in the same colour family as the pins, which are
      // the thing that must stand out. A track is context, so it gets its own hue and stays under
      // full opacity.
      'line-color': '#c2410c',
      'line-width': 3,
      'line-opacity': 0.65,
    },
  });
}

function paint(element: HTMLElement, pin: MapPin): void {
  element.classList.toggle('pin-pending', pin.pending);
  element.classList.toggle('pin-selected', pin.selected);
}
