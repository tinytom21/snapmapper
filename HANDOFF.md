# Handoff

This project was scaffolded on a machine where **Node.js could not be installed**, so nothing here
has been executed. Treat every claim below as designed-but-unverified until the spike runs.

## What exists

| Path | State |
|---|---|
| `docs/PLAN.md` | Approved design. Read this second. |
| `packages/core/src/gps.ts` | Written, **untested**. Decimal ↔ EXIF DMS + hemisphere refs. |
| `packages/core/src/time.ts` | Written, **untested**. Camera-clock drift, timezone, GPS timestamps. |
| `packages/core/test/*.test.ts` | Written, **never run**. Expect to fix real bugs on first run. |
| `spike/` | Harness for Phase 0. Written against documented API shapes that were **not verified** — the first script deliberately probes and prints the real shapes. |
| `packages/ui`, `packages/shells` | Do not exist. Blocked on the spike's shell decision. |

## Do this first, in order

### 1. Install prerequisites

```bash
winget install OpenJS.NodeJS.LTS
```

```bash
winget install OliverBetz.ExifTool
```

Confirm both, then install workspace dependencies:

```bash
node --version && exiftool -ver && npm install
```

`PhilHarvey.ExifTool` does not exist in the winget repository — `OliverBetz.ExifTool` is the
packaged Windows installer of the same tool. It installs per-user and registers PATH only in the
registry, so open a fresh shell afterwards, or set `EXIFTOOL` to the absolute path.

### 2. Run the core tests — expect failures

```bash
npm test --workspace @geotagger/core
```

These have never executed. The DMS carry logic and the DST-boundary conversion are the two places
a real bug is most likely.

### 3. Add fixtures

Copy a handful of **real A6400 JPEGs** into `spike/fixtures/` — never the originals, and never the
only copy. Include a mix: already-geotagged and not, portrait orientation, and one large file.
Sony MakerNotes preservation is the whole point of the exercise, so generic JPEGs won't do.

### 4. Run the spike

```bash
npm run spike
```

Then answer the four questions in `spike/README.md` and record the results there.

### 5. Choose the shell, then build Phase 1

Tauri 2 unless the spike gives a reason not to. Desktop MVP before Android — it proves the
portable core with a faster iteration loop.

## Open questions for the user

- **Sample photos.** The spike needs real A6400 JPEGs; none were available on the original
  machine. Nothing in Phase 0 can be validated without them.
- **App name.** `photo-geotagger` is a placeholder throughout.
- **Camera timezone default.** `time.ts` requires an IANA zone. Worth defaulting to the system
  zone and letting the user override per session.

## Things not to relearn the hard way

- ExifTool is **not** Windows-only. That premise shaped the original brief and is wrong — it's a
  Perl library that runs anywhere. GeoSetter is Windows-locked because its GUI is Delphi.
- **Do not substitute exiv2.** It corrupts Sony ARW on GPS write.
- Android 11+ **refuses** `ACTION_OPEN_DOCUMENT_TREE` grants on an SD card's root volume. Ask for
  `DCIM/100MSDCF` instead. This will look like a permissions bug if you don't know it.
- Chrome on Android still has no `showDirectoryPicker()`, which is why a pure PWA was ruled out.
