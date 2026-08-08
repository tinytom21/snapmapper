/**
 * The GPS track panel: load a GPX file, then let it place the photographs.
 *
 * This is the second half of the camera clock, and the two are useless apart. A track says where
 * you were at a given instant; `clock-sync.ts` says what the camera's timestamps actually mean.
 * Match on an uncorrected clock and every photograph lands somewhere plausible and wrong, so this
 * panel says what clock it is about to use and links back to the one that sets it.
 *
 * The file arrives through a plain `<input type="file">` rather than `showOpenFilePicker`. A GPX
 * file is read once and never written, so nothing here needs the File System Access API — which
 * means this works in browsers where the rest of the app does not, and, more usefully, that the
 * input's own click is the user gesture, with no chance of repeating the picker-gesture bug that
 * the destination bar exists to avoid.
 */

import { useRef, useState } from 'react';

import {
  DEFAULT_TOLERANCE_SECONDS,
  readTrackFile,
  toGpx,
  trackSpan,
  type GpxTrack,
  type Session,
  type TrackApplyOptions,
  type TrackPlacement,
  type TrackSkip,
} from '@snapmapper/core';

import type { TrackSearchProgress } from './track-search.ts';

export interface TrackPanelProps {
  readonly session: Session;
  readonly track: GpxTrack | null;
  /** The file's name, for saying which track is loaded when the GPX carries no `<name>`. */
  readonly trackFile: string | null;
  readonly onTrack: (track: GpxTrack, fileName: string) => void;
  readonly onClearTrack: () => void;
  readonly onMatch: (options: TrackApplyOptions) => {
    readonly placed: readonly TrackPlacement[];
    readonly skipped: readonly TrackSkip[];
  };
  readonly busy: boolean;

  /**
   * The remembered track folder and how to search it. Absent where folders cannot be remembered.
   *
   * Passed as one object rather than six props because the panel treats it as one feature: either
   * there is an automatic route to a track or there is not.
   */
  readonly folder: TrackFolderProps;
}

/** The automatic half: a folder remembered once, searched by date whenever photos are open. */
export interface TrackFolderProps {
  readonly name: string | null;
  /** The folder came back from storage but the browser wants the grant confirmed. */
  readonly needsPermission: boolean;
  readonly searching: TrackSearchProgress | null;
  /** What the last search found. Kept in the app, because a search survives closing the panel. */
  readonly lastSearch: TrackSearchOutcome | null;
  readonly onChoose: () => void;
  readonly onReconnect: () => void;
  readonly onForget: () => void;
  readonly onSearch: () => void;
}

/** What a folder search came to, in terms the panel can phrase. */
export interface TrackSearchOutcome {
  readonly kind: 'loaded' | 'nothing' | 'no-dates' | 'error';
  readonly files: readonly string[];
  readonly considered: number;
  readonly message?: string;
  readonly nearestDays?: number;
}

interface MatchResult {
  readonly placed: readonly TrackPlacement[];
  readonly skipped: readonly TrackSkip[];
  readonly scope: 'all' | 'selected';
}

