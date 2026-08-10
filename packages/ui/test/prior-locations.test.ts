import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  entryFromTags,
  failedEntry,
  type BatchFile,
  type BatchRun,
  type BatchRunner,
  type FolderHandle,
  type MetadataBackend,
  type PhotoEntry,
  type PhotoRef,
} from '@snapmapper/core';

import { readPriorLocations } from '../src/prior-locations.ts';
import { formatCoordinates, formatDistance } from '../src/format-location.ts';
import type { BrowserFileStore } from '../src/browser-file-store.ts';

/**
 * What is worth pinning here is not the reading — it is *which file* is read and *which tag* is
 * read out of it. Both of those fail silently when they are wrong: asking Composite of a sidecar
 * returns nothing and a raw photograph simply goes on looking unplaced, with no error anywhere.
 */

const folder: FolderHandle = { id: 'f1', displayName: '100MSDCF' };

function ref(name: string): PhotoRef {
  return { folder, name, sizeBytes: 1000, modifiedAtMs: 1_700_000_000_000, locator: name };
}

function entry(name: string): PhotoEntry {
  return entryFromTags(ref(name), { 'EXIF:DateTimeOriginal': '2024:07:01 12:00:00' });
}

const bytes = (text: string) => new TextEncoder().encode(text);

interface FakeStoreOptions {
  /** Names present in the `geotagged` folder. */
  readonly output?: readonly string[];
  /** Sidecars present beside the photographs, by sidecar filename. */
  readonly sidecars?: readonly string[];
  readonly listThrows?: boolean;
}

function fakeStore(options: FakeStoreOptions = {}) {
  const opened: string[] = [];

  const store = {
    async listOutputNames() {
      if (options.listThrows) throw new Error('permission was revoked');
      return new Set(options.output ?? []);
    },
    async readOutputHead(name: string) {
      opened.push(`output:${name}`);
      if (!options.output?.includes(name)) return undefined;
      return bytes(`copy of ${name}`);
    },
    async readSidecar(target: PhotoRef) {
      const name = target.name.replace(/\.[^.]+$/, '.xmp');
      opened.push(`sidecar:${name}`);
      if (!options.sidecars?.includes(name)) return undefined;
      return bytes(`<x:xmpmeta>${name}</x:xmpmeta>`);
    },
  } as unknown as BrowserFileStore;

  return { store, opened };
}

/** Tag records to return, keyed by the filename the reader mounts. */
function fakeRunner(records: Record<string, Record<string, unknown>>) {
  const seen: BatchFile[][] = [];

  const runner: BatchRunner = {
    async run(files: readonly BatchFile[]): Promise<BatchRun> {
      seen.push([...files]);
      const paths = files.map((file, index) => `/${index}_${file.name}`);
      const out = files.map((file, index) => ({
        SourceFile: paths[index],
        ...(records[file.name] ?? {}),
      }));
      return { stdout: JSON.stringify(out), stderr: '', paths, exitCode: 0 };
    },
  };

  return { runner, seen };
}

function fakeBackend(records: Record<string, Record<string, unknown>>): MetadataBackend {
  return {
    async write() {
      throw new Error('not used');
    },
    async read(input: { name: string }) {
      return {
        ok: true,
        data: JSON.stringify([{ SourceFile: `/${input.name}`, ...(records[input.name] ?? {}) }]),
        message: '',
      };
    },
  } as unknown as MetadataBackend;
}

const GREENWICH = { 'Composite:GPSLatitude': 51.4778, 'Composite:GPSLongitude': -0.0015 };

