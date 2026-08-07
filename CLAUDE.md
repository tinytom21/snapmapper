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
- **NEVER hand `writeMetadata` a `File` or `Blob`. Read it to a `Uint8Array` first.** zeroperl reads
  Blob-backed files with `await blob.slice(...).arrayBuffer()` **once per read syscall** — thousands of
  allocations for one photo. Measured on a phone with the same 5.4MB file: **1.11 s with a `Uint8Array`,
  ~76 s with the `File`** (~69×). Desktop hides it completely, which is how it went unnoticed for most of
  Phase 0 and produced a confident but wrong "Android is not viable" conclusion. `fd_write` rejects Blobs
  outright, so this is purely about reading the input.
- **Q3 cost, with bytes passed correctly:** desktop ~2 s per 5–7MB JPEG; phone **1.11 s** for 5.4MB.
  Comfortable at the real session size of 10–50 photos.
- **Q6 — splice, don't send the photograph.** Metadata is only ~2% of an A6400 JPEG. Give ExifTool a stub
  of the headers, let it do all the EXIF and MakerNote work unchanged, then splice its output onto the
  original scan data with a byte copy. **184 checks, zero failures** — identical to Q1, same 0.11%
  offset-only MakerNotes drift. On the phone: **343 ms vs 1.11 s**, and **6.85 s for 20 photos**. Verified
  that the rewritten APP1 is byte-identical whether ExifTool sees 1.6% of the file or all of it, so the
  metadata rewrite does not depend on the body. Reference: `spike/src/splice-core.mjs`.
- **Q5: never use `piexifjs`.** It writes in 6 ms and corrupts the file — 116 MakerNote tags changed, 47
  tags dropped including `OffsetTime`, and ExifTool reporting `Possibly incorrect maker notes offsets`.
  The exiv2 failure mode exactly. A casual check passes, which is what makes it dangerous.
- **Both platforms are viable on one backend.** The remaining Phase 0 item is the shell choice, which
  needs the SAF-to-removable-card test on real hardware.

**Phase 1 in progress — the desktop MVP runs.** `npm run dev`, then Chrome or Edge at
http://localhost:5173/ (see HANDOFF.md; `localhost` is required for a secure context).

- `packages/core` is complete for the MVP: `gps`, `time`, `jpeg` (the splice), `exif-tags`,
  `exiftool` (the write path), `exiftool-wasm`, `session` (staged edits + undo), `storage`.
  **122 tests, `tsc` clean.**
- `packages/ui` is React 19 + MapLibre 5 on Vite 7, with a `FileStore` over the File System
  Access API. **20 tests** covering save orchestration, partial failure and QR scan scaling.
  Thumbnails come from the camera's own embedded ~6KB JPEG, and shift-click selects a range.
  Placement is select-then-click on the map, and only that — see below.
- `packages/shells` does not exist. Deliberately: the shell decision is still open, and the
  browser gives a faster loop for the desktop MVP. Only `browser-file-store.ts` is throwaway.

### Browser-specific gotchas already paid for

- **Serve `zeroperl.wasm` at the site root.** In a browser zeroperl fetches
  `./zeroperl.wasm` relative to the *document*, not the module. `vite-plugin-zeroperl.ts`
  does it. Any shell needs the same arrangement.
- **A secure context is required for writes** (`crypto.randomUUID`). `localhost` counts.
- **`readTags` must use `-G`, not `-G0:1`.** The latter emits
  `EXIF:ExifIFD:DateTimeOriginal`, so no date ever resolves — and it hides behind
  `Composite:*`, which keeps working. Pinned by a regression test.
- **The browser cannot preserve file mtime.** Surfaced in the UI as `MTIME_LIMITATION`.

### Do not add drag-and-drop onto the map

It was built and removed. An HTML5 drag over a canvas that MapLibre is already tracking
pointer events on made the interface misbehave, and select-then-click is the better gesture
regardless: it handles one photo and fifty identically, with no second code path.

Note that `draggable={false}` on the thumbnail `<img>` is load-bearing. Browsers make images
draggable by default, so without it a click-and-drag on a thumbnail starts a native image
drag with a ghost image, which reads as a bug.

### Camera-clock sync stores the measurement, not the offset

`clock-sync.ts` holds the camera's reading plus the true instant, and `setTimeZone` re-derives
`offsetSeconds` from it. An offset is only valid for the zone it was derived in, so keeping
just the number would leave every GPS timestamp wrong by the zone gap *and* by a stale offset
the moment somebody corrected the zone. `setOffsetSeconds` drops the measurement on purpose.

The true instant comes from a QR code the app displays and the user photographs. QR because
its error correction means a misread cannot silently yield a plausible wrong time — it either
decodes exactly or not at all.

### Every save is verified by reading the file back

`verify-write.ts` re-reads each written file and checks the coordinates landed *and* that
ExifTool raises no structural warning. The warning half is the load-bearing part: a file whose
maker notes have been wrecked still reports perfect coordinates, so a check that only compared
tag values would pass it. That is exactly how `piexifjs` looked from the outside.

Two details that are easy to undo by accident:

- **The verification read must not pass `-fast2`.** Measured: with it, a corrupted file reports
  no warning at all; without it, `[minor] Possibly incorrect maker notes offsets`. `-fast2`
  stops before parsing maker notes. Pinned by a test.
- **A clear is verified as an absence.** Otherwise a clear that silently did nothing passes.

A failure is reported as *written but not verified*, not as a plain failure — the bytes are on
disk, and implying otherwise would be worse than saying nothing.

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
