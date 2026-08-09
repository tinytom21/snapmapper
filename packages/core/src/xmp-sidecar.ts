/**
 * Writing an XMP sidecar, for raw files that must never be opened for writing.
 *
 * Real ExifTool builds the document, exactly as it does everywhere else here. The temptation is to
 * hand-roll it — XMP is RDF/XML, not the binary IFDs that `piexifjs` mangles, so the usual argument
 * does not obviously apply — and it is still the wrong call. The GPS encoding is the fiddly part:
 * XMP does not store signed decimals, it stores `33,52.128S`, degrees and decimal minutes with the
 * hemisphere as a letter. Getting that subtly wrong produces a document that parses, looks
 * plausible, and puts the photograph in the wrong hemisphere.
 *
 * ## The three things measured before this was written
 *
 * `spike/src/xmp-sidecar.mjs`, verified end to end against native ExifTool 13.59 — 10 checks, 0
 * failures:
 *
 *   1. **ExifTool creates an XMP from no input file at all.** Just `-o out.xmp` and some tags. This
 *      matters because it means a sidecar needs no source, so a 25MB ARW never has to be read,
 *      copied or handed to the WASM at all.
 *   2. **The wrapper's write path cannot do it.** `writeMetadata` always appends the input path and
 *      always names its output `<uuid>.tmp` — and the output *extension* is what tells ExifTool to
 *      produce an XMP. So this goes through the batch runner, which can name its own output and
 *      read a produced file back out of the virtual filesystem.
 *   3. **XMP has no `GPSLatitudeRef`.** Passing the EXIF ref tags earns `Sorry, XMP:GPSLatitudeRef
 *      doesn't exist or isn't writable`, and `classify` treats unrecognised stderr as fatal — so
 *      sending them would fail every sidecar write. `buildSidecarTags` exists partly to make that
 *      unrepresentable.
 *
 * The hemisphere survives regardless: given signed decimals under `-n`, ExifTool writes the letter
 * itself, and reading back yields `Composite:GPSLatitudeRef: S` from a latitude of −33.8688.
 */

import type { BatchRunner } from './exiftool-batch.ts';
import type { TagSet } from './exif-tags.ts';
import { assertValidCoordinates, formatDecimal, type Coordinates } from './gps.ts';
import { MetadataWriteError } from './exiftool.ts';
import type { Place } from './place.ts';

/** Where the sidecar is built inside the virtual filesystem. Never touches a real path. */
const OUTPUT_PATH = '/sidecar.xmp';

/**
 * The tags a sidecar carries.
 *
 * **XMP only, and that is a constraint rather than a simplification.** An `.xmp` file holds an XMP
 * packet and nothing else, so the IPTC IIM tags that `buildPlaceTags` writes into a JPEG have
 * nowhere to go here — offering them would earn the same "isn't writable" error as the ref tags.
 * Nothing is lost: `XMP:CountryCode` is the alpha-2 field anyway, and the IIM one is the
 * three-octet legacy field this project already refuses to write.
 *
 * `city`, `state` and `country` land in Adobe's `photoshop:` namespace and the code in
 * `Iptc4xmpCore:` — verified in the produced document — which is precisely what Lightroom reads.
 */
export function buildSidecarTags(coordinates: Coordinates, place?: Place): TagSet {
  assertValidCoordinates(coordinates);

  const tags: TagSet = {
    // Signed decimals, under `-n`. No ref tags: see the header.
    'XMP:GPSLatitude': formatDecimal(coordinates.latitude),
    'XMP:GPSLongitude': formatDecimal(coordinates.longitude),
    'XMP:GPSMapDatum': 'WGS-84',
  };

  if (coordinates.altitude !== undefined) {
    tags['XMP:GPSAltitude'] = formatDecimal(coordinates.altitude);
  }

  /*
   * Only what the geocoder actually returned.
   *
   * An empty string is ExifTool's *delete* value, so writing all four unconditionally would be a
   * request to clear them. In a file created from nothing that is merely pointless; the habit is
   * what matters, because the same tags go into JPEGs where it would strip a city set by hand.
   */
  if (place?.city) tags['XMP:City'] = place.city;
  if (place?.state) tags['XMP:State'] = place.state;
  if (place?.country) tags['XMP:Country'] = place.country;
  if (place?.countryCode) tags['XMP:CountryCode'] = place.countryCode;

  return tags;
}

/**
 * Build the sidecar and return its bytes.
 *
 * Nothing is mounted and nothing is read: the document is created from the tags alone, so this
 * costs one ExifTool invocation and no file I/O whatever the size of the raw file it describes.
 */
export async function writeXmpSidecar(
  runner: BatchRunner,
  tags: TagSet,
): Promise<Uint8Array> {
  const args = [
    '-n',
    ...Object.entries(tags).map(([tag, value]) => `-${tag}=${value}`),
    '-o', OUTPUT_PATH,
  ];

  const result = await runner.run([], args, [OUTPUT_PATH]);
  const bytes = result.produced?.get(OUTPUT_PATH);

  if (!bytes || bytes.byteLength === 0) {
    throw new MetadataWriteError(
      'ExifTool produced no XMP sidecar',
      result.stderr.trim() || `exit ${String(result.exitCode)}`,
    );
  }

  /*
   * Judged on the document, not on the exit code.
   *
   * A tag ExifTool cannot write is a warning that still produces a file — a sidecar silently
   * missing its coordinates would be worse than a failed write, because it would look like a
   * success and leave a plausible file on disk.
   */
  const text = new TextDecoder().decode(bytes);
  if (!text.includes('<x:xmpmeta')) {
    throw new MetadataWriteError('what ExifTool produced is not an XMP packet', text.slice(0, 200));
  }
  for (const tag of Object.keys(tags)) {
    const local = tag.slice(tag.indexOf(':') + 1);
    if (!text.includes(`:${local}>`)) {
      throw new MetadataWriteError(
        `the sidecar is missing ${tag}`,
        result.stderr.trim() || text.slice(0, 200),
      );
    }
  }

  return bytes;
}
