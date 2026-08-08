import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MetadataWriteError,
  classify,
  decodeBase64,
  readTags,
  readThumbnail,
  writeMetadataSpliced,
  type BackendInput,
  readTagsAndThumbnail,
  type MetadataBackend,
} from '../src/exiftool.ts';
import { findScanStart } from '../src/jpeg.ts';

/** A JPEG whose structure is real enough to splice, built by hand. */
function buildJpeg(scanBytes = 2000, extraHeader: number[] = []) {
  const seg = (marker: number, payload: number[]) => {
    const length = payload.length + 2;
    return [0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload];
  };
  const header = [
    0xff, 0xd8,
    ...seg(0xe1, [...Array.from('Exif\0\0', (c) => c.charCodeAt(0)), 1, 2, 3, 4]),
    ...extraHeader,
    ...seg(0xc0, [8, 0, 16, 0, 16, 1, 1, 0x11, 0]),
    ...seg(0xda, [1, 1, 0, 0, 63, 0]),
  ];
  const scan = Array.from({ length: scanBytes }, (_, i) => (i % 251) + 1);
  return new Uint8Array([...header, ...scan, 0xff, 0xd9]);
}

/**
 * A backend that behaves like the real one: it receives a stub and returns a stub with
 * *grown* headers, because writing GPS to a file without it adds an IFD entry.
 */
