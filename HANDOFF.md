# Handoff

**Snapmapper is built, deployed and in use.** Read this first, then `CLAUDE.md` for the gotchas that
cost real time. `docs/PLAN.md` is the original design and several of its premises are now disproved —
do not trust it without checking here.

- **Live:** https://tinytom21.github.io/snapmapper/ — Chrome or Edge, desktop or Android.
- **Repository:** https://github.com/tinytom21/snapmapper (public, Artistic License 2.0).
- **State:** working end to end on a PC and an Android phone against real Sony A6400 files. Photos
  are picked, placed on a map, written as copies into a `geotagged` folder, and every one is read
  back and verified. The user has confirmed it on a phone since the interface was rebuilt.

Nothing is half-finished. The tree is clean and every change is deployed.

## Where it stands

| Path | State |
|---|---|
| `packages/core` | Platform-agnostic logic. **238 tests, `tsc` clean.** `gps`, `time`, `jpeg` (the splice), `exif-tags`, `exiftool` (write path), `exiftool-wasm`, `session` (staged edits, undo, named actions), `clock-sync`, `gpx` (track parsing and matching), `google-timeline` + `track-file` (Timeline import), `verify-write`, `storage`. |
| `packages/ui` | React 19 + MapLibre 5 on Vite 7. **133 tests.** The only platform-specific file is `browser-file-store.ts`, behind `FileStore`. |
| `packages/shells` | Does not exist and is not needed. There is no native shell and no reason for one. |
| `spike/` | Phase 0, done. Still where the write path is checked against a **native** ExifTool: `npm run splice --workspace spike` → 184 checks. |
| `docs/PLAN.md` | Historical. Useful for intent, wrong in places. |

**371 tests, `tsc` clean, production build succeeds.**

```bash
npm test && npm run typecheck
```

## Running it

```bash
npm run dev
```

Then http://localhost:5173/. **`localhost` matters** — writing needs a secure context, and on a plain
`http://` LAN address `crypto.randomUUID` and the file pickers are simply absent, which looks exactly
like the platform not supporting them.

For a phone on the same network, `npm run dev:lan` serves HTTPS with a self-signed certificate.
Accept the warning; it still counts as secure. Note that browsers refuse to register a **service
worker** on an untrusted certificate, so that route is for using the app, not for installing it.

Inspect the interface without an OS file picker in the way — this is how nearly every layout bug here
was found:

```
(await import('/src/dev-preview.tsx')).previewPhotoList()   // the real Sidebar, 24 sample photos
(await import('/src/dev-preview.tsx')).previewFullSize()    // the full-size preview overlay
(await import('/src/dev-preview.tsx')).previewMap()         // the map on its own, pins and a track
(await import('/src/dev-preview.tsx')).previewActionMenu()  // the phone's overflow menu
(await import('/src/dev-preview.tsx')).findOverlaps()       // anything painted over anything
```

## Deploying

**Push to `main` and it ships.** `.github/workflows/deploy.yml` typechecks, runs all 371 tests,
builds and publishes to GitHub Pages; a failing test blocks the deploy. About two minutes.

The base path comes from the repository name, so renaming the repo needs no edit. A Pages project
site is served from `/<repo>/`, and that prefix has to reach four places — Vite's `base`, the service
worker's `BASE`, the registration scope, and the manifest. Getting it wrong is silent: the worker
registers, reports itself active, and caches nothing.

An update reaches an installed phone on its **second** launch by design, and the app now says so with
a *"A new version is ready"* banner rather than leaving it a mystery.

## What is settled

- **ExifTool-WASM is the backend.** Proved on real ILCE-6400 files against a separate native
  ExifTool 13.59. Never exiv2, never `piexifjs` — both corrupt Sony maker notes.
- **No native shell.** Chrome on Android has the File System Access API; the PLAN premise that it
  does not is stale. Verified by geotagging real photos on a phone.
- **File modification dates do not matter to the user**, which removed the last argument for a
  native desktop build.
- **Copies by default**, into a `geotagged` folder. The originals are never opened for writing, which
  also removes the per-file permission prompt.
- **Every save is verified** by reading the file back — coordinates *and* the absence of a structural
  warning. A wrecked file still reports perfect coordinates; that is how `piexifjs` looked from
  outside.
- **The look is "Quiet"**, light and dark, following the system. The palette is contrast-driven and
  `styles.test.ts` enforces it by reading `styles.css`.
- **The sidebar is an accordion**, exactly one section open. Structural, not cosmetic — see CLAUDE.md.
- **Vector tiles** from OpenFreeMap's `liberty`, with label density raised for a phone-sized
  viewport and the old raster source kept as a fallback.
