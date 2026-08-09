/**
 * The XMP sidecar's tag set and its write path.
 *
 * That the produced document is *correct* is proved against native ExifTool by
 * `npm run xmp --workspace spike` — 10 checks, 0 failures, including that a latitude of −33.8688
 * reads back with `Composite:GPSLatitudeRef: S`. These pin the decisions around it, and above all
 * the one that would break every sidecar write: XMP has no ref tags.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSidecarTags, writeXmpSidecar } from '../src/xmp-sidecar.ts';
import type { BatchRunner } from '../src/exiftool-batch.ts';

const LONDON = { latitude: 51.5074, longitude: -0.1278 };

/** A runner that reports what it was asked, and answers with a document containing those tags. */
function fakeRunner(options: { produce?: boolean; stderr?: string } = {}) {
  const seen: { args: readonly string[]; outputs: readonly string[] | undefined; files: number }[] = [];

  const runner: BatchRunner = {
    async run(files, args, outputs) {
      seen.push({ args, outputs, files: files.length });

      // A document echoing back whatever tags were asked for, shaped like ExifTool's.
      const body = args
        .filter((arg) => arg.startsWith('-XMP:'))
        .map((arg) => {
          const [tag, value] = arg.slice(5).split('=');
          return `  <exif:${tag}>${value}</exif:${tag}>`;
        })
        .join('\n');

      const xml = `<x:xmpmeta xmlns:x='adobe:ns:meta/'>\n${body}\n</x:xmpmeta>`;

      return {
        stdout: '', stderr: options.stderr ?? '', paths: [], exitCode: 0,
        ...(options.produce === false
          ? {}
          : { produced: new Map([['/sidecar.xmp', new TextEncoder().encode(xml)]]) }),
      };
    },
  };

  return { runner, seen };
}

describe('buildSidecarTags', () => {
  it('writes signed decimals and no ref tags at all', () => {
    /*
     * The trap that would fail every sidecar write. XMP has no `GPSLatitudeRef` — the hemisphere
     * lives inside the value, as `51,30.0N`. Passing the EXIF ref tags earns
     * `Sorry, XMP:GPSLatitudeRef doesn't exist or isn't writable`, and `classify` treats any
     * unrecognised stderr as fatal. Measured against real ExifTool in the spike.
     */
    const tags = buildSidecarTags({ latitude: -33.8688, longitude: -151.2093 });

    assert.equal(tags['XMP:GPSLatitude'], '-33.8688');
    assert.equal(tags['XMP:GPSLongitude'], '-151.2093');
    assert.equal(tags['XMP:GPSLatitudeRef'], undefined);
    assert.equal(tags['XMP:GPSLongitudeRef'], undefined);
    assert.equal(tags['XMP:GPSAltitudeRef'], undefined);
  });

  it('writes nothing from EXIF or IPTC', () => {
    // An `.xmp` file holds an XMP packet and nothing else, so an EXIF or IPTC tag would earn the
    // same "isn't writable" error as the ref tags.
    const tags = buildSidecarTags(LONDON, {
      city: 'London', state: 'Greater London', country: 'United Kingdom', countryCode: 'GB',
    });

    assert.deepEqual(
      Object.keys(tags).filter((tag) => !tag.startsWith('XMP:')),
      [],
    );
  });

  it('omits a field the geocoder did not fill rather than blanking it', () => {
    // An empty string is ExifTool's *delete* value.
    const tags = buildSidecarTags(LONDON, { country: 'United Kingdom' });

    assert.equal(tags['XMP:Country'], 'United Kingdom');
    assert.equal('XMP:City' in tags, false);
    assert.equal('XMP:State' in tags, false);
  });

  it('includes altitude only when there is one', () => {
    assert.equal('XMP:GPSAltitude' in buildSidecarTags(LONDON), false);
    assert.equal(buildSidecarTags({ ...LONDON, altitude: 42.5 })['XMP:GPSAltitude'], '42.5');
  });

  it('refuses coordinates that are not on the planet', () => {
    assert.throws(() => buildSidecarTags({ latitude: 91, longitude: 0 }));
  });
});

describe('writeXmpSidecar', () => {
  it('mounts nothing and names its own output', async () => {
    /*
     * The two reasons this cannot go through the wrapper's write path: that one always appends an
     * input file, and always names its output `<uuid>.tmp` — and the extension is what tells
     * ExifTool to produce an XMP rather than a copy of the input.
     */
    const { runner, seen } = fakeRunner();
    await writeXmpSidecar(runner, buildSidecarTags(LONDON));

    assert.equal(seen[0]?.files, 0, 'a sidecar needs no source file');
    assert.deepEqual(seen[0]?.outputs, ['/sidecar.xmp']);
    assert.ok(seen[0]?.args.includes('-o'));
    assert.ok(seen[0]?.args.includes('-n'), 'signed decimals need numeric mode');
  });

  it('throws when nothing was produced', async () => {
    const { runner } = fakeRunner({ produce: false });
    await assert.rejects(
      () => writeXmpSidecar(runner, buildSidecarTags(LONDON)),
      /produced no XMP sidecar/,
    );
  });

  it('throws when a tag did not make it into the document', async () => {
    /*
     * Judged on the document rather than on the exit code. A tag ExifTool declines to write is a
     * warning that still produces a file — and a sidecar quietly missing its coordinates would be
     * worse than a failed write, because it leaves a plausible file on disk and reports success.
     */
    const runner: BatchRunner = {
      async run() {
        return {
          stdout: '', stderr: 'Warning: Sorry, XMP:GPSLatitude is not writable',
          paths: [], exitCode: 0,
          produced: new Map([[
            '/sidecar.xmp',
            new TextEncoder().encode("<x:xmpmeta xmlns:x='adobe:ns:meta/'></x:xmpmeta>"),
          ]]),
        };
      },
    };

    await assert.rejects(
      () => writeXmpSidecar(runner, buildSidecarTags(LONDON)),
      /missing XMP:GPSLatitude/,
    );
  });

  it('rejects something that is not an XMP packet', async () => {
    const runner: BatchRunner = {
      async run() {
        return {
          stdout: '', stderr: '', paths: [], exitCode: 0,
          produced: new Map([['/sidecar.xmp', new TextEncoder().encode('not xml at all')]]),
        };
      },
    };

    await assert.rejects(
      () => writeXmpSidecar(runner, buildSidecarTags(LONDON)),
      /not an XMP packet/,
    );
  });
});
