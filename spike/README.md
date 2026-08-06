# Phase 0 — spike

Throwaway code. It exists to produce a **decision**, not a passing test suite: does ExifTool-WASM
stay as the metadata backend, and which native shell gets built on top of it.

None of this has ever been executed — it was written on a machine without Node. Expect to fix real
problems on the first run, particularly in `probe-api.mjs`, which is written against a documented
API surface that was never verified.

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
| Verdict | _not yet run_ |
| Native ExifTool version | |
| Fixtures used | |
| Notes | |

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
| Verdict | _not yet run_ |
| Working option shape | |
| Wrapped ExifTool version | |

### Q3 — What does it cost?

Bundle size, cold start, and per-photo write time. The bar: **a batch of 200 photos has to be
tolerable.** A tablet is typically 3-5× slower than a desktop here, so the Node numbers are a
floor, not a prediction.

Watch for the WASM instance being rebuilt per call — a batch would pay that cost 200 times over.

| Measurement | Node (desktop) | Webview (desktop) | Webview (tablet) |
|---|---|---|---|
| Module import | | | |
| First call | | | |
| Warm call | | | |
| Median write | | | |
| 200-photo projection | | | |
| Instance reused? | | | |

Bundle: `.wasm` size ______ — this ships inside the APK.

### Q4 — Where is the memory ceiling?

WASM is 32-bit, so ~4GB is the wall. 25MB is the size that matters, being roughly an ARW file, for
the deferred raw phase.

| Result | |
|---|---|
| 25MB file | _not yet run_ |
| Notes | |

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
| Shell chosen | _pending_ |
| Reason | |

## If ExifTool-WASM does not work out

In order of preference:

1. **Drive zeroperl directly** with ExifTool's own CLI argument list. Keeps real ExifTool.
2. **`piexifjs`** — writes GPS to JPEG in ~30KB of plain JS, no WASM. Fine for v1's JPEG-only
   scope, but gives up the ARW and video future, which is precisely why it is not the default.
3. **Native ExifTool binary on desktop, something else on Android.** Two backends, two code paths,
   two sets of bugs. Last resort.

Never exiv2 — it corrupts Sony ARW when writing GPS.
