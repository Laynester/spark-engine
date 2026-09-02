import type { Script } from '../lingo/ast.js';
import type { CastFont, MemberKind } from '../bundle/types.js';
import type { LImage, LRect, LVal } from '../lingo/values.js';

export interface ShapeDef {
  shapeType: string;
  width: number;
  height: number;
  color: number;
  backColor: number;
  fillType: number;
  lineThickness: number;
  lineDirection: number;
  filled: boolean;
  outlineInvisible: boolean;
}

export function parseShapeText(content: string): ShapeDef {
  const d: ShapeDef = {
    shapeType: 'rect', width: 0, height: 0, color: 0xffffff, backColor: 0,
    fillType: 1, lineThickness: 0, lineDirection: 5, filled: true, outlineInvisible: false,
  };
  for (const line of content.split(/\r?\n/)) {
    const m = /^\s*([\w ]+?)\s*:\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase().replace(/\s+/g, '');
    const raw = m[2].trim();
    switch (key) {
      case 'shapetype': d.shapeType = raw.toLowerCase(); break;
      case 'width': d.width = parseInt(raw, 10) || 0; break;
      case 'height': d.height = parseInt(raw, 10) || 0; break;
      case 'color': d.color = parseInt(raw, 16); break;
      case 'backcolor': d.backColor = parseInt(raw, 16); break;
      case 'filltype': d.fillType = parseInt(raw, 10) || 0; break;
      case 'linethickness': d.lineThickness = parseInt(raw, 10) || 0; break;
      case 'linedirection': d.lineDirection = parseInt(raw, 10) || 0; break;
      case 'filled': d.filled = raw.toLowerCase() === 'yes' || raw === '1' || raw.toLowerCase() === 'true'; break;
      case 'outlineinvisible': d.outlineInvisible = raw.toLowerCase() === 'yes' || raw === '1' || raw.toLowerCase() === 'true'; break;
    }
  }
  return d;
}

export class Member {
  regX = 0;
  regY = 0;
  text?: string;
  raw?: Uint8Array;
  palette?: number[][];
  paletteTarget?: number[][];
  script?: Script;
  fileName?: string;
  image?: LImage;
  imagePainted = false;
  color?: LVal;
  rect?: LRect;
  font?: LVal;
  fontSize?: LVal;
  alignment?: LVal;
  wordWrap?: LVal;
  fixedLineSpace?: LVal;
  fontStyle?: LVal;
  paletteRef?: LVal;
  textProps?: Map<string, LVal>;
  chunkStyles?: { from: number; to: number; font?: LVal; fontStyle?: LVal; color?: LVal }[];
  shape?: ShapeDef;

  constructor(
    public castLibNumber: number,
    public number: number,
    public name: string,
    public kind: MemberKind,
  ) {}

  get width(): number {
    if (this.kind === 'text' && this.rect) return this.rect.width;
    if (this.kind === 'bitmap' && this.raw) {
      const size = readPngSize(this.raw);
      return size ? size.w : 0;
    }
    if (this.kind === 'shape' && this.shape) return this.shape.width;
    if (this.image) return this.image.width;
    return 0;
  }

  get height(): number {
    if (this.kind === 'text') {
      if (this.rect && this.rect.height > 0) return this.rect.height;
      const size = Math.round(Number(this.fontSize)) || 12;
      return size + 2;
    }
    if (this.kind === 'bitmap' && this.raw) {
      const size = readPngSize(this.raw);
      return size ? size.h : 0;
    }
    if (this.kind === 'shape' && this.shape) return this.shape.height;
    if (this.image) return this.image.height;
    return 0;
  }
}

export class CastLib {
  members = new Map<number, Member>();
  byName = new Map<string, Member>();
  fonts: CastFont[] = [];
  fontFiles: string[] = [];
  fileName?: string;
  preloadMode = 0;
  loaded = false;

  constructor(public number: number, public name: string) {}
}

export function readPngSize(bytes: Uint8Array): { w: number; h: number } | null {
  if (bytes.length < 24) return null;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}

export function normalizeTextLines(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\n/g, '\r');
}

export function parsePalette(content: string): number[][] {
  const lines = content.split(/\r?\n/);
  const colors: number[][] = [];
  for (const line of lines) {
    const m = /^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*$/.exec(line);
    if (m) colors.push([parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]);
  }
  return colors;
}

export function parsePaletteBytes(bytes: Uint8Array): number[][] {
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x50 && bytes[1] === 0x41 && bytes[2] === 0x4c && bytes[3] === 0x42
  ) {
    const count = bytes[4] | (bytes[5] << 8);
    const colors: number[][] = [];
    for (let i = 0; i < count; i++) {
      const o = 6 + i * 3;
      if (o + 2 >= bytes.length) break;
      colors.push([bytes[o], bytes[o + 1], bytes[o + 2]]);
    }
    return colors;
  }
  return parsePalette(new TextDecoder().decode(bytes));
}
