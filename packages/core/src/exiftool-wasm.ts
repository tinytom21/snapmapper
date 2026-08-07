/**
 * `MetadataBackend` over `@uswriting/exiftool` — real ExifTool 13.42 on zeroperl.
 *
 * The only file in `core` that knows the WASM package exists. Everything else talks to
 * the `MetadataBackend` interface, which is what makes the write path testable without
 * booting a Perl interpreter and what would let the backend be swapped without
 * touching the logic that was so expensive to get right.
 *
 * It still runs everywhere — Node, a desktop webview, an Android webview — so this does
 * not breach `core`'s no-platform-dependencies rule. There is no `node:` import and no
 * DOM access here.
 *
 * Two hazards this file exists to contain:
 *
 *   - **Blob input.** The package accepts a `File` and then reads it one
 *     `blob.slice().arrayBuffer()` per syscall, which costs ~69× on a phone. The
 *     `Binaryfile` shape below is always used, never a `File`, and `BackendInput.bytes`
 *     is typed to make the alternative hard to express.
 *   - **Warnings reported as failures.** `success: false` arrives for a bare warning
 *     about file times, so `ok` is reported honestly and the *classification* is left
 *     to `exiftool.ts`, which knows which warnings matter.
 */

import type { BackendInput, BackendResult, MetadataBackend } from './exiftool.ts';
import type { TagSet } from './exif-tags.ts';

/** The subset of `@uswriting/exiftool` used here. Declared, not imported, so `core` */
/** compiles without the package present and the dependency stays honest. */
export interface ExifToolWasmModule {
  parseMetadata(
    file: WasmBinaryFile,
    options?: { args?: string[] },
  ): Promise<WasmOutput<string>>;
  writeMetadata(
    file: WasmBinaryFile,
    tags: Record<string, string | number | boolean | (string | number | boolean)[]>,
    options?: { args?: string[] },
  ): Promise<WasmOutput<ArrayBuffer>>;
  dispose?(): Promise<void>;
}

/** Bytes plus a filename. Never a `File` — see the note above. */
interface WasmBinaryFile {
  name: string;
  data: Uint8Array;
}

type WasmOutput<T> =
  | { success: true; data: T; exitCode: 0 }
  | { success: false; data: undefined; error: string; exitCode: number | undefined };

/**
 * Wrap the WASM module as a `MetadataBackend`.
 *
 * The module is passed in rather than imported so that a host can control when a 24MB
 * WASM binary is loaded — on Android that is a visible cost at startup.
 */
export function createWasmBackend(wasm: ExifToolWasmModule): MetadataBackend {
  return {
    async write(input: BackendInput): Promise<BackendResult> {
      assertBytes(input.bytes);

      const output = await wasm.writeMetadata(
        { name: input.name, data: input.bytes },
        toWasmTags(input.tags ?? {}),
        { args: [...input.args] },
      );

      if (output.success) {
        // ArrayBuffer, not Uint8Array — the plan assumed otherwise; spike Q2 corrected it.
        return { ok: true, data: new Uint8Array(output.data), message: undefined };
      }
      return { ok: false, data: undefined, message: output.error };
    },

    async read(input: Omit<BackendInput, 'tags'>): Promise<BackendResult<string>> {
      assertBytes(input.bytes);

      const output = await wasm.parseMetadata(
        { name: input.name, data: input.bytes },
        { args: [...input.args] },
      );

      if (output.success) return { ok: true, data: output.data, message: undefined };
      return { ok: false, data: undefined, message: output.error };
    },
  };
}

/**
 * Read a `Blob` or `File` into bytes, once, in bulk.
 *
 * The correct way to get browser-sourced data into the backend, and the reason this is
 * exported rather than left to each caller: doing it per-read is the ~69× mistake.
 */
export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function assertBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(
      'the WASM backend must be given a Uint8Array — passing a Blob or File makes '
      + 'zeroperl read it one slice per syscall, ~69× slower on a phone',
    );
  }
}

/** ExifTool's write API takes strings; `TagSet` is already string-valued. */
function toWasmTags(tags: TagSet): Record<string, string> {
  return { ...tags };
}
