/**
 * The photo list: what is open, what is selected, and what each photo's location is.
 *
 * Its own module because it is the part of the interface people actually look at, and because a
 * component that can be mounted on its own can be checked at a phone's width without an
 * operating system file picker in the way.
 */

import { useRef } from 'react';

import {
  instantOf,
  locationOf,
  type PhotoEntry,
  type Session,
} from '@snapmapper/core';

export function PhotoList({
  session,
  thumbnails,
  onToggle,
  onSelectOnly,
  onSelectRange,
  onSelectAll,
  onSelectNone,
  onClear,
  onRevert,
}: {
  session: Session;
  thumbnails: Map<string, string>;
  onToggle: (name: string) => void;
  onSelectOnly: (name: string) => void;
  onSelectRange: (from: string, to: string, add: boolean) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onClear: () => void;
  onRevert: () => void;
}) {
  const selectedCount = session.selected.size;

  /** Where the last plain click landed, so shift-click has something to extend from. */
  const anchor = useRef<string | null>(null);

  return (
    <section className="panel grow">
      <h2>
        Photos <span className="count">{session.photos.length}</span>
      </h2>

      <div className="row">
        <button type="button" onClick={onSelectAll}>All</button>
        <button type="button" onClick={onSelectNone} disabled={selectedCount === 0}>None</button>
        <button type="button" onClick={onClear} disabled={selectedCount === 0}>
          Clear location
        </button>
        <button type="button" onClick={onRevert} disabled={selectedCount === 0}>Revert</button>
      </div>

      <p className="note">
        {selectedCount === 0
          ? 'Click a photo, then click the map to place it. Shift-click for a range.'
          : `${selectedCount} selected — click the map to place ${selectedCount === 1 ? 'it' : 'them'}.`}
      </p>

      <ul className="photos">
        {session.photos.map((entry) => (
          <PhotoRow
            key={entry.ref.name}
            entry={entry}
            session={session}
            thumbnail={thumbnails.get(entry.ref.name)}
            onToggle={onToggle}
            onClick={(event) => {
              if (event.shiftKey && anchor.current) {
                onSelectRange(anchor.current, entry.ref.name, event.ctrlKey || event.metaKey);
                return;
              }
              anchor.current = entry.ref.name;
              if (event.ctrlKey || event.metaKey) onToggle(entry.ref.name);
              else onSelectOnly(entry.ref.name);
            }}
          />
        ))}
      </ul>
    </section>
  );
}

function PhotoRow({
  entry,
  session,
  thumbnail,
  onToggle,
  onClick,
}: {
  entry: PhotoEntry;
  session: Session;
  thumbnail: string | undefined;
  onToggle: (name: string) => void;
  onClick: (event: React.MouseEvent) => void;
}) {
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

      {/*
        draggable={false} matters even though nothing here handles a drag: browsers make
        images draggable by default, so without it a click-and-drag on a thumbnail starts a
        native image drag with a ghost image, which looks like the interface misbehaving.
      */}
      {thumbnail
        ? <img className="thumb" src={thumbnail} alt="" draggable={false} loading="lazy" />
        : <span className="thumb placeholder" aria-hidden="true" />}

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
