# photo-geotagger

A cross-platform replacement for [GeoSetter](https://geosetter.de/en/main-en/): put photos on a
map, place them by hand, write GPS into the files. Targets Android phone/tablet **and** any PC.

Source camera is a **Sony A6400** (no GPS receiver, so location is applied after the fact).

## Current state

**Phase 0 complete. All four questions answered against 7 real ILCE-6400 JPEGs.** Results and
reasoning are in `spike/README.md`.

- **The backend is confirmed: keep ExifTool-WASM.** Q1 passes — correct GPS, MakerNotes functionally
  intact, verified with a separate native ExifTool 13.59.
- `packages/core` is **tested and passing** (53 tests).
- The spike needed three upstream fixes before it would run at all — see the gotchas below.
- **Q3 on desktop:** ~2 s per 5–7MB JPEG, ~4.5 s per 12MB one. Acceptable at the real session size
  (10–50 photos) if writes are backgrounded; painful for a whole card. The cost is in the dependency's
  unbuffered WASI filesystem shim, not in ExifTool, and batching cannot recover it.
- **Q3 on mobile rules Android out for writes.** A phone (Android 10, Chrome 150) wrote a 5.4MB JPEG in
  **76 s**: **13.87 s/MB against the desktop's 0.26 s/MB**, 53× worse, while reads were only 3.5× slower.
  Startup is *faster* than desktop, so the fault is entirely in the per-byte write path — the unbuffered
  WASI filesystem shim. 99% of the cost is bytes, so batching cannot help. ~25 min for 20 photos.
- **This undercuts the reason WebAssembly was chosen.** Running one real ExifTool on both desktop and
  Android was the whole justification; a desktop can just use a native binary. Desktop and Android now
  need separate decisions.
- **The Android write path is the open question**, ahead of the shell choice. The shell still also needs
  the SAF-to-removable-card test on real hardware.

`packages/ui` and `packages/shells` do not exist yet.

### Do not use byte-identity as the MakerNotes test

This nearly killed the project. Writing GPS to a file with no existing GPS adds a 12-byte IFD entry to
IFD0, which shifts MakerNotes 12 bytes later. Sony's internal offsets are relative to the start of the
*file*, so a correct writer **must** rewrite them — measured: 41 of 37,664 bytes change, every one a
value incremented by exactly 12. Byte-identity failing is the *expected* result; byte-identity holding
while the block moves would be the corruption. Test decoded tag values, plus whether `PreviewImage`
and `ThumbnailImage` still resolve byte-identically, plus ExifTool's own warnings.

Read **[HANDOFF.md](HANDOFF.md)** first — it has the exact next steps. The approved design is in
**[docs/PLAN.md](docs/PLAN.md)**.

## Prerequisites

Not yet installed on the original machine; install these first:

```bash
winget install OpenJS.NodeJS.LTS
```

```bash
winget install OliverBetz.ExifTool
```

Node 22.18+ or 24+ (the test scripts rely on built-in TypeScript stripping, no build step).
Native ExifTool is the **independent verifier** for the spike — verifying ExifTool-WASM's output
with a separate native ExifTool is what makes the golden-file check meaningful.

There is no `PhilHarvey.ExifTool` in the winget repository; `OliverBetz.ExifTool` is the packaged
Windows installer of Phil Harvey's ExifTool. It installs per-user to
`%LOCALAPPDATA%\Programs\ExifTool` and only registers PATH in the registry, so an already-open
shell will not find it. The spike reads an `EXIFTOOL` environment variable as an absolute-path
override for exactly that case.

## Decisions already made

- **ExifTool stays as the backend.** It is not Windows-only — it is a Perl library that runs
  natively on Linux/macOS/BSD. GeoSetter is Windows-locked because its GUI is Delphi.
- **ExifTool runs via WebAssembly** ([`@uswriting/exiftool`](https://github.com/6over3/exiftool),
  wrapping ExifTool 13.42 on [zeroperl](https://github.com/6over3/zeroperl)) so the same real
  ExifTool runs on desktop and inside an Android webview. No Perl install, no Termux, no server.
- **Never use exiv2.** It corrupts Sony ARW when writing GPS
  ([KDE #326408](https://bugs.kde.org/show_bug.cgi?id=326408)); digiKam moved to ExifTool over
  exactly this. Relevant to the deferred ARW phase.
- **Android needs a native shell.** Chrome on Android has no `showDirectoryPicker()`, so a pure
  PWA cannot rewrite files in a card folder in place.
- **Licence: elect the Artistic License** where ExifTool and Perl offer the choice. No copyleft on
  our code, and it avoids the GPL/App Store conflict if iOS is ever added.

## Still open

- **Shell: Tauri 2 vs Capacitor.** Tauri 2 remains the going-in recommendation. Nothing measured yet
  distinguishes them; the deciding test (SAF writes to a removable card) needs the tablet. Note the
  WASM alone is 24.2MB, against the ~10MB whole-app figure the plan assumed.
- **Whether the write cost is tolerable on a tablet.** The desktop webview matched Node, so the tablet
  will be a CPU multiple of ~2–4.5 s per photo. Unmeasured — `npm run browser --workspace spike`.

Settled by the spike:

- **ExifTool-WASM stays.** Q1 passed on real A6400 files.

- **Raw ExifTool arguments do reach the write path** via `{ args: [...] }`, proved by effect. But
  `-P` and `-overwrite_original` correctly fail in the sandbox and must not be passed — there is no
  real filesystem, and restoring mtime is the host's job.
- **`piexifjs` is no longer the assumed escape hatch.** It re-serialises EXIF IFDs, which is the exact
  mechanism that corrupts offset-relative MakerNotes — the same reason exiv2 is banned here. It must
  clear the same byte-level check before being trusted.

## Scope

**v1:** JPEG only, written in place. Manual placement on a map. Camera-clock/timezone offset
correction. Map showing photos. Online tiles, designed so offline drops in later. Photos read from
the camera's SD card on Android.

**Deferred:** ARW (offer XMP sidecars first), video, GPX import, built-in track logging, reverse
geocoding, IPTC editing, offline tiles.

## Conventions

- `packages/core` is platform-agnostic TypeScript with **zero platform dependencies**. All file
  access goes through the `FileStore` interface; nothing else in the app touches files.
- ESM throughout (`"type": "module"`).
- Tests use the built-in `node:test` runner. No test framework dependency.

## Rules that matter

- **Never write directly over an original.** Write a temp file in the same directory, then
  replace. A half-written file on a camera card is the worst failure this app has.
- **Never run spike or test code against the only copy of someone's photos.** Copy fixtures first.
  `spike/fixtures/` is gitignored for this reason.
- **Verify with a second implementation.** Round-tripping ExifTool-WASM output through native
  ExifTool is the check that actually proves correctness — particularly that `Sony:MakerNotes`
  survives byte-identical.
