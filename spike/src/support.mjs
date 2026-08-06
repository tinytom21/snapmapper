/** Shared plumbing for the spike scripts. Console output and fixture loading. */

import { readdir, readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURES_DIR = path.join(here, '..', 'fixtures');
export const OUTPUT_DIR = path.join(here, '..', 'output');

export function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
  console.log('─'.repeat(Math.max(title.length, 24)));
}

export function result(pass, text) {
  console.log(`  ${pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${text}`);
}

export function note(text) {
  console.log(`  \x1b[2m${text}\x1b[0m`);
}

/** True when a module was run directly rather than imported. Windows-safe. */
export function isMain(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  return importMetaUrl === pathToFileURL(entry).href;
}

export async function listFixtures() {
  let entries;
  try {
    entries = await readdir(FIXTURES_DIR);
  } catch {
    return [];
  }

  return entries
    .filter((name) => /\.jpe?g$/i.test(name))
    .map((name) => path.join(FIXTURES_DIR, name))
    .sort();
}

/**
 * Load one fixture, or explain why the spike cannot proceed.
 *
 * Returns null rather than throwing so callers can report a clean "add
 * fixtures" message instead of a stack trace.
 */
export async function loadFixture(preferred) {
  const fixtures = await listFixtures();

  if (fixtures.length === 0) {
    console.log(`
  No fixtures found in spike/fixtures/.

  Copy a few real Sony A6400 JPEGs in there — copies, never the originals, and
  never the only copy. See spike/fixtures/README.md for what makes a useful set.

  Generic JPEGs will not answer the question this spike exists to answer: the
  whole point is whether Sony MakerNotes survive a write byte-identically.
`);
    return null;
  }

  const chosen = preferred ?? fixtures[0];
  const bytes = await readFile(chosen);

  return { path: chosen, name: path.basename(chosen), bytes };
}

export async function ensureOutputDir() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  return OUTPUT_DIR;
}

export function formatBytes(count) {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
  return `${(count / 1024 / 1024).toFixed(1)} MB`;
}

export function formatMs(ms) {
  return ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`;
}
