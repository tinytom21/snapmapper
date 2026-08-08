/**
 * Choosing the day's track out of a folder of them.
 *
 * The case worth caring about is midnight, and the reason it works is that nothing here ever looks
 * at a filename. A photograph has an instant; a file has a span; the question is only whether they
 * overlap. Every test below that names a file misleadingly does so on purpose.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SELECTION_PAD_MS, chooseTracks, photoSpan } from '../src/track-folder.ts';
import { gpxSpan, mergeSpans, mergeTracks, parseGpx } from '../src/gpx.ts';

const HOUR = 3_600_000;

function at(iso: string): number {
  return Date.parse(iso);
}

/** A candidate covering `from`..`to`, named however the caller likes. */
function file(name: string, from: string, to: string) {
  return { name, span: { from: at(from), to: at(to) } };
}

const MONDAY = file('2024-07-01.gpx', '2024-07-01T06:00:00Z', '2024-07-01T22:00:00Z');
const TUESDAY = file('2024-07-02.gpx', '2024-07-02T06:00:00Z', '2024-07-02T22:00:00Z');
const LAST_YEAR = file('2023-01-01.gpx', '2023-01-01T06:00:00Z', '2023-01-01T22:00:00Z');

describe('choosing tracks for a shoot', () => {
  it('takes the file covering the photographs', () => {
    const choice = chooseTracks([LAST_YEAR, MONDAY, TUESDAY], {
      from: at('2024-07-01T13:00:00Z'),
      to: at('2024-07-01T15:00:00Z'),
    });
    // Tuesday is in range only because of the 12h pad, which is deliberate — see below.
    assert.ok(choice.chosen.some((one) => one.name === MONDAY.name));
    assert.equal(choice.chosen.some((one) => one.name === LAST_YEAR.name), false);
  });

  it('takes both files when a shoot crosses midnight', () => {
    /*
     * The case that was asked about. A logger rolling over at midnight puts 23:50 in one file and
     * 00:10 in the next, and no rule about *which* file is right can be correct for both — so both
     * are taken and the timestamps sort it out.
     */
    const choice = chooseTracks([MONDAY, TUESDAY], {
      from: at('2024-07-01T23:50:00Z'),
      to: at('2024-07-02T00:10:00Z'),
    });
    assert.deepEqual(choice.chosen.map((one) => one.name), [MONDAY.name, TUESDAY.name]);
  });

  it('never reads a filename, however wrong it is', () => {
    // A logger that flushes after midnight names the file for the day it was *written*. Choosing
    // on the name would pick a file whose contents are the previous day.
    const misnamed = file('2024-07-02.gpx', '2024-07-01T06:00:00Z', '2024-07-01T22:00:00Z');
    const choice = chooseTracks([misnamed], {
      from: at('2024-07-01T13:00:00Z'),
      to: at('2024-07-01T14:00:00Z'),
    });
    assert.equal(choice.chosen.length, 1);
  });

  it('absorbs a camera clock that is wrong by hours', () => {
    // The one quantity in this selection known to be wrong. A clock four hours out must not put
    // the shoot in a day with no track at all.
    const choice = chooseTracks([MONDAY], {
      from: at('2024-07-01T02:00:00Z'),
      to: at('2024-07-01T03:00:00Z'),
    });
    assert.equal(choice.chosen.length, 1);
    assert.equal(SELECTION_PAD_MS, 12 * HOUR);
  });

  it('takes a file that covers only part of the shoot', () => {
    // A logger started late leaves half a track, which is worth far more than none.
    const half = file('late.gpx', '2024-07-01T14:00:00Z', '2024-07-01T22:00:00Z');
    const choice = chooseTracks([half], {
      from: at('2024-07-01T12:00:00Z'),
      to: at('2024-07-01T20:00:00Z'),
    });
    assert.equal(choice.chosen.length, 1);
  });

  it('says how far off the nearest track was when nothing overlaps', () => {
    // "No match" leaves you wondering whether the feature is broken. "The closest is three days
    // earlier" tells you the logger was off, which is a fact about your day, not about the app.
    const choice = chooseTracks([LAST_YEAR], {
      from: at('2024-07-01T13:00:00Z'),
      to: at('2024-07-01T15:00:00Z'),
    });
    assert.deepEqual(choice.chosen, []);
    assert.equal(choice.nearest?.name, LAST_YEAR.name);
    assert.ok((choice.nearest?.offBy ?? 0) > 300 * 24 * HOUR);
  });

  it('reports files it could not read a span from', () => {
    const choice = chooseTracks([{ name: 'broken.gpx' }, MONDAY], {
      from: at('2024-07-01T13:00:00Z'),
      to: at('2024-07-01T15:00:00Z'),
    });
    assert.deepEqual(choice.unreadable, ['broken.gpx']);
  });

  it('copes with an empty folder', () => {
    const choice = chooseTracks([], { from: 0, to: 1 });
    assert.deepEqual(choice.chosen, []);
    assert.equal(choice.nearest, undefined);
  });
});

