/**
 * The photos: what is open, what is selected, and where each one is.
 *
 * Two views, because there are two things people do here. **List** is for reading — filenames,
 * times, coordinates, what is staged. **Grid** is for looking, to find the frames you mean; it drops
 * every word and shows pictures and tick boxes.
 *
 * Its own module because it is the part of the interface people actually look at, and because a
 * component that can be mounted on its own can be checked at a phone's width without an operating
 * system file picker in the way.
 */

import { useRef } from 'react';

import {
  instantOf,
  locationOf,
  unplacedPhotos,
  type PhotoEntry,
  type Session,
} from '@snapmapper/core';
import { GridLargeIcon, GridSmallIcon, ListIcon } from './ViewIcons.tsx';
import {
  LIST_THUMB_WIDTH,
  gridMinWidth,
  isGrid,
  type ViewMode,
} from './view-mode.ts';

/**
 * The three views, in the order they escalate: most detail to most photographs.
 *
 * A table rather than three hand-written buttons, so a mode cannot end up with an icon and no
 * name — which for an icon-only control is the difference between a button and a mystery.
 */
const VIEW_BUTTONS: readonly {
  readonly mode: ViewMode;
  readonly label: string;
  readonly Glyph: () => React.ReactElement;
}[] = [
  { mode: 'list', label: 'List, with dates and coordinates', Glyph: ListIcon },
  { mode: 'grid-small', label: 'Small grid', Glyph: GridSmallIcon },
  { mode: 'grid-large', label: 'Large grid', Glyph: GridLargeIcon },
];

export interface PhotoListProps {
  readonly session: Session;
  readonly thumbnails: Map<string, string>;
  readonly view: ViewMode;
  readonly onView: (view: ViewMode) => void;
  readonly onToggle: (name: string) => void;
  readonly onPreview: (name: string) => void;
  readonly onSelectOnly: (name: string) => void;
  readonly onSelectRange: (from: string, to: string, add: boolean) => void;
  readonly onSelectAll: () => void;
  readonly onSelectNone: () => void;
  readonly onSelectUnplaced: () => void;
  readonly onClear: () => void;
  readonly onRevert: () => void;
}

