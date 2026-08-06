# photo-geotagger

A cross-platform replacement for [GeoSetter](https://geosetter.de/en/main-en/): put photos on a
map, place them by hand, write GPS into the files. Targets Android phone/tablet **and** any PC.

Source camera is a **Sony A6400** (no GPS receiver, so location is applied after the fact).

## Current state

**Phase 0 — spike, not yet run.** The spike decides the native shell and confirms the metadata
backend before any real architecture is committed. Nothing has been validated on real files yet.

Written so far: `packages/core/src/gps.ts` and `packages/core/src/time.ts` (pure logic, needed
under any backend). Everything else is scaffolding.

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

## Still open — the spike decides

- **Shell: Tauri 2 vs Capacitor.** Tauri 2 is the going-in recommendation (one codebase to desktop
  binaries + an Android APK, ~10MB). Fall back to Capacitor if Tauri's Android SAF path can't
  reliably write to a removable card.
- **Whether ExifTool-WASM is viable on a tablet at all.** If it is too heavy, `piexifjs` writes
  GPS to JPEG in ~30KB of plain JS — at the cost of the ARW/video future.
- **Whether raw ExifTool arguments reach the write path** (`-P`, `-overwrite_original`,
  `-XMP:GPS*`). If not, drop to zeroperl and drive ExifTool's own CLI.

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
