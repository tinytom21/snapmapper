# Handover

Everything needed to continue Snapmapper in a different Claude account or on a different machine.

**Read `HANDOFF.md` first, then `CLAUDE.md`.** Those two carry the state of the project and every
gotcha that cost real time; this file only covers the transfer itself.

---

## The starting prompt

Paste this into the first message of the new session, with the project directory open.

> I'm taking over Snapmapper, a cross-platform GeoSetter replacement that puts photos on a map and
> writes GPS into the files. It works and is deployed — read `HANDOFF.md` for where it stands and
> `CLAUDE.md` for the decisions and traps, both of which are detailed and current. Don't trust
> `docs/PLAN.md`; several of its premises were disproved.
>
> The short version: TypeScript monorepo, `packages/core` (platform-agnostic, no platform
> dependencies by rule) and `packages/ui` (React 19 + MapLibre 5 on Vite 7). Real ExifTool runs in
> the browser on WebAssembly and does all the metadata work. It's a PWA, installed on my Android
> phone, deployed to GitHub Pages on every push to `main`. My camera is a Sony A6400.
>
> How I'd like you to work:
>
> - **Push to `main` without asking.** I review on the live site, and nobody else uses it. Run
>   `npm test && npm run typecheck` first; a failing test blocks the deploy anyway.
> - **Verify by measuring, not by eyeballing.** Read `CLAUDE.md`'s notes on this — a long list of
>   real bugs in this project were found by measuring the DOM and would have been missed by looking.
> - **Tell me what you couldn't verify.** That matters more to me than confidence.
>
> Two features are designed but not started — they're at the bottom of `HANDOFF.md` under "What to
> pick up next". Start by reading the docs and telling me what you make of the state of things.

---

## What does not travel through git

**`spike/fixtures/` is gitignored, deliberately** — it holds real photographs, and the rule in
`CLAUDE.md` is never to run spike code against the only copy of anything. Copy the folder across by
hand. Without it these stop working, and they are the checks that prove correctness:

| script | needs | proves |
|---|---|---|
| `npm run splice --workspace spike` | A6400 JPEGs | the write path against native ExifTool — 184 checks |
| `npm run batch-verify --workspace spike` | A6400 JPEGs | batched reads match one-at-a-time — 93 checks |
| `npm run arw --workspace spike` | one ARW | reading raw from a 1MB head |
| `npm run xmp --workspace spike` | nothing | sidecars against native ExifTool — 10 checks |

The current set is seven ILCE-6400 JPEGs and one 24.9MB ARW. Any real A6400 files will do; generic
JPEGs will not, because the whole point is whether Sony MakerNotes survive.

**Native ExifTool** is the independent verifier and must be installed separately:

```bash
winget install OliverBetz.ExifTool
```

It installs per-user and only registers PATH in the registry, so an already-open shell will not find
it. The spike reads an `EXIFTOOL` environment variable as an absolute-path override for that case.
Node 22.18+ or 24+ is the other prerequisite — the test scripts rely on built-in TypeScript
stripping, so there is no build step.

**Nothing else is needed.** No API keys: the map tiles are OpenFreeMap and need no registration, and
reverse geocoding is Nominatim. No deploy secrets either — the GitHub Actions workflow uses the
token it is given automatically.

## If the repository moves to a different GitHub account

- The Pages URL changes, and `SNAPMAPPER_BASE` derives from the repository *name*, so a rename needs
  no edit but a move to a differently-named repo does.
- Update the links in `packages/ui/src/Landing.tsx` (the source-code link in the licences line) and
  in `HANDOFF.md`.
- Enable Pages with **GitHub Actions** as the source; the workflow does the rest.

## Working preferences worth carrying over

These were established over the previous sessions and are not obvious from the code.

- **Push finished work to `main` without asking.** The live site is the review surface. This does
  not extend to force-pushes or history rewrites.
- **Screenshots may not be available.** In the previous environment the browser pane did not
  composite, so UI work was verified by measuring the DOM — computed styles, bounding boxes,
  contrast arithmetic, decoding a rendered QR with the real jsQR. That caught defects eyeballing
  would have missed: a QR at 0.75 opacity, a 35px touch target, grid rows stretched to 25.78px, a
  dead `.qr canvas { width }` rule beaten by an inline style. If screenshots *do* work in the new
  environment, use them — but keep measuring as well.
- **Do not hand-roll an overlap checker.** `findOverlaps()` in `dev-preview.tsx` exists because
  every from-scratch attempt produced phantoms; naive rect intersection reports edge-touching
  elements as overlapping.
- **The licence notices are generated.** After any dependency change, run
  `npm run notices --workspace @snapmapper/ui`, or `THIRD-PARTY-NOTICES.md` will claim to ship
  something it does not.

## The one thing that is not settled

**Monetisation.** The code licences all permit it — see `README.md` — but the map tiles and place
names run on donated infrastructure sized for small applications. OpenFreeMap and Nominatim's own
terms are the things to read before charging for this, and they were never checked.
