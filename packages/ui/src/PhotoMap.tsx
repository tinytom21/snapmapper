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
import maplibregl, { type Map as MapLibreMap, type Marker } from 'maplibre-gl';

import { boundsOf, selectionFocus } from './map-focus.ts';
import {
  ATTRIBUTION,
  RASTER_FALLBACK,
  VECTOR_STYLE_URL,
  isStyleLoadFailure,
  tileChoiceFrom,
} from './tiles.ts';
import type { Coordinates } from '@snapmapper/core';

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
}

export function PhotoMap({
  pins, onPlace, onSelectPin, onMovePin, armed, selectedCount, visible,
}: PhotoMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef(new Map<string, Marker>());

  // Handlers are read through a ref so the map's listeners never go stale, without
  // tearing the map down and rebuilding it whenever a prop identity changes.
  const handlers = useRef({ onPlace, onSelectPin, onMovePin });
  handlers.current = { onPlace, onSelectPin, onMovePin };

  useEffect(() => {
    if (!container.current || map.current) return;

    const instance = new maplibregl.Map({
      container: container.current,
      style: tileChoiceFrom(window.location.search) === 'raster'
        ? RASTER_FALLBACK
        : VECTOR_STYLE_URL,
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

    return () => {
      instance.remove();
      map.current = null;
      markers.current.clear();
    };
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

function paint(element: HTMLElement, pin: MapPin): void {
  element.classList.toggle('pin-pending', pin.pending);
  element.classList.toggle('pin-selected', pin.selected);
}