describe('photoSpan', () => {
  it('is the range of the instants that are known', () => {
    const span = photoSpan([
      new Date('2024-07-01T13:00:00Z'),
      undefined,
      new Date('2024-07-01T11:00:00Z'),
    ]);
    assert.equal(span?.from, at('2024-07-01T11:00:00Z'));
    assert.equal(span?.to, at('2024-07-01T13:00:00Z'));
  });

  it('is undefined when nothing has a date, which is not the same as an empty folder', () => {
    assert.equal(photoSpan([undefined, undefined]), undefined);
    assert.equal(photoSpan([]), undefined);
  });
});

describe('gpxSpan', () => {
  const XML = '<gpx><metadata><time>2024-07-02T03:00:00Z</time></metadata><trk><trkseg>'
    + '<trkpt lat="51" lon="-1"><time>2024-07-01T11:00:00Z</time></trkpt>'
    + '<trkpt lat="51" lon="-1"><time>2024-07-01T12:00:00Z</time></trkpt>'
    + '</trkseg></trk></gpx>';

  it('takes the minimum and maximum, not the first and last', () => {
    /*
     * `<metadata><time>` is when the file was written, and it comes first while being later than
     * everything in the file — a logger flushing after midnight does exactly this. Reading first
     * and last would give a span running backwards.
     */
    const span = gpxSpan(XML);
    assert.equal(span?.from, at('2024-07-01T11:00:00Z'));
    assert.equal(span?.to, at('2024-07-02T03:00:00Z'));
    assert.ok((span?.to ?? 0) > (span?.from ?? 0));
  });

  it('is undefined for a file with no times', () => {
    assert.equal(gpxSpan('<gpx><trkpt lat="51" lon="-1"/></gpx>'), undefined);
  });
});

describe('merging the chosen tracks', () => {
  const first = parseGpx(
    '<gpx><trk><name>Monday</name><trkseg><trkpt lat="51" lon="-1">'
    + '<time>2024-07-01T23:50:00Z</time></trkpt></trkseg></trk></gpx>',
  );
  const second = parseGpx(
    '<gpx><trk><name>Tuesday</name><trkseg><trkpt lat="52" lon="-2">'
    + '<time>2024-07-02T00:10:00Z</time></trkpt></trkseg></trk></gpx>',
  );

  it('puts the points in time order regardless of the order the files came in', () => {
    const merged = mergeTracks([second, first]);
    assert.deepEqual(
      merged.points.map((point) => point.latitude),
      [51, 52],
    );
    assert.equal(merged.name, 'Tuesday + Monday');
  });

  it('returns the single track untouched when there is only one', () => {
    assert.equal(mergeTracks([first]), first);
  });
});

