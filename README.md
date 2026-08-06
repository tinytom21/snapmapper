# photo-geotagger

A cross-platform replacement for [GeoSetter](https://geosetter.de/en/main-en/): put photos on a
map, place them by hand, and write GPS into the files. Runs on Android phone/tablet **and** any PC.

Built for **Sony A6400** files, which have no GPS of their own.

> **Status: Phase 0, not yet started.** This repository is scaffolding and a spike harness. Nothing
> in it has been executed — it was prepared on a machine where Node.js could not be installed.
> Start with [HANDOFF.md](HANDOFF.md).

## Why this exists

GeoSetter does the job but is Windows-only and no longer updated. Its backend, ExifTool, was never
the limitation — ExifTool is a Perl library that runs on Linux, macOS and BSD perfectly well. The
limitation is GeoSetter's Delphi GUI.

So the plan keeps ExifTool and replaces the shell around it. ExifTool now compiles to WebAssembly,
which means the *same real ExifTool* can run on a desktop and inside an Android webview — no Perl
install, no Termux, no server.

## Layout

```
docs/PLAN.md          The approved design. Read after HANDOFF.md.
packages/core/        Platform-agnostic logic. No filesystem, no DOM.
  src/gps.ts          Decimal <-> EXIF DMS, hemisphere refs
  src/time.ts         Camera-clock drift, timezones, GPS timestamps
  src/exif-tags.ts    Which tags get written, and why
  src/storage.ts      FileStore — the one seam between core and each platform
spike/                Phase 0. Decides the backend and the shell.
```

`packages/ui` and `packages/shells` do not exist yet; they are blocked on the spike's shell
decision.

## Getting started

```bash
winget install OpenJS.NodeJS.LTS
```

```bash
winget install PhilHarvey.ExifTool
```

```bash
npm install && npm test
```

Requires Node 22.18+ or 24+ — the packages rely on Node's built-in TypeScript stripping, so there
is no build step.

Native ExifTool is not a runtime dependency of the application. It is the **independent verifier**
for the spike: checking ExifTool-WASM's output with a separate native ExifTool is what makes the
correctness check mean anything.

## Scope

**v1** — JPEG only, written in place. Manual placement on a map. Camera-clock and timezone offset
correction. Map view of tagged photos. Online tiles, with the tile layer arranged so offline can
drop in later.

**Deferred** — Sony ARW (XMP sidecars first, which is what raw editors read anyway), video, GPX
track import, built-in track logging, reverse geocoding, IPTC editing, offline tiles.

## Licensing

ExifTool and Perl are each dual-licensed under the Artistic License or the GPL. This project
**elects the Artistic License**, which imposes no copyleft on our own code. The full dependency
chain and its obligations are recorded in [docs/PLAN.md](docs/PLAN.md); the short version is that
shipping a third-party licenses screen discharges them.
