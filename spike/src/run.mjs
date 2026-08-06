/**
 * Runs the whole of Phase 0 and prints a verdict.
 *
 * The point is a decision, not a green tick: does ExifTool-WASM stay as the
 * backend, and which native shell gets built on top of it.
 */

import { note, result, section } from './support.mjs';
import { probeApi } from './probe-api.mjs';
import { writeGpsChecks } from './write-gps.mjs';
import { benchmark } from './benchmark.mjs';

console.log(`
\x1b[1mphoto-geotagger — Phase 0 spike\x1b[0m

Answering, in order:
  Q1  Does ExifTool-WASM write correct GPS to a real A6400 JPEG, intact?
  Q2  Do raw ExifTool arguments reach the write path?
  Q3  What does it cost — bundle, cold start, per-photo?
  Q4  Where is the memory ceiling?
`);

const probe = await probeApi();
const write = probe.failed ? { failed: true, skipped: true } : await writeGpsChecks();
const bench = probe.failed ? { failed: true, skipped: true } : await benchmark();

section('Summary');

const rows = [
  ['Q2  API shape and raw args', probe],
  ['Q1  Correctness on real files', write],
  ['Q3/Q4  Cost and ceiling', bench],
];

for (const [label, outcome] of rows) {
  if (outcome.skipped) {
    note(`SKIP  ${label} — blocked by an earlier failure`);
  } else {
    result(!outcome.failed, label);
  }
}

section('What to do with this');

if (write.failed) {
  console.log(`
  Do not start Phase 1 yet.

  If MakerNotes changed, ExifTool-WASM is the wrong backend and the fallbacks
  are, in order: drive zeroperl directly with ExifTool's own CLI arguments, or
  for JPEG-only work drop to piexifjs (~30KB, no WASM) and give up the ARW and
  video future.

  If only the raw-argument checks failed, that is survivable — the shell can
  restore the file modification date itself, which is most of what -P buys.
`);
} else {
  console.log(`
  Backend confirmed. Next: the shell decision.

  Tauri 2 unless the Android SAF path cannot reliably write to a removable card
  — that requirement has no workaround, and Capacitor is the fallback.

  Run \`npm run browser --workspace spike\` before deciding. Node numbers are the
  optimistic case; the webview is what Android actually runs.

  Record the results in spike/README.md, then build the desktop MVP first.
`);
}

process.exitCode = probe.failed || write.failed ? 1 : 0;