function fakeBackend(overrides: Partial<{
  message: string;
  ok: boolean;
  data: Uint8Array | undefined;
  onWrite: (input: BackendInput) => void;
  readData: string;
}> = {}): MetadataBackend {
  return {
    async write(input) {
      overrides.onWrite?.(input);
      if ('data' in overrides) {
        return {
          ok: overrides.ok ?? true,
          data: overrides.data,
          message: overrides.message,
        };
      }
      // Grow the headers, as a real GPS insertion does.
      const grown = buildJpeg(32, [0xff, 0xe2, 0x00, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
      return { ok: overrides.ok ?? true, data: grown, message: overrides.message };
    },
    async read() {
      return {
        ok: true,
        data: overrides.readData ?? '[{"SourceFile":"x","EXIF:Orientation":1}]',
        message: undefined,
      };
    },
  };
}

describe('writeMetadataSpliced', () => {
  it('hands ExifTool only the metadata, not the photograph', async () => {
    const original = buildJpeg(500_000);
    let seen: BackendInput | undefined;

    const result = await writeMetadataSpliced(
      fakeBackend({ onWrite: (input) => { seen = input; } }),
      original,
      'DSC00119.JPG',
      { 'EXIF:GPSLatitude': '51.4778' },
    );

    assert.ok(seen, 'backend was never called');
    const stub = seen as BackendInput;
    assert.ok(
      stub.bytes.byteLength < original.byteLength / 10,
      `stub was ${stub.bytes.byteLength} of ${original.byteLength} bytes — not a stub`,
    );
    assert.equal(result.totalBytes, original.byteLength);
    assert.equal(result.stubBytes, stub.bytes.byteLength);
  });

  it('preserves the photograph byte for byte', async () => {
    const original = buildJpeg(50_000);
    const scanStart = findScanStart(original);

    const { bytes } = await writeMetadataSpliced(
      fakeBackend(), original, 'x.jpg', { 'EXIF:GPSLatitude': '1' },
    );

    assert.deepEqual(bytes.subarray(findScanStart(bytes)), original.subarray(scanStart));
  });

  it('passes -n and never -P or -overwrite_original', async () => {
    let seen: BackendInput | undefined;
    await writeMetadataSpliced(
      fakeBackend({ onWrite: (input) => { seen = input; } }),
      buildJpeg(), 'x.jpg', {},
    );

    assert.ok(seen?.args.includes('-n'));
    // Both fail in the WASM sandbox; see spike/README.md Q2.
    assert.ok(!seen?.args.includes('-P'));
    assert.ok(!seen?.args.includes('-overwrite_original'));
  });

  it('refuses a Blob rather than being 69x slower on a phone', async () => {
    const notBytes = new Blob([buildJpeg()]) as unknown as Uint8Array;
    await assert.rejects(
      () => writeMetadataSpliced(fakeBackend(), notBytes, 'x.jpg', {}),
      (error: Error) => error instanceof MetadataWriteError && /Uint8Array/.test(error.message),
    );
  });

  it('stops on a maker-note warning, which is how corruption announces itself', async () => {
    await assert.rejects(
      () => writeMetadataSpliced(
        fakeBackend({ message: 'Warning: [minor] Possibly incorrect maker notes offsets (fix by -53?)' }),
        buildJpeg(), 'x.jpg', {},
      ),
      (error: Error) => error instanceof MetadataWriteError && /maker note/i.test(error.message),
    );
  });

  it('carries on through a file-time warning, which the sandbox cannot avoid', async () => {
    const result = await writeMetadataSpliced(
      fakeBackend({ ok: false, message: 'Warning: Error setting file time - /x.jpg' }),
      buildJpeg(), 'x.jpg', {},
    );
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? '', /file time/i);
  });

  it('throws when the backend returns nothing', async () => {
    await assert.rejects(
      () => writeMetadataSpliced(
        fakeBackend({ ok: false, data: undefined, message: 'Error: something broke' }),
        buildJpeg(), 'x.jpg', {},
      ),
      MetadataWriteError,
    );
  });

  it('throws rather than emit a file when the backend returns junk', async () => {
    await assert.rejects(
      () => writeMetadataSpliced(
        fakeBackend({ data: new Uint8Array([1, 2, 3]) }), buildJpeg(), 'x.jpg', {},
      ),
      // jpeg.ts refuses to parse it; the point is that nothing is returned.
      (error: Error) => /JpegStructureError|MetadataWriteError/.test(error.name),
    );
  });
});

describe('classify', () => {
  it('treats an unrecognised message as fatal, not benign', () => {
    // The default has to be fatal: silent maker-note corruption is invisible for
    // months, so anything we do not positively recognise must stop the write.
    const { benign, fatal } = classify('Warning: something nobody has seen before');
    assert.equal(benign.length, 0);
    assert.equal(fatal.length, 1);
  });

  it('ignores the success line', () => {
    const { benign, fatal } = classify('    1 image files updated');
    assert.deepEqual(benign, []);
    assert.deepEqual(fatal, []);
  });

  it('classifies nothing as nothing', () => {
    assert.deepEqual(classify(undefined), { benign: [], fatal: [] });
    assert.deepEqual(classify(''), { benign: [], fatal: [] });
  });

  it('catches every shape of structural complaint', () => {
    for (const message of [
      'Warning: [minor] Possibly incorrect maker notes offsets',
      'Warning: Truncated PreviewImage',
      'Error: Corrupted JPEG image',
      'Warning: Bad IFD0 offset',
    ]) {
      assert.equal(classify(message).fatal.length, 1, message);
    }
  });

  it('separates the benign from the fatal in one message', () => {
    const { benign, fatal } = classify(
      'Warning: Error setting file time - /x.jpg\nWarning: Possibly incorrect maker notes offsets',
    );
    assert.equal(benign.length, 1);
    assert.equal(fatal.length, 1);
  });
});

describe('readTags', () => {
  it('parses ExifTool JSON and drops SourceFile', async () => {
    const values = await readTags(fakeBackend(), buildJpeg(), 'x.jpg');
    assert.equal(values['EXIF:Orientation'], 1);
    assert.ok(!('SourceFile' in values));
  });

  it('throws on output that is not JSON, rather than returning nothing', async () => {
    await assert.rejects(
      () => readTags(fakeBackend({ readData: 'File not found' }), buildJpeg(), 'x.jpg'),
      MetadataWriteError,
    );
  });

  it('throws when ExifTool reports no metadata at all', async () => {
    await assert.rejects(
      () => readTags(fakeBackend({ readData: '[]' }), buildJpeg(), 'x.jpg'),
      MetadataWriteError,
    );
  });
});

describe('decodeBase64', () => {
  it('decodes the standard test vectors', () => {
    const text = (bytes: Uint8Array) => String.fromCharCode(...bytes);
    assert.equal(text(decodeBase64('')), '');
    assert.equal(text(decodeBase64('Zg==')), 'f');
    assert.equal(text(decodeBase64('Zm8=')), 'fo');
    assert.equal(text(decodeBase64('Zm9v')), 'foo');
    assert.equal(text(decodeBase64('Zm9vYg==')), 'foob');
    assert.equal(text(decodeBase64('Zm9vYmE=')), 'fooba');
    assert.equal(text(decodeBase64('Zm9vYmFy')), 'foobar');
  });

  it('round-trips every byte value', () => {
    // A JPEG thumbnail is arbitrary binary, so no byte may be mangled.
    const original = Uint8Array.from({ length: 256 }, (_, i) => i);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let encoded = '';
    for (let i = 0; i < original.length; i += 3) {
      const a = original[i] ?? 0;
      const b = original[i + 1] ?? 0;
      const c = original[i + 2] ?? 0;
      encoded += alphabet[a >> 2];
      encoded += alphabet[((a & 3) << 4) | (b >> 4)];
      encoded += i + 1 < original.length ? alphabet[((b & 15) << 2) | (c >> 6)] : '=';
      encoded += i + 2 < original.length ? alphabet[c & 63] : '=';
    }
    assert.deepEqual(decodeBase64(encoded), original);
  });

  it('ignores whitespace and newlines a decoder may introduce', () => {
    assert.deepEqual(decodeBase64('Zm9v\n YmFy'), decodeBase64('Zm9vYmFy'));
  });

  it('recovers a real JPEG SOI marker from ExifTool-shaped output', () => {
    // The first bytes of every embedded thumbnail. If the decode is off by a bit, this is
    // where it shows.
    const decoded = decodeBase64('/9j/2wCEAAI');
    assert.equal(decoded[0], 0xff);
    assert.equal(decoded[1], 0xd8);
    assert.equal(decoded[2], 0xff);
  });
});

describe('readThumbnail', () => {
  it('decodes a base64 thumbnail out of ExifTool JSON', async () => {
    const backend = fakeBackend({
      readData: '[{"SourceFile":"x","EXIF:ThumbnailImage":"base64:Zm9vYmFy"}]',
    });
    const thumbnail = await readThumbnail(backend, buildJpeg(), 'x.jpg');
    assert.equal(String.fromCharCode(...(thumbnail ?? [])), 'foobar');
  });

  it('returns undefined when there is no thumbnail, rather than failing a folder load', async () => {
    const backend = fakeBackend({ readData: '[{"SourceFile":"x"}]' });
    assert.equal(await readThumbnail(backend, buildJpeg(), 'x.jpg'), undefined);
  });

  it('ignores a non-binary value that happens to be present', async () => {
    const backend = fakeBackend({ readData: '[{"SourceFile":"x","EXIF:Make":"SONY"}]' });
    assert.equal(await readThumbnail(backend, buildJpeg(), 'x.jpg'), undefined);
  });

  it('survives output that is not JSON at all', async () => {
    const backend = fakeBackend({ readData: 'File not found' });
    assert.equal(await readThumbnail(backend, buildJpeg(), 'x.jpg'), undefined);
  });
});

describe('reading tags and the thumbnail in one invocation', () => {
  /*
   * The reason this function exists is a measurement, not a tidiness preference: reading costs
   * ~1s *per ExifTool invocation* and almost nothing per byte, so two calls per photograph was
   * paying the fixed cost twice. Median of nine interleaved runs on a real 6.9MB A6400 JPEG:
   * 1921ms for two calls against 1173ms for one. See `spike/src/load-cost.mjs`.
   */
  function readingBackend(payload: Record<string, unknown>): {
    backend: MetadataBackend;
    calls: BackendInput[];
  } {
    const calls: BackendInput[] = [];
    return {
      calls,
      backend: {
        async write() { throw new Error('not used'); },
        async read(input) {
          calls.push(input);
          return { ok: true, data: JSON.stringify([payload]), message: undefined };
        },
      },
    };
  }

  /** ExifTool's own encoding for binary inside JSON, verified against 13.59. */
  const THUMB = `base64:${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;

  it('asks once and returns both', async () => {
    const { backend, calls } = readingBackend({
      SourceFile: '/x.jpg',
      'EXIF:DateTimeOriginal': '2024:07:01 12:00:00',
      'EXIF:ThumbnailImage': THUMB,
    });

    const result = await readTagsAndThumbnail(
      backend, new Uint8Array([1]), 'x.jpg', ['EXIF:DateTimeOriginal'],
    );

    assert.equal(calls.length, 1, 'the whole point is that this is one call');
    assert.equal(result.tags['EXIF:DateTimeOriginal'], '2024:07:01 12:00:00');
    assert.deepEqual([...(result.thumbnail ?? [])], [0xff, 0xd8, 0xff, 0xd9]);
  });

  it('passes -n and -b together, which is what makes one call possible', () => {
    // They are independent: -n controls how numbers are rendered, -b how binary is. Dropping
    // either silently changes the result — without -n, coordinates come back as DMS strings that
    // `entryFromTags` cannot read, and the failure looks like photos having no location.
    return (async () => {
      const { backend, calls } = readingBackend({ SourceFile: '/x.jpg' });
      await readTagsAndThumbnail(backend, new Uint8Array([1]), 'x.jpg', ['EXIF:Make']);

      const args = calls[0]?.args ?? [];
      assert.ok(args.includes('-n'), 'missing -n');
      assert.ok(args.includes('-b'), 'missing -b');
      assert.ok(args.includes('-G') && !args.includes('-G0:1'), 'must be -G, never -G0:1');
      assert.ok(args.includes('-ThumbnailImage'));
    })();
  });

  it('lifts the thumbnail out of the tag values rather than leaving it there', async () => {
    /*
     * Not tidiness. Left in place, a several-kilobyte base64 string would sit in every photo
     * entry for the life of the page — and a session is copied on every single edit, which is
     * only free because entries are small.
     */
    const { backend } = readingBackend({
      SourceFile: '/x.jpg',
      'EXIF:Make': 'SONY',
      'EXIF:ThumbnailImage': THUMB,
    });

    const { tags } = await readTagsAndThumbnail(backend, new Uint8Array([1]), 'x.jpg');
    assert.deepEqual(Object.keys(tags), ['EXIF:Make']);
  });

  it('is fine with a photo that has no thumbnail', async () => {
    // Plenty of edited or exported JPEGs have none, and it is cosmetic — it must not fail a load.
    const { backend } = readingBackend({ SourceFile: '/x.jpg', 'EXIF:Make': 'SONY' });
    const { tags, thumbnail } = await readTagsAndThumbnail(backend, new Uint8Array([1]), 'x.jpg');
    assert.equal(thumbnail, undefined);
    assert.equal(tags['EXIF:Make'], 'SONY');
  });
});
