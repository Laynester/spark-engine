import type { CastFont, CastListEntry, LinkedCast, MemberEntry, MemberKind, MovieConfig } from './types.js';

/** Parse a linked cast file reference like `D:\LINGO\Builds\x\fuse_client.cst`
 *  into its cast name (basename without extension). */
export function parseLinkedCastLine(line: string): LinkedCast | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const file = trimmed.split(/[\\/]/).pop()!.trim();
  if (!file || !file.includes('.')) return null;
  const name = file.replace(/\.[^.]+$/, '');
  if (!/^[A-Za-z0-9_]+$/.test(name)) return null;
  return { name, file };
}

export function parseLinkedCastsTxt(content: string): LinkedCast[] {
  const out: LinkedCast[] = [];
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseLinkedCastLine(line);
    if (parsed) out.push(parsed);
  }
  return out;
}

const TYPE_TOKENS: Record<string, MemberKind> = {
  script: 'script',
  bitmap: 'bitmap',
  text: 'text',
  palette: 'palette',
  sound: 'sound',
  font: 'font',
  shape: 'shape',
};

const MEMBER_RE = /^(\d{3,4})_([a-z]+)_(.+)$/i;

export function parseMemberFileName(basename: string): {
  number: number;
  kind: MemberKind;
  name: string;
} | null {
  const m = MEMBER_RE.exec(basename);
  if (!m) return null;
  const number = parseInt(m[1], 10);
  const kind = TYPE_TOKENS[m[2].toLowerCase()];
  if (!kind) return null;
  let rest = m[3];
  const dot = rest.lastIndexOf('.');
  if (dot > 0) rest = rest.slice(0, dot);
  // Member names may genuinely contain underscores (cloud art is
  // "cloud_0_left") or spaces ("Habbo UK garden"). The export tool underscored
  // every space for filesystem safety, so the slug is ambiguous; cast usage
  // arbitrates: script members are referenced with spaces, everything else
  // keeps the underscore form. Runtime lookups normalize _ <-> space anyway.
  return { number, kind, name: kind === 'script' ? rest.replaceAll('_', ' ') : rest };
}

export function parseRegPoint(content: string): { regX?: number; regY?: number } {
  const out: { regX?: number; regY?: number } = {};
  for (const line of content.split(/\r?\n/)) {
    const m = /(regX|regY)\s*=\s*(-?\d+)/i.exec(line);
    if (m) {
      const v = parseInt(m[2], 10);
      if (m[1].toLowerCase() === 'regx') out.regX = v;
      else out.regY = v;
    }
  }
  return out;
}

export function parseFontsTxt(content: string): CastFont[] {
  const fonts: CastFont[] = [];
  for (const line of content.split(/\r?\n/)) {
    const parts = line.trim().split(/\t+/);
    if (parts.length >= 3) {
      const num = parseInt(parts[0], 10);
      const style = parseInt(parts[1], 10);
      if (!Number.isNaN(num) && !Number.isNaN(style)) {
        fonts.push({ memberNumber: num, style, fontName: parts[2].trim() });
      }
    }
  }
  return fonts;
}

/** Parse `movie.txt` — tab-separated `key\tvalue` lines (Director movie props). */
export function parseMovieTxt(content: string): MovieConfig | null {
  const raw: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sep = trimmed.indexOf('\t');
    const key = (sep >= 0 ? trimmed.slice(0, sep) : trimmed.split(/\s+/)[0]).trim().toLowerCase();
    const value = (sep >= 0 ? trimmed.slice(sep + 1) : trimmed.replace(/^\S+\s*/, '')).trim();
    if (key && value) raw[key] = value;
  }
  const num = (k: string): number => {
    const v = raw[k];
    if (v === undefined) return 0;
    if (/^0x[0-9a-f]+$/i.test(v)) return parseInt(v.slice(2), 16);
    const n = Number(v);
    return Number.isNaN(n) ? 0 : n;
  };
  return {
    stageWidth: num('stage_width'),
    stageHeight: num('stage_height'),
    stageLeft: num('stage_left'),
    stageTop: num('stage_top'),
    stageRight: num('stage_right'),
    stageBottom: num('stage_bottom'),
    backgroundColor: num('background_color'),
    stageColor: num('stage_color'),
    // The resolved RGB is what Shockwave renders (e.g. 0x000000 black); keep
    // it optional so movies without the field fall back to backgroundColor.
    stageColorRgb: raw['stage_color_rgb'] !== undefined ? num('stage_color_rgb') : undefined,
    tempo: num('tempo'),
    minMember: num('min_member'),
    maxMember: num('max_member'),
    defaultPalette: raw['default_palette'] ?? '',
    directorVersion: num('director_version'),
    movieVersion: num('movie_version'),
    platform: num('platform'),
    // Score chunk channel count — backs Lingo `the lastChannel` (Sprite
    // Manager pool size). Exporters may write either key.
    channels:
      raw['channels'] !== undefined ? num('channels') : raw['num_channels'] !== undefined ? num('num_channels') : undefined,
  };
}

/** Parse `casts.txt` — the movie's castLib registry (id\tname\tpath\tmin\tmax\tcount). */
export function parseCastsTxt(content: string): CastListEntry[] {
  const out: CastListEntry[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Split on single tab so empty path fields (Internal/bin) are preserved;
    // the header row's `id` parses to NaN and is skipped.
    const parts = trimmed.split(/\t/);
    if (parts.length < 6) continue;
    const id = parseInt(parts[0], 10);
    const minMember = parseInt(parts[3], 10);
    const maxMember = parseInt(parts[4], 10);
    const memberCount = parseInt(parts[5], 10);
    if (Number.isNaN(id)) continue;
    out.push({
      id,
      name: parts[1].trim(),
      path: parts[2].trim(),
      minMember,
      maxMember,
      memberCount,
    });
  }
  return out;
}