export function TrackPanel({
  session, track, trackFile, onTrack, onClearTrack, onMatch, busy, folder,
}: TrackPanelProps) {
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<MatchResult | null>(null);

  const [toleranceSeconds, setToleranceSeconds] = useState(DEFAULT_TOLERANCE_SECONDS);
  const [interpolate, setInterpolate] = useState(true);
  const [replaceExisting, setReplaceExisting] = useState(false);

  const selected = session.selected.size;

  async function load(file: File) {
    setProblem(null);
    setResult(null);
    try {
      onTrack(readTrackFile(await file.text()).track, file.name);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function match(scope: 'all' | 'selected') {
    const outcome = onMatch({
      toleranceSeconds,
      interpolate,
      replaceExisting,
      ...(scope === 'selected' ? { names: [...session.selected] } : {}),
    });
    setResult({ ...outcome, scope });
  }

  return (
    <div className="panel-body">
      <input
        ref={input}
        type="file"
        accept=".gpx,.json,application/gpx+xml,application/json,text/xml"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void load(file);
          // Cleared so choosing the same file twice fires a change event — after a failed parse,
          // re-picking the file you just fixed is the obvious thing to try.
          event.target.value = '';
        }}
      />

      <TrackFolderBar {...folder} busy={busy} />

      {!track && !folder.name && (
        <p className="note">
          A <strong>.gpx</strong> from a logger app, or a <strong>Google Timeline</strong> export.
          Timeline needs nothing running on the day, but it is inferred rather than logged and much
          less precise — the panel says what each track is made of.
        </p>
      )}

      <div className="row">
        <button type="button" onClick={() => input.current?.click()} disabled={busy}>
          {track ? 'Load a different track…' : 'Load a track…'}
        </button>
        {track && (
          <button type="button" onClick={() => { onClearTrack(); setResult(null); }}>
            Remove
          </button>
        )}
      </div>

      {problem && <p className="note error">{problem}</p>}

      {track && (
        <>
          <TrackSummary track={track} fileName={trackFile} />

          {/*
            The clock, restated where the decision is made. Somebody reaching for a track has not
            necessarily been through the Camera clock section, and a match against an unmeasured
            clock is the one failure here that leaves no trace.
          */}
          <p className={`note${unsetClock(session) ? ' error' : ''}`}>
            Matching against <strong>{session.clock.timeZone}</strong>
            {session.clock.offsetSeconds === 0
              ? ', with no camera drift set'
              : `, camera ${Math.abs(session.clock.offsetSeconds)}s `
                + `${session.clock.offsetSeconds > 0 ? 'fast' : 'slow'}`}
            {session.sync ? ' (measured).' : ' (typed in).'}
            {/*
              The nudge appears only when there is genuinely nothing set. Repeating it beside a
              drift somebody has already entered reads as the app not having noticed, which is how
              a warning stops being read at all.
            */}
            {unsetClock(session)
              && ' A track match is only as good as the clock — set them in Camera clock first.'}
          </p>

          <details className="manual">
            <summary>Matching options</summary>

            <label>
              Accept a fix up to (seconds) away
              <input
                type="number"
                min={1}
                value={toleranceSeconds}
                onChange={(event) =>
                  setToleranceSeconds(Math.max(1, Number(event.target.value) || 1))}
              />
            </label>
            <p className="note">
              Beyond this a photo is left alone rather than placed from a fix that may be nowhere
              near it. Anything skipped reports how far the nearest fix was, so you can tell
              whether raising this would be reasonable.
            </p>

            <label className="check">
              <input
                type="checkbox"
                checked={interpolate}
                onChange={(event) => setInterpolate(event.target.checked)}
              />
              Interpolate between the fixes either side
            </label>

            <label className="check">
              <input
                type="checkbox"
                checked={replaceExisting}
                onChange={(event) => setReplaceExisting(event.target.checked)}
              />
              Replace locations that are already set
            </label>
          </details>

          <div className="row">
            <button type="button" className="primary" onClick={() => match('all')} disabled={busy}>
              Match all photos
            </button>
            <button
              type="button"
              onClick={() => match('selected')}
              disabled={busy || selected === 0}
            >
              Match selected {selected || ''}
            </button>
          </div>

          {result && <MatchReport result={result} />}
        </>
      )}
    </div>
  );
}

/**
 * The remembered track folder, and the automatic search over it.
 *
 * This is the whole point of the folder feature: chosen once per device, and from then on the
 * question "which file covers these photographs" is answered by the photographs. The manual
 * picker below stays, because a track that arrived by email is not in the logger's folder.
 */
