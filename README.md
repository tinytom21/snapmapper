# Snapmapper

**Put your snapshots on the map.** Select photos, tap where they were taken, and the GPS
coordinates are written into the files themselves.

A cross-platform replacement for [GeoSetter](https://geosetter.de/en/main-en/) that runs in a
browser — on a PC, and on an Android phone straight off the camera's SD card. Built for **Sony
A6400** files, which have no GPS receiver of their own.

**Nothing is uploaded.** Your photographs are read and written locally, by code running in your
browser. There is no server, no account, and no network request containing a photograph — the app
works with the network switched off entirely.

## What it does

- **Place photos by hand on a map.** Select one or fifty, tap the map, done.
- **Or load a track** — a GPX from a logger app, or a **Google Timeline export**, which needs
  nothing running on the day — and let it place them by time. Point it once at the folder your
  logger writes to and it finds the right file for each shoot by itself, including across midnight. Anything it cannot place confidently is
  left alone and reported, rather than dropped somewhere plausible — and it matches against the
  *corrected* camera clock, so the two features work together.
- **Writes real EXIF GPS** with a genuine ExifTool, compiled to WebAssembly — the same ExifTool
  everything else in this space uses, not a reimplementation.
- **Saves copies by default**, into a `geotagged` folder beside your originals. Your originals are
  never opened for writing.
- **Verifies every write** by reading the file back and checking both the coordinates *and* that
  ExifTool raises no structural warning. A file whose maker notes were damaged still reports
  perfect coordinates, so checking the values alone is not enough.
- **Corrects the camera clock.** Photograph a QR code the app displays, tell it which photo that
  is, and it works out your camera's offset — then applies it to the GPS timestamps. Timezones
  can be corrected afterwards without redoing the measurement.
- **Installs as an app.** Add it to your home screen and it runs offline, with no server anywhere.

## Try it

The hosted build is at **https://tinytom21.github.io/snapmapper/** — open it in Chrome or
Edge (the File System Access API is required to write files, which Firefox and Safari do not have).

To run it yourself:

```bash
npm install && npm run dev
```

Then open http://localhost:5173/. The `localhost` part matters: writing needs a secure context.

Requires Node 22.18+ or 24+. There is no build step for the TypeScript packages — they rely on
Node's built-in type stripping.

## Status

Working, and used in earnest on both a PC and an Android phone against real A6400 files. JPEG only
so far.

**Deferred:** Sony ARW (XMP sidecars first, which is what raw editors read anyway), video,
built-in track logging, reverse geocoding, offline map tiles.

**Known limitation:** no browser can set a file's modification date, so copies carry the date they
were written. Your originals keep theirs, which is most of why copies are the default.

## Layout

```
packages/core/   Platform-agnostic logic. No filesystem, no DOM, 180 tests.
  src/gps.ts         Decimal <-> EXIF DMS, hemisphere refs
  src/time.ts        Camera-clock drift, timezones, GPS timestamps
  src/jpeg.ts        The splice: hand ExifTool a header stub, reattach the image data
  src/exiftool.ts    The write path
  src/session.ts     Staged edits and undo — nothing touches disk until you save
  src/verify-write.ts  Read it back and prove it landed
packages/ui/     React + MapLibre. The only platform-specific file is browser-file-store.ts.
spike/           How the approach was chosen, and where it is checked against native ExifTool.
docs/PLAN.md     The original design. A few of its premises turned out to be wrong; see CLAUDE.md.
```

`CLAUDE.md` and `HANDOFF.md` are the orientation documents, and they record the things that cost
real time to learn — including three confident assumptions that turned out to be false.

## Licensing

Snapmapper is under the **Artistic License 2.0** — see [LICENSE](LICENSE). No copyleft: the source
may be kept public or taken private, and the tool may be sold.

ExifTool and Perl are each dual-licensed under the Artistic License or the GPL, and this project
**elects the Artistic License**. Taking the GPL instead would have made the whole bundle copyleft
and conflicted with the App Store, so the election is load-bearing rather than a preference.

Everything shipped alongside it — MapLibre (BSD-3-Clause), React and node-qrcode (MIT),
@uswriting/exiftool, zeroperl and jsQR (Apache-2.0) — obliges us to reproduce its notices when
distributing a build, and a bundled web app is a distribution. Those notices are generated from the
licence texts as installed and served with the app:

```bash
npm run notices --workspace @snapmapper/ui
```

The result is [packages/ui/public/THIRD-PARTY-NOTICES.md](packages/ui/public/THIRD-PARTY-NOTICES.md),
linked from the landing screen. **Do not edit it by hand** — regenerate it after changing a
dependency, or it will claim to ship something it does not.

Note that `@uswriting/exiftool` strips ExifTool own POD when bundling, so the copy actually shipped
carries no notice of its own. That is the strongest reason the generated file exists.

The map is OpenStreetMap data under the ODbL, credited unconditionally on every screen showing a
map; place names come from Nominatim under its usage policy. Neither is a code licence, but both
carry obligations — and both are the things to revisit before charging for this, since they run on
donated infrastructure sized for small applications.

## Credits

- [ExifTool](https://exiftool.org/) by Phil Harvey, which does all the metadata work.
- [@uswriting/exiftool](https://github.com/6over3/exiftool) and
  [zeroperl](https://github.com/6over3/zeroperl), which run it in a browser.
- [MapLibre GL](https://maplibre.org/) and [OpenStreetMap](https://www.openstreetmap.org/)
  contributors for the map.
