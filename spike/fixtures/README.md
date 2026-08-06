# Fixtures

Put **copies** of real Sony A6400 JPEGs here. Everything in this folder except this file is
gitignored — camera files are large, and they are the user's photographs.

## Never point the spike at originals

The scripts here write modified copies to `spike/output/`, but a bug in a spike is exactly the
kind of thing that gets written before it is understood. Copy the files in.

## What makes a useful set

Six or so files, covering:

- One **already geotagged** by GeoSetter — the reference for what the output should look like.
- One with **no GPS at all** — the normal case.
- One shot in **portrait orientation** — proves the orientation tag survives.
- One **large** file (fine-quality JPEG, 10MB+) — for the timing measurement.
- One shot with a **creative style or DRO** applied, so the Sony MakerNotes are non-trivial.

Generic JPEGs from any other source will not do. The entire point of the exercise is proving that
`Sony:MakerNotes` survives a write byte-identically, and only a real Sony file has those.

## What the recorded numbers were measured against

The Q2/Q3/Q4 results in `spike/README.md` were taken against a **synthetic** 6000×4000 JPEG
(24MP, quality 90, 11.7MB — deliberately sized to match an A6400 fine JPEG), because no real files
were available. It has been deleted so it cannot be mistaken for a fixture or quietly skew a later
run.

That stand-in was enough for timing, memory and argument handling, all of which depend on file
*size* rather than file *provenance*. It was not enough for Q1: it has no MakerNotes, so the check
the whole spike exists for has never run. Adding real files here and re-running
`npm run write --workspace spike` is the remaining step.
