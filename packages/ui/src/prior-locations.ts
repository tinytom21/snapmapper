/**
 * Find where an earlier session already put these photographs.
 *
 * The reasoning for the feature, and the precedence rule, are in `core/prior-location.ts`. This is
 * the part that touches the disk: which files to look for, how few bytes to read, and which tag to
 * read them through.
 *
 * ## The cost, which was budgeted before it was built
 *
 * One directory enumeration answers "which of these have been done" for the whole set — no file is
 * opened, so it is the same cost for three copies as for three thousand. Only the files that exist
 * are then read, batched sixteen at a time through the runner the load has already built, at about
 * 43 ms each. Fifty photographs already geotagged is therefore roughly two seconds on top of the
 * load, and none at all for a card that has never been touched.
 *
 * **The runner is passed in rather than created.** Building one instantiates the 24MB WASM into a
 * second zeroperl instance, which would cost far more than this whole step saves — see
 * `load-photos.ts`, which builds the one this shares.
 *
 * ## Two tags, and they are not interchangeable
 *
 * A JPEG copy is read through `Composite:GPSLatitude`; an XMP sidecar through `XMP:GPSLatitude`.
 * Asking Composite of a sidecar returns nothing — there is nothing to compose it from, the value
 * *is* the XMP tag — and the symptom is not an error but a raw photograph that goes on looking
 * unplaced. Both are requested in the same invocation, because the extra tags are free, and the
 * right one is picked per file by which kind of file it was.
 */

import {
  headerOnly,
} from './load-photos.ts';
import {
  isRawFile,
  readManyTags,
  readTags,
  sidecarName,
  type BatchFile,
  type BatchRunner,
  type MetadataBackend,
  type PhotoEntry,
  type PhotoRef,
  type PriorLocation,
  type PriorSource,
} from '@snapmapper/core';
import type { BrowserFileStore } from './browser-file-store.ts';

/**
 * How much of a prior copy to read.
 *
 * The same 1MB the ordinary metadata read uses, and for the same reason: the cost is per
 * invocation rather than per byte, so this is about the disk and the phone's memory, not about
 * ExifTool. GPS sits in the first few kilobytes either way.
 */
const HEAD_BYTES = 1024 * 1024;

/** Both spellings, in one request. Which one is read depends on the file — see the file note. */
const WANTED = [
  'Composite:GPSLatitude',
  'Composite:GPSLongitude',
  'Composite:GPSAltitude',
  'XMP:GPSLatitude',
  'XMP:GPSLongitude',
  'XMP:GPSAltitude',
];

/** A file worth reading, and what reading it would tell us about. */
interface Candidate {
  /** The photograph's name, which is not the name of the file being read. */
  readonly photo: string;
  readonly file: BatchFile;
  readonly source: PriorSource;
  readonly location: string;
}

export interface PriorLocationsResult {
  readonly priors: readonly PriorLocation[];
  /**
   * Files that were found but could not be read.
   *
   * Reported rather than thrown. A corrupt sidecar is a reason to say so and carry on with the
   * photographs; it is not a reason to refuse to open a card.
   */
  readonly problems: readonly string[];
}

/**
 * Look for locations written by an earlier session, and read the ones that exist.
 *
 * Never throws for a single unreadable file, and never throws at all for the ordinary case of
 * there being nothing to find. This runs on the way into a session, and a session that refuses to
 * start because an optional lookup failed would be a poor trade for a convenience.
 */