function TrackFolderBar({
  name, needsPermission, searching, lastSearch, onChoose, onReconnect, onForget, onSearch, busy,
}: TrackFolderProps & { busy: boolean }) {
  if (!name) {
    return (
      <div className="note">
        <button type="button" className="link" onClick={onChoose} disabled={busy}>
          Choose the folder your logger writes to…
        </button>
        {' '}— remembered on this device, so the right track is then found by date on its own.
      </div>
    );
  }

  return (
    <div className="track-folder">
      <div className="note">
        Tracks from <code>{name}</code>
        {' · '}
        <button type="button" className="link" onClick={onForget} disabled={busy}>forget</button>
      </div>

      {needsPermission
        ? (
          /*
           * Chrome drops the permission when the tab closes, and `requestPermission` only works
           * inside a user gesture — so this button *is* the gesture. Saying "reconnect" rather
           * than re-asking for the folder matters: the app has not forgotten it, and making
           * somebody navigate a picker again would suggest otherwise.
           */
          <div className="row">
            <button type="button" onClick={onReconnect} disabled={busy}>
              Reconnect the track folder
            </button>
          </div>
        )
        : (
          <div className="row">
            <button type="button" onClick={onSearch} disabled={busy || searching !== null}>
              {searching
                ? `Reading tracks ${searching.read}/${searching.total}…`
                : 'Find the track for these photos'}
            </button>
          </div>
        )}

      {lastSearch && <SearchReport result={lastSearch} />}
    </div>
  );
}

function SearchReport({ result }: { result: TrackSearchOutcome }) {
  if (result.kind === 'loaded') {
    return (
      <p className="note">
        Using {result.files.length === 1 ? result.files[0] : `${result.files.length} files`}
        {result.files.length > 1 && ` (${result.files.join(', ')})`}
        {' '}out of {result.considered}.
      </p>
    );
  }

  if (result.kind === 'no-dates') {
    return <p className="note error">None of these photos has a readable date to search by.</p>;
  }

  if (result.kind === 'error') {
    return <p className="note error">{result.message}</p>;
  }

  return (
    <p className="note error">
      No track covers these photographs, out of {result.considered} in the folder.
      {result.nearestDays !== undefined && (
        ` The closest is ${result.nearestDays === 0 ? 'less than a day' : `${result.nearestDays} day${result.nearestDays === 1 ? '' : 's'}`} away, `
        + 'so the logger was probably not running.'
      )}
    </p>
  );
}

/**
 * The track in one line, for the collapsed accordion header.
 *
 * Which file and how long it covers — the two things that answer "is the right track loaded",
 * which is the question you would otherwise open the section to ask.
 */
export function describeTrack(track: GpxTrack | null, fileName: string | null): string {
  if (!track) return 'none loaded';

  const span = trackSpan(track);
  const day = span ? span.from.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
  return `${track.name ?? fileName ?? 'track'} · ${track.points.length} fixes${day ? ` · ${day}` : ''}`;
}

function TrackSummary({ track, fileName }: { track: GpxTrack; fileName: string | null }) {
  const span = trackSpan(track);
  // Notes are only produced by a conversion, so their presence is the signal — no second flag to
  // thread through and keep in step with the first.
  const isConverted = (track.notes ?? []).length > 0;

  return (
    <div className="banner ok inline">
      <strong>{track.name ?? fileName ?? 'Track'}</strong>
      <div className="note">
        {track.points.length.toLocaleString()} fixes
        {span && (
          <>
            {' · '}
            {/*
              Local time, explicitly labelled. The file holds UTC and the photographs hold a
              wall-clock reading, so an unlabelled time here would be a third convention to guess
              between — and "does this track cover that afternoon" is a question people answer in
              the time they remember, not in UTC.
            */}
            {formatLocal(span.from)} to {formatLocal(span.to)} local
          </>
        )}
      </div>
      {track.untimed > 0 && (
        <div className="note">
          {track.untimed} point(s) carry no time and were ignored — they cannot be matched to
          anything.
        </div>
      )}

      {/*
        What the track is made of, when that varies. A Google Timeline export mixes real GPS fixes
        with a road-snapped path and inferred visits, and which one a photograph matched is the
        difference between ten metres and a hundred. The converter counts them; this says so.
      */}
      {(track.notes ?? []).map((note) => <div key={note} className="note">{note}</div>)}

      {/*
        Only offered for a converted track, because for a GPX it would hand back the file you just
        opened. Worth having for Timeline: the export is a format only Google reads, covers years,
        and has already changed twice — a GPX of the one day is small, portable and stable.
      */}
      {isConverted && <SaveAsGpx track={track} />}
    </div>
  );
}

