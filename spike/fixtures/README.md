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