export async function readPriorLocations(
  entries: readonly PhotoEntry[],
  store: BrowserFileStore,
  backend: MetadataBackend,
  runner: BatchRunner | undefined,
): Promise<PriorLocationsResult> {
  const problems: string[] = [];
  const candidates = await gatherCandidates(entries, store, problems);
  if (candidates.length === 0) return { priors: [], problems };

  const priors: PriorLocation[] = [];

  if (runner) {
    const results = await readManyTags(runner, candidates.map((c) => c.file), WANTED, 'ThumbnailImage');
    for (const [index, result] of results.entries()) {
      const candidate = candidates[index] as Candidate;
      if (!result.ok) {
        problems.push(`${candidate.location}: ${result.error}`);
        continue;
      }
      collect(priors, candidate, result.tags);
    }
    return { priors, problems };
  }

  /*
   * No runner: a handful of photographs, where booting a second interpreter costs more than it
   * saves. One at a time through the ordinary backend, which is the same path `loadPhotos` falls
   * back to and needs no new machinery.
   */
  for (const candidate of candidates) {
    try {
      const tags = await readTags(backend, candidate.file.bytes, candidate.file.name, WANTED);
      collect(priors, candidate, tags);
    } catch (error) {
      problems.push(`${candidate.location}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { priors, problems };
}

/**
 * Decide what to read, and read the bytes.
 *
 * A raw photograph's prior location is in its sidecar, beside it; a JPEG's is in the copy in the
 * output folder. The enumeration comes first so that no file is opened speculatively — asking for
 * a handle that does not exist is an exception per photograph, and a card of a thousand untouched
 * frames would be a thousand of them.
 */
async function gatherCandidates(
  entries: readonly PhotoEntry[],
  store: BrowserFileStore,
  problems: string[],
): Promise<Candidate[]> {
  const candidates: Candidate[] = [];

  let outputNames: ReadonlySet<string> = new Set();
  try {
    outputNames = await store.listOutputNames();
  } catch (error) {
    problems.push(`could not list the output folder: ${describe(error)}`);
  }

  for (const entry of entries) {
    // An unreadable photograph cannot be written either, so a location for it would be a pin on
    // the map for a file the application has already given up on. `findPriorLocations` refuses
    // these too; skipping here means not paying to read the file in the first place.
    if (entry.error !== undefined) continue;

    try {
      const candidate = isRawFile(entry.ref.name)
        ? await sidecarCandidate(entry.ref, store)
        : await copyCandidate(entry.ref, store, outputNames);
      if (candidate) candidates.push(candidate);
    } catch (error) {
      problems.push(`${entry.ref.name}: ${describe(error)}`);
    }
  }

  return candidates;
}

async function sidecarCandidate(
  ref: PhotoRef,
  store: BrowserFileStore,
): Promise<Candidate | undefined> {
  const bytes = await store.readSidecar(ref);
  if (!bytes || bytes.byteLength === 0) return undefined;

  const name = sidecarName(ref.name);
  return {
    photo: ref.name,
    // The name carries the `.xmp` extension deliberately: it is what tells ExifTool the bytes are
    // an XMP document rather than something to sniff.
    file: { name, bytes },
    source: 'sidecar',
    location: name,
  };
}

async function copyCandidate(
  ref: PhotoRef,
  store: BrowserFileStore,
  outputNames: ReadonlySet<string>,
): Promise<Candidate | undefined> {
  if (!outputNames.has(ref.name)) return undefined;

  const bytes = await store.readOutputHead(ref.name, HEAD_BYTES);
  if (!bytes || bytes.byteLength === 0) return undefined;

  /*
   * Note the harmless degenerate case: opening the `geotagged` folder itself as the photo folder
   * makes each photograph its own prior copy. The coordinates then agree with themselves, so it
   * adopts silently and changes nothing.
   */
  return {
    photo: ref.name,
    file: { name: ref.name, bytes: headerOnly(bytes) },
    source: 'copy',
    location: `${OUTPUT_LABEL}/${ref.name}`,
  };
}

/** What the output folder is called, for display. The store's own constant is the same word. */
const OUTPUT_LABEL = 'geotagged';

function collect(
  priors: PriorLocation[],
  candidate: Candidate,
  tags: Record<string, unknown>,
): void {
  const prefix = candidate.source === 'sidecar' ? 'XMP' : 'Composite';

  const latitude = numberAt(tags, `${prefix}:GPSLatitude`);
  const longitude = numberAt(tags, `${prefix}:GPSLongitude`);
  // A file with no GPS is the ordinary case for a copy written before this feature placed it.
  if (latitude === undefined || longitude === undefined) return;

  const altitude = numberAt(tags, `${prefix}:GPSAltitude`);

  priors.push({
    name: candidate.photo,
    coordinates: { latitude, longitude, ...(altitude !== undefined ? { altitude } : {}) },
    source: candidate.source,
    location: candidate.location,
  });
}

/**
 * A finite number under a tag, or nothing.
 *
 * Strings are accepted because ExifTool's `-n` output is not uniformly numeric — but a value that
 * does not parse must vanish rather than default, since `0, 0` is a real place off the coast of
 * Ghana and a half-read coordinate that lands there is worse than no answer at all.
 */
function numberAt(tags: Record<string, unknown>, key: string): number | undefined {
  const value = tags[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
