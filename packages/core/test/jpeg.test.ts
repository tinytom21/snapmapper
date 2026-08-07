import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  JpegStructureError,
  SCAN_STUB_BYTES,
  buildHeaderStub,
  findScanStart,
  metadataFraction,
  spliceHeaders,
} from '../src/jpeg.ts';

/**
 * Hand-built JPEGs rather than fixtures.
 *
 * Real A6400 files are the user's photographs: gitignored, absent on a fresh clone,
 * and impossible to assert exact offsets against. Structure parsing is exactly the
 * kind of thing that should be tested against bytes chosen to be awkward. The
 * end-to-end proof against real Sony files lives in the spike, where it belongs —
 * 184 checks against a native ExifTool.
 */
function segment(marker: number, payload: number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload];
}

interface JpegOptions {
  /** Extra segments between APP1 and SOS. */
  extra?: number[];
  /** 0xFF fill bytes inserted before the SOS marker, which is legal. */
  fill?: number;
  scanBytes?: number;
}

function buildJpeg({ extra = [], fill = 0, scanBytes = 64 }: JpegOptions = {}) {
  const app1 = segment(0xe1, [...Array.from('Exif\0\0', (c) => c.charCodeAt(0)), 1, 2, 3, 4]);
  const sof = segment(0xc0, [8, 0, 16, 0, 16, 1, 1, 0x11, 0]);
  const sos = segment(0xda, [1, 1, 0, 0, 63, 0]);

  const header = [0xff, 0xd8, ...app1, ...sof, ...extra, ...Array(fill).fill(0xff), ...sos];
  // Scan data deliberately avoids 0xFF so it cannot be mistaken for a marker.
  const scan = Array.from({ length: scanBytes }, (_, i) => (i % 251) + 1);

  return {
    bytes: new Uint8Array([...header, ...scan, 0xff, 0xd9]),
    scanStart: header.length,
  };
}

describe('findScanStart', () => {
  it('finds the byte after the SOS header', () => {
    const { bytes, scanStart } = buildJpeg();
    assert.equal(findScanStart(bytes), scanStart);
  });

  it('skips over any number of metadata segments', () => {
    const { bytes, scanStart } = buildJpeg({
      extra: [...segment(0xe2, [9, 9]), ...segment(0xdb, Array(64).fill(1)), ...segment(0xc4, [0, 1])],
    });
    assert.equal(findScanStart(bytes), scanStart);
  });

  it('tolerates 0xFF fill bytes before a marker', () => {
    const { bytes, scanStart } = buildJpeg({ fill: 3 });
    assert.equal(findScanStart(bytes), scanStart);
  });

  it('does not mistake scan data that resembles a marker', () => {
    // A real SOS is followed by entropy-coded data containing 0xFF00 escapes and
    // restart markers. Scanning past SOS would trip over them, so we must not.
    const { bytes, scanStart } = buildJpeg();
    const withEscapes = new Uint8Array([
      ...bytes.subarray(0, scanStart),
      0xff, 0x00, 0xff, 0xd0, 0x12, 0xff, 0x00,
      0xff, 0xd9,
    ]);
    assert.equal(findScanStart(withEscapes), scanStart);
  });

  it('rejects anything that is not a JPEG', () => {
    assert.throws(() => findScanStart(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), JpegStructureError);
    assert.throws(() => findScanStart(new Uint8Array([])), JpegStructureError);
    assert.throws(() => findScanStart(new Uint8Array([0xff, 0xd8])), JpegStructureError);
  });

  it('rejects a file with no scan at all rather than returning a guess', () => {
    const headerOnly = new Uint8Array([0xff, 0xd8, ...segment(0xe1, [1, 2, 3]), 0xff, 0xd9]);
    assert.throws(() => findScanStart(headerOnly), JpegStructureError);
  });

  it('rejects a corrupt segment length instead of walking off the end', () => {
    // Length 0 would leave the offset stuck or moving backwards.
    const corrupt = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x00, 0xff, 0xda]);
    assert.throws(() => findScanStart(corrupt), JpegStructureError);
  });

  it('rejects a segment whose length runs past the end of the file', () => {
    const truncated = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x01, 0x02]);
    assert.throws(() => findScanStart(truncated), JpegStructureError);
  });
});

