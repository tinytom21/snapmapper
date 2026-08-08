/**
 * Reading a track file without asking the user what kind it is.
 *
 * There are two ways in — a GPX from a logger app, and a Google Timeline export — and making
 * somebody pick from a menu before the file dialog would be asking them to answer a question the
 * first byte of the file already answers.
 *
 * **Sniffed by content, not by extension.** A Timeline export has been called `Timeline.json`,
 * `location-history.json` and `Records.json` depending on the year and the phone, and a file that
 * has been through a share sheet, a chat app or a rename may be called anything at all. What it
 * *is* does not vary: XML starts with a `<`, JSON does not.
 */

import { parseGoogleTimeline, type TimelineSummary } from './google-timeline.ts';
import { parseGpx, type GpxTrack } from './gpx.ts';

export type TrackFileKind = 'gpx' | 'google-timeline';

export interface TrackFile {
  readonly track: GpxTrack;
  readonly kind: TrackFileKind;
  /** Present only for a Timeline export. */
  readonly summary?: TimelineSummary;
}

export function readTrackFile(text: string): TrackFile {
  // Leading whitespace, a byte-order mark, or an XML declaration all come before the `<`.
  const start = text.replace(/^﻿/, '').trimStart();

  if (start.startsWith('<')) return { track: parseGpx(start), kind: 'gpx' };

  if (start.startsWith('{') || start.startsWith('[')) {
    const { track, summary } = parseGoogleTimeline(start);
    return { track, kind: 'google-timeline', summary };
  }

  throw new Error(
    'That file is neither a GPX track nor a Google Timeline export — it starts with '
    + `“${start.slice(0, 20).trim() || 'nothing at all'}”.`,
  );
}
