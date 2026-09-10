export type MemberKind =
  | 'script'
  | 'bitmap'
  | 'text'
  | 'palette'
  | 'sound'
  | 'font'
  | 'shape'
  | 'filmloop'
  | 'unknown';

export interface MemberEntry {
  /** Cast-internal member number, from the NNNN filename prefix. */
  number: number;
  kind: MemberKind;
  /** Member name, e.g. "Room_Interface_Class" or "park_a.room". */
  name: string;
  /** Path inside the bundle, relative to bundle root. */
  file: string;
  /** Registration point for bitmaps. */
  regX?: number;
  regY?: number;
  /** Path of the bitmap's own .pal companion (JASC-PAL), if the export shipped
   *  one next to the PNG. The runtime parses it for palette-index matte/key
   *  background removal (DirPlayer get_bg_color_ref = palette index 0). */
  palRel?: string;
  /** True for small text payloads that we can cache inline. */
  inlineText?: string;
  /** Script members: when true, `file` holds LBC1 bytecode instead of .ls
   *  text (the bundler compiled it; the runtime decodes it without parsing). */
  bytecode?: boolean;
  /** Film-loop members: cast member numbers of the frames, in playback order
   *  (simple loops with one member per frame). */
  frames?: number[];
  /** Film-loop members: per-frame sprite composition from the member's SCVW
   *  mini-score (the decompiler exports it as `filmloops/NNNN_...txt`). Each
   *  frame lists the cast members to draw with their mini-stage position,
   *  display size and ink. When present, the runtime composes the loop from
   *  these instead of showing a single member per frame. */
  sprites?: FilmLoopSprite[][];
  /** Film-loop members: the authored loop rect (the CASt initialRect) — the
   *  mini-stage viewport the loop composes into. The runtime renders tiles at
   *  natural bitmap size when this matches the sprites' natural bounding box
   *  (DirPlayer prefer_bitmap_dims), else at the sprite display size. */
  loopX?: number;
  loopY?: number;
  loopW?: number;
  loopH?: number;
}

export interface FilmLoopSprite {
  /** Cast member number to draw (same cast library as the loop). */
  member: number;
  /** Mini-stage position of the sprite's (scaled) registration point. */
  x: number;
  y: number;
  /** Display size: the member bitmap is scaled to this rect. */
  w: number;
  h: number;
  /** Sprite ink (8 = matte: palette-0 background keyed transparent). */
  ink: number;
  /** Sprite blend amount. */
  blend: number;
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
  /** Cast name = top-level directory under the export root, e.g. "hh_room_park". */
  name: string;
  members: MemberEntry[];
  fonts: CastFont[];
  fontsFile?: string;
  /** Font assets (e.g. .ttf) that don't carry a member number. */
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
  /** Every file path present in the bundle. */
  files: string[];
}
