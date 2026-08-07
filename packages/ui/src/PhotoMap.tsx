/**
 * The map. MapLibre GL, one pin per located photo, click to place.
 *
 * MapLibre is imperative and React is declarative, so the map instance lives in a ref
 * and effects push state into it. Markers are reconciled against a keyed map rather than
 * torn down and rebuilt each render — rebuilding 200 DOM markers on every selection
 * change is visibly slow on a laptop and worse on a tablet.
 *
 * Tiles come from a config seam, per the plan, so the later "ship one .pmtiles file for
 * a region" story drops in without touching this component.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap, type Marker, type StyleSpecification } from 'maplibre-gl';

import type { Coordinates } from '@geotagger/core';

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
   * A thumbnail was dropped on the map. Carries the dragged photo's name and the point.
   *
   * Dropping is a separate gesture from clicking: it places the photo that was dragged,
   * regardless of what is selected, which is what makes it feel direct.
   */
  readonly onDropPhoto: (name: string, coordinates: Coordinates) => void;
}

/**
 * Raster OSM rather than a vector source, deliberately, for the MVP.
 *
 * The plan prefers vector + PMTiles, and that is still right for offline. But vector
 * styles need an API key or a self-hosted style JSON, and this MVP should run for anyone
 * who clones the repository with nothing to sign up for. One `style` constant is the
 * seam; swapping it is a one-line change.
 */
const TILE_STYLE: StyleSpecification = {
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

export function PhotoMap({
  pins, onPlace, onSelectPin, onMovePin, armed, onDropPhoto,
}: PhotoMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef(new Map<string, Marker>());

  // Handlers are read through a ref so the map's listeners never go stale, without
  // tearing the map down and rebuilding it whenever a prop identity changes.
  const handlers = useRef({ onPlace, onSelectPin, onMovePin, onDropPhoto });
  handlers.current = { onPlace, onSelectPin, onMovePin, onDropPhoto };

  useEffect(() => {
    if (!container.current || map.current) return;

    const instance = new maplibregl.Map({
      container: container.current,
      style: TILE_STYLE,
      center: [-0.0015, 51.4778],
      zoom: 3,
    });

    instance.addControl(new maplibregl.NavigationControl(), 'top-right');
    instance.addControl(new maplibregl.ScaleControl({ unit: 'metric' }));

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

  // Frame the photos once there is something to frame, so the user is not left staring
  // at the mid-Atlantic wondering where their pins went.
  const bounds = useMemo(() => boundsOf(pins), [pins]);
  const framed = useRef(false);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !bounds || framed.current) return;
    framed.current = true;
    instance.fitBounds(bounds, { padding: 80, maxZoom: 14, duration: 0 });
  }, [bounds]);

  /**
   * Turn a drop into a coordinate.
   *
   * MapLibre owns the canvas, so the pixel-to-coordinate conversion has to go through its
   * `unproject`, relative to the container's own bounding box.
   */
  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      className={`map${dragOver ? ' drag-over' : ''}`}
      ref={container}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(DRAG_MIME)) return;
        // Without this the browser refuses the drop and shows a "no entry" cursor.
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);

        const name = event.dataTransfer.getData(DRAG_MIME);
        const instance = map.current;
        if (!name || !instance || !container.current) return;

        const box = container.current.getBoundingClientRect();
        const point = instance.unproject([event.clientX - box.left, event.clientY - box.top]);
        handlers.current.onDropPhoto(name, { latitude: point.lat, longitude: point.lng });
      }}
    />
  );
}

/**
 * Custom MIME type for a dragged photo.
 *
 * Deliberately not `text/plain`: a specific type means the map only offers to accept
 * drops that are actually ours, so dragging a file or a selection over it does nothing.
 */
export const DRAG_MIME = 'application/x-geotagger-photo';

function paint(element: HTMLElement, pin: MapPin): void {
  element.classList.toggle('pin-pending', pin.pending);
  element.classList.toggle('pin-selected', pin.selected);
}

function boundsOf(pins: readonly MapPin[]): [[number, number], [number, number]] | null {
  if (pins.length === 0) return null;

  let west = 180;
  let east = -180;
  let south = 90;
  let north = -90;

  for (const pin of pins) {
    west = Math.min(west, pin.coordinates.longitude);
    east = Math.max(east, pin.coordinates.longitude);
    south = Math.min(south, pin.coordinates.latitude);
    north = Math.max(north, pin.coordinates.latitude);
  }

  return [[west, south], [east, north]];
}
