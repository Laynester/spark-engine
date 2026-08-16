import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BundleManifest, CastManifest, MemberEntry } from './types.js';
import { buildMemberEntries, parseCastsTxt, parseFontsTxt, parseLinkedCastsTxt, parseMemberFileName, parseMovieTxt, scanCastFiles } from './scan.js';

export interface FileSystemLike {
  listDir(dir: string): string[];
  readText(file: string): string | undefined;
  isDir(dir: string): boolean;
}

export const nodeFs: FileSystemLike = {
  listDir(dir) {
    try {
      return readdirSync(dir).map((n) => join(dir, n));
    } catch {
      return [];
    }
  },
  readText(file) {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  },
  isDir(dir) {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  },
};

/** Recursively list file paths under `dir`, relative to `dir`. macOS
 *  .DS_Store files (Finder junk in every exported dir) are skipped — they are
 *  not cast members and only add index entries + scan time to every bundle. */
export function walkFiles(dir: string, fs: FileSystemLike): string[] {
  const out: string[] = [];
  const visit = (absolute: string, relDir: string) => {
    for (const entry of fs.listDir(absolute)) {
      const name = entry.split(/[\\/]/).pop()!;
      if (name === '.DS_Store') continue;
      const rel = relDir ? `${relDir}/${name}` : name;
      if (fs.isDir(entry)) visit(entry, rel);
      else out.push(rel);
    }
  };
  for (const entry of fs.listDir(dir)) {
    const name = entry.split(/[\\/]/).pop()!;
    if (name === '.DS_Store') continue;
    if (fs.isDir(entry)) visit(entry, name);
    else out.push(name);
  }
  return out.sort();
}

/** Subdirectories that mark a directory as one Director cast (the exporter's
 *  member categories). A container like `hof_furni` has none of these at its
 *  top level — only sub-directories that are themselves casts. */
const CAST_MEMBER_DIRS = new Set(['bitmaps', 'scripts', 'palettes', 'texts', 'shapes', 'sounds', 'fonts', 'other']);

/** True when `dir` looks like a single Director cast — member subdirectories,
 *  control files (movie.txt/casts.txt/fonts.txt/linked_casts.txt) or
 *  member-prefixed files at its top level — rather than a container of casts. */
export function isCastDir(dir: string, fs: FileSystemLike = nodeFs): boolean {
  for (const entry of fs.listDir(dir)) {
    const name = entry.split(/[\\/]/).pop()!;
    if (fs.isDir(entry)) {
      if (CAST_MEMBER_DIRS.has(name.toLowerCase())) return true;
    } else {
      const lower = name.toLowerCase();
      if (lower === 'fonts.txt' || lower === 'movie.txt' || lower === 'casts.txt' || lower === 'linked_casts.txt') {
        return true;
      }
      if (parseMemberFileName(name)) return true;
    }
  }
  return false;
}

export interface CastUnit {
  /** Cast name (the manifest name and bundle basename), e.g. "hh_furni_xx_TableH". */
  name: string;
  /** Container directory name for nested casts; undefined for top-level casts. */
  group?: string;
  /** Absolute path to the cast directory. */
  path: string;
}

/**
 * Enumerate every cast under the export root. Top-level directories that look
 * like casts are returned as-is; directories that are containers (e.g.
 * `hof_furni`, which holds hundreds of furniture casts) are expanded so each
 * sub-directory becomes its own cast unit grouped under the container name.
 * A filter may name a cast, a container (all of its casts), or `group/name`.
 */
export function listCastUnits(
  exportRoot: string,
  castFilter?: string[],
  fs: FileSystemLike = nodeFs,
): CastUnit[] {
  const units: CastUnit[] = [];
  const filter = castFilter ? new Set(castFilter) : null;
  for (const castPath of fs.listDir(exportRoot).sort()) {
    if (!fs.isDir(castPath)) continue;
    const name = castPath.split(/[\\/]/).pop()!;
    if (isCastDir(castPath, fs)) {
      if (filter && !filter.has(name)) continue;
      units.push({ name, path: castPath });
      continue;
    }
    // Container of nested casts: expand one level. A nested cast is selected
    // by its `group/name` path or by naming the whole container — a bare sub
    // name is not matched, since it would also pull in any same-named
    // top-level cast (hh_furni_classes exists in both places).
    const includeAll = !filter || filter.has(name);
    for (const subPath of fs.listDir(castPath).sort()) {
      if (!fs.isDir(subPath)) continue;
      const sub = subPath.split(/[\\/]/).pop()!;
      if (!includeAll && !filter.has(`${name}/${sub}`)) continue;
      units.push({ group: name, name: sub, path: subPath });
    }
  }
  return units;
}

