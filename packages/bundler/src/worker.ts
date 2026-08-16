import { parentPort } from 'node:worker_threads';
import { buildSparkBundle } from './index.js';

/**
 * Bundle worker: builds one cast's spark bundle per message. The bundling
 * work is pure per-cast CPU+IO (scan cast dir -> read files -> deflate the
 * single-stream spark container), so N workers across N cores bundle N casts
 * concurrently. The main thread keeps all fs writes, so there's no write
 * contention and results land in the same deterministic layout.
 */

export interface BundleWork {
  root: string;
  key: string;
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
    try {
      const { spark, manifest } = buildSparkBundle(work.root, [work.key]);
      const fontFiles: string[] = [];
      for (const cast of manifest.casts) {
        for (const rel of cast.fontFiles ?? []) fontFiles.push(rel);
      }
      const members = manifest.casts.reduce((n, c) => n + c.members.length, 0);
      const result: BundleWorkResult = { key: work.key, spark, members, fontFiles };
      // Transfer the buffer so the bytes move (not copy) to the main thread.
      const transfer = [result.spark.buffer] as ArrayBuffer[];
      port.postMessage(result, transfer);
    } catch (e) {
      const err: BundleWorkError = { key: work.key, error: e instanceof Error ? e.message : String(e) };
      port.postMessage(err);
    }
  });
}