describe('finding what an earlier session wrote', () => {
  it('reads a JPEG copy through Composite', async () => {
    const { store } = fakeStore({ output: ['a.jpg'] });
    const { runner } = fakeRunner({ 'a.jpg': GREENWICH });

    const { priors, problems } = await readPriorLocations(
      [entry('a.jpg')], store, fakeBackend({}), runner,
    );

    assert.deepEqual(problems, []);
    assert.equal(priors.length, 1);
    assert.equal(priors[0]!.name, 'a.jpg');
    assert.equal(priors[0]!.source, 'copy');
    assert.equal(priors[0]!.location, 'geotagged/a.jpg');
    assert.equal(priors[0]!.coordinates.latitude, 51.4778);
  });

  it('reads a raw sidecar through XMP, not Composite', async () => {
    /*
     * The trap. An XMP has no `Composite:GPSLatitude` — there is nothing to compose it from,
     * because the value *is* the XMP tag. Reading the wrong one returns nothing and the raw
     * photograph goes on looking unplaced, with no error to notice.
     */
    const { store } = fakeStore({ sidecars: ['a.xmp'] });
    const { runner, seen } = fakeRunner({
      'a.xmp': { 'XMP:GPSLatitude': 51.4778, 'XMP:GPSLongitude': -0.0015, 'XMP:GPSAltitude': 12 },
    });

    const { priors } = await readPriorLocations([entry('a.arw')], store, fakeBackend({}), runner);

    assert.equal(priors.length, 1);
    assert.equal(priors[0]!.source, 'sidecar');
    assert.deepEqual(priors[0]!.coordinates, { latitude: 51.4778, longitude: -0.0015, altitude: 12 });
    // Mounted under its own `.xmp` name, which is what tells ExifTool what the bytes are.
    assert.deepEqual(seen[0]!.map((file) => file.name), ['a.xmp']);
  });

  it('does not read a Composite value out of a sidecar', async () => {
    // A sidecar that somehow reports Composite must not be believed through the JPEG path —
    // this pins that the tag is chosen by what the file *is*, not by what happens to be present.
    const { store } = fakeStore({ sidecars: ['a.xmp'] });
    const { runner } = fakeRunner({ 'a.xmp': GREENWICH });

    const { priors } = await readPriorLocations([entry('a.arw')], store, fakeBackend({}), runner);
    assert.equal(priors.length, 0);
  });

  it('opens nothing when the output folder has no copy of the photograph', async () => {
    // A card of a thousand untouched frames must not be a thousand failed file opens.
    const { store, opened } = fakeStore({ output: ['other.jpg'] });
    const { runner, seen } = fakeRunner({});

    const { priors } = await readPriorLocations([entry('a.jpg')], store, fakeBackend({}), runner);

    assert.equal(priors.length, 0);
    assert.deepEqual(opened, []);
    assert.deepEqual(seen, []);
  });

  it('skips a photograph that could not be read', async () => {
    const { store, opened } = fakeStore({ output: ['a.jpg'] });
    const { runner } = fakeRunner({ 'a.jpg': GREENWICH });

    const { priors } = await readPriorLocations(
      [failedEntry(ref('a.jpg'), 'File format error')], store, fakeBackend({}), runner,
    );

    assert.equal(priors.length, 0);
    assert.deepEqual(opened, []);
  });

  it('returns nothing for a copy that has no GPS in it', async () => {
    // The ordinary case for a copy written before the photograph was ever placed.
    const { store } = fakeStore({ output: ['a.jpg'] });
    const { runner } = fakeRunner({ 'a.jpg': { 'EXIF:Model': 'ILCE-6400' } });

    const { priors } = await readPriorLocations([entry('a.jpg')], store, fakeBackend({}), runner);
    assert.equal(priors.length, 0);
  });

  it('discards a coordinate that does not parse rather than defaulting it', async () => {
    // `0, 0` is a real place off the coast of Ghana, so a half-read position must vanish.
    const { store } = fakeStore({ output: ['a.jpg'] });
    const { runner } = fakeRunner({
      'a.jpg': { 'Composite:GPSLatitude': 51.4778, 'Composite:GPSLongitude': 'unknown' },
    });

    const { priors } = await readPriorLocations([entry('a.jpg')], store, fakeBackend({}), runner);
    assert.equal(priors.length, 0);
  });

  it('reports a folder it could not list, and carries on with the sidecars', async () => {
    const { store } = fakeStore({ listThrows: true, sidecars: ['a.xmp'] });
    const { runner } = fakeRunner({ 'a.xmp': { 'XMP:GPSLatitude': 1, 'XMP:GPSLongitude': 2 } });

    const { priors, problems } = await readPriorLocations(
      [entry('a.arw'), entry('b.jpg')], store, fakeBackend({}), runner,
    );

    assert.equal(priors.length, 1);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /output folder/);
  });

  it('reports one unreadable file without losing the others', async () => {
    const { store } = fakeStore({ output: ['a.jpg', 'b.jpg'] });
    const runner: BatchRunner = {
      async run(files) {
        // ExifTool's real behaviour: a record for the good file, an error on stderr, exit 1.
        const paths = files.map((file, index) => `/${index}_${file.name}`);
        const good = files
          .map((file, index) => ({ file, path: paths[index] as string }))
          .filter(({ file }) => file.name !== 'a.jpg');
        return {
          stdout: JSON.stringify(good.map(({ path }) => ({ SourceFile: path, ...GREENWICH }))),
          stderr: 'Error: File format error - /0_a.jpg',
          paths,
          exitCode: 1,
        };
      },
    };

    const { priors, problems } = await readPriorLocations(
      [entry('a.jpg'), entry('b.jpg')], store, fakeBackend({}), runner,
    );

    assert.deepEqual(priors.map((p) => p.name), ['b.jpg']);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /a\.jpg/);
  });

  it('falls back to the one-at-a-time backend when there is no runner', async () => {
    // Two photographs is below the threshold where booting a second interpreter pays for itself.
    const { store } = fakeStore({ output: ['a.jpg'] });
    const backend = fakeBackend({ 'a.jpg': GREENWICH });

    const { priors } = await readPriorLocations([entry('a.jpg')], store, backend, undefined);

    assert.equal(priors.length, 1);
    assert.equal(priors[0]!.coordinates.longitude, -0.0015);
  });

  it('does nothing at all when there is nothing to find', async () => {
    const { store } = fakeStore();
    const { runner, seen } = fakeRunner({});

    const result = await readPriorLocations(
      [entry('a.jpg'), entry('b.arw')], store, fakeBackend({}), runner,
    );

    assert.deepEqual(result.priors, []);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(seen, []);
  });
});

describe('wording a position and the gap between two', () => {
  it('rounds metres, because the tenths are noise from two fixes', () => {
    assert.equal(formatDistance(0.4), '0 m');
    assert.equal(formatDistance(342.7), '343 m');
    assert.equal(formatDistance(999), '999 m');
  });

  it('switches to kilometres, and drops the decimal once it stops helping', () => {
    assert.equal(formatDistance(1000), '1.0 km');
    assert.equal(formatDistance(20_500), '21 km');
  });

  it('prints a position to about a metre', () => {
    assert.equal(formatCoordinates({ latitude: 51.47780123, longitude: -0.0015 }), '51.47780, -0.00150');
  });
});
