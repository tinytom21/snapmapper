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

## Running the desktop MVP

```bash
npm run dev
```

Placement is **select photos, then click the map**. Shift-click extends a range, ctrl-click
toggles one. Dragging a thumbnail onto the map was tried and deliberately removed.

Then open **http://localhost:5173/ in Chrome or Edge** — not the in-app browser, and not
Firefox or Safari, which have no File System Access API. Open a folder of JPEGs, select
photos in the list, click the map to place them, then Save.

`localhost` matters: the WASM backend needs a secure context for `crypto.randomUUID`, and
over a plain LAN address reads work while every write fails.

**Every save is verified.** After writing, each file is read back off disk and checked: the
coordinates must read back as intended, and ExifTool must raise no structural warning. A file
that fails is reported as *written but not verified* — deliberately distinct from a plain
failure, because the bytes did reach the disk — and is left listed as unsaved rather than
quietly accepted. Proven against real data: it passes a correctly spliced A6400 file and
catches the piexifjs-corrupted one, using a native ExifTool as the reader.

It costs one extra metadata read per photo, a few hundred milliseconds against a write of one
to two seconds, and it reads only the ~100KB header stub. On by default.

**Two things to know before pointing it at photographs you care about:**

- It writes in place. `writeAtomic` goes through Chromium's swap-file mechanism, so an
  interrupted save leaves the original intact — but **use copies for the first run
  anyway.** Nothing has yet been written by the UI to a file anybody cares about.
- **The modification date cannot be preserved in a browser.** The File System Access API
  has no way to set it, so geotagged photos will show today's date in Explorer. That is a
  real regression against GeoSetter and the reason a native shell still matters. The UI
  says so rather than hiding it.

### Setting the camera clock from a photograph

**Sync from a photo** shows a QR code carrying the current instant, refreshed every 250 ms.
Photograph the screen with the camera, copy that frame into the folder, press **Re-scan
folder**, select it, and press **Read clock from photo**. The instant is decoded out of the
image and compared against the frame's own `DateTimeOriginal`.

A QR rather than a readable clock face for one reason: it carries its own error correction,
so it either decodes to exactly what was displayed or fails. **A misread cannot silently
produce a plausible wrong time** — which matters, because the result shifts the GPS
timestamp of every photo in the session.

Two things this design gets right that are easy to get wrong:

- **The measurement is stored, not just the resulting seconds.** A derived offset is only
  valid for the zone it was derived in, so changing the zone afterwards **re-derives** it.
  Storing only "43 s fast" would leave every timestamp wrong by the zone gap *and* by a
  stale offset. Typing an offset in by hand deliberately discards the measurement, so the
  next zone change cannot silently throw the typed value away.
- **It describes the camera as it is now.** If the camera's clock has been changed since the
  shoot, the measurement does not apply to those photos. The panel says so.

There is also a **manual** path — type a time you can read from some other clock in a
photograph — which is the only option for a shoot already finished.

There is a runtime smoke check for the parts unit tests cannot reach — that the 24MB WASM
loads, that the origin is a secure context, and that a real write completes. Run it from
the browser console:

```js
(await import('/src/self-check.ts')).runSelfCheck().then(r => console.table(r.checks))
```

Run that **first** on Android. All three of those failed on a device during Phase 0 after
passing review.

## Phase 0 is done — the backend is confirmed

Q1 passed on 7 real ILCE-6400 JPEGs, verified with a separate native ExifTool 13.59: correct GPS in
both hemispheres, all 170–221 MakerNote tags decoding identically, the embedded preview and thumbnail
still resolving byte-identically, no new ExifTool warnings, image data untouched. **Keep
ExifTool-WASM.**

Be aware that the plan's stated criterion — "`Sony:MakerNotes` byte-identical" — is **wrong**, and it
failed on every Sony file on the first run. See the note in CLAUDE.md before you trust a failure there.

## The write path Phase 1 should build

**1. Never pass a `File` or `Blob` to `writeMetadata`. Read it to a `Uint8Array` first,
in one `arrayBuffer()` call.** This is worth ~69× on a phone — 1.11 s versus ~76 s for the same 5.4MB
file — because zeroperl reads Blob-backed files with `await blob.slice(...).arrayBuffer()` once per read
syscall. A desktop hides it entirely. It cost most of a day and produced a confident, wrong conclusion
that Android was not viable; don't pay for it twice.