/**
 * Keep the converted track as a GPX.
 *
 * An object URL and a synthetic click, not the File System Access API. This is a download rather
 * than a managed write — it wants the browser's own "where do you want this" behaviour, it needs no
 * permission grant, and it works in browsers where the rest of the app does not.
 */
function SaveAsGpx({ track }: { track: GpxTrack }) {
  const [saved, setSaved] = useState(false);

  function save() {
    const span = trackSpan(track);
    // Named for the day it covers, because a folder of files called `track.gpx` is a folder of
    // files nobody can tell apart.
    const day = span ? span.from.toISOString().slice(0, 10) : 'track';
    const blob = new Blob([toGpx(track, `${track.name ?? 'Track'} ${day}`)], {
      type: 'application/gpx+xml',
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `snapmapper-${day}.gpx`;
    link.click();
    // Revoked on the next tick: revoking synchronously can beat the download starting.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setSaved(true);
  }

  return (
    <div className="row">
      <button type="button" className="link" onClick={save}>
        {saved ? 'Saved as GPX — save again' : 'Save this as a GPX file'}
      </button>
    </div>
  );
}

function MatchReport({ result }: { result: MatchResult }) {
  const { placed, skipped } = result;
  const interpolated = placed.filter((one) => one.interpolated).length;

  // Grouped by reason, because a list of forty filenames each saying "no fix" is not a report.
  const noFix = skipped.filter((one) => one.reason === 'no-fix');
  const alreadyPlaced = skipped.filter((one) => one.reason === 'already-placed').length;
  const noDate = skipped.filter((one) => one.reason === 'no-date').length;
  const unreadable = skipped.filter((one) => one.reason === 'unreadable').length;

  return (
    <div className={`banner ${placed.length > 0 ? 'ok' : 'warn'} inline`}>
      <strong>
        Placed {placed.length} of {placed.length + skipped.length}
        {result.scope === 'selected' ? ' selected' : ''}
      </strong>

      {placed.length > 0 && (
        <div className="note">
          {interpolated > 0 && `${interpolated} interpolated between fixes. `}
          Nothing is written yet — check them on the map, then Save.
        </div>
      )}

      {noFix.length > 0 && (
        <div className="note">
          {noFix.length} had no fix close enough; the nearest was{' '}
          {describeGap(Math.min(...noFix.map((one) =>
            (one.reason === 'no-fix' ? one.gapSeconds : Infinity))))} away.
          {' '}Raise the tolerance if that sounds reasonable for this track.
        </div>
      )}
      {alreadyPlaced > 0 && (
        <div className="note">
          {alreadyPlaced} already had a location and were left alone. Tick{' '}
          <em>Replace locations that are already set</em> to overwrite them.
        </div>
      )}
      {noDate > 0 && (
        <div className="note">
          {noDate} {noDate === 1 ? 'has' : 'have'} no readable date to match on.
        </div>
      )}
      {unreadable > 0 && <div className="note">{unreadable} could not be read at all.</div>}
    </div>
  );
}

/**
 * Whether nothing has been done about the camera clock at all.
 *
 * A drift of zero with no measurement is the default a fresh session starts with, so it means "not
 * looked at" rather than "checked and found correct". A camera that has genuinely never drifted is
 * indistinguishable from that, and saying so costs nothing — the measurement takes one photograph.
 */
function unsetClock(session: Session): boolean {
  return session.clock.offsetSeconds === 0 && !session.sync;
}

/** `95s`, `4 min`, `3 h` — a duration at the precision anybody would actually say it in. */
function describeGap(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'nowhere near';
  if (seconds < 120) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 360) / 10} h`;
}

function formatLocal(instant: Date): string {
  return instant.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