describe('a month in one file', () => {
  /*
   * The shape a permanent logger tends to end up with, because a file per day does not scale
   * nicely over years. Selection needs nothing new — span overlap does not care how long a file
   * is — but everything about *size* changes, and this is where that is pinned.
   */
  function month(year: number, monthIndex: number, stepMinutes = 30): string {
    const points: string[] = [];
    const start = Date.UTC(year, monthIndex, 1);
    const end = Date.UTC(year, monthIndex + 1, 1);

    for (let time = start; time < end; time += stepMinutes * 60_000) {
      const fraction = (time - start) / (end - start);
      points.push(
        `<trkpt lat="${(51 + fraction).toFixed(6)}" lon="${(-1 + fraction).toFixed(6)}">`
        + `<time>${new Date(time).toISOString()}</time></trkpt>`,
      );
    }

    return `<gpx><trk><name>${year}-${monthIndex + 1}</name><trkseg>`
      + points.join('') + '</trkseg></trk></gpx>';
  }

  const JULY = month(2024, 6);

  /** A candidate from a real document, which is where a monthly span comes from in practice. */
  function scanned(name: string, xml: string) {
    const span = gpxSpan(xml);
    return { name, ...(span ? { span } : {}) };
  }

  it('is chosen for a shoot inside it, exactly as a daily file would be', () => {
    const choice = chooseTracks(
      [scanned('2024-06.gpx', month(2024, 5)), scanned('2024-07.gpx', JULY)],
      { from: at('2024-07-15T13:00:00Z'), to: at('2024-07-15T15:00:00Z') },
    );
    assert.deepEqual(choice.chosen.map((one) => one.name), ['2024-07.gpx']);
  });

  it('takes both months when a shoot crosses the turn of the month', () => {
    // The month boundary is the midnight case again, one scale up — and it needs no more code.
    const choice = chooseTracks(
      [scanned('2024-07.gpx', JULY), scanned('2024-08.gpx', month(2024, 7))],
      { from: at('2024-07-31T23:50:00Z'), to: at('2024-08-01T00:10:00Z') },
    );
    assert.deepEqual(choice.chosen.map((one) => one.name), ['2024-07.gpx', '2024-08.gpx']);
  });

  it('parses only the window, not the month', () => {
    /*
     * The reason `parseGpx` takes a window rather than the caller filtering afterwards: the points
     * outside it are never allocated. On a real monthly file that is a quarter of a million objects
     * not created, on a phone, to place one afternoon.
     */
    const whole = parseGpx(JULY);
    const window = {
      from: at('2024-07-15T06:00:00Z'),
      to: at('2024-07-15T20:00:00Z'),
    };
    const clipped = parseGpx(JULY, window);

    assert.ok(whole.points.length > 1400, `only ${whole.points.length} points in a month`);
    assert.equal(clipped.points.length, 29);
    assert.ok(clipped.points.every((p) => p.time >= window.from && p.time <= window.to));
  });

  it('does not treat a window that excludes everything as a broken file', () => {
    // A file chosen on span overlap may still hold nothing in the load window. That is an ordinary
    // answer for the folder search, not a reason to throw at the user.
    const empty = parseGpx(JULY, { from: at('2023-01-01T00:00:00Z'), to: at('2023-01-02T00:00:00Z') });
    assert.deepEqual(empty.points, []);
  });

  it('still refuses a file that genuinely has no usable points', () => {
    assert.throws(
      () => parseGpx('<gpx><trkpt lat="51" lon="-1"/></gpx>', { from: 0, to: 9e15 }),
      /none of them carry a time/,
    );
  });

  it('reads a big span from the two ends alone', () => {
    /*
     * What `spanOf` does for a file too big to want all of. The ends are scanned separately and
     * merged so that a `<time>` severed by the slice cannot be misread as something else.
     */
    const head = JULY.slice(0, 4000);
    const tail = JULY.slice(-4000);
    const edges = mergeSpans([gpxSpan(head), gpxSpan(tail)]);
    const whole = gpxSpan(JULY);

    assert.deepEqual(edges, whole);
  });

  it('merges spans while ignoring the ends that had none', () => {
    assert.equal(mergeSpans([undefined, undefined]), undefined);
    assert.deepEqual(
      mergeSpans([{ from: 10, to: 20 }, undefined, { from: 5, to: 15 }]),
      { from: 5, to: 20 },
    );
  });
});
