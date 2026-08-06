# Handoff

Scaffolded on a machine where **Node.js could not be installed**. As of **2026-08-06 it has now
been run**: prerequisites installed, core tests passing, and the Phase 0 spike executed. Three of
its four questions are answered.

## Where it stands

| Path | State |
|---|---|
| `docs/PLAN.md` | Approved design. Read this second. One premise corrected (`ArrayBuffer`, not `Uint8Array`). |
| `packages/core/src/gps.ts` | **Tested, passing.** Decimal ↔ EXIF DMS + hemisphere refs. Held up under an independent sweep of 400k values. |
| `packages/core/src/time.ts` | **Tested, passing.** Camera-clock drift, timezone, GPS timestamps. |
| `packages/core/test/*.test.ts` | **50 tests, all passing.** |
| `spike/` | **Run.** Results recorded in `spike/README.md`. Needed three upstream fixes before it would work at all. |
| `packages/ui`, `packages/shells` | Still do not exist. Correctly blocked — see below. |

## The one thing that needs you

**Copy real Sony A6400 JPEGs into `spike/fixtures/`** (copies, never originals — see the README
there for what makes a useful set), then:

```bash
npm run write --workspace spike
```

Q1 — whether `Sony:MakerNotes` survives a write byte-identically — is the only question still open,
and it is now the one the backend decision turns on. It cannot be answered without real files: a
synthetic JPEG has no MakerNotes. Everything else that could be measured has been.

## Do not start Phase 1 yet

Not because the spike failed, but because it found something that changes the shape of the answer:
**ExifTool-WASM writes a 24MP JPEG in ~4.5 s**, which is ~13 minutes for 200 photos on a fast
desktop and worse on a tablet. The cost is in the dependency's filesystem shim, not in ExifTool. Read
"Where this leaves the decision" in `spike/README.md` before committing to a backend or a shell.

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

**50 passing.** The DMS carry logic and the DST-boundary conversion were expected to be the two
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

Q2, Q3 and Q4 are answered and recorded in `spike/README.md`. Q1 needs the fixtures above.

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

**Deliberately still open.** Nothing measured distinguishes Tauri from Capacitor, and the shell
question is downstream of a backend question that is not settled. Desktop MVP before Android
regardless — it proves the portable core with a faster iteration loop.

## Open questions for the user

- **Sample photos.** Still the blocker for Q1, and Q1 is now the pivot. Nothing else in Phase 0 is
  waiting on anything.
- **The backend, once Q1 is known.** If MakerNotes survive, the question is whether ~4.5 s per photo
  is acceptable given how many photos a real session actually tags. If they do not, the backend is
  wrong and the speed never mattered. `spike/README.md` sets out the options.
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
