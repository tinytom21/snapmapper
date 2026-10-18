# Handover

Moving Snapmapper to another machine or Claude account. **Read `HANDOFF.md` first, then
`CLAUDE.md`** — they carry the state of the project and every trap that cost real time. This file
only covers the move itself.

Last moved: **2026-10-18, from Windows 11 to Linux Mint 23.**

---

## Work instruction: Windows PC → Linux Mint

About twenty minutes. Steps 1–5 on the Linux PC; step 3 needs the old PC or a USB stick.

### 1. Install the prerequisites

```bash
sudo apt update && sudo apt install -y git curl libimage-exiftool-perl
```

**Node 22.18 or newer is required** — the tests run TypeScript through Node's built-in type
stripping, so an older Node fails on the first `.ts` import. Check what apt would give you before
trusting it:

```bash
node -v
```

If that is missing or below 22.18, install the current LTS from NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs
```

**A Chromium-based browser is required to run the app.** Mint ships Firefox, which has no
`showDirectoryPicker` — the app will load and then report the platform as unsupported, which is
correct and looks like a bug. Install Chromium from the Software Manager, or Google Chrome from
google.com/chrome.

### 2. Clone and authenticate

```bash
git clone https://github.com/tinytom21/snapmapper.git ~/snapmapper
```

Clone to a path **without spaces**. The Windows copy lived in `photo geotagging` and that space is
what the zeroperl path patch in `spike/` exists to survive; there is no reason to keep testing it.

The repository is public, so cloning needs no login — **pushing does**, and every push to `main` is
a deploy. The simplest route:

```bash
sudo apt install -y gh && gh auth login
```

Choose GitHub.com, HTTPS, and *Login with a web browser*. `gh` then acts as git's credential helper.
Set the commit identity too, matching the Windows history:

```bash
git -C ~/snapmapper config user.name "tbailey"
```

```bash
git -C ~/snapmapper config user.email "tinytom21@gmail.com"
```

### 3. Copy the photo fixtures across by hand

`spike/fixtures/` is **gitignored on purpose** — it is the user's photographs. On the Windows PC it
is `C:\CLAUDE_CODE\photo geotagging\spike\fixtures\`: seven ILCE-6400 JPEGs and one ARW, **65MB**.
Copy those eight files (not `README.md`, which git already brought) into `~/snapmapper/spike/fixtures/`
by USB stick or a network share. They are copies already; still, never let a spike near an original.

### 4. Install and prove it works

```bash
cd ~/snapmapper && npm ci && npm test && npm run typecheck
```

Expect **634 tests, 0 failures** (359 core, 275 UI) and a clean typecheck. Then the checks that need
native ExifTool and the fixtures:

```bash
exiftool -ver
```

```bash
npm run raw-thumb --workspace spike && npm run thumb --workspace spike && npm run splice --workspace spike
```

On Windows these gave 5/0, 7 of 7 by hand, and 184 checks. **The splice check compares against
native ExifTool, so its version matters a little**: Windows had 13.59, and Ubuntu-family repositories
can lag well behind. If a check fails on a tag that looks like a naming difference rather than
damage, compare versions before suspecting the code. The current release is a tarball from
exiftool.org; point `EXIFTOOL` at it to use it without installing:

```bash
EXIFTOOL=~/Image-ExifTool-13.xx/exiftool npm run splice --workspace spike
```

### 5. Run it, and start Claude

```bash
npm run dev
```

Open http://localhost:5173/ in **Chromium or Chrome**. Then start Claude in `~/snapmapper` and paste
the prompt below.

---

## The starting prompt

> I'm moving Snapmapper to this Linux machine from a Windows PC. It's a cross-platform GeoSetter
> replacement — photos on a map, GPS written into the files — and it works and is deployed. Read
> `HANDOVER.md` (the move), `HANDOFF.md` (where it stands) and `CLAUDE.md` (decisions and traps) —
> all current as of the move. Don't trust `docs/PLAN.md`; several of its premises were disproved.
>
> TypeScript monorepo: `packages/core` (platform-agnostic, no platform dependencies by rule) and
> `packages/ui` (React 19 + MapLibre 5 on Vite 7). Real ExifTool runs in the browser on WebAssembly.
> It's a PWA on my Android phone, deployed to GitHub Pages on every push to `main`. My camera is a
> Sony A6400.
>
> How I'd like you to work:
>
> - **Push to `main` without asking.** I review on the live site, and nobody else uses it. Run
>   `npm test && npm run typecheck` first; a failing test blocks the deploy anyway.
> - **Verify by measuring, not by eyeballing.** `CLAUDE.md` explains why — a long list of real bugs
>   here were found by measuring the DOM.
> - **Tell me what you couldn't verify.** That matters more to me than confidence.
> - **Only optimise for what's common across cameras**, not for my A6400 specifically. A
>   format-level gain (anything every camera writing that format benefits from) is fine.
>
> First, confirm the move worked: `npm test && npm run typecheck`, and the spike checks in
> `HANDOVER.md` step 4. Then tell me what you make of the state of things.

---

## What does not travel through git

| what | why | where it went |
|---|---|---|
| `spike/fixtures/` | real photographs, gitignored | copied by hand, step 3 |
| native ExifTool | the independent verifier | installed, step 1 |
| Claude's memory | stored per machine | **folded into this file and `CLAUDE.md`** — see below |
| browser state on the phone | the remembered folders, the session backup | stays on the phone; nothing to move |

The spike scripts that need fixtures, and what they prove:

| script | needs | proves |
|---|---|---|
| `npm run splice --workspace spike` | A6400 JPEGs | the write path against native ExifTool — 184 checks |
| `npm run batch-verify --workspace spike` | A6400 JPEGs | batched reads match one-at-a-time — 93 checks |
| `npm run thumb --workspace spike` | A6400 JPEGs | hand-read JPEG thumbnails are byte-identical — 7 of 7 |
| `npm run raw-thumb --workspace spike` | one ARW | hand-read raw thumbnails are byte-identical — 5 checks |
| `npm run arw --workspace spike` | one ARW | reading raw metadata from a 1MB head |
| `npm run prior-verify --workspace spike` | A6400 JPEGs | earlier sessions' copies and sidecars are read back — 15 checks |
| `npm run xmp --workspace spike` | nothing | sidecars against native ExifTool — 10 checks |

Any real A6400 files will do; generic JPEGs will not, because the point is whether Sony MakerNotes
survive.

**Nothing else is needed.** No API keys — the tiles are OpenFreeMap, geocoding is Nominatim. No
deploy secrets — the workflow uses the token GitHub gives it.

## What changed for Linux, and what to watch for

- **The spike's ExifTool lookup was Windows-only, and is fixed.** Four scripts defaulted to
  `%LOCALAPPDATA%\Programs\ExifTool\exiftool.exe` unconditionally, which on Linux resolves to a
  relative path that does not exist. `exifToolPath()` in `spike/src/support.mjs` now uses `EXIFTOOL`,
  then the Windows install on Windows, then `exiftool` on PATH. Re-verified on Windows after the
  change; **not yet run on Linux** — step 4 is that check.
- **`.claude/settings.local.json` is Windows-specific** — permission rules naming `C:/Users/...`
  paths and `taskkill`. Harmless on Linux, just dead. Prune it if it is in the way.
- **GeoSetter does not exist on Linux.** It was installed on the Windows PC as a reference for
  diffing tag output, and nothing depends on it. Native ExifTool is the verifier that matters.
- **Line endings.** The Windows checkout used `core.autocrlf=true`, so the repository holds LF and a
  Linux checkout is clean. If git ever shows every line of a file changed, that is the cause.
- **Paths in the docs.** `CLAUDE.md` and `HANDOFF.md` mention `C:\` paths and `winget` in places,
  describing where things were measured. The commands in this file are the Linux ones.

## Working preferences, from Claude's memory on the old machine

Memory does not travel, so these are written down here.

- **Push finished work to `main` without asking**, after `npm test && npm run typecheck`. The live
  site is the review surface and the user is its only user. This does not extend to force-pushes or
  history rewrites, and would lapse if the site gained other users. In the old environment the
  sandbox blocked network access, so `git push` needed the sandbox disabled for that one command.
- **Screenshots did not work** in the old environment's browser pane, so UI work was verified by
  measuring the DOM — computed styles, bounding boxes, contrast arithmetic, decoding a rendered QR
  with the real jsQR. That caught defects eyeballing would have missed. If screenshots work here,
  use them, but keep measuring.
- **MapLibre's tile loading cannot be observed in a harness** — it fetches inside a `blob:` worker,
  so the map never finishes loading there. That gap is how the `addProtocol` `json` bug shipped.
- **Do not hand-roll an overlap checker.** Use `findOverlaps()` in `dev-preview.tsx`.
- **Performance questions get answered on the phone.** The chooser's footer has a *Timings* link;
  the user pastes the report back. Four separate faults were invisible on a desktop and obvious in
  one paste. Ask for one rather than guessing.
- **The licence notices are generated.** After any dependency change, run
  `npm run notices --workspace @snapmapper/ui`.

## If the repository moves to a different GitHub account

- The Pages URL changes, and the base path derives from the repository *name*, so a rename needs no
  edit but a move to a differently-named repo does.
- Update the links in `packages/ui/src/Landing.tsx` (the source-code link) and in `HANDOFF.md`.
- Enable Pages with **GitHub Actions** as the source; the workflow does the rest.

## The one thing that is not settled

**Monetisation.** The code licences all permit it — see `README.md` — but the tiles and place names
run on donated infrastructure sized for small applications. OpenFreeMap's and Nominatim's terms are
the things to read before charging for this, and they were never checked.
