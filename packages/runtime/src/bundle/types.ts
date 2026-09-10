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
  number: number;
  kind: MemberKind;
  name: string;
  file: string;
  regX?: number;
  regY?: number;
  palRel?: string;
  inlineText?: string;
  /** Script members: when true, `file` holds LBC1 bytecode (compileScript) —
   *  the runtime decodes it instead of parsing .ls source text. Omitted or
   *  false = the file is plain Lingo text (parse as before). */
  bytecode?: boolean;
  /** Film-loop members: cast member numbers of the frames, in playback order
   *  (simple loops with one member per frame). */
  frames?: number[];
  /** Film-loop members: per-frame sprite composition from the member's SCVW
   *  mini-score. Each frame lists the cast members to draw with their
   *  mini-stage position, display size and ink. When present, the runtime
   *  composes the loop from these instead of showing a single member per
   *  frame. */
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
  name: string;
  file: string;
}

export interface MovieConfig {
  stageWidth: number;
  stageHeight: number;
  stageLeft: number;
  stageTop: number;
  stageRight: number;
  stageBottom: number;
  backgroundColor: number;
  stageColor: number;
  stageColorRgb?: number;
  tempo: number;
  minMember: number;
  maxMember: number;
  defaultPalette: string;
  directorVersion: number;
  movieVersion: number;
  platform: number;
  channels?: number;
}

export interface CastListEntry {
  id: number;
  name: string;
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
  linkedCasts: LinkedCast[];
  fileName?: string;
  movie?: MovieConfig;
  castList?: CastListEntry[];
}

export interface BundleManifest {
  version: 1;
  casts: CastManifest[];
  files: string[];
}
