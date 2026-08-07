# Phase 0 — spike

Throwaway code. It exists to produce a **decision**, not a passing test suite: does ExifTool-WASM
stay as the metadata backend, and which native shell gets built on top of it.

**Run on 2026-08-06/07** (Windows 11, Node 24.15.0, native ExifTool 13.59, `@uswriting/exiftool`
1.0.9 wrapping `@6over3/zeroperl-ts` 1.0.10). **All four questions are answered against 7 real
ILCE-6400 JPEGs.**

**Recommendation for review: keep ExifTool-WASM as the metadata backend.** It is correct on real
files, which was the only thing that could have ruled it out. Its write cost is high (~2 s for a 5–7MB
JPEG, ~4.5 s for a 12MB one) but acceptable at the real session size of 10–50 photos, provided writes
are backgrounded. The shell decision is still open and needs the tablet.

## Before anything ran: three upstream defects

None of this worked out of the box, and all three matter beyond the spike.

1. **`@6over3/zeroperl-ts` cannot load its own WASM under Node.** It resolves the binary with
   `new URL("./zeroperl.wasm", import.meta.url).pathname`, and a `file:` URL's `pathname` is not a
   filesystem path. It keeps the leading slash before a drive letter, so Node opens `C:\C:\…`
   (broken on *every* Windows machine), and it leaves percent-encoding in place, so any directory
   containing a space arrives as `photo%20geotagging` (broken on Linux and macOS too — and this
   repository's own path has a space in it). `spike/src/patch-zeroperl.mjs` rewrites the line to use
   `fileURLToPath`. It patches `node_modules` in place, which is not shippable — carrying this fix
   properly (vendor the file, patch on install, or upstream it) is a Phase 1 task.
2. **The ESM bundle imports a bare specifier.** `@uswriting/exiftool`'s ESM build contains a literal
   `import … from "@6over3/zeroperl-ts"`, which no browser can resolve. The measurement page needs
   an import map, and so will the Android build's bundler.
3. **In a browser, zeroperl fetches `./zeroperl.wasm` relative to the document**, not the module, so
   the request lands at the site root regardless of where the package really lives. The 24MB WASM
   has to be served next to the page.
4. **Writes require a secure context.** `@uswriting/exiftool` names its temp output file with
   `crypto.randomUUID()`, which the spec exposes *only* in a secure context. Over plain `http://` on a
   LAN address it does not exist, so **reads succeed and every write fails** with
   `crypto.randomUUID is not a function`. This only showed up on a real phone: the desktop webview was
   tested over `localhost`, which counts as secure and hid the problem completely.

   The measurement page now polyfills it from `crypto.getRandomValues` (which *is* available
   insecurely), verified to produce 2000/2000 well-formed unique v4 UUIDs with a real write succeeding
   through it. The cost is one UUID per write, far below the noise floor of a multi-second measurement.

   **This is a constraint on the shipped app, not only on the spike.** It is *expected* to be harmless,
   because Capacitor serves the webview from `https://localhost` (and `capacitor://` on iOS) and Tauri
   from `http://tauri.localhost`, and Chromium treats `localhost` and `*.localhost` as potentially
   trustworthy origins. **That reasoning has not been confirmed on a device**, so it belongs on the
   shell evaluation checklist: whichever shell is chosen, check `window.isSecureContext` inside its
   webview before assuming writes work at all.

Also fixed in the harness itself: `verify.mjs` compared `EXIF:GPSLatitude` against a *signed*
expectation, but EXIF stores GPS unsigned with the hemisphere in a separate ref, so the
southern+western case — the one case that exists to catch a dropped sign — would have failed
falsely. It now compares `Composite:*` for the signed value and checks magnitude and ref separately.

## Running it

```bash
npm install
```

Copy real A6400 JPEGs into `fixtures/` (see the README there — copies, never originals), then:

```bash
npm run spike
```

Individual stages, if one needs iterating on:

```bash
npm run probe --workspace spike
```

```bash
npm run write --workspace spike
```

```bash
npm run bench --workspace spike
```

And the one that actually predicts Android — run it **on the tablet**:

```bash
npm run browser --workspace spike
```

## The four questions

### Q1 — Does it write correct GPS to a real A6400 JPEG without damaging anything else?

The load-bearing question. `write-gps.mjs` tags a file and then verifies with a **separate native
ExifTool** that:

- coordinates round-trip, including for a southern *and* western location where a dropped sign
  would show
- `Sony:MakerNotes` is **byte-identical** — Sony stores AF, lens and white-balance data at offsets
  relative to the start of the file, so a careless writer corrupts them while the tags still
  appear to read correctly
- the compressed image data is unchanged (hashed from the Start Of Scan marker onward)
- `DateTimeOriginal` and `Orientation` survive
- no tags were dropped

**A MakerNotes mismatch means stop.** Do not build on the backend.

| Result | |
|---|---|
| Verdict | **PASS — ExifTool-WASM is safe on real A6400 files** |
| Native ExifTool version | 13.59 (`OliverBetz.ExifTool`) |
| Fixtures used | 7 real ILCE-6400 JPEGs, 4.9–6.9MB, ~37KB MakerNotes each. Five with no GPS, two already geotagged by GeoSetter, one portrait (`Orientation` 6). |
| Notes | Two locations per file (Greenwich, and a southern+western case), so 14 writes. Every check passes. |

| Check | Result |
|---|---|
| Coordinates round-trip signed, both hemispheres | PASS (`-33.8688, -70.6693` read back exactly) |
| EXIF stores unsigned magnitudes per spec | PASS |
| Hemisphere refs written and correct | PASS |
| XMP mirrors EXIF (what Lightroom reads) | PASS |
| Every MakerNote tag decodes to the same value | PASS (170–221 tags per file, all identical) |
| `PreviewImage` still resolves byte-identically | PASS (273–412KB, hash unchanged) |
| `ThumbnailImage` still resolves byte-identically | PASS |
| No new ExifTool warnings | PASS (none, before or after) |
| Compressed image data byte-identical | PASS |
| `DateTimeOriginal` preserved | PASS |
| `Orientation` preserved | PASS (including 6, portrait) |
| No tags dropped | PASS |

### The criterion had to be corrected, and this nearly killed the project

**"`Sony:MakerNotes` byte-identical" is the wrong test, and on the first real run it failed on every
single Sony file.** Taken at face value that reads as "stop, do not build on this backend". It would
have been the wrong conclusion.

Inserting a GPS IFD pointer adds one 12-byte entry to IFD0, which shifts the MakerNotes block 12
bytes later in the file. Sony stores offsets inside MakerNotes relative to the start of the *file*, so
a correct writer **must** rewrite them. Measured on `DSC00119.JPG`: exactly **41 of 37,664 bytes
changed (0.11%), and every one of them was a value incremented by precisely 12.** Nothing else moved.

So bytes changing is the expected result. Bytes staying identical while the block moves would be the
corruption — that is the exiv2 failure mode this project already knows about.

The mechanism is confirmed by the two GeoSetter-tagged fixtures: they report the MakerNotes block
**byte-identical**, because IFD0 already contained a GPS pointer, so nothing shifted and no offset
needed rewriting. Five files with no prior GPS drift by 41 bytes; two with existing GPS drift by zero.

`verify.mjs` now proves the right thing rather than merely relaxing the old check — three independent
angles, because no one of them suffices:

1. **Every MakerNote tag decodes to the same value.** Catches lost or garbled fields.
2. **`PreviewImage` and `ThumbnailImage` extract byte-identically.** Both are reached through absolute
   file offsets held in MakerNotes, so this is what actually proves the offsets were repaired — a
   stale offset yields truncated or garbage bytes, not a clean error. The 393KB preview still decodes
   as a valid 1616×1080 JPEG.
3. **ExifTool reports no new warnings.** It validates maker-note offset plausibility itself.

Raw byte drift is still reported, but as information — and a *length* change or a large percentage
would still stand out immediately.

### Q2 — Do raw ExifTool arguments reach the write path?

`-n` (numeric input), `-P` (preserve file modification date) and `-overwrite_original` are not
optional, and `-XMP:GPS*` is how Lightroom sees a location at all. The tag-object API is
documented; argument passthrough is not.

`probe-api.mjs` tries several option shapes. Note that *accepted* is not *applied* — an unknown
option is easily ignored. The modification-date check in `write-gps.mjs` is what settles it.

If arguments do not get through: drop to [zeroperl](https://github.com/6over3/zeroperl) directly
and drive ExifTool's own CLI. Survivable either way — the shell restores the modification date
itself, which is most of what `-P` buys.

| Result | |
|---|---|
| Verdict | **YES — `args` reaches ExifTool's command line, proved by effect** |
| Working option shape | `{ args: [...] }` on both `parseMetadata` and `writeMetadata` |
| Wrapped ExifTool version | 13.42 |

Proved rather than assumed: an argument that *sets a tag* was passed, and the tag read back out of
the returned bytes. Accepting an option proves nothing, which the control demonstrates —
`{ extraArgs: [...] }` is not a real option and "passed" cleanly, because unknown keys are silently
ignored.

Argument by argument, though, the plan's three "not optional" arguments are not equivalent:

| Argument | Result |
|---|---|
| `-n` | works — keep it, so coordinates are read as decimal degrees rather than parsed as DMS |
| `-P` | reported as a **failure** (`Warning: Error setting file time`) |
| `-overwrite_original` | **hard failure** (`Error erasing original`) |

**Both of the failures are the right outcome, and neither is a loss.** They exist to manipulate a
real filesystem, and the WASM build has none — it works on a copy inside a virtual FS and hands the
bytes back. There is no original to overwrite, and preserving the modification date is the host's
job, done by `writeAtomic` on the way out. PLAN.md's "Preserve the file's modification date (`-P`)"
should be read as a requirement on the shell, not on the backend.

One consequence worth carrying into Phase 1: **the wrapper reports `success: false` for a mere
warning.** `-P` only warned, yet the call was indistinguishable from a real failure. A benign
ExifTool warning on one photo in a batch would therefore look like a failed write, so the write path
needs to inspect the error text rather than trusting the boolean.

### Q3 — What does it cost?

Bundle size, cold start, and per-photo write time. The bar: **a batch of 200 photos has to be
tolerable.** A tablet is typically 3-5× slower than a desktop here, so the Node numbers are a
floor, not a prediction.

Watch for the WASM instance being rebuilt per call — a batch would pay that cost 200 times over.

**Verdict: it costs a lot, but less than the original bar implied.** The 200-photo bar was an
assumption in the plan, not a requirement. Confirmed with the user on 2026-08-06: **a realistic
session tags tens of photos, 10–50, not two hundred.** At ~4.5 s each that is roughly:

| Session | Desktop | Tablet (est. 3×) |
|---|---|---|
| 20 photos | ~90 s | ~5 min |
| 50 photos | ~4 min | ~12 min |
| 200 photos | ~13 min | ~40 min+ |

So this is uncomfortable rather than disqualifying, *provided* writes are backgrounded with per-file
progress — which Phase 1 already requires for other reasons. It does mean the tablet is the weak
point, and that a full card dump would be painful.

The numbers below are unchanged; only their interpretation is.

| Measurement | Node (desktop) | Webview (desktop) | Webview (phone) |
|---|---|---|---|
| Module import | 1–3 ms | 46 ms | loaded OK |
| First call (read) | 595 ms @ 11.7MB | 1089 ms @ 4.8MB | **3.54 s @ 5.4MB** |
| Warm call (read) | 615 ms | — | _pending_ |
| Median write, 11.7MB | **4.48 s** | ~1.5 s @ 4.8MB | _pending_ |
| 200-photo projection | **761 s (12.7 min)** | — | _pending_ |
| Instance reused? | **No** — 595 ms then 615 ms | — | _pending_ |

No Android tablet was available, so a phone stands in. A phone is if anything slower than the tablet
the app would be used on, so a tolerable number here is a safe result rather than an optimistic one.
The 24MB WASM loaded without trouble, which was the main worry about mobile.

**Read cost scales as expected:** 3.54 s for 5.4MB on the phone against 1.09 s for 4.8MB in the desktop
webview is roughly **3× slower**, matching the 3–5× rule of thumb. Write timings are still pending —
the first attempt died on the secure-context defect above, which is now polyfilled.

Bundle: `.wasm` size **24.2 MB** — this ships inside the APK. (Measured as the largest single asset,
not a sum: the package ships the same `zeroperl.wasm` under both `dist/esm` and `dist/cjs`, and a
bundler takes one.)

The bar was 200 photos in a tolerable time, read as 120 s. **It misses by 6×**, before Android is
considered at all. The desktop webview is not the problem — at 4.8MB it matched Node — so the tablet
will be a CPU-speed multiple of an already-failing number.

### Where the time goes, and why batching cannot save it

`npm run cost --workspace spike` fits write time against file size:

```
   64.0 KB ->  858 ms          fit: 757 ms fixed per invocation
  512.0 KB -> 1.05 s                + 261 ms per MB
    2.0 MB -> 1.21 s
    6.0 MB -> 1.95 s           200 photos, one invocation each:  761 s
   11.7 MB -> 4.00 s           200 photos, fixed cost paid once: 610 s
```

Only 20% of a typical photo's cost is startup. **The bytes dominate, so the classic ExifTool remedy —
one invocation for many files, as `-stay_open` does and as GeoSetter uses — would recover about two
minutes out of thirteen.** Not enough to matter.

Narrowing it further:

| Operation | 64 KB | 11.7 MB |
|---|---|---|
| `-ver` (no file work) | 384 ms | 397 ms |
| read, full | 488 ms | 609 ms |
| read, `-fast2` | 600 ms | 673 ms |
| **write** | **1444 ms** | **4429 ms** |

Copying bytes *in* is nearly free (`-ver` is flat across sizes), and reads barely scale — `-fast2`
does not help, so nothing is scanning that shouldn't. The entire size-dependence lives in the
**write** path: ExifTool rewriting the file through zeroperl's WASI filesystem shim, one syscall at a
time, then copying the result back out. That is a JS-level shim inefficiency in a dependency we do
not control, not a cost inherent to ExifTool or to WASM.

Which means it is plausibly *fixable* — buffered writes in the WASI layer would likely transform
these numbers — but not cheaply, and not by us this week.

### Q4 — Where is the memory ceiling?

WASM is 32-bit, so ~4GB is the wall. 25MB is the size that matters, being roughly an ARW file, for
the deferred raw phase.

| Result | |
|---|---|
| 25MB file | **PASS** — read in 1.08 s, no failure, RSS 675 MB |
| Notes | Nowhere near the 32-bit wall. But this was a **read**; at 261 ms/MB a 25MB *write* projects to ~7 s, so for the deferred ARW phase the ceiling is performance, not memory. |

Also worth recording against Q3: `dispose()` is exported and the loader keeps the compiled module in
a `WeakRef`, so the instance *can* be reused — but reads showed no warm-up benefit at all (595 ms
then 615 ms), so whatever is cached is not what the per-call cost is spent on.

## Then: choose the shell

**Tauri 2** unless there is a reason not to — one codebase to Windows/macOS/Linux binaries plus an
Android APK, ~10MB output, and the strongest desktop story. Costs a Rust toolchain, and Android
folder access leans on the community `tauri-plugin-android-fs`.

**Capacitor** is the fallback: pure JS/TS, no Rust, strong Android story, iOS free later; desktop
only via Electron, which is heavier and less polished.

The deciding factor is whether the Android SAF path can reliably write to a **removable card**.
That requirement has no workaround. Remember that Android 11+ refuses `ACTION_OPEN_DOCUMENT_TREE`
grants on an SD card's root volume — ask for `DCIM/100MSDCF` instead, or it will look like a
permissions bug.

| Decision | |
|---|---|
| Shell chosen | _still pending, and deliberately so_ |
| Reason | The shell question is downstream of the backend question, and the backend is not settled. Nothing measured here distinguishes Tauri from Capacitor; the SAF write test needs the tablet and the card. |

## Where this leaves the decision

A recommendation for review, not a settled conclusion:

- **Q1 passes.** ExifTool-WASM writes correct GPS to real A6400 JPEGs and leaves Sony MakerNotes
  functionally intact, rewriting their internal offsets exactly as it should. Verified with a separate
  native ExifTool 13.59. **Recommendation: keep ExifTool-WASM as the metadata backend.**
- **Q2 and Q4 are clean.** Arguments get through, and memory is not a constraint.
- **Q3 is uncomfortable but survivable at the real session size.** 4.5 s per photo means ~90 s for a
  20-photo session and ~4 min for 50 on desktop — acceptable if writes are backgrounded with per-file
  progress, which Phase 1 wants anyway. The tablet, at an estimated 3×, is the weak point.
- **Nothing now argues for changing backend.** Correctness was the only criterion that could have
  disqualified it, and it passed on real files. The remaining unknown is the tablet.

### Cross-check against GeoSetter

Two fixtures were tagged by GeoSetter, which the plan names as the reference implementation. Our
output matches its tag set and its formats:

| Tag | GeoSetter | Ours |
|---|---|---|
| `GPS:GPSLatitude` / `Ref`, `GPSLongitude` / `Ref` | yes | yes |
| `GPS:GPSMapDatum` = `WGS-84` | yes | yes |
| `GPS:GPSAltitude` / `Ref` | not on these files | yes, when an altitude is given |
| `GPS:GPSDateStamp` / `GPSTimeStamp` | yes | yes, from `buildGeotagTags` when the instant is known |
| `XMP-exif` mirror | yes | yes |
| `GPS:GPSVersionID` | `2.2.0.0` | `2.3.0.0` (ExifTool's default — harmless) |

Two gaps were found and closed in `packages/core/src/exif-tags.ts`:

- **`XMP:GPSMapDatum` was missing.** GeoSetter writes the datum into XMP as well as EXIF. Added.
- **`REQUIRED_WRITE_ARGS` still contained `-P` and `-overwrite_original`**, which Q2 proved fail in the
  sandbox. It is now `['-n']`, with a regression test so it cannot come back.

Still open, and deliberately not changed: the spike's `write-gps.mjs` builds its own tag set rather
than calling `buildGeotagTags`, so Q1's evidence covers the coordinate tags but not `GPSDateStamp` /
`GPSTimeStamp` on a real file. Worth wiring together in Phase 1 so the shipping tag set is the tested
one.
- **Reading metadata does not need this backend at all.** Reads cost ~0.5 s each — 100 s just to list
  a 200-photo folder — and parsing EXIF for display is low-risk work that plain JS does in
  milliseconds. A hybrid (read in JS, write with whatever Q1 vindicates) looks better than either
  extreme. Worth designing for, once Q1 is known.

**A caution about the escape hatch.** `piexifjs` re-serialises the EXIF IFDs to insert GPS. That is
precisely the operation that corrupts offset-relative MakerNotes, and it is why exiv2 is already
banned in this project (KDE #326408). Being small and fast does not make it safe, and **it must clear
the same byte-level MakerNotes check before it can be treated as a fallback.** On present evidence
the fallback is less trustworthy than the thing it would replace, not more.

## If ExifTool-WASM does not work out

In order of preference, revised by what the spike measured:

1. **Fix the write path in the WASI layer.** The measurements point at one specific cause — unbuffered
   filesystem writes inside `zeroperl-ts` — rather than at ExifTool or WASM in general. Driving
   zeroperl directly would let us control that layer, and it keeps real ExifTool. This has moved up:
   it is now the option with a known target rather than a vague hope.
2. **Native ExifTool binary on desktop, WASM only on Android.** Two code paths, but the desktop MVP
   is Phase 1 and a native binary is fast and unquestionably correct. Buys time to resolve Android
   separately instead of letting the hardest target dictate the easiest one.
3. **`piexifjs`** — ~30KB of plain JS, no WASM, and orders of magnitude faster. **Demoted**, and not
   merely for giving up the ARW and video future: it re-serialises EXIF IFDs, which is the exact
   mechanism by which offset-relative Sony MakerNotes get corrupted. Do not adopt it without running
   the same byte-level MakerNotes check that Q1 applies to ExifTool-WASM.

Never exiv2 — it corrupts Sony ARW when writing GPS.
