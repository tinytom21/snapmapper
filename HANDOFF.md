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

**Moving this to another machine or Claude account?** Read `HANDOVER.md` — some of what this
project needs does not travel through git, the photo fixtures above all.

## Where it stands

| Path | State |
|---|---|
| `packages/core` | Platform-agnostic logic. **355 tests, `tsc` clean.** `gps`, `time`, `jpeg` (the splice), `exif-tags`, `exiftool` (write path), `exiftool-wasm`, `session` (staged edits, undo, named actions), `clock-sync`, `gpx` (track parsing and matching), `google-timeline` + `track-file` (Timeline import), `exiftool-batch` (batched reads), `verify-write`, `prior-location` (earlier sessions' work), `storage`. |
| `packages/ui` | React 19 + MapLibre 5 on Vite 7. **251 tests.** `browser-file-store.ts` is the only file behind `FileStore`; `batch-runner.ts` is the only other one tied to the build, since it takes the ExifTool script from a Vite virtual module. |
| `packages/shells` | Does not exist and is not needed. There is no native shell and no reason for one. |
| `spike/` | Phase 0, done. Still where the write path is checked against a **native** ExifTool: `npm run splice --workspace spike` → 184 checks. |
| `docs/PLAN.md` | Historical. Useful for intent, wrong in places. |

**606 tests, `tsc` clean, production build succeeds.**

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
(await import('/src/dev-preview.tsx')).previewReviewBar()   // the review strip, over a stand-in map
(await import('/src/dev-preview.tsx')).previewActionMenu()  // the phone's overflow menu
(await import('/src/dev-preview.tsx')).previewConflicts(3)  // "two locations for this photograph"
(await import('/src/dev-preview.tsx')).findOverlaps()       // anything painted over anything
```

## Deploying

**Push to `main` and it ships.** `.github/workflows/deploy.yml` typechecks, runs all 606 tests,
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
- **One way in: open the folder your photographs are in**, then choose which of them inside the
  app. The OS file picker is gone, and so is the question about where to save — `showOpenFilePicker`
  cannot reach a file's parent (verified against the live API), which is what forced both the
  raw/JPEG split and the follow-up folder prompt. Listing a folder is free (20 ms to enumerate 1000
  entries) and only the chosen photographs are read, so the old size warning is gone too. The
  chooser shows **thumbnails, filled in gradually** while you select — expanded days first. See
  `FolderChooser.tsx` and CLAUDE.md.
- **Thumbnails are read straight out of the EXIF bytes**, not through ExifTool — 0.165 ms against
  634 ms, byte-identical to ExifTool on all seven real fixtures (`npm run thumb --workspace
  spike`). Reading is safe where *writing* would not be; see CLAUDE.md. ExifTool is reached only
  for raw, and zeroperl is no longer booted at all for a folder of JPEGs. Measured in a browser:
  60 pictures in 548 ms with the main thread free.
- **Never `await` a file access inside a loop.** Three bugs so far, all the same shape, all
  invisible on a desktop and the whole cost on a phone reading a card. Collect, then `Promise.all`
  in bounded batches.
- **But on Android that overlap does not happen.** Measured from the device: a batch's wall clock
  came out at *exactly* the batch size times the per-file cost, in both of two runs — Chrome
  serialises File System Access reads below `Promise.all`. Reading is 128-148 ms per photograph
  there against 0.01 ms to parse, so the only levers are bytes and round trips. See CLAUDE.md.
- **The thumbnail timings are in the interface**, in the chooser's footer: one tap shows the
  report, a second copies it. It names whichever stage dominates, which is the line that would have
  caught all three of those bugs in one paste. See `diagnostics.ts`.
- **ExifTool blocks the main thread**, ~700 ms per batch of sixteen, measured — which now only
  matters for raw. **Moving zeroperl into a worker is the outstanding fix** — see the note about
  `zeroperl.wasm` resolving relative to the document before attempting it.
- **Copies by default**, into a `geotagged` folder. The originals are never opened for writing, which
  also removes the per-file permission prompt. **A destination folder deleted between sessions is
  remade before the next save**, or the question is asked again — a dead directory handle used to
  fail once per photograph with `NotFoundError` and no way out. See CLAUDE.md.
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
- **Metadata is read in batches**, sixteen photographs to one ExifTool invocation. Measured in the
  browser at **13.4x** — 350 ms for sixteen against 4701 ms one at a time — and proved equivalent to
  the old path against real A6400 files by `npm run batch-verify --workspace spike` (93 checks, 0
  failures). The ExifTool script is extracted from `@uswriting/exiftool`'s bundle at build time
  rather than vendored. Three traps and a per-photograph fallback; see CLAUDE.md before touching it.
- **Raw is written as an XMP sidecar**, never into the ARW — `DSC01234.ARW` gets `DSC01234.xmp` beside it, the Adobe convention Lightroom reads. The raw file is never read, copied or opened for writing, so there is nothing to corrupt. Proved against native ExifTool by `npm run xmp --workspace spike`; reading an ARW is proved by `npm run arw --workspace spike` against a real 24.9MB file, and batching handles it unchanged. Raw needs **folder mode**: the sidecar must sit beside the file and the picker gives no access to a parent.
- **The logger's folder is remembered per device**, and the right file for a shoot is found by the
  times inside the files — so a permanent logger plus a card of photos needs no track picking at
  all. Midnight falls out of it rather than being special-cased, and so does the turn of the month.
  Daily *and* monthly track files work; monthly is the harder one and the one in use — see
  CLAUDE.md for the span-from-the-ends and load-window measurements.
- **Photographs geotagged in an earlier session show as placed**, read from the copy in
  `geotagged/` or from a raw file's `.xmp` sidecar — through `Composite:GPS*` and `XMP:GPS*`
  respectively, which are *not* interchangeable. Where the file and the earlier copy genuinely
  disagree the user is asked, per photograph, with a way to answer for the rest. Proved against
  native ExifTool by `npm run prior-verify --workspace spike` (15 checks, 0 failures), including
  that `-fast2` really does read an XMP. Read the CLAUDE.md section before touching it: the search
  is driven by an *effect* rather than by the end of loading, because the output folder is usually
  not known when the photographs are.
- **Map markers are the photographs themselves**, as a rounded tile, giving way to the old dot
  wherever two would collide on screen — a pixel rule rather than a zoom threshold, so one town and
  one tour both work. The selected frame always shows its picture and always comes to the front.
  Measured: 9 tiles at z17 collapsing to 2 at z12, and a crowded dot becoming a 62px tile at
  z-index 3 when picked. Each marker has a **leader** whose tip is the coordinate, and every
  photograph keeps its picture — `?markers=declutter` restores the give-way-when-crowded rule,
  which is kept as an experiment rather than deleted. Measured across z6-z19: tile 72x57, dot
  18x25, tip **0 px** from the coordinate for every on-screen marker.
  See CLAUDE.md before touching `PhotoMap.tsx`: **`.pin` is MapLibre's element** — never assign
  `className` on it and never give it `position` or `transform`, each of which has shipped a map
  that lied about where photographs were. Note the `mapReady` rule too, since effects that ran
  before the map finished building used to never run again.

## What to pick up next

**Both designed features have shipped** — see "already placed" and "thumbnail markers" under
*What is settled*. What is left below was deferred rather than designed.

### 1. Back up the card, not just geotag it

Asked for as an idea rather than a requirement: **be the way photographs get off a card while away
from a PC.** Copy to the phone's or laptop's local storage before geotagging, or card-to-card where
the hardware allows it.

It fits what is already here. A folder grant gives read access to the source and the destination is
the same kind of handle `geotagged/` already uses, so the copy is `writeAtomic` over a set of refs
with no metadata read at all — which is the cheap half of what the chooser already does. The
chooser is also already the right screen for it: pick a day, and the button says copy rather than
open.

Three things to think about before starting. A copy of a 2000-file card is tens of gigabytes and
will want resuming rather than restarting. Verifying a copy means reading both sides back, which
doubles the I/O and is probably still worth it for the only copy of somebody's photographs. And
card-to-card depends entirely on the phone mounting two volumes at once, which is a hardware
question to answer before any of the rest.

### 2. Video

Wanted eventually, not now. ExifTool writes GPS to MP4/MOV.

### 3. Code-split the ~1.5MB bundle

Fine on a desktop, worth it on mobile data. It is precached, so it is paid once per version rather
than per visit.

Deferred by the plan rather than by us: video.

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
