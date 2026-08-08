/**
 * Place names: turning coordinates into something you can search for.
 *
 * Coordinates make a photograph mappable. Place names make it *findable* — "everything from
 * Toulouse" is a question Lightroom, digiKam and Immich can answer from these fields and none of
 * them can answer from a latitude.
 *
 * Two things this panel has to be honest about, because both are unusual for this app:
 *
 * **It needs the network.** Everything else here works offline. Being on a train is not an error,
 * so a failure is reported as an ordinary outcome and what did resolve is kept.
 *
 * **It sends your coordinates to somebody else.** Not the photographs, and not anything that
 * identifies you — but a position, to a third party, which no other part of this app does. That is
 * said plainly before the button rather than in a footnote after it.
 */

import { useMemo, useState } from 'react';

import {
  describePlace,
  groupByPlace,
  locationOf,
  placeKey,
  type Place,
  type Session,
} from '@snapmapper/core';

import { cachedCount, type GeocodeProgress } from './nominatim.ts';

export interface PlacePanelProps {
  readonly session: Session;
  readonly busy: boolean;
  readonly progress: GeocodeProgress | null;
  /** Look up the given groups and stage what comes back. Resolves when finished or stopped. */
  readonly onGeocode: (scope: 'all' | 'selected') => void;
  readonly onStop: () => void;
  readonly lastRun: { readonly named: number; readonly failed: number } | null;
}

export function PlacePanel({
  session, busy, progress, onGeocode, onStop, lastRun,
}: PlacePanelProps) {
  const [showNamed, setShowNamed] = useState(false);

  /*
   * Everything with a position, staged or already on disk.
   *
   * Both, deliberately: a photo whose coordinates were written last week can still be given place
   * names now, and restricting this to staged edits would make that impossible to ask for.
   */
  const located = useMemo(() => session.photos.flatMap((entry) => {
    const location = locationOf(session, entry.ref.name);
    if (location.kind !== 'saved' && location.kind !== 'pending') return [];
    return [{ name: entry.ref.name, coordinates: location.coordinates }];
  }), [session]);

  const groups = useMemo(() => groupByPlace(located), [located]);
  const alreadyKnown = useMemo(
    () => cachedCount(groups.map((group) => group.key)),
    [groups],
  );

  const selectedLocated = located.filter((one) => session.selected.has(one.name));
  const named = [...session.places].filter(([, place]) => place !== null).length;
  const toAsk = groups.length - alreadyKnown;

  if (located.length === 0) {
    return (
      <div className="panel-body">
        <p className="note">
          Place a few photographs first — city and country names are looked up from their
          coordinates.
        </p>
      </div>
    );
  }

  return (
    <div className="panel-body">
      <p className="note">
        Writes <strong>City</strong>, <strong>County</strong> and <strong>Country</strong> into IPTC
        and XMP, so your library can search by place rather than only show pins on a map.
      </p>

      {/*
        The one place in this app that talks to a third party, said before the button rather than
        after it. The specific reassurance matters as much as the warning: coordinates, not
        photographs.
      */}
      <p className="note">
        This sends the <strong>coordinates</strong> — never your photographs — to OpenStreetMap's
        Nominatim, which is free and asks for no more than one lookup a second.
        {' '}{located.length} located photo{located.length === 1 ? '' : 's'} come to{' '}
        <strong>{groups.length} place{groups.length === 1 ? '' : 's'}</strong>
        {alreadyKnown > 0 && `, ${alreadyKnown} of which ${alreadyKnown === 1 ? 'is' : 'are'} already known`}
        {toAsk > 0
          ? ` — about ${toAsk === 1 ? 'a second' : `${toAsk} seconds`}.`
          : ' — nothing to ask for.'}
      </p>

      <div className="row">
        {progress
          ? (
            <>
              <button type="button" onClick={onStop}>Stop</button>
              <span className="note">
                {progress.done} of {progress.total}
                {progress.fromCache > 0 && ` · ${progress.fromCache} already known`}
              </span>
            </>
          )
          : (
            <>
              <button
                type="button"
                className="primary"
                onClick={() => onGeocode('all')}
                disabled={busy}
              >
                Name {groups.length} place{groups.length === 1 ? '' : 's'}
              </button>
              <button
                type="button"
                onClick={() => onGeocode('selected')}
                disabled={busy || selectedLocated.length === 0}
              >
                Selected {selectedLocated.length || ''}
              </button>
            </>
          )}
      </div>

      {lastRun && !progress && (
        <div className={`banner ${lastRun.failed > 0 ? 'warn' : 'ok'} inline`}>
          <strong>Named {lastRun.named} photo{lastRun.named === 1 ? '' : 's'}</strong>
          {lastRun.failed > 0 && (
            <div className="note">
              {lastRun.failed} place{lastRun.failed === 1 ? '' : 's'} could not be looked up — most
              likely no network. What did resolve is staged; try again for the rest.
            </div>
          )}
          <div className="note">Nothing is written until you press Save.</div>
        </div>
      )}

      {named > 0 && (
        <details className="manual" open={showNamed} onToggle={(e) => setShowNamed(e.currentTarget.open)}>
          <summary>What will be written ({named})</summary>
          {/* The actual strings, because a place name is a thing you either recognise or do not,
              and no summary count can tell you whether the lookup got it right. */}
          <ul className="places">
            {[...session.places].map(([name, place]) => (
              <li key={name}>
                <span className="who">{name}</span>
                <span className="what">{place ? describePlace(place) : 'no name found'}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** The section header while shut. */
export function describePlaces(session: Session): string {
  const staged = session.places.size;
  if (staged === 0) return 'none yet';

  const named = [...session.places].filter(([, place]) => place !== null).length;
  return named === staged ? `${named} named` : `${named} of ${staged} named`;
}

/** Exported for the app, which needs the same grouping to know what to ask for. */
export function locatedGroups(session: Session, onlySelected: boolean) {
  const located = session.photos.flatMap((entry) => {
    const location = locationOf(session, entry.ref.name);
    if (location.kind !== 'saved' && location.kind !== 'pending') return [];
    if (onlySelected && !session.selected.has(entry.ref.name)) return [];
    return [{ name: entry.ref.name, coordinates: location.coordinates }];
  });
  return groupByPlace(located);
}

/** Map a geocode result back onto photo names, via the position key each one shares. */
export function placesByPhoto(
  groups: readonly { readonly key: string; readonly names: readonly string[] }[],
  byKey: ReadonlyMap<string, Place>,
): Map<string, Place> {
  const found = new Map<string, Place>();
  for (const group of groups) {
    const place = byKey.get(group.key);
    if (!place) continue;
    for (const name of group.names) found.set(name, place);
  }
  return found;
}

export { placeKey };
