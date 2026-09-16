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
import { composeFilmLoopFrame, filmLoopImage, planFilmLoopComposition, prepareFilmTexture, type FilmLoopPlan, type FilmTexture, type FilmTile } from './filmloop.js';
import { decodeImage } from './pix8.js';
import { decodeMemberMedia, encodeMemberMedia } from './media.js';
import { decodePng } from './png.js';
import { decodeGif } from './gif.js';
import { inverseDirectorTransformPoint } from '../stage/pixi.js';

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
import { bakeModeForInk, inkUsesPixelHitTest } from '../stage/matte.js';
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
  clipToBox?: boolean;
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
  /**
   * The front-most sprite under a stage point, using the SAME pixel rule the
   * adapter uses to route mouse events (see PixiStage.hitTest). `the rollover`
   * and `the clickOn` must be the sprite that actually receives the event — the
   * room's `Room_Interface::validateEvent` compares the two by id (`if
   * call(#getID, sprite(the rollover).scriptInstanceList) = tSprID`) before it
   * runs its own ink-36 white-cover click-through, and a disagreement makes it
   * bail out. Only the stage knows the rendered (baked) pixels, so it answers.
   * When absent the engine falls back to its own sprite rect/alpha test.
   */
  pointerSpriteAt?(x: number, y: number): number;
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

interface MultiuserMessage {
  subject: string;
  content: LVal;
  /** "System" marks an Xtra-originated message (ConnectToNetServer / errors). */
  senderID?: string;
  errorCode?: number;
}