describe('buildHeaderStub', () => {
  it('keeps every metadata segment and a little scan data', () => {
    const { bytes, scanStart } = buildJpeg({ scanBytes: 10_000 });
    const stub = buildHeaderStub(bytes, scanStart);

    assert.equal(stub.length, scanStart + SCAN_STUB_BYTES + 2);
    assert.deepEqual(stub.subarray(0, scanStart), bytes.subarray(0, scanStart));
  });

  it('terminates the stub with EOI so it is a complete JPEG', () => {
    const { bytes, scanStart } = buildJpeg({ scanBytes: 10_000 });
    const stub = buildHeaderStub(bytes, scanStart);

    assert.equal(stub[stub.length - 2], 0xff);
    assert.equal(stub[stub.length - 1], 0xd9);
  });

  it('keeps some scan data, because a stub with none is rejected as corrupt', () => {
    const { bytes, scanStart } = buildJpeg({ scanBytes: 10_000 });
    const stub = buildHeaderStub(bytes, scanStart);
    assert.ok(stub.length > findScanStart(stub), 'stub has no scan data at all');
  });

  it('does not run past the end of a file smaller than the stub size', () => {
    const { bytes, scanStart } = buildJpeg({ scanBytes: 8 });
    const stub = buildHeaderStub(bytes, scanStart);
    assert.ok(stub.length <= bytes.length + 2);
    assert.doesNotThrow(() => findScanStart(stub));
  });
});

describe('spliceHeaders', () => {
  it('produces rewritten headers followed by the original scan, byte for byte', () => {
    const { bytes, scanStart } = buildJpeg({ scanBytes: 500 });

    // Stand in for ExifTool: same structure, but with an extra segment, so the
    // headers grow and the scan necessarily moves — which is the real case.
    const grown = buildJpeg({ extra: segment(0xe1, Array(40).fill(7)), scanBytes: 32 });

    const out = spliceHeaders(bytes, scanStart, grown.bytes);

    assert.deepEqual(
      out.subarray(0, grown.scanStart),
      grown.bytes.subarray(0, grown.scanStart),
      'headers should come from the rewritten stub',
    );
    assert.deepEqual(
      out.subarray(grown.scanStart),
      bytes.subarray(scanStart),
      'scan data must be the original bytes, unchanged',
    );
  });

  it('keeps the photograph identical even when the headers shrink', () => {
    const { bytes, scanStart } = buildJpeg({
      extra: segment(0xe2, Array(200).fill(3)),
      scanBytes: 300,
    });
    const smaller = buildJpeg({ scanBytes: 16 });

    const out = spliceHeaders(bytes, scanStart, smaller.bytes);
    assert.deepEqual(out.subarray(findScanStart(out)), bytes.subarray(scanStart));
  });

  it('refuses a rewritten stub it cannot parse, rather than emitting a broken file', () => {
    const { bytes, scanStart } = buildJpeg();
    assert.throws(
      () => spliceHeaders(bytes, scanStart, new Uint8Array([0x00, 0x01, 0x02])),
      JpegStructureError,
    );
  });

  it('round-trips: splicing a file with its own headers reproduces it exactly', () => {
    const { bytes, scanStart } = buildJpeg({ scanBytes: 777 });
    const stub = buildHeaderStub(bytes, scanStart);
    assert.deepEqual(spliceHeaders(bytes, scanStart, stub), bytes);
  });
});

describe('metadataFraction', () => {
  it('reports how little of a photo is metadata', () => {
    const { bytes } = buildJpeg({ scanBytes: 99_000 });
    const fraction = metadataFraction(bytes);
    assert.ok(fraction > 0 && fraction < 0.02, `expected a small fraction, got ${fraction}`);
  });
});
