/**
 * The camera-clock panel: the live QR clock, the sync result, and the manual fallback.
 *
 * Three ways to establish the camera's drift, in decreasing order of how much they can be
 * trusted:
 *
 *   1. Photograph the code below, then mark that photo as the reference. The instant is
 *      read out of the image, so nothing is transcribed and nothing can be misread
 *      silently.
 *   2. Type in a time you can read from some other clock in a photograph. The only option
 *      for a shoot that is already finished.
 *   3. Type the drift in seconds directly, if you happen to know it.
 *
 * The zone is separate from all of them, and changing it re-derives the offset from
 * whichever reference is held — which is why the reference is stored rather than just the
 * resulting seconds.
 */

import { useEffect, useMemo, useState } from 'react';

import {
  isValidTimeZone,
  type ClockSync,
  type NaiveDateTime,
  type PhotoEntry,
  type Session,
} from '@snapmapper/core';

import { QrClock } from './QrClock.tsx';

export interface ClockPanelProps {
  readonly session: Session;
  readonly onTimeZone: (timeZone: string) => void;
  readonly onOffsetSeconds: (offsetSeconds: number) => void;
  readonly onSync: (sync: ClockSync) => void;
  readonly onClearSync: () => void;
  /** Reads the reference photo and looks for the clock code. */
  readonly onScanReference: (name: string) => Promise<string | null>;
  /**
   * How to bring the reference frame in, which differs by how the session was opened.
   *
   * A picked selection has no folder to re-scan, so the reference photo is added with the file
   * picker instead. Naming the actual button avoids instructions that do not match the screen.
   */
  readonly addPhotosLabel: string;
  readonly busy: boolean;
}

