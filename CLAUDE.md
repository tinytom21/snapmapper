# photo-geotagger

A cross-platform replacement for [GeoSetter](https://geosetter.de/en/main-en/): put photos on a
map, place them by hand, write GPS into the files. Targets Android phone/tablet **and** any PC.

Source camera is a **Sony A6400** (no GPS receiver, so location is applied after the fact).

## Current state

**Phase 0 — spike run on 2026-08-06. Q2, Q3 and Q4 answered; Q1 still open.** The spike decides the
native shell and confirms the metadata backend before any real architecture is committed.

- `packages/core/src/gps.ts` and `packages/core/src/time.ts` are **tested and passing** (50 tests).
- The spike needed three upstream fixes before it would run at all, all recorded in `spike/README.md`.
- **Q1 — whether `Sony:MakerNotes` survive a write byte-identically — has never run**, because it
  needs real A6400 files and none are available. It is now the question the backend decision turns on.
- **Q3 found a real problem:** ExifTool-WASM writes a 24MP JPEG in ~4.5 s (~13 min for 200 photos on
  a fast desktop, worse on a tablet). The cost is in the dependency's unbuffered WASI filesystem
  shim, not in ExifTool, and batching cannot recover it.

Do not begin Phase 1 until the backend question is closed. `packages/ui` and `packages/shells` are
correctly still absent.

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

- **Q1: does a write preserve `Sony:MakerNotes` byte-identically?** Blocked on real A6400 fixtures.
  Everything else observable passed on a synthetic file. This is the pivot.
- **Shell: Tauri 2 vs Capacitor.** Tauri 2 remains the going-in recommendation. Nothing measured yet
  distinguishes them; the deciding test (SAF writes to a removable card) needs the tablet. Note the
  WASM alone is 24.2MB, against the ~10MB whole-app figure the plan assumed.
- **Whether ExifTool-WASM is viable on a tablet.** Desktop webview matched Node, so the tablet will
  be a CPU multiple of an already-failing write time. Unmeasured.

Settled by the spike:

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
