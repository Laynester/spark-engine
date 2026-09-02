import type { Expr, Handler, Script, TheSegment } from '../lingo/ast.js';
import { Env, Interpreter, NO_GLOBALS, scriptPropsLower, type GlobalHandlerRef, type InterpreterHost } from '../lingo/interpreter.js';
import { createBuiltinTable, type BuiltinBackend, type BuiltinFn } from '../lingo/builtins.js';
import { inferScriptType, parseLingo } from '../lingo/parser.js';
import { decodeScript } from '../lingo/bytecode.js';
import {
  asNum, colorFrom, LEMPTY, toLingoString, VOID,
  type LCastLibRef, type LMemberRef, type LObject, type LPoint, type LPropList,
  type LSpriteRef, type LStageRef, type LVal, type LWindowRef,
  LImage, LList, LPoint as LPointClass, LPropList as LPropListClass, LRect as LRectClass,
  LSymbol, intColor, LColor, hexColor, fontStyleFlags, duplicateValue, PropPairs,
  LObject as LObjectClass, LMemberRef as LMemberRefClass, LSpriteRef as LSpriteRefClass,
  LCastLibRef as LCastLibRefClass, LWindowRef as LWindowRefClass, LStageRef as LStageRefClass,
} from '../lingo/values.js';
import { parseXmlToLingo } from '../lingo/xml.js';
import type { BundleLoader } from '../bundle/loader.js';
import type { CastListEntry, CastManifest, MemberEntry, MovieConfig } from '../bundle/types.js';
import { CastLib, Member, normalizeTextLines, parsePaletteBytes, parseShapeText, type ShapeDef } from './members.js';
import { decodeImage } from './pix8.js';
import { decodePng } from './png.js';
import { decodeGif } from './gif.js';

const WEB_TO_DIRECTOR_KEYCODE: Record<number, number> = {
  8: 51,
  9: 48,
  13: 36,
  16: 56,
  17: 55,
  18: 58,
  20: 57,
  27: 53,
  32: 49,
  37: 123,
  38: 126,
  39: 124,
  40: 125,
  48: 29, 49: 18, 50: 19, 51: 20, 52: 21, 53: 23, 54: 22, 55: 26, 56: 28, 57: 25,
  65: 0, 66: 11, 67: 8, 68: 2, 69: 14, 70: 3, 71: 5, 72: 4, 73: 34, 74: 38,
  75: 40, 76: 37, 77: 46, 78: 45, 79: 31, 80: 35, 81: 12, 82: 15, 83: 1,
  84: 17, 85: 32, 86: 9, 87: 13, 88: 7, 89: 16, 90: 6,
  97: 83, 98: 84, 99: 85, 100: 86, 101: 87, 102: 88, 103: 89, 104: 91, 105: 92,
  112: 122, 113: 120, 114: 99, 115: 118, 116: 96, 117: 97, 118: 98, 119: 100,
  120: 101, 121: 109, 122: 111, 123: 110,
  186: 41, 187: 24, 188: 43, 189: 27, 190: 47, 191: 44, 192: 50,
  219: 33, 220: 42, 221: 30, 222: 39,
};

const GRAYSCALE_PALETTE: number[][] = Array.from({ length: 256 }, (_, i) => [255 - i, 255 - i, 255 - i]);
import { bakeModeForInk } from '../stage/matte.js';
import { mp3DurationMs } from './mp3.js';
import type { MemberKind } from '../bundle/types.js';
import { Channel } from './sprites.js';
import type { PersistWorkerLike, PersistWorkerMsg } from '../worker/persist.js';

let measureCtx: CanvasRenderingContext2D | null = null;
export interface ChannelVisual {
  kind: 'bitmap' | 'text' | 'image' | 'shape';
  bytes?: Uint8Array;
  remapPalette?: number[][];
  text?: string;
  image?: LImage;
  shape?: ShapeDef;
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
  fontSize?: number;
  color?: string | null;
  ink?: number;
  maskBytes?: Uint8Array;
  maskRegX?: number;
  maskRegY?: number;
  bgColor?: string | null;
  alignment?: string;
  wordWrap?: boolean;
  width?: number;
  height?: number;
  regX: number;
  regY: number;
}

export function cssFontFor(font: LVal | undefined): { family: string; weight: string } {
  const name = typeof font === 'string' ? font : font instanceof LSymbol ? font.name : '';
  const lower = name.toLowerCase();
  if (lower.includes('volter') || lower === 'v' || lower === 'vb' || lower.includes('courier')) {
    return { family: 'Volter', weight: lower.includes('bold') || lower === 'vb' || lower.includes('courier') ? '700' : '400' };
  }
  return { family: name || 'Arial', weight: '400' };
}

export function cssColorFor(color: LVal | undefined | null): string | null {
  if (color === undefined || color === null) return null;
  const c = colorFrom(color);
  if (!c) return null;
  return `rgb(${c.red},${c.green},${c.blue})`;
}

export function alignmentName(alignment: LVal | undefined): string {
  if (typeof alignment === 'string') return alignment.toLowerCase();
  if (alignment instanceof LSymbol) return alignment.name.toLowerCase();
  return 'left';
}

export function textPropOf(member: Member, key: string): LVal | undefined {
  return member.textProps?.get(key.toLowerCase());
}

const MEMBER_TEXT_PROPS = new Set([
  'topspacing', 'boxtype', 'leftmargin', 'rightmargin', 'leading', 'italics',
  'bold', 'underline', 'bordertype', 'shadow', 'bgcolor', 'antialias',
  'bordercolor', 'hilite', 'inset', 'border', 'textshadow',
  'autotab', 'editable',
]);

export interface StageAdapter {
  setBackground(color: number): void;
  setChannel(channel: number, visual: ChannelVisual | null): void;
  refreshChannel(channel: number): void;
  resize(width: number, height: number): void;
  captureStage?(): Uint8Array | null;
}

interface WindowData {
  props: Map<string, LVal>;
  elements: Map<string, LObject>;
  procs: { handler: string; obj: LObject }[];
}

interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  readyState: number;
  close(): void;
  send(data: string | Uint8Array): void;
}

interface MultiuserState {
  socket: { close(): void; send(d: string | Uint8Array): void; readyState: number } | null;
  queue: { subject: string; content: LVal }[];
  deliver: { subject: string; content: LVal }[];
  buffer: string;
  mode: number;
  logon?: Uint8Array;
  handlerName?: string;
  handlerTarget?: LObjectClass;
}

interface WorkerShim {
  url: string;
  readyState: number;
  send(d: string | Uint8Array): void;
  close(): void;
}

