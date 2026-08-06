/**
 * Spike Q2 — what does the WASM wrapper's API actually look like?
 *
 * The package's documented surface is `parseMetadata(file, options)` and
 * `writeMetadata(file, tags, options)`, with reads accepting an `args` array.
 * Whether *writes* accept raw ExifTool arguments is undocumented, and it
 * matters: `-n`, `-P` and `-overwrite_original` are not optional for this
 * application, and `-XMP:GPS*` is how Lightroom sees a location at all.
 *
 * This script assumes nothing. It prints what is really exported, what the
 * results really look like, and whether raw arguments have any effect.
 */

import { isMain, loadFixture, note, section, result } from './support.mjs';
import { patchZeroperl } from './patch-zeroperl.mjs';

const REQUIRED_ARGS = ['-n', '-P', '-overwrite_original'];

export async function probeApi() {
  const findings = {};

  // Has to happen before the first import: the dependency cannot load its own
  // WASM on Windows, or from any path containing a space, without this.
  section('Upstream WASM loader patch');
  const patch = await patchZeroperl();
  findings.zeroperlPatch = patch;
  if (patch.patched) {
    result(true, 'patched @6over3/zeroperl-ts to resolve zeroperl.wasm correctly');
    note('Upstream uses URL.pathname as a filesystem path. See patch-zeroperl.mjs.');
  } else if (patch.alreadyPatched) {
    result(true, 'already patched');
  } else {
    result(false, patch.reason);
  }

  section('Package surface');

  let pkg;
  try {
    pkg = await import('@uswriting/exiftool');
  } catch (error) {
    result(false, `Could not import @uswriting/exiftool: ${error.message}`);
    console.log('\n  Run `npm install` at the repository root first.\n');
    return { failed: true };
  }

  const exports = Object.keys(pkg).sort();
  console.log(`  exports: ${exports.join(', ')}`);
  findings.exports = exports;

  for (const name of ['parseMetadata', 'writeMetadata']) {
    const fn = pkg[name];
    console.log(
      `  ${name}: ${typeof fn}${typeof fn === 'function' ? ` (arity ${fn.length})` : ''}`,
    );
  }

  const fixture = await loadFixture();
  if (!fixture) return { failed: true };

  // --- What shape does the file argument take in Node? -------------------
  section('File argument shape');

  const candidates = [
    {
      label: 'Binaryfile { name, data }',
      build: () => ({ name: fixture.name, data: fixture.bytes }),
    },
    {
      label: 'File (node:buffer global)',
      build: () =>
        typeof File === 'undefined'
          ? null
          : new File([fixture.bytes], fixture.name, { type: 'image/jpeg' }),
    },
  ];

  let workingFile = null;
  for (const candidate of candidates) {
    const built = candidate.build();
    if (!built) {
      result(false, `${candidate.label} — not available in this runtime`);
      continue;
    }

    try {
      const output = await pkg.parseMetadata(built, { args: ['-json', '-n'] });
      const ok = output?.success === true;
      result(ok, `${candidate.label} — ${describe(output)}`);
      if (ok && !workingFile) workingFile = candidate;
    } catch (error) {
      result(false, `${candidate.label} — threw: ${error.message}`);
    }
  }

  if (!workingFile) {
    console.log('\n  No file shape worked. Everything downstream is blocked on this.\n');
    return { failed: true, findings };
  }

  findings.fileShape = workingFile.label;

  // --- Which ExifTool does it actually wrap? -----------------------------
  section('Wrapped ExifTool version');

  const version = await pkg.parseMetadata(workingFile.build(), { args: ['-ver'] });
  const versionText = String(version?.data ?? '').trim();
  console.log(`  ExifTool ${versionText || '(unreported)'}`);
  findings.exifToolVersion = versionText;

  // --- Q2 proper: do raw arguments reach the write path? -----------------
  section('Raw argument passthrough on writes');

  const tags = { 'EXIF:GPSLatitude': '51.4778', 'EXIF:GPSLatitudeRef': 'N' };

  // Each argument is tried on its own. Passing the three together only tells you
  // that *something* in the set is a problem, and they turn out not to be
  // equivalent: one is required, and two are actively harmful here.
  const attempts = [
    { label: 'no options (control)', options: {} },
    { label: "args: ['-n']", options: { args: ['-n'] } },
    { label: "args: ['-P']", options: { args: ['-P'] } },
    { label: "args: ['-overwrite_original']", options: { args: ['-overwrite_original'] } },
    { label: `args: ${JSON.stringify(REQUIRED_ARGS)}`, options: { args: REQUIRED_ARGS } },
    // The control that matters. `extraArgs` is not a real option, so if this
    // "passes" it proves only that unknown keys are ignored — which is exactly
    // how a passthrough check fools itself into a green tick.
    { label: 'extraArgs (not a real option — expect it to be ignored)',
      options: { extraArgs: REQUIRED_ARGS } },
  ];

  findings.writeArgSupport = {};

  for (const attempt of attempts) {
    try {
      const output = await pkg.writeMetadata(workingFile.build(), tags, attempt.options);
      const bytes = output?.data;
      const ok = output?.success === true && bytes && bytes.byteLength > 0;

      result(ok, `${attempt.label} — ${describe(output)}`);
      findings.writeArgSupport[attempt.label] = ok ? 'accepted' : 'rejected';
    } catch (error) {
      result(false, `${attempt.label} — threw: ${error.message}`);
      findings.writeArgSupport[attempt.label] = `threw: ${error.message}`;
    }
  }

  // --- Passthrough proved by effect, not by exit code --------------------
  //
  // The only conclusive test is an argument whose result is visible in the
  // output file. Writing a tag via `args` rather than via the tags object does
  // that: if the description comes back, the argument genuinely reached
  // ExifTool's command line.
  section('Raw argument passthrough, proved by effect');

  const MARKER = 'passthrough-proof-42';
  try {
    const written = await pkg.writeMetadata(workingFile.build(), tags, {
      args: [`-EXIF:ImageDescription=${MARKER}`],
    });

    if (written?.success !== true) {
      result(false, `write with a tag-setting argument failed: ${truncate(written?.error)}`);
      findings.argsApplied = false;
    } else {
      const readBack = await pkg.parseMetadata(
        { name: fixture.name, data: new Uint8Array(written.data) },
        { args: ['-json', '-EXIF:ImageDescription'] },
      );
      const applied = String(readBack?.data ?? '').includes(MARKER);
      result(applied, applied
        ? 'an argument set a tag that reads back — arguments genuinely reach ExifTool'
        : 'the argument was accepted but had no effect — it is being ignored');
      findings.argsApplied = applied;
    }
  } catch (error) {
    result(false, `passthrough proof threw: ${error.message}`);
    findings.argsApplied = false;
  }

  return { findings };
}

function describe(output) {
  if (output === undefined || output === null) return 'returned nothing';
  if (typeof output !== 'object') return `returned ${typeof output}`;

  const keys = Object.keys(output);
  if (output.success === false) return `success: false, error: ${truncate(output.error)}`;

  return `keys [${keys.join(', ')}], data: ${describeData(output.data)}`;
}

/**
 * Writes return an ArrayBuffer, not the Uint8Array the plan assumed. Naming the
 * concrete type here is the point of the probe, so report it precisely rather
 * than collapsing everything unfamiliar to 'object'.
 */
function describeData(data) {
  if (data === undefined) return 'no data';
  if (data instanceof ArrayBuffer) return `ArrayBuffer(${data.byteLength})`;
  if (ArrayBuffer.isView(data)) return `${data.constructor.name}(${data.byteLength})`;
  if (typeof data === 'string') return `string(${data.length} chars)`;
  return typeof data;
}

function truncate(value, limit = 120) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

if (isMain(import.meta.url)) {
  await probeApi();
}