export function PhotoList(props: PhotoListProps) {
  const { session, view } = props;
  const selectedCount = session.selected.size;
  const unplacedCount = unplacedPhotos(session).length;
  const grid = isGrid(view);

  /** Where the last plain click landed, so shift-click has something to extend from. */
  const anchor = useRef<string | null>(null);

  /*
   * Selection, identically in both views.
   *
   * One handler rather than one per view: shift-ranges and ctrl-toggles are the fiddly part, and two
   * copies would drift. The grid's tiles and the list's rows both call exactly this.
   */
  const onPick = (name: string, event: React.MouseEvent) => {
    if (event.shiftKey && anchor.current) {
      props.onSelectRange(anchor.current, name, event.ctrlKey || event.metaKey);
      return;
    }
    anchor.current = name;
    if (event.ctrlKey || event.metaKey) props.onToggle(name);
    else props.onSelectOnly(name);
  };

  /*
   * No heading of its own: the accordion's header carries the name and the count, and two of them
   * would be one too many. This returns the section's contents and lets the section be the box.
   */
  return (
    <>
      {/*
        One button per view, which is three rather than the four it used to take.

        With words, `Small` and `Large` had to stay hidden until you were already in the grid —
        they meant nothing on their own, so they needed `Grid` next to them to be read at all. That
        also meant the row changed length as you used it, shifting everything below it.

        Drawn, the size *is* the label: nine squares against four needs no `Grid` to explain it. So
        the separate Grid button had nothing left to do, and the three modes are now three
        buttons — always the same three, in the same places.
      */}
      <div className="row views" role="group" aria-label="How to show the photos">
        {VIEW_BUTTONS.map(({ mode, label, Glyph }) => (
          <button
            key={mode}
            type="button"
            className={`icon-only ${view === mode ? 'chosen' : ''}`}
            aria-pressed={view === mode}
            // The name the icon no longer carries. `title` for a mouse, `aria-label` for everything
            // else — an icon button with neither is a button nobody can name.
            aria-label={label}
            title={label}
            onClick={() => props.onView(mode)}
          >
            <Glyph />
          </button>
        ))}
      </div>

      <div className="row">
        <button type="button" onClick={props.onSelectAll}>All</button>
        {/*
          The set left over after a track match, which is the whole reason this is here: 38 of 45
          placed leaves seven scattered through a list of forty-five, and finding those by eye is
          the tedious part of an otherwise automatic job. Hidden when there are none, because then
          it is a button that does nothing and its absence is the good news.
        */}
        {unplacedCount > 0 && (
          <button
            type="button"
            onClick={props.onSelectUnplaced}
            title={`Select the ${unplacedCount} photo(s) with no location yet`}
          >
            Unplaced {unplacedCount}
          </button>
        )}
        <button type="button" onClick={props.onSelectNone} disabled={selectedCount === 0}>
          None
        </button>
        <button type="button" onClick={props.onClear} disabled={selectedCount === 0}>
          Clear location
        </button>
        <button type="button" onClick={props.onRevert} disabled={selectedCount === 0}>
          Revert
        </button>
      </div>

      <p className="note">
        {selectedCount === 0
          ? 'Click a photo, then click the map to place it. Shift-click for a range.'
          : `${selectedCount} selected — click the map to place ${selectedCount === 1 ? 'it' : 'them'}.`}
        {' '}Tap the corner of a photo to see it full size.
      </p>

      {grid
        ? (
          <ul
            className={`photo-grid ${view === 'grid-small' ? 'small' : 'large'}`}
            // A custom property rather than a class per size: one declaration lays the grid out, and
            // adding a size means touching only `view-mode.ts`.
            style={{ '--tile-min': `${gridMinWidth(view)}px` } as React.CSSProperties}
          >
            {session.photos.map((entry) => (
              <PhotoTile
                key={entry.ref.name}
                entry={entry}
                session={session}
                thumbnail={props.thumbnails.get(entry.ref.name)}
                onToggle={props.onToggle}
                onPreview={props.onPreview}
                onClick={(event) => onPick(entry.ref.name, event)}
              />
            ))}
          </ul>
        )
        : (
          <ul
            className="photos"
            style={{ '--thumb-w': `${LIST_THUMB_WIDTH}px` } as React.CSSProperties}
          >
            {session.photos.map((entry) => (
              <PhotoRow
                key={entry.ref.name}
                entry={entry}
                session={session}
                thumbnail={props.thumbnails.get(entry.ref.name)}
                onToggle={props.onToggle}
                onPreview={props.onPreview}
                onClick={(event) => onPick(entry.ref.name, event)}
              />
            ))}
          </ul>
        )}
    </>
  );
}

interface ItemProps {
  readonly entry: PhotoEntry;
  readonly session: Session;
  readonly thumbnail: string | undefined;
  readonly onToggle: (name: string) => void;
  readonly onPreview: (name: string) => void;
  readonly onClick: (event: React.MouseEvent) => void;
}

function PhotoRow({ entry, session, thumbnail, onToggle, onPreview, onClick }: ItemProps) {
  const location = locationOf(session, entry.ref.name);
  const selected = session.selected.has(entry.ref.name);
  const instant = instantOf(session, entry);
  const broken = entry.error !== undefined;

  return (
    <li
      className={`photo${selected ? ' selected' : ''}${broken ? ' broken' : ''}`}
      onClick={onClick}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={() => onToggle(entry.ref.name)}
        onClick={(event) => event.stopPropagation()}
        disabled={broken}
        aria-label={`Select ${entry.ref.name}`}
      />

      <Thumbnail entry={entry} thumbnail={thumbnail} onPreview={onPreview} />

      <div className="details">
        <span className="name">{entry.ref.name}</span>
        <div className="meta">
          {broken
            ? <span className="error">unreadable — {entry.error}</span>
            : (
              <>
                <span>
                  {instant
                    ? `${instant.toISOString().replace('T', ' ').slice(0, 19)}Z`
                    : 'no date'}
                </span>
                <LocationLabel location={location} />
              </>
            )}
        </div>
      </div>
    </li>
  );
}

