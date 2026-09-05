#!/usr/bin/env node
import { copyFileSync, existsSync, writeFileSync, mkdirSync, renameSync, watch, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { buildCastSparkBundle, buildSparkBundle } from './index.js';
import { isCastDir, listCastUnits, nodeFs } from './manifest.js';
import type { CastUnit } from './manifest.js';
import type { BundleWork, BundleWorkError, BundleWorkResult } from './worker.js';

interface Args {
  /** Watch mode: rebuild the cast whose files change. */
  watch?: boolean;
  root: string;
  casts?: string[];
  out: string;
  outDir?: string;
  ext?: string;
  /** Parallel bundle workers (default: CPU count). --jobs 1 = sequential. */
  jobs?: number;
  /** Debounce between a file save and the rebuild (ms, default 150). */
  debounce?: number;
}

const USAGE = `spark bundle <root> [<outDir>]   — bundle every cast under <root> into <outDir> (one .zip/.spark per cast)
  positional: <root>    exported cast directory (default "exported")
              <outDir>  output directory (defaults to a single bundle when omitted)
  flags: --root <dir> --out-dir <dir> --casts a,b,c --out <file> --ext zip|spark
         --jobs <n>     parallel workers (default: CPU count; 1 = sequential)
  alias:  habbo-bundle (old name)

spark watch <root> [<outDir>]      — rebuild the cast whose files change, on save
  positional: <root>    exported cast directory (default "exported")
              <outDir>  output directory (defaults to a single bundle when omitted)
  flags: --root <dir> --watch-dir <dir> (alias) --out-dir <dir> --casts a,b,c
         --ext zip|spark --debounce <ms> (default 150)
  Keeps running; pair it with a dev server serving the outDir for auto-reload.`;

function parseArgs(argv: string[]): Args {
  // `spark bundle ...` / `spark watch ...` — accept the optional subcommand so
  // the CLI reads like a proper tool (the old `habbo-bundle <root> ...` form
  // still works).
  const args: Args = { root: 'exported', out: 'bundle.spark' };
  if (argv[0] === 'bundle') argv = argv.slice(1);
  else if (argv[0] === 'watch') {
    args.watch = true;
    argv = argv.slice(1);
  }
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--root':
      case '--watch-dir':
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
      case '--debounce': {
        const n = Number(argv[++i]);
        args.debounce = Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
        break;
      }
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
        const built = buildCastSparkBundle(root, unit);
        if (!built) throw new Error('cast directory has no files');
        const { spark, manifest } = built;
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
    inflight++;
    w.postMessage({ root, unit } satisfies BundleWork);
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

/** Watch mode: rebuild the cast that owns a changed file, debounced. Casts
 *  are resolved lazily by walking up from the changed path, so startup is
 *  instant (enumerating the export tree takes seconds on the full corpus). */
async function watchAll(args: Args): Promise<void> {
  const root = resolve(args.root);
  const outDir = resolve(args.outDir!);
  mkdirSync(outDir, { recursive: true });
  const ext = args.ext ?? 'zip';
  const debounceMs = args.debounce ?? 150;
  const outAbs = resolve(outDir);
  const filter = args.casts ? new Set(args.casts) : null;
  // Cache of resolved cast dirs (absolute path -> unit).
  const resolved = new Map<string, CastUnit>();

  const fileFor = (unit: CastUnit): string =>
    unit.group ? join(outDir, unit.group, `${unit.name}.${ext}`) : join(outDir, `${unit.name}.${ext}`);
  const keyFor = (unit: CastUnit): string => (unit.group ? `${unit.group}/${unit.name}` : unit.name);

  /** Mirror listCastUnits' filter semantics: a bare name, a group path
   *  (container), or a `group/name` pair all match. */
  const matchesFilter = (unit: CastUnit): boolean => {
    if (!filter) return true;
    const key = unit.group ? `${unit.group}/${unit.name}` : unit.name;
    if (filter.has(key) || filter.has(unit.name)) return true;
    return [...filter].some((f) => key.startsWith(f + '/'));
  };

  const statSafe = (p: string): ReturnType<typeof statSync> | null => {
    try {
      return statSync(p);
    } catch {
      return null;
    }
  };

  const shipFontFiles = (rels: string[]): void => {
    for (const rel of rels) {
      const src = join(root, rel);
      if (!existsSync(src)) continue;
      const dst = join(outDir, rel);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
  };

  const buildOne = (unit: CastUnit, why: string): void => {
    const key = keyFor(unit);
    try {
      const built = buildCastSparkBundle(root, unit);
      if (!built) throw new Error('cast directory has no files');
      const { spark, manifest } = built;
      const file = fileFor(unit);
      mkdirSync(dirname(file), { recursive: true });
      // Atomic write (tmp + rename) so a dev server never serves a partial
      // bundle while the cast is being rebuilt.
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, spark);
      renameSync(tmp, file);
      for (const cast of manifest.casts) shipFontFiles(cast.fontFiles ?? []);
      const members = manifest.casts.reduce((n, c) => n + c.members.length, 0);
      console.log(`watch: rebuilt ${key} (${members} members) -> ${file}  [${why}]`);
    } catch (e) {
      console.warn(`watch: SKIPPED ${key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const timers = new Map<string, NodeJS.Timeout>();
  const schedule = (unit: CastUnit, why: string): void => {
    const key = keyFor(unit);
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        buildOne(unit, why);
      }, debounceMs),
    );
  };

  /** Walk up from a changed path and pick the SHALLOWEST directory that looks
   *  like a cast. Member subdirs (scripts/, bitmaps/, …) also pass isCastDir
   *  because their files parse as members, so the first hit is never taken —
   *  the real cast is the outermost one (containers like 31/hof_furni are not
   *  casts themselves). New cast dirs are picked up automatically, so no
   *  separate adoption pass is needed. */
  const resolveUnit = (abs: string): CastUnit | undefined => {
    let dir = statSafe(abs)?.isDirectory() ? abs : dirname(abs);
    let castDir: string | null = null;
    while (dir.length >= root.length && (dir === root || dir.startsWith(root + sep))) {
      if (dir !== root) {
        const cached = resolved.get(dir);
        if (cached) castDir = cached.path;
        else if (isCastDir(dir, nodeFs)) castDir = dir;
      }
      const next = dirname(dir);
      if (next === dir) break;
      dir = next;
    }
    if (!castDir) return undefined;
    let cached = resolved.get(castDir);
    if (!cached) {
      const rel = relative(root, castDir).split(sep).join('/');
      const name = basename(castDir);
      const group = rel === name ? undefined : rel.slice(0, rel.length - name.length - 1);
      cached = group ? { group, name, path: castDir } : { name, path: castDir };
      resolved.set(castDir, cached);
    }
    return matchesFilter(cached) ? cached : undefined;
  };

  let closed = false;
  const onEvent = (dirAbs: string, filename: string | null): void => {
    if (closed) return;
    const abs = filename ? resolve(dirAbs, filename) : dirAbs;
    // Ignore our own output (defends against outDir living under root) and
    // transient temp files.
    if (abs.startsWith(outAbs + sep) || abs === outAbs) return;
    if (filename?.endsWith('.tmp')) return;
    const unit = resolveUnit(abs);
    if (unit) schedule(unit, 'changed');
  };

  const watcher: { close(): void } = (() => {
    try {
      const w = watch(root, { recursive: true }, (_ev, f) => onEvent(root, f ?? null));
      return {
        close: () => {
          closed = true;
          w.close();
        },
      };
    } catch {
      // Linux: no recursive watch — watch every directory under root
      // individually and rescan on rename so new dirs get watchers.
      const watchers = new Map<string, ReturnType<typeof watch>>();
      const addDir = (dir: string): void => {
        if (watchers.has(dir)) return;
        watchers.set(dir, watch(dir, (_ev, f) => onEvent(dir, f ?? null)));
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) addDir(join(dir, entry.name));
        }
      };
      addDir(root);
      const rescan = (): void => {
        const walk = (dir: string): void => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const sub = join(dir, entry.name);
            if (!watchers.has(sub)) {
              watchers.set(sub, watch(sub, (_ev, f) => onEvent(sub, f ?? null)));
            }
            walk(sub);
          }
        };
        walk(root);
      };
      const rescanTimer = setInterval(rescan, 2000);
      return {
        close: () => {
          closed = true;
          clearInterval(rescanTimer);
          for (const w of watchers.values()) w.close();
        },
      };
    }
  })();

  console.log(`watch: watching ${root} -> ${outDir} (${ext}, ${debounceMs}ms debounce). Ctrl-C to stop.`);
  console.log('watch: tip — a dev server serving outDir reloads when a cast lands; run `spark bundle` once first if casts are missing.');

  const shutdown = (): void => {
    watcher.close();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise<void>(() => undefined); // stay alive until signalled
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.watch) {
    if (!args.outDir) {
      console.error('spark watch requires --out-dir (or a positional <outDir>)');
      process.exit(1);
    }
    void watchAll(args).catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
    return;
  }

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