export function ClockPanel({
  session,
  addPhotosLabel,
  onTimeZone,
  onOffsetSeconds,
  onSync,
  onClearSync,
  onScanReference,
  busy,
}: ClockPanelProps) {
  const [showClock, setShowClock] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const selected = useMemo(
    () => session.photos.filter((entry) => session.selected.has(entry.ref.name)),
    [session],
  );
  const reference = selected.length === 1 ? selected[0] : undefined;

  async function scan(entry: PhotoEntry) {
    setScanError(null);
    setScanning(true);
    try {
      const failure = await onScanReference(entry.ref.name);
      if (failure) setScanError(failure);
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="panel-body">
      <p className="note">
        GPS timestamps are written in UTC, so the drift and the zone both matter. Getting
        the zone wrong shifts every timestamp by hours.
      </p>

      <SyncStatus session={session} onClearSync={onClearSync} />

      {/*
        Reading the photograph is the *default* now, and this panel used to assume the opposite.
        It opened with "Photograph this code with the camera" and hid the button behind a toggle —
        which made sense when the code lived only here, and stopped making sense the moment it
        moved to the start screen. By the time anybody reaches this panel the photograph has almost
        certainly been taken and the card is in the reader; the only thing left to do is point at
        the frame. So that is the step this leads with, and the code itself is now the fallback.
      */}
      <p className="note">
        Select the photo you took of the code on the start screen, then press the button.
        The exact time is read out of the image, so nothing is typed and nothing can be misread.
      </p>

      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={!reference || busy || scanning}
          onClick={() => reference && scan(reference)}
        >
          {scanning ? 'Reading…' : 'Read clock from photo'}
        </button>
      </div>

      <p className="note">
        {selected.length === 0
          ? 'Select that one photo in the list above.'
          : selected.length > 1
            ? `${selected.length} photos selected — select exactly one.`
            : `Reference: ${reference?.ref.name}`}
      </p>

      {scanError && <p className="note error">{scanError}</p>}

      {/*
        The fallback, for somebody who did not photograph the code on the way in. It costs a round
        trip of the card — out of the reader, into the camera, and back — which is exactly why it is
        no longer the path this panel presents first.
      */}
      <details className="manual">
        <summary>Didn’t photograph the code?</summary>

        <p className="note">
          You can still do it now, though the card has to go back into the camera. Next time, the
          same code is on the start screen before you take it out.
        </p>

        <ol className="steps">
          <li>Photograph this code with the camera.</li>
          <li>Put the card back and bring that photo in with <strong>{addPhotosLabel}</strong>.</li>
          <li>Select that one photo, then press <strong>Read clock from photo</strong> above.</li>
        </ol>

        {/* Mounted only when open, so a closed panel is not redrawing a QR four times a second. */}
        {showClock
          ? <QrClock />
          : (
            <div className="row">
              <button type="button" onClick={() => setShowClock(true)}>Show the code</button>
            </div>
          )}
      </details>

      <ManualSync
        session={session}
        reference={reference}
        onSync={onSync}
        disabled={busy}
      />

      <ZoneField timeZone={session.clock.timeZone} onChange={onTimeZone} />

      <label>
        Clock runs fast by (seconds)
        <input
          type="number"
          value={session.clock.offsetSeconds}
          onChange={(event) => onOffsetSeconds(Number(event.target.value) || 0)}
        />
      </label>
      {session.sync && (
        <p className="note">
          Typing here replaces the measurement, so a later zone change will not re-derive it.
        </p>
      )}
    </div>
  );
}

/**
 * The clock in one line, for a collapsed panel's summary.
 *
 * A section that hides its contents has to say enough while shut to be worth leaving shut —
 * otherwise it has to be opened every time just to check, which is worse than not collapsing it.
 */
export function describeClock(session: Session): string {
  const drift = session.clock.offsetSeconds === 0
    ? 'no drift'
    : describeOffset(session.clock.offsetSeconds).replace('Clock runs ', '');

  return `${session.clock.timeZone}, ${drift}${session.sync ? ' (measured)' : ''}`;
}

/** Type in a time read from some other clock in a photograph. */
function ManualSync({
  session,
  reference,
  onSync,
  disabled,
}: {
  session: Session;
  reference: PhotoEntry | undefined;
  onSync: (sync: ClockSync) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const cameraReading = reference?.takenAt;

  function apply() {
    setProblem(null);

    if (!reference || !cameraReading) {
      setProblem('Select one photo that has a readable date.');
      return;
    }

    // A bare instant, in UTC, entered explicitly. Anything looser risks a local time being
    // read as UTC, which is a silent multi-hour error.
    const trimmed = text.trim();
    const parsed = /Z$|[+-]\d{2}:?\d{2}$/.test(trimmed) ? new Date(trimmed) : new Date(NaN);

    if (!Number.isFinite(parsed.getTime())) {
      setProblem('Enter the true time including a zone, e.g. 2024-07-01T11:00:00Z.');
      return;
    }

    onSync({
      cameraReading,
      trueInstant: parsed,
      sourcePhoto: reference.ref.name,
      method: 'manual',
    });
    setText('');
  }

  return (
    <details className="manual">
      <summary>Or type the true time from another clock</summary>

      <p className="note">
        For a shoot that is already over: if you photographed a clock at the time, enter
        the time it showed.
      </p>

      <p className="note">
        {reference
          ? cameraReading
            ? `Camera recorded ${formatNaive(cameraReading)} for ${reference.ref.name}.`
            : `${reference.ref.name} has no readable date.`
          : 'Select exactly one photo.'}
      </p>

      <label>
        True time, with a zone
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="2024-07-01T11:00:00Z"
          spellCheck={false}
        />
      </label>

      <button type="button" onClick={apply} disabled={disabled || !reference}>
        Use this time
      </button>
      {problem && <p className="note error">{problem}</p>}
      <p className="note">
        Session zone is {session.clock.timeZone}; the drift is derived in it and re-derived
        if you change it.
      </p>
    </details>
  );
}

function SyncStatus({
  session,
  onClearSync,
}: {
  session: Session;
  onClearSync: () => void;
}) {
  const { sync, clock } = session;

  if (!sync) {
    return (
      <p className="note">
        Drift is {clock.offsetSeconds === 0 ? 'not set' : `${describeOffset(clock.offsetSeconds)} (typed in)`}.
      </p>
    );
  }

  return (
    <div className="banner ok inline">
      <strong>{describeOffset(clock.offsetSeconds)}</strong>
      <div className="note">
        Measured from {sync.sourcePhoto} ({sync.method === 'qr' ? 'read from the code' : 'typed in'}),
        against {sync.trueInstant.toISOString().replace('T', ' ').slice(0, 19)}Z.
        Re-derived automatically if you change the zone.
      </div>
      <div className="note">
        This describes the camera as it is now. If its clock has been changed since the
        shoot, it does not apply to those photos.
      </div>
      <button type="button" onClick={onClearSync}>Forget measurement</button>
    </div>
  );
}

function ZoneField({
  timeZone,
  onChange,
}: {
  timeZone: string;
  onChange: (timeZone: string) => void;
}) {
  const [text, setText] = useState(timeZone);

  // Follow the session when it changes underneath us, e.g. through undo.
  useEffect(() => setText(timeZone), [timeZone]);

  const valid = isValidTimeZone(text);

  return (
    <>
      <label>
        Time zone the camera was set to
        <input
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            if (isValidTimeZone(event.target.value)) onChange(event.target.value);
          }}
          className={valid ? '' : 'invalid'}
          spellCheck={false}
        />
      </label>
      {!valid && <p className="note error">Not an IANA zone, e.g. Europe/London.</p>}
    </>
  );
}

function describeOffset(seconds: number): string {
  if (seconds === 0) return 'Clock is correct';

  const magnitude = Math.abs(seconds);
  const parts: string[] = [];
  const hours = Math.floor(magnitude / 3600);
  const minutes = Math.floor((magnitude % 3600) / 60);
  const rest = magnitude % 60;

  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (rest || parts.length === 0) parts.push(`${rest}s`);

  return `Clock runs ${parts.join(' ')} ${seconds > 0 ? 'fast' : 'slow'}`;
}

/** The camera's own reading, shown as it was recorded — no zone applied. */
function formatNaive(naive: NaiveDateTime): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${naive.year}-${pad(naive.month)}-${pad(naive.day)} `
    + `${pad(naive.hour)}:${pad(naive.minute)}:${pad(naive.second)}`;
}
