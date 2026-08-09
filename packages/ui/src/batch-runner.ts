/**
 * A `BatchRunner` over zeroperl, so several photographs share one ExifTool invocation.
 *
 * `@uswriting/exiftool` is used everywhere else in this app and is used here too — for its
 * *script*, not its API. Its `parseMetadata` mounts one file and appends one path, and there is no
 * way in from outside to add a second. Underneath, though, it is doing something very simple:
 * create a `MemoryFileSystem`, `addFile('/exiftool', script)`, `addFile` the input, and
 * `runFile('/exiftool', [...args, path])`. This does the same with several paths.
 *
 * The script arrives through `virtual:exiftool-script`, extracted from the wrapper's own bundle at
 * build time by `vite-plugin-exiftool-script.ts`. It is therefore always the script the wrapper
 * itself would have run, which matters: reading with one ExifTool and writing with another is a
 * mismatch nothing would report.
 *
 * ## What is deliberately shared, and what is deliberately not
 *
 * One interpreter is created and reused, because creating it is the expensive part — that is the
 * whole finding this file rests on. `reset()` before each run clears interpreter state, and every
 * mounted file is removed afterwards in a `finally`, or a folder of two hundred photographs would
 * accumulate two hundred header stubs in memory that nothing ever frees.
 *
 * The **write** path is untouched. It still goes through the wrapper, one file at a time, through
 * `createWasmBackend`. Writing is not where the time goes, saving is a deliberate act the user is
 * already waiting on, and the write path took a great deal of measurement to get right — there is
 * nothing to gain by putting it on new machinery.
 */

import type { BatchFile, BatchRun, BatchRunner } from '@snapmapper/core';

/**
 * The zeroperl surface used here. Declared rather than imported for its types, so this file states
 * exactly what it depends on and a change upstream shows up as a type error rather than at runtime.
 */
interface ZeroperlModule {
  MemoryFileSystem: new (roots: Record<string, string>) => VirtualFileSystem;
  ZeroPerl: {
    create(options: {
      fileSystem: VirtualFileSystem;
      stdout: (chunk: string | Uint8Array) => void;
      stderr: (chunk: string | Uint8Array) => void;
    }): Promise<PerlInterpreter>;
  };
}

interface VirtualFileSystem {
  addFile(path: string, contents: string | Uint8Array): void;
  removeFile(path: string): void;
}

interface PerlInterpreter {
  reset(): Promise<void>;
  flush(): void;
  runFile(path: string, args: readonly string[]): Promise<{
    success: boolean;
    exitCode: number | undefined;
  }>;
}

/**
 * Build a runner, or report why not.
 *
 * Never throws. Batching is an optimisation over a path that already works, so every way it can
 * fail to become available — the virtual module missing, zeroperl failing to load its 24MB binary,
 * an older browser — has to end in the caller quietly using the one-at-a-time reader. A folder
 * that loads slowly is a disappointment; a folder that refuses to load is a broken app.
 */
export async function createBatchRunner(): Promise<BatchRunner | undefined> {
  /*
   * Built once for the life of the page.
   *
   * Each runner owns a zeroperl interpreter, and creating one means instantiating the 24MB WASM
   * again — so a second folder, or a Re-scan, would otherwise pay the whole setup cost afresh and
   * leave the first interpreter alive holding its memory. `loadPhotos` calls this on every load,
   * which is the right shape for the caller and the wrong one to take literally.
   */
  cached ??= build().catch(() => undefined);
  return cached;
}

let cached: Promise<BatchRunner | undefined> | undefined;

async function build(): Promise<BatchRunner | undefined> {
  try {
    const [{ default: script }, zeroperl] = await Promise.all([
      import('virtual:exiftool-script'),
      import('@6over3/zeroperl-ts') as Promise<unknown> as Promise<ZeroperlModule>,
    ]);

    if (typeof script !== 'string' || script.length === 0) return undefined;

    return new ZeroperlBatchRunner(zeroperl, script);
  } catch {
    return undefined;
  }
}