/**
 * A photograph and a tick box. No words at all.
 *
 * One deliberate exception to "no text": a small dot when the photo has a location, amber when that
 * location is staged rather than written. It is not text, and it is the single thing here you cannot
 * recover by looking at the picture — without it there is no way to tell what is already placed,
 * which is exactly what you are working out while placing things.
 */
function PhotoTile({ entry, session, thumbnail, onToggle, onPreview, onClick }: ItemProps) {
  const location = locationOf(session, entry.ref.name);
  const selected = session.selected.has(entry.ref.name);
  const broken = entry.error !== undefined;

  const placed = location.kind === 'saved' || location.kind === 'pending';
  const staged = location.kind === 'pending' || location.kind === 'pending-clear';

  return (
    // The filename lives in `title` rather than on screen: available when wanted, silent otherwise.
    <li
      className={`tile${selected ? ' selected' : ''}${broken ? ' broken' : ''}`}
      onClick={onClick}
      title={entry.ref.name}
    >
      {thumbnail
        ? <img src={thumbnail} alt={entry.ref.name} draggable={false} loading="lazy" />
        : <span className="tile-blank" aria-hidden="true" />}

      <input
        type="checkbox"
        checked={selected}
        onChange={() => onToggle(entry.ref.name)}
        onClick={(event) => event.stopPropagation()}
        disabled={broken}
        aria-label={`Select ${entry.ref.name}`}
      />

      {(placed || staged) && (
        <span
          className={`tile-dot${staged ? ' staged' : ''}`}
          title={staged ? 'unsaved change' : 'has a location'}
        />
      )}

      <button
        type="button"
        className="tile-zoom"
        title={`See ${entry.ref.name} full size`}
        aria-label={`See ${entry.ref.name} full size`}
        onClick={(event) => {
          event.stopPropagation();
          onPreview(entry.ref.name);
        }}
      >
        ⤢
      </button>
    </li>
  );
}

/**
 * The list's thumbnail, which is a button.
 *
 * Even 160px is not always enough to be certain of a frame, and this is the affordance that behaves
 * the same under a mouse and a thumb — a magnifier revealed on hover would be invisible on a phone.
 * `stopPropagation` keeps it from also selecting the row.
 *
 * `draggable={false}` matters even though nothing here handles a drag: browsers make images
 * draggable by default, so without it a click-and-drag starts a native image drag with a ghost
 * image, which looks like the interface misbehaving.
 */
function Thumbnail({
  entry,
  thumbnail,
  onPreview,
}: Pick<ItemProps, 'entry' | 'thumbnail' | 'onPreview'>) {
  return (
    <button
      type="button"
      className="thumb-button"
      title={`See ${entry.ref.name} full size`}
      aria-label={`See ${entry.ref.name} full size`}
      onClick={(event) => {
        event.stopPropagation();
        onPreview(entry.ref.name);
      }}
    >
      {thumbnail
        ? <img className="thumb" src={thumbnail} alt="" draggable={false} loading="lazy" />
        : <span className="thumb placeholder" aria-hidden="true" />}
      <span className="thumb-zoom" aria-hidden="true">⤢</span>
    </button>
  );
}

function LocationLabel({ location }: { location: ReturnType<typeof locationOf> }) {
  if (location.kind === 'none') return <span className="dim">no location</span>;
  if (location.kind === 'pending-clear') {
    return <span className="pendingText">location will be removed</span>;
  }

  const { latitude, longitude } = location.coordinates;
  const text = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;

  return location.kind === 'pending'
    ? <span className="pendingText">{text} (unsaved)</span>
    : <span>{text}</span>;
}