interface MultiuserState {
  socket: { close(): void; send(d: string | Uint8Array): void; readyState: number } | null;
  queue: MultiuserMessage[];
  deliver: MultiuserMessage[];
  buffer: string;
  mode: number;
  logon?: Uint8Array;
  handlerName?: string;
  handlerTarget?: LObjectClass;
  /** Set when the Xtra is driven as a plain HTTP client (HttpCookie) — no socket. */
  http?: { host: string; port: number };
  /** Re-entrancy guard for autoDeliver (the handler can push more messages). */
  delivering?: boolean;
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

/** Resolves a cast-member value to the media bytes the MUS frame should carry
 *  for it (see `DirectorEngine.memberMediaBytes`). A member that cannot be
 *  expressed as media stays a Void value. */
type MusMediaResolver = (v: LVal) => Uint8Array | null;

function musPad(bytes: Uint8Array): Uint8Array {
  return bytes.length % 2 ? concatBytes([bytes, new Uint8Array([0])]) : bytes;
}

/**
 * A MUS value as {type tag, body}. The tag is written ONCE by the enclosing
 * frame or container — the receiving decoder reads the tag and then the body
 * (for a PropList: count + [symbol tag + key + value tag + value]). Emitting
 * the tag a second time inside the body shifted every
 * following field by two bytes, which is what made the photo upload die in the
 * server with `readEvenPaddedString` reading a bogus 131072-byte string.
 *
 * `resolver` turns a cast-member value into media bytes (type 20): the corpus
 * sends `[#image: <member media>, #time: ..., #cs: ...]` for a photo, and the
 * server stores whatever bytes that `image` prop carries
 * (MusConnectionHandler: `getPropAsBytes("image")`).
 */
function musValueParts(v: LVal, resolver?: MusMediaResolver): { tag: number; body: Uint8Array } {
  if (typeof v === 'number') {
    return { tag: MUS_INT, body: i32Bytes(Math.trunc(v)) };
  }
  if (typeof v === 'string') {
    return { tag: MUS_STRING, body: musStr(v) };
  }
  if (v instanceof LSymbol) {
    return { tag: MUS_SYMBOL, body: musStr(v.name) };
  }
  if (v instanceof Uint8Array) {
    return { tag: MUS_MEDIA, body: musPad(concatBytes([u32Bytes(v.length), v])) };
  }
  if (v instanceof LList) {
    const parts: Uint8Array[] = [u32Bytes(v.items.length)];
    for (const item of v.items) parts.push(musValue(item, resolver));
    return { tag: MUS_LIST, body: concatBytes(parts) };
  }
  if (v instanceof LPropListClass) {
    const pairs: [string, LVal][] = [...v.props.entries()];
    const parts: Uint8Array[] = [u32Bytes(pairs.length)];
    for (const [k, val] of pairs) parts.push(musValue(new LSymbol(k), resolver), musValue(val, resolver));
    return { tag: MUS_PROPLIST, body: concatBytes(parts) };
  }
  const media = resolver?.(v);
  if (media) {
    return { tag: MUS_MEDIA, body: musPad(concatBytes([u32Bytes(media.length), media])) };
  }
  return { tag: 0, body: new Uint8Array(0) };
}

function musValue(v: LVal, resolver?: MusMediaResolver): Uint8Array {
  const parts = musValueParts(v, resolver);
  return concatBytes([u16Bytes(parts.tag), parts.body]);
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
      case MUS_MEDIA: {
        // Binary payload (the server answers GETBINDATA with a PropList whose
        // `image` prop is Media, but a whole-frame Media content is legal too):
        // hand the corpus raw bytes so `member.media = <payload>` can consume
        // them instead of an empty string.
        const len = readU32();
        content = body.slice(off, off + len);
        off += len + (len % 2 ? 1 : 0);
        break;
      }
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
            map.set(key, dataTag === MUS_STRING || dataTag === MUS_SYMBOL ? latin1Of(data) : data);
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
  /** When the last key was PRESSED, for `the lastKey`. Director defines that
   *  player property as "the time in ticks (1 tick = 1/60 of a second) since the
   *  last key was pressed" (drmx2004_scripting_ref.txt:33058), i.e. a STOPWATCH
   *  that restarts on every keyDown — never the key itself. Wobble Squabble
   *  (`Paalu_Interface_Class::update`) is the corpus's only reader and gates its
   *  whole input on it: `if the lastKey < the timer then …consume the key…
   *  startTimer()`, with `the timer` reset by `startTimer()` after each action.
   *  Returning a character instead made that gate read `"q" < 4` — a string
   *  compared with a number, which is false — so the game ignored every key.
   *  Initialised to boot time so the "nothing pressed yet" value behaves like
   *  Director's. The character stays on `lastKey` for `the key`. */
  lastKeyAt = Date.now();
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
  private paletteCache = new Map<string, number[][]>();
  private theCache = new Map<string, LVal>();
  private theCacheFrame = -1;

  private getTheCacheKey(head: string, chain: TheSegment[]): string {
    let key = head.toLowerCase();
    for (const seg of chain) {
      key += '|' + seg.name.toLowerCase();
      if (seg.arg) key += ':' + JSON.stringify(seg.arg);
    }
    return key;
  }

  private readPalette(loader: BundleLoader, path: string): number[][] | undefined {
    const cached = this.paletteCache.get(path);
    if (cached !== undefined) return cached;
    const bytes = loader.readBytes(path);
    if (bytes === undefined) return undefined;
    const pal = parsePaletteBytes(bytes);
    this.paletteCache.set(path, pal);
    return pal;
  }
  private goIssued = false;
  clickOnChannel = 0;
  interp: Interpreter;
  adapter: StageAdapter | null;
  private builtins = createBuiltinTable();
  private visualDirty = new Set<number>();
  /** Film-loop members (room water) advanced each tick. */
  private filmLoops = new Set<Member>();
  /** Composed film-loop plan (canvas + per-frame placed tiles) per member. */
  private filmPlans = new Map<Member, FilmLoopPlan>();
  /** Matte-baked frame-member textures, cached per (member, ink). */
  private filmTextures = new Map<Member, FilmTexture>();
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

  /**
   * Restore Director's member names from the cast's own `memberalias.index`.
   *
   * The export tool replaced every space in a member name with an underscore for
   * filesystem safety, which makes the slug ambiguous: `cloud_0_left` really is
   * underscored, while wall art really is `leftwall dimmer_buttn_a_0`. The alias
   * field is Director data and spells the names the way Director did, so it
   * arbitrates: every name it mentions whose underscore slug is a member of this
   * cast is that member's real name.
   *
   * Why Lingo must be able to SEE it: the corpus rebuilds art names from the name
   * it reads back. `hh_room_utils/0017 Object Mover Class::moveItem` swaps the
   * first word of the dragged item's member name to follow the wall —
   * `getmemnum(tProps[#direction] && tName.word[2..tName.word.count])` — so an
   * underscored slug is ONE word, word[2..1] is empty, the lookup is
   * `"rightwall "` (getmemnum 0) and the handler bails at
   * `if tMemNum = 0 then return 0`. The item still renders (direct lookups
   * normalize _ <-> space) but its preview never changes sprite or flip while
   * hovering the other wall.
   *
   * Lookups are unchanged: `byName` keeps the slug key and the engine's
   * name lookups try both spellings, so nothing that asks for the slug breaks.
   */
  private applyAliasMemberNames(cast: CastLib): void {
    const text = cast.byName.get('memberalias.index')?.text;
    if (!text) return;
    for (const line of text.split(/\r\n|\r|\n/)) {
      // The corpus reads these with `the itemDelimiter = "="` and ignores
      // one-char lines; `item 2 to n` keeps any further "=" inside the name.
      if (line.length <= 2) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      for (const side of [line.slice(0, eq), line.slice(eq + 1)]) {
        let name = side.trim();
        if (name.endsWith('*')) name = name.slice(0, -1);
        if (!name.includes(' ')) continue;
        const member = cast.byName.get(name.replaceAll(' ', '_').toLowerCase());
        if (member && member.name !== name) member.directorName = name;
      }
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
      if (entry.frames) member.filmRefs = entry.frames;
      if (entry.sprites) member.filmSpriteRefs = entry.sprites;
      if (entry.loopW !== undefined && entry.loopH !== undefined) {
        member.filmX = entry.loopX ?? 0;
        member.filmY = entry.loopY ?? 0;
        member.filmW = entry.loopW;
        member.filmH = entry.loopH;
      }

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
            const pal = this.readPalette(loader, entry.palRel);
            if (pal !== undefined) member.palette = pal;
          }
          break;
        case 'palette': {
          const pal = this.readPalette(loader, entry.file);
          if (pal !== undefined) {
            member.palette = pal;
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
    this.applyAliasMemberNames(cast);
    this.resolveFilmLoops(cast);
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
    if (this.theCacheFrame !== this.frameCount) {
      this.theCache.clear();
      this.theCacheFrame = this.frameCount;
    }
    this.completeNetRequests();
    this.fireTimeouts();
    this.fireDelays();
    this.fireNetMessages();
    this.pumpObjectManager();
    this.advanceFilmLoops();
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
        const client = toLingoString(args[4] ?? '');
        const st = this.multiuserState.get(obj.id) ?? { socket: null, queue: [], deliver: [], buffer: '', mode };
        st.mode = mode;
        // HttpCookie_Instance_Class carries HTTP over this Xtra: it asks for a
        // raw connection to the web port with the "HTTP_CLASS" client
        // (connectToNetServer("*", "*", server, 80, "HTTP_CLASS", 1)) and then
        // sends a literal "GET /... HTTP/1.1" as the message content. A WebSocket
        // can never open on port 80, so building ws://host:80 left the request
        // unsent and the reply never arrived — the interstitial burned its 15s
        // timeout and roomPrePartFinished() held back ROOM_DIRECTORY, so rooms
        // looked stuck loading. Serve these connections with fetch() instead and
        // feed the raw HTTP reply back through the message queue (handleHttpRequest).
        if (client.toLowerCase().startsWith('http')) {
          st.http = { host, port: Number(port) || 80 };
          st.socket = null;
          this.multiuserState.set(obj.id, st);
          this.pushNetMessage(st, { subject: 'ConnectToNetServer', content: '', senderID: 'System' });
          return 0;
        }
        const url = host && port ? `${wsScheme()}://${host}${port == "0" ? '' : ':' + port}` : this.multiuserUrl ?? '';
        if (!url) {
          this.log(`net: multiuser connect (no ws url): no WebSocket in this environment — stub`);
          return 0;
        }
        if (mode === 0) {
          const logonContent = musValueParts(
            new LList([toLingoString(args[4] ?? ''), toLingoString(args[0] ?? ''), toLingoString(args[1] ?? '')]),
          );
          st.logon = musFrame('Logon', toLingoString(args[0] ?? ''), ['System'], logonContent.tag, logonContent.body);
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
              d.arrayBuffer().then((ab) => this.ingestNetBytes(st, new Uint8Array(ab))).catch(() => { });
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
        if (st?.http) {
          // HttpCookie's request text is the whole payload (handleHttpRequest).
          this.handleHttpRequest(st, toLingoString(args[2] ?? ''));
          return 0;
        }
        if (!st?.socket) return 0;
        const isRawBytesSend = args[0] === 0 && args[1] === 0;
        const from = asNum(args[0] ?? -1);
        const to = asNum(args[1] ?? -1);
        let data: string;
        if (isRawBytesSend) {
          data = toLingoString(args[2] ?? '');
          if (data.length === 1 && data.charCodeAt(0) === 0) {
            try { st.socket.close(); } catch { }
            st.socket = null;
            return 0;
          }
        } else if (st.mode === 0) {
          const subject = toLingoString(args[1] ?? '');
          const contentVal = args[2];
          let contentType = MUS_STRING;
          let contentBytes: Uint8Array;
          if (contentVal instanceof LPropListClass || contentVal instanceof Uint8Array) {
            // Typed content: the tag goes in the frame header ONCE (see
            // musValueParts) — the body must not repeat it.
            const parts = musValueParts(contentVal, (v) => this.memberMediaBytes(v));
            contentType = parts.tag;
            contentBytes = parts.body;
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
          try { st.socket.close(); } catch { }
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
          ['errorCode', m.errorCode ?? 0],
          ['senderID', m.senderID ?? ''],
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
            } catch { }
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

  private pushNetMessage(st: MultiuserState, msg: MultiuserMessage): void {
    st.queue.push(msg);
    this.autoDeliver(st);
  }

  /**
   * The game Connection pumps its messages with checkNetMessages(), but the
   * HttpCookie class never does — the real Multiuser Xtra hands each message to
   * the handler registered by setNetMessageHandler as it arrives. Pump HTTP
   * connections here so the fetch() round-trip actually reaches messageHandler.
   */
  private autoDeliver(st: MultiuserState): void {
    const handlerName = st.handlerName;
    const target = st.handlerTarget;
    if (!handlerName || !target || st.delivering) return;
    st.delivering = true;
    try {
      while (st.queue.length) {
        const msg = st.queue.shift()!;
        st.deliver.push(msg);
        try {
          this.interp.callObjectHandler(target, handlerName, []);
        } catch (err) {
          this.warn(`net handler #${handlerName}: ${err instanceof Error ? err.message : String(err)}`);
        }
        st.deliver.length = 0;
      }
    } finally {
      st.delivering = false;
    }
  }

  /**
   * Serve one HttpCookie request (the connecttonetserver HTTP branch above).
   * `raw` is the complete request HttpCookie_Instance_Class::handleHelloResponse
   * built: a request line, "Header: value" lines, a blank line and an optional
   * body. Browsers have no raw TCP socket, so issue it with fetch() and render
   * the reply in the wire shape HttpCookie_Instance_Class::parseResponse reads —
   * an "HTTP/1.1 <code> <reason>" status line, header lines, a blank line, then
   * the body.
   */
  private handleHttpRequest(st: MultiuserState, raw: string): void {
    const http = st.http;
    if (!http) return;
    const sep = raw.indexOf('\r\n\r\n');
    const head = sep >= 0 ? raw.slice(0, sep) : raw;
    const body = sep >= 0 ? raw.slice(sep + 4) : '';
    const lines = head.split(/\r?\n/);
    const reqMatch = /^\s*(\S+)\s+(\S+)/.exec(lines.shift() ?? '');
    const method = (reqMatch?.[1] ?? 'GET').toUpperCase();
    const path = reqMatch?.[2] ?? '/';
    const authority = http.port === 80 ? http.host : `${http.host}:${http.port}`;
    const url = /^https?:\/\//i.test(path) ? path : `http://${authority}${path.startsWith('/') ? '' : '/'}${path}`;
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const i = line.indexOf(':');
      if (i <= 0) continue;
      const key = line.slice(0, i).trim().toLowerCase();
      // Browser-controlled headers can't be set from script; fetch supplies
      // Host/Connection/Content-Length itself.
      if (key === 'host' || key === 'connection' || key === 'content-length' || key === 'accept-charset') continue;
      headers[key] = line.slice(i + 1).trim();
    }
    if (typeof fetch !== 'function') {
      this.pushNetMessage(st, { subject: '', content: '', senderID: http.host, errorCode: 1 });
      return;
    }
    const init: { method: string; headers?: Record<string, string>; body?: string; redirect: 'manual' } = {
      method,
      redirect: 'manual',
    };
    if (Object.keys(headers).length) init.headers = headers;
    if (body) init.body = body;
    fetch(url, init)
      .then(async (res) => {
        const text = latin1Of(new Uint8Array(await res.arrayBuffer()));
        const headerLines = [`HTTP/1.1 ${res.status} ${res.statusText}`];
        let hasLocation = false;
        res.headers.forEach((value: string, key: string) => {
          const lower = key.toLowerCase();
          // fetch already decoded the body; exposing Transfer-Encoding or
          // Content-Encoding would make parseResponse decode it a second time.
          if (lower === 'transfer-encoding' || lower === 'content-encoding' || lower === 'content-length') return;
          if (lower === 'location') hasLocation = true;
          headerLines.push(`${key}: ${value}`);
        });
        // A #bitmap download is only imported through the redirect branch
        // (handleContentResponse calls preloadNetThing(Location), which lands in
        // importFileInto). A server that answers the ad URL with the image
        // directly would error there and leave the interstitial on its 15s
        // timeout, so point that branch back at the URL we just fetched.
        if (!hasLocation && /^image\//i.test(res.headers.get('content-type') ?? '')) {
          headerLines.push(`Location: ${url}`);
        }
        this.pushNetMessage(st, {
          subject: '',
          content: `${headerLines.join('\r\n')}\r\n\r\n${text}`,
          senderID: http.host,
        });
      })
      .catch((err: unknown) => {
        this.log(`net: http request failed ${url}: ${err instanceof Error ? err.message : String(err)}`);
        this.pushNetMessage(st, { subject: '', content: '', senderID: http.host, errorCode: 1 });
      });
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

  /**
   * Deliver a pointer event to the ONE sprite the pointer owns.
   *
   * Director gives a mouse event to the sprite script of the sprite involved —
   * the front-most active sprite, which is what `the clickOn` reports — NOT to
   * every sprite under the cursor. A click that should reach a sprite underneath
   * is passed EXPLICITLY by the movie: Room Interface's `validateEvent` hides an
   * ink-36 white area and re-calls the event on `sprite(the rollover)`, which is
   * then the sprite below (hh_room/0003). The FUSE window elements rely on the
   * same rule the other way round — `Window Instance Class::buildVisual` wires
   * every element sprite's Event Broker with a VOID procedure
   * (`tsprite.registerProcedure(VOID, me.getID(), VOID)`), so a click on a
   * catalogue window does nothing to the navigator underneath it.
   */
  dispatchPointerEvent(type: 'mouseDown' | 'mouseUp' | 'mouseMove', channel: number, x: number, y: number): void {
    this.mouseH = x;
    this.mouseV = y;
    this._stopEventPending = false;
    if (type === 'mouseDown') {
      this.mouseButton = 'down';
      // A press whose release the page never delivered (the button came up
      // outside the browser window, or the window lost focus mid-press) is
      // still holding its own state: the corpus's Event Broker forwards only
      // `mouseUpOutSide` to Button / DropDown / Scrollbar / Container Hand, so
      // overwriting the press target below would leak it forever and the next
      // clicks on that sprite would be swallowed. Close it as the outside
      // release it is. (A press released on the SAME channel is a normal
      // mouseUp, which the release below already delivers.)
      if (this.mouseDownChannel !== 0 && this.mouseDownChannel !== channel) {
        this.dispatchToChannelHandlers(this.mouseDownChannel, 'mouseupoutside', []);
      }
      this.mouseDownChannel = channel;
      const now = Date.now();
      this.doubleClick = now - this.lastMouseDownTime < 500;
      this.lastMouseDownTime = now;
      this.clickOnChannel = this.hitSpriteAt(x, y);
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

  /**
   * The pointer left the stage. Director has no rollover outside the stage, so
   * a hover left behind keeps the previous sprite's mouseEntered state alive
   * (the room hiliter, the rollover tooltip), and a press the stage can no
   * longer see is closed as an OUTSIDE release — `#mouseUpOutSide`, the event
   * Director and the corpus's own Event Broker model for "released away from
   * the sprite". Returns whether anything was actually unwound.
   */
  pointerLost(): boolean {
    let changed = false;
    if (this.rolloverChannel !== 0) {
      const previous = this.rolloverChannel;
      this.rolloverChannel = 0;
      this.dispatchToChannelHandlers(previous, 'mouseleave', []);
      changed = true;
    }
    if (this.mouseButton === 'down' || this.mouseDownChannel !== 0) {
      this.dispatchPointerEvent('mouseUp', 0, this.mouseH, this.mouseV);
      changed = true;
    }
    return changed;
  }

  /**
   * The window lost focus. The browser hands the keyup for a held modifier to
   * the window that gained focus, so `the shiftDown` / `the optionDown` / the
   * held-key list stayed set (and so did a held press, since no pointerup
   * follows either). The room UI reads exactly those: a shift-click routes to
   * the object-info overlay (Room Interface Class 1016/1058/1099/1119) and an
   * option-click on an active object starts the object mover (1084) — so a
   * stuck modifier silently swallows every later click.
   */
  focusLost(): boolean {
    const changed = this.pointerLost();
    const hadKeys =
      this.shiftDown ||
      this.optionDown ||
      this.controlDown ||
      this.commandDown ||
      this.keyDownActive ||
      this.heldKeys.length > 0;
    this.shiftDown = false;
    this.optionDown = false;
    this.controlDown = false;
    this.commandDown = false;
    this.keyDownActive = false;
    this.heldKeys = [];
    this.keyPressed = '';
    return changed || hadKeys;
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
    // `the lastKey` is the stopwatch behind the last PRESS (see lastKeyAt), so a
    // keyUp must not refresh it: the corpus uses the gate as a one-shot debounce
    // and would otherwise act again on the release of the key it just consumed.
    if (down) this.lastKeyAt = Date.now();
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
    // Per-frame net: traffic drowns the page log; keep it quiet unless the
    // net debug toggle is on (window.SPARK_NET_LOG = 1). Tests run in node
    // (process present) and must keep asserting on net: log lines.
    if (msg.startsWith('net: ')) {
      const isNode = typeof process !== 'undefined' && !!(process as { versions?: { node?: string } }).versions?.node;
      if (!isNode) {
        const w = typeof window !== 'undefined' ? (window as { SPARK_NET_LOG?: unknown }) : null;
        if (!w || !w.SPARK_NET_LOG) return;
      }
    }
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

  getMemberByImage(image: LImage): LMemberRef | null {
    const member = this.imageOwners.get(image);
    if (!member) return null;
    return new LMemberRefClass(member.number, member.name, member.kind, member.castLibNumber, this);
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

  /**
   * The media bytes of a cast-member value, for the MUS serializer — a member
   * inside a propList travels as a Media value carrying its media, which is how
   * `[#image: tmember.media, ...]` reaches the server (`MusConnectionHandler`
   * reads it with `getPropAsBytes("image")` and stores the bytes verbatim).
   */
  memberMediaBytes(v: LVal): Uint8Array | null {
    if (!(v instanceof LMemberRefClass)) return null;
    const member = this.memberFor(v);
    if (!member) return null;
    return this.encodeMemberMediaFor(member);
  }

  encodeMemberMediaFor(member: Member): Uint8Array | null {
    const image = member.image;
    if (image && image.width > 0 && image.height > 0) {
      return encodeMemberMedia({
        width: image.width,
        height: image.height,
        data: image.ensure(),
        // Paletted surfaces travel indexed, as Director's own bitmap media does
        // (one byte per pixel, PackBits-compressed: the server column is a 64 KiB
        // blob and a 161x117 frame is 75 KB as RGBA). See media.ts.
        indices: image.indices ?? null,
        palette: image.palette && image.palette.length > 0 ? image.palette : undefined,
      });
    }
    if (member.raw) {
      try {
        const dec = decodeImage(member.raw, member.palette);
        return encodeMemberMedia({
          width: dec.width,
          height: dec.height,
          data: dec.rgba,
          indices: dec.indices ?? null,
          palette: member.palette,
        });
      } catch {
        return null;
      }
    }
    return null;
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
    const cacheKey = this.getTheCacheKey(head, chain);
    const cached = this.theCache.get(cacheKey);
    if (cached !== undefined) return cached;

    let result: LVal = VOID;
    let cacheable = false;

    if (chain.length === 0) {
      switch (h) {
        case 'frame': result = this.frame; cacheable = true; break;
        case 'frametempo': result = this.frameTempo; cacheable = true; break;
        case 'rollover': result = this.rollover(); break;
        case 'stage': result = this.getStage(); cacheable = true; break;
        case 'stageleft': result = this.stageLeft; cacheable = true; break;
        case 'stageright': result = this.stageRight; cacheable = true; break;
        case 'stagetop': result = this.stageTop; cacheable = true; break;
        case 'stagebottom': result = this.stageBottom; cacheable = true; break;
        case 'tracescript': result = this.traceScript; break;
        case 'tracelogfile': result = this.traceLogFile; break;
        case 'activewindow': result = new LWindowRefClass(this.activeWindow, this); break;
        case 'title': result = ''; cacheable = true; break;
        case 'runmode': result = this.runMode; cacheable = true; break;
        case 'platform': result = 'Windows,32'; cacheable = true; break;
        case 'exitlock': result = 0; cacheable = true; break;
        case 'debugplaybackenabled': result = 0; cacheable = true; break;
        case 'itemdelimiter': result = this.itemDelim; cacheable = true; break;
        case 'moviepath': result = this.moviePath; cacheable = true; break;
        case 'paramcount': result = this.interp.currentArgs().length; break;
        case 'lastchannel': result = this.lastChannel; cacheable = true; break;
        case 'alerthook': result = this.alertHookValue; cacheable = true; break;
        case 'clickloc': result = new LPointClass(0, 0); break;
        case 'clickon': result = this.clickOnChannel; break;
        case 'doubleclick': result = this.doubleClick ? 1 : 0; break;
        case 'mousedown': result = this.mouseButton === 'down' ? 1 : 0; break;
        case 'mouseup': result = this.mouseButton === 'down' ? 0 : 1; break;
        case 'mouseh': result = this.mouseH; break;
        case 'mousev': result = this.mouseV; break;
        case 'mouseloc': result = new LPointClass(this.mouseH, this.mouseV); break;
        case 'keyboardfocussprite': result = this.keyboardFocusSprite; break;
        case 'key': result = this.lastKey; break;
        case 'keypressed': result = this.keyPressed; break;
        case 'keycode': result = this.lastKeyCode; break;
        case 'keydown': result = this.keyDownActive ? 1 : 0; break;
        case 'keyup': result = this.keyDownActive ? 0 : 1; break;
        // Player property, not an alias of `the key`: ticks (1/60 s) SINCE the
        // last key press (drmx2004_scripting_ref.txt:33058). Its siblings
        // (`the lastClick`, `the lastRoll`) are the same shape and unused here.
        case 'lastkey': result = Math.floor((Date.now() - this.lastKeyAt) / (1000 / 60)); break;
        case 'floatprecision': result = this.floatPrecision; cacheable = true; break;
        case 'maxinteger': result = 2147483647; cacheable = true; break;
        // Live input state, like the pointer values above: a DOM key event can
        // change it between two reads in the SAME frame, so it must not be
        // pinned by the per-frame `the` cache (a room click reads the
        // shiftDown/optionDown to pick its click action).
        case 'shiftdown': result = this.shiftDown ? 1 : 0; break;
        case 'optiondown': result = this.optionDown ? 1 : 0; break;
        case 'commanddown': result = this.commandDown ? 1 : 0; break;
        case 'controldown': result = this.controlDown ? 1 : 0; break;
        case 'colordepth': result = 32; cacheable = true; break;
        case 'longtime': result = new Date().toLocaleString('en-US'); break;
        case 'shorttime': result = new Date().toLocaleTimeString('en-US'); break;
        case 'abbrevtime': result = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: 'numeric' }); break;
        case 'longdate': result = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); break;
        case 'shortdate': result = new Date().toLocaleDateString('en-US'); break;
        case 'abbrevdate': result = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); break;
        case 'time': result = new Date().toLocaleTimeString('en-US'); break;
        case 'date': result = new Date().toLocaleDateString('en-US'); break;
        case 'xtralist': {
          const xtras = new LList([
            new LPropListClass(new PropPairs([['name', 'Multiusr'], ['fileName', 'Multiusr.x32']])),
          ]);
          result = xtras;
          break;
        }
        case 'environment': {
          result = new LPropListClass(new PropPairs([
            ['productName', 'Macromedia Director'],
            ['productVersion', '10.1'],
            ['productBuildVersion', 'R31'],
            ['osVersion', 'Windows,32'],
            ['platform', 'Windows,32'],
            ['runMode', 'Plugin'],
            ['colorDepth', 32],
          ]));
          break;
        }
        case 'seconds': result = Math.floor(Date.now() / 1000); break;
        case 'ticks': result = Math.floor(Date.now() / 60); break;
        case 'milliseconds': result = Date.now(); break;
        // TICKS (1/60 s), not milliseconds: `timer` is the Director stopwatch and
        // the corpus converts seconds to it with `* 60` (hh_room_orient/0122
        // `if the timer < pLightSwitchTimer + tTime * 60`) and compares it with
        // `the lastKey`, also ticks. `the milliSeconds` is the ms clock.
        case 'timer': result = Math.floor((Date.now() - this.timerStart) / (1000 / 60)); break;
        default:
          this.warn(`the ${head}: unsupported property`);
          result = VOID;
      }
    } else if (h === 'count' && chain.length === 1) {
      const argE = chain[0].arg ?? { kind: 'ident', name: chain[0].name } as Expr;
      const v = this.evalExprNode(argE);
      if (v instanceof LList) result = v.items.length;
      else if (v instanceof LPropListClass) result = v.props.size;
      else if (typeof v === 'string') result = v.length;
      else result = 0;
    } else if (h === 'chunk') {
      const seg = chain[0];
      if (seg.arg) {
        const v = this.evalExprNode(seg.arg);
        if (typeof v === 'string' && ['char', 'word', 'line', 'item', 'paragraph'].includes(seg.name)) {
          const parts =
            seg.name === 'char' ? v.split('') :
              seg.name === 'word' ? v.split(/\s+/).filter(Boolean) :
                seg.name === 'item' ? v.split(this.itemDelim) :
                  v.split('\n');
          if (parts.length === 0) result = '';
          else if (seg.qualifier === 'last') result = parts[parts.length - 1];
          else if (seg.qualifier === 'first') result = parts[0];
          else if (seg.qualifier === 'middle') result = parts[Math.floor(parts.length / 2)];
          else result = parts[parts.length - 1];
        } else {
          result = VOID;
        }
      } else {
        result = VOID;
      }
    } else if (h === 'number') {
      const seg0 = chain[0];
      const name = seg0.name.toLowerCase();
      if (name === 'castlib' && seg0.arg) {
        const cast = this.getCastLib(this.evalExprNode(seg0.arg));
        result = cast?.number ?? 0;
      } else if (name === 'castlibs') {
        result = this.casts.length;
      } else if (name === 'members') {
        result = this.casts[0]?.members.size ?? 0;
      } else if (name === 'castmembers') {
        const seg1 = chain[1];
        if (seg1 && seg1.name.toLowerCase() === 'castlib' && seg1.arg) {
          const cast = this.getCastLib(this.evalExprNode(seg1.arg));
          if (!cast) result = 0;
          else {
            const c = this.casts[cast.number - 1];
            let max = 0;
            if (c) for (const num of c.members.keys()) if (num > max) max = num;
            result = max;
          }
        } else {
          result = 0;
        }
      } else if (name === 'lines' || name === 'items' || name === 'words' || name === 'chars') {
        const subjectE = chain[1]
          ? (chain[1].arg ?? { kind: 'ident', name: chain[1].name } as Expr)
          : (seg0.arg ?? { kind: 'ident', name: seg0.name } as Expr);
        const v = this.evalExprNode(subjectE);
        if (typeof v === 'string') {
          if (name === 'lines') result = v.split('\n').length;
          else if (name === 'items') result = v.split(this.itemDelim).length;
          else if (name === 'words') result = v.split(/\s+/).filter(Boolean).length;
          else result = v.length;
        } else {
          result = 0;
        }
      } else {
        // Fall through to subject evaluation for arbitrary expressions that may yield a castLibRef
        const subjectE = seg0.arg ?? (chain.length === 1 ? { kind: 'ident', name: seg0.name } as Expr : undefined);
        if (subjectE) {
          const subject = this.evalExprNode(subjectE);
          if (subject instanceof LCastLibRefClass) {
            result = subject.number;
          } else {
            result = VOID;
          }
        } else {
          result = VOID;
        }
      }
    } else {
      const seg0 = chain[0];
      const subjectE = seg0.arg ?? (chain.length === 1 ? { kind: 'ident', name: seg0.name } as Expr : undefined);
      if (subjectE) {
        const subject = this.evalExprNode(subjectE);
        if (subject instanceof LMemberRefClass) {
          result = this.getMemberProp(subject, head);
        } else if (h === 'image' && subject instanceof LMemberRefClass) {
          const member = this.memberFor(subject);
          result = member ? this.memberImage(member) : new LImage(0, 0);
        } else if (subject instanceof LSpriteRefClass) {
          result = this.getSpriteProp(subject, head);
        } else if (subject instanceof LImage) {
          switch (h) {
            case 'rect': result = new LRectClass(0, 0, subject.width, subject.height); break;
            case 'depth': result = subject.depth ?? 32; break;
            case 'width': result = subject.width; break;
            case 'height': result = subject.height; break;
            case 'paletteref': result = subject.paletteRef ?? VOID; break;
            case 'usealpha': result = subject.useAlpha ? 1 : 0; break;
            default: result = VOID;
          }
        } else if (subject instanceof LObjectClass) {
          let cur: LObjectClass | null = subject;
          let hops = 0;
          while (cur) {
            if (cur.script && scriptPropsLower(cur.script).has(h)) {
              if (cur.props.has(head)) { result = cur.props.get(head)!; break; }
              if (cur.props.has(h)) { result = cur.props.get(h)!; break; }
              result = VOID; break;
            }
            if (++hops > 32) break;
            const anc = cur.props.get('ancestor');
            cur = anc instanceof LObjectClass ? anc : null;
          }
          if (result === VOID) {
            if (subject.props.has(head)) result = subject.props.get(head)!;
            else if (subject.props.has(h)) result = subject.props.get(h)!;
            else result = VOID;
          }
        } else if (subject instanceof LPropListClass) {
          const k = subject.props.has(head) ? head : subject.props.has(h) ? h : undefined;
          result = k !== undefined ? subject.props.get(k) ?? VOID : VOID;
        } else if (subject instanceof LCastLibRefClass) {
          if (h === 'number') result = subject.number;
          else if (h === 'name') result = subject.name;
          else result = VOID;
        } else if (subject instanceof LPointClass) {
          if (h === 'loch') result = subject.locH;
          else if (h === 'locv') result = subject.locV;
          else result = VOID;
        } else if (h === 'rollover') {
          result = this.rollover();
        } else {
          result = VOID;
        }
      } else {
        this.warn(`the ${head} of ...: unsupported [${chain.map((s) => s.name + (s.arg ? '(arg)' : '')).join(' <- ')}]`);
        result = VOID;
      }
    }

    if (cacheable) this.theCache.set(cacheKey, result);
    return result;
  }

  setThe(head: string, chain: TheSegment[], value: LVal): void {
    void chain;
    const h = head.toLowerCase();
    const cacheableKeys = new Set([
      'frame', 'frametempo', 'stage', 'stageleft', 'stageright', 'stagetop', 'stagebottom',
      'tracescript', 'tracelogfile', 'title', 'runmode', 'platform', 'exitlock', 'debugplaybackenabled',
      'itemdelimiter', 'moviepath', 'lastchannel', 'alerthook', 'clickon', 'doubleclick',
      'mousedown', 'mouseup', 'mouseh', 'mousev', 'keyboardfocussprite', 'key', 'keypressed',
      'keycode', 'keydown', 'keyup', 'lastkey', 'floatprecision', 'maxinteger', 'shiftdown',
      'optiondown', 'commanddown', 'controldown', 'colordepth', 'castlibs', 'members',
    ]);
    switch (h) {
      case 'frame':
        this.frame = Math.round(asNum(value));
        break;
      case 'frametempo':
        this.frameTempo = Math.round(asNum(value));
        break;
      case 'itemdelimiter':
        this.itemDelim = toLingoString(value);
        break;
      case 'alerthook':
        this.alertHookValue = value;
        break;
      case 'tracescript':
        this.traceScript = asNum(value) === 0 ? 0 : 1;
        break;
      case 'tracelogfile':
        this.traceLogFile = toLingoString(value);
        break;
      case 'activewindow':
        this.activeWindow =
          (value instanceof LWindowRefClass && this.windows.has(value.id))
            ? value.id
            : (typeof value === 'string' && this.windows.has(value))
              ? value
              : 'stage';
        break;
      case 'exitlock':
      case 'debugplaybackenabled':
      case 'selstart':
      case 'selend':
      case 'mouseline':
      case 'mouseh':
      case 'keyboardfocussprite':
        this.keyboardFocusSprite = Math.max(0, Math.round(asNum(value)));
        break;
      case 'mousev':
      case 'title':
        break;
      case 'floatprecision':
        this.floatPrecision = Math.max(0, Math.min(255, Math.round(asNum(value))));
        break;
      case 'shiftdown':
      case 'optiondown':
      case 'commanddown':
      case 'controldown':
        break;
      default:
        this.warn(`set the ${head}: unsupported`);
    }
    // Invalidate cache for settable properties that we cache
    const cacheableSetKeys = new Set([
      'frame', 'frametempo', 'stage', 'stageleft', 'stageright', 'stagetop', 'stagebottom',
      'tracescript', 'tracelogfile', 'title', 'runmode', 'platform', 'exitlock', 'debugplaybackenabled',
      'itemdelimiter', 'moviepath', 'lastchannel', 'alerthook',
      'key', 'keypressed', 'keycode',
      'floatprecision', 'maxinteger',
    ]);
    if (cacheableSetKeys.has(h)) this.theCache.clear();
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

  /**
   * The behavior object carried by a sprite that defines `name` — the target of a
   * `handler(spriteRef, …)` call. A room sprite's channel holds the Event Broker
   * Behavior its element's `#id` was wired to (`Sprite Manager::setEventBroker`,
   * fuse_client/0034:86), and the corpus's room classes call their handlers on it
   * with the sprite as the first argument (hh_room_park/0105, hh_room_pool/0007).
   */
  spriteBehaviorFor(s: LSpriteRef, name: string): LObject | null {
    if (s.channel <= 0 || s.channel >= this.channels.length) return null;
    const list = this.channels[s.channel].scriptInstanceList;
    if (!(list instanceof LList)) return null;
    for (const item of list.items) {
      if (item instanceof LObjectClass && this.interp.hasHandler(item, name)) return item;
    }
    return null;
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
    if (lower === 'registerprocedure' || lower === 'unregisterprocedure' || lower === 'removeprocedure') {
      const handler = args[0] instanceof LSymbol ? args[0].name : toLingoString(args[0] ?? '');
      const objId = toLingoString(args[1] ?? '');
      const msg = args[2] instanceof LSymbol ? args[2].name : toLingoString(args[2] ?? '');
      const obj = this.getObjectById(objId);
      if (lower === 'registerprocedure' && obj && handler && msg) this.addEvent(msg, handler, obj);
      // The sprite's own behavior already received the call — the name is
      // dispatched to the channel's scriptInstanceList at the top of this method,
      // which is where Event Broker `registerProcedure` / `removeProcedure` live
      // (and `removeProcedure` is how the corpus unregisters:
      // hh_shared/0003:112, snowwar 0005:44, hh_cat_new/0045:31). Recognising the
      // name here just keeps it from being reported as `unsupported`.
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
        const obj = this.getObjectById(toLingoString(args[1])) ?? null;
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
    return this.hitSpriteAt(this.mouseH, this.mouseV);
  }

  /**
   * The one hit test behind `the rollover`, `the clickOn` and the event
   * dispatch: the adapter's (it owns the rendered pixels), else the engine's own
   * scan. Keeping the three on one answer is what the corpus expects — the room
   * re-reads `sprite(the rollover)` after hiding the sprite that got the event.
   */
  private hitSpriteAt(x: number, y: number): number {
    const viaStage = this.adapter?.pointerSpriteAt?.(x, y);
    return viaStage === undefined ? this.spriteAtPoint(x, y) : viaStage;
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
      const member = ch.member;
      if (!member || ch.visible !== 1) continue;
      const w = ch.width ?? member.width;
      const h = ch.height ?? member.height;
      if (w <= 0 || h <= 0) continue;
      // Apply inverse transform for rotated/flipped sprites to get correct hit bounds
      let tx = x;
      let ty = y;
      if (ch.rotation !== 0 || ch.skew !== 0 || ch.flipH === 1 || ch.flipV === 1) {
        const inv = inverseDirectorTransformPoint(ch.rotation || 0, ch.skew || 0, ch.flipH, ch.flipV, ch.locH, ch.locV, x, y);
        tx = inv.tx;
        ty = inv.ty;
      }
      const left = ch.locH - (member.regX ?? 0);
      const top = ch.locV - (member.regY ?? 0);
      if (tx < left || tx > left + w || ty < top || ty > top + h) continue;
      hits.push({ ch, z: ch.locZ, n: i });
    }
    let scriptedFallback = 0;
    hits.sort((a, b) => (b.z - a.z) || (b.n - a.n));
    for (const hit of hits) {
      if (scriptedFallback === 0 && hit.ch.isPointerTarget(true)) scriptedFallback = hit.n;
      const w = hit.ch.width ?? hit.ch.member!.width;
      const h = hit.ch.height ?? hit.ch.member!.height;
      if (this.spritePixelAccept(hit.ch, w, h, x, y)) return hit.n;
    }
    // No candidate DISPLAYS anything at the point: a scripted sprite still owns
    // it by its rectangle (see PixiStage.hitTest). The Object Mover's ghost
    // carries its `#mouseDown` proc on the sprite, so a click on a transparent
    // pixel of its art must still reach it or placing silently does nothing.
    // Plain scenery keeps the pixel rule — a transparent hole is click-through.
    return scriptedFallback;
  }

  /**
   * Does the sprite's own pixel at (x, y) accept the pointer?
   *
   * Director's active area is "the portion of the image that is displayed"
   * (drmx2004_scripting_ref.txt:6979, 7027): the pixels a sprite renders as
   * nothing belong to the sprite underneath, whatever produced the hole — an
   * ink's keying, or artwork that simply has an alpha channel (furniture and
   * avatar canvases here are `image(w, h, 32)` compositions, so an alpha test is
   * the whole rule). `visible`/stacking decides which sprites are candidates;
   * this decides which of their pixels are real. Reading the raw member image
   * (rather than the stage's baked buffer) keeps `the rollover` and `the clickOn`
   * computable without a stage, and the two agree on everything the ink bakes do
   * not key. Surface-missing and out-of-bounds coordinates fall back to the
   * rectangle so a drifted mapping can never make a sprite unreachable.
   *
   * This is the rule the room's `validateEvent` relies on: it hides an ink-36
   * white cover (`tSpr.visible = 0`), re-reads `sprite(the rollover)` and expects
   * the sprite BELOW.
   */
  private spritePixelAccept(ch: Channel, w: number, h: number, x: number, y: number): boolean {
    const member = ch.member;
    if (!member) return true;
    const img = this.memberImage(member);
    // Only the inks that can key pixels away (and art with its own alpha) use
    // the displayed-pixel rule; everything else owns its rectangle — see
    // spritePixelHitTest. Keeps this path in step with the stage adapter.
    if (!inkUsesPixelHitTest(ch.ink ?? 0, (img.depth ?? 0) >= 32)) return true;
    const sw = Math.round(img.width);
    const sh = Math.round(img.height);
    if (sw < 1 || sh < 1) return true;
    // Apply inverse transform for rotated/flipped sprites
    let tx = x;
    let ty = y;
    if (ch.rotation !== 0 || ch.skew !== 0 || ch.flipH === 1 || ch.flipV === 1) {
      const inv = inverseDirectorTransformPoint(ch.rotation || 0, ch.skew || 0, ch.flipH, ch.flipV, ch.locH, ch.locV, x, y);
      tx = inv.tx;
      ty = inv.ty;
    }
    const left = ch.locH - (member.regX ?? 0);
    const top = ch.locV - (member.regY ?? 0);
    const px = Math.round((tx - left) * (sw / Math.max(1, w)));
    const py = Math.round((ty - top) * (sh / Math.max(1, h)));
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

  /**
   * Resolve an id (object / connection / listener table) the way Lingo does:
   * ids are symbols or strings and fold case, so `#Info` and `#info` are the
   * same id. Exact match wins; the existing spelling is returned so a write
   * updates the stored entry instead of creating a case twin.
   */
  private idKey<T>(map: Map<string, T>, id: string): string | undefined {
    if (map.has(id)) return id;
    const lower = id.toLowerCase();
    for (const k of map.keys()) {
      if (k.toLowerCase() === lower) return k;
    }
    return undefined;
  }

  getObjectById(id: string): LObject | null {
    const key = this.idKey(this.objects, id);
    return key === undefined ? null : this.objects.get(key) ?? null;
  }

  setObjectById(id: string, obj: LObject): void {
    this.objects.set(this.idKey(this.objects, id) ?? id, obj);
  }

  removeObjectById(id: string): void {
    const key = this.idKey(this.objects, id);
    if (key !== undefined) this.objects.delete(key);
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

  /** Resolve manifest film-loop members: bind their frame members (the
   *  bundler emits filmloop entries from the decompiler's SCVW data; the
   *  original client built these natively at room load). Simple loops seed the
   *  current frame onto the member so the bitmap render path just works;
   *  sprite-composed loops (waterloop) pre-plan their composition canvas and
   *  compose frames on each tick.
   */
  private resolveFilmLoops(cast: CastLib): void {
    for (const loop of cast.members.values()) {
      if (loop.kind !== 'filmloop') continue;
      if (loop.filmRefs && loop.filmRefs.length > 0) {
        const frames = loop.filmRefs
          .map((num) => cast.members.get(num))
          .filter((m): m is Member => m !== undefined && m.kind === 'bitmap');
        if (frames.length > 0) {
          loop.film = frames;
          loop.filmIndex = 0;
          loop.raw = frames[0].raw;
          if (frames[0].palette) loop.palette = frames[0].palette;
          loop.regX = frames[0].regX;
          loop.regY = frames[0].regY;
        }
      }
      if (loop.filmSpriteRefs && loop.filmSpriteRefs.length > 0) {
        const resolved: FilmTile[][] = [];
        for (const frame of loop.filmSpriteRefs) {
          const tiles: FilmTile[] = [];
          for (const s of frame) {
            const m = cast.members.get(s.member);
            if (m && m.kind === 'bitmap' && m.raw) {
              tiles.push({ member: m, x: s.x, y: s.y, w: s.w, h: s.h, ink: s.ink, blend: s.blend });
            }
          }
          if (tiles.length > 0) resolved.push(tiles);
        }
        if (resolved.length > 0) {
          loop.filmSprites = resolved;
          const authored =
            loop.filmW > 0 && loop.filmH > 0
              ? { x: loop.filmX, y: loop.filmY, w: loop.filmW, h: loop.filmH }
              : undefined;
          const plan = planFilmLoopComposition(resolved, authored);
          if (plan) {
            this.filmPlans.set(loop, plan);
            // Film loops always use center registration (reg = display size /
            // 2) — the composed
            // image's center sits on the sprite's loc, not its top-left.
            loop.regX = Math.floor(plan.width / 2);
            loop.regY = Math.floor(plan.height / 2);
            loop.filmW = plan.width;
            loop.filmH = plan.height;
            this.composeFilmLoop(loop, 0);
          }
        }
      }
      if (loop.film || loop.filmSprites) this.filmLoops.add(loop);
    }
  }

  /** Compose one frame of a sprite-composed film loop into `filmImage`. */
  private composeFilmLoop(loop: Member, index: number): void {
    const plan = this.filmPlans.get(loop);
    if (!plan || !loop.filmSprites || loop.filmSprites.length === 0) return;
    for (const t of loop.filmSprites[index] ?? []) {
      if (!this.filmTextures.has(t.member)) {
        const tex = prepareFilmTexture(t.member, t.ink);
        if (tex) this.filmTextures.set(t.member, tex);
      }
    }
    const pixels = composeFilmLoopFrame(plan, index, this.filmTextures, loop.filmImage?.data ?? undefined);
    loop.filmImage = filmLoopImage(pixels, plan.width, plan.height, loop.filmImage);
    loop.image = undefined;
  }

  /** Advance every film loop one frame and refresh the channels showing it. */
  private advanceFilmLoops(): void {
    if (this.filmLoops.size === 0) return;
    let touched = false;
    for (const loop of this.filmLoops) {
      if (loop.filmSprites && loop.filmSprites.length > 0) {
        loop.filmIndex = (loop.filmIndex + 1) % loop.filmSprites.length;
        this.composeFilmLoop(loop, loop.filmIndex);
        touched = true;
        continue;
      }
      if (!loop.film || loop.film.length === 0) continue;
      loop.filmIndex = (loop.filmIndex + 1) % loop.film.length;
      const frame = loop.film[loop.filmIndex];
      loop.raw = frame.raw;
      if (frame.palette) loop.palette = frame.palette;
      loop.regX = frame.regX;
      loop.regY = frame.regY;
      loop.image = undefined; // drop any cached rasterized surface
      touched = true;
    }
    if (!touched) return;
    for (let n = 1; n < this.channels.length; n++) {
      const ch = this.channels[n];
      if (ch.member && this.filmLoops.has(ch.member)) this.notifyChannel(ch);
    }
  }

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
    // Prune completed entries to keep the map from accumulating large response
    // bodies (external_texts.txt is 227KB; cast files are larger) indefinitely.
    // The corpus polls netDone/netTextResult within a handful of frames of
    // completion, so entries older than ~120 frames are safe to drop.  Keep the
    // most recent 64 done entries as a safety margin.
    if (this.net.size > 128) {
      const toDelete: number[] = [];
      for (const [id, req] of this.net) {
        if (req.done) toDelete.push(id);
        if (this.net.size - toDelete.length <= 64) break;
      }
      for (const id of toDelete) {
        const req = this.net.get(id);
        if (req) { req.text = ''; req.bytes = undefined; }
        this.net.delete(id);
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
      for (const p of procs) this.interp.callObjectHandler(p.obj, p.handler, Array.isArray(data) ? data : [data]);
    }
    this.log(`message: #${msgName}`);
  }

  registerListener(connId: string, objId: string, msgs: LVal): void {
    const key = this.idKey(this.listeners, connId) ?? connId;
    if (!this.listeners.has(key)) this.listeners.set(key, []);
    this.listeners.get(key)!.push({ objId, msgs });
    this.log(`listener: ${objId} on ${connId}`);
  }

  registerCommands(connId: string, objId: string, cmds: LVal): void {
    const key = this.idKey(this.commands, connId) ?? connId;
    if (!this.commands.has(key)) this.commands.set(key, []);
    this.commands.get(key)!.push({ objId, cmds });
  }

  unregisterListener(connId: string, objId: string): void {
    const key = this.idKey(this.listeners, connId);
    const list = key === undefined ? undefined : this.listeners.get(key);
    if (key !== undefined && list) this.listeners.set(key, list.filter((l) => l.objId !== objId));
  }

  getConnection(id: string): LVal {
    const existingKey = this.idKey(this.connections, id);
    const existing = existingKey === undefined ? undefined : this.connections.get(existingKey);
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
    return this.idKey(this.connections, id) !== undefined;
  }

  removeConnection(id: string): void {
    const key = this.idKey(this.connections, id);
    if (key !== undefined) this.connections.delete(key);
  }


  private imageOwners = new WeakMap<LImage, Member>();

  imageMutated(img: LImage): void {
    // The palette indices the image was DECODED with stop describing its
    // pixels the moment the movie writes into it (see LImage.indicesStale), so
    // every index-based rule has to fall back to the colours actually present.
    img.indicesStale = true;
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
          this.adjustTextRect(member, img);
          return img;
        }
      }
      if ((member.kind === 'bitmap' || member.kind === 'filmloop') && member.raw) {
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
    } else {
      // Cached raster: re-assert adjust-to-fit here too, not just when the
      // raster is first built. Writer::fakeAlphaRender reads pMember.height
      // (this raster) and then feeds `pMember.rect` to copyPixels as the
      // SOURCE rect of an identically-sized mask. If the rect is shorter than
      // the raster, copyPixels RESAMPLES the glyphs — its
      // `syRow = sy0 + trunc(fy * srcH / destH)` turns 4 source rows into
      // `x3,x3,x3,x2` destination row runs — and the text renders vertically
      // stretched. That is the navigator room-description report (the desc
      // writer's rect is a `rect(0,0,W,0)` hint, so it must never stay behind
      // the raster): the header writer is unaffected only because its render
      // path rebuilds the rect from pMember.height every call.
      this.adjustTextRect(member, member.image);
    }
    return member.image;
  }

  // Director adjust-to-fit (the `#adjust` boxType): an auto-size text member's
  // box IS its rendered content, so the rect has to track the raster in BOTH
  // directions. Growing alone is not enough. A Writer scratch member is reused
  // for every string it renders: the navigator defines
  // `[#rect: rect(0, 0, tWidth, 0)]` once and then calls `render()` per room,
  // and `Writer::define`/`render` only re-assign the rect when the WIDTH
  // changes — so after a tall description the box stays tall for the next,
  // shorter one. fakeAlphaRender then copies through mismatched rects
  //   tFakeAlpha = image(pMember.width, pMember.height, 8)      (11 rows)
  //   copyPixels(pMember.image, pMember.rect, tFakeAlpha.rect)  (dest 31)
  // and copyPixels RESAMPLES instead of copying: its
  // `syRow = sy0 + trunc(fy * srcH / destH)` smears the 11-row source over the
  // 31-row destination as x3,x3,x3,x2 row runs — the "navigator description /
  // IM message glyphs are doubled and stretched" report. Director never lets
  // the box and the raster disagree, so neither may we.
  private adjustTextRect(member: Member, img: LImage): void {
    if (member.kind !== 'text' || !member.rect || !member.text) return;
    if (member.textProps?.has('boxtype')) return;
    if (member.rect.height !== img.height) member.rect.bottom = member.rect.top + img.height;
  }

  private memberTextHeight(member: Member): number {
    const base = member.height;
    if (member.kind !== 'text' || member.textProps?.has('boxtype')) return base;
    if (!member.text) return base;
    let img = member.image;
    if (!img && this.textRasterizer) {
      try { img = this.memberImage(member); } catch { img = undefined; }
    } else if (img) {
      // Cached raster: re-assert adjust-to-fit here too, not just when the
      // raster is first built. Writer::fakeAlphaRender reads pMember.height
      // BEFORE pMember.rect; if the rect is shorter than the cached raster,
      // copyPixels RESAMPLES the glyphs instead of copying them 1:1.
      this.adjustTextRect(member, img);
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
        // `directorName` is the name Director had, recovered from the cast's
        // memberalias.index when the bundle slug had to underscore a space (see
        // applyAliasMemberNames); the corpus rebuilds art names from this.
        return member.directorName ?? member.name;
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
      case 'scripttext':
        // Director: a script member's source, EMPTY for every other kind —
        // including a bitmap with no behaviour attached. Only one place in the
        // corpus reads this, and it is a guard, not a display:
        // `hh_photo/0003 Photo Component Class::binaryDataReceived` does
        // `if pPhotoMember.type <> #bitmap or pPhotoMember.scriptText <> EMPTY`
        // to reject a media blob that is really a script member, then `erase()`s
        // the member and bails. Answering VOID made VOID <> EMPTY true for
        // EVERY photo, so the window kept its photo_placeholder and the decoded
        // picture was never assigned to the sprite.
        return member.kind === 'script' ? member.text ?? '' : '';
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
        return member.fontStyle ?? new LList([new LSymbol('plain')]); case 'filename':
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
    if (p === 'scripttext') {
      // Only script members carry text; Director errors on anything else and
      // the corpus relies on that (`scriptText = EMPTY` clears a behaviour).
      if (member.kind !== 'script') {
        this.warn(`member(${member.number}).scriptText = : not a script member`);
        return;
      }
      const source = toLingoString(value);
      const prior = member.script;
      const script = parseLingo(source);
      script.name = member.name;
      script.type = prior?.type ?? 'parent';
      member.text = source;
      member.script = script;
      this.scriptsByName.set(member.name.toLowerCase(), { script, member });
      for (const [name, ref] of this.globalHandlers) {
        if (ref.script === prior) this.globalHandlers.delete(name);
      }
      if (script.type !== 'parent') {
        for (const h of script.handlers) this.globalHandlers.set(h.name.toLowerCase(), { script, handler: h });
      }
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
      if (value instanceof Uint8Array) {
        // Media arriving from the server (the photo binary payload read back
        // with `retrieveBinaryData`). Decoding it makes the member displayable
        // again, palette included — `countCS` re-hashes the result against the
        // checksum the sender stored, and `getPixel().paletteIndex` needs the
        // same table to land on the same indices.
        //
        // The camera's table is the decode's fallback palette, not just the
        // member's afterwards. A real photo's media is a BARE INDEX RASTER with
        // no palette of its own (Director keeps it on the member/element), so
        // `rgbaFromIndices` had nothing to look the raster up in and fell back
        // to `grey = index` — the identity ramp. That is the opposite of
        // `#grayscale`, whose index 0 is WHITE (the hh_photo `.pal` sidecars
        // 0x0012/0x0020 all start `255 255 255 ... 0 0 0`, i.e. the table is
        // `255 - index`), so every photo previewed
        // as a negative while the palette attached next to it said otherwise.
        // The stage bakes from `image.data` (bakeSurface -> img.ensure()), so
        // the RGBA and the table have to be built through the SAME ramp.
        const blob = decodeMemberMedia(value, GRAYSCALE_PALETTE);
        if (blob) {
          if (member.image) this.imageOwners.delete(member.image);
          // A real photo's media is a bare index raster with no palette of its
          // own (Director keeps it on the member/element), and the corpus paints
          // it through the camera's palette — `#palette: #grayscale` on both
          // cam_display and photo_picture. Without it the indices would have no
          // colours and the preview would be black.
          const table = blob.palette ?? GRAYSCALE_PALETTE;
          const img = new LImage(blob.width, blob.height);
          img.data = new Uint8Array(blob.rgba);
          img.palette = table;
          img.indices = blob.indices ?? null;
          img.depth = blob.indices ? 8 : 32;
          img.dirty = true;
          member.kind = 'bitmap';
          member.image = img;
          member.imagePainted = true;
          member.raw = undefined;
          member.palette = table;
          this.imageOwners.set(img, member);
          for (let n = 1; n < this.channels.length; n++) {
            const ch = this.channels[n];
            if (ch.member === member) this.buildChannelVisual(ch);
          }
        } else {
          this.warn(`set member(${member.number}).media: unrecognised media payload (${value.length}B)`);
        }
        return;
      }
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
          } if (src.raw) {
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
      case 'membernum':
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
        return this.spriteBgColor(ch);
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
          ch.bgColorIndex = null;
        }
        ch.member = member ?? undefined;
        // Assigning a member re-derives the sprite's display size from the
        // member. A recycled sprite may carry a stale explicit width/height
        // (the Sprite Manager's releaseSprite sets rect(0,0,1,1)), so drop
        // the override and render at the member's natural size — code that
        // wants a stretch sets width/height *after* the member (Director
        // semantics).
        if (member?.kind === 'bitmap') {
          ch.width = undefined;
          ch.height = undefined;
        }
        this.notifyChannel(ch);
        return;
      }
      case 'castnum':
      case 'membernum': {
        const n = Math.round(asNum(value));
        const member = this.membersByGlobal.get(n) ?? this.memberForStaleSlotNumber(n);
        // Director treats writing a sprite's own cast member back to it as a
        // no-op: nothing that is drawn can have changed. The corpus leans on
        // that. Avatar Effect Class::setMember rewrites `tsprite.castNum` on
        // EVERY frame — its #frm list has 16 entries, so the frame counter always
        // advances and tChanges stays 1 for the whole life of the effect — and
        // for the fx.3 UFO all 16 frames resolve to the same member name, so the
        // lookup result never actually changes (measured live: 24 identical
        // writes a second to the effect's extra sprite). Rebuilding the channel
        // visual for each one destroyed and recreated the pixi node and its
        // texture every frame, which is pure churn for a sprite that cannot have
        // changed. A genuinely different number — including `castNum = 0` to
        // clear a sprite whose member was set through `sprite.member` — still
        // notifies, since the resolved member differs.
        if (ch.castNum === n && ch.member === (member ?? undefined)) return;
        ch.castNum = n;
        ch.member = member ?? undefined;
        // castNum deliberately keeps geometry (furniture sets rotation/skew
        // before castNum) — the #member path above is where a recycled sprite
        // re-adopts the member's natural size.
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
        // Same bake family (e.g. 41 -> 41): the bake buffer is mutated in
        // place but nothing would re-upload it to the GPU — mark the member
        // image dirty so syncChannelImages re-bakes and calls update().
        if (ch.member?.image) ch.member.image.dirty = true;
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
        if (ch.member?.image) ch.member.image.dirty = true;
        changed = false;
        break;
      case 'bgcolor':
      case 'backcolor': {
        // A JS number is a Director palette index (0-255): stored unresolved
        // and resolved against the sprite member's own bitmap palette at tint
        // time. rgb()/strings tint
        // directly, as before.
        const raw = Math.round(asNum(value));
        if (typeof value === 'number' && raw >= 0 && raw <= 255) {
          ch.bgColorIndex = raw;
          ch.bgColor = raw;
          ch.bgColorIsRgb = false;
        } else if (value instanceof LColor && value.paletteIndex !== undefined) {
          // A colour that still carries the index it came from — another
          // sprite's bgColor (the Object Mover's copy), a pixel of a palette
          // member, `paletteIndex(n)` — STAYS an index, so it keeps resolving
          // against the member's own palette at tint time instead of being
          // frozen into the RGB it happened to have on the source member.
          ch.bgColorIndex = value.paletteIndex;
          ch.bgColor = value.paletteIndex;
          ch.bgColorIsRgb = false;
        } else {
          ch.bgColorIndex = null;
          ch.bgColor = this.colorToInt(value);
          ch.bgColorIsRgb = value instanceof LColor || typeof value === 'string';
        }
        if (ch.member?.image) ch.member.image.dirty = true;
        changed = this.bgTintForChannel(ch) !== null;
        break;
      }
      case 'forecolor': {
        // Like backColor: a bare number is a Director palette INDEX (resolved
        // against the source member's own palette at render time), while
        // rgb()/string is a real colour. The avatar colour effects set
        // `foreColor = rgb("#00FF00")`; `resetSpriteColors` sets the default
        // `foreColor = 255` (index, black) which must stay inert.
        const raw = typeof value === 'number' ? Math.round(value) : NaN;
        if (!Number.isNaN(raw) && raw >= 0 && raw <= 255) {
          ch.foreColorIndex = raw;
          ch.foreColor = raw;
          ch.foreColorIsRgb = false;
        } else {
          ch.foreColorIndex = null;
          ch.foreColor = this.colorToInt(value);
          ch.foreColorIsRgb = value instanceof LColor || typeof value === 'string';
        }
        changed = false;
        break;
      }
      case 'rotation':
        ch.rotation = asNum(value);
        break;
      case 'skew':
        ch.skew = asNum(value);
        break;
      case 'fliph':
        ch.flipH = Math.round(asNum(value));
        break;
      case 'flipv':
        ch.flipV = Math.round(asNum(value));
        break;
      case 'scale':
        ch.scale = Math.max(0.0001, asNum(value) || 1);
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

  /**
   * Resolve a channel's bg tint for the render path: an indexed backColor
   * resolves against the sprite member's OWN bitmap palette; white (or no
   * palette) means no filtering.
   */
  /**
   * `sprite.bgColor`/`backColor` as Director reports it.
   *
   * A background set from a BARE NUMBER is a palette index (`sprite.backColor =
   * random(150) + 20`, hh_entry_se's Entry Car) and a background nobody set is
   * the Director DEFAULT — which is an index too, 0. Both are reported as the
   * indexed colour they resolve to with the index still attached, exactly like
   * `image.getPixel()` colours and `paletteIndex(n)`; only an `rgb()` /
   * `"#RRGGBB"` assignment is a plain colour. Reporting the default as
   * `rgb(0, 0, 0)` made every Lingo COPY lose the form, and the Object Mover is
   * exactly that copy: `tSpr.bgColor = tOrigSprList[i].bgColor`
   * (hh_room_utils/0017) stored an explicit black on the sprite it ghosts the
   * item with, so ink 36 keyed the item's own black art out while the background
   * the ink is meant to remove — its palette entry 0 — stayed standing.
   */
  private spriteBgColor(ch: Channel): LColor {
    const index = ch.bgColorIsRgb ? null : ch.bgColorIndex ?? 0;
    if (index === null) return intColor(ch.bgColor);
    const entry = ch.member?.palette?.[index];
    const col = entry ? new LColor(entry[0], entry[1], entry[2]) : intColor(ch.bgColor);
    col.paletteIndex = index;
    return col;
  }

  bgTintForChannel(ch: Channel): number | null {
    if (ch.bgColorIsRgb) {
      if (ch.bgColor === 0xffffff) return null;
      if (ch.bgColor === 0 && ch.ink !== 41) return null;
      return ch.bgColor;
    }
    if (ch.bgColorIndex != null) {
      // Index 0 is the DEFAULT background (the corpus resets with it:
      // `pSprite.backColor = 0`, Entry Car), so it filters nothing — the same
      // "no colour" a sprite that never had a background reports (index null).
      // Keeping the two identical matters because Lingo COPIES the background:
      // the Object Mover writes a sprite's default onto the sprite it ghosts an
      // item with, and a copy that suddenly resolved palette entry 0 as a tint
      // would colourize the preview the placed item never is.
      if (ch.bgColorIndex === 0) return null;
      const pal = ch.member?.palette;
      if (pal && pal[ch.bgColorIndex]) {
        const [r, g, b] = pal[ch.bgColorIndex];
        const rgb = ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
        return rgb === 0xffffff ? null : rgb;
      }
      if (ch.bgColorIndex === 255) return 0x000000;
      return null;
    }
    return null;
  }

  /**
   * The sprite foreColor resolved to an RGB colour, or null when it carries no
   * colour for the render path (unset, or a palette index that resolves to
   * black — the corpus default `sprite.foreColor = 255`). Only an explicit
   * rgb()/string assignment produces a colour, so engine code that keeps the
   * Director default never tints anything.
   */
  foreColorRgbForChannel(ch: Channel): number | null {
    if (ch.foreColorIsRgb) return ch.foreColor === 0x000000 ? null : ch.foreColor;
    if (ch.foreColorIndex != null) {
      const pal = ch.member?.palette;
      if (pal && pal[ch.foreColorIndex]) {
        const [r, g, b] = pal[ch.foreColorIndex];
        const rgb = ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
        return rgb === 0x000000 ? null : rgb;
      }
      return null;
    }
    return null;
  }

  /**
   * The fg→bg duotone a channel's ink asks for, or null when it is the identity.
   *
   * Both users of this are authoured as "remap every pixel through a
   * foreground→background ramp" (`mix(src, fg, bg)` per channel, black→fg and
   * white→bg — the same maths `tintSpriteDarken` runs):
   *
   *  - ink 41 (Darken) with `sprite.color` (foreColor) and backColor. The
   *    Director defaults are fg=black/bg=white, which are the identity. The
   *    respect flash sets ONLY `sprite.color`
   *    (`tsprite.color = color(#rgb, 247,204,59)`) and leaves backColor at
   *    `paletteIndex(0)` (white), so gating this on a non-white backColor
   *    suppressed the whole flash. A set fg therefore has to run the duotone
   *    with bg defaulting to white.
   *
   *  - inks 4/8/9 with an EXPLICIT RGB foreColor: the avatar colour effects.
   *    `hh_human/texts/0041_text_fx.11.txt` (X-Ray) is just
   *    `human_sprite_props/[ink: 8, bgcolor: "#007700", forecolor: "#00FF00"]`
   *    and ships no bitmaps at all, so that ramp IS the effect: black→#00FF00,
   *    white→#007700, which reads as the green x-ray look. fx.12 (Ice) is the
   *    same shape — `[ink: 4, bgcolor: "#CCFFFF", forecolor: "#66CCFF"]`, the
   *    documented "Not copy" ink, which replaces the body sprite's `resetSpriteColors`
   *    ink 36 and would otherwise leave the canvas's opaque white block on screen.
   */
  duotoneForChannel(ch: Channel): { fg: number; bg: number } | null {
    const bg = this.bgTintForChannel(ch) ?? 0xffffff;
    if (ch.ink === 41) {
      const fg = ch.colorSet ? ch.color : 0x000000;
      if (bg === 0xffffff && fg === 0x000000) return null;
      return { fg, bg };
    }
    if (ch.ink === 4 || ch.ink === 8 || ch.ink === 9) {
      const fg = this.foreColorRgbForChannel(ch);
      if (fg === null) return null;
      return { fg, bg };
    }
    return null;
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
    const member = ch.member;
    if (member && member.kind === 'filmloop' && member.filmSprites && member.filmSprites.length > 0) {
      // Sprite-composed film loop: the current frame is pre-composited into
      // filmImage (per-tile matte baked in, loop-sized RGBA with alpha), so it
      // renders as an image and the stage transform scales it to the element
      // rect.
      if (member.filmImage) {
        this.adapter.setChannel(ch.number, {
          kind: 'image',
          image: member.filmImage,
          regX: member.regX,
          regY: member.regY,
        });
      } else {
        this.adapter.setChannel(ch.number, null);
      }
      this.adapter.refreshChannel(ch.number);
      return;
    }
    // Simple film loops render their current frame; the frame data is
    // live-copied onto the loop member, so bitmap handling applies verbatim.
    if (member && (member.kind === 'bitmap' || member.kind === 'filmloop')) {
      const painted = !!member.image && member.imagePainted && ch.ink !== 9;
      if (member.raw && !painted) {
        const mask = ch.ink === 9 ? this.ink9MaskFor(member) : null;
        this.adapter.setChannel(ch.number, {
          kind: 'bitmap',
          bytes: member.raw,
          regX: member.regX,
          regY: member.regY,
          ...(mask ? { maskBytes: mask.raw, maskRegX: mask.regX, maskRegY: mask.regY } : {}),
          ...(member.paletteTarget ? { remapPalette: member.paletteTarget } : {}),
        });
      } else if (member.image) {
        this.adapter.setChannel(ch.number, {
          kind: 'image',
          image: member.image,
          regX: member.regX,
          regY: member.regY,
        });
      } else {
        this.adapter.setChannel(ch.number, null);
      }
      this.adapter.refreshChannel(ch.number);
      return;
    }
    if (ch.member?.kind === 'text') {
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
        // boxType present (any value incl. #limit/#fixed/#adjust) = a FIXED
        // box: live text must clip at the rect like the rasterizer does
        // (autoSize is boxType-unset only). #limit fields (chat input,
        // tooltips) are cut off at the box edge.
        clipToBox: !!m.textProps?.has('boxtype'),
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
    else if (p === 'name') {
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
      // Clean up any film textures cached for this member.
      this.filmTextures.delete(member);
      this.filmPlans.delete(member);
      // Clean up the image owner reference so the LImage can be GC'd.
      if (member.image) this.imageOwners.delete(member.image);
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
    // Dispose any channels that belonged to this cast so their
    // textures and sprites are freed — without this, leaving a
    // room leaks every sprite's GPU texture (the "landscape climb"
    // symptom: new windows keep allocating textures on top of old
    // ones that were never destroyed).
    for (let n = 1; n < this.channels.length; n++) {
      const ch = this.channels[n];
      if (ch.member && ch.member.castLibNumber === cast.number) {
        this.adapter?.setChannel(ch.number, null);
      }
    }
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
