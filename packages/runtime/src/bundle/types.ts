export type MemberKind =
  | 'script'
  | 'bitmap'
  | 'text'
  | 'palette'
  | 'sound'
  | 'font'
  | 'shape'
  | 'unknown';

export interface MemberEntry {
  number: number;
  kind: MemberKind;
  name: string;
  file: string;
  regX?: number;
  regY?: number;
  /** Path of the bitmap's own .pal companion (JASC-PAL), if shipped. */
  palRel?: string;
  inlineText?: string;
}

export interface CastFont {
  memberNumber: number;
  style: number;
  fontName: string;
}

export interface LinkedCast {
  /** Cast name derived from the linked file's basename, e.g. "fuse_client". */
  name: string;
  /** Original linked file basename, e.g. "fuse_client.cst". */
  file: string;
}

/** Parsed `movie.txt` — the Director movie's stage/config properties. */
export interface MovieConfig {
  stageWidth: number;
  stageHeight: number;
  stageLeft: number;
  stageTop: number;
  stageRight: number;
  stageBottom: number;
  /** Palette-encoded background (e.g. 0x000020 = index into default palette). */
  backgroundColor: number;
  /** Palette-encoded stage color. */
  stageColor: number;
  /** Resolved RGB of the stage — what Shockwave actually renders (e.g. black). */
  stageColorRgb?: number;
  tempo: number;
  minMember: number;
  maxMember: number;
  defaultPalette: string;
  directorVersion: number;
  movieVersion: number;
  platform: number;
  /** Score chunk channel count (e.g. 1006 on the v14 client movie) — backs
   *  Lingo `the lastChannel`. */
  channels?: number;
}

/** One row of `casts.txt` — a castLib in the movie, in Director order. */
export interface CastListEntry {
  id: number;
  name: string;
  /** Original .cst path (empty for the movie's own Internal cast and `bin`). */
  path: string;
  minMember: number;
  maxMember: number;
  memberCount: number;
}

export interface CastManifest {
  name: string;
  members: MemberEntry[];
  fonts: CastFont[];
  fontsFile?: string;
  fontFiles: string[];
  /** Linked external casts from linked_casts.txt (Director cast links). */
  linkedCasts: LinkedCast[];
  /** Original cast file name, e.g. "fuse_client.cst" or "habbo.dir". */
  fileName?: string;
  /** Parsed movie.txt — stage/size/tempo (present on the movie's own cast). */
  movie?: MovieConfig;
  /** Parsed casts.txt — the full castLib registry in Director order. */
  castList?: CastListEntry[];
}

export interface BundleManifest {
  version: 1;
  casts: CastManifest[];
  files: string[];
}