export interface ScannedMember {
  number: number;
  kind: MemberKind;
  name: string;
  /** Path of the file this member came from (relative to the cast dir). */
  file: string;
  /** Path of the matching .regpoint file, if any. */
  regpointRel?: string;
  /** Path of the matching .pal file (per-bitmap palette companion), if any. */
  palRel?: string;
}

/**
 * Classify every file in a cast directory. `files` are paths relative to the
 * cast directory; only the basename is used for classification.
 */
export function scanCastFiles(files: string[]): {
  members: ScannedMember[];
  fontsFile?: string;
  fontFiles: string[];
  linkedCastsFile?: string;
  movieFile?: string;
  castListFile?: string;
} {
  const members: ScannedMember[] = [];
  const regpoints = new Map<number, string>();
  const pals = new Map<number, string>();
  let fontsFile: string | undefined;
  let linkedCastsFile: string | undefined;
  let movieFile: string | undefined;
  let castListFile: string | undefined;
  const fontFiles: string[] = [];

  // Pass 1: collect companion files (.regpoint / .pal) before members are
  // built so they attach to the bitmap instead of becoming duplicate members
  // (MEMBER_RE matches `0017_bitmap_openhrs_ill.pal` as a bitmap member).
  for (const rel of files) {
    const basename = rel.split('/').pop() ?? rel;
    const m = MEMBER_RE.exec(basename);
    if (!m) continue;
    const number = parseInt(m[1], 10);
    const kind = TYPE_TOKENS[m[2].toLowerCase()];
    if (basename.toLowerCase().endsWith('.regpoint')) regpoints.set(number, rel);
    // A `.pal` whose filename token is `bitmap` is the bitmap's own palette
    // (JASC-PAL companion), NOT a palette member — palette MEMBERS live in
    // the palettes/ dir with a `palette` token and stay regular members.
    else if (basename.toLowerCase().endsWith('.pal') && kind === 'bitmap') pals.set(number, rel);
  }
  // Pass 2: classify everything else.
  for (const rel of files) {
    const basename = rel.split('/').pop() ?? rel;
    const lower = basename.toLowerCase();
    if (lower === 'fonts.txt') {
      fontsFile = rel;
      continue;
    }
    if (lower === 'linked_casts.txt') {
      linkedCastsFile = rel;
      continue;
    }
    if (lower === 'movie.txt') {
      movieFile = rel;
      continue;
    }
    if (lower === 'casts.txt') {
      castListFile = rel;
      continue;
    }
    if (lower.endsWith('.ttf')) {
      fontFiles.push(rel);
      continue;
    }
    if (lower.endsWith('.regpoint')) continue;
    // Bitmap-palette companions were claimed in pass 1 — skip them here so a
    // `.pal` never emits a duplicate bitmap member.
    if (lower.endsWith('.pal')) {
      const m = MEMBER_RE.exec(basename);
      if (m && TYPE_TOKENS[m[2].toLowerCase()] === 'bitmap') continue;
    }
    const parsed = parseMemberFileName(basename);
    if (!parsed) continue;
    // One member number must resolve to exactly one file. Re-exports can leave
    // the previous run's file behind (a raw `.bin` sound container next to the
    // clean `.mp3` now emitted), and both parse to the same member; prefer the
    // real media format over the raw container when they collide.
    const dupe = members.find((x) => x.number === parsed.number);
    if (dupe) {
      const dupeExt = dupe.file.split('.').pop()?.toLowerCase() ?? '';
      const thisExt = rel.split('.').pop()?.toLowerCase() ?? '';
      if (mediaRank(thisExt) > mediaRank(dupeExt)) {
        dupe.file = rel;
        dupe.regpointRel = regpoints.get(parsed.number);
        dupe.palRel = pals.get(parsed.number);
      }
      continue;
    }
    members.push({ ...parsed, file: rel, regpointRel: regpoints.get(parsed.number), palRel: pals.get(parsed.number) });
  }

  return { members, fontsFile, fontFiles, linkedCastsFile, movieFile, castListFile };
}

/** Prefer decoded media over raw containers when both exist for a member:
 *  mp3/wav/aiff > bin (the exporter falls back to .bin when it can't strip the
 *  member's container header). */
function mediaRank(ext: string): number {
  switch (ext) {
    case 'mp3':
    case 'wav':
    case 'aif':
    case 'aiff':
      return 1;
    default:
      return 0;
  }
}

/** Build MemberEntry list from scan results, attaching regpoint coordinates. */
export function buildMemberEntries(
  scanned: ScannedMember[],
  readText: (rel: string) => string | undefined,
): MemberEntry[] {
  const entries: MemberEntry[] = [];
  for (const sm of scanned) {
    const entry: MemberEntry = {
      number: sm.number,
      kind: sm.kind,
      name: sm.name,
      file: sm.file,
      palRel: sm.palRel,
    };
    if (sm.regpointRel) {
      const content = readText(sm.regpointRel);
      if (content !== undefined) {
        const rp = parseRegPoint(content);
        if (rp.regX !== undefined) entry.regX = rp.regX;
        if (rp.regY !== undefined) entry.regY = rp.regY;
      }
    }
    entries.push(entry);
  }
  return entries;
}
