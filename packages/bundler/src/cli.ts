#!/usr/bin/env node
import { copyFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { buildSparkBundle } from './index.js';
import { listCastUnits, nodeFs } from './manifest.js';
import type { BundleWork, BundleWorkError, BundleWorkResult } from './worker.js';

interface Args {
  root: string;
  casts?: string[];
  out: string;
  outDir?: string;
  ext?: string;
  /** Parallel bundle workers (default: CPU count). --jobs 1 = sequential. */
  jobs?: number;
}

const USAGE = `spark bundle <root> [<outDir>]   — bundle every cast under <root> into <outDir> (one .zip/.spark per cast)
  positional: <root>    exported cast directory (default "exported")
              <outDir>  output directory (defaults to a single bundle when omitted)
  flags: --root <dir> --out-dir <dir> --casts a,b,c --out <file> --ext zip|spark
         --jobs <n>     parallel workers (default: CPU count; 1 = sequential)
  alias:  habbo-bundle (old name)`;

function parseArgs(argv: string[]): Args {
  // `spark bundle ...` — accept the optional subcommand so the CLI reads like
  // a proper tool (the old `habbo-bundle <root> ...` form still works).
  if (argv[0] === 'bundle') argv = argv.slice(1);
  const args: Args = { root: 'exported', out: 'bundle.spark' };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--root':
        args.root = argv[++i];
        break;
      case '--casts':
        args.casts = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--out':
        args.out = argv[++i];
        break;
      case '--out-dir':
        args.outDir = argv[++i];
        break;
      case '--ext':
        args.ext = argv[++i];
        break;
      case '--jobs': {
        const n = Number(argv[++i]);
        args.jobs = Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
        break;
      }
      case '--help':
      case '-h':
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        if (a.startsWith('--')) throw new Error(`Unknown option: ${a}\n${USAGE}`);
        positional.push(a);
    }
  }
  // Positional convenience: `spark bundle <root> [<outDir>]` — with an outDir
  // every cast under root is bundled into it (the /casts layout); with only a
  // root the original single-bundle path is used.
  if (positional.length > 0) args.root = positional[0];
  if (positional.length > 1) args.outDir = positional[1];
  return args;
}

/** One bundle per cast (Director linked-cast model): <outDir>/<cast>.spark.
 *  Container directories (e.g. hof_furni, which holds hundreds of furniture
 *  casts) become a subdirectory in the output; each nested cast is bundled
 *  into it: <outDir>/<group>/<cast>.spark. */
