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
  palRel?: string;
  inlineText?: string;
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
