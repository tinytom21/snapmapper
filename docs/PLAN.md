# Cross-platform photo geotagger (GeoSetter replacement)

## Context

GeoSetter does the job for Sony A6400 photos but is Windows-only and unmaintained. The goal is
the same workflow — put photos on a map, place them by hand, write GPS into the files — running
on Android phone/tablet **and** any PC.

One premise in the original brief needs correcting, because it changes the design substantially:

> **ExifTool is not Windows-only.** It is a Perl library (`Image::ExifTool`) that runs natively on
> Linux, macOS and BSD; Windows just gets a bundled `.exe` wrapper. GeoSetter is Windows-locked
> because *its GUI* is written in Delphi, not because of its backend.

So ExifTool stays. It does not need rewriting, and it does not need replacing.

**Findings that shape the plan:**

| Finding | Consequence |
|---|---|
| ExifTool is compiled to WebAssembly via [zeroperl](https://andrews.substack.com/p/zeroperl-sandboxed-perl-with-webassembly) — [`6over3/exiftool`](https://github.com/6over3/exiftool) / `@uswriting/exiftool`, wrapping ExifTool 13.42, with a `writeMetadata()` that returns the modified file as a `Uint8Array` | Real ExifTool can run unmodified inside a webview on Android. No Perl install, no Termux, no server. |
| exiv2 corrupts Sony ARW when writing GPS ([KDE #326408](https://bugs.kde.org/show_bug.cgi?id=326408)); digiKam switched to ExifTool over exactly this | Do not use exiv2, even though it is the obvious C++ library. Matters for the later ARW phase. |
| Chrome on Android has no `showDirectoryPicker()` ([crbug 40101963](https://issues.chromium.org/issues/40101963)) | A pure PWA cannot open a card folder and rewrite files in place. Android needs a native shell. |
| Android 11+ refuses `ACTION_OPEN_DOCUMENT_TREE` grants on the **root** of an SD card volume | User grants `DCIM/` or `DCIM/100MSDCF/` on the card instead. Fine for this workflow, but the UI must ask for a subfolder, not the card root. |

**Licensing** — ExifTool is "free software; you can redistribute it and/or modify it under the same
terms as Perl itself (either the Perl Artistic License or GPL)", © 2003-2026 Phil Harvey. It is
dual-licensed and **we elect the Artistic License**, which imposes no copyleft on our own code and
avoids the GPL/App Store conflict if iOS is ever added. We call ExifTool unmodified, so the whole
obligation is preserving notices. Full chain:

| Component | License | Obligation |
|---|---|---|
| ExifTool 13.42 | Artistic **or** GPL (we elect Artistic) | Notice + license text |
| Perl 5 (inside zeroperl) | Artistic **or** GPL (same) | Notice + license text |
| `6over3/zeroperl` | MIT | Notice |
| `6over3/exiftool` wrapper | Apache-2.0 | Notice + NOTICE file |

Action: ship a third-party licenses screen. Before release, read the actual `LICENSE` files in the
vendored versions (the table above comes from repo metadata) and confirm the bundled ExifTool is
unmodified — if the WASM build patched it, the Artistic License's modification clauses re-engage.
This is a reading of the license text, not legal advice; worth a proper review before any
commercial or employer-branded distribution.

**Agreed scope for v1:** JPEG only, written in place. Manual placement on a map. Camera-clock /
timezone offset correction. Map showing photos (and later GPX tracks). Online tiles, with the tile
layer designed so offline drops in later. Photos read from the camera's SD card on Android.
Deferred: ARW, XMP sidecars, video, GPX import, built-in track logging, reverse geocoding, IPTC editing.

---

## Architecture

A platform-agnostic TypeScript core, a web UI, and thin native shells. Everything real lives in
`core`; the shells only supply file access and packaging.

```
photo-geotagger/
  packages/
    core/        # TS, zero platform deps — the whole brain
      exiftool/  # driver around @uswriting/exiftool (WASM)
      gps.ts     # decimal <-> EXIF rational/ref conversion, WGS-84
      time.ts    # camera-clock offset, timezone, GPSDateStamp derivation
      session.ts # photo list, pending edits, dirty/committed state, undo
      storage.ts # FileStore INTERFACE ONLY — list / read / writeAtomic
    ui/          # React + MapLibre GL JS; imports core, knows no platform
    shells/
      desktop/   # decided by the spike
      android/   # decided by the spike
  spike/         # phase 0, throwaway
```

`FileStore` is the single seam between portable code and each platform:

```ts
interface FileStore {
  listFolder(handle: FolderHandle): Promise<PhotoRef[]>;   // name, size, mtime
  read(ref: PhotoRef): Promise<Uint8Array>;
  writeAtomic(ref: PhotoRef, bytes: Uint8Array): Promise<void>; // temp + replace
}
```

Desktop implements it over the OS filesystem; Android over SAF document-tree URIs. Nothing else
in the app touches files. `writeAtomic` must never stream over the original in place — write a
temp file in the same directory, then replace. A half-written file on a camera card is the worst
failure mode this app has.

**Write path per photo:** read bytes → `writeMetadata(bytes, gpsTags)` → get modified bytes back →
`writeAtomic`. The WASM module is a pure byte-in/byte-out transform, which is what makes one
backend work identically on every platform.

**Tags written for a manual pin** (mirroring what GeoSetter emits, so existing files stay consistent):
`GPSLatitude` / `GPSLatitudeRef`, `GPSLongitude` / `GPSLongitudeRef`, `GPSAltitude` /
`GPSAltitudeRef` (optional), `GPSMapDatum=WGS-84`, and `GPSDateStamp` / `GPSTimeStamp` derived in
UTC from the photo's `DateTimeOriginal` plus the session offset. Mirror to `XMP:GPS*` as well so
Lightroom and Capture One agree with Explorer. Preserve the file's modification date (`-P`).

---

## Phase 0 — Spike (do this first; it picks the stack)

Throwaway code in `spike/`, run in Node against **real A6400 JPEGs**. This exists to answer the
questions that decide everything downstream, before any architecture is committed.

Must answer:

1. **Does `writeMetadata()` actually write correct GPS to an A6400 JPEG?** Tag a file, then verify
   with a *native* ExifTool install that the coordinates round-trip exactly and that
   `Sony:MakerNotes` survives byte-identical. Compare the decoded pixel data hash before/after to
   prove the image is untouched.
2. **Can arbitrary ExifTool arguments reach the write path?** The tag-object API is documented;
   passing raw args (`-P`, `-overwrite_original`, `-XMP:GPSLatitude=`) is not. If the wrapper
   won't pass them, drop to `zeroperl` directly and drive ExifTool's own CLI argument list.
3. **What does it cost?** WASM bundle size, cold-start time, and per-photo write time for a ~10MB
   JPEG. Then the same numbers in a browser/webview, not just Node — the Android target is the
   one that will hurt. A batch of 200 photos needs to be tolerable.
4. **Memory ceiling.** 32-bit WASM caps around 4GB; confirm a 25MB file (headroom for ARW later)
   round-trips without blowing up, and that modules can be reused across photos rather than
   re-instantiated per file.

**Then choose the shell**, on evidence rather than preference:

- **Tauri 2** (recommended going in) — one codebase to Windows/macOS/Linux binaries plus an
  Android APK, ~10MB output, and the desktop story is the strongest available. Costs a Rust
  toolchain, and Android folder access leans on the community `tauri-plugin-android-fs`.
- **Capacitor** — pure JS/TS, no Rust, strong Android story, iOS free later; desktop only via
  Electron, which is heavier and less polished.

Fall back to Capacitor if the spike shows Tauri's Android SAF path can't reliably write to a
removable card, since that is the one requirement with no workaround.

**A note worth flagging now:** for JPEG-only work, `piexifjs` writes GPS in ~30KB of pure JS with
no WASM at all. If the spike shows ExifTool-WASM is painfully heavy on the tablet, that is the
escape hatch — at the cost of the ARW/video future, which is precisely why it is not the default.

---

## Phase 1 — Desktop MVP

Build `core` + `ui` + desktop shell. Desktop first because iterating is faster and it proves the
portable core before the Android file-access work starts.

- Open a folder; list JPEGs with thumbnails, filename, `DateTimeOriginal`, existing GPS if present.
- MapLibre GL JS map with an OSM-derived vector source (OpenFreeMap or Protomaps). Vector +
  PMTiles is chosen deliberately: the later offline story is "ship one `.pmtiles` file for a
  region", which is far cleaner than caching raster tiles.
- Select photos → click the map (or drag a thumbnail onto it) to assign coordinates. Assigned
  photos appear as pins; selecting a pin selects its photos. Drag a pin to adjust.
- Time offset panel: per-session camera-clock offset and timezone, plus a "sync from a photo"
  tool (shoot a GPS clock display, enter the true time, derive the offset). Feeds `GPSDateStamp`
  now and GPX matching later.
- Edits are staged and visibly pending; an explicit **Save** commits them. Nothing touches disk
  until then.
- On first write, keep ExifTool's `_original` backup by default, with a setting to turn it off
  once trust is established.
- Progress and a per-file result list on save — geotagging 200 files silently is not acceptable
  when one of them can fail.

## Phase 2 — Android

Same `core` and `ui`, new `FileStore`.

- `ACTION_OPEN_DOCUMENT_TREE` against a folder on the card (`DCIM/100MSDCF`, **not** the card
  root — Android 11+ rejects that), with the grant persisted across restarts.
- `writeAtomic` over `DocumentsContract`: create a temp document in the same tree, write, replace.
- Touch-first UI pass: the map interaction and multi-select need to work with a finger, and the
  thumbnail list needs to survive a folder of several hundred files on tablet-grade hardware.
- Test on the real tablet with the real card in a real card reader. Card-reader write behaviour
  is the sort of thing that only fails on the actual device.

## Phase 3 — Deferred (design for, don't build)

GPX/KML import with timestamp matching (`-geotag`); built-in track logging on Android; ARW support
(offer **XMP sidecars first** — zero corruption risk and what raw editors read anyway); reverse
geocoding into IPTC City/State/Country; offline tiles via PMTiles; video.

---

## Verification

**Unit** — GPS decimal↔rational/ref conversion across all four hemispheres, the equator, the prime
meridian, and negative altitude; time offset math across DST boundaries and timezone changes.

**Golden-file** — the real test, and the one that decides whether this is trustworthy. For a corpus
of real A6400 JPEGs: tag with the app, then independently verify with a native ExifTool install
that (a) coordinates round-trip to the expected precision, (b) `Sony:MakerNotes` is byte-identical,
(c) decoded pixel data is unchanged, (d) `DateTimeOriginal` and file mtime are unchanged. Run the
same corpus through GeoSetter and diff the resulting tag sets — GeoSetter is the reference
implementation here, so matching its output is the clearest signal of correctness.

**Interop** — confirm tagged files show the right location in Windows Explorer's Details pane,
Google Photos, and Lightroom. EXIF that is technically valid but that Lightroom ignores is a
failure.

**Manual, on device** — a full session on the tablet: insert card, grant folder access, tag ~50
photos, save, verify on the card, then pull the card into a PC and re-verify there.

**Safety** — kill the app mid-save and confirm no file is left truncated or partially written.
Verify against a write-protected card that failures are reported per-file rather than silently
swallowed.

---

## Risks

| Risk | Mitigation |
|---|---|
| ExifTool-WASM too slow or too heavy on the tablet | Phase 0 measures this before anything is built on it; `piexifjs` is the JPEG-only fallback |
| WASM wrapper won't accept raw ExifTool arguments | Drop to `zeroperl` and drive ExifTool's CLI directly |
| Tauri's Android SAF path can't write to a removable card | Spike tests this specifically; fall back to Capacitor |
| A bug corrupts photos on the only copy that exists | Atomic writes, `_original` backups on by default, byte-level MakerNotes verification in CI, and never test on a card without a backup elsewhere |
| Vector tile provider rate-limits or disappears | Tile source is behind a config seam from day one; PMTiles self-hosting is the exit |

These are recommendations for review rather than settled decisions — in particular the shell
choice is deliberately left to the spike's evidence, and the Phase 0 results may justify revisiting
the ExifTool-WASM backend itself.
