/**
 * Working out what kind of track file somebody just picked.
 *
 * The reason this is sniffed rather than switched on the file extension: a Timeline export has been
 * called `Timeline.json`, `location-history.json` and `Records.json` depending on the year and the
 * phone, and a file that has been through a share sheet or a chat app may arrive called anything.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readTrackFile } from '../src/track-file.ts';

const GPX = '<?xml version="1.0"?><gpx><trkpt lat="51" lon="-1">'
  + '<time>2024-07-01T11:00:00Z</time></trkpt></gpx>';

const TIMELINE = JSON.stringify({
  rawSignals: [{ position: { LatLng: '51.0°, -1.0°', timestamp: '2024-07-01T11:00:00Z' } }],
});

describe('readTrackFile', () => {
  it('knows a GPX by its first character, whatever it is called', () => {
    assert.equal(readTrackFile(GPX).kind, 'gpx');
  });

  it('knows a Timeline export, object or array', () => {
    assert.equal(readTrackFile(TIMELINE).kind, 'google-timeline');
    assert.equal(readTrackFile('[{"startTime":"2024-07-01T11:00:00Z","endTime":'
      + '"2024-07-01T11:10:00Z","timelinePath":[{"point":"51°, -1°",'
      + '"durationMinutesOffsetFromStartTime":1}]}]').kind, 'google-timeline');
  });

  it('sees past a byte-order mark and leading whitespace', () => {
    // A BOM is what a file saved by a Windows editor carries, and it would otherwise make a
    // perfectly good GPX look like neither format.
    assert.equal(readTrackFile(`﻿${GPX}`).kind, 'gpx');
    assert.equal(readTrackFile(`\n\n  ${TIMELINE}`).kind, 'google-timeline');
  });

  it('carries the Timeline breakdown through, and gives a GPX none', () => {
    assert.equal(readTrackFile(TIMELINE).summary?.rawFixes, 1);
    assert.equal(readTrackFile(GPX).summary, undefined);
  });

  it('quotes what it actually found when the file is neither', () => {
    // The likeliest mistake is picking a photograph, a KML, or the zip the export came in — and
    // "unsupported file" would leave somebody re-picking the same wrong file.
    assert.throws(() => readTrackFile('PK binary rubbish'), /neither a GPX track nor/);
    assert.throws(() => readTrackFile('   '), /nothing at all/);
  });
});