**2. Splice rather than sending the whole photograph.** Give ExifTool a stub of the metadata headers (SOI
up to and including the SOS header, plus ~4KB of scan data and an EOI), let it write GPS exactly as it
does now, then reattach the original scan data with a plain byte copy. That is ~2% of the bytes, and a
further 3.2× on a phone: **343 ms per photo, 6.85 s for 20.** Reference implementation:
`spike/src/splice-core.mjs`, shared by the Node verification and the browser measurement.

Real ExifTool still performs every byte of the metadata rewrite, so the correctness Q1 proved carries
over — verified: 184 checks, zero failures, the same 0.11% offset-only MakerNotes drift.

`spliceHeaders` already asserts rather than trusts, and production should keep that: it re-parses its own
output and refuses to return a file whose scan data moved or changed length.

**3. Never re-serialise EXIF yourself.** Q5 measured `piexifjs` doing exactly that: 6 ms, 47 tags lost
including `OffsetTime`, and ExifTool reporting incorrect maker-note offsets.

## Deciding the shell

The question splits in two, and the second barely matters until the first is answered.

**A. Can Android write to a card at all?** This is about Android's Storage Access Framework,
not about Tauri or Capacitor — both call the same `DocumentsContract` APIs. If the platform
will not do it on real hardware, neither wrapper helps and the Android plan changes.

**B. Which wrapper?** Only worth arguing once A is a yes.

### Step 1: check the premise, on the device

`docs/PLAN.md` rules out a pure PWA on Android because Chrome there has no
`showDirectoryPicker`. That was true when written and has never been checked on the
hardware. **If it is stale, there is no Android shell decision at all** — the existing app
works. Given that two other written-down premises in this project turned out to be wrong at
real cost, check rather than inherit.

```bash
npm run dev:lan
```

Open the `https://` address it prints on the phone, accept the certificate warning, and read
the **This device** panel. No console needed.

`dev:lan` serves **HTTPS**, and that is not optional. `showDirectoryPicker` and
`crypto.randomUUID` are both gated on a secure context, so over plain `http://` on a LAN
address they are absent whatever the platform supports — a false negative that looks like a
definitive answer. The panel refuses to draw a conclusion from an insecure origin and says so.

Inbound `5173` needs a firewall rule; the earlier one was for the spike's port `8080`. In an
**Administrator** PowerShell:

```bash
New-NetFirewallRule -DisplayName "photo-geotagger dev 5173" -Direction Inbound -Protocol TCP -LocalPort 5173 -Action Allow -Profile Any -RemoteAddress LocalSubnet
```

### Step 2: the test that actually decides A

Against `DCIM/100MSDCF` on the card — **not** the card root, which Android 11+ refuses:

1. Grant a tree with `ACTION_OPEN_DOCUMENT_TREE`.
2. Read a photo from it.
3. **Create a new document in the same tree** (the temp file).
4. Write bytes to it.
5. **Delete the original and rename the temp into its place.**
6. Set the modification date.

Steps 3–5 are `writeAtomic`, and they are where this fails if it fails. Many Android file
plugins can read a tree and overwrite a document but cannot create-and-rename inside it — and
overwriting in place is precisely what we refuse to do.

Worth doing as a throwaway Android project, so it commits to neither shell. **A tablet is not
required**: a USB-OTG card reader on a phone presents the card as a removable volume, which
is the same SAF path.

### Step 3: then, and only then, B

| | Tauri 2 | Capacitor |
|---|---|---|
| Toolchain | Rust + MSVC + Android SDK, multi-GB, none installed | Android SDK + JDK, no Rust |
| Android SAF | community `tauri-plugin-android-fs` | `@capacitor/filesystem` is weak on document trees; likely a small Kotlin plugin |
| Desktop | real native binaries | Electron, heavier |
| mtime | yes | yes |

Two notes. **Tauri's size advantage is noise here** — the WASM is 24.2MB, so arguing about
10MB versus Electron misses the point. And needing a small Kotlin plugin is not the drawback
it sounds like: it means controlling the exact create-write-rename sequence rather than hoping
a community plugin exposes it.

There is also a smaller path that skips the question: **Tauri on desktop only**, which fixes
the mtime regression and needs no Android SDK.

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
- **A `Blob` input is ~69× slower than a `Uint8Array` on mobile**, and identical on desktop. See the write
  path above. Any benchmark that compares a Node run against a browser run must pass the same input type
  in both, or it is comparing two different code paths — which is exactly the mistake made here.
