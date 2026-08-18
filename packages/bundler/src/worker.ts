import { parentPort } from 'node:worker_threads';
import { buildCastSparkBundle } from './index.js';
import type { CastUnit } from './manifest.js';

/**
 * Bundle worker: builds one cast's spark bundle per message. The bundling
 * work is pure per-cast CPU+IO (scan cast dir -> read files -> deflate the
 * single-stream spark container), so N workers across N cores bundle N casts
 * concurrently. The main thread keeps all fs writes, so there's no write
 * contention and results land in the same deterministic layout.
 *
 * The unit (not just a key) is sent over so the worker can build the cast
 * straight from its path — re-running the full tree scan per cast was
 * O(casts^2) directory walks once deep containers like hof_furni expanded
 * the unit count into the thousands.
 */

export interface BundleWork {
  root: string;
  unit: CastUnit;
}

export interface BundleWorkResult {
  key: string;
  spark: Uint8Array;
  members: number;
  fontFiles: string[];
}

export interface BundleWorkError {
  key: string;
  error: string;
}

const port = parentPort;
if (port) {
  port.on('message', (work: BundleWork) => {
    const key = work.unit.group ? `${work.unit.group}/${work.unit.name}` : work.unit.name;
    try {
      const built = buildCastSparkBundle(work.root, work.unit);
      if (!built) throw new Error('cast directory has no files');
      const { spark, manifest } = built;
      const fontFiles: string[] = [];
      for (const cast of manifest.casts) {
        for (const rel of cast.fontFiles ?? []) fontFiles.push(rel);
      }
      const members = manifest.casts.reduce((n, c) => n + c.members.length, 0);
      const result: BundleWorkResult = { key, spark, members, fontFiles };
      // Transfer the buffer so the bytes move (not copy) to the main thread.
      const transfer = [result.spark.buffer] as ArrayBuffer[];
      port.postMessage(result, transfer);
    } catch (e) {
      const err: BundleWorkError = { key, error: e instanceof Error ? e.message : String(e) };
      port.postMessage(err);
    }
  });
}