/** Build one cast's manifest entry from its directory. Nested casts (group set)
 *  keep a `<group>/<name>` bundle prefix so they can live under a container
 *  directory next to top-level casts without path collisions. */
function buildCastManifest(
  unit: CastUnit,
  fs: FileSystemLike,
): { cast: CastManifest; files: string[] } | null {
  const { path: castPath, name: castName, group } = unit;
  const relFiles = walkFiles(castPath, fs);
  if (relFiles.length === 0) return null;

  const readCastText = (rel: string) => fs.readText(join(castPath, rel));
  const scanned = scanCastFiles(relFiles);
  const fonts = scanned.fontsFile ? parseFontsTxt(readCastText(scanned.fontsFile) ?? '') : [];
  const linkedCasts = scanned.linkedCastsFile
    ? parseLinkedCastsTxt(readCastText(scanned.linkedCastsFile) ?? '')
    : [];
  const movie = scanned.movieFile ? parseMovieTxt(readCastText(scanned.movieFile) ?? '') : undefined;
  const castList = scanned.castListFile ? parseCastsTxt(readCastText(scanned.castListFile) ?? '') : undefined;
  // Director linked casts are .cst files; the movie itself is .dir/.dcr.
  const fileName = `${castName}.cst`;

  const members: MemberEntry[] = buildMemberEntries(scanned.members, readCastText);
  members.sort((a, b) => a.number - b.number);

  // Bundle paths are relative to the bundle root: <cast>/<rel>.
  const prefix = group ? `${group}/${castName}` : castName;
  for (const m of members) {
    m.file = `${prefix}/${m.file}`;
    if (m.palRel) m.palRel = `${prefix}/${m.palRel}`;
  }
  const fontFiles = scanned.fontFiles.map((f) => `${prefix}/${f}`);
  const fontsFile = scanned.fontsFile ? `${prefix}/${scanned.fontsFile}` : undefined;

  // Keep small text payloads inline for zero-IO member access.
  for (const m of members) {
    if (m.kind === 'text') {
      const content = readCastText(m.file.slice(prefix.length + 1));
      if (content !== undefined && content.length < 64_000) m.inlineText = content;
    }
  }

  return {
    cast: { name: castName, members, fonts, fontsFile, fontFiles, linkedCasts, fileName, movie: movie ?? undefined, castList },
    // .regpoint files are consumed at BUILD time (regX/regY land on the member
    // entries) and are never read from the bundle by the runtime — shipping
    // them is dead weight (~51k files in the corpus), so exclude them. A file
    // that parses as a member but lost a number collision (e.g. a stale .bin
    // sound container next to the clean .mp3 the re-export emits) is excluded
    // too — it is unreferenced dead weight.
    files: relFiles
      .filter((f) => !f.endsWith('.regpoint'))
      .filter((f) => {
        const base = f.split(/[\\/]/).pop() ?? f;
        const parsed = parseMemberFileName(base);
        if (!parsed) return true; // control/companion/font files always ship
        if (scanned.members.some((m) => m.file === f)) return true;
        return scanned.members.some((m) => m.palRel === f);
      })
      .map((f) => `${prefix}/${f}`),
  };
}

/**
 * Scan an export directory into a BundleManifest.
 * @param exportRoot path to the exported cast collection
 * @param castFilter optional cast names to include (all when omitted); may also
 *   name a container (all casts inside) or a `group/name` nested cast
 */
export function buildManifest(
  exportRoot: string,
  castFilter?: string[],
  fs: FileSystemLike = nodeFs,
): BundleManifest {
  const casts: CastManifest[] = [];
  const files: string[] = [];
  for (const unit of listCastUnits(exportRoot, castFilter, fs)) {
    const built = buildCastManifest(unit, fs);
    if (!built) continue;
    const { cast, files: castFiles } = built;
    casts.push(cast);
    files.push(...castFiles);
  }
  return { version: 1, casts, files };
}