class ZeroperlBatchRunner implements BatchRunner {
  readonly #zeroperl: ZeroperlModule;
  readonly #script: string;

  #started: Promise<{ perl: PerlInterpreter; files: VirtualFileSystem }> | undefined;
  #out = '';
  #err = '';

  /**
   * One run at a time.
   *
   * The interpreter is a single shared machine with one stdout: two overlapping runs would
   * interleave their JSON into the same buffer and both would fail to parse — or, far worse,
   * one would parse and carry the other's records. Nothing in the app currently loads two folders
   * at once, and this makes sure that stays harmless if something ever does.
   */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(zeroperl: ZeroperlModule, script: string) {
    this.#zeroperl = zeroperl;
    this.#script = script;
  }

  async run(files: readonly BatchFile[], args: readonly string[]): Promise<BatchRun> {
    const mine = this.#queue.then(() => this.#runExclusive(files, args));
    // Swallowed on the queue only; `mine` still rejects for the caller. Without this a single
    // failed batch would poison every later one.
    this.#queue = mine.catch(() => undefined);
    return mine;
  }

  async #runExclusive(files: readonly BatchFile[], args: readonly string[]): Promise<BatchRun> {
    const { perl, files: fs } = await this.#start();

    /*
     * Paths are prefixed with the file's position, and that is not decoration.
     *
     * Two photographs picked from different folders can share a name, and mounting the second at
     * the same path would silently replace the first — one record back for two files, with the
     * loader then unable to tell which. The index makes every path unique by construction, and
     * the extension is preserved because ExifTool uses it to choose a format.
     */
    const paths = files.map((file, index) => `/${index}_${sanitise(file.name)}`);

    this.#out = '';
    this.#err = '';
    await perl.reset();

    try {
      for (const [index, file] of files.entries()) {
        fs.addFile(paths[index] as string, file.bytes);
      }

      const result = await perl.runFile('/exiftool', [...args, ...paths]);
      perl.flush();

      /*
       * `exitCode` is reported, not judged. ExifTool exits 1 when *any* file in the batch failed
       * while still returning good records for all the others — measured with a corrupt file in
       * the middle of five: five records out, four intact. `readManyTags` reads the records and
       * the stderr; there is nothing for this layer to decide.
       */
      return {
        stdout: this.#out,
        stderr: this.#err,
        paths,
        exitCode: result.exitCode,
      };
    } finally {
      for (const path of paths) {
        try { fs.removeFile(path); } catch { /* never mounted, or already gone */ }
      }
    }
  }

  /** Create the interpreter once. Shared across every batch; recreated only if creation failed. */
  #start(): Promise<{ perl: PerlInterpreter; files: VirtualFileSystem }> {
    this.#started ??= this.#create().catch((error: unknown) => {
      // Cleared so a transient failure — a WASM fetch that timed out — can be retried rather than
      // leaving the runner permanently broken.
      this.#started = undefined;
      throw error;
    });
    return this.#started;
  }

  async #create(): Promise<{ perl: PerlInterpreter; files: VirtualFileSystem }> {
    const decoder = new TextDecoder();
    const files = new this.#zeroperl.MemoryFileSystem({ '/': '' });
    files.addFile('/exiftool', this.#script);

    const perl = await this.#zeroperl.ZeroPerl.create({
      fileSystem: files,
      stdout: (chunk) => {
        this.#out += typeof chunk === 'string' ? chunk : decoder.decode(chunk);
      },
      stderr: (chunk) => {
        this.#err += typeof chunk === 'string' ? chunk : decoder.decode(chunk);
      },
    });

    return { perl, files };
  }
}

/**
 * Make a filename safe to be a path component.
 *
 * A name is user data — it comes off a card — and a slash in one would mount the file into a
 * directory that does not exist. Everything unusual becomes an underscore; the extension survives
 * because ExifTool chooses its parser from it.
 */
function sanitise(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}