- **Track import works**, and it is the camera clock's other half — a match runs through the
  measured drift and the session zone, so the two features are only useful together. Both a GPX
  from a logger app and a **Google Timeline export** are accepted, sniffed by content. Timeline is
  inferred rather than logged, so the panel reports what each track is made of; see CLAUDE.md.

## What to pick up next

Ordered by what would change the tool most.

1. **Offline map tiles.** The app opens offline but the map is blank over ground never loaded. The
   service worker *cannot* fix this: MapLibre fetches tiles inside a worker created from a `blob:`
   URL and those requests never reach it (measured). It needs `maplibregl.addProtocol`, whose
   handlers run on the main thread. PMTiles is the plan's long-term answer.
2. **A dark map.** The interface is dark and the map is bright. Liberty has no dark variant, so this
   means recolouring the style after load — worth trying, and it needs a human eye to judge.
3. **Code-split the ~1.5MB bundle.** Fine on a desktop, worth it on mobile data. It is precached, so
   it is paid once per version rather than per visit.

Deferred by the plan rather than by us: ARW via XMP sidecars, reverse geocoding into IPTC, video.

## The write path, if you touch it

**1. Never pass a `File` or `Blob` to the backend. Read it to a `Uint8Array` in one
`arrayBuffer()` call.** Worth ~69× on a phone — 1.11 s versus ~76 s for the same 5.4MB file — because
zeroperl reads Blob-backed files once per read syscall. A desktop hides it completely. This cost most
of a day and produced a confident, wrong conclusion that Android was not viable.

**2. Splice rather than sending the whole photograph.** Give ExifTool a stub of the headers, let it do
every byte of the metadata rewrite, then reattach the original scan data with a byte copy. ~2% of the
bytes and a further 3.2× on a phone: **343 ms per photo, 6.85 s for 20.** `spliceHeaders` re-parses
its own output and refuses a file whose scan data moved or changed length — keep that.

**3. Never re-serialise EXIF yourself.** Measured: `piexifjs` writes in 6 ms, drops 47 tags including
`OffsetTime`, and leaves ExifTool reporting incorrect maker-note offsets.

**4. Do not use byte-identity as the MakerNotes test.** Adding a GPS IFD entry shifts the block 12
bytes, and Sony's offsets are file-relative, so a *correct* writer must rewrite them. Test decoded tag
values, whether `PreviewImage` and `ThumbnailImage` still resolve byte-identically, and ExifTool's own
warnings.

## Things not to relearn the hard way

The full list, with measurements, is in `CLAUDE.md`. The ones that have bitten more than once:

- **ExifTool is not Windows-only.** It is a Perl library; GeoSetter is Windows-locked because its GUI
  is Delphi. That premise shaped the original brief and is wrong.
- **`@6over3/zeroperl-ts` cannot find its own WASM under Node** without the patch in
  `spike/src/patch-zeroperl.mjs` — it resolves the binary with `URL.pathname`, so any Windows path or
  any path with a space fails with a baffling `ENOENT` for `C:\C:\…%20…`. In a browser it fetches
  `./zeroperl.wasm` relative to the **document**, which is why `vite-plugin-zeroperl.ts` serves it at
  the site root.
- **`-P` and `-overwrite_original` fail inside the WASM sandbox**, correctly — there is no real
  filesystem. Do not pass them.
- **The wrapper reports `success: false` for a bare warning.** Read the error text; the boolean alone
  will make one benign warning look like a failed write.
- **`readTags` must use `-G`, not `-G0:1`**, or no date ever resolves — and it hides behind
  `Composite:*`, which keeps working.
- **The verification read must not pass `-fast2`**, which stops before parsing maker notes, so the
  warning that catches corruption never appears.
- **A second file picker cannot be chained after the first.** Pickers only open while a user gesture
  is in flight, and the first dialog plus a few seconds of metadata reading spends it.
- **Verify layout on the real composition, at more than one size and zoom.** Every layout bug here has
  been about what happens when space runs short: a harness that mounted `PhotoList` alone missed one,
  a grid with room to spare missed another, and browser zoom is what took the last one over the edge.
  Use `findOverlaps()` — it clips to every scrolling ancestor and checks visibility, because rects
  alone produce phantoms.

## Phase 0, for the record

All four questions are answered, with numbers, in `spike/README.md`. The headline: keep
ExifTool-WASM; the splice makes it fast enough on a phone; `piexifjs` is unsafe; both platforms work
on one backend. Fixtures live in `spike/fixtures/` and are **gitignored** — copy real A6400 JPEGs in,
never the originals and never the only copy.

Native ExifTool is the independent verifier, not a runtime dependency:

```bash
winget install OliverBetz.ExifTool
```

There is no `PhilHarvey.ExifTool` in winget; `OliverBetz.ExifTool` is the same tool packaged. It
installs per-user and registers PATH only in the registry, so open a fresh shell afterwards or set
`EXIFTOOL` to the absolute path.
