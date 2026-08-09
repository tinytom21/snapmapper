/**
 * Raw files, and the sidecar that carries their location.
 *
 * ## Why a sidecar and not the file
 *
 * The raw file is never opened for writing. That is the entire point, and it is not caution for its
 * own sake: exiv2 corrupts Sony ARW when writing GPS
 * ([KDE #326408](https://bugs.kde.org/show_bug.cgi?id=326408)), which is why digiKam moved to
 * ExifTool and why this project banned exiv2 outright. A file created from nothing cannot be
 * corrupted, and a sidecar is what raw editors read anyway — so the safest option is also the one
 * that works best.
 *
 * It also means a raw photograph needs no copy. The JPEG path writes into a `geotagged` folder so
 * the originals cannot be damaged by a bug here; for raw there is nothing to damage, and copying a
 * 25MB ARW to attach a 500-byte sidecar to it would be absurd. The sidecar goes beside the file.
 *
 * ## The naming convention, which is a real fork
 *
 * `DSC01234.ARW` gets `DSC01234.xmp` — the extension is **replaced**, which is the Adobe
 * convention and what Lightroom, Bridge, Camera Raw, Capture One and GeoSetter look for. The other
 * live convention appends instead (`DSC01234.ARW.xmp`) and is what darktable, RawTherapee and
 * digiKam default to. They are mutually exclusive and the choice was the user's: Lightroom.
 *
 * The cost of that choice is recorded in `sidecarCollision` below, because it is not free.
 */

/**
 * Extensions treated as raw.
 *
 * Sony only for now, which is the camera this exists for, and deliberately not a long list of
 * formats nobody here can test. Adding one is a line — but a format that has never been read is a
 * format that might not parse, and listing it would promise support that has not been checked.
 */
export const RAW_EXTENSIONS: readonly string[] = ['.arw'];

/** The XMP sidecar's own extension. */
export const SIDECAR_EXTENSION = '.xmp';

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  // A leading dot is a hidden file, not an extension.
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

export function isRawFile(name: string): boolean {
  return RAW_EXTENSIONS.includes(extensionOf(name));
}

/**
 * The sidecar filename for a photograph.
 *
 * Replaces the extension rather than appending: `DSC01234.ARW` → `DSC01234.xmp`. A name with no
 * extension at all simply gains one.
 */
export function sidecarName(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot <= 0 ? name : name.slice(0, dot)) + SIDECAR_EXTENSION;
}

/**
 * Names in the same folder that would share this photograph's sidecar.
 *
 * The price of the Adobe convention: `DSC01234.ARW` and `DSC01234.JPG` are one frame shot in two
 * formats — which an A6400 does on every RAW+JPEG press — and they resolve to the same
 * `DSC01234.xmp`. That is harmless when both want the same coordinates, and it is exactly what
 * Lightroom expects. It stops being harmless if the two were placed differently, so the caller is
 * given the means to notice rather than being left to overwrite silently.
 *
 * Returns the *other* names, never the photograph's own.
 */
export function sidecarCollision(name: string, allNames: Iterable<string>): string[] {
  const target = sidecarName(name);
  const clashes: string[] = [];

  for (const other of allNames) {
    if (other === name) continue;
    // A file literally called `DSC01234.xmp` collides too, and it is the one already on disk.
    if (sidecarName(other) === target || other === target) clashes.push(other);
  }

  return clashes;
}
