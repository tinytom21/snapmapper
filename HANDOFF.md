# Handoff

Scaffolded on a machine where **Node.js could not be installed**. As of **2026-08-07 it has now
been run**: prerequisites installed, core tests passing, and the Phase 0 spike executed against real
A6400 files. All four questions are answered.

## Where it stands

| Path | State |
|---|---|
| `docs/PLAN.md` | Approved design. Read this second. One premise corrected (`ArrayBuffer`, not `Uint8Array`). |
| `packages/core/src/gps.ts` | **Tested, passing.** Decimal ↔ EXIF DMS + hemisphere refs. Held up under an independent sweep of 400k values. |
| `packages/core/src/time.ts` | **Tested, passing.** Camera-clock drift, timezone, GPS timestamps. |
| `packages/core/src/exif-tags.ts` | **Tested, passing.** Cross-checked against GeoSetter's own output; two gaps found and closed. |
| `packages/core/test/*.test.ts` | **53 tests, all passing.** |
| `spike/` | **Run against real A6400 files.** Results in `spike/README.md`. Needed three upstream fixes before it would work at all. |
| `packages/ui`, `packages/shells` | Still do not exist. Next up, once the shell is chosen. |

## Phase 0 is done — the backend is confirmed

Q1 passed on 7 real ILCE-6400 JPEGs, verified with a separate native ExifTool 13.59: correct GPS in
both hemispheres, all 170–221 MakerNote tags decoding identically, the embedded preview and thumbnail
still resolving byte-identically, no new ExifTool warnings, image data untouched. **Keep
ExifTool-WASM.**

Be aware that the plan's stated criterion — "`Sony:MakerNotes` byte-identical" — is **wrong**, and it
failed on every Sony file on the first run. See the note in CLAUDE.md before you trust a failure there.

## The write path Phase 1 should build

**Do not hand the whole file to ExifTool.** Give it a stub of the metadata headers (SOI up to and
including the SOS header, plus ~4KB of scan data and an EOI), let it write GPS exactly as it does now,
then splice its rewritten headers onto the original scan data with a plain byte copy. Reference
implementation: `spike/src/splice-write.mjs`.

That is 1.5% of the bytes on an A6400 JPEG, and it is the difference between ~2 s and ~76 s per photo on
a phone. Real ExifTool still performs every byte of the metadata rewrite, so the correctness Q1 proved
carries over — verified: 184 checks, zero failures, the same 0.11% offset-only MakerNotes drift.

Assert the invariant in production rather than trusting it: compare the scan data before and after and
refuse the write if it moved.

**And never re-serialise EXIF yourself.** Q5 measured `piexifjs` doing exactly that: 6 ms, 47 tags lost,
and ExifTool reporting incorrect maker-note offsets.

## What is left before Phase 1

Only the shell decision, and it needs hardware:

```bash
npm run browser --workspace spike
```

Run that **on the tablet**. The desktop webview matched Node, so the tablet is a straight CPU multiple
of ~2 s per 5–7MB photo. Then test whether the chosen shell's SAF path can write to a removable card —
that is the one requirement with no workaround, and it is what picks Tauri over Capacitor or vice
versa.

## How it was run, in order

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

### 2. Run the core tests

```bash
npm test --workspace @geotagger/core
```

**53 passing.** The DMS carry logic and the DST-boundary conversion were expected to be the two
likeliest bugs, and both turned out to be sound — confirmed by an independent probe outside the
project's own suite (400k values through `toDms` with no invalid 60s and a worst round-trip error of
3e-14°; every real wall clock across two years in eight zones, including Lord Howe's half-hour DST,
resolving correctly).

Two genuine problems were fixed in `time.ts` regardless: `photoInstant`'s doc comment described the
opposite of what the code does, and the code was right — subtracting drift from a wall-clock reading
before resolving it can land in a spring-forward gap and silently move the answer an hour. And
`hour12: false` became `hourCycle: 'h23'`, which is under-specified rather than wrong on Node but
matters in an Android webview. Two tests were added: nothing had combined drift with a DST boundary.

### 3. Add fixtures

Copy a handful of **real A6400 JPEGs** into `spike/fixtures/` — never the originals, and never the
only copy. Include a mix: already-geotagged and not, portrait orientation, and one large file.
Sony MakerNotes preservation is the whole point of the exercise, so generic JPEGs won't do.

### 4. Run the spike

```bash
npm run spike
```

All four questions are answered and recorded in `spike/README.md`.

Note that `npm install` overwrites the `node_modules` patch the spike depends on. The scripts
re-apply it automatically, so this only matters if you call the package directly.

There is also a fifth measurement the plan did not ask for, because the headline write time did not
explain itself:

```bash
npm run cost --workspace spike
```

And the one that actually predicts Android — run it **on the tablet**:

```bash
npm run browser --workspace spike
```

The desktop webview column is filled in; the tablet column is not, and it is the number that decides
whether Android is viable at all.

### 5. Choose the shell, then build Phase 1

**Still open, and the last Phase 0 item.** Nothing measured distinguishes Tauri from Capacitor — the
deciding test is whether the shell's SAF path can write to a removable card, which needs the tablet
and the card. Desktop MVP before Android regardless: it proves the portable core with a faster
iteration loop.

## Open questions for the user

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
- **`@6over3/zeroperl-ts` cannot find its own WASM under Node** without a patch. It resolves the
  binary with `URL.pathname`, which keeps the slash before a Windows drive letter and leaves
  percent-encoding intact — so it fails on all Windows Node and on any path containing a space. The
  symptom is a baffling `ENOENT` for `C:\C:\…%20…`. See `spike/src/patch-zeroperl.mjs`.
- **In a browser the same package needs an import map**, because its ESM bundle imports a bare
  specifier, and it fetches `./zeroperl.wasm` relative to the *document* rather than the module.
- **`-P` and `-overwrite_original` fail inside the WASM sandbox**, correctly — there is no real
  filesystem. Do not pass them. Restoring mtime is the host's job.
- **The wrapper reports `success: false` for a bare warning.** Read the error text; do not trust the
  boolean, or one benign warning will look like a failed write.
- **Writes need a secure context.** The wrapper names its temp file with `crypto.randomUUID()`, which
  exists only in secure contexts, so over plain `http://` on a LAN address reads work and every write
  throws `crypto.randomUUID is not a function`. Testing over `localhost` hides this, because localhost
  counts as secure. Check `window.isSecureContext` in the chosen shell's webview.