function bytesOf(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function latin1Of(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

const MUS_INT = 1;
const MUS_SYMBOL = 2;
const MUS_STRING = 3;
const MUS_LIST = 7;
const MUS_PROPLIST = 10;
const MUS_MEDIA = 20;

function u16Bytes(n: number): Uint8Array {
  const o = new Uint8Array(2);
  new DataView(o.buffer).setUint16(0, n);
  return o;
}
function u32Bytes(n: number): Uint8Array {
  const o = new Uint8Array(4);
  new DataView(o.buffer).setUint32(0, n >>> 0);
  return o;
}
function i32Bytes(n: number): Uint8Array {
  const o = new Uint8Array(4);
  new DataView(o.buffer).setInt32(0, n | 0);
  return o;
}
function concatBytes(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function musStr(s: string): Uint8Array {
  const bytes = bytesOf(s);
  const out = new Uint8Array(4 + bytes.length + (bytes.length % 2 ? 1 : 0));
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  if (bytes.length % 2) out[4 + bytes.length] = 0;
  return out;
}

function musValue(v: LVal): Uint8Array {
  if (typeof v === 'number') {
    return concatBytes([u16Bytes(MUS_INT), i32Bytes(Math.trunc(v))]);
  }
  if (typeof v === 'string') {
    return concatBytes([u16Bytes(MUS_STRING), musStr(v)]);
  }
  if (v instanceof LSymbol) {
    return concatBytes([u16Bytes(MUS_SYMBOL), musStr(v.name)]);
  }
  if (v instanceof Uint8Array) {
    return concatBytes([u16Bytes(MUS_MEDIA), u32Bytes(v.length), v, v.length % 2 ? new Uint8Array([0]) : new Uint8Array()]);
  }
  if (v instanceof LList) {
    const parts: Uint8Array[] = [u16Bytes(MUS_LIST), u32Bytes(v.items.length)];
    for (const item of v.items) parts.push(musValue(item));
    return concatBytes(parts);
  }
  if (v instanceof LPropListClass) {
    const pairs: [string, LVal][] = [...v.props.entries()];
    const parts: Uint8Array[] = [u16Bytes(MUS_PROPLIST), u32Bytes(pairs.length)];
    for (const [k, val] of pairs) parts.push(musValue(new LSymbol(k)), musValue(val));
    return concatBytes(parts);
  }
  return u16Bytes(0);
}

function musFrame(subject: string, senderId: string, recipients: string[], contentType: number, content: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [
    i32Bytes(0),
    i32Bytes(0),
    musStr(subject),
    musStr(senderId),
    u32Bytes(recipients.length),
  ];
  for (const r of recipients) parts.push(musStr(r));
  parts.push(u16Bytes(contentType), content);
  const body = concatBytes(parts);
  return concatBytes([u16Bytes(0x7200), u32Bytes(body.length), body]);
}

interface MusFrame {
  subject: string;
  contentType: number;
  content: LVal;
}

function parseMusFrames(buf: Uint8Array): { frames: MusFrame[]; rest: Uint8Array } {
  const frames: MusFrame[] = [];
  let off = 0;
  while (off + 6 <= buf.length) {
    const header = (buf[off] << 8) | buf[off + 1];
    if (header !== 0x7200) {
      off++;
      continue;
    }
    const len = new DataView(buf.buffer, buf.byteOffset + off + 2, 4).getUint32(0);
    if (off + 6 + len > buf.length) break;
    const parsed = parseMusBody(new Uint8Array(buf.buffer, buf.byteOffset + off + 6, len));
    if (parsed) frames.push(parsed);
    off += 6 + len;
  }
  return { frames, rest: buf.subarray(off) };
}

function parseMusBody(body: Uint8Array): MusFrame | null {
  let off = 0;
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const readU32 = (): number => {
    const v = dv.getUint32(off);
    off += 4;
    return v;
  };
  const readI32 = (): number => {
    const v = dv.getInt32(off);
    off += 4;
    return v;
  };
  const readU16 = (): number => {
    const v = dv.getUint16(off);
    off += 2;
    return v;
  };
  const readStr = (): string => {
    const len = readU32();
    if (len === 0) return '';
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(body[off + i]);
    off += len + (len % 2 ? 1 : 0);
    return s;
  };
  try {
    readI32();
    readI32();
    const subject = readStr();
    readStr();
    const recvCount = readU32();
    for (let i = 0; i < recvCount; i++) readStr();
    const contentType = readU16();
    let content: LVal = '';
    switch (contentType) {
      case MUS_INT:
        content = readI32();
        break;
      case MUS_STRING:
        content = readStr();
        break;
      case MUS_PROPLIST: {
        const count = readU32();
        const map = new Map<string, LVal>();
        for (let i = 0; i < count; i++) {
          readU16();
          const key = readStr();
          const dataTag = readU16();
          if (dataTag === MUS_INT) {
            map.set(key, readI32());
          } else {
            const dlen = readU32();
            const data = body.subarray(off, off + dlen);
            off += dlen + (dlen % 2 ? 1 : 0);
            map.set(key, dataTag === MUS_STRING ? latin1Of(data) : data);
          }
        }
        content = new LPropListClass(map);
        break;
      }
      default:
        content = '';
    }
    return { subject, contentType, content };
  } catch {
    return null;
  }
}

function wsScheme(): string {
  const proto = (globalThis as { location?: { protocol?: string } }).location?.protocol;
  return proto === 'https:' ? 'wss' : 'ws';
}

interface NetRequest {
  url: string;
  done: boolean;
  error: string;
  text: string;
  bytes?: Uint8Array;
  framesLeft?: number;
  bytesSoFar?: number;
  bytesTotal?: number;
  rampFrames?: number;
  awaitingFinish?: boolean;
}

const NET_RAMP_FRAMES = 24;

const CAST_MEMBER_RE = /^--\s*Cast member:\s*(.*)$/m;

export class DirectorEngine implements InterpreterHost, BuiltinBackend, MemberHostApi {
  casts: CastLib[] = [];
  castByName = new Map<string, CastLib>();
  membersByGlobal = new Map<number, Member>();
  scriptsByName = new Map<string, { script: Script; member: Member }>();
  globalHandlers = new Map<string, GlobalHandlerRef>();
  globals = new Map<string, LVal>();
  channels: Channel[] = [new Channel(0)];
  objects = new Map<string, LObject>();
  windows = new Map<string, WindowData>();
  events = new Map<string, { handler: string; obj: LObject }[]>();
  listeners = new Map<string, { objId: string; msgs: LVal }[]>();
  commands = new Map<string, { objId: string; cmds: LVal }[]>();
  connections = new Map<string, LObject>();
  prefs = new Map<string, string>();
  frame = 1;
  frameTempo = 30;
  itemDelim = ',';
  traceScript = 0;
  traceLogFile = '';
  activeWindow = 'stage';
  _movie: LObjectClass;
  _player: LObjectClass;
  rolloverChannel = 0;
  mouseH = 0;
  mouseV = 0;
  mouseButton: 'down' | 'up' = 'up';
  mouseDownChannel = 0;
  doubleClick = false;
  private lastMouseDownTime = 0;
  _stopEventPending = false;
  onCastLoaded?: (castName: string) => void;
  keyboardFocusSprite = 0;
  lastKey = '';
  lastKeyCode = 0;
  keyDownActive = false;
  keyPressed = '';
  private heldKeys: string[] = [];
  floatPrecision = 4;
  shiftDown = false;
  optionDown = false;
  commandDown = false;
  controlDown = false;
  stageWidth = 720;
  stageHeight = 540;
  stageLeft = 0;
  stageTop = 0;
  stageRight = 720;
  stageBottom = 540;
  stageBackground = 0x0d0d18;
  private _stageImage: LImage | null = null;
  private _stageComposite: LImage | null = null;
  movieConfig: MovieConfig | null = null;
  castList: CastListEntry[] | null = null;
  currentPalette: number[][] | null = null;
  lastChannel = 1006;
  alertHookValue: LVal = 0;
  private timeouts: { obj: LObject; due: number; period: number; handler: string; target: LObject }[] = [];

  private delays: { id: number; due: number; obj: LObject; handler: string; args: LVal[] }[] = [];
  private delaySeq = 0;
  moviePath = '/';
  timerStart = Date.now();
  runMode = 'Projector';
  textRasterizer?: (member: Member) => LImage | null;
  private externalParamList: { name: string; value: string }[] = [];
  private externalParamByName = new Map<string, string>();
  frameScripts: { script: Script; instance: LObject; handlers: Map<string, Handler>; passed: boolean }[] = [];
  movieScripts: { script: Script; instance: LObject }[] = [];
  frameCount = 0;
  booted = false;
  logs: string[] = [];
  netId = 0;
  net = new Map<number, NetRequest>();
  bundleLoader: BundleLoader | null = null;
  private uid = 0;
  private slotLastCast = new Map<number, string>();
  private goIssued = false;
  clickOnChannel = 0;
  interp: Interpreter;
  adapter: StageAdapter | null;
  private builtins = createBuiltinTable();
  private visualDirty = new Set<number>();
  private visualFlushScheduled = false;

  constructor(adapter: StageAdapter | null = null) {
    this.adapter = adapter;
    this.interp = new Interpreter(this);
    this._movie = this.hostGlobalObj('_movie');
    this._player = this.hostGlobalObj('_player');
    this.globals.set('_movie', this._movie);
    this.globals.set('_player', this._player);
    this.refreshPlayerWindowList();
  }


  async loadCast(loader: BundleLoader, castName: string): Promise<CastLib | null> {
    const existing = this.castByName.get(castName);
    if (existing?.loaded) return existing;
    this.bundleLoader = loader;
    await loader.loadCast(castName);
    const manifest = loader.getCast(castName);
    if (!manifest) return null;
    const cast = this.registerCast(loader, manifest);
    for (const link of manifest.linkedCasts ?? []) {
      if (this.castByName.get(link.name)?.loaded) continue;
      await this.loadCast(loader, link.name);
    }
    return cast;
  }

  private applyMovieConfig(m: MovieConfig): void {
    this.movieConfig = m;
    if (m.stageWidth !== undefined && m.stageWidth !== 0) this.stageWidth = m.stageWidth;
    if (m.stageHeight !== undefined && m.stageHeight !== 0) this.stageHeight = m.stageHeight;
    if (m.stageLeft !== undefined && m.stageLeft !== 0) this.stageLeft = m.stageLeft;
    if (m.stageTop !== undefined && m.stageTop !== 0) this.stageTop = m.stageTop;
    if (m.stageRight !== undefined && m.stageRight !== 0) this.stageRight = m.stageRight;
    if (m.stageBottom !== undefined && m.stageBottom !== 0) this.stageBottom = m.stageBottom;
    if (m.stageColorRgb !== undefined) this.stageBackground = m.stageColorRgb;
    else if (m.backgroundColor !== undefined) this.stageBackground = m.backgroundColor;
    if (m.tempo !== undefined && m.tempo !== 0) this.frameTempo = m.tempo;
    if (m.channels !== undefined && m.channels > 0) this.lastChannel = m.channels;
    this.log(`movie config: ${this.stageWidth}x${this.stageHeight} tempo ${this.frameTempo} bg #${this.stageBackground.toString(16).padStart(6, '0')}`);
    if (this.adapter) {
      this.adapter.resize(this.stageWidth, this.stageHeight);
      this.adapter.setBackground(this.stageBackground);
    }
  }

  private registerCastListShells(entries: CastListEntry[]): void {
    if (this.castList) return;
    this.castList = entries;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const cast = new CastLib(i + 1, e.name);
      const base = e.path.split(/[\\/]/).pop();
      if (base) cast.fileName = base;
      cast.loaded = false;
      this.casts.push(cast);
      this.castByName.set(e.name, cast);
    }
    this.log(`casts.txt: registered ${entries.length} castLibs`);
  }

  private findCastSlot(manifest: CastManifest): CastLib | null {
    const castName = manifest.name;
    const shell = this.castByName.get(castName);
    if (shell && !shell.loaded) return shell;
    if (manifest.movie) {
      const internal = this.castList?.find((e) => !e.path);
      if (internal) {
        const cast = this.castByName.get(internal.name);
        if (cast && !cast.loaded) return cast;
      }
    }
    if (manifest.fileName) {
      const base = manifest.fileName.split(/[\\/]/).pop()?.toLowerCase();
      if (base) {
        const entry = this.castList?.find((e) => e.path.split(/[\\/]/).pop()?.toLowerCase() === base);
        if (entry) {
          const cast = this.castByName.get(entry.name);
          if (cast && !cast.loaded) return cast;
        }
      }
    }
    const base = this.castNameFromUrl(castName);
    for (const cand of this.casts) {
      if (cand.loaded || cand.members.size > 0) continue;
      const candBase = this.castNameFromUrl(cand.name);
      if (candBase && candBase.toLowerCase() === (base ?? castName).toLowerCase()) return cand;
    }
    return null;
  }

  private registerCast(loader: BundleLoader, manifest: CastManifest): CastLib {
    const castName = manifest.name;
    if (manifest.movie && Array.isArray(manifest.castList) && !this.movieConfig) this.applyMovieConfig(manifest.movie);
    if (manifest.castList?.length) this.registerCastListShells(manifest.castList);

    let cast = this.findCastSlot(manifest);
    if (!cast) {
      cast = new CastLib(this.casts.length + 1, castName);
      this.casts.push(cast);
    }
    const prior = this.castByName.get(castName);
    if (prior && prior !== cast && prior.loaded && this.castList && !this.castList.some((e) => e.name === prior.name)) {
      this.log(`cast slot ${prior.number} superseded by "${castName}" (purging ${prior.members.size} members)`);
      this.clearCastMembers(prior);
      prior.loaded = false;
    }
    cast.loaded = true;
    cast.fonts = manifest.fonts;
    cast.fontFiles = manifest.fontFiles;
    cast.fileName = manifest.fileName ?? `${castName}.cst`;
    this.slotLastCast.set(cast.number, castName);

    for (const entry of manifest.members) {
      const member = new Member(cast.number, entry.number, entry.name, entry.kind);
      member.fileName = entry.file;
      if (entry.regX !== undefined) member.regX = entry.regX;
      if (entry.regY !== undefined) member.regY = entry.regY;

      switch (entry.kind) {
        case 'script': {
          let script: Script | null = null;
          let source = '';
          if (entry.bytecode) {
            const bytes = loader.readBytes(entry.file);
            if (bytes) {
              try {
                script = decodeScript(bytes);
                script.name = entry.name;
              } catch (e) {
                this.warn(`bytecode decode failed for ${entry.name}: ${e instanceof Error ? e.message : String(e)}`);
                script = null;
              }
            }
          }
          if (!script) {
            source = loader.memberText(entry) ?? '';
            script = parseLingo(source);
            script.name = entry.name;
            script.type = inferScriptType(source);
          }
          member.script = script;
          member.text = source || entry.file;
          break;
        }
        case 'text':
        case 'shape': {
          const text = loader.memberText(entry);
          if (entry.kind === 'text') member.text = text === undefined ? undefined : normalizeTextLines(text);
          else member.text = text;
          if (entry.kind === 'shape' && text !== undefined) member.shape = parseShapeText(text);
          break;
        }
        case 'bitmap':
          member.raw = loader.readBytes(entry.file);
          if (entry.palRel) {
            const palBytes = loader.readBytes(entry.palRel);
            if (palBytes !== undefined) member.palette = parsePaletteBytes(palBytes);
          }
          break;
        case 'palette': {
          const palBytes = loader.readBytes(entry.file);
          if (palBytes !== undefined) {
            member.palette = parsePaletteBytes(palBytes);
            if (member.palette.length > 0) this.currentPalette = member.palette;
          }
          break;
        }
        case 'sound':
        case 'font':
          member.raw = loader.readBytes(entry.file);
          break;
        default:
          break;
      }

      cast.members.set(member.number, member);
      cast.byName.set(member.name.toLowerCase(), member);
      this.membersByGlobal.set(this.memberGlobalNum(cast.number, member.number), member);

      if (member.script) {
        this.scriptsByName.set(member.name.toLowerCase(), { script: member.script, member });
        if (member.script.type !== 'parent') {
          for (const h of member.script.handlers) {
            this.globalHandlers.set(h.name.toLowerCase(), { script: member.script, handler: h });
          }
        }
      }
    }

    if (!this.casts.includes(cast)) this.casts.push(cast);
    this.castByName.set(castName, cast);
    this.castByName.set(cast.name, cast);
    this.log(`cast loaded: ${castName} (${manifest.members.length} members)`);
    this.onCastLoaded?.(castName);
    return cast;
  }

  addScriptMember(name: string, type: Script['type'], source: string): Member {
    const cast = this.casts[0] ?? new CastLib(1, 'internal');
    if (!this.casts.includes(cast)) {
      this.casts.push(cast);
      this.castByName.set('internal', cast);
    }
    const number = cast.members.size + 1;
    const member = new Member(cast.number, number, name, 'script');
    const script = parseLingo(source);
    script.name = name;
    script.type = type;
    member.script = script;
    member.text = source;
    cast.members.set(number, member);
    cast.byName.set(name.toLowerCase(), member);
    this.membersByGlobal.set(this.memberGlobalNum(cast.number, number), member);
    this.scriptsByName.set(name.toLowerCase(), { script, member });
    if (type !== 'parent') {
      for (const h of script.handlers) {
        this.globalHandlers.set(h.name.toLowerCase(), { script, handler: h });
      }
    }
    return member;
  }

  boot(): void {
    if (this.booted) return;
    this.booted = true;
    for (const [name, { script, member }] of this.scriptsByName) {
      void name;
      void member;
      if (script.type === 'score' || script.type === 'behavior') {
        const instance = this.interp.makeInstance(script);
        const handlers = new Map<string, Handler>();
        for (const h of script.handlers) handlers.set(h.name.toLowerCase(), h);
        this.frameScripts.push({ script, instance, handlers, passed: false });
      } else if (script.type === 'movie') {
        const instance = this.interp.makeInstance(script);
        this.movieScripts.push({ script, instance });
      }
    }
    this.log(`boot: ${this.frameScripts.length} frame scripts, ${this.movieScripts.length} movie scripts`);
    for (const ms of this.movieScripts) {
      this.callMovieHandler(ms, 'preparemovie');
    }
    for (const ms of this.movieScripts) {
      this.callMovieHandler(ms, 'startmovie');
    }
  }

  private callMovieHandler(ms: { script: Script; instance: LObject }, name: string): void {
    const h = ms.instance.handlers.get(name);
    if (h) this.interp.callHandler(ms.script, h, [], ms.instance, NO_GLOBALS);
  }

  tick(): void {
    if (!this.booted) return;
    this.frameCount++;
    this.completeNetRequests();
    this.fireTimeouts();
    this.fireDelays();
    this.fireNetMessages();
    this.pumpObjectManager();
    for (const fs of this.frameScripts) {
      if (fs.passed) continue;
      const enter = fs.handlers.get('enterframe');
      if (enter) this.interp.callHandler(fs.script, enter, [], fs.instance, NO_GLOBALS);
      const exit = fs.handlers.get('exitframe');
      if (!exit) continue;
      this.goIssued = false;
      this.interp.callHandler(fs.script, exit, [], fs.instance, NO_GLOBALS);
      if (!this.goIssued) fs.passed = true;
    }
  }

  timeout(name: string): LObject {
    const script: Script = {
      name: `timeout:${name}`,
      type: 'parent',
      props: [],
      globals: [],
      handlers: [],
      source: '',
    };
    const obj = this.interp.makeInstance(script);
    obj.lenient = true;
    obj.props.set('name', name);
    obj.props.set('period', 0);
    return obj;
  }

  private hostGlobalObj(name: string): LObjectClass {
    const script: Script = { name, type: 'parent', props: [], globals: [], handlers: [], source: '' };
    const obj = this.interp.makeInstance(script, this.getUniqueId());
    obj.lenient = true;
    return obj;
  }

  private refreshPlayerWindowList(): void {
    const refs = new LList([...this.windows.keys()].map((id) => new LWindowRefClass(id, this)));
    this._player.props.set('windowList', refs);
  }

  xtraInstance(name: string): LObject {
    const script: Script = {
      name: `xtra:${name}`,
      type: 'parent',
      props: [],
      globals: [],
      handlers: [],
      source: '',
    };
    const obj = this.interp.makeInstance(script, this.getUniqueId());
    obj.lenient = true;
    obj.props.set('name', name);
    return obj;
  }

  xmlParserMethod(obj: LObject, name: string, args: LVal[]): LVal {
    const lower = name.toLowerCase();
    if (lower === 'parsestring') {
      const xml = toLingoString(args[0] ?? '');
      try {
        const doc = parseXmlToLingo(xml);
        obj.props.set('child', doc.props.get('child') ?? new LList([]));
        obj.props.set('error', VOID);
        return 1;
      } catch (err) {
        obj.props.set('error', err instanceof Error ? err.message : String(err));
        obj.props.set('child', new LList([]));
        return 0;
      }
    }
    if (lower === 'geterror') {
      const e = obj.props.get('error');
      return e === undefined || e === null ? VOID : e;
    }
    return VOID;
  }

  multiuserUrl?: string;

  persistWorker?: PersistWorkerLike;
  pageHidden = false;

  private multiuserState = new Map<string, MultiuserState>();

  xtraMethod(obj: LObject, name: string, args: LVal[]): LVal {
    const lower = name.toLowerCase();
    switch (lower) {
      case 'setnetbufferlimits':
        return 0;
      case 'setnetmessagehandler': {
        const h = args[0];
        const t = args[1];
        const st = this.multiuserState.get(obj.id) ?? { socket: null, queue: [], deliver: [], buffer: '', mode: 0 };
        this.multiuserState.set(obj.id, st);
        if (h instanceof LSymbol && t instanceof LObjectClass) {
          st.handlerName = h.name;
          st.handlerTarget = t;
          obj.props.set('netHandler', h.name);
          obj.props.set('netTarget', t);
          this.log(`net: handler registered #${h.name} -> obj ${t.id}`);
        } else if (h === null && t === null) {
          st.handlerName = undefined;
          st.handlerTarget = undefined;
          obj.props.set('netHandler', VOID);
          obj.props.set('netTarget', VOID);
        } else {
          st.handlerName = undefined;
          st.handlerTarget = undefined;
          obj.props.set('netHandler', VOID);
          obj.props.set('netTarget', VOID);
          this.log(`net: setNetMessageHandler arg mismatch (sym=${h instanceof LSymbol} obj=${t instanceof LObjectClass})`);
        }
        return 0;
      }
      case 'connecttonetserver': {
        const host = toLingoString(args[2] ?? '');
        const port = toLingoString(args[3] ?? '');
        const mode = Math.round(asNum(args[5] ?? 0));
        const url = host && port ? `${wsScheme()}://${host}:${port}` : this.multiuserUrl ?? '';
        if (!url) {
          this.log(`net: multiuser connect (no ws url): no WebSocket in this environment — stub`);
          return 0;
        }
        const st = this.multiuserState.get(obj.id) ?? { socket: null, queue: [], deliver: [], buffer: '', mode };
        st.mode = mode;
        if (mode === 0) {
          st.logon = musFrame(
            'Logon',
            toLingoString(args[0] ?? ''),
            ['System'],
            MUS_LIST,
            musValue(new LList([toLingoString(args[4] ?? ''), toLingoString(args[0] ?? ''), toLingoString(args[1] ?? '')])),
          );
        } else {
          st.logon = undefined;
        }
        this.multiuserState.set(obj.id, st);
        if (this.persistWorker) {
          const pw = this.persistWorker;
          const shim: WorkerShim = {
            url,
            readyState: 0,
            send: (d) => pw.send(url, d instanceof Uint8Array ? d : bytesOf(d)),
            close: () => pw.closeSocket(url),
          };
          st.socket = shim;
          this.log(`net: multiuser ws ${url} (worker)`);
          pw.connect(url);
          return 0;
        }
        const WS = (globalThis as { WebSocket?: new (u: string) => WebSocketLike }).WebSocket;
        if (typeof WS !== 'function') {
          this.log(`net: multiuser connect (${url}): no WebSocket in this environment — stub`);
          return 0;
        }
        try {
          const ws = new WS(url);
          st.socket = ws;
          this.log(`net: multiuser ws ${url}`);
          ws.onopen = () => {
            this.log(`net: multiuser ws open ${url}`);
            if (st.mode === 0 && st.logon) {
              try {
                ws.send(st.logon);
              } catch (e) {
                this.log(`net: mus logon send failed: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
            st.queue.push({ subject: 'ConnectToNetServer', content: '' });
          };
          ws.onmessage = (ev: { data: unknown }) => {
            const d = ev.data;
            if (d instanceof ArrayBuffer) {
              this.ingestNetBytes(st, new Uint8Array(d));
            } else if (ArrayBuffer.isView(d)) {
              this.ingestNetBytes(st, new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
            } else if (typeof Blob !== 'undefined' && d instanceof Blob) {
              d.arrayBuffer().then((ab) => this.ingestNetBytes(st, new Uint8Array(ab))).catch(() => {  });
            } else if (typeof d === 'string') {
              this.ingestNetText(st, d);
            }
          };
          ws.onclose = () => {
            st.socket = null;
            this.log(`net: multiuser ws closed ${url}`);
          };
          ws.onerror = (e: unknown) => this.log(`net: multiuser ws error: ${e instanceof Error ? e.message : String(e)}`);
        } catch (e) {
          this.log(`net: multiuser ws connect failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return 0;
      }
      case 'sendnetmessage': {
        const st = this.multiuserState.get(obj.id);
        if (!st?.socket) return 0;
        const isRawBytesSend = args[0] === 0 && args[1] === 0;
        const from = asNum(args[0] ?? -1);
        const to = asNum(args[1] ?? -1);
        let data: string;
        if (isRawBytesSend) {
          data = toLingoString(args[2] ?? '');
          if (data.length === 1 && data.charCodeAt(0) === 0) {
            try { st.socket.close(); } catch {  }
            st.socket = null;
            return 0;
          }
        } else if (st.mode === 0) {
          const subject = toLingoString(args[1] ?? '');
          const contentVal = args[2];
          let contentType = MUS_STRING;
          let contentBytes: Uint8Array;
          if (contentVal instanceof LPropListClass) {
            contentType = MUS_PROPLIST;
            contentBytes = musValue(contentVal);
          } else if (contentVal instanceof Uint8Array) {
            contentType = MUS_MEDIA;
            contentBytes = musValue(contentVal);
          } else if (contentVal instanceof LList) {
            contentBytes = musStr(contentVal.items.map(toLingoString).join(' '));
          } else {
            contentBytes = musStr(toLingoString(contentVal ?? ''));
          }
          const fromWhom = toLingoString(args[0] ?? '');
          const frame = musFrame(subject, fromWhom, [fromWhom || '*'], contentType, contentBytes);
          this.log(`net: sendNetMessage MUS subj=${subject} ${frame.length}B -> ws`);
          try {
            st.socket.send(frame);
          } catch (e) {
            this.log(`net: multiuser send failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          return 0;
        } else {
          const subject = toLingoString(args[1] ?? '');
          const content =
            args[2] instanceof LList
              ? (args[2] as LList).items.map(toLingoString).join(' ')
              : toLingoString(args[2] ?? '');
          data = subject + (content ? ' ' + content : '');
        }
        let subj: string | number = '?';
        if (data.length >= 5) subj = ((data.charCodeAt(3) & 63) * 64) + (data.charCodeAt(4) & 63);
        else if (data.length > 3) subj = data.charCodeAt(3);
        this.log(`net: sendNetMessage from=${from} to=${to} ${data.length}B subj=${subj} -> ws`);
        try { st.socket.send(bytesOf(data)); } catch (e) {
          this.log(`net: multiuser send failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return 0;
      }
      case 'closenetconnection':
      case 'disconnect':
      case 'flushnetmessages': {
        const st = this.multiuserState.get(obj.id);
        if (st?.socket) {
          try { st.socket.close(); } catch {  }
          st.socket = null;
        }
        return 0;
      }
      case 'isconnected': {
        const st = this.multiuserState.get(obj.id);
        return st?.socket?.readyState === 1 ? 1 : 0;
      }
      case 'getnumberwaitingnetmessages':
        return this.multiuserState.get(obj.id)?.queue.length ?? 0;
      case 'checknetmessages': {
        const st = this.multiuserState.get(obj.id);
        if (!st) return 0;
        const want = Math.max(0, Math.round(asNum(args[0] ?? 1)));
        const n = Math.min(want, st.queue.length);
        const handlerName = st.handlerName;
        const target = st.handlerTarget;
        if (handlerName && target) {
          for (let i = 0; i < n; i++) {
            const msg = st.queue.shift();
            if (!msg) break;
            st.deliver.push(msg);
            this.interp.callObjectHandler(target, handlerName, []);
            st.deliver.length = 0;
          }
        }
        return n;
      }
      case 'getnetmessage': {
        const st = this.multiuserState.get(obj.id);
        const m = st?.deliver.shift() ?? st?.queue.shift();
        if (!m) return VOID;
        try {
          const t = st?.handlerTarget;
          let ptr: LPropListClass | null = null;
          if (t instanceof LObjectClass) {
            const key = [...t.props.keys()].find((k) => k.toLowerCase() === 'plistenerspntr');
            if (key !== undefined && t.props.get(key) instanceof LPropListClass) {
              ptr = t.props.get(key) as LPropListClass;
            }
          }
          const value = ptr?.props.get('value');
          const keys = value instanceof LPropListClass ? [...value.props.keys()] : [];
          this.log(`net: listeners table keys=[${keys.join(',')}] (${keys.length})`);
        } catch {
        }
        this.log(`net: getNetMessage subj="${m.subject}" content=${typeof m.content === 'string' ? m.content.length : 0}B`);
        return new LPropListClass(new Map<string, LVal>([
          ['errorCode', 0],
          ['senderID', ''],
          ['subject', m.subject],
          ['content', m.content],
        ]));
      }
      default:
        this.warn(`xtra(Multiuser).${name}(): unsupported`);
        return VOID;
    }
  }

  attachPersistence(worker: PersistWorkerLike): void {
    if (this.persistWorker === worker) return;
    this.persistWorker = worker;
    worker.onMessage((msg) => this.onWorkerMessage(msg));
  }

  setPageHidden(hidden: boolean): void {
    this.pageHidden = hidden;
    this.persistWorker?.setHidden(hidden);
    this.log(`net: page ${hidden ? 'hidden' : 'visible'} — ${hidden ? 'worker 1 Hz tick' : 'rAF ticker'}`);
  }

  private onWorkerMessage(msg: PersistWorkerMsg): void {
    switch (msg.type) {
      case 'ws-open': {
        for (const st of this.multiuserState.values()) {
          const s = st.socket as WorkerShim | null;
          if (!s || s.url !== msg.url) continue;
          s.readyState = 1;
          this.log(`net: multiuser ws open ${msg.url}`);
          if (st.mode === 0 && st.logon) {
            try {
              this.persistWorker?.send(msg.url, st.logon);
            } catch {  }
          }
          st.queue.push({ subject: 'ConnectToNetServer', content: '' });
        }
        break;
      }
      case 'ws-data': {
        const bytes = new Uint8Array(msg.bytes);
        for (const st of this.multiuserState.values()) {
          const s = st.socket as WorkerShim | null;
          if (s && s.url === msg.url) this.ingestNetBytes(st, bytes);
        }
        break;
      }
      case 'ws-text': {
        for (const st of this.multiuserState.values()) {
          const s = st.socket as WorkerShim | null;
          if (s && s.url === msg.url) this.ingestNetText(st, msg.text);
        }
        break;
      }
      case 'ws-close': {
        for (const st of this.multiuserState.values()) {
          const s = st.socket as WorkerShim | null;
          if (s && s.url === msg.url) {
            st.socket = null;
            this.log(`net: multiuser ws closed ${msg.url}`);
          }
        }
        break;
      }
      case 'ws-error':
        this.log(`net: multiuser ws error: ${msg.message}`);
        break;
      case 'tick':
        if (this.pageHidden) this.tick();
        break;
    }
  }

  registerTimeout(obj: LObject, period: number, handler: string, target: LObject): void {
    this.timeouts.push({ obj, due: Date.now() + period, period, handler, target });
  }

  forgetTimeout(obj: LObject): void {
    this.timeouts = this.timeouts.filter((t) => t.obj !== obj);
  }

  private fireNetMessages(): void {
    for (const st of this.multiuserState.values()) {
      const handlerName = st.handlerName;
      const target = st.handlerTarget;
      if (!handlerName || !target) continue;
      if (st.queue.length === 0) continue;
      this.log(`net: draining ${st.queue.length} to #${handlerName}`);
      while (st.queue.length > 0) {
        const msg = st.queue.shift();
        if (!msg) break;
        st.deliver.push(msg);
        try {
          this.interp.callObjectHandler(target, handlerName, []);
        } catch (e) {
          this.warn(`net: multiuser handler threw: ${e instanceof Error ? e.message : String(e)}`);
        }
        st.deliver.length = 0;
      }
    }
  }

  private ingestNetBytes(st: MultiuserState, bytes: Uint8Array): void {
    if (st.mode === 0) {
      let prior = st.buffer.length;
      const combined = new Uint8Array(prior + bytes.length);
      for (let i = 0; i < prior; i++) combined[i] = st.buffer.charCodeAt(i);
      combined.set(bytes, prior);
      const { frames, rest } = parseMusFrames(combined);
      st.buffer = '';
      for (let i = 0; i < rest.length; i++) st.buffer += String.fromCharCode(rest[i]);
      for (const f of frames) {
        st.queue.push({ subject: f.subject, content: f.content });
        this.log(`net: mus rx subj="${f.subject}" (${st.queue.length} queued)`);
      }
      return;
    }
    let text = '';
    for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    this.ingestNetText(st, text);
  }

  private ingestNetText(st: MultiuserState, text: string): void {
    if (!text) return;
    st.queue.push({ subject: '', content: text });
    const subj =
      text.length >= 2 ? ((text.charCodeAt(0) & 63) * 64) + (text.charCodeAt(1) & 63) : -1;
    this.log(`net: rx ${text.length}B subj=${subj} (${st.queue.length} queued)`);
  }

  scheduleDelay(obj: LObject, ms: number, handler: string, args: LVal[]): number {
    const id = ++this.delaySeq;
    this.delays.push({ id, due: Date.now() + ms, obj, handler, args });
    return id;
  }

  cancelDelay(id: number): void {
    this.delays = this.delays.filter((d) => d.id !== id);
  }

  private fireDelays(): void {
    if (this.delays.length === 0) return;
    const now = Date.now();
    const due = this.delays.filter((d) => d.due <= now);
    if (due.length === 0) return;
    this.delays = this.delays.filter((d) => d.due > now);
    for (const d of due) {
      try {
        this.interp.callObjectHandler(d.obj, d.handler, d.args);
      } catch (err) {
        this.warn(`delayed #${d.handler}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private fireTimeouts(): void {
    if (this.timeouts.length === 0) return;
    const now = Date.now();
    const due = this.timeouts.filter((t) => t.due <= now);
    if (due.length === 0) return;
    const forgottenObjs = new Set<LObject>();
    const preCount = new Map<LObject, number>();
    for (const t of this.timeouts) {
      preCount.set(t.obj, (preCount.get(t.obj) || 0) + 1);
    }
    for (const t of due) {
      const h = t.target.handlers.get(t.handler.toLowerCase());
      if (h && t.target.script) this.interp.callHandler(t.target.script, h, [t.obj], t.target, NO_GLOBALS);
      else this.interp.callObjectHandler(t.target, t.handler, [t.obj]);
    }
    const postCount = new Map<LObject, number>();
    for (const t of this.timeouts) {
      postCount.set(t.obj, (postCount.get(t.obj) || 0) + 1);
    }
    const dueCount = new Map<LObject, number>();
    for (const t of due) {
      dueCount.set(t.obj, (dueCount.get(t.obj) || 0) + 1);
    }
    for (const [obj, pc] of preCount) {
      const dc = dueCount.get(obj) || 0;
      const po = postCount.get(obj) || 0;
      if (po <= pc - dc) forgottenObjs.add(obj);
    }
    this.timeouts = this.timeouts.filter((t) => t.due > now);
    for (const t of due) {
      if (t.period <= 0) continue;
      if (forgottenObjs.has(t.obj)) continue;
      this.timeouts.push({ ...t, due: now + t.period });
    }
  }

  dispatchPointerEvent(type: 'mouseDown' | 'mouseUp' | 'mouseMove', channel: number, x: number, y: number): void {
    this.mouseH = x;
    this.mouseV = y;
    this._stopEventPending = false;
    if (type === 'mouseDown') {
      this.mouseButton = 'down';
      this.mouseDownChannel = channel;
      const now = Date.now();
      this.doubleClick = now - this.lastMouseDownTime < 500;
      this.lastMouseDownTime = now;
      this.clickOnChannel = this.spriteAtPoint(x, y);
      const m = channel > 0 && channel < this.channels.length ? this.channels[channel].member : undefined;
      if (m && m.kind === 'text' && m.textProps?.get('editable')) this.keyboardFocusSprite = channel;
      else this.keyboardFocusSprite = 0;
    }
    if (type === 'mouseUp') {
      this.mouseButton = 'up';
      if (this.mouseDownChannel !== 0 && channel !== this.mouseDownChannel) {
        this.dispatchToChannelHandlers(this.mouseDownChannel, 'mouseupoutside', []);
      }
      this.mouseDownChannel = 0;
    }
    const lower = type.toLowerCase();
    for (const fs of this.frameScripts) {
      const h = fs.handlers.get(lower);
      if (h) this.interp.callHandler(fs.script, h, [], fs.instance, NO_GLOBALS);
      if (this._stopEventPending) {
        this._stopEventPending = false;
        return;
      }
    }
    this.dispatchToChannelHandlers(channel, lower, []);
    if (lower === 'mousemove') {
      const prev = this.rolloverChannel;
      if (prev !== 0 && prev !== channel) this.dispatchToChannelHandlers(prev, 'mouseleave', []);
      if (channel !== 0 && prev !== channel) this.dispatchToChannelHandlers(channel, 'mouseenter', []);
      if (channel !== 0 && channel === prev) this.dispatchToChannelHandlers(channel, 'mousewithin', []);
    }
    if (type === 'mouseUp') this.doubleClick = false;
    this.setRollover(channel);
    this._stopEventPending = false;
  }

  private directorKeyChar(key: string, keyCode: number): string {
    if (keyCode === 13) return '\r';
    if (keyCode === 8) return '\b';
    if (keyCode === 9) return '\t';
    if (keyCode === 27) return '';
    if (key === 'ArrowUp') return '\x1E';
    if (key === 'ArrowDown') return '\x1F';
    if (key === 'ArrowLeft') return '\x1C';
    if (key === 'ArrowRight') return '\x1D';
    return key;
  }

  dispatchKeyEvent(type: 'keyDown' | 'keyUp', key: string, keyCode: number, mods?: { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean }): void {
    if (mods) {
      this.shiftDown = !!mods.shift;
      this.optionDown = !!mods.alt;
      this.controlDown = !!mods.ctrl;
      this.commandDown = !!mods.meta;
    }
    const down = type === 'keyDown';
    this._stopEventPending = false;
    const dKey = this.directorKeyChar(key, keyCode);
    this.lastKey = dKey;
    this.lastKeyCode = WEB_TO_DIRECTOR_KEYCODE[keyCode] ?? keyCode;
    this.keyDownActive = down;
    if (down) {
      if (dKey !== '' && !this.heldKeys.includes(dKey)) this.heldKeys.push(dKey);
      this.keyPressed = this.heldKeys.length ? this.heldKeys[this.heldKeys.length - 1] : '';
    } else {
      const idx = this.heldKeys.lastIndexOf(dKey);
      if (idx >= 0) this.heldKeys.splice(idx, 1);
      this.keyPressed = this.heldKeys.length ? this.heldKeys[this.heldKeys.length - 1] : '';
    }
    const focus = this.keyboardFocusSprite;
    if (focus <= 0 || focus >= this.channels.length) return;
    this.dispatchToChannelHandlers(focus, down ? 'keydown' : 'keyup', []);
    if (this._stopEventPending || !down) {
      this._stopEventPending = false;
      return;
    }
    const member = this.channels[focus].member;
    if (!member) return;
    if (member.kind !== 'text' || !member.textProps?.get('editable')) return;
    const current = toLingoString(member.text ?? '');
    let next = current;
    if (keyCode === 8) next = current.slice(0, -1);
    else if (key.length === 1 && keyCode >= 32) next = current + key;
    if (next !== current) {
      this.setMemberProp(new LMemberRefClass(member.number, member.name, member.kind, member.castLibNumber, this), 'text', next);
    }
    this._stopEventPending = false;
  }

  private dispatchToChannelHandlers(channel: number, handler: string, args: LVal[]): void {
    if (channel <= 0 || channel >= this.channels.length) return;
    const list = this.channels[channel].scriptInstanceList;
    if (!(list instanceof LList)) return;
    for (const item of list.items) {
      if (this._stopEventPending) break;
      if (item instanceof LObjectClass) this.interp.callObjectHandler(item, handler, args);
    }
  }

  getChannel(n: number): Channel {
    while (this.channels.length <= n) this.channels.push(new Channel(this.channels.length));
    return this.channels[n];
  }

  private memberGlobalNum(castLib: number, member: number): number {
    return (castLib << 16) | (member & 0xffff);
  }

  getmemnum(name: string): number {
    const lower = name.toLowerCase();
    for (const v of this.nameVariants(lower)) {
      for (const cast of this.casts) {
        const member = cast.byName.get(v);
        if (member) {
          return this.memberGlobalNum(cast.number, member.number);
        }
      }
    }
    return 0;
  }

  private diagOn(): boolean {
    return !!(globalThis as { SPARK_DIAG?: unknown }).SPARK_DIAG;
  }

  private diagLog(msg: string): void {
    if (this.diagOn()) (typeof console !== 'undefined' ? console.log : null)?.('[SPARK_DIAG] ' + msg);
  }

  memberFor(ref: LMemberRef): Member | null {
    return this.membersByGlobal.get(this.memberGlobalNum(ref.castLibNumber, ref.number)) ?? null;
  }

  private ink9MaskFor(member: Member): Member | null {
    const cast = this.casts[member.castLibNumber - 1];
    if (!cast) return null;
    const next = cast.members.get(member.number + 1);
    if (next && next.kind === 'bitmap' && next.raw) return next;
    return null;
  }


  log(msg: string): void {
    this.logs.push(msg);
    if (this.logs.length > 4000) this.logs.splice(0, 2000);
  }

  warn(msg: string): void {
    const trail = this.interp?.callTrail?.slice(-6).join(' <- ');
    this.log(trail ? `[warn] ${msg} [${trail}]` : `[warn] ${msg}`);
  }

  getMember(number: number, castLibNumber?: number): LMemberRef | null {
    if (number < 0) number = -number;
    if (castLibNumber !== undefined) {
      const cast = this.casts[castLibNumber - 1];
      const member = cast?.members.get(number);
      return member ? new LMemberRefClass(member.number, member.name, member.kind, member.castLibNumber, this) : null;
    }
    const member = this.membersByGlobal.get(number);
    if (member) return new LMemberRefClass(member.number, member.name, member.kind, member.castLibNumber, this);
    if (number === 0) return null;
    const current = this.interp.currentScript;
    if (current) {
      for (const [name, hit] of this.scriptsByName) {
        if (hit.script === current && hit.member.castLibNumber !== 0) {
          const cast = this.casts[hit.member.castLibNumber - 1];
          const local = cast?.members.get(number);
          if (local) {
            return new LMemberRefClass(local.number, local.name, local.kind, local.castLibNumber, this);
          }
          break;
        }
      }
    }
    for (const cast of this.casts) {
      const local = cast.members.get(number);
      if (local && local.name) {
        return new LMemberRefClass(local.number, local.name, local.kind, local.castLibNumber, this);
      }
    }
    const m = this.memberForStaleSlotNumber(number);
    if (m) return new LMemberRefClass(m.number, m.name, m.kind, m.castLibNumber, this);
    return null;
  }

  private memberForStaleSlotNumber(number: number): Member | null {
    const slot = number >> 16;
    const localNum = number & 0xffff;
    if (slot < 1 || localNum < 1) return null;
    const last = this.slotLastCast.get(slot);
    if (!last) return null;
    const holder = this.castByName.get(last);
    return holder?.members.get(localNum) ?? null;
  }

  getMemberByName(name: string): LMemberRef | null {
    const lower = name.toLowerCase();
    for (const v of this.nameVariants(lower)) {
      for (const cast of this.casts) {
        const member = cast.byName.get(v);
        if (member) {
          return new LMemberRefClass(member.number, member.name, member.kind, member.castLibNumber, this);
        }
      }
    }
    return null;
  }

  getMemberByNameInCast(name: string, castLibNumber: number): LMemberRef | null {
    const cast = this.casts[castLibNumber - 1];
    if (!cast) return null;
    const lower = name.toLowerCase();
    for (const v of this.nameVariants(lower)) {
      const member = cast.byName.get(v);
      if (member) return new LMemberRefClass(member.number, member.name, member.kind, member.castLibNumber, this);
    }
    return null;
  }

  resolvePaletteTable(value: LVal): number[][] | null {
    let member: Member | null = null;
    if (value instanceof LMemberRefClass) {
      member = this.memberFor(value);
    } else if (typeof value === 'string') {
      const lower = value.toLowerCase();
      for (const v of this.nameVariants(lower)) {
        for (const cast of this.casts) {
          const m = cast.byName.get(v);
          if (m) { member = m; break; }
        }
        if (member) break;
      }
      if (!member) {
        const norm = lower.replace(/[\s_-]+/g, '');
        for (const cast of this.casts) {
          for (const [name, m] of cast.byName) {
            if (name.toLowerCase().replace(/[\s_-]+/g, '') === norm) { member = m; break; }
          }
          if (member) break;
        }
      }
    } else if (typeof value === 'number') {
      const ref = this.getMember(Math.round(value));
      if (ref) member = this.memberFor(ref);
    } else if (value instanceof LSymbol) {
      if (String(value.name).toLowerCase() === 'grayscale') return GRAYSCALE_PALETTE;
      return null;
    }
    return member?.palette ?? null;
  }

  memberExists(v: number | string): boolean {
    if (typeof v === 'number') return this.getMember(Math.round(v)) !== null;
    return this.getMemberByName(v) !== null;
  }

  private nameVariants(lower: string): string[] {
    const out = [lower];
    const spaced = lower.replaceAll('_', ' ');
    const underscored = lower.replaceAll(' ', '_');
    if (spaced !== lower) out.push(spaced);
    if (underscored !== lower) out.push(underscored);
    if (spaced !== lower && underscored !== lower) out.push(underscored.replaceAll('_', ' '));
    return out;
  }

  newMember(kind: MemberKind, castLibNumber: number): LMemberRef | null {
    const cast = this.casts[castLibNumber - 1] ?? this.casts[0];
    if (!cast) return null;
    let number = 1;
    while (cast.members.has(number)) number++;
    const member = new Member(cast.number, number, '', kind);
    cast.members.set(number, member);
    this.membersByGlobal.set(this.memberGlobalNum(cast.number, number), member);
    return new LMemberRefClass(number, member.name, member.kind, member.castLibNumber, this);
  }

  createNamedMember(name: string, kind: string, castLibNumber: number): number {
    const ref = this.newMember(kind as MemberKind, castLibNumber);
    if (!ref) return 0;
    const member = this.memberFor(ref);
    if (member) {
      this.diagLog(`createMember("${name}", ${kind}) in cast#${member.castLibNumber} -> local ${member.number} (${member.castLibNumber}<<16|${member.number})`);
      member.name = name;
      const cast = this.casts[member.castLibNumber - 1];
      if (cast && name) cast.byName.set(name.toLowerCase(), member);
    }
    return this.memberGlobalNum(ref.castLibNumber, ref.number);
  }

  getSprite(channel: number): LSpriteRef {
    return new LSpriteRefClass(channel, this);
  }

  getCastLib(arg: LVal): LCastLibRef | null {
    if (arg instanceof LCastLibRefClass) return arg;
    if (typeof arg === 'number') {
      const cast = this.casts[Math.round(arg) - 1];
      return cast ? new LCastLibRefClass(cast.number, cast.name, this) : null;
    }
    if (typeof arg === 'string') {
      let cast = this.castByName.get(arg);
      if (!cast) cast = this.createCast(arg);
      return cast ? new LCastLibRefClass(cast.number, cast.name, this) : null;
    }
    if (arg instanceof LSymbol) {
      let cast = this.castByName.get(arg.name);
      if (!cast) cast = this.createCast(arg.name);
      return cast ? new LCastLibRefClass(cast.number, cast.name, this) : null;
    }
    return null;
  }

  private createCast(name: string): CastLib {
    const cast = new CastLib(this.casts.length + 1, name);
    this.casts.push(cast);
    this.castByName.set(name, cast);
    this.log(`cast created dynamically: ${name}`);
    return cast;
  }

  getWindow(id: string): LWindowRef | null {
    return this.windows.has(id) ? new LWindowRefClass(id, this) : null;
  }

  createWindow(id: string): LWindowRef | null {
    if (!this.windows.has(id)) {
      this.windows.set(id, { props: new Map(), elements: new Map(), procs: [] });
      this.refreshPlayerWindowList();
      this.log(`window created: ${id}`);
    }
    return new LWindowRefClass(id, this);
  }

  removeWindow(id: string): void {
    this.windows.delete(id);
    this.refreshPlayerWindowList();
    this.log(`window removed: ${id}`);
  }

  windowExists(id: string): boolean {
    return this.windows.has(id);
  }

  getWindowIdList(): string[] {
    return [...this.windows.keys()];
  }

  getStage(): LStageRef {
    return new LStageRefClass(this.stageWidth, this.stageHeight);
  }

  stageImage(): LImage {
    if (!this._stageImage) this._stageImage = new LImage(this.stageWidth, this.stageHeight);
    return this._stageImage;
  }

  stageComposite(): LImage | null {
    if (!this.adapter?.captureStage) return null;
    if (!this._stageComposite) this._stageComposite = new LImage(this.stageWidth, this.stageHeight);
    const img = this._stageComposite;
    const px = this.adapter.captureStage();
    if (!px) return null;
    const buf = img.ensure();
    buf.set(px.length >= buf.length ? px.subarray(0, buf.length) : px);
    img.dirty = false;
    return img;
  }

  stageBgColor(): LVal {
    return intColor(this.stageBackground);
  }

  getThe(head: string, chain: TheSegment[]): LVal {
    const h = head.toLowerCase();
    if (chain.length === 0) {
      switch (h) {
        case 'frame': return this.frame;
        case 'frametempo': return this.frameTempo;
        case 'rollover': return this.rollover();
        case 'stage': return this.getStage();
        case 'stageleft': return this.stageLeft;
        case 'stageright': return this.stageRight;
        case 'stagetop': return this.stageTop;
        case 'stagebottom': return this.stageBottom;
        case 'tracescript': return this.traceScript;
        case 'tracelogfile': return this.traceLogFile;
        case 'activewindow': return new LWindowRefClass(this.activeWindow, this);
        case 'title': return '';
        case 'runmode': return this.runMode;
        case 'platform': return 'Windows,32';
        case 'exitlock': return 0;
        case 'debugplaybackenabled': return 0;
        case 'itemdelimiter': return this.itemDelim;
        case 'moviepath': return this.moviePath;
        case 'paramcount': return this.interp.currentArgs().length;
        case 'lastchannel': return this.lastChannel;
        case 'alerthook': return this.alertHookValue;
        case 'clickloc': return new LPointClass(0, 0);
        case 'clickon': return this.clickOnChannel;
        case 'doubleclick': return this.doubleClick ? 1 : 0;
        case 'mousedown': return this.mouseButton === 'down' ? 1 : 0;
        case 'mouseup': return this.mouseButton === 'down' ? 0 : 1;
        case 'mouseh': return this.mouseH;
        case 'mousev': return this.mouseV;
        case 'mouseloc': return new LPointClass(this.mouseH, this.mouseV);
        case 'keyboardfocussprite': return this.keyboardFocusSprite;
        case 'key': return this.lastKey;
        case 'keypressed': return this.keyPressed;
        case 'keycode': return this.lastKeyCode;
        case 'keydown': return this.keyDownActive ? 1 : 0;
        case 'keyup': return this.keyDownActive ? 0 : 1;
        case 'lastkey': return this.lastKey;
        case 'floatprecision': return this.floatPrecision;
        case 'maxinteger': return 2147483647;
        case 'shiftdown': return this.shiftDown ? 1 : 0;
        case 'optiondown': return this.optionDown ? 1 : 0;
        case 'commanddown': return this.commandDown ? 1 : 0;
        case 'controldown': return this.controlDown ? 1 : 0;
        case 'colordepth': return 32;
        case 'longtime': return new Date().toLocaleString('en-US');
        case 'shorttime': return new Date().toLocaleTimeString('en-US');
        case 'abbrevtime': return new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: 'numeric' });
        case 'longdate': return new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        case 'shortdate': return new Date().toLocaleDateString('en-US');
        case 'abbrevdate': return new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        case 'time': return new Date().toLocaleTimeString('en-US');
        case 'date': return new Date().toLocaleDateString('en-US');
        case 'xtralist': {
          const xtras = new LList([
            new LPropListClass(new PropPairs([['name', 'Multiusr'], ['fileName', 'Multiusr.x32']])),
          ]);
          return xtras;
        }
        case 'environment': {
          return new LPropListClass(new PropPairs([
            ['productName', 'Macromedia Director'],
            ['productVersion', '10.1'],
            ['productBuildVersion', 'R31'],
            ['osVersion', 'Windows,32'],
            ['platform', 'Windows,32'],
            ['runMode', 'Plugin'],
            ['colorDepth', 32],
          ]));
        }
        case 'seconds': return Math.floor(Date.now() / 1000);
        case 'ticks': return Math.floor(Date.now() / 60);
        case 'milliseconds': return Date.now();
        case 'timer': return Date.now() - this.timerStart;
        default:
          this.warn(`the ${head}: unsupported property`);
          return VOID;
      }
    }
    if (h === 'count' && chain.length === 1) {
      const argE = chain[0].arg ?? { kind: 'ident', name: chain[0].name } as Expr;
      const v = this.evalExprNode(argE);
      if (v instanceof LList) return v.items.length;
      if (v instanceof LPropListClass) return v.props.size;
      if (typeof v === 'string') return v.length;
      return 0;
    }
    if (h === 'chunk') {
      const seg = chain[0];
      if (seg.arg) {
        const v = this.evalExprNode(seg.arg);
        if (typeof v === 'string' && ['char', 'word', 'line', 'item', 'paragraph'].includes(seg.name)) {
          const parts =
            seg.name === 'char' ? v.split('') :
            seg.name === 'word' ? v.split(/\s+/).filter(Boolean) :
            seg.name === 'item' ? v.split(this.itemDelim) :
            v.split('\n');
          if (parts.length === 0) return '';
          if (seg.qualifier === 'last') return parts[parts.length - 1];
          if (seg.qualifier === 'first') return parts[0];
          if (seg.qualifier === 'middle') return parts[Math.floor(parts.length / 2)];
          return parts[parts.length - 1];
        }
        return VOID;
      }
    }
    if (h === 'number') {
      const seg0 = chain[0];
      const name = seg0.name.toLowerCase();
      if (name === 'castlib' && seg0.arg) {
        const cast = this.getCastLib(this.evalExprNode(seg0.arg));
        return cast?.number ?? 0;
      }
      if (name === 'castlibs') return this.casts.length;
      if (name === 'members') return this.casts[0]?.members.size ?? 0;
      if (name === 'castmembers') {
        const seg1 = chain[1];
        if (seg1 && seg1.name.toLowerCase() === 'castlib' && seg1.arg) {
          const cast = this.getCastLib(this.evalExprNode(seg1.arg));
          if (!cast) return 0;
          const c = this.casts[cast.number - 1];
          let max = 0;
          if (c) for (const num of c.members.keys()) if (num > max) max = num;
          return max;
        }
        return 0;
      }
      if (name === 'lines' || name === 'items' || name === 'words' || name === 'chars') {
        const subjectE = chain[1]
          ? (chain[1].arg ?? { kind: 'ident', name: chain[1].name } as Expr)
          : (seg0.arg ?? { kind: 'ident', name: seg0.name } as Expr);
        const v = this.evalExprNode(subjectE);
        if (typeof v === 'string') {
          if (name === 'lines') return v.split('\n').length;
          if (name === 'items') return v.split(this.itemDelim).length;
          if (name === 'words') return v.split(/\s+/).filter(Boolean).length;
          return v.length;
        }
        return 0;
      }
    }
    const seg0 = chain[0];
    const subjectE = seg0.arg ?? (chain.length === 1 ? { kind: 'ident', name: seg0.name } as Expr : undefined);
    if (subjectE) {
      const subject = this.evalExprNode(subjectE);
      if (subject instanceof LMemberRefClass) {
        return this.getMemberProp(subject, head);
      }
      if (h === 'image' && subject instanceof LMemberRefClass) {
        const member = this.memberFor(subject);
        return member ? this.memberImage(member) : new LImage(0, 0);
      }
      if (subject instanceof LSpriteRefClass) {
        return this.getSpriteProp(subject, head);
      }
      if (subject instanceof LImage) {
        switch (h) {
          case 'rect':
            return new LRectClass(0, 0, subject.width, subject.height);
          case 'depth':
            return subject.depth ?? 32;
          case 'width':
            return subject.width;
          case 'height':
            return subject.height;
          case 'paletteref':
            return subject.paletteRef ?? VOID;
          case 'usealpha':
            return subject.useAlpha ? 1 : 0;
          default:
            return VOID;
        }
      }
      if (subject instanceof LObjectClass) {
        let cur: LObjectClass | null = subject;
        let hops = 0;
        while (cur) {
          if (cur.script && scriptPropsLower(cur.script).has(h)) {
            if (cur.props.has(head)) return cur.props.get(head)!;
            if (cur.props.has(h)) return cur.props.get(h)!;
            return VOID;
          }
          if (++hops > 32) break;
          const anc = cur.props.get('ancestor');
          cur = anc instanceof LObjectClass ? anc : null;
        }
        if (subject.props.has(head)) return subject.props.get(head)!;
        if (subject.props.has(h)) return subject.props.get(h)!;
        return VOID;
      }
      if (subject instanceof LPropListClass) {
        const k = subject.props.has(head) ? head : subject.props.has(h) ? h : undefined;
        return k !== undefined ? subject.props.get(k) ?? VOID : VOID;
      }
      if (subject instanceof LCastLibRefClass) {
        if (h === 'number') return subject.number;
        if (h === 'name') return subject.name;
        return VOID;
      }
      if (subject instanceof LPointClass) {
        if (h === 'loch') return subject.locH;
        if (h === 'locv') return subject.locV;
        return VOID;
      }
      if (h === 'rollover') return this.rollover();
    }
    this.warn(`the ${head} of ...: unsupported [${chain.map((s) => s.name + (s.arg ? '(arg)' : '')).join(' <- ')}]`);
    return VOID;
  }

  setThe(head: string, chain: TheSegment[], value: LVal): void {
    void chain;
    const h = head.toLowerCase();
    switch (h) {
      case 'frame':
        this.frame = Math.round(asNum(value));
        return;
      case 'frametempo':
        this.frameTempo = Math.round(asNum(value));
        return;
      case 'itemdelimiter':
        this.itemDelim = toLingoString(value);
        return;
      case 'alerthook':
        this.alertHookValue = value;
        return;
      case 'tracescript':
        this.traceScript = asNum(value) === 0 ? 0 : 1;
        return;
      case 'tracelogfile':
        this.traceLogFile = toLingoString(value);
        return;
      case 'activewindow':
        this.activeWindow =
          (value instanceof LWindowRefClass && this.windows.has(value.id))
            ? value.id
            : (typeof value === 'string' && this.windows.has(value))
              ? value
              : 'stage';
        return;
      case 'exitlock':
      case 'debugplaybackenabled':
      case 'selstart':
      case 'selend':
      case 'mouseline':
      case 'mouseh':
      case 'keyboardfocussprite':
        this.keyboardFocusSprite = Math.max(0, Math.round(asNum(value)));
        return;
      case 'mousev':
      case 'title':
        return;
      case 'floatprecision':
        this.floatPrecision = Math.max(0, Math.min(255, Math.round(asNum(value))));
        return;
      case 'shiftdown':
      case 'optiondown':
      case 'commanddown':
      case 'controldown':
        return;
      default:
        this.warn(`set the ${head}: unsupported`);
    }
  }

  resolveGlobalHandler(name: string): GlobalHandlerRef | null {
    const lower = name.toLowerCase();
    const current = this.interp.currentScript;
    if (current) {
      const h = current.handlers.find((x) => x.name.toLowerCase() === lower);
      if (h) return { script: current, handler: h };
    }
    return this.globalHandlers.get(lower) ?? null;
  }

  resolveScript(name: string): Script | null {
    const lower = name.toLowerCase();
    for (const v of this.nameVariants(lower)) {
      const hit = this.scriptsByName.get(v);
      if (hit) return hit.script;
    }
    return null;
  }

  resolveScriptByNumber(number: number): Script | null {
    const member = this.membersByGlobal.get(number);
    if (member?.script) return member.script;
    for (const cast of this.casts) {
      const local = cast.members.get(number);
      if (local?.script) return local.script;
    }
    return this.memberForStaleSlotNumber(number)?.script ?? null;
  }

  itemDelimiter(): string {
    return this.itemDelim;
  }

  private variableContainer(): LObjectClass | null {
    const core = this.globals.get('gcore');
    if (!(core instanceof LObjectClass)) return null;
    const pObjectList = core.props.get('pObjectList');
    if (!(pObjectList instanceof LPropListClass)) return null;
    const vm = pObjectList.props.get('variable_manager');
    return vm instanceof LObjectClass ? vm : null;
  }

  private containerItemList(vm: LObjectClass): LPropListClass | null {
    let cur: LObjectClass | null = vm;
    while (cur) {
      const pl = cur.props.get('pItemList');
      if (pl instanceof LPropListClass) return pl;
      const anc = cur.props.get('ancestor');
      cur = anc instanceof LObjectClass ? anc : null;
    }
    return null;
  }

  globalGet(name: string): LVal | undefined {
    return this.globalGetLower(name.toLowerCase(), name);
  }

  globalGetLower(key: string, name: string): LVal | undefined {
    const v = this.globals.get(key);
    if (v !== undefined) return v;
    const vm = this.variableContainer();
    if (vm) {
      const pItemList = this.containerItemList(vm);
      if (pItemList) {
        const hit = pItemList.props.get(name);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  }

  globalSet(name: string, value: LVal): void {
    this.globals.set(name.toLowerCase(), value);
    const vm = this.variableContainer();
    if (vm) {
      const pItemList = this.containerItemList(vm);
      if (pItemList) pItemList.props.set(name, value);
    }
  }

  getPref(name: string): string {
    return this.prefs.get(name.toLowerCase()) ?? '';
  }

  setPref(name: string, value: string): void {
    this.prefs.set(name.toLowerCase(), value);
  }

  go(frame: LVal): void {
    this.goIssued = true;
    const n = Math.round(asNum(frame));
    if (n === this.frame) return;
    this.frame = n;
    this.log(`go: frame ${n}`);
  }

  builtin(name: string, args: LVal[], interp: Interpreter): LVal | undefined {
    const fn = this.builtins.get(name.toLowerCase());
    if (fn) return fn(this, args, interp);
    return undefined;
  }

  resetTimer(): void {
    this.timerStart = Date.now();
  }

  memberMethod(m: LMemberRef, name: string, args: LVal[]): LVal {
    void args;
    const lower = name.toLowerCase();
    if (lower === 'erase') {
      const cast = this.casts[m.castLibNumber - 1];
      if (cast) {
        cast.members.delete(m.number);
        cast.byName.delete(m.name?.toLowerCase());
        this.membersByGlobal.delete(this.memberGlobalNum(m.castLibNumber, m.number));
        if (m.name) {
          const hit = this.scriptsByName.get(m.name.toLowerCase());
          if (hit?.member.castLibNumber === m.castLibNumber && hit.member.number === m.number) {
            this.scriptsByName.delete(m.name.toLowerCase());
          }
        }
      }
      return 1;
    }
    if (['movetofront', 'movetoback', 'copy', 'delete'].includes(lower)) return 1;
    if (lower === 'duplicate') {
      const src = this.memberFor(m);
      const targetArg = args[0];
      let targetRef: LMemberRef | null = targetArg instanceof LMemberRefClass ? targetArg : null;
      if (!targetRef && typeof targetArg === 'number') {
        targetRef = this.getMember(Math.round(targetArg));
      }
      const target = targetRef ? this.memberFor(targetRef) : null;
      if (src && target) {
        target.kind = src.kind;
        target.name = src.name;
        target.raw = src.raw;
        target.text = src.text;
        target.palette = src.palette;
        target.paletteTarget = src.paletteTarget;
        target.script = src.script;
        target.regX = src.regX;
        target.regY = src.regY;
        return 1;
      }
      return 1;
    }
    if (lower === 'charpostoloc') return this.charPosToLoc(m, args);
    if (lower === 'loctocharpos') return this.locToCharPos(m, args);
    this.warn(`member(${m.number}).${name}(): stub`);
    return VOID;
  }

  private textLineTop(member: Member, fixed: number, topSpacing: number, size: number): number {
    let fontLH = size + 1;
    if (typeof document !== 'undefined' && measureCtx) {
      try {
        const { family, weight } = cssFontFor(member.font);
        const style = fontStyleFlags(member.fontStyle);
        const effWeight = style.bold ? '700' : weight;
        measureCtx.font = `${style.italic ? 'italic ' : ''}${effWeight} ${size}px ${family}`;
        const bbA = (measureCtx.measureText('M') as { fontBoundingBoxAscent?: number }).fontBoundingBoxAscent;
        const bbD = (measureCtx.measureText('M') as { fontBoundingBoxDescent?: number }).fontBoundingBoxDescent;
        if (typeof bbA === 'number' && isFinite(bbA) && bbA > 0) {
          fontLH = Math.round(bbA + (typeof bbD === 'number' && isFinite(bbD) ? bbD : 0));
        }
      } catch {
      }
    }
    const leading = Math.max(0, fixed - fontLH);
    const vOverflow = Math.max(0, fontLH - fixed);
    const lineStart0 = topSpacing + (topSpacing > 1 ? 1 : 0);
    return Math.max(0, lineStart0 + leading - vOverflow);
  }

  private charPosToLoc(m: LMemberRef, args: LVal[]): LVal {
    const member = this.memberFor(m);
    if (!member) return new LPointClass(0, 0);
    const text = member.text ?? '';
    const size = Math.max(1, Math.round(asNum(member.fontSize ?? 0) || 12));
    const fixed = Math.round(asNum(member.fixedLineSpace ?? 0) || 0);
    const topSpacing = Math.max(0, Math.round(asNum(member.textProps?.get('topspacing') ?? 0) || 0));
    const lineH = fixed > 0 ? fixed + topSpacing : Math.max(1, size);
    const charIndex = Math.max(1, Math.round(asNum(args[0])));
    const lines = text.split(/\r\n|\r|\n/);
    let remaining = charIndex;
    let lineIdx = 0;
    let posInLine = lines[0] ? lines[0].length : 0;
    for (let i = 0; i < lines.length; i++) {
      if (remaining <= lines[i].length) {
        lineIdx = i;
        posInLine = remaining;
        break;
      }
      remaining -= lines[i].length + 1;
      lineIdx = i;
      posInLine = lines[i].length;
    }
    const line = lines[lineIdx] ?? '';
    const prefix = line.slice(0, Math.min(posInLine, line.length));
    const prefixW = this.measureTextWidth(member, prefix);
    const rectW = member.rect ? Math.round(member.rect.width) : 0;
    const align = alignmentName(member.alignment);
    const lineW = this.measureTextWidth(member, line);
    let startX = 0;
    if (align === 'center' && rectW > 0) startX = Math.max(0, (rectW - lineW) / 2);
    else if (align === 'right' && rectW > 0) startX = Math.max(0, rectW - lineW);
    const lineTop = fixed > 0
      ? this.textLineTop(member, fixed, topSpacing, size)
      : (topSpacing > 0 ? topSpacing : Math.max(1, Math.round((lineH - size) / 2)));
    return new LPointClass(Math.round(startX + prefixW), lineTop + lineIdx * lineH);
  }

  private locToCharPos(m: LMemberRef, args: LVal[]): LVal {
    const member = this.memberFor(m);
    if (!member) return 0;
    const text = member.text ?? '';
    const size = Math.max(1, Math.round(asNum(member.fontSize ?? 0) || 12));
    const fixed = Math.round(asNum(member.fixedLineSpace ?? 0) || 0);
    const topSpacing = Math.max(0, Math.round(asNum(member.textProps?.get('topspacing') ?? 0) || 0));
    const lineH = fixed > 0 ? fixed + topSpacing : Math.max(1, size);
    const pt = args[0] instanceof LPointClass ? args[0] : null;
    const targetX = pt ? pt.locH : 0;
    const targetY = pt ? pt.locV : 0;
    const lineTop = fixed > 0
      ? this.textLineTop(member, fixed, topSpacing, size)
      : (topSpacing > 0 ? topSpacing : Math.max(1, Math.round((lineH - size) / 2)));
    const lines = text.split(/\r\n|\r|\n/);
    const lineIdx = Math.min(Math.max(0, Math.floor((targetY - lineTop) / lineH)), lines.length - 1);
    const line = lines[lineIdx] ?? '';
    let chars = 0;
    let w = 0;
    for (const ch of line) {
      w = this.measureTextWidth(member, line.slice(0, chars + 1));
      if (w > targetX) break;
      chars++;
    }
    let index = chars;
    for (let i = 0; i < lineIdx; i++) index += lines[i].length + 1;
    return Math.max(1, index + 1);
  }

  private measureTextWidth(member: Member, text: string): number {
    if (text.length === 0) return 0;
    const size = Math.max(1, Math.round(asNum(member.fontSize ?? 0) || 12));
    if (typeof document === 'undefined') return Math.round(text.length * size * 0.6);
    try {
      const { family, weight } = cssFontFor(member.font);
      const style = fontStyleFlags(member.fontStyle);
      const effWeight = style.bold ? '700' : weight;
      if (!measureCtx) {
        const canvas = document.createElement('canvas');
        measureCtx = canvas.getContext('2d');
      }
      if (!measureCtx) return Math.round(text.length * size * 0.6);
      measureCtx.font = `${style.italic ? 'italic ' : ''}${effWeight} ${size}px ${family}`;
      return measureCtx.measureText(text).width;
    } catch {
      return Math.round(text.length * size * 0.6);
    }
  }

  spriteMethod(s: LSpriteRef, name: string, args: LVal[]): LVal {
    const lower = name.toLowerCase();
    this.dispatchToChannelHandlers(s.channel, lower, args);
    if (lower === 'setid' || lower === 'setid2') {
      this.setSpriteProp(s, 'id', args[0] ?? VOID);
      return VOID;
    }
    if (lower === 'getid') return this.getSpriteProp(s, 'id');
    if (lower === 'setcursor' || lower === 'setcursor2') return VOID;
    if (lower === 'setmember') {
      this.setSpriteProp(s, 'member', args[0] ?? VOID);
      return VOID;
    }
    if (lower === 'registerprocedure' || lower === 'unregisterprocedure') {
      const handler = args[0] instanceof LSymbol ? args[0].name : toLingoString(args[0] ?? '');
      const objId = toLingoString(args[1] ?? '');
      const msg = args[2] instanceof LSymbol ? args[2].name : toLingoString(args[2] ?? '');
      const obj = this.objects.get(objId);
      if (lower === 'registerprocedure' && obj && handler && msg) this.addEvent(msg, handler, obj);
      return VOID;
    }
    this.warn(`sprite(${s.channel}).${name}(): unsupported`);
    return VOID;
  }

  windowMethod(w: LWindowRef, name: string, args: LVal[]): LVal {
    const data = this.windows.get(w.id);
    if (!data) return VOID;
    const lower = name.toLowerCase();
    switch (lower) {
      case 'merge':
      case 'unmerge':
      case 'center':
      case 'resizeto':
      case 'move':
      case 'deactivate':
      case 'activate':
      case 'close':
        this.log(`window ${w.id}.${name}()`);
        return VOID;
      case 'setproperty': {
        const key = args[0] instanceof LSymbol ? args[0].name : toLingoString(args[0]);
        data.props.set(key, args[1] ?? VOID);
        return VOID;
      }
      case 'getproperty':
        return data.props.get(args[0] instanceof LSymbol ? args[0].name : toLingoString(args[0])) ?? VOID;
      case 'elementexists':
        return data.elements.has(toLingoString(args[0])) ? 1 : 0;
      case 'getelement': {
        const name = toLingoString(args[0]);
        if (!data.elements.has(name)) data.elements.set(name, this.makeElement(name));
        return data.elements.get(name) ?? VOID;
      }
      case 'registerprocedure': {
        const handler = toLingoString(args[0]);
        const obj = this.objects.get(toLingoString(args[1])) ?? null;
        const msg = args[2] instanceof LSymbol ? args[2].name : toLingoString(args[2] ?? '');
        if (obj) {
          data.procs.push({ handler, obj });
          this.addEvent(msg, handler, obj);
        }
        return VOID;
      }
      case 'removeprocedure': {
        const handler = toLingoString(args[0]);
        const objId = toLingoString(args[1]);
        data.procs = data.procs.filter((p) => !(p.handler === handler && p.obj.id === objId));
        return VOID;
      }
      default:
        this.warn(`window ${w.id}.${name}(): stub`);
        return VOID;
    }
  }

  private makeElement(name: string): LObject {
    const script: Script = {
      name: `element:${name}`,
      type: 'parent',
      props: [],
      globals: [],
      handlers: [],
      source: '',
    };
    const obj = this.interp.makeInstance(script);
    obj.lenient = true;
    obj.props.set('name', name);
    const buffer = this.interp.makeInstance(script);
    buffer.lenient = true;
    buffer.props.set('image', this.stageImage());
    obj.props.set('buffer', buffer);
    return obj;
  }

  adoptImagePalette(ref: LMemberRef): void {
    const target = this.memberFor(ref);
    if (target?.palette && target.palette.length > 0) this.currentPalette = target.palette;
  }

  paletteColor(index: number): LColor {
    const raw = Math.round(index);
    if (raw >= 0 && raw <= 255) {
      const pal = this.currentPalette;
      const i = raw & 0xff;
      if (pal && pal[i]) {
        const [r, g, b] = pal[i];
        return new LColor(r, g, b);
      }
      return new LColor(128, 128, 128);
    }
    return new LColor((raw >> 16) & 0xff, (raw >> 8) & 0xff, raw & 0xff);
  }

  rollover(): number {
    return this.spriteAtPoint(this.mouseH, this.mouseV);
  }

  rolloverSprite(n: number): boolean {
    const ch = this.channels[n];
    if (!ch || !ch.member || ch.visible !== 1) return false;
    const w = ch.width ?? ch.member.width;
    const h = ch.height ?? ch.member.height;
    if (w <= 0 || h <= 0) return false;
    if (this.mouseH < ch.left || this.mouseH > ch.right || this.mouseV < ch.top || this.mouseV > ch.bottom) return false;
    return this.spritePixelAccept(ch, w, h, this.mouseH, this.mouseV);
  }

  private spriteAtPoint(x: number, y: number): number {
    const hits: { ch: Channel; z: number; n: number }[] = [];
    for (let i = 1; i < this.channels.length; i++) {
      const ch = this.channels[i];
      if (!ch.member || ch.visible !== 1) continue;
      const w = ch.width ?? ch.member.width;
      const h = ch.height ?? ch.member.height;
      if (w <= 0 || h <= 0) continue;
      if (x < ch.left || x > ch.right || y < ch.top || y > ch.bottom) continue;
      hits.push({ ch, z: ch.locZ, n: i });
    }
    hits.sort((a, b) => (b.z - a.z) || (b.n - a.n));
    for (const hit of hits) {
      const w = hit.ch.width ?? hit.ch.member!.width;
      const h = hit.ch.height ?? hit.ch.member!.height;
      if (this.spritePixelAccept(hit.ch, w, h, x, y)) return hit.n;
    }
    return 0;
  }

  private spritePixelAccept(ch: Channel, w: number, h: number, x: number, y: number): boolean {
    if (ch.ink !== 8) return true;
    const img = this.memberImage(ch.member!);
    const sw = Math.round(img.width);
    const sh = Math.round(img.height);
    if (sw < 1 || sh < 1) return true;
    const px = Math.round((x - ch.left) * (sw / Math.max(1, w)));
    const py = Math.round((y - ch.top) * (sh / Math.max(1, h)));
    if (px < 0 || py < 0 || px >= sw || py >= sh) return true;
    const data = img.ensure();
    return data[(py * sw + px) * 4 + 3] !== 0;
  }

  setRollover(n: number): void {
    this.rolloverChannel = n;
  }

  makeObject(script: Script): LObject {
    return this.interp.makeInstance(script, this.getUniqueId());
  }

  getObjectById(id: string): LObject | null {
    return this.objects.get(id) ?? null;
  }

  setObjectById(id: string, obj: LObject): void {
    this.objects.set(id, obj);
  }

  removeObjectById(id: string): void {
    this.objects.delete(id);
  }

  getUniqueId(): string {
    return `uid_${++this.uid}`;
  }

  private evalExprNode(expr: Expr): LVal {
    return this.interp.evalExpr(expr, this.interp.curEnv ?? new Env());
  }


  netGetNetText(url: string): number {
    const id = ++this.netId;
    this.net.set(id, { url, done: false, error: 'OK', text: '' });
    this.log(`net: getNetText(${url}) -> #${id}`);
    if (typeof fetch === 'function') {
      fetch(url).then(async (res) => {
        const req = this.net.get(id);
        if (!req) return;
        req.text = res.ok ? await res.text() : '';
        req.error = res.ok ? 'OK' : `HTTP ${res.status}`;
        req.done = true;
        this.log(`net: done #${id} (${url}) ${req.text.length} chars`);
      }).catch((err: unknown) => {
        const req = this.net.get(id);
        if (!req) return;
        req.error = err instanceof Error ? err.message : String(err);
        req.done = true;
        this.log(`net: error #${id} (${url}): ${req.error}`);
      });
    } else {
      const req = this.net.get(id);
      if (req) req.framesLeft = 3;
    }
    return id;
  }

  getStreamStatus(id: number): LVal {
    const req = this.net.get(Math.round(id));
    if (!req) return VOID;
    let soFar: number;
    let total: number;
    if ((req.bytesTotal ?? 0) > 0) {
      soFar = Math.min(req.bytesSoFar ?? 0, req.bytesTotal ?? 0);
      total = req.bytesTotal ?? 0;
    } else {
      soFar = req.done ? Math.max(1, req.text?.length ?? 0) : 0;
      total = soFar;
    }
    const status = new Map<string, LVal>([
      ['bytesSoFar', soFar],
      ['bytesTotal', total],
      ['error', req.error ?? 'OK'],
    ]);
    return new LPropListClass(status);
  }

  netDone(id: number | undefined): number {
    if (id === undefined) {
      let latest: NetRequest | undefined;
      for (const req of this.net.values()) latest = req;
      return latest?.done ? 1 : 0;
    }
    return this.net.get(id)?.done ? 1 : 0;
  }

  netError(id: number | undefined): string {
    return this.net.get(id ?? 0)?.error ?? '';
  }

  netTextResult(id: number | undefined): string {
    return normalizeTextLines(this.net.get(id ?? 0)?.text ?? '');
  }

  preloadNetThing(url: string): number {
    const id = ++this.netId;
    const req = { url, done: false, error: 'OK', text: '', bytesSoFar: 0, bytesTotal: 100, rampFrames: NET_RAMP_FRAMES, awaitingFinish: false };
    this.net.set(id, req);
    this.log(`net: preload(${url}) -> #${id}`);
    const name = this.castNameFromUrl(url);
    if (name && this.bundleLoader) {
      if (this.bundleLoader.getCast(name)) {
        req.bytesSoFar = 100;
        req.done = true;
        this.log(`net: done #${id} (${url})`);
      } else {
        this.bundleLoader.loadCast(name, (soFar, total) => {
          const r = this.net.get(id);
          if (!r || r.done || total <= 0) return;
          r.rampFrames = 0;
          r.bytesSoFar = soFar;
          r.bytesTotal = total;
        }, url).then(() => {
          const r = this.net.get(id);
          if (!r || r.done) return;
          if (!this.bundleLoader!.getCast(name)) {
            r.error = `bundle not found for ${name}`;
            r.done = true;
            this.log(`net: error #${id} (${url}): ${r.error}`);
            return;
          }
          r.awaitingFinish = true;
        }, (e: unknown) => {
          const r = this.net.get(id);
          if (!r || r.done) return;
          r.error = e instanceof Error ? e.message : String(e);
          r.done = true;
          this.log(`net: error #${id} (${url}): ${r.error}`);
        });
      }
    } else {
      if (typeof fetch === 'function') {
        req.awaitingFinish = true;
        this.fetchFileBytes(id, url).catch(() => {
          const r = this.net.get(id);
          if (r && !r.done) {
            r.done = true;
            this.log(`net: error #${id} (${url}): ${r.error}`);
          }
        });
      } else {
        req.awaitingFinish = true;
      }
    }
    return id;
  }

  private async fetchFileBytes(id: number, url: string): Promise<void> {
    const res = await fetch(url);
    const req = this.net.get(id);
    if (!req || req.done) return;
    if (!res.ok) {
      req.error = `HTTP ${res.status}`;
      req.done = true;
      this.log(`net: error #${id} (${url}): ${req.error}`);
      return;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (req.done) return;
    req.bytes = bytes;
    req.bytesSoFar = bytes.length;
    req.bytesTotal = bytes.length;
    req.done = true;
    this.log(`net: done #${id} (${url}) ${bytes.length} bytes`);
  }

  private completeNetRequest(id: number, url: string): void {
    const req = this.net.get(id);
    if (!req || req.done) return;
    req.done = true;
    this.log(`net: done #${id} (${url})`);
  }

  private castNameFromUrl(url: string): string | null {
    const base = (url.split('?')[0].split('/').pop() ?? '').trim();
    if (!base) return null;
    const m = /^(.+?)\.(cct|cst|cxt)$/i.exec(base);
    if (m) return m[1];
    if (/\.[a-z0-9]{2,5}$/i.test(base)) return null;
    return base;
  }

  importFileInto(member: LVal, url: string): number {
    const name = this.castNameFromUrl(url);
    if (!name) {
      return this.importDownloadedImage(member, url);
    }
    if (this.castByName.get(name)?.loaded) return 1;
    const loader = this.bundleLoader;
    const manifest = loader?.getCast(name);
    if (!manifest) {
      this.warn(`importFileInto: no bundle for "${name}"`);
      return 0;
    }
    const cast = this.registerCast(loader!, manifest);
    this.indexCast(cast.number);
    this.log(`cast loaded: ${name} (${manifest.members.length} members)`);
    return 1;
  }

  private importDownloadedImage(memberRef: LVal, url: string): number {
    const member = this.memberFor(memberRef as LMemberRef);
    if (!member) {
      this.warn(`importFileInto: no member for image ${url}`);
      return 0;
    }
    const finish = (bytes: Uint8Array): number => {
      try {
        const isPng = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
        const { width, height, rgba } = isPng ? decodePng(bytes) : decodeGif(bytes);
        const img = new LImage(width, height);
        img.data = rgba;
        img.dirty = true;
        if (member.image) this.imageOwners.delete(member.image);
        member.image = img;
        this.imageOwners.set(img, member);
        member.raw = undefined;
        this.log(`net: imported image ${url} (${width}x${height}) -> cast ${member.castLibNumber}#${member.number}`);
        for (const ch of this.channels) {
          if (ch.member === member) this.buildChannelVisual(ch);
        }
        return 1;
      } catch (e) {
        this.warn(`importFileInto: decode failed for ${url}: ${e instanceof Error ? e.message : String(e)}`);
        return 0;
      }
    };
    for (const req of this.net.values()) {
      if (req.url === url && req.bytes) return finish(req.bytes);
    }
    if (typeof fetch !== 'function') {
      this.warn(`importFileInto: no fetch for image ${url}`);
      return 0;
    }
    fetch(url)
      .then(async (res) => {
        if (!res.ok) {
          this.warn(`importFileInto: HTTP ${res.status} for ${url}`);
          return;
        }
        finish(new Uint8Array(await res.arrayBuffer()));
      })
      .catch((err: unknown) => {
        this.warn(`importFileInto: fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
      });
    return 1;
  }

  /** Cast slots that went through indexCast (preIndexMembers ran); observable
   *  for tests, kept off the log stream. */
  indexedSlots: number[] = [];

  private indexCast(castNum: number): void {
    const cast = this.casts[castNum - 1];
    this.indexedSlots.push(castNum);
    try {
      const h = this.globalHandlers.get('getresourcemanager');
      if (!h) return;
      const rm = this.interp.callHandler(h.script, h.handler, [], null, NO_GLOBALS);
      if (rm instanceof LObjectClass) {
        this.interp.callObjectHandler(rm, 'preIndexMembers', [castNum]);
      }
    } catch (e) {
      this.warn(`preIndexMembers(${castNum}) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private unindexCast(castNum: number): void {
    const cast = this.casts[castNum - 1];
    if (!cast || cast.members.size === 0) return;
    try {
      const h = this.globalHandlers.get('getresourcemanager');
      if (!h) return;
      const rm = this.interp.callHandler(h.script, h.handler, [], null, NO_GLOBALS);
      if (rm instanceof LObjectClass) {
        this.interp.callObjectHandler(rm, 'unregisterMembers', [castNum]);
      }
    } catch (e) {
      this.warn(`unregisterMembers(${castNum}) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private pumpObjectManager(): void {
    const core = this.globals.get('gcore');
    if (!(core instanceof LObjectClass)) return;
    const h = core.handlers.get('prepareframe');
    if (!h || !core.script) return;
    try {
      this.interp.callHandler(core.script, h, [], core, NO_GLOBALS);
    } catch (err) {
      this.warn(`object manager prepareFrame: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private completeNetRequests(): void {
    for (const req of this.net.values()) {
      if (req.done) continue;
      if (req.rampFrames !== undefined) {
        if (req.rampFrames > 0 && req.bytesTotal === 100) {
          req.rampFrames--;
          req.bytesSoFar = Math.min(100, 100 - req.rampFrames * (100 / NET_RAMP_FRAMES));
        }
        if (req.awaitingFinish && req.rampFrames === 0) {
          req.done = true;
          this.log(`net: done # (${req.url})`);
        }
        continue;
      }
      if (req.framesLeft !== undefined) {
        if (--req.framesLeft <= 0) {
          req.done = true;
          this.log(`net: done # (${req.url})`);
        }
      }
    }
  }


  audioHost?: {
    play(channel: number, name: string, raw: Uint8Array, opts: { loop?: boolean; volume?: number; onEnded?: () => void }): void;
    stop(channel: number): void;
    setVolume(channel: number, volume: number): void;
    isBusy(channel: number): boolean;
  };

  private soundChannels = new Map<
    number,
    { volume: number; memberRef: LMemberRef | null; memberName: string; loop: boolean; playing: boolean; queue: LList; playStartedAt: number; soundDuration: number }
  >();

  private soundChannel(channel: number): { volume: number; memberRef: LMemberRef | null; memberName: string; loop: boolean; playing: boolean; queue: LList; playStartedAt: number; soundDuration: number } {
    let st = this.soundChannels.get(channel);
    if (!st) {
      st = { volume: 255, memberRef: null, memberName: '', loop: false, playing: false, queue: new LList(), playStartedAt: 0, soundDuration: 0 };
      this.soundChannels.set(channel, st);
    }
    return st;
  }

  private soundMemberRef(member: LVal): LMemberRef | null {
    return member instanceof LMemberRefClass ? member :
      typeof member === 'number' ? this.getMember(Math.round(member)) :
      typeof member === 'string' ? this.getMemberByName(member) :
      null;
  }

  puppetSound(channel: number, member: LVal): void {
    const ref = this.soundMemberRef(member);
    const name = ref ? ref.name : (member instanceof LMemberRefClass ? member.name : toLingoString(member));
    if (!ref) {
      this.log(`sound: puppetSound(${channel}, ${name}) (no such member)`);
      return;
    }
    this.stopSoundChannel(channel);
    this.playSoundChannel(channel, ref, false);
  }

  queueSoundOnChannel(member: LVal, channel: number, props?: LVal): void {
    const ref = this.soundMemberRef(member);
    if (!ref) {
      this.log(`sound: queueSound(${channel}, ${toLingoString(member)}) (no such member)`);
      return;
    }
    const entry = props instanceof LPropListClass ? (duplicateValue(props) as LPropListClass) : new LPropListClass();
    entry.props.set('member', ref);
    this.soundChannel(channel).queue.items.push(entry);
  }

  startSoundChannelBuiltin(channel: number): number {
    const st = this.soundChannels.get(channel);
    if (st && st.playing) return 1;
    this.advanceSoundQueue(channel);
    return 1;
  }

  stopSoundChannelBuiltin(channel: number): number {
    this.stopSoundChannel(channel);
    return 1;
  }

  playSoundInChannelBuiltin(member: LVal, channel: number): number {
    const ref = this.soundMemberRef(member);
    if (!ref) {
      this.log(`sound: playSoundInChannel(${channel}, ${toLingoString(member)}) (no such member)`);
      return 0;
    }
    this.stopSoundChannel(channel);
    this.playSoundChannel(channel, ref, false);
    return 1;
  }

  private stopSoundChannel(channel: number): void {
    const st = this.soundChannels.get(channel);
    if (st) {
      st.playing = false;
      st.memberRef = null;
      st.memberName = '';
      st.loop = false;
      st.queue = new LList();
      st.playStartedAt = 0;
      st.soundDuration = 0;
    }
    this.audioHost?.stop(channel);
  }

  private playSoundChannel(channel: number, ref: LMemberRef, loop: boolean): void {
    const member = this.memberFor(ref);
    const name = ref.name;
    if (!member || !member.raw) {
      this.log(`sound: puppetSound(${channel}, ${name}) (no payload)`);
      return;
    }
    const st = this.soundChannel(channel);
    st.memberRef = ref;
    st.memberName = member.name;
    st.playing = true;
    st.loop = loop;
    st.playStartedAt = Date.now();
    st.soundDuration = (this.getMemberProp(ref, 'duration') as number) || 0;
    if (!this.audioHost) {
      this.log(`sound: puppetSound(${channel}, ${name}) (no audio host)`);
      return;
    }
    this.audioHost.play(channel, member.name, member.raw, {
      loop,
      volume: st.volume,
      onEnded: () => this.advanceSoundQueue(channel),
    });
  }

  getSoundChannel(channel: number): LVal {
    const script: Script = {
      name: `sound:${channel}`,
      type: 'parent',
      props: ['member', 'startTime', 'endTime'],
      globals: [],
      handlers: [],
      source: '',
    };
    const obj = this.interp.makeInstance(script);
    obj.lenient = true;
    obj.props.set('volume', 255);
    obj.props.set('member', VOID);
    const st = this.soundChannels.get(channel);
    if (st && st.playing && st.playStartedAt > 0) {
      const elapsed = Date.now() - st.playStartedAt;
      obj.props.set('startTime', Math.min(elapsed, st.soundDuration));
      obj.props.set('endTime', st.soundDuration);
    } else {
      obj.props.set('startTime', 0);
      obj.props.set('endTime', 0);
    }
    return obj;
  }

  soundChannelMethod(obj: LObject, name: string, args: LVal[]): LVal {
    const chanMatch = /^sound:(\d+)$/.exec(obj.scriptName ?? '');
    const channel = chanMatch ? Number(chanMatch[1]) : 0;
    const lower = name.toLowerCase();
    if (lower === 'volume') {
      return obj.props.get('volume') ?? 0;
    }
    if (lower === 'member') return obj.props.get('member') ?? VOID;
    if (lower === 'setvolume') {
      const vol = Math.max(0, Math.min(255, Math.round(asNum(args[0]))));
      this.soundChannel(channel).volume = vol;
      this.audioHost?.setVolume(channel, vol);
      return vol;
    }
    if (lower === 'play') {
      const list = args[0] instanceof LPropListClass ? args[0] : args[0] instanceof LList ? args[0] : null;
      const memberVal = list instanceof LPropListClass ? (list.props.get('member') ?? VOID) : list instanceof LList ? (list.items[0] ?? VOID) : VOID;
      const loopCount = list instanceof LPropListClass ? asNum(list.props.get('loopCount') ?? 0) : 0;
      let ref: LMemberRef | null = null;
      if (memberVal !== VOID && memberVal !== undefined && memberVal !== 0) {
        ref =
          memberVal instanceof LMemberRefClass ? memberVal :
          typeof memberVal === 'number' ? this.getMember(Math.round(memberVal)) :
          typeof memberVal === 'string' ? this.getMemberByName(memberVal) :
          null;
      }
      if (!ref) {
        ref = this.soundChannel(channel).memberRef;
      }
      if (!ref) {
        const st = this.soundChannels.get(channel);
        if (st && st.queue.items.length > 0) {
          this.advanceSoundQueue(channel);
          return 1;
        }
        this.log(`sound: channel ${channel} play (no such member ${toLingoString(memberVal)})`);
        return 0;
      }
      this.stopSoundChannel(channel);
      this.playSoundChannel(channel, ref, loopCount === 0);
      obj.props.set('member', ref);
      return 1;
    }
    if (lower === 'queue') {
      const st = this.soundChannel(channel);
      st.queue.items.push(args[0] ?? VOID);
      return 1;
    }
    if (lower === 'stop') {
      this.stopSoundChannel(channel);
      return 1;
    }
    if (lower === 'setplaylist') {
      const st = this.soundChannel(channel);
      if (args[0] instanceof LList) {
        st.queue = args[0];
      } else {
        st.queue = new LList();
      }
      return 1;
    }
    if (lower === 'getplaylist') {
      return this.soundChannel(channel).queue;
    }
    if (lower === 'isbusy') {
      const st = this.soundChannels.get(channel);
      return st && (st.playing || st.queue.items.length > 0) ? 1 : 0;
    }
    if (lower === 'pause' || lower === 'resume') {
      this.audioHost?.stop(channel);
      return 1;
    }
    this.warn(`sound channel ${channel} method ${name}: unsupported`);
    return 0;
  }

  private advanceSoundQueue(channel: number): void {
    const st = this.soundChannels.get(channel);
    if (!st) return;
    st.playing = false;
    st.memberRef = null;
    st.memberName = '';
    st.loop = false;
    while (st.queue.items.length > 0) {
      const next = st.queue.items.shift();
      if (!next) continue;
      const memberVal = next instanceof LPropListClass ? (next.props.get('member') ?? VOID) : next;
      const ref =
        memberVal instanceof LMemberRefClass ? memberVal :
        typeof memberVal === 'number' ? this.getMember(Math.round(memberVal)) :
        typeof memberVal === 'string' ? this.getMemberByName(memberVal) :
        null;
      if (!ref) continue;
      this.playSoundChannel(channel, ref, false);
      return;
    }
  }

  setExternalParams(params: Record<string, string>): void {
    this.externalParamList = Object.entries(params).map(([name, value]) => ({ name, value }));
    this.externalParamByName = new Map(this.externalParamList.map((p) => [p.name.toLowerCase(), p.value]));
  }

  externalParamValue(v: LVal): LVal {
    if (typeof v === 'number') {
      const i = Math.round(v);
      if (i >= 1 && i <= this.externalParamList.length) return this.externalParamList[i - 1].value;
      return VOID;
    }
    if (typeof v === 'string') return this.externalParamByName.get(v.toLowerCase()) ?? VOID;
    if (v instanceof LSymbol) return this.externalParamByName.get(v.name.toLowerCase()) ?? VOID;
    return VOID;
  }

  externalParamCount(): number {
    return this.externalParamList.length;
  }

  externalParamName(n: number): LVal {
    const i = Math.round(n);
    if (i >= 1 && i <= this.externalParamList.length) return this.externalParamList[i - 1].name;
    return VOID;
  }

  setPuppet(channel: number, flag: number): void {
    this.getChannel(channel).puppet = flag;
  }

  setFrameTempo(n: number): void {
    this.frameTempo = Math.max(1, n);
  }


  private addEvent(msg: string, handler: string, obj: LObject): void {
    const key = msg.toLowerCase();
    if (!this.events.has(key)) this.events.set(key, []);
    this.events.get(key)!.push({ handler, obj });
  }

  dispatchMessage(msgName: string, data: LVal): void {
    const lower = msgName.toLowerCase();
    const procs = this.events.get(lower);
    if (procs) {
      for (const p of procs) this.interp.callObjectHandler(p.obj, p.handler, [data]);
    }
    this.log(`message: #${msgName}`);
  }

  registerListener(connId: string, objId: string, msgs: LVal): void {
    if (!this.listeners.has(connId)) this.listeners.set(connId, []);
    this.listeners.get(connId)!.push({ objId, msgs });
    this.log(`listener: ${objId} on ${connId}`);
  }

  registerCommands(connId: string, objId: string, cmds: LVal): void {
    if (!this.commands.has(connId)) this.commands.set(connId, []);
    this.commands.get(connId)!.push({ objId, cmds });
  }

  unregisterListener(connId: string, objId: string): void {
    const list = this.listeners.get(connId);
    if (list) this.listeners.set(connId, list.filter((l) => l.objId !== objId));
  }

  getConnection(id: string): LVal {
    const existing = this.connections.get(id);
    if (existing) return existing;
    const script: Script = {
      name: `connection:${id}`,
      type: 'parent',
      props: [],
      globals: [],
      handlers: [
        {
          name: 'send',
          params: ['me', 'msg', 'params'],
          body: [
            {
              kind: 'return',
              value: {
                kind: 'call',
                callee: { kind: 'ident', name: 'connectionSend' },
                args: [
                  { kind: 'str', value: id },
                  { kind: 'ident', name: 'msg' },
                  { kind: 'ident', name: 'params' },
                ],
              },
            },
          ],
        },
      ],
      source: '',
    };
    const obj = this.interp.makeInstance(script);
    obj.lenient = true;
    obj.props.set('id', id);
    this.connections.set(id, obj);
    return obj;
  }

  connectionExists(id: string): boolean {
    return this.connections.has(id);
  }

  removeConnection(id: string): void {
    this.connections.delete(id);
  }


  private imageOwners = new WeakMap<LImage, Member>();

  imageMutated(img: LImage): void {
    const member = this.imageOwners.get(img);
    if (!member) return;
    if (member.imagePainted) return;
    member.imagePainted = true;
    for (let n = 1; n < this.channels.length; n++) {
      const ch = this.channels[n];
      if (ch.member === member) this.notifyChannel(ch);
    }
  }

  debugCopyOwner(img: unknown): string {
    if (img instanceof LImage) {
      const m = this.imageOwners.get(img);
      if (m) return `${m.castLibNumber}#${m.number} "${m.name}"`;
    }
    return '';
  }

  private memberImage(member: Member): LImage {
    if (!member.image) {
      if (member.kind === 'text' && this.textRasterizer) {
        const img = this.textRasterizer(member);
        if (img) {
          member.image = img;
          this.imageOwners.set(img, member);
          if (member.rect && member.text && !member.textProps?.has('boxtype') && img.height > member.rect.height) {
            member.rect.bottom = member.rect.top + img.height;
          }
          return img;
        }
      }
      if (member.kind === 'bitmap' && member.raw) {
        try {
          const { width, height, rgba, indices } = decodeImage(member.raw, member.palette);
          const img = new LImage(width, height);
          img.data = rgba;
          img.dirty = true;
          img.palette = member.palette;
          img.indices = indices ?? null;
          if (member.paletteTarget) {
            if (indices) img.remapPaletteByIndices(indices, member.paletteTarget);
            else img.remapPalette(member.paletteTarget);
          }
          member.image = img;
          this.imageOwners.set(img, member);
          return img;
        } catch (e) {
          this.warn(`member.image decode failed for ${member.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      member.image = new LImage(member.width, member.height);
      this.imageOwners.set(member.image, member);
    }
    return member.image;
  }

  private memberTextHeight(member: Member): number {
    const base = member.height;
    if (member.kind !== 'text' || member.textProps?.has('boxtype')) return base;
    if (asNum(member.wordWrap ?? 0) === 1 && member.textProps?.has('boxtype')) return base;
    if (!member.text) return base;
    let img = member.image;
    if (!img && this.textRasterizer) {
      try {
        const rasterized = this.textRasterizer(member);
        if (rasterized) {
          img = rasterized;
          member.image = rasterized;
          this.imageOwners.set(rasterized, member);
        }
      } catch {
        img = undefined;
      }
    }
    return img ? img.height : base;
  }

  memberScript(m: LMemberRef): Script | null {
    return this.memberFor(m)?.script ?? null;
  }

  getMemberProp(m: LMemberRef, prop: string): LVal {
    const member = this.memberFor(m);
    if (!member) return VOID;
    const p = prop.toLowerCase();
    switch (p) {
      case 'text':
        return member.kind === 'text' || member.kind === 'script' ? member.text ?? '' : VOID;
      case 'name':
        return member.name;
      case 'linecount':
        return member.kind === 'text' ? (member.text ?? '').split('\n').length : 0;
      case 'number':
        return this.memberGlobalNum(member.castLibNumber, member.number);
      case 'castlibnum':
        return member.castLibNumber;
      case 'type': {
        return new LSymbol(member.kind === 'text' ? 'field' : member.kind);
      }
      case 'regpoint':
      case 'regpointx':
        return p === 'regpointx' ? member.regX : new LPointClass(member.regX, member.regY);
      case 'regpointy':
        return member.regY;
      case 'width':
        return member.width;
      case 'height':
        return this.memberTextHeight(member);
      case 'image':
        return this.memberImage(member);
      case 'media':
        return m;
      case 'color':
        return member.color ?? VOID;
      case 'rect':
        return member.rect ?? new LRectClass(0, 0, member.width, member.height);
      case 'font':
        return member.font ?? '';
      case 'fontsize':
        return member.fontSize ?? 12;
      case 'alignment':
        return member.alignment ?? new LSymbol('left');
      case 'wordwrap':
        return member.wordWrap ?? 1;
      case 'fixedlinespace':
        return member.fixedLineSpace ?? 0;
      case 'fontstyle':
        return member.fontStyle ?? new LList([new LSymbol('plain')]);      case 'filename':
        return member.fileName ?? '';
      case 'duration':
        if (member.kind === 'sound' && member.raw) {
          const ms = mp3DurationMs(member.raw);
          if (ms >= 2000 && ms % 2000 < 200) return ms - (ms % 2000);
          return ms;
        }
        return 0;
      case 'paletteref':
        return member.paletteRef ?? 0;
      default:
        if (member.textProps && member.textProps.has(p)) return member.textProps.get(p)!;
        if (MEMBER_TEXT_PROPS.has(p)) return member.textProps?.get(p) ?? 0;
        this.warn(`member(${member.number}).${prop}: unsupported property`);
        return VOID;
    }
  }

  setMemberProp(m: LMemberRef, prop: string, value: LVal): void {
    const member = this.memberFor(m);
    if (!member) return;
    const p = prop.toLowerCase();
    const invalidateTextImage = (): void => {
      if (member.kind === 'text') member.image = undefined;
    };
    const rebuildChannels = (): void => {
      if (!this.adapter) return;
      for (let n = 1; n < this.channels.length; n++) {
        const ch = this.channels[n];
        if (ch.member === member) this.buildChannelVisual(ch);
      }
    };
    if (p === 'text') {
      member.text = toLingoString(value);
      member.chunkStyles = undefined;
      invalidateTextImage();
      rebuildChannels();
      return;
    }
    if (p === 'color') {
      member.color = value;
      invalidateTextImage();
      rebuildChannels();
      return;
    }
    if (p === 'rect') {
      if (value instanceof LRectClass) member.rect = value;
      invalidateTextImage();
      return;
    }
    if (p === 'font' || p === 'fontsize' || p === 'alignment' || p === 'style') {
      member.font = p === 'font' ? value : member.font;
      member.fontSize = p === 'fontsize' ? value : member.fontSize;
      member.alignment = p === 'alignment' ? value : member.alignment;
      invalidateTextImage();
      rebuildChannels();
      return;
    }
    if (p === 'wordwrap' || p === 'fixedlinespace') {

      member.wordWrap = p === 'wordwrap' ? value : member.wordWrap;
      member.fixedLineSpace = p === 'fixedlinespace' ? value : member.fixedLineSpace;
      invalidateTextImage();
      return;
    }
    if (p === 'fontstyle') {
      member.fontStyle = value;
      invalidateTextImage();
      rebuildChannels();
      return;
    }
    if (p === 'paletteref') {
      member.paletteRef = value;
      if (value instanceof LMemberRefClass) {
        const target = this.memberFor(value);
        if (target?.palette && target.palette.length > 0) {
          if (!member.palette || member.palette.length < 2) {
            member.palette = target.palette;
          } else {
            member.paletteTarget = target.palette;
          }
          this.currentPalette = target.palette;
          if (member.paletteTarget && member.image) {
            if (member.image.indices) member.image.remapPaletteByIndices(member.image.indices, member.paletteTarget);
            else member.image.remapPalette(member.paletteTarget);
          }
          rebuildChannels();
        }
      }
      return;
    }
    if (p === 'palette') {
      if (value instanceof LMemberRefClass) {
        const target = this.memberFor(value);
        if (target?.palette && target.palette.length > 0) {
          if (!member.palette || member.palette.length < 2) {
            member.palette = target.palette;
          } else {
            member.paletteTarget = target.palette;
          }
          member.paletteRef = value;
          this.currentPalette = target.palette;
          if (member.paletteTarget && member.image) {
            if (member.image.indices) member.image.remapPaletteByIndices(member.image.indices, member.paletteTarget);
            else member.image.remapPalette(member.paletteTarget);
          }
        }
      }
      return;
    }
    if (MEMBER_TEXT_PROPS.has(p)) {
      if (!member.textProps) member.textProps = new Map();
      member.textProps.set(p, value);
      invalidateTextImage();
      return;
    }
    if (p === 'image') {
      if (value instanceof LImage) {
        if (!member.image) member.image = new LImage(value.width, value.height);
        else member.image.resize(value.width, value.height);
        member.image.data = new Uint8Array(value.ensure());
        member.image.palette = value.palette;
        member.image.depth = value.depth;
        member.image.dirty = true;
        this.imageOwners.set(member.image, member);
        member.regX = Math.round(value.width / 2);
        member.regY = Math.round(value.height / 2);
      }
      return;
    }
    if (p === 'name') {
      const cast = this.casts[member.castLibNumber - 1];
      if (cast) cast.byName.delete(member.name.toLowerCase());
      const prevName = member.name;
      member.name = toLingoString(value);
      if (cast && member.name) cast.byName.set(member.name.toLowerCase(), member);
      if (!member.name) {
        if (member.image) this.imageOwners.delete(member.image);
        member.image = undefined;
        member.raw = undefined;
      }
      if (this.diagOn() && !member.name && prevName && cast) {
        this.diagLog(`rename-to-EMPTY "${prevName}" (cast#${cast.number} local ${member.number}) — number freed for reuse`);
      }
      return;
    }
    if (p === 'regpoint' || p === 'regpointx' || p === 'regpointy') {
      if (p === 'regpoint' && value instanceof LPointClass) {
        member.regX = value.locH;
        member.regY = value.locV;
      } else if (p === 'regpointx') member.regX = Math.round(asNum(value));
      else if (p === 'regpointy') member.regY = Math.round(asNum(value));
      return;
    }
    if (p === 'media') {
      if (value instanceof LMemberRefClass) {
        const src = this.memberFor(value);
        if (src) {
          if (member.image) this.imageOwners.delete(member.image);
          member.image = undefined;
          member.raw = undefined;
          if (src.kind === 'text' || src.kind === 'script') {
            member.kind = src.kind;
            member.text = src.text;
            member.script = src.script;
          }                  if (src.raw) {
                    member.raw = src.raw;
                    member.palette = src.palette;
                  }
                  else if (src.image) {
            member.image = src.image;
            this.imageOwners.set(src.image, member);
          }
          member.regX = src.regX;
          member.regY = src.regY;
        }
      } else if (value instanceof LImage) {
        member.image = value;
        this.imageOwners.set(value, member);
      }
      return;
    }
    this.warn(`set member(${member.number}).${prop}: unsupported`);
  }

  getSpriteProp(s: LSpriteRef, prop: string): LVal {
    if (s.channel === 0) return VOID;
    const ch = this.getChannel(s.channel);
    const p = prop.toLowerCase();
    switch (p) {
      case 'member':
        return ch.member ? new LMemberRefClass(ch.member.number, ch.member.name, ch.member.kind, ch.member.castLibNumber, this) : VOID;
      case 'castnum':
        return ch.member ? this.memberGlobalNum(ch.member.castLibNumber, ch.member.number) : 0;
      case 'castlibnum':
        return ch.member?.castLibNumber ?? 0;
      case 'loch':
        return ch.locH;
      case 'locv':
        return ch.locV;
      case 'loc':
        return new LPointClass(ch.locH, ch.locV);
      case 'locz':
        return ch.locZ;
      case 'ink':
        return ch.ink;
      case 'blend':
        return ch.blend;
      case 'color':
        return intColor(ch.color);
      case 'bgcolor':
      case 'backcolor':
        return intColor(ch.bgColor);
      case 'forecolor':
        return intColor(ch.foreColor);
      case 'rotation':
        return ch.rotation;
      case 'skew':
        return ch.skew;
      case 'fliph':
        return ch.flipH;
      case 'flipv':
        return ch.flipV;
      case 'scale':
        return ch.scale;
      case 'ilk':
        return new LSymbol('sprite');
      case 'spritenum':
        return s.channel;
      case 'visible':
        return ch.visible;
      case 'width':
        return ch.width ?? ch.member?.width ?? 0;
      case 'height':
        return ch.height ?? ch.member?.height ?? 0;
      case 'stretch':
        return ch.stretch;
      case 'left':
        return ch.left;
      case 'top':
        return ch.top;
      case 'right':
        return ch.right;
      case 'bottom':
        return ch.bottom;
      case 'rect':
        return new LRectClass(ch.left, ch.top, ch.right, ch.bottom);
      case 'scriptinstancelist':
        return ch.scriptInstanceList;
      case 'name':
        return ch.name;
      case 'puppet':
        return ch.puppet;
      case 'id':
        return ch.id;
      default:
        this.warn(`sprite(${s.channel}).${prop}: unsupported property`);
        return VOID;
    }
  }

  setSpriteProp(s: LSpriteRef, prop: string, value: LVal): void {
    if (s.channel === 0) return;
    const ch = this.getChannel(s.channel);
    const p = prop.toLowerCase();
    let changed = true;
    switch (p) {
      case 'member': {
        const member = this.resolveMember(value);
        if (!member) {
          ch.rotation = 0;
          ch.skew = 0;
          ch.flipH = 0;
          ch.flipV = 0;
          ch.color = 0;
          ch.colorSet = false;
          ch.bgColor = 0;
          ch.bgColorIsRgb = false;
        }
        ch.member = member ?? undefined;
        this.notifyChannel(ch);
        return;
      }
      case 'castnum': {
        const n = Math.round(asNum(value));
        ch.castNum = n;
        const member = this.membersByGlobal.get(n) ?? this.memberForStaleSlotNumber(n);
        ch.member = member ?? undefined;
        this.notifyChannel(ch);
        return;
      }
      case 'castlibnum':
        this.warn('sprite.castLibNum: set unsupported');
        return;
      case 'loch':
        ch.locH = asNum(value);
        changed = false;
        break;
      case 'locv':
        ch.locV = asNum(value);
        changed = false;
        break;
      case 'loc': {
        if (value instanceof LPointClass) {
          ch.locH = value.locH;
          ch.locV = value.locV;
        } else if (value instanceof LList) {
          ch.locH = asNum(value.items[0]);
          ch.locV = asNum(value.items[1]);
        }
        changed = false;
        break;
      }
      case 'locz':
        ch.locZ = value === null ? ch.number : asNum(value);
        changed = false;
        break;
      case 'ink': {
        const next = Math.round(asNum(value));
        const rebake = bakeModeForInk(next) !== bakeModeForInk(ch.ink);
        ch.ink = next;
        if (rebake) {
          this.notifyChannel(ch);
          return;
        }
        changed = false;
        break;
      }
      case 'blend':
        ch.blend = Math.round(asNum(value));
        changed = false;
        break;
      case 'visible':
        ch.visible = Math.round(asNum(value));
        changed = false;
        break;
      case 'width':
        ch.width = Math.round(asNum(value));
        changed = false;
        break;
      case 'height':
        ch.height = Math.round(asNum(value));
        changed = false;
        break;
      case 'stretch':
        ch.stretch = Math.round(asNum(value));
        changed = false;
        break;
      case 'scriptinstancelist': {
        ch.scriptInstanceList = value instanceof LList ? value : new LList([value]);
        for (const item of ch.scriptInstanceList.items) {
          if (item instanceof LObjectClass) item.props.set('spriteNum', s.channel);
        }
        changed = false;
        break;
      }
      case 'name':
        ch.name = toLingoString(value);
        changed = false;
        break;
      case 'id': {
        const n = asNum(value);
        if (Number.isFinite(n)) {
          ch.id = Math.round(n);
          changed = false;
        }
        break;
      }
      case 'color':
        ch.color = this.colorToInt(value);
        ch.colorSet = true;
        changed = false;
        break;
      case 'bgcolor':
      case 'backcolor':
        ch.bgColor = this.colorToInt(value);
        ch.bgColorIsRgb = value instanceof LColor || typeof value === 'string';
        changed = ch.bgColorIsRgb && ch.bgColor !== 0xffffff;
        break;
      case 'forecolor':
        ch.foreColor = this.colorToInt(value);
        changed = false;
        break;
      case 'rotation':
        ch.rotation = asNum(value);
        changed = false;
        break;
      case 'skew':
        ch.skew = asNum(value);
        changed = false;
        break;
      case 'fliph':
        ch.flipH = Math.round(asNum(value));
        changed = false;
        break;
      case 'flipv':
        ch.flipV = Math.round(asNum(value));
        changed = false;
        break;
      case 'scale':
        ch.scale = Math.max(0.0001, asNum(value) || 1);
        changed = false;
        break;
      case 'puppet':
        ch.puppet = Math.round(asNum(value));
        changed = false;
        break;
      case 'rect':
        if (value instanceof LRectClass) {
          const regX = ch.member?.regX ?? 0;
          const regY = ch.member?.regY ?? 0;
          ch.locH = value.left + regX;
          ch.locV = value.top + regY;
          ch.width = value.right - value.left;
          ch.height = value.bottom - value.top;
        }
        changed = false;
        break;
      case 'cursor':
        changed = false;
        break;
      case 'editable':
        changed = false;
        break;
      default:
        this.warn(`set sprite(${s.channel}).${prop}: unsupported`);
        return;
    }
    if (changed) this.notifyChannel(ch);
    else this.refreshSprite(ch);
  }

  private colorToInt(v: LVal): number {
    if (v instanceof LColor) return ((v.red & 0xff) << 16) | ((v.green & 0xff) << 8) | (v.blue & 0xff);
    if (typeof v === 'string') {
      const h = hexColor(v);
      if (h) return ((h.red & 0xff) << 16) | ((h.green & 0xff) << 8) | (h.blue & 0xff);
    }
    return Math.round(asNum(v));
  }

  private refreshSprite(ch: Channel): void {
    if (this.visualDirty.has(ch.number)) return;
    this.adapter?.refreshChannel(ch.number);
  }

  private resolveMember(v: LVal): Member | null {
    if (v instanceof LMemberRefClass) return this.memberFor(v);
    if (typeof v === 'number') {
      return this.membersByGlobal.get(Math.round(v)) ?? this.memberForStaleSlotNumber(Math.round(v)) ?? null;
    }
    if (typeof v === 'string') {
      const ref = this.getMemberByName(v);
      return ref ? this.memberFor(ref) : null;
    }
    return null;
  }

  private notifyChannel(ch: Channel): void {
    if (!this.adapter) return;
    this.visualDirty.add(ch.number);
    this.scheduleVisualFlush();
  }

  private scheduleVisualFlush(): void {
    if (this.visualFlushScheduled) return;
    this.visualFlushScheduled = true;
    queueMicrotask(() => {
      this.visualFlushScheduled = false;
      this.flushChannelVisuals();
    });
  }

  flushChannelVisuals(): void {
    if (!this.adapter) return;
    const dirty = Array.from(this.visualDirty);
    this.visualDirty.clear();
    for (const n of dirty) this.buildChannelVisual(this.getChannel(n));
  }

  refreshTextChannels(): void {
    if (!this.adapter) return;
    for (let n = 1; n < this.channels.length; n++) {
      const ch = this.channels[n];
      if (ch.member?.kind === 'text') this.buildChannelVisual(ch);
    }
  }

  private buildChannelVisual(ch: Channel): void {
    if (!this.adapter) return;
    const painted =
      ch.member?.kind === 'bitmap' && !!ch.member.image && ch.member.imagePainted && ch.ink !== 9;
    if (ch.member?.kind === 'bitmap' && ch.member.raw && !painted) {
      const mask = ch.ink === 9 ? this.ink9MaskFor(ch.member) : null;
      this.adapter.setChannel(ch.number, {
        kind: 'bitmap',
        bytes: ch.member.raw,
        regX: ch.member.regX,
        regY: ch.member.regY,
        ...(mask ? { maskBytes: mask.raw, maskRegX: mask.regX, maskRegY: mask.regY } : {}),
        ...(ch.member.paletteTarget ? { remapPalette: ch.member.paletteTarget } : {}),
      });
    } else if (ch.member?.kind === 'bitmap' && ch.member.image) {
      this.adapter.setChannel(ch.number, {
        kind: 'image',
        image: ch.member.image,
        regX: ch.member.regX,
        regY: ch.member.regY,
      });
    } else if (ch.member?.kind === 'text') {
      const m = ch.member;
      const r = m.rect;
      const font = cssFontFor(m.font);
      const fs = fontStyleFlags(m.fontStyle);
      const displayText = (m.text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      this.adapter.setChannel(ch.number, {
        kind: 'text',
        text: displayText,
        fontFamily: font.family,
        fontWeight: fs.bold ? '700' : font.weight,
        fontStyle: fs.italic ? 'italic' : 'normal',
        fontSize: Math.max(1, Math.round(asNum(m.fontSize ?? 0) || 12)),
        color: cssColorFor(m.color),
        bgColor: cssColorFor(textPropOf(m, 'bgcolor')),
        alignment: alignmentName(m.alignment),
        wordWrap: asNum(m.wordWrap ?? 0) === 1,
        width: r ? Math.max(1, Math.round(r.width)) : undefined,
        height: r ? Math.max(1, Math.round(r.height)) : undefined,
        regX: m.regX,
        regY: m.regY,
        ink: ch.ink,
      });
    } else if (ch.member?.kind === 'shape') {
      const s = ch.member.shape;
      this.adapter.setChannel(ch.number, {
        kind: 'shape',
        shape: s ?? { shapeType: 'rect', width: 0, height: 0, color: 0xffffff, backColor: 0, fillType: 1, lineThickness: 0, lineDirection: 5, filled: true, outlineInvisible: false },
        regX: ch.member.regX,
        regY: ch.member.regY,
      });
    } else {
      this.adapter.setChannel(ch.number, null);
    }
    this.adapter.refreshChannel(ch.number);
  }


  getCastLibProp(c: LCastLibRef, prop: string): LVal {
    const cast = this.casts[c.number - 1];
    const p = prop.toLowerCase();
    switch (p) {
      case 'number':
        return c.number;
      case 'name':
        return c.name;
      case 'filename':
        return cast?.fileName ?? '';
      case 'preloadmode':
        return cast?.preloadMode ?? 0;
      case 'members':
        return cast?.members.size ?? 0;
      default:
        this.warn(`castLib(${c.number}).${prop}: unsupported property`);
        return VOID;
    }
  }

  setCastLibProp(c: LCastLibRef, prop: string, value: LVal): void {
    const cast = this.casts[c.number - 1];
    if (!cast) return;
    const p = prop.toLowerCase();
    if (p === 'preloadmode') cast.preloadMode = Math.round(asNum(value));
    else    if (p === 'name') {
      const old = cast.name;
      const newName = toLingoString(value);
      const prior = this.castByName.get(newName);
      if (prior && prior !== cast && this.castList && !this.castList.some((e) => e.name === prior.name)) {
        this.log(`cast slot ${prior.number} superseded by "${newName}" (purging ${prior.members.size} members)`);
        this.clearCastMembers(prior);
        prior.loaded = false;
      }
      cast.name = newName;
      if (old && old !== cast.name) this.castByName.delete(old);
      this.castByName.set(cast.name, cast);
      if (/^empty\s*\d+$/i.test(newName) && cast.loaded) {
        this.clearCastMembers(cast);
        cast.loaded = false;
        for (const [key, entry] of this.castByName) {
          if (entry === cast && key !== cast.name) this.castByName.delete(key);
        }
      }
      if (!cast.loaded) {
        const loader = this.bundleLoader;
        const isDynamicDownload = cast.name.includes('/');
        let manifest = loader?.getCast(cast.name);
        if (!manifest) {
          const bare = this.castNameFromUrl(cast.name);
          if (bare && bare !== cast.name) {
            manifest = loader?.getCast(bare) ?? null;
            if (manifest) {
              const holder = this.castByName.get(bare);
              if (!holder || holder === cast || !holder.loaded) this.castByName.set(bare, cast);
            }
          }
        }
        if (manifest) {
          this.registerCast(loader!, manifest);
          if (!isDynamicDownload) this.indexCast(cast.number);
        }
      }
    } else if (p === 'filename') cast.fileName = toLingoString(value);
    else this.warn(`set castLib(${c.number}).${prop}: unsupported`);
  }

  private clearCastMembers(cast: CastLib): void {
    this.unindexCast(cast.number);
    for (const member of cast.members.values()) {
      this.membersByGlobal.delete(this.memberGlobalNum(cast.number, member.number));
      if (member.name) {
        const hit = this.scriptsByName.get(member.name.toLowerCase());
        if (hit?.member.castLibNumber === cast.number && hit.member.number === member.number) {
          this.scriptsByName.delete(member.name.toLowerCase());
        }
      }
      if (member.script) {
        for (const [name, ref] of this.globalHandlers) {
          if (ref.script === member.script) this.globalHandlers.delete(name);
        }
      }
    }
    cast.members.clear();
    cast.byName.clear();
  }

  getWindowProp(w: LWindowRef, prop: string): LVal {
    const data = this.windows.get(w.id);
    const p = prop.toLowerCase();
    if (p === 'name') return w.id;
    if (p === 'visible') return data ? 1 : 0;
    if (data) {
      const key = prop.toLowerCase();
      if (data.props.has(key)) return data.props.get(key)!;
      if (data.props.has(prop)) return data.props.get(prop)!;
    }
    return VOID;
  }

  setWindowProp(w: LWindowRef, prop: string, value: LVal): void {
    const data = this.windows.get(w.id);
    if (data) data.props.set(prop, value);
  }

  setMemberChunkProp(m: LMemberRef, chunk: string, from: number | undefined, to: number | undefined, prop: string, value: LVal): void {
    const member = this.memberFor(m);
    if (!member || member.kind !== 'text') return;
    const p = prop.toLowerCase();
    if (p !== 'font' && p !== 'fontstyle' && p !== 'color' && p !== 'fontsize') return;
    if (!from || from < 1) return;
    const text = member.text ?? '';
    const lo = Math.round(from);
    const hi = Math.round(to ?? lo);
    let start: number;
    let end: number;
    if (chunk === 'char') {
      start = lo;
      end = hi;
    } else {
      const sep = chunk === 'word' ? /\s+/ : chunk === 'item' ? this.itemDelim : /\r?\n/;
      const parts = text.split(sep);
      const a = Math.max(1, Math.min(lo, parts.length));
      const b = Math.max(a, Math.min(hi, parts.length));
      const join = chunk === 'word' ? ' ' : chunk === 'item' ? this.itemDelim : '\n';
      const seg = parts.slice(a - 1, b).join(join);
      const idx = text.indexOf(seg);
      if (idx < 0) return;
      start = idx + 1;
      end = idx + seg.length;
    }
    start = Math.max(1, start);
    end = Math.min(text.length, Math.max(start, end));
    if (start > text.length) return;
    member.chunkStyles ??= [];
    const field = p === 'fontstyle' ? 'fontStyle' : p === 'fontsize' ? 'fontSize' : p === 'color' ? 'color' : 'font';
    const existing = member.chunkStyles.find((s) => s.from === start && s.to === end);
    if (existing) {
      (existing as Record<string, LVal | undefined>)[field] = value;
      return;
    }
    member.chunkStyles.push({ from: start, to: end, [field]: value } as NonNullable<Member['chunkStyles']>[number]);
  }
}

export type MemberHostApi = {
  getMemberProp(m: LMemberRef, prop: string): LVal;
  setMemberProp(m: LMemberRef, prop: string, value: LVal): void;
  getSpriteProp(s: LSpriteRef, prop: string): LVal;
  setSpriteProp(s: LSpriteRef, prop: string, value: LVal): void;
  getCastLibProp(c: LCastLibRef, prop: string): LVal;
  setCastLibProp(c: LCastLibRef, prop: string, value: LVal): void;
  getWindowProp(w: LWindowRef, prop: string): LVal;
  setWindowProp(w: LWindowRef, prop: string, value: LVal): void;
  setMemberChunkProp(m: LMemberRef, chunk: string, from: number | undefined, to: number | undefined, prop: string, value: LVal): void;
};

export function makeCastManifest(name: string, members: MemberEntry[]): CastManifest {
  return { name, members, fonts: [], fontFiles: [], linkedCasts: [] };
}