async function bundleAll(args: Args): Promise<void> {
  const root = resolve(args.root);
  const outDir = resolve(args.outDir!);
  mkdirSync(outDir, { recursive: true });

  const units = listCastUnits(root, args.casts, nodeFs);
  const ext = args.ext ?? 'zip';
  const jobs = args.jobs ?? Math.max(1, availableParallelism());

  let total = 0;
  let failed = 0;
  let done = 0;

  // Ship cast font files (fonts/*.ttf) alongside each bundle: referenced by
  // the manifest but stored outside the archive so the embed can register
  // them with the browser (FontFace) and rasterize text members.
  const shipFonts = (rel: string): void => {
    const src = join(root, rel);
    if (!existsSync(src)) return;
    const dst = join(outDir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  };
  const report = (key: string, members: number, file: string): void => {
    total += members;
    done++;
    console.log(`bundle: ${key} (${members} members) -> ${file}`);
  };
  const reportFailure = (key: string, message: string): void => {
    failed++;
    console.warn(`bundle: SKIPPED ${key}: ${message}`);
  };
  const fileFor = (unit: { group?: string; name: string }): string =>
    unit.group ? join(outDir, unit.group, `${unit.name}.${ext}`) : join(outDir, `${unit.name}.${ext}`);

  const workerUrl = new URL('./worker.js', import.meta.url);
  const workerFile = fileURLToPath(workerUrl);
  // The single-file `bundler.js` distribution has no worker module next to
  // it -- fall back to the sequential loop (--jobs > 1 silently ignored).
  const hasWorker = existsSync(workerFile);

  // Sequential path (--jobs 1, a single cast, or no worker module): the
  // original loop.
  if (jobs === 1 || units.length <= 1 || !hasWorker) {
    for (const unit of units) {
      const key = unit.group ? `${unit.group}/${unit.name}` : unit.name;
      try {
        const { spark, manifest } = buildSparkBundle(root, [key]);
        const file = fileFor(unit);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, spark);
        for (const cast of manifest.casts) for (const rel of cast.fontFiles ?? []) shipFonts(rel);
        report(key, manifest.casts.reduce((n, c) => n + c.members.length, 0), file);
      } catch (e) {
        reportFailure(key, e instanceof Error ? e.message : String(e));
      }
    }
    console.log(`bundled ${done} casts, ${total} members (${failed} skipped) -> ${outDir}`);
    return;
  }

  // Parallel path: N workers each build one cast at a time; the main thread
  // owns ALL fs writes, so workers never contend on the output dir and results
  // are deterministic. Workers stay warm between casts (module load paid once).
  const workers: Worker[] = [];
  const queue = [...units];
  let inflight = 0;
  let cursor = 0;

  /** Give a worker its next cast, or retire it once the queue is drained. */
  const dispatch = (w: Worker): void => {
    if (cursor >= queue.length) {
      void w.terminate();
      return;
    }
    const unit = queue[cursor++];
    const key = unit.group ? `${unit.group}/${unit.name}` : unit.name;
    inflight++;
    w.postMessage({ root, key } satisfies BundleWork);
  };

  const spawn = (): Worker => {
    const w = new Worker(workerUrl);
    workers.push(w);
    w.on('message', (msg: BundleWorkResult | BundleWorkError) => {
      inflight--;
      if ('error' in msg) {
        reportFailure(msg.key, msg.error);
      } else {
        try {
          const unit = queue.find((u) => (u.group ? `${u.group}/${u.name}` : u.name) === msg.key);
          const file = fileFor(unit ?? { name: msg.key });
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, msg.spark);
          for (const rel of msg.fontFiles) shipFonts(rel);
          report(msg.key, msg.members, file);
        } catch (e) {
          reportFailure(msg.key, `write: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      dispatch(w); // next cast, or terminate when drained
    });
    w.on('error', (e) => {
      inflight--;
      reportFailure('<worker>', e instanceof Error ? e.message : String(e));
    });
    return w;
  };

  // Prime one cast per worker; each pulls the next from the queue as it
  // finishes (self-dispatching pool).
  for (let i = 0; i < Math.min(jobs, queue.length); i++) dispatch(spawn());

  // Wait for every in-flight bundle (workers self-terminate when drained).
  while (inflight > 0) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await Promise.all(workers.map((w) => w.terminate().catch(() => undefined)));
  console.log(`bundled ${done} casts, ${total} members (${failed} skipped) -> ${outDir}`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.outDir) {
    void bundleAll(args).then(
      () => process.exit(0),
      (e) => {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
      },
    );
    return;
  }

  const { spark, manifest } = buildSparkBundle(args.root, args.casts);

  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, spark);

  const totalMembers = manifest.casts.reduce((n, c) => n + c.members.length, 0);
  const scripts = manifest.casts.reduce((n, c) => n + c.members.filter((m) => m.kind === 'script').length, 0);
  const bitmaps = manifest.casts.reduce((n, c) => n + c.members.filter((m) => m.kind === 'bitmap').length, 0);
  console.log(
    `bundle: ${manifest.casts.length} casts, ${totalMembers} members ` +
      `(${scripts} scripts, ${bitmaps} bitmaps), ${manifest.files.length} files -> ${outPath}`,
  );
}

main();
