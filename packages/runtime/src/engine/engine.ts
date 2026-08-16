import type { Expr, Handler, Script, TheSegment } from '../lingo/ast.js';
import { Env, Interpreter, NO_GLOBALS, scriptPropsLower, type GlobalHandlerRef, type InterpreterHost } from '../lingo/interpreter.js';
import { createBuiltinTable, type BuiltinBackend, type BuiltinFn } from '../lingo/builtins.js';
import { parseLingo } from '../lingo/parser.js';
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
import { decodePng } from './png.js';
import { decodeGif } from './gif.js';

/** Director's built-in "Grayscale" palette: index 0 = WHITE descending to
 *  black at 255 (Mac convention, matching DirPlayer). Window layouts use
 *  `#palette: #grayscale` for button/loading art; the PC convention (index 0 =
 *  black) inverted the art and left the ink-8 matte with no white to key. */
const GRAYSCALE_PALETTE: number[][] = Array.from({ length: 256 }, (_, i) => [255 - i, 255 - i, 255 - i]);
import { bakeModeForInk } from '../stage/matte.js';
import { mp3DurationMs } from './mp3.js';
import type { MemberKind } from '../bundle/types.js';
import { Channel } from './sprites.js';
import type { PersistWorkerLike, PersistWorkerMsg } from '../worker/persist.js';

/** Shared 2D context for text measurement (created lazily in the browser). */
let measureCtx: CanvasRenderingContext2D | null = null;  /** What a channel shows on stage; the adapter turns this into pixels. */
export interface ChannelVisual {
  kind: 'bitmap' | 'text' | 'image' | 'shape';
  bytes?: Uint8Array;
  /** Pattern-palette remap for a bitmap channel (`member.paletteRef`): the
   *  decoded pixels are recolored by palette index through this table before
   *  the ink bake/tint — room wall/floor patterns (Private Room Engine
   *  setWallPaper/setFloorPattern). The member's OWN palette (sidecar .pal)
   *  is the index source for older RGBA exports; indexed PNGs carry the
   *  indices directly. */
  remapPalette?: number[][];
  text?: string;
  /** Runtime-painted surface for bitmap members created in-movie (no `raw`):
   *  the Loading Bar / window element buffers draw into `member.image`, so the
   *  adapter uploads this LImage to the canvas (see PixiStage.syncChannelImages). */
  image?: LImage;
  /** Parsed Director shape definition (skyleft/skyright/box — the entry scene's
   *  solid-fill rects/ovals). The stage draws it with the sprite's color
   *  (buildVisual sets `tSpr.color = rgb(...)` per element). */
  shape?: ShapeDef;
  // Text styling (kind === 'text'; from the member's font/color/rect props).
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
  fontSize?: number;
  /** CSS color; null/undefined = default (white). */
  color?: string | null;
  /** Director ink number of the channel — the adapter skips the text bg fill
   *  for the transparency inks (1/8/36) so the window art shows through. */
  ink?: number;
  /** Ink 9 (Mask): the NEXT cast member's bitmap is the grayscale alpha mask
   *  (black=opaque, white=transparent, aligned by registration points). The
   *  pool water (vesi1 -> vesimask1, both in hh_room_pool) renders through it;
   *  without this the water shows as a solid rectangle. */
  maskBytes?: Uint8Array;
  maskRegX?: number;
  maskRegY?: number;
  /** CSS background fill behind the text (field members' txtBgColor). */
  bgColor?: string | null;
  alignment?: string;
  wordWrap?: boolean;
  width?: number;
  height?: number;
  regX: number;
  regY: number;
}

/** Map a Director font name (member.font: "VB", "Volter-Bold (GoldFish)",
 *  "Courier", ...) to a CSS family + weight. The casts bundle the Volter
 *  TTFs; Courier (the writers' font) maps onto Volter's synthetic 700. */
export function cssFontFor(font: LVal | undefined): { family: string; weight: string } {
  const name = typeof font === 'string' ? font : font instanceof LSymbol ? font.name : '';
  const lower = name.toLowerCase();
  if (lower.includes('volter') || lower === 'v' || lower === 'vb' || lower.includes('courier')) {
    return { family: 'Volter', weight: lower.includes('bold') || lower === 'vb' || lower.includes('courier') ? '700' : '400' };
  }
  return { family: name || 'Arial', weight: '400' };
}

/** member.color / member.bgColor -> CSS color string (null when unset). */
export function cssColorFor(color: LVal | undefined | null): string | null {
  if (color === undefined || color === null) return null;
  const c = colorFrom(color);
  if (!c) return null;
  return `rgb(${c.red},${c.green},${c.blue})`;
}

/** member.alignment (#center / "center" / ...) -> CSS text-align value. */
export function alignmentName(alignment: LVal | undefined): string {
  if (typeof alignment === 'string') return alignment.toLowerCase();
  if (alignment instanceof LSymbol) return alignment.name.toLowerCase();
  return 'left';
}

/** Read a generic text-member prop (bgColor, topSpacing, ...) from textProps. */
export function textPropOf(member: Member, key: string): LVal | undefined {
  return member.textProps?.get(key.toLowerCase());
}

/** Field/bitmap member props the Writer + interfaces set on members — valid
 *  Director member properties, stored silently with 0 defaults. One list for
 *  both get (silent default) and set (store) so they can never drift. */
const MEMBER_TEXT_PROPS = new Set([
  'topspacing', 'boxtype', 'leftmargin', 'rightmargin', 'leading', 'italics',
  'bold', 'underline', 'bordertype', 'shadow', 'bgcolor', 'antialias',
  'bordercolor', 'hilite', 'inset', 'border', 'textshadow',
  // Field members (Login Interface initB via Field Wrapper prepare).
  'autotab', 'editable',
]);

export interface StageAdapter {
  setBackground(color: number): void;
  setChannel(channel: number, visual: ChannelVisual | null): void;
  refreshChannel(channel: number): void;
  /** Resize the canvas to match the movie's stage dims (movie.txt). */
  resize(width: number, height: number): void;
}

interface WindowData {
  props: Map<string, LVal>;
  elements: Map<string, LObject>;
  procs: { handler: string; obj: LObject }[];
}

/** Minimal WebSocket surface the Multiuser Xtra uses (browser global or Node's
 *  undici WebSocket); kept structural so the engine stays DOM-free. */
interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  readyState: number;
  close(): void;
  send(data: string | Uint8Array): void;
}

/** Per-instance Multiuser Xtra state: the socket, the inbound v14 frame
 *  buffer, and the message queues the corpus polls (checkNetMessages /
 *  getNetMessage) or the engine pushes on tick (C++ MultiuserXtra::tick). */
interface MultiuserState {
  socket: { close(): void; send(d: string | Uint8Array): void; readyState: number } | null;
  queue: { subject: string; content: LVal }[];
  deliver: { subject: string; content: LVal }[];
  buffer: string;
  /** Xtra connection mode: 0 = binary (MUS protocol), 1 = text. The info
   *  connection (Connection Instance) uses 1; the Binary Manager's MUS
   *  connection uses 0 — kepler's ws.mus socket speaks the MUS binary
   *  framing (0x7200 header) with a Logon handshake, so sends and receives
   *  differ from the v14 @-frames. */
  mode: number;
  /** Pre-built MUS Logon handshake frame (mode 0 only), sent on socket open. */
  logon?: Uint8Array;
  handlerName?: string;
  handlerTarget?: LObjectClass;
}

/** Socket facade for the worker-owned WebSocket (see attachPersistence): the
 *  engine stores it in MultiuserState.socket so send/close/readyState keep the
 *  existing surface, and `url` routes inbound worker messages to the right
 *  connection. */
interface WorkerShim {
  url: string;
  readyState: number;
  send(d: string | Uint8Array): void;
  close(): void;
}

/** latin1 string -> bytes (byte == char code; kepler wants binary frames). */
function bytesOf(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** bytes -> latin1 string (inverse of bytesOf). */
function latin1Of(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** MUS binary protocol (kepler MusTypes == DirPlayer MusLingoValueTag): a
 *  frame is `0x7200` ('r' + 0) + u32 payload length + payload {i32 errorCode,
 *  u32 timestamp, even-padded subject, even-padded sender, u32 receiver
 *  count + even-padded receivers, u16 content tag, content}. Strings are u32
 *  length + latin1 bytes + a pad byte when odd. The Binary Manager's MUS
 *  connection (connectToNetServer mode 0) speaks this on kepler's ws.mus
 *  socket; the game connection (mode 1) stays the v14 @-frames. */
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

/** even-padded MUS string: u32 length + latin1 bytes + pad byte if odd. */
function musStr(s: string): Uint8Array {
  const bytes = bytesOf(s);
  const out = new Uint8Array(4 + bytes.length + (bytes.length % 2 ? 1 : 0));
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  if (bytes.length % 2) out[4 + bytes.length] = 0;
  return out;
}

/** Encode a Lingo value as a MUS lingo value (u16 tag + payload). PropList
 *  pairs are written kepler-style: u16 key tag (Symbol) + even-padded key +
 *  the value — readPropList's layout matches DirPlayer's mus_lingo_value. */
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
  return u16Bytes(0); // VOID
}

/** Encode one MUS message frame (kepler MusNetworkEncoder layout). */
function musFrame(subject: string, senderId: string, recipients: string[], contentType: number, content: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [
    i32Bytes(0), // errorCode
    i32Bytes(0), // timestamp (seconds; 0 for the handshake)
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

/** Split a MUS byte stream into complete frames; returns the leftover bytes
 *  to buffer for the next chunk. An invalid header resyncs by dropping one
 *  byte (kepler closes the socket on a bad header; we recover instead). */
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
    if (off + 6 + len > buf.length) break; // incomplete frame — wait for more
    const parsed = parseMusBody(new Uint8Array(buf.buffer, buf.byteOffset + off + 6, len));
    if (parsed) frames.push(parsed);
    off += 6 + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/** Decode one MUS frame payload (kepler MusNetworkDecoder layout) into a
 *  {subject, content} message. Content types: Int -> number, String -> latin1
 *  string, PropList -> LPropList, Media -> Uint8Array. */
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
    readI32(); // errorCode
    readI32(); // timestamp
    const subject = readStr();
    readStr(); // senderId
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
          readU16(); // key tag (Symbol)
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
        content = ''; // Void / unknown — nothing meaningful to deliver
    }
    return { subject, contentType, content };
  } catch {
    return null;
  }
}

/** WebSocket scheme for the Multiuser Xtra connection: `wss` on https pages,
 *  `ws` everywhere else (http/localhost/file). Like the original Xtra, the
 *  socket follows the page's protocol so mixed-content rules never block it.
 *  Headless (no window.location) falls back to `ws`. */
function wsScheme(): string {
  const proto = (globalThis as { location?: { protocol?: string } }).location?.protocol;
  return proto === 'https:' ? 'wss' : 'ws';
}

interface NetRequest {
  url: string;
  done: boolean;
  error: string;
  text: string;
  /** Raw bytes of a plain-file download (catalogue/badge image fetched by
   *  preloadNetThing); importFileInto decodes these into the member. */
  bytes?: Uint8Array;
  /** Frames until completion; preloads of local casts complete quickly. */
  framesLeft?: number;
  /** Real chunked-fetch progress (set when preloadNetThing's bundle fetch
   *  reports bytes) so getStreamStatus -> Download Instance -> CastLoad Task
   *  -> Loading Bar animates instead of jumping 0 -> 100%. */
  bytesSoFar?: number;
  bytesTotal?: number;
  /** Artificial download ramp for preloads: the demo's cast bundles are
   *  local, so a real fetch arrives in one chunk and the Loading Bar would
   *  still jump 0 -> 100%. While set, bytesSoFar ramps 0 -> 100 each tick
   *  (synthetic bytesTotal = 100); real fetch bytes replace the ramp, and
   *  the request goes done once the real load has landed AND the ramp ran
   *  out (so the bar visibly fills like the original socket download). */
  rampFrames?: number;
  /** The real bundle load finished (or was already registered); completion
   *  now only waits for the ramp. */
  awaitingFinish?: boolean;
}

/** Ticks a preload's artificial download ramp runs (Loading Bar fill). */
const NET_RAMP_FRAMES = 24;

const SCRIPT_TYPE_RE = /^--\s*Type:\s*(\w+)/m;
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
  /** Movie preferences (`setPref`/`getPref`), keyed case-insensitively.
   *  Director keeps these in prefs.txt; the browser embed may seed them from
   *  localStorage, headless probes start empty. */
  prefs = new Map<string, string>();
  frame = 1;
  frameTempo = 30;
  itemDelim = ',';
  /** `the traceScript` — Director's statement-tracing flag (FALSE default).
   *  Every corpus component's init guard reads it (`if the traceScript then
   *  return 0`) and immediately zeroes it (and _movie/_player's copies). */
  traceScript = 0;
  /** `the traceLogFile` — the file Director writes trace output to. The
   *  browser embed has no filesystem, so the value is stored for get/set
   *  round-trip only (the corpus sets it to EMPTY on init). */
  traceLogFile = '';
  /** `the activeWindow` — the window with keyboard focus; Director's default
   *  is the main stage window named "stage". The Initialization script bails
   *  with stopMovie() unless `(the activeWindow).name = "stage"`. */
  activeWindow = 'stage';
  /** Host-provided globals (DirPlayer convention): the updated movie scripts
   *  never assign `_movie`/`_player` — the host defines them. Lenient objects:
   *  `_movie.traceScript = 0` / `_player.traceScript = 0` store silently and
   *  any unset read returns VOID. */
  _movie: LObjectClass;
  _player: LObjectClass;
  rolloverChannel = 0;
  /** Last pointer position (backs `the mouseH` / `the mouseV` / `the mouseLoc`). */
  mouseH = 0;
  mouseV = 0;
  /** Button state backing `the mouseDown` / `the mouseUp` (1 pressed / 0 up). */
  mouseButton: 'down' | 'up' = 'up';
  /** Channel hit at the last mouseDown — backs `mouseUpOutSide` (drag release). */
  mouseDownChannel = 0;
  /** `the doubleClick` — true from the second mouseDown until that click's
   *  mouseUp finishes (Director/DirPlayer: two mouseDowns < 500 ms apart).
   *  Furniture classes gate double-click actions (Sound Machine state toggle,
   *  Bottle roll, E-Dice throw, Credit Furni) on it. */
  doubleClick = false;
  /** Timestamp of the last mouseDown — backs doubleClick detection. */
  private lastMouseDownTime = 0;
  /** stopEvent() sets this; the current pointer/key dispatch chain honors it. */
  _stopEventPending = false;
  /** Called whenever a cast bundle is registered (loadCast during boot's net
   *  preloads) — the embed host uses it to load that cast's TTF fonts once the
   *  manifest is in (loadFonts runs before the lazy casts exist otherwise). */
  onCastLoaded?: (castName: string) => void;
  /** Director `the keyboardFocusSprite` — the editable field sprite that
   *  receives keystrokes (Field Wrapper setFocus sets it on field clicks). */
  keyboardFocusSprite = 0;
  /** Last key state backing `the key` / `the keyCode` / `the keyDown` / `the keyUp`. */
  lastKey = '';
  lastKeyCode = 0;
  keyDownActive = false;
  /** Director `the floatPrecision` — digits kept when formatting floats
   *  (DirPlayer float_precision, default 4). Room Geometry getScreenCoordinate
   *  does `set the floatPrecision to 2` around its tile math. */
  floatPrecision = 4;
  /** Keyboard modifier state backing `the shiftDown` / `the optionDown` /
   *  `the commandDown` / `the controlDown` (DirPlayer keyboard_manager). */
  shiftDown = false;
  optionDown = false;
  commandDown = false;
  controlDown = false;
  stageWidth = 720;
  stageHeight = 540;
  /** Stage rect in window coordinates (movie.txt: 89/50/809/590). */
  stageLeft = 0;
  stageTop = 0;
  stageRight = 720;
  stageBottom = 540;
  /** Movie background color (movie.txt `background_color`, e.g. 0x000020). */
  stageBackground = 0x0d0d18;
  /** Persistent stage drawing surface backing `(the stage).image`. */
  private _stageImage: LImage | null = null;
  /** Parsed movie.txt config of the loaded movie. */
  movieConfig: MovieConfig | null = null;
  /** Parsed casts.txt registry (Director castLib order), or null when absent. */
  castList: CastListEntry[] | null = null;
  /** Movie's current palette (RGB triplets) — backs `paletteIndex(n)`. Set from
   *  the last loaded palette member / .pal companion (hh_human's palette drives
   *  avatar figure colors). */
  currentPalette: number[][] | null = null;
  /** Last sprite channel number (backs `the lastChannel`). The v14 movie's
   *  score chunk has 1006 channels; movie.txt `channels` overrides. */
  lastChannel = 1006;
  /** Object whose `alertHook` handler Director calls on alerts (`the alertHook`). */
  alertHookValue: LVal = 0;
  /** Active `timeout(name).new(period, handler, target)` timers. */
  private timeouts: { obj: LObject; due: number; period: number; handler: string; target: LObject }[] = [];

  /** One-shot `me.delay(ms, #handler, args...)` callbacks (corpus-wide idiom).
   *  Ticked each frame like timeouts; cancelled via `me.Cancel(id)`. */
  private delays: { id: number; due: number; obj: LObject; handler: string; args: LVal[] }[] = [];
  private delaySeq = 0;
  /** URL-style path of the movie (backs `the moviePath`). */
  moviePath = '/';
  /** `the timer` clock base (Director: ms since the movie started, reset by
   *  the `startTimer()` builtin — Paalu game countdowns read it). */
  timerStart = Date.now();
  /** `the runMode` — "Author" / "Projector" / "Plugin" (corpus gates the
   *  sw-param parse on `the runMode contains "Plugin"`). */
  runMode = 'Projector';
  /** Host-provided rasterizer for text/field members: given a member, produce
   *  its rendered image (canvas text is antialiased by the browser). The
   *  browser embed installs one; headless probes run without it and text
   *  members simply have no image. Returns null when it can't render. */
  textRasterizer?: (member: Member) => LImage | null;
  /** External params from an <embed>/<object>/<spark> tag (sw1..sw9, src...). */
  private externalParamList: { name: string; value: string }[] = [];
  private externalParamByName = new Map<string, string>();
  /** Score/behavior scripts; `passed` scripts no longer fire frame events
   *  (Director: an exitFrame that issues no `go` lets the playhead advance, so
   *  that frame's script never runs again — Init's startClient path depends on
   *  this to avoid re-running resetCastLibs on every download completion). */
  frameScripts: { script: Script; instance: LObject; handlers: Map<string, Handler>; passed: boolean }[] = [];
  movieScripts: { script: Script; instance: LObject }[] = [];
  frameCount = 0;
  booted = false;
  logs: string[] = [];
  netId = 0;
  net = new Map<number, NetRequest>();
  /** BundleLoader provided at boot; runtime cast downloads register through it. */
  bundleLoader: BundleLoader | null = null;
  private uid = 0;
  /** Last cast name registered into each dynamic castLib slot (slot -> cast
   *  name). pAllMemNumList holds slot-encoded member numbers that can outlive
   *  a slot recycle (the CastLoad Manager re-imports into a DIFFERENT slot
   *  each room switch), so stale numbers re-resolve through the cast that USED
   *  to live there to its current holder. Updated on import only. */
  private slotLastCast = new Map<number, string>();
  /** Set when a `go` command executes; tick() uses it to detect whether an
   *  exitFrame handler pinned the playhead (`go(the frame)`) or let it advance. */
  private goIssued = false;
  /** DirPlayer `the clickOn`: the TOPMOST sprite (script or not) at the last
   *  mouseDown position — the Furniture Club TV's select uses it to detect a
   *  double-click on its bottom/stand parts (sprites 3-5) and walks to the
   *  floor instead of toggling. Set on mouseDown (unscripted lookup), kept
   *  through the release so mouseUp-time select handlers read it. */
  clickOnChannel = 0;
  interp: Interpreter;
  adapter: StageAdapter | null;
  private builtins = createBuiltinTable();
  /** Channels whose stage visual must be (re)built. Coalesced so a synchronous
   *  burst of sprite prop sets (Visualizer buildVisual sets ~12 props per
   *  sprite) produces ONE texture load per sprite instead of one per prop —
   *  the per-prop rebuilds each created + revoked a blob URL / PNG decode
   *  (ERR_FILE_NOT_FOUND console spam + 100-900ms rAF violations at boot). */
  private visualDirty = new Set<number>();
  private visualFlushScheduled = false;

  constructor(adapter: StageAdapter | null = null) {
    this.adapter = adapter;
    this.interp = new Interpreter(this);
    // Seed the DirPlayer-style host globals the updated movie scripts expect
    // (Initialization's `_movie.traceScript = 0` / `_player.windowList`). The
    // corpus itself guards with `if _player <> VOID then`, so an object here
    // is exactly what the scripts are written against.
    this._movie = this.hostGlobalObj('_movie');
    this._player = this.hostGlobalObj('_player');
    this.globals.set('_movie', this._movie);
    this.globals.set('_player', this._player);
    this.refreshPlayerWindowList();
  }

  // ------------------------------------------------------------ loading

  /**
   * Load a cast and, recursively, its linked casts (Director linked-cast
   * model). CastLib numbers follow load order, matching linked_casts.txt.
   */
  async loadCast(loader: BundleLoader, castName: string): Promise<CastLib | null> {
    // A pre-registered shell (casts.txt) is NOT loaded yet — only return early
    // once its bundle actually filled it in.
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

  /** Apply movie.txt: stage size/rect, background color, tempo. */
  private applyMovieConfig(m: MovieConfig): void {
    this.movieConfig = m;
    if (m.stageWidth !== undefined && m.stageWidth !== 0) this.stageWidth = m.stageWidth;
    if (m.stageHeight !== undefined && m.stageHeight !== 0) this.stageHeight = m.stageHeight;
    // Zero guard (like width/height): linked cast files ship an all-zero
    // stage rect meaning "no stage geometry here" — applying it would clobber
    // the boot movie's real rect and push centered windows off-screen.
    if (m.stageLeft !== undefined && m.stageLeft !== 0) this.stageLeft = m.stageLeft;
    if (m.stageTop !== undefined && m.stageTop !== 0) this.stageTop = m.stageTop;
    if (m.stageRight !== undefined && m.stageRight !== 0) this.stageRight = m.stageRight;
    if (m.stageBottom !== undefined && m.stageBottom !== 0) this.stageBottom = m.stageBottom;
    // Shockwave renders the resolved RGB (`stage_color_rgb`, e.g. 0x000000
    // black); `background_color`/`stage_color` are palette-encoded values that
    // only make sense through the movie's default palette.
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

  /** Pre-register every castLib from casts.txt as an empty shell, in Director
   *  order (Internal=1, fuse_client=2, bin=3, empty 1..38=4..41). Loaded
   *  bundles fill their matching shell later. */
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

  /** Find which castLib slot a loaded bundle should fill (or null → append). */
  private findCastSlot(manifest: CastManifest): CastLib | null {
    const castName = manifest.name;
    const shell = this.castByName.get(castName);
    if (shell && !shell.loaded) return shell;
    // The movie's own cast (has movie.txt) is the "Internal" entry — the one
    // with an empty path in casts.txt.
    if (manifest.movie) {
      const internal = this.castList?.find((e) => !e.path);
      if (internal) {
        const cast = this.castByName.get(internal.name);
        if (cast && !cast.loaded) return cast;
      }
    }
    // The 38 "empty N" entries all point at the same empty.cst; a loaded
    // bundle whose fileName matches fills the first such shell.
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
    // setImportedCast renames the target shell to the cast's FILE PATH at
    // download START (before the bundle is necessarily in the loader), so the
    // rename-time fill may never happen and importFileInto would otherwise
    // append an untracked slot the corpus never releases. Match an UNLOADED
    // shell whose basename equals this cast name so the members land in the
    // shell the corpus tracks (its rename-to-empty then clears them).
    const base = this.castNameFromUrl(castName);
    for (const cand of this.casts) {
      if (cand.loaded || cand.members.size > 0) continue;
      const candBase = this.castNameFromUrl(cand.name);
      if (candBase && candBase.toLowerCase() === (base ?? castName).toLowerCase()) return cand;
    }
    return null;
  }

  /** Register a cast whose bundle is already present in the loader. */
  private registerCast(loader: BundleLoader, manifest: CastManifest): CastLib {
    const castName = manifest.name;
    // Only the movie's own bundle applies its stage config — and only the
    // FIRST one. Every linked cast ships a placeholder movie.txt (all-zero
    // stage, white color) that must NOT clobber the boot movie's real black
    // 720x540 stage mid-boot.
    if (manifest.movie && Array.isArray(manifest.castList) && !this.movieConfig) this.applyMovieConfig(manifest.movie);
    if (manifest.castList?.length) this.registerCastListShells(manifest.castList);

    let cast = this.findCastSlot(manifest);
    if (!cast) {
      cast = new CastLib(this.casts.length + 1, castName);
      this.casts.push(cast);
    }
    // Supersede a DIFFERENT loaded holder of the same cast name. The corpus
    // can hold a cast under two name forms (bare name vs the file-path shell
    // name from setImportedCast), so the rename-time purge misses the stale
    // holder and lookups keep resolving to the OLD slot's members ("loaded
    // into a slot but only replaces a few [images]"). Once a fresh import
    // lands, the previous holder is stale: clear it (permanent casts.txt
    // casts are never purged).
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
    // Track the slot's cast for stale-number re-resolution (see slotLastCast).
    this.slotLastCast.set(cast.number, castName);

    for (const entry of manifest.members) {
      const member = new Member(cast.number, entry.number, entry.name, entry.kind);
      member.fileName = entry.file;
      if (entry.regX !== undefined) member.regX = entry.regX;
      if (entry.regY !== undefined) member.regY = entry.regY;

      switch (entry.kind) {
        case 'script': {
          const source = loader.memberText(entry) ?? '';
          const script = parseLingo(source);
          script.name = entry.name;
          const tm = SCRIPT_TYPE_RE.exec(source);
          if (tm) {
            const type = tm[1].toLowerCase();
            script.type = type === 'parent' || type === 'movie' || type === 'score' || type === 'behavior' ? type : 'unknown';
          }
          member.script = script;
          member.text = source;
          break;
        }
        case 'text':
        case 'shape': {
          const text = loader.memberText(entry);
          // Director stores text members with CR (chr 13) separators — the
          // corpus splits them with `the itemDelimiter = RETURN` (e.g.
          // convertToPropList(field("System Props"), RETURN)). The re-export
          // ships LF files, so normalize to CR or those splits find nothing
          // and every class lookup reads VOID. Shape text is only consumed by
          // parseShapeText (which splits on \\r?\\n), so leave it untouched.
          if (entry.kind === 'text') member.text = text === undefined ? undefined : normalizeTextLines(text);
          else member.text = text;
          if (entry.kind === 'shape' && text !== undefined) member.shape = parseShapeText(text);
          break;
        }
        case 'bitmap':
          member.raw = loader.readBytes(entry.file);
          // The re-export ships each bitmap's own .pal companion (JASC-PAL).
          // Parse it so matte/key removal can match the palette's index 0
          // exactly (DirPlayer get_bg_color_ref) instead of guessing near-
          // white — the cloud body gray is a DIFFERENT index than the white
          // background, and enclosed whites are index 0 (must be keyed).
          if (entry.palRel) {
            const palBytes = loader.readBytes(entry.palRel);
            if (palBytes !== undefined) member.palette = parsePaletteBytes(palBytes);
          }
          break;
        case 'palette': {
          // Palette members ship either the bundler's PALB binary form or
          // JASC text (old bundles) — parsePaletteBytes handles both.
          const palBytes = loader.readBytes(entry.file);
          if (palBytes !== undefined) {
            member.palette = parsePaletteBytes(palBytes);
            // Only real palette members drive currentPalette (per-bitmap .pal
            // companions exist for matte keying, not paletteIndex() — Figure
            // System avatar colors need the cast palette, e.g. hh_human).
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

  /** Register a script directly (tests, patches). */
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
    // Director lifecycle: prepareMovie runs before the first frame, then startMovie.
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

  /** Advance one frame: enterFrame + exitFrame on all active frame behaviors.
   *  An exitFrame that issues `go(the frame)` pins the playhead (the loading
   *  loop fires again next frame); one that issues no `go` lets the playhead
   *  advance and never fires again — without this, Init's startClient would
   *  re-run on every completed download and wipe freshly imported casts. */
  tick(): void {
    if (!this.booted) return;
    this.frameCount++;
    this.completeNetRequests();
    this.fireTimeouts();
    this.fireDelays();
    this.fireNetMessages();
    // Director drives the Object Manager's prepareFrame every frame, which
    // pumps its #prepare + #update lists — the Download/CastLoad managers,
    // windows and visualizers all progress through this. Without it, downloads
    // never leave #LOADING.
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

  /** Director `timeout(name)` — a timer object; `.new(period, #handler,
   *  target)` fires target's handler every period ms. The Timeout Manager
   *  wraps these and dispatches via its own executeTimeOut, so we just invoke
   *  the callback with the timeout obj. */
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

  /** Shared `xtra("Name")` stub factory — one definition for builtins + interpreter. */
  /** A lenient host-defined global object (DirPlayer `_movie`/`_player`
   *  convention): any property set stores on props, reads return the stored
   *  value or VOID. */
  private hostGlobalObj(name: string): LObjectClass {
    const script: Script = { name, type: 'parent', props: [], globals: [], handlers: [], source: '' };
    const obj = this.interp.makeInstance(script, this.getUniqueId());
    obj.lenient = true;
    return obj;
  }

  /** Keep `_player.windowList` in sync with the open MIAW windows — the
   *  corpus's single-instance guard (`if _player.windowList.count > 0 then
   *  return stopMovie()`) must see every window the Window Manager opens. The
   *  stage is NOT a member (it always exists — counting it would trip the
   *  guard on every boot). */
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

  /** Real xmlparser Xtra — FUSE Figure System/Data parse partsets.xml,
   *  draworder.xml, animation.xml and figuredata.xml through it:
   *  `new(xtra("xmlparser"))`, `parseString(tData)` -> 1/0, `getError()` ->
   *  message or VOID, then `parser.child[i].name/.child/.attributeName[k]/
   *  .attributeValue[k]` and `element.child[1].text` (#text nodes). The
   *  corpus walks `tParserObject.child.count` / `tParserObject.child[i]` as
   *  the TOP-LEVEL element list (LibreShockwave parity: the xtra's `child`
   *  property returns the #document node's child list), stored on the
   *  instance's `child` prop so those reads resolve through the lenient-
   *  object props path. */
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
        // The corpus gates on voidp(getError()) — a failed parse must leave
        // the error string (and an empty element list so later walks no-op).
        obj.props.set('error', err instanceof Error ? err.message : String(err));
        obj.props.set('child', new LList([]));
        return 0;
      }
    }
    if (lower === 'geterror') {
      const e = obj.props.get('error');
      return e === undefined || e === null ? VOID : e;
    }
    // Unknown xmlparser method: lenient no-op (matches the stub contract).
    return VOID;
  }

  /** Optional WebSocket override for the Multiuser Xtra (the old
   *  `<spark-player ws="...">` attribute). Only used for movies that connect
   *  with empty host/port — the Xtra normally builds the URL from the
   *  connectToNetServer args itself. */
  multiuserUrl?: string;

  /** Persistence worker (owns the Multiuser WebSocket + a 1 Hz hidden-clock),
   *  attached by the embed host via attachPersistence. Null in headless/tests
   *  → the Multiuser Xtra keeps its inline WebSocket path. */
  persistWorker?: PersistWorkerLike;
  /** True while the page is hidden: worker `tick` messages drive engine.tick()
   *  at 1 Hz because the rAF ticker is paused then. */
  pageHidden = false;

  /** Per-instance Multiuser socket + message queues, keyed by obj.id. */
  private multiuserState = new Map<string, MultiuserState>();

  /** Real Multiuser Xtra — WebSocket-backed when `multiuserUrl` is set. FUSE
   *  registers a message handler with setNetMessageHandler, connects, and
   *  sends; server pushes are pulled with checkNetMessages/getNetMessage. */
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
          // Corpus disconnect(): setNetMessageHandler(VOID, VOID) is an
          // intentional clear — not a misuse.
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
        // args: ("*", "*", host, port, "*", mode) — the corpus reads the sw
        // host/port params itself (Core Thread load_params), so each
        // connection (connection.info.* AND connection.mus.*) resolves its
        // own URL, like the original Xtra / DirPlayer.
        const host = toLingoString(args[2] ?? '');
        const port = toLingoString(args[3] ?? '');
        // The Xtra connects with the page's protocol (wss on https, ws
        // otherwise) so mixed-content never blocks the socket, using exactly
        // the host/port strings the script passes (connection.info.* from sw2
        // and connection.mus.* from sw4 — two separate ports). A preset
        // multiuserUrl is only a fallback for empty host/port — it must NOT
        // override the script's args or the MUS connection gets hijacked onto
        // the info connection's URL.
        const mode = Math.round(asNum(args[5] ?? 0));
        const url = host && port ? `${wsScheme()}://${host}:${port}` : this.multiuserUrl ?? '';
        if (!url) {
          this.log(`net: multiuser connect (no ws url): no WebSocket in this environment — stub`);
          return 0;
        }
        const st = this.multiuserState.get(obj.id) ?? { socket: null, queue: [], deliver: [], buffer: '', mode };
        st.mode = mode;
        // MUS handshake: kepler only replies Logon + HELLO after a Logon
        // frame, and the Binary Manager's pHandshakeFinished flips on HELLO —
        // without it, checkConnection never sends LOGIN and bindata is dead.
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
        // Persistence worker path: the socket lives in a worker so it survives
        // the tab being hidden (an inline socket's draining freezes when rAF
        // pauses). The shim keeps the { send, close, readyState } surface the
        // Xtra uses; sends are routed by url so the other connection (info vs
        // mus) is never hit.
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
            // MUS handshake first: the Logon frame prompts kepler's Logon +
            // HELLO reply, which the Binary Manager needs before LOGIN.
            if (st.mode === 0 && st.logon) {
              try {
                ws.send(st.logon);
              } catch (e) {
                this.log(`net: mus logon send failed: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
            // C++ QueuedMultiuserBridge::notifyConnected queues a synthetic
            // {0, "System", "ConnectToNetServer", ""} message on connect —
            // delivering it unblocks sends the moment the socket opens.
            st.queue.push({ subject: 'ConnectToNetServer', content: '' });
          };
          ws.onmessage = (ev: { data: unknown }) => {
            // Kepler speaks BINARY websocket frames; the browser surfaces
            // those as ArrayBuffer/Blob, not strings — a string-only gate
            // dropped every frame (the "connects but nothing happens" bug).
            const d = ev.data;
            if (d instanceof ArrayBuffer) {
              this.ingestNetBytes(st, new Uint8Array(d));
            } else if (ArrayBuffer.isView(d)) {
              this.ingestNetBytes(st, new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
            } else if (typeof Blob !== 'undefined' && d instanceof Blob) {
              d.arrayBuffer().then((ab) => this.ingestNetBytes(st, new Uint8Array(ab))).catch(() => { /* noop */ });
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
        // Director Multiuser Xtra: sendNetMessage(fromWhom, toWhom, data).
        //   (0, 0, bytes)  -> raw binary send (Connection Instance `send`
        //     frames the v14 message itself; a single NUL byte = disconnect).
        //   ("*", subject, content) -> text send: subject + ' ' + content.
        const st = this.multiuserState.get(obj.id);
        if (!st?.socket) return 0;
        // Two send forms: Connection Instance ships RAW v14 frames via
        // sendNetMessage(0, 0, bytes); the Multiuser Instance (MUS) sends
        // ("*", subject, content). asNum() coerces BOTH "*" and a non-numeric
        // subject to 0, which would hijack the MUS send into the raw-bytes
        // path — check the actual argument types.
        const isRawBytesSend = args[0] === 0 && args[1] === 0;
        const from = asNum(args[0] ?? -1);
        const to = asNum(args[1] ?? -1);
        let data: string;
        if (isRawBytesSend) {
          data = toLingoString(args[2] ?? '');
          if (data.length === 1 && data.charCodeAt(0) === 0) {
            try { st.socket.close(); } catch { /* noop */ }
            st.socket = null;
            return 0;
          }
        } else if (st.mode === 0) {
          // MUS binary framing. Kepler parses LOGIN/GETBINDATA/PHOTOTXT from
          // a String content and BINDATA (sendBinary) from a PropList — a
          // Lingo list becomes the space-joined string, a propList stays a
          // propList, raw bytes become Media.
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
        // Ship BINARY (latin1 bytes), not a text frame: kepler only forwards
        // BinaryWebSocketFrame to the game decoder. The v14 outbound frame is
        // 3 @-encoded length bytes + a 2-byte @-encoded command id + params;
        // the routing subject is the pair at bytes 3-4 decoded @-style, NOT
        // byte 3 alone (reading only data[3] misreported the sound-machine
        // save as subj=67 — the first byte of command 218).
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
          try { st.socket.close(); } catch { /* noop */ }
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
            // The handler (xtraMsgHandler) pulls the message via getNetMessage
            // — stage it in `deliver`, invoke, then clear.
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
        // DIAG: dump the connection instance's pListenersPntr (#value) so we
        // can see whether the corpus's forwardMsg(0) lookup will find
        // handleHello. Props are stored under their declared case, so scan
        // case-insensitively.
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
          /* diag only */
        }
        this.log(`net: getNetMessage subj="${m.subject}" content=${typeof m.content === 'string' ? m.content.length : 0}B`);
        // C++ messagePropList: {#errorCode, #senderID, #subject, #content}.
        // String keys are fine — keyOf() normalizes symbol lookups to names.
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

  /** Attach the persistence worker: route Multiuser sockets through it and
   *  accept its 1 Hz tick while the page is hidden. Call once at embed init,
   *  before any Lingo connects. Headless environments skip this and the Xtra
   *  keeps its inline WebSocket path. */
  attachPersistence(worker: PersistWorkerLike): void {
    if (this.persistWorker === worker) return; // already wired (embed re-init guard)
    this.persistWorker = worker;
    worker.onMessage((msg) => this.onWorkerMessage(msg));
  }

  /** Page visibility: hidden → the worker starts its 1 Hz clock and its `tick`
   *  messages keep engine.tick() running (timeouts/delays/net draining/frame
   *  scripts all advance); visible → the rAF ticker takes back over and the
   *  worker's clock stops, so nothing double-ticks. */
  setPageHidden(hidden: boolean): void {
    this.pageHidden = hidden;
    this.persistWorker?.setHidden(hidden);
    this.log(`net: page ${hidden ? 'hidden' : 'visible'} — ${hidden ? 'worker 1 Hz tick' : 'rAF ticker'}`);
  }

  /** Inbound persistence-worker messages: socket lifecycle + frames (queued
   *  exactly like the inline ws.onmessage path so the corpus's poll and tick
   *  push behave identically) + the 1 Hz hidden-clock. */
  private onWorkerMessage(msg: PersistWorkerMsg): void {
    switch (msg.type) {
      case 'ws-open': {
        for (const st of this.multiuserState.values()) {
          const s = st.socket as WorkerShim | null;
          if (!s || s.url !== msg.url) continue;
          s.readyState = 1;
          this.log(`net: multiuser ws open ${msg.url}`);
          // MUS handshake: send the Logon frame built at connect time (see
          // connecttonetserver) — kepler replies Logon + HELLO, which the
          // Binary Manager needs before it sends LOGIN.
          if (st.mode === 0 && st.logon) {
            try {
              this.persistWorker?.send(msg.url, st.logon);
            } catch { /* noop */ }
          }
          // Same synthetic connect message the inline path pushes (see
          // connecttonetserver) so sends unblock the moment the socket opens.
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
        // Only while hidden — when visible the rAF ticker drives engine.tick()
        // (and the worker's clock is stopped anyway via setPageHidden(false)).
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

  /** C++ MultiuserXtra::tick() — the Xtra itself pushes queued messages to
   *  the registered netHandler. Lingo only polls in the Room Component, so
   *  login-phase traffic depends on this push to reach xtraMsgHandler. */
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
        // The handler (xtraMsgHandler) pulls the message via getNetMessage
        // — stage it in `deliver`, invoke, then clear.
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

  /** Convert inbound binary ws bytes to a latin1 string (byte == char code) so
   *  the v14 frame parser works byte-exactly — or, for MUS connections (mode
   *  0), split the byte stream into MUS frames and deliver {subject, content}.
   *  Partial frames stay buffered until the next chunk arrives. */
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

  /** Server -> client frames arrive WITHOUT the client-side 3-byte length
   *  prefix (kepler's HELLO is `@@\x01`). The corpus's Connection Instance
   *  msghandler does ALL the framing on receive itself — it parses the 2-byte
   *  header from content and recurses for concatenated messages — so the Xtra
   *  must deliver the raw bytes verbatim. Any length-prefix parsing here
   *  would eat real frames. */
  private ingestNetText(st: MultiuserState, text: string): void {
    if (!text) return;
    st.queue.push({ subject: '', content: text });
    // DIAG: decode the 2-byte @-header subject the corpus msghandler will
    // parse (tMsgType = (char1&63)*64 + (char2&63)) so a console glance shows
    // exactly which protocol subjects arrive (6 = wallet balance, 8 = room
    // list, ...). subj=-1 when the frame is shorter than the 2-byte header.
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
    this.timeouts = this.timeouts.filter((t) => t.due > now);
    for (const t of due) {
      const h = t.target.handlers.get(t.handler.toLowerCase());
      if (h && t.target.script) this.interp.callHandler(t.target.script, h, [t.obj], t.target, NO_GLOBALS);
      else this.interp.callObjectHandler(t.target, t.handler, [t.obj]);
      // Periodic timeouts re-arm (Director semantics) unless forgotten during
      // the callback (Timeout Manager's executeTimeOut calls forget() when the
      // matching task is gone, which removes it from this.timeouts).
      if (t.period > 0 && this.timeouts.some((t2) => t2.obj === t.obj)) {
        this.timeouts.push({ ...t, due: now + t.period });
      }
    }
  }

  /** Dispatch a pointer event to the frame scripts AND the hit channel's
   *  behavior instances. FUSE wires an Event Broker per window-element sprite
   *  whose mouse handlers redirectEvent() to the window's registered client
   *  procedures — so clicks reach Lingo end-to-end. */
  dispatchPointerEvent(type: 'mouseDown' | 'mouseUp' | 'mouseMove', channel: number, x: number, y: number): void {
    this.mouseH = x;
    this.mouseV = y;
    this._stopEventPending = false;
    if (type === 'mouseDown') {
      this.mouseButton = 'down';
      this.mouseDownChannel = channel;
      // DirPlayer parity: two mouseDowns within 500 ms => `the doubleClick` is
      // true for this press AND its release (cleared after the mouseUp below).
      const now = Date.now();
      this.doubleClick = now - this.lastMouseDownTime < 500;
      this.lastMouseDownTime = now;
      // DirPlayer: `the clickOn` = the topmost sprite at the press point
      // (get_sprite_at scripted=false — the TV's bottom-part sprites are
      // scripted via the object, but the check must not depend on dispatch).
      this.clickOnChannel = this.spriteAtPoint(x, y);
      // Click-to-focus (Director): mouseDown on an editable text field moves
      // `the keyboardFocusSprite` there; clicking anything else — a button,
      // the drag bar, or the empty stage — drops it back to 0.
      const m = channel > 0 && channel < this.channels.length ? this.channels[channel].member : undefined;
      if (m && m.kind === 'text' && m.textProps?.get('editable')) this.keyboardFocusSprite = channel;
      else this.keyboardFocusSprite = 0;
    }
    if (type === 'mouseUp') {
      this.mouseButton = 'up';
      // Director: `mouseUpOutSide` fires on the sprite where the button went
      // down when the up lands elsewhere — Window Instance uses it to end a
      // drag (`me.drag(0)`) when you release outside the window.
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
        // U119: stopEvent() halts THIS dispatch chain only — clear it so it
        // cannot bleed into sprite-method dispatches that run between events.
        this._stopEventPending = false;
        return;
      }
    }
    // Sprite behaviors (Director dispatches sprite events to the sprite's
    // scriptInstanceList). Guarded: FUSE reserves the element sprites via
    // Sprite Manager and expects this chain for all click UI.
    this.dispatchToChannelHandlers(channel, lower, []);
    // mouseEnter/mouseLeave fire on rollover transitions; mouseWithin fires
    // while the cursor STAYS over a sprite (Event Broker redirects them to the
    // window's mouseEnter/mouseLeave/mouseWithin procs). Director sends
    // mouseWithin every frame the cursor is inside the sprite — DirPlayer
    // dispatches it on each pointer move (events.rs dispatch_rollover_events).
    // Without it the DropDown Class's `on mouseWithin` never ran, so the open
    // menu never highlighted an option, pRollOverItem stayed VOID, and clicks
    // closed the menu without selecting (which re-opened it on the next click
    // and re-ordered the list — the dropdown "jumped").
    if (lower === 'mousemove') {
      const prev = this.rolloverChannel;
      if (prev !== 0 && prev !== channel) this.dispatchToChannelHandlers(prev, 'mouseleave', []);
      if (channel !== 0 && prev !== channel) this.dispatchToChannelHandlers(channel, 'mouseenter', []);
      if (channel !== 0 && channel === prev) this.dispatchToChannelHandlers(channel, 'mousewithin', []);
    }
    // `the doubleClick` covers the second click's release handlers, then clears
    // (DirPlayer resets is_double_click at the END of the mouseUp command).
    if (type === 'mouseUp') this.doubleClick = false;
    this.setRollover(channel);
    // U119: event chain over. A behavior's stopEvent() must not bleed into
    // sprite-method dispatches that run BETWEEN events — the room build's
    // setID/registerProcedure (a stuck flag made dispatchToChannelHandlers
    // break immediately, so the re-entered room's floor broker was never wired
    // and every click died silently).
    this._stopEventPending = false;
  }

  /** Dispatch a keyboard event. Director routes keys to `the
   *  keyboardFocusSprite` (Field Wrapper setFocus sets it on field click): the
   *  focused sprite's behaviors get keyDown/keyUp, and an EDITABLE text member
   *  on it receives the keystroke natively (Director field editing). */
  dispatchKeyEvent(type: 'keyDown' | 'keyUp', key: string, keyCode: number, mods?: { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean }): void {
    if (mods) {
      this.shiftDown = !!mods.shift;
      this.optionDown = !!mods.alt;
      this.controlDown = !!mods.ctrl;
      this.commandDown = !!mods.meta;
    }
    const down = type === 'keyDown';
    this._stopEventPending = false;
    // Director `the key`: Enter/Backspace/Tab/Esc surface as control chars
    // (CHAR(13)/CHAR(8)/CHAR(9)/CHAR(27)) for keyDown handlers that branch on
    // them; the native-editing branch below keys off keyCode instead.
    this.lastKey =
      keyCode === 13 ? '\r' :
      keyCode === 8 ? '\b' :
      keyCode === 9 ? '\t' :
      keyCode === 27 ? '' :
      key;
    this.lastKeyCode = keyCode;
    this.keyDownActive = down;
    const focus = this.keyboardFocusSprite;
    if (focus <= 0 || focus >= this.channels.length) return;
    this.dispatchToChannelHandlers(focus, down ? 'keydown' : 'keyup', []);
    if (this._stopEventPending || !down) {
      this._stopEventPending = false; // U119: don't leak stopEvent past this event
      return;
    }
    // Native field editing: insert the printable char / handle backspace into
    // the focused member's text (setMemberProp invalidates the text image so
    // the rasterizer re-renders the field). A behavior's stopEvent() skips it.
    const member = this.channels[focus].member;
    if (!member) return;
    if (member.kind !== 'text' || !member.textProps?.get('editable')) return;
    const current = toLingoString(member.text ?? '');
    let next = current;
    if (keyCode === 8) next = current.slice(0, -1); // backspace
    else if (key.length === 1 && keyCode >= 32) next = current + key; // printable character
    if (next !== current) {
      this.setMemberProp(new LMemberRefClass(member.number, member.name, member.kind, member.castLibNumber, this), 'text', next);
    }
    this._stopEventPending = false; // U119: key chain over, don't leak the flag
  }

  /** Call a handler on every behavior instance attached to a sprite channel. */
  private dispatchToChannelHandlers(channel: number, handler: string, args: LVal[]): void {
    if (channel <= 0 || channel >= this.channels.length) return;
    const list = this.channels[channel].scriptInstanceList;
    if (!(list instanceof LList)) return;
    for (const item of list.items) {
      if (this._stopEventPending) break; // a lower behavior called stopEvent()
      if (item instanceof LObjectClass) this.interp.callObjectHandler(item, handler, args);
    }
  }

  getChannel(n: number): Channel {
    while (this.channels.length <= n) this.channels.push(new Channel(this.channels.length));
    return this.channels[n];
  }

  /** Director 6+ "slot number" for a member: (castLib << 16) | member. Unique
   *  across casts even with >999 members — the old castLib*1000+local scheme
   *  collided and messenger buttons resolved to the wrong cast's art. Matches
   *  DirPlayer get_cast_slot_number. */
  private memberGlobalNum(castLib: number, member: number): number {
    return (castLib << 16) | (member & 0xffff);
  }

  getmemnum(name: string): number {
    const lower = name.toLowerCase();
    for (const v of this.nameVariants(lower)) {
      for (const cast of this.casts) {
        const member = cast.byName.get(v);
        if (member) {
          // SPARK_DIAG: log every _small/_sd resolution with the member's cast
          // so a repro shows which slot's art a lookup lands on (enable with
          // window.SPARK_DIAG = 1 before reproducing).
          if (this.diagOn() && /(_small|_sd)$/i.test(name)) {
            const img = this.memberImage(member);
            this.log(`DBG getmemnum("${name}") -> (${cast.number}<<16|${member.number}) name="${member.name}" art=${img?.width ?? '?'}x${img?.height ?? '?'} [${this.interp.callTrail.slice(-3).join(' <- ')}]`);
          }
          return this.memberGlobalNum(cast.number, member.number);
        }
      }
    }
    return 0;
  }

  /** SPARK_DIAG diagnostics — enable with `window.SPARK_DIAG = 1` before
   *  reproducing. Logs furniture _small/_sd resolutions + bin member churn so
   *  a repro shows which slot/art a lookup lands on. */
  private diagOn(): boolean {
    return !!(globalThis as { SPARK_DIAG?: unknown }).SPARK_DIAG;
  }

  private diagLog(msg: string): void {
    if (this.diagOn()) (typeof console !== 'undefined' ? console.log : null)?.('[SPARK_DIAG] ' + msg);
  }

  memberFor(ref: LMemberRef): Member | null {
    return this.membersByGlobal.get(this.memberGlobalNum(ref.castLibNumber, ref.number)) ?? null;
  }

  /** Ink 9 (Mask): the sprite renders through a mask bitmap. Room authors
   *  named masks "vesi" -> "vesimask" in the SAME cast (vesi1 -> vesimask1),
   *  which holds for every ink-9 room; Director's generic rule is "the next
   *  cast member", used as the fallback. Null when neither finds a bitmap —
   *  the sprite renders unmasked. */
  private ink9MaskFor(member: Member): Member | null {
    const cast = this.casts[member.castLibNumber - 1];
    if (!cast) return null;
    const maskName = member.name.toLowerCase().replace('vesi', 'vesimask');
    if (maskName !== member.name.toLowerCase()) {
      const byName = cast.byName.get(maskName);
      if (byName && byName.kind === 'bitmap' && byName.raw) return byName;
    }
    const next = cast.members.get(member.number + 1);
    if (next && next.kind === 'bitmap' && next.raw) return next;
    return null;
  }

  // ------------------------------------------------------------ InterpreterHost

  log(msg: string): void {
    this.logs.push(msg);
    if (this.logs.length > 4000) this.logs.splice(0, 2000);
    // U79 DIAG: boot-order diagnostics must survive the #log window's line
    // cap — mirror them to the devtools console where history is kept.
    if (msg.startsWith('DBG ')) {
      (typeof console !== 'undefined' ? console.log : null)?.(msg);
    }
  }

  warn(msg: string): void {
    const trail = this.interp?.callTrail?.slice(-6).join(' <- ');
    this.log(trail ? `[warn] ${msg} [${trail}]` : `[warn] ${msg}`);
  }

  getMember(number: number, castLibNumber?: number): LMemberRef | null {
    // Resource Manager stores NEGATIVE numbers for `*` alias lines (a
    // direction variant pointing at another alias); Director resolves
    // member(-n) to member(n), so normalize before lookup or *-aliased
    // furniture variants fail their art lookup.
    if (number < 0) number = -number;
    if (castLibNumber !== undefined) {
      const cast = this.casts[castLibNumber - 1];
      const member = cast?.members.get(number);
      return member ? new LMemberRefClass(member.number, member.name, member.kind, member.castLibNumber, this) : null;
    }
    const member = this.membersByGlobal.get(number);
    if (member) return new LMemberRefClass(member.number, member.name, member.kind, member.castLibNumber, this);
    // Cast-local fallback: FUSE passes member(x).number (cast-local) to
    // field()/member(). Prefer the currently running script's cast so two
    // casts with the same local numbers don't cross-wire. member(0) is
    // Director's empty "default member" — never a real lookup.
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
      // Skip unnamed members: removeMember renames bitmap bin members to EMPTY
      // before recycling their numbers, and windows leave ~50 such members
      // behind on close — they still carry the window's GUI art, so a bare
      // local-number scan landing on one would show that art in place of the
      // caller's member (a sound-machine GUI sprite on a furniture shadow).
      if (local && local.name) {
        return new LMemberRefClass(local.number, local.name, local.kind, local.castLibNumber, this);
      }
    }
    // Stale slot-encoded number: the corpus's pAllMemNumList can hold
    // (castLib<<16)|member from a slot that has since been recycled or
    // released (dynamic cast slots move between rooms). Re-resolve through the
    // slot's last known cast name to the CURRENT holder of that cast.
    const m = this.memberForStaleSlotNumber(number);
    if (m) return new LMemberRefClass(m.number, m.name, m.kind, m.castLibNumber, this);
    return null;
  }

  /** Stale (castLib<<16)|member number -> the member with that local number
   *  in the CURRENT holder of the cast that last lived in that slot (see
   *  slotLastCast). Keeps stale pAllMemNumList values resolving across slot
   *  churn instead of VOIDing. */
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

  /** U67: resolve a paletteRef value to its RGB table so `image.paletteRef =
   *  <palette>` can remap 8-bit pixels (window chrome recoloring). Layouts
   *  name palettes with spaces ("interface palette_messenger") while member
   *  names use underscores — nameVariants reconciles. Symbols name built-ins
   *  (#grayscale); member refs point at palette members. Null = no remap. */
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
      // Space/underscore/hyphen tolerant fallback for odd layout spellings.
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
      // Director accepts a member number anywhere a member ref goes.
      const ref = this.getMember(Math.round(value));
      if (ref) member = this.memberFor(ref);
    } else if (value instanceof LSymbol) {
      if (String(value.name).toLowerCase() === 'grayscale') return GRAYSCALE_PALETTE;
      return null;
    }
    return member?.palette ?? null;
  }

  /** Director `memberExists(nameOrNum)` — TRUE when a cast member with that
   *  name (all casts, underscore/space tolerant) or movie-global number
   *  exists. The Layout Parser gates every window-def parse on it, and Text
   *  Manager's dump() gates the System Props bootstrap. */
  memberExists(v: number | string): boolean {
    if (typeof v === 'number') return this.getMember(Math.round(v)) !== null;
    return this.getMemberByName(v) !== null;
  }

  /** Director treats spaces and underscores in member names as equivalent.
   *  Names may mix both (corpus `"pool_a Class"` vs stored `"pool a class"`),
   *  so every combination is generated: as-is, all-underscore, all-space. */
  private nameVariants(lower: string): string[] {
    const out = [lower];
    const spaced = lower.replaceAll('_', ' ');
    const underscored = lower.replaceAll(' ', '_');
    if (spaced !== lower) out.push(spaced);
    if (underscored !== lower) out.push(underscored);
    if (spaced !== lower && underscored !== lower) out.push(underscored.replaceAll('_', ' '));
    return out;
  }

  /** Director `new(#field, castLib(n))` — create a dynamic cast member. */
  newMember(kind: MemberKind, castLibNumber: number): LMemberRef | null {
    const cast = this.casts[castLibNumber - 1] ?? this.casts[0];
    if (!cast) return null;
    // Next free cast-local number.
    let number = 1;
    while (cast.members.has(number)) number++;
    const member = new Member(cast.number, number, '', kind);
    cast.members.set(number, member);
    this.membersByGlobal.set(this.memberGlobalNum(cast.number, number), member);
    return new LMemberRefClass(number, member.name, member.kind, member.castLibNumber, this);
  }

  /** Director `createMember(name, #kind[, castLib])` — a named dynamic member;
   *  returns the movie-global member number (the clouds create theirs this
   *  way). */
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

  /** Lazily create a castlib by name — the original movie had scratch casts
   *  (e.g. `bin`) that aren't in the export, and Director code expects
   *  `castLib("bin")` to resolve so dynamic members can be created there. */
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

  /** Director `getWindowIdList()` — ids of all open windows. */
  getWindowIdList(): string[] {
    return [...this.windows.keys()];
  }

  getStage(): LStageRef {
    return new LStageRefClass(this.stageWidth, this.stageHeight);
  }

  /** Persistent stage-sized RGBA surface (Director `(the stage).image`). */
  stageImage(): LImage {
    if (!this._stageImage) this._stageImage = new LImage(this.stageWidth, this.stageHeight);
    return this._stageImage;
  }

  /** Stage background as an LColor (Director `(the stage).bgColor`). */
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
        // Web embed: the moviePath is the movie's own directory URL (embed.ts
        // sets it with a trailing slash). The corpus checks `contains "http://"`
        // to decide on cache-busting, so keep it the honest URL, no `file:`.
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
        case 'keycode': return this.lastKeyCode;
        case 'keydown': return this.keyDownActive ? 1 : 0;
        case 'keyup': return this.keyDownActive ? 0 : 1;
        case 'lastkey': return this.lastKey;
        case 'floatprecision': return this.floatPrecision;
        // DirPlayer movie.rs:307 — `the maxInteger` = i32::MAX. Gamesystem
        // CIterateSeed 0025:52/54 does `float(the maxinteger) * 2 + 2 + n` and
        // `bitOr((n + the maxinteger + 1) / power(2, s), ...)`; String Services
        // explode (0036:116) uses it as the no-limit bound. Unsupported → VOID
        // broke the wire-seed PRNG (float(VOID)*2 = 0 → seed 2+n instead of
        // 4294967296+n).
        // DirPlayer movie.rs parity: `the maxInteger` = i32::MAX. The
        // Gamesystem wire-seed PRNG and String Services explode() rely on it
        // (VOID broke the seed math: float(VOID)*2 = 0).
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
          // Director `the xtraList` — the installed Xtras as a list of
          // proplists ({#name, #fileName, ...}). LibreShockwave XtraManager
          // toDirectorXtraListName: the Multiuser Xtra registers in the
          // xtraList under its 8.3 name "Multiusr" (fileName "Multiusr.x32").
          // FUSE's Special Services checkForXtra contains-matches #name FIRST
          // (fileName only when #name is VOID), and Connection Instance
          // connect() gates the WHOLE multiuser handshake on
          // `checkForXtra("Multiusr")` — without a matching #name the client
          // fatals to the client_error page before ever connecting.
          const xtras = new LList([
            new LPropListClass(new PropPairs([['name', 'Multiusr'], ['fileName', 'Multiusr.x32']])),
          ]);
          return xtras;
        }
        case 'environment': {
          // Director `the environment` — the movie-environment proplist; the
          // Error Manager's fatal report reads #productVersion /
          // #productBuildVersion / #osVersion off it.
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
        // Director `the milliseconds` is the full ms clock (openView computes
        // `pViewMaxTime - (the milliSeconds - pViewOpenTime)` over a 500ms
        // window). The old `% 1000` wrapped every second, so openView's
        // countdown never reached 0 and the entry sign animation never ran.
        // Full ms clock (openView computes a countdown window from it — the
        // old % 1000 wrap made the entry sign animation never run).
        case 'milliseconds': return Date.now();
        case 'timer': return Date.now() - this.timerStart;
        default:
          this.warn(`the ${head}: unsupported property`);
          return VOID;
      }
    }
    if (h === 'count' && chain.length === 1) {
      // `the count of tList` — the parser stores a bare ident subject as the
      // segment *name* (arg stays undefined), so fall back to an ident lookup.
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
        // `the number of castLib("name")` — the castLib number of a named cast.
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
          // Director numbers are dense 1..N, but our bundles keep the original
          // (possibly sparse) numbering — preIndexMembers loops `repeat with i
          // = 1 to the number of castMembers` and would skip any member
          // numbered above the count (cloud_0_right #45 was never indexed).
          // Return the max number so the whole range is visited; gaps resolve
          // to VOID and the corpus's `length(name) > 0` guard skips them.
          const c = this.casts[cast.number - 1];
          let max = 0;
          if (c) for (const num of c.members.keys()) if (num > max) max = num;
          return max;
        }
        return 0;
      }
      if (name === 'lines' || name === 'items' || name === 'words' || name === 'chars') {
        // `the number of lines of tStr` — subject may be stored as name (bare
        // ident) or arg (any expression); fall back to ident lookup.
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
    // Bare-ident subjects (`the pItemList of me`) are stored without an arg —
    // the identifier lives in seg.name; fall back to an ident lookup.
    const subjectE = seg0.arg ?? (chain.length === 1 ? { kind: 'ident', name: seg0.name } as Expr : undefined);
    if (subjectE) {
      const subject = this.evalExprNode(subjectE);
      if (subject instanceof LMemberRefClass) {
        // `the name of member(n)`, `the type of member("X")`, etc.
        return this.getMemberProp(subject, head);
      }
      if (h === 'image' && subject instanceof LMemberRefClass) {
        const member = this.memberFor(subject);
        return member ? this.memberImage(member) : new LImage(0, 0);
      }
      if (subject instanceof LSpriteRefClass) {
        // `the locH of the pSprite of me` (Image Wrapper drag offset math
        // 0058:179) — the element's pSprite is a sprite REF; read any sprite
        // property off it (locH/locV/width/height/visible/member/...).
        return this.getSpriteProp(subject, head);
      }
      if (subject instanceof LImage) {
        // `the rect of the pimage of me` (Purse Image Wrapper clearBuffer
        // 0058) and `the depth of pimage` (Navigator getProperty on a Unique
        // Element) — the window buffers are 8-bit `image(w,h,8,tPalette)`.
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
        // `the pItemList of me` — object property read, walking #ancestor
        // (declaration-based ownership, mirroring me.pItemList). FUSE's
        // Manager Template gates exists() on this.
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
        // `the connection of tMsg` — FUSE message structs (struct.message =
        // [#subject, #content, #connection, #ilk:#struct]) are propLists whose
        // #connection prop holds the Connection Instance; the Login Handler's
        // handleHello does `the connection of tMsg.send("INIT_CRYPTO")` — the
        // struct's connection is the sender. Keys are stored normalized (keyOf).
        const k = subject.props.has(head) ? head : subject.props.has(h) ? h : undefined;
        return k !== undefined ? subject.props.get(k) ?? VOID : VOID;
      }
      if (subject instanceof LCastLibRefClass) {
        // `the number of tCast` — a castLib object's own castLib number. The
        // Dynamic Downloader reads it to size its member-copy loop; VOID made
        // tLast=0 and the bin cast stayed empty (furniture PH boxes).
        if (h === 'number') return subject.number;
        if (h === 'name') return subject.name;
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
        // Director: a boolean flag; the corpus only ever sets it to 0.
        this.traceScript = asNum(value) === 0 ? 0 : 1;
        return;
      case 'tracelogfile':
        this.traceLogFile = toLingoString(value);
        return;
      case 'activewindow':
        // Director `set the activeWindow to window "X"` — the ref's name is
        // its id; an unknown id falls back to the stage window.
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
        // Director: `the keyboardFocusSprite = spriteNum` routes keystrokes to
        // the focused editable field (Field Wrapper setFocus 1/0).
        this.keyboardFocusSprite = Math.max(0, Math.round(asNum(value)));
        return;
      case 'mousev':
      case 'title':
        return; // benign no-ops (stage/window title)
      case 'floatprecision':
        this.floatPrecision = Math.max(0, Math.min(255, Math.round(asNum(value))));
        return;
      case 'shiftdown':
      case 'optiondown':
      case 'commanddown':
      case 'controldown':
        // Director key-state props are read-only (they mirror the keyboard);
        // the corpus only ever reads `the shiftDown` / `the optionDown`.
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
    // Script names come from filenames (Object_Manager_Class) but scripts
    // address them with spaces (script "Object Manager Class") — and may mix
    // both ("pool_a Class"), so try every space/underscore combination.
    for (const v of this.nameVariants(lower)) {
      const hit = this.scriptsByName.get(v);
      if (hit) return hit.script;
    }
    return null;
  }

  resolveScriptByNumber(number: number): Script | null {
    // Global getmemnum (Director slot: (castLib<<16)|member) or a cast-local member number.
    const member = this.membersByGlobal.get(number);
    if (member?.script) return member.script;
    for (const cast of this.casts) {
      const local = cast.members.get(number);
      if (local?.script) return local.script;
    }
    // Stale slot-encoded number (see memberForStaleSlotNumber): re-resolve
    // through the slot's last known cast name to the current holder of that
    // cast.
    return this.memberForStaleSlotNumber(number)?.script ?? null;
  }

  itemDelimiter(): string {
    return this.itemDelim;
  }

  /** The FUSE Variable Container instance (if constructed) via gCore's pObjectList. */
  private variableContainer(): LObjectClass | null {
    const core = this.globals.get('gcore');
    if (!(core instanceof LObjectClass)) return null;
    const pObjectList = core.props.get('pObjectList');
    if (!(pObjectList instanceof LPropListClass)) return null;
    const vm = pObjectList.props.get('variable_manager');
    return vm instanceof LObjectClass ? vm : null;
  }

  /** pItemList lives on an ANCESTOR of the container (Manager Template), so
   *  walk the #ancestor chain (declaration-based, like me.pItemList does). */
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

  /** globalGet with an already-lowercased key (InterpreterHost.globalGetLower
   *  — evalIdent computes the key once instead of lowercasing per call). The
   *  FUSE Variable Container mirror keeps ORIGINAL-case keys (globalSet
   *  mirrors with the name as written), so it is probed with `name` exactly
   *  as globalGet did — only the engine-globals map is keyed lowercase. */
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
    // Mirror into the FUSE Variable Container's pItemList (ancestor chain) so
    // script-side reads (getVariableManager().GET / exists / getInt) see the
    // same values — this is how dumped external_variables.txt lines become
    // real variables.
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

  /** `startTimer()` builtin: reset `the timer` clock. */
  resetTimer(): void {
    this.timerStart = Date.now();
  }

  memberMethod(m: LMemberRef, name: string, args: LVal[]): LVal {
    void args;
    const lower = name.toLowerCase();
    if (lower === 'erase') {
      // Director `member(n).erase()` deletes the cast member. FUSE uses it to
      // clean up temp field members after dumping (removeMember).
      const cast = this.casts[m.castLibNumber - 1];
      if (cast) {
        cast.members.delete(m.number);
        cast.byName.delete(m.name?.toLowerCase());
        this.membersByGlobal.delete(this.memberGlobalNum(m.castLibNumber, m.number));
        // Purge script registrations so erased script members can't still resolve.
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
      // Director `member(n).duplicate(targetRef)` copies the member's media
      // into the target member. Layout Parser parse_window uses it for palette
      // duplicates: member(tPalMemNum).duplicate(createMember(...)) where
      // createMember RETURNS A NUMBER — Director accepts a member number
      // anywhere a member ref goes. Without this the bin palette duplicate
      // never received the table and paletteRef remaps found no source colors.
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
      return 1; // no-op without a usable source/target (lenient like Director)
    }
    // Director text-layout: charPosToLoc(charIndex) -> the char's point;
    // locToCharPos(point) -> the 1-based char at a location. Text Wrapper
    // sizes centered text with `charPosToLoc(char.count).locH + 16` — a stub
    // point(0,0) collapsed header/button text to a 16px box and pushed it
    // left, so real measurement is required.
    if (lower === 'charpostoloc') return this.charPosToLoc(m, args);
    if (lower === 'loctocharpos') return this.locToCharPos(m, args);
    this.warn(`member(${m.number}).${name}(): stub`);
    return VOID;
  }

  /** Director `member(n).charPosToLoc(i)` — the 1-based char position's point
   *  in the member's coordinate space. Text Wrapper sizes centered text with
   *  `charPosToLoc(char.count).locH + 16`, so this must return the real
   *  measured text width (matching the rasterizer's canvas font). */
  private charPosToLoc(m: LMemberRef, args: LVal[]): LVal {
    const member = this.memberFor(m);
    if (!member) return new LPointClass(0, 0);
    const text = member.text ?? '';
    const size = Math.max(1, Math.round(asNum(member.fontSize ?? 0) || 12));
    // Must match rasterizeTextMember's Director line layout: step =
    // fixedLineSpace + topSpacing, first line at topSpacing.
    const fixed = Math.round(asNum(member.fixedLineSpace ?? 0) || 0);
    const topSpacing = Math.max(0, Math.round(asNum(member.textProps?.get('topspacing') ?? 0) || 0));
    const lineH = fixed > 0 ? fixed + topSpacing : Math.max(1, size);
    const charIndex = Math.max(1, Math.round(asNum(args[0])));
    const lines = text.split(/\r\n|\r|\n/);
    // find the natural line containing charIndex (1-based, +1 per line break)
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
    // alignment offset (center/right) matches DirPlayer/C++ alignmentOffset:
    // the member's rect width is the field width when alignment is set.
    const rectW = member.rect ? Math.round(member.rect.width) : 0;
    const align = alignmentName(member.alignment);
    const lineW = this.measureTextWidth(member, line);
    let startX = 0;
    if (align === 'center' && rectW > 0) startX = Math.max(0, (rectW - lineW) / 2);
    else if (align === 'right' && rectW > 0) startX = Math.max(0, rectW - lineW);
    // v matches the rasterizer's vertical glyph inset so the location API and
    // painted pixels agree.
    const topInset = topSpacing > 0 ? topSpacing : Math.max(1, Math.round((lineH - size) / 2));
    return new LPointClass(Math.round(startX + prefixW), topInset + lineIdx * lineH);
  }

  /** Director `member(n).locToCharPos(point)` — 1-based char index at a
   *  location (used by Icon Button hit-testing). */
  private locToCharPos(m: LMemberRef, args: LVal[]): LVal {
    const member = this.memberFor(m);
    if (!member) return 0;
    const text = member.text ?? '';
    const size = Math.max(1, Math.round(asNum(member.fontSize ?? 0) || 12));
    // Must match rasterizeTextMember's Director line layout.
    const fixed = Math.round(asNum(member.fixedLineSpace ?? 0) || 0);
    const topSpacing = Math.max(0, Math.round(asNum(member.textProps?.get('topspacing') ?? 0) || 0));
    const lineH = fixed > 0 ? fixed + topSpacing : Math.max(1, size);
    const pt = args[0] instanceof LPointClass ? args[0] : null;
    const targetX = pt ? pt.locH : 0;
    const targetY = pt ? pt.locV : 0;
    const topInset = topSpacing > 0 ? topSpacing : Math.max(1, Math.round((lineH - size) / 2));
    const lines = text.split(/\r\n|\r|\n/);
    const lineIdx = Math.min(Math.max(0, Math.floor((targetY - topInset) / lineH)), lines.length - 1);
    const line = lines[lineIdx] ?? '';
    // count chars until the running width reaches targetX
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

  /** Measure a text member's string width with the same canvas font the
   *  rasterizer uses (browser); headless (no document) falls back to a
   *  proportional estimate so probes/tests still produce sane values. */
  private measureTextWidth(member: Member, text: string): number {
    if (text.length === 0) return 0;
    const size = Math.max(1, Math.round(asNum(member.fontSize ?? 0) || 12));
    if (typeof document === 'undefined') return Math.round(text.length * size * 0.6);
    try {
      const { family, weight } = cssFontFor(member.font);
      const style = fontStyleFlags(member.fontStyle);
      const effWeight = style.bold ? '700' : weight;
      // reuse one 2D context — Text Wrapper calls this in layout loops
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

  /** Sprite methods. FUSE's Sprite Manager calls sprite(n).setID(...) when
   *  wiring event agents; Director sprites expose properties, not methods, so
   *  only the known FUSE sprite API is stored — unknown calls still warn so
   *  typos stay debuggable. */
  spriteMethod(s: LSpriteRef, name: string, args: LVal[]): LVal {
    const lower = name.toLowerCase();
    // Director dispatches EVERY sprite message to the sprite's behavior
    // scripts (scriptInstanceList) first. FUSE wires an Event Broker there and
    // relies on this for `tsprite.setID(tid)` (the broker's redirectEvent
    // passes its `id` as the element id) and `tsprite.registerProcedure(VOID,
    // windowID, VOID)` (buildVisual fills the broker's pProcList — the click
    // chain).
    this.dispatchToChannelHandlers(s.channel, lower, args);
    if (lower === 'setid' || lower === 'setid2') {
      this.setSpriteProp(s, 'id', args[0] ?? VOID);
      return VOID;
    }
    if (lower === 'getid') return this.getSpriteProp(s, 'id');
    // Director/FUSE sprite API: setcursor is a UI nicety (no-op);
    // registerProcedure/unregisterProcedure wire FUSE's window event agents
    // (Window Instance buildVisual calls tsprite.registerProcedure(VOID,
    // me.getID(), VOID) on every element sprite) — bridge to the engine event
    // bus when the target object resolves, else stay silent.
    if (lower === 'setcursor' || lower === 'setcursor2') return VOID;
    if (lower === 'setmember') {
      // Director sprite API: `sprite(n).setMember(member)` = `sprite(n).member =
      // member`. FUSE's flashMessengerIcon swaps the room-bar messenger icon
      // this way (Room Interface 0008:1088), and the room pool/park scripts
      // swap fountain/lift-door members the same way.
      this.setSpriteProp(s, 'member', args[0] ?? VOID);
      return VOID;
    }
    if (lower === 'registerprocedure' || lower === 'unregisterprocedure') {
      // Keep the engine event-bus bridge too: window objects also use
      // registerProcedure (Login Interface registers #eventProcLogin).
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
    // The window-buffer loading bar reads `getElement("drag").getProperty
    // (#buffer).image` — give elements a buffer wrapper backed by the stage
    // image so that chain yields a real LImage and fill/draw paint pixels
    // instead of warning on VOID.
    const buffer = this.interp.makeInstance(script);
    buffer.lenient = true;
    buffer.props.set('image', this.stageImage());
    obj.props.set('buffer', buffer);
    return obj;
  }

  /** Backend for the image() builtin's 4-arg palette form (Navigator row
   *  backs): `image(w,h,8,member("nav_ui_palette"))` then `paletteIndex(n)`
   *  must resolve against that member's palette — mirror the paletteref
   *  member setter. */
  adoptImagePalette(ref: LMemberRef): void {
    const target = this.memberFor(ref);
    if (target?.palette && target.palette.length > 0) this.currentPalette = target.palette;
  }

  paletteColor(index: number): LColor {
    const pal = this.currentPalette;
    const i = index & 0xff;
    if (pal && pal[i]) {
      const [r, g, b] = pal[i];
      return new LColor(r, g, b);
    }
    // No palette loaded yet — neutral gray (keeps bbinterface/catalogue fill()
    // calls off VOID without asserting a wrong color).
    return new LColor(128, 128, 128);
  }

  /** DirPlayer get_sprite_at parity — the rollover resolves FRESH at the
   *  current mouse position on every read (any visible sprite). The corpus
   *  depends on this being LIVE: validateEvent hides the rollover sprite
   *  (`tSpr.visible = 0`) then reads `sprite(the rollover)` again expecting
   *  the sprite BELOW — the matte-white click-through that passes a click on
   *  furniture art to the tile/wall behind. A cached "last pointer event"
   *  channel re-dispatches to the just-hidden sprite and loops forever (the
   *  hc_tv tile click died exactly that way). */
  rollover(): number {
    return this.spriteAtPoint(this.mouseH, this.mouseV);
  }

  /** DirPlayer `rollover(spriteNum)` — TRUE when the mouse is over THAT
   *  specific sprite, via a direct hit test ignoring whatever is stacked above
   *  it. The E-Dice select checks its LOWER part while the die (upper part)
   *  is under the cursor — the topmost rollover picked the wrong branch. */
  rolloverSprite(n: number): boolean {
    const ch = this.channels[n];
    if (!ch || !ch.member || ch.visible !== 1) return false;
    const w = ch.width ?? ch.member.width;
    const h = ch.height ?? ch.member.height;
    if (w <= 0 || h <= 0) return false;
    if (this.mouseH < ch.left || this.mouseH > ch.right || this.mouseV < ch.top || this.mouseV > ch.bottom) return false;
    return this.spritePixelAccept(ch, w, h, this.mouseH, this.mouseV);
  }

  /** Topmost visible sprite whose rect (and ink-8 matte) contains (x, y). */
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
    // Ties on locZ resolve to the highest channel (previous >= behavior).
    hits.sort((a, b) => (b.z - a.z) || (b.n - a.n));
    for (const hit of hits) {
      const w = hit.ch.width ?? hit.ch.member!.width;
      const h = hit.ch.height ?? hit.ch.member!.height;
      if (this.spritePixelAccept(hit.ch, w, h, x, y)) return hit.n;
    }
    return 0;
  }

  /** DirPlayer matte_pixel_hit_test: ink-8 sprites accept only opaque pixels;
   *  every other ink is rect-clickable. A sprite with no pixels still accepts
   *  (fall back to the bounding box, like DirPlayer's `None => return true`). */
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
    // Evaluate in the interpreter's current environment so `the ... of castLib
    // tVar` style chains can see locals and loop variables.
    return this.interp.evalExpr(expr, this.interp.curEnv ?? new Env());
  }

  // ------------------------------------------------------------ net

  netGetNetText(url: string): number {
    const id = ++this.netId;
    this.net.set(id, { url, done: false, error: 'OK', text: '' });
    this.log(`net: getNetText(${url}) -> #${id}`);
    if (typeof fetch === 'function') {
      // Real HTTP in the browser (or Node >= 18). Relative URLs resolve against
      // the page; failures complete with the error text so the download flow
      // (queueDownload -> dumpVariableField) keeps moving.
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
      // No fetch (older Node): complete quickly with empty text like the stub.
      const req = this.net.get(id);
      if (req) req.framesLeft = 3;
    }
    return id;
  }

  /** Director `getStreamStatus(netId)` — a [#bytesSoFar, #bytesTotal]
   *  proplist (0 bytes while pending, text length once done). The Download
   *  Instance only imports the file when bytesSoFar > 0. */
  getStreamStatus(id: number): LVal {
    const req = this.net.get(Math.round(id));
    if (!req) return VOID;
    let soFar: number;
    let total: number;
    if ((req.bytesTotal ?? 0) > 0) {
      // Real chunked-fetch progress (preloadNetThing plumbed it through): the
      // CastLoad Instance divides bytesSoFar/bytesTotal every frame and feeds
      // the Loading Bar via TellStreamState.
      soFar = Math.min(req.bytesSoFar ?? 0, req.bytesTotal ?? 0);
      total = req.bytesTotal ?? 0;
    } else {
      // Local (preload) downloads carry no text, but the Download Instance
      // only imports when bytesSoFar > 0 — report >= 1 once done so cast loads
      // proceed.
      soFar = req.done ? Math.max(1, req.text?.length ?? 0) : 0;
      total = soFar;
    }
    const status = new Map<string, LVal>([
      ['bytesSoFar', soFar],
      ['bytesTotal', total],
      // The CastLoad Instance gates on `tStreamStatus.error <> EMPTY and
      // <> "OK"`; without this key the read is VOID and every cast download
      // flips to #error and re-queues with a random param forever.
      ['error', req.error ?? 'OK'],
    ]);
    return new LPropListClass(status);
  }

  netDone(id: number | undefined): number {
    // No id: true when the most recent net operation finished (Director
    // semantics) — how Init's exitFrame gates startClient().
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
    // Director canonicalizes fetched text to CR line separators (chr 13) —
    // the corpus parses external_vars.txt with `the itemDelimiter = RETURN`
    // and .line chunks, but HTTP serves LF/CRLF, so normalize here (same
    // contract as text-member loading).
    return normalizeTextLines(this.net.get(id ?? 0)?.text ?? '');
  }

  preloadNetThing(url: string): number {
    // Each real download gets a short artificial ramp so the Loading Bar
    // visibly fills even though the demo's casts are local (a real fetch
    // delivers the whole bundle in one chunk). completeNetRequests advances
    // bytesSoFar each tick; real chunked-fetch bytes replace the ramp; done
    // once the bundle is registered AND the ramp ran out.
    const id = ++this.netId;
    const req = { url, done: false, error: 'OK', text: '', bytesSoFar: 0, bytesTotal: 100, rampFrames: NET_RAMP_FRAMES, awaitingFinish: false };
    this.net.set(id, req);
    this.log(`net: preload(${url}) -> #${id}`);
    const name = this.castNameFromUrl(url);
    if (name && this.bundleLoader) {
      if (this.bundleLoader.getCast(name)) {
        // Already registered (loaded synchronously by an earlier pass): the
        // data is local, nothing to download or animate. Complete immediately
        // with bytes=100 so the Download Instance's bytesSoFar>0 gate passes
        // — the artificial ramp on an already-registered cast was the boot
        // net_done stall (~1.6s of fake download for the movie's own cast).
        req.bytesSoFar = 100;
        req.done = true;
        this.log(`net: done #${id} (${url})`);
      } else {
        // The preload URL carries the CDN path the corpus received (e.g.
        // casts/hof_furni/...cct?randp...) — pass it through so the bundle
        // source can fetch the nested .spark.
        this.bundleLoader.loadCast(name, (soFar, total) => {
          const r = this.net.get(id);
          if (!r || r.done || total <= 0) return;
          r.rampFrames = 0; // real bytes drive from here
          r.bytesSoFar = soFar;
          r.bytesTotal = total;
        }, url).then(() => {
          const r = this.net.get(id);
          if (!r || r.done) return;
          // A load that resolved WITHOUT registering means the bundle fetch
          // missed everywhere. Surface it as an error instead of completing a
          // download that never loaded — the corpus takes the #error path in
          // DoneCurrentDownLoad instead of limping on unloaded.
          if (!this.bundleLoader!.getCast(name)) {
            r.error = `bundle not found for ${name}`;
            r.done = true;
            this.log(`net: error #${id} (${url}): ${r.error}`);
            return;
          }
          r.awaitingFinish = true; // completeNetRequests finishes after the ramp
        }, (e: unknown) => {
          const r = this.net.get(id);
          if (!r || r.done) return;
          r.error = e instanceof Error ? e.message : String(e);
          r.done = true;
          this.log(`net: error #${id} (${url}): ${r.error}`);
        });
      }
    } else {
      // Plain file (catalogue/badge image, ...) — not a cast bundle. Fetch the
      // real bytes so getStreamStatus reports progress and importFileInto can
      // decode them into the member; failures surface as netError so the
      // Download Instance retries instead of importing nothing.
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
        // No fetch (older Node): keep the ramp, then finish.
        req.awaitingFinish = true;
      }
    }
    return id;
  }

  /** Fetch a plain file (image) into a net request: bytes + progress, done on
   *  arrival. Used by preloadNetThing for non-cast URLs. */
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

  /** Mark a preload net request done once its bundle is registered. */
  private completeNetRequest(id: number, url: string): void {
    const req = this.net.get(id);
    if (!req || req.done) return;
    req.done = true;
    this.log(`net: done #${id} (${url})`);
  }

  /** "http://x/hh_interface.cct?r=1" -> "hh_interface"; a bare cast name
   *  passes through. URLs with a NON-cast extension (.gif/.png/.jpg —
   *  catalogue/badge images) return null: they're plain file downloads, so
   *  they must be fetched raw instead of appending .spark like a cast bundle. */
  private castNameFromUrl(url: string): string | null {
    const base = (url.split('?')[0].split('/').pop() ?? '').trim();
    if (!base) return null;
    const m = /^(.+?)\.(cct|cst|cxt)$/i.exec(base);
    if (m) return m[1];
    if (/\.[a-z0-9]{2,5}$/i.test(base)) return null;
    return base;
  }

  /** Director `importFileInto(member, url)`: the Download Instance's import
   *  step for cast files. Routes into the bundle loader — the bundle for the
   *  cast name is already loaded (preloadNetThing kicked it off), so register
   *  it into its casts.txt shell synchronously. */
  importFileInto(member: LVal, url: string): number {
    const name = this.castNameFromUrl(url);
    if (!name) {
      // Plain file (catalogue/badge image): decode the bytes fetched by the
      // preceding preloadNetThing into the member's image surface.
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

  /** Director `importFileInto(member, url)` for a NON-cast file: decode the
   *  downloaded image (PNG/GIF) into the member's image surface so the sprite
   *  renders it. Reuses the bytes from the preceding preloadNetThing request;
   *  fetches on demand when the member was created without one. */
  private importDownloadedImage(memberRef: LVal, url: string): number {
    const member = this.memberFor(memberRef as LMemberRef);
    if (!member) {
      this.warn(`importFileInto: no member for image ${url}`);
      return 0;
    }
    const finish = (bytes: Uint8Array): number => {
      try {
        // Dispatch on signature: PNG (0x89 'PNG') or GIF87a/89a.
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

  /** Run the corpus per-cast index step after a runtime cast fills its shell.
   *  The real client does this in setImportedCast after `tCastLib.name =
   *  tCastName`; it dumps the cast's variable.index / class.index / alias.index
   *  text members into the Variable Manager. Our engine renames the shell
   *  first, so the corpus guard fails and the step never runs without this. */
  private indexCast(castNum: number): void {
    const cast = this.casts[castNum - 1];
    this.log(`DBG indexCast(${castNum} ${cast?.name ?? '?'})`);
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

  /** Un-index a cast from the corpus Resource Manager (mirror of indexCast):
   *  runs the corpus's own `unregisterMembers(castNum)` so names are deleted
   *  from pAllMemNumList BEFORE our maps are wiped. Without this, a cast we
   *  cleared left its (slot<<16)|local numbers behind, and after the slot was
   *  reused by a DIFFERENT cast those stale numbers resolved to the new
   *  occupant's member — the wrong-sprite corruption (a sound-machine GUI
   *  member on furniture shadows after window churn). Silent no-op when the
   *  Resource Manager hasn't been built or the cast was never indexed. */
  private unindexCast(castNum: number): void {
    // Only casts that actually hold members need unregistering (the corpus
    // cache only has entries for indexed members). Skip empty shells: the
    // getresourcemanager handler CONSTRUCTS + REGISTERS the Resource Manager
    // when absent, which at boot flips the Object Manager's create() gate off
    // the working member() fallback and breaks startClient ("Script not
    // found: 0" for every manager it creates).
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

  /** Call gCore.prepareFrame() so managers in the #prepare/#update lists run. */
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
        // Artificial preload ramp (preloadNetThing): advance the synthetic
        // 100-byte download each tick; real bytes (bytesTotal != 100) stop the
        // ramp and drive the numbers directly. Done needs BOTH the real load
        // (awaitingFinish) and the ramp (or just the ramp when synthetic).
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

  // ------------------------------------------------------------ sound

  /** Browser audio host hook (set by the embed). Plays sound-member payloads
   *  through the Web Audio API; headless engines leave it unset and sound
   *  calls stay silent while the corpus's channel bookkeeping still runs. */
  audioHost?: {
    play(channel: number, name: string, raw: Uint8Array, opts: { loop?: boolean; volume?: number; onEnded?: () => void }): void;
    stop(channel: number): void;
    setVolume(channel: number, volume: number): void;
    isBusy(channel: number): boolean;
  };

  /** Per-channel sound state backing `sound(n)` / `puppetSound` (the corpus's
   *  Sound Channel Class wraps this object; the Song Player / Sound Machine
   *  drive loops and queues through it). */
  private soundChannels = new Map<
    number,
    { volume: number; memberRef: LMemberRef | null; memberName: string; loop: boolean; playing: boolean; queue: LList }
  >();

  private soundChannel(channel: number): { volume: number; memberRef: LMemberRef | null; memberName: string; loop: boolean; playing: boolean; queue: LList } {
    let st = this.soundChannels.get(channel);
    if (!st) {
      st = { volume: 255, memberRef: null, memberName: '', loop: false, playing: false, queue: new LList() };
      this.soundChannels.set(channel, st);
    }
    return st;
  }

  /** Resolve a sound member from a member ref / global number / name string
   *  (shared by puppetSound / queueSound / playSoundInChannel). */
  private soundMemberRef(member: LVal): LMemberRef | null {
    return member instanceof LMemberRefClass ? member :
      typeof member === 'number' ? this.getMember(Math.round(member)) :
      typeof member === 'string' ? this.getMemberByName(member) :
      null;
  }

  /** Director `puppetSound(channel, member)` — play a sound member on a
   *  channel immediately (the corpus calls it with a global member number,
   *  e.g. `puppetSound(3, getmemnum("naw_snd_cash"))`). */
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

  /** Director `queueSound member, channel[, props]` — add a sound member to a
   *  channel's playback queue (the Song Player queues whole tracks with
   *  `queueSound(name, channel, [#startTime: ms])`; the startTime is stored on
   *  the entry — the Web Audio host can't seek MP3s, so it plays from the
   *  top, matching the corpus's zero-offset sample slots). */
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

  /** Director `startSoundChannel channel` — begin playing the channel's
   *  queued playlist (Song Player reserveSongChannels / startChannels call it
   *  after queueSound; the queue then advances on each sound's end). */
  startSoundChannelBuiltin(channel: number): number {
    const st = this.soundChannels.get(channel);
    if (st && st.playing) return 1;
    this.advanceSoundQueue(channel);
    return 1;
  }

  /** Director `stopSoundChannel channel` — stop playback and clear the queue. */
  stopSoundChannelBuiltin(channel: number): number {
    this.stopSoundChannel(channel);
    return 1;
  }

  /** Director `playSoundInChannel member, channel` — play immediately; 1 on
   *  success, 0 when the member can't be resolved (the Song Player's
   *  startSamplePreview turns a 0 into an error). */
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
    if (!this.audioHost) {
      this.log(`sound: puppetSound(${channel}, ${name}) (no audio host)`);
      return;
    }
    this.audioHost.play(channel, member.name, member.raw, {
      loop,
      volume: st.volume,
      onEnded: () => this.advanceSoundQueue(channel),
    });
    // SOUND DIAG: every channel play mirrors to the console so a repro shows
    // whether the song path ever starts audio (and what it plays first).
    this.log(`DBG sound: play ch=${channel} "${member.name}" bytes=${member.raw.length} loop=${loop}`);
  }

  /** Director `sound(n)` — the raw sound-channel object. The corpus wraps it
   *  in its Sound Channel Class; methods dispatch through the interpreter's
   *  `sound:` branch to soundChannelMethod. */
  getSoundChannel(channel: number): LVal {
    const script: Script = {
      name: `sound:${channel}`,
      type: 'parent',
      props: [],
      globals: [],
      handlers: [],
      source: '',
    };
    const obj = this.interp.makeInstance(script);
    obj.lenient = true;
    obj.props.set('volume', 255);
    obj.props.set('member', VOID);
    return obj;
  }

  /** Sound-channel method dispatch (interpreter routes `sound:`-named objects
   *  here): play/queue/stop/setPlayList/getPlaylist/isBusy/member/volume. */
  soundChannelMethod(obj: LObject, name: string, args: LVal[]): LVal {
    const chanMatch = /^sound:(\d+)$/.exec(obj.scriptName ?? '');
    const channel = chanMatch ? Number(chanMatch[1]) : 0;
    const lower = name.toLowerCase();
    if (lower === 'volume') {
      // volume is a prop (get/set through the object's value map), not a call
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
        // Director `play()` with no args resumes the channel's current member
        // (Sound Channel Class startPlaying calls `tChannel.play()` bare).
        ref = this.soundChannel(channel).memberRef;
      }
      if (!ref) {
        // A bare play() with a queued playlist STARTS the queue — the Song
        // Player's startSoundChannel -> Sound Channel startPlaying path relies
        // on it to begin the song after queueSound filled the playlist (a
        // plain "no current member" no-op left the sound machine silent).
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

  /** Advance the channel to its next queued sound once the current one ends
   *  (the audio host calls onEnded when a non-looping source finishes). */
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

  /** Director `externalParamValue(paramNameOrNum)` — case-insensitive name or 1-based index. */
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

  // ------------------------------------------------------------ messages & connections

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

  // ------------------------------------------------------------ MemberHost

  /** Persistent per-member `member.image` surface. For raw bitmap members this
   *  is their DECODED pixel data (the Entry Cloud Class reads
   *  `member("cloud1_left").image` as the source for copyPixels compositing);
   *  for in-movie members it is a paintable offscreen surface. */
  /** U66 debug: LImage surface -> owning Member, so copyPixels can name the
   *  source of each element. */
  private imageOwners = new WeakMap<LImage, Member>();

  /** U66 debug (InterpreterHost): "<cast>#<n> \"<name>\"" or "". */
  debugCopyOwner(img: unknown): string {
    if (img instanceof LImage) {
      const m = this.imageOwners.get(img);
      if (m) return `${m.castLibNumber}#${m.number} "${m.name}"`;
    }
    return '';
  }

  private memberImage(member: Member): LImage {
    if (!member.image) {
      // Text/field members rasterize through the host hook (canvas); the
      // result is cached until a text-affecting prop changes (see setMemberProp
      // invalidation), so the shared "visual window text" member re-renders
      // per window even though memberImage caches.
      if (member.kind === 'text' && this.textRasterizer) {
        const img = this.textRasterizer(member);
        if (img) {
          member.image = img;
          this.imageOwners.set(img, member);
          return img;
        }
      }
      if (member.kind === 'bitmap' && member.raw) {
        try {
          const { width, height, rgba, indices } = decodePng(member.raw);
          const img = new LImage(width, height);
          img.data = rgba;
          img.dirty = true;
          // Carry the member's palette so copyPixels' ink-8 matte can match
          // index 0 exactly. The raw indices ride along so the flood matte
          // keys palette INDEX 0 (not the RGB of index 0) — the fuzzy floor
          // tile's white dither squares at other indices must survive
          // createMatte/copyPixels or the black V outlines of tiles behind
          // show through as a grid.
          img.palette = member.palette;
          img.indices = indices ?? null;
          // U101: wall/floor pattern pieces are rainbow test-pattern art in
          // the source; Private Room Engine assigns `member.palette =
          // member(<pattern palette>)` so each piece renders through the
          // pattern's palette. Indexed exports carry the true per-pixel
          // indices (remapPaletteByIndices — the reverse RGB lookup is
          // ambiguous when several indices share a color); older RGBA exports
          // fall back to the index-recovering remapPalette.
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

  /** Director `script(memberRef)` — the Script behind a script-type cast
   *  member. initializeAndRun's vercode gate does `new script(member(5, 1))`:
   *  member 5 of castlib 1 is a Parent script, and script() must hand back its
   *  Script so `new` can instantiate it (was: "unknown script member..." ->
   *  VOID -> getV on VOID -> the check never ran). */
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
        // Director: the number of RETURN-delimited lines in a field member.
        // The Dynamic Downloader iterates `1 to tmember.lineCount` over
        // asset.index to register furniture classes into "Room Classes" —
        // without it, casts not in the static class list fell back to the
        // plain Active Object Class (no states applied).
        return member.kind === 'text' ? (member.text ?? '').split('\n').length : 0;
      case 'number':
        // Director 6+ member numbers are global "slot numbers"
        // ((castLib<<16)|local) — unique across casts even with >999 members,
        // so member(x.number) round-trips to the right cast.
        return this.memberGlobalNum(member.castLibNumber, member.number);
      case 'castlibnum':
        return member.castLibNumber;
      case 'type': {
        // Director reports text members as #field — the Dynamic Downloader
        // switches on `#field` to read asset.index and copy .props to the bin;
        // returning #text made that branch dead and furniture aliases were
        // never registered (every room object fell back to the PH placeholder).
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
        return member.height;
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
        // Director: the duration of a sound member in ms. The SoundMachine
        // Component reads it to size each sample's 2000ms timeline slots — a 0
        // made every sample 1 slot and the song grid collapsed. Frame-walk the
        // MP3 payload for exact ms, but snap durations just over a 2000ms
        // multiple DOWN to that multiple: the corpus's saved song data uses
        // declared slot-multiple durations (2000/4000/...), while the MP3
        // encoder tail runs ~150ms longer — the raw walk pushed the slot count
        // one over and the timeline never filled (room song silent, editor
        // previews fine). Playback is unaffected: channels advance on audio end.
        if (member.kind === 'sound' && member.raw) {
          const ms = mp3DurationMs(member.raw);
          if (ms >= 2000 && ms % 2000 < 200) return ms - (ms % 2000);
          return ms;
        }
        return 0;
      case 'paletteref':
        // The palette member behind an 8-bit bitmap (Element Wrapper reads it
        // while building window elements); the 8-bit pipeline applies it later.
        return member.paletteRef ?? 0;
      default:
        if (member.textProps && member.textProps.has(p)) return member.textProps.get(p)!;
        // Writer/Interface field-member props with Director defaults: silent
        // (0) instead of warn — they're valid member properties in real Lingo.
        // Writer/Interface field-member props with Director defaults: silent
        // (0) instead of warn — they're valid member properties in real Lingo.
        if (MEMBER_TEXT_PROPS.has(p)) return member.textProps?.get(p) ?? 0;
        this.warn(`member(${member.number}).${prop}: unsupported property`);
        return VOID;
    }
  }

  setMemberProp(m: LMemberRef, prop: string, value: LVal): void {
    const member = this.memberFor(m);
    if (!member) return;
    const p = prop.toLowerCase();
    // Any text-affecting prop change invalidates the cached rasterized image
    // so the next member.image read re-renders (the shared "visual window
    // text" member is re-rasterized per window this way).
    const invalidateTextImage = (): void => {
      if (member.kind === 'text') member.image = undefined;
    };
    // Rebuild any channel currently displaying this member so live pixi Text
    // (editable fields) reflects the change immediately — Director native field
    // editing. Without this, dispatchKeyEvent updates member.text but the
    // channel keeps the old glyphs and typing appears to do nothing.
    const rebuildChannels = (): void => {
      if (!this.adapter) return;
      for (let n = 1; n < this.channels.length; n++) {
        const ch = this.channels[n];
        if (ch.member === member) this.buildChannelVisual(ch);
      }
    };
    if (p === 'text') {
      member.text = toLingoString(value);
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
      // Store the text-box rect; real text layout renders from it later.
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
      // Palette member ref behind an 8-bit bitmap (Element Wrapper / room
      // classes assign it; Private Room Engine setFloorPattern does
      // `tSpr.member.paletteRef = member(getmemnum(tPalette))`). Attach the
      // referenced palette's TABLE as paletteTarget (keeping the member's OWN
      // palette as the index source), remap an existing member.image, and
      // rebuild channels showing it so the pattern swap re-renders.
      member.paletteRef = value;
      if (value instanceof LMemberRefClass) {
        const target = this.memberFor(value);
        if (target?.palette && target.palette.length > 0) {
          if (!member.palette || member.palette.length < 2) {
            // No sidecar palette (RGB baked by the export) — the target table
            // still drives the matte key (palette index 0).
            member.palette = target.palette;
          } else {
            member.paletteTarget = target.palette;
          }
          this.currentPalette = target.palette;
          if (member.paletteTarget && member.image) {
            // Index-exact when the raw indices survived (memberImage materializes
            // indexed exports with them): the reverse RGB lookup is ambiguous
            // when several indices share a color (the fuzzy floor tile's white
            // dither squares) and re-mapping an already-remapped surface would
            // scramble the checkerboard. Index remap is idempotent.
            if (member.image.indices) member.image.remapPaletteByIndices(member.image.indices, member.paletteTarget);
            else member.image.remapPalette(member.paletteTarget);
          }
          rebuildChannels();
        }
      }
      return;
    }
    if (p === 'palette') {
      // Visualizer Part Wrapper renderImage sets `tPartMem.palette =
      // member(getmemnum(tPalette))` on the wall/floor pattern bitmaps
      // (Private Room Engine setWallPaper/setFloorPattern). Attach the
      // referenced palette member's TABLE so the member's 8-bit image
      // resolves the right colors for the subsequent copyPixels / createMatte
      // pipeline — previously "set member(x).palette: unsupported" left the
      // pattern images on their own palette and private rooms stalled.
      if (value instanceof LMemberRefClass) {
        const target = this.memberFor(value);
        if (target?.palette && target.palette.length > 0) {
          // U101: keep the member's OWN palette (sidecar .pal — the index
          // source for remapPalette) and store the pattern palette separately;
          // the remap applies when memberImage materializes the surface.
          if (!member.palette || member.palette.length < 2) {
            // U87: no sidecar palette (RGB baked by the export) — the target
            // table still drives the ink-8 matte key (palette index 0).
            member.palette = target.palette;
          } else {
            member.paletteTarget = target.palette;
          }
          member.paletteRef = value;
          this.currentPalette = target.palette;
          if (member.paletteTarget && member.image) {
            // Index-exact remap when raw indices are available (see paletteref).
            if (member.image.indices) member.image.remapPaletteByIndices(member.image.indices, member.paletteTarget);
            else member.image.remapPalette(member.paletteTarget);
          }
        }
      }
      return;
    }
    // Generic text-member props (Writer/Messenger set these on field members).
    if (MEMBER_TEXT_PROPS.has(p)) {
      if (!member.textProps) member.textProps = new Map();
      member.textProps.set(p, value);
      invalidateTextImage();
      return;
    }
    if (p === 'image') {
      if (value instanceof LImage) {
        // Director: `member.image = img` copies the pixel data into the
        // MEMBER's own buffer (Common Button does `pBuffer.image = pimage`
        // then white-fills + copyPixels back on top; a shared reference would
        // wipe pimage too). The copy goes into the member's EXISTING surface,
        // not a fresh object — Entry Cloud captures `pImg = member.image`
        // before assigning and later paints its turn into pImg, so replacing
        // the object would detach the turn (clouds never flip).
        if (!member.image) member.image = new LImage(value.width, value.height);
        else member.image.resize(value.width, value.height);
        member.image.data = new Uint8Array(value.ensure());
        // U78: keep the source art's palette + depth. Image Button pastes
        // `pBuffer.image = pimage` (a duplicate of char.button.left.active,
        // which ships a .pal with index 0 = white); without the palette the
        // ink-8 matte rejects the arrow (its dark outline touches the buffer
        // edges) — leaving a white box behind the arrowhead.
        member.image.palette = value.palette;
        member.image.depth = value.depth;
        member.image.dirty = true;
        this.imageOwners.set(member.image, member);
      }
      return;
    }
    if (p === 'name') {
      const cast = this.casts[member.castLibNumber - 1];
      if (cast) cast.byName.delete(member.name.toLowerCase());
      const prevName = member.name;
      member.name = toLingoString(value);
      if (cast && member.name) cast.byName.set(member.name.toLowerCase(), member);
      // removeMember renames bitmap bin members to EMPTY before recycling their
      // number (pBmpMemNumList reuse). A freed member must not keep its art: the
      // number is handed to the NEXT createMember whose caller expects a blank
      // slate (window element buffers, copyMemberToBin furniture copies) — a
      // lingering LImage/raw would surface as the previous owner's art (see the
      // media-copy clear above). The member is unnamed now, so nothing can
      // legitimately render it until it is renamed + re-painted.
      if (!member.name) {
        if (member.image) this.imageOwners.delete(member.image);
        member.image = undefined;
        member.raw = undefined;
      }
      // Log it so a live repro shows which members got freed into the reuse
      // pool and which art they carried.
      if (this.diagOn() && !member.name && prevName && cast) {
        this.diagLog(`rename-to-EMPTY "${prevName}" (cast#${cast.number} local ${member.number}) — number freed for reuse`);
      }
      return;
    }
    if (p === 'regpoint' || p === 'regpointx' || p === 'regpointy') {
      // Director: member.regPoint = point(x, y) — the registration point the
      // sprite centers on (Window Instance buildVisual sets point(0,0) on
      // every element member).
      if (p === 'regpoint' && value instanceof LPointClass) {
        member.regX = value.locH;
        member.regY = value.locV;
      } else if (p === 'regpointx') member.regX = Math.round(asNum(value));
      else if (p === 'regpointy') member.regY = Math.round(asNum(value));
      return;
    }
    if (p === 'media') {
      // Dynamic Downloader copyMemberToBin: `tTargetMember.media =
      // tSourceMember.media` duplicates furniture art into the bin cast under
      // its aliased name. Previously a no-op — bin members were created empty
      // and furniture rendered as 0-size sprites even when the name resolved.
      if (value instanceof LMemberRefClass) {
        const src = this.memberFor(value);
        if (src) {
          // The media copy REPLACES the member's entire content: drop any
          // stale surface from a previous life. Bin members are recycled
          // through pBmpMemNumList (windows free their element buffers by
          // renaming them EMPTY), so a furniture copy can land on a number
          // whose member still holds the window's painted LImage — without
          // clearing it the icon/shadow renders the OLD window GUI art (the
          // sound-machine GUI sprite on hand icons / furniture shadows
          // corruption). Symmetrically, a raw-bytes member must not keep them
          // when the copy is image-only (buildChannelVisual prefers raw).
          if (member.image) this.imageOwners.delete(member.image);
          member.image = undefined;
          member.raw = undefined;
          // Field/text members: for a .props/.data/.asset.index field the
          // media IS the text, and the bin copy must carry it or
          // `value(field(getmemnum(pClass & ".props")))` reads an EMPTY
          // member and every furniture's solveInk/solveBlend errors
          // `*.props is not valid!` (inks never apply, on-light renders black
          // instead of additive).
          if (src.kind === 'text' || src.kind === 'script') {
            member.kind = src.kind;
            member.text = src.text;
            member.script = src.script;
          }                  if (src.raw) {
                    // Payload is shared, not copied — safe: PNG bytes are immutable
                    // in the engine (decodePng never mutates its input).
                    member.raw = src.raw;
                    // The .pal companion travels with the media too: the bin
                    // member is what actually RENDERS (getmemnum resolves the
                    // bin copy), and the ink-8/33 matte keys the background by
                    // the member's palette index 0 (DirPlayer get_bg_color_ref)
                    // — without it the bake falls back to edge inference and
                    // can key the wrong color.
                    member.palette = src.palette;
                  }
                  else if (src.image) {
            member.image = src.image;
            this.imageOwners.set(src.image, member);
          }
          // Director: the bitmap's registration point travels with the media.
          // Furniture parts compose at their per-part regPoints, so a bin copy
          // that drops regX/regY pivots every part at (0,0) and they scatter.
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
        // Director sprite.color is an LColor (rgb(...)) — the visualizer reads
        // it back to compare against layout values.
        return intColor(ch.color);
      case 'bgcolor':
      case 'backcolor':
        return intColor(ch.bgColor);
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
        // Director: `ilk(sprite(n))` is #sprite; FUSE compares `pLogoSpr.ilk = #sprite`.
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
        // Director/DirPlayer parity: a member change resets the channel's
        // rotation/skew/flips (castNum keeps transforms so the furniture flip
        // `rotation 180 + skew 180` set BEFORE castNum survives). Without the
        // reset, releaseSprite()'s `tsprite.member = member(0)` leaked a
        // flipped sprite's mirror onto the next user of the channel
        // (navigator sprites randomly flipped after switching tabs).
        if (ch.puppet && ch.member !== member) {
          ch.rotation = 0;
          ch.skew = 0;
          ch.flipH = 0;
          ch.flipV = 0;
        }
        ch.member = member ?? undefined;
        this.notifyChannel(ch);
        return;
      }
      case 'castnum': {
        // Director sprite.castNum = the movie-global member number (Window
        // Instance buildVisual sets tsprite.castNum right after creating each
        // element member). A stale (slot<<16)|local encode falls back through
        // memberForStaleSlotNumber so a cleared cast's number resolves to its
        // CURRENT holder instead of a reused slot's unrelated member.
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
        // VOID (null) resets a sprite to Director's default z-order = channel
        // number (Sprite Manager release does `tsprite.locZ = VOID`).
        ch.locZ = value === null ? ch.number : asNum(value);
        changed = false;
        break;
      case 'ink': {
        // Blend modes apply live via refreshChannel; an ink entering or leaving
        // an alpha-bake mode (1/8/36) must REBUILD so the texture is (re)baked
        // with the white background removed (entry clouds/city set ink in the
        // same burst as castNum, but later ink changes must work too).
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
        // Director stamps spriteNum on attach (Event Broker setID does
        // `pSprite = sprite(me.spriteNum)`); stamp unconditionally so a
        // behavior re-attached to another channel follows it.
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
        // Director sprite.id is a number; FUSE's `tsprite.setID(tid)` passes
        // ELEMENT ids (#login_ok / "login_ok") whose numeric coercion is NaN —
        // keep the channel id numeric and skip non-numeric sets instead of
        // letting NaN pollute it.
        const n = asNum(value);
        if (Number.isFinite(n)) {
          ch.id = Math.round(n);
          changed = false;
        }
        break;
      }
      case 'color':
        // buildVisual sets `tSpr.color = rgb(...)` — an LColor. Store the
        // 0xRRGGBB so the stage can fill shape sprites and getSpriteProp can
        // return an LColor.
        ch.color = this.colorToInt(value);
        ch.colorSet = true;
        changed = false;
        break;
      case 'bgcolor':
      case 'backcolor':
        ch.bgColor = this.colorToInt(value);
        ch.colorSet = true;
        // U78: only REAL RGB colors (rgb() LColor / hex string) tint the
        // bitmap's grayscale pixels (figure-creator swatch = white pixel +
        // `sprite.bgColor = rgb(...)`). Bare ints are palette indices (Entry
        // Car `backColor = random(150)+20`) — stored for parity, never tinted.
        ch.bgColorIsRgb = value instanceof LColor || typeof value === 'string';
        // A live bgColor change must rebuild so the stage re-tints the bitmap;
        // white (Layout Parser default) and palette-index ints stay on the
        // cheap refresh path.
        changed = ch.bgColorIsRgb && ch.bgColor !== 0xffffff;
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
        // Channel rect is derived (loc ± member regpoint), so fold the rect
        // back into loc/width/height. releaseSprite() uses rect(0,0,1,1).
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
        // Sprite cursor is a UI nicety; accepting it silently keeps
        // releaseSprite() clean (FUSE resets cursor on release).
        changed = false;
        break;
      default:
        this.warn(`set sprite(${s.channel}).${prop}: unsupported`);
        return;
    }
    // Only member/castNum (handled above) rebuild the visual; every other prop
    // is read live by the stage adapter on refresh (position, size, blend,
    // ink blend mode), so a rebuild is never needed — per-frame animations
    // (cloud drift, avatar walk, loading bar) must not re-decode textures.
    if (changed) this.notifyChannel(ch);
    else this.refreshSprite(ch);
  }

  /** Coerce a Lingo color-ish value (LColor from rgb(), hex string, int) to
   *  0xRRGGBB. Previously `asNum(value)` silently turned every rgb(...) sprite
   *  color into 0. */
  private colorToInt(v: LVal): number {
    if (v instanceof LColor) return ((v.red & 0xff) << 16) | ((v.green & 0xff) << 8) | (v.blue & 0xff);
    if (typeof v === 'string') {
      const h = hexColor(v);
      if (h) return ((h.red & 0xff) << 16) | ((h.green & 0xff) << 8) | (h.blue & 0xff);
    }
    return Math.round(asNum(v));
  }

  /** Refresh the stage's channel node without rebuilding its visual — the
   *  cheap path for transform/color props (rotation, flip, scale, loc...). */
  private refreshSprite(ch: Channel): void {
    this.adapter?.refreshChannel(ch.number);
  }

  private resolveMember(v: LVal): Member | null {
    if (v instanceof LMemberRefClass) return this.memberFor(v);
    if (typeof v === 'number') {
      // Same stale-encode fallback as castNum above (see memberForStaleSlotNumber).
      return this.membersByGlobal.get(Math.round(v)) ?? this.memberForStaleSlotNumber(Math.round(v)) ?? null;
    }
    if (typeof v === 'string') {
      const ref = this.getMemberByName(v);
      return ref ? this.memberFor(ref) : null;
    }
    return null;
  }

  /** Mark a channel's stage visual dirty; the rebuild is coalesced to a
   *  microtask so a burst of prop sets builds once — the texture load sees the
   *  FINAL member + ink (buildVisual sets castNum then ink in one stack). */
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

  /** Build the stage visual for every dirty channel. Public so tests (and the
   *  headless probe) can flush synchronously. */
  flushChannelVisuals(): void {
    if (!this.adapter) return;
    const dirty = Array.from(this.visualDirty);
    this.visualDirty.clear();
    for (const n of dirty) this.buildChannelVisual(this.getChannel(n));
  }

  /** Rebuild every text-member channel — called by the embed host after its
   *  cast fonts finish loading: a pixi Text built before its FontFace
   *  registered keeps fallback glyphs, so re-pushing rebuilds it with the real
   *  Director font. */
  refreshTextChannels(): void {
    if (!this.adapter) return;
    for (let n = 1; n < this.channels.length; n++) {
      const ch = this.channels[n];
      if (ch.member?.kind === 'text') this.buildChannelVisual(ch);
    }
  }

  private buildChannelVisual(ch: Channel): void {
    if (!this.adapter) return;
    if (ch.member?.kind === 'bitmap' && ch.member.raw) {
      // Ink 9 (Mask): Director uses the NEXT cast member's bitmap as the
      // sprite's grayscale alpha mask. The pool water (vesi1) is masked by
      // vesimask1 — the very next member in hh_room_pool's cast order. Pass
      // the mask's raw PNG + reg point so the stage can bake it into the
      // water's alpha (black=opaque, white=transparent).
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
      // Runtime-created bitmap member (window element buffers, Loading Bar
      // drag): content lives in the painted LImage surface, not raw bytes.
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
      // Live Field Wrapper text renders through Pixi Text, which only breaks
      // lines on LF — member text is stored canonically CR (Director chr 13),
      // so convert CR/CRLF to LF at the display boundary. (The image
      // rasterizer splits on CR itself, so this only affects live channels.)
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

  // ------------------------------------------------------------ castLib props

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
      // Superseded-holder purge: removeTemporaryCast keeps next-room casts
      // loaded, so a room -> room switch re-imports a cast into a DIFFERENT
      // dynamic slot while the old slot keeps the same name AND its old
      // content forever ("the pool fills and never clears"). Name lookups scan
      // in slot order, so the stale holder shadowed the fresh one (dead UI).
      // Assigning a name already held by another slot supersedes that holder:
      // purge its members so lookups resolve against the fresh import.
      // Permanent casts (casts.txt) are never purged.
      const prior = this.castByName.get(newName);
      if (prior && prior !== cast && this.castList && !this.castList.some((e) => e.name === prior.name)) {
        this.log(`cast slot ${prior.number} superseded by "${newName}" (purging ${prior.members.size} members)`);
        this.clearCastMembers(prior);
        prior.loaded = false;
      }
      cast.name = newName;
      // Keep the name index consistent (FindCastNumber iterates .name, but
      // castLib("name") / the number of castLib("name") use castByName).
      if (old && old !== cast.name) this.castByName.delete(old);
      this.castByName.set(cast.name, cast);
      // Dynamic-slot recycle: ResetOneDynamicCast renames a used slot back to
      // "empty N" and re-pools it. Wipe the old members + their global
      // indexes/handlers HERE, immediately — deferring the wipe until the
      // next bundle refill kept the previous room's members visible mid-load
      // and the refill yanked them out from under live objects (DEPTH 25
      // window-recursion loop + dead UI after a couple of room switches).
      if (/^empty\s*\d+$/i.test(newName) && cast.loaded) {
        this.clearCastMembers(cast);
        cast.loaded = false;
        // Drop stale name-index aliases so a wiped shell stops resolving under
        // its old names (dynamic downloads alias the bare cast name to the
        // full-URL-renamed shell); the "empty N" pool marker itself is kept.
        for (const [key, entry] of this.castByName) {
          if (entry === cast && key !== cast.name) this.castByName.delete(key);
        }
      }
      // Runtime cast load: setImportedCast renames an empty shell to the
      // cast's name (`tCastLib.name = tCastName`). Fill the shell from the
      // bundle loader if one is available for that name.
      if (!cast.loaded) {
        const loader = this.bundleLoader;
        // Dynamic downloads pass the FULL CDN URL as the cast name
        // (`http://.../hh_furni_xx_club_sofa.cct`); bundles are keyed by the
        // bare cast name, so also resolve through castNameFromUrl. A URL/path
        // shaped name is the dynamic-download signature — boot casts always
        // use bare names.
        const isDynamicDownload = cast.name.includes('/');
        let manifest = loader?.getCast(cast.name);
        if (!manifest) {
          const bare = this.castNameFromUrl(cast.name);
          if (bare && bare !== cast.name) {
            manifest = loader?.getCast(bare) ?? null;
            // Alias the bare name to THIS (already renamed) shell so
            // registerCast/findCastSlot fills it in place instead of appending
            // a fresh slot — acquireAssetsFromCast reads members from this
            // slot's number, and FindCastNumber matches the full-URL name.
            // Don't shadow an already-loaded holder (same caution as the
            // superseded-holder purge above); stale empty holders get
            // overwritten so the alias self-heals on re-download.
            if (manifest) {
              const holder = this.castByName.get(bare);
              if (!holder || holder === cast || !holder.loaded) this.castByName.set(bare, cast);
            }
          }
        }
        if (manifest) {
          this.registerCast(loader!, manifest);
          // setImportedCast only runs the per-cast index step while the shell
          // is still named "empty N" — we rename it first, so the guard skips
          // and variable.index/class.index/alias.index never get dumped. Run
          // it ourselves — but NOT for dynamic downloads: those import with
          // tDoIndexing=0 so copyMemberToBin's getmemnum(name)=0 gate stays
          // open (pre-indexing registers the md_* names with cast-slot numbers
          // that ResetOneDynamicCast later wipes — `club_sofa.props is not
          // valid!`).
          if (!isDynamicDownload) this.indexCast(cast.number);
        }
      }
    } else if (p === 'filename') cast.fileName = toLingoString(value);
    else this.warn(`set castLib(${c.number}).${prop}: unsupported`);
  }

  /** Wipe a cast slot's members + global indexes (dynamic-slot recycle) so a
   *  reused "empty N" shell can refill with a fresh bundle. Unregisters from
   *  the corpus Resource Manager FIRST (the members must still be readable
   *  for unregisterMembers to find their names) so the corpus's pAllMemNumList
   *  cache never outlives a cast we clear — stale (slot<<16)|local numbers
   *  would resolve to whatever cast later reuses the slot. */
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
        // Global handler registrations for this script must go too, or a
        // recycled room's stale prepare/getManager handlers keep firing
        // against a cleared script (DEPTH 25 window-recursion + dead UI).
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
    // Director: a window's name IS its id — `(window "myWin").name` =
    // "myWin", and `(the activeWindow).name` = "stage" for the main stage
    // window (the Initialization boot guard checks exactly that).
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
}

/** MemberHost re-export (interface declared here for values.ts compatibility). */
export type MemberHostApi = {
  getMemberProp(m: LMemberRef, prop: string): LVal;
  setMemberProp(m: LMemberRef, prop: string, value: LVal): void;
  getSpriteProp(s: LSpriteRef, prop: string): LVal;
  setSpriteProp(s: LSpriteRef, prop: string, value: LVal): void;
  getCastLibProp(c: LCastLibRef, prop: string): LVal;
  setCastLibProp(c: LCastLibRef, prop: string, value: LVal): void;
  getWindowProp(w: LWindowRef, prop: string): LVal;
  setWindowProp(w: LWindowRef, prop: string, value: LVal): void;
};

/** Helper to create a cast manifest from raw entries (tests/demo). */
export function makeCastManifest(name: string, members: MemberEntry[]): CastManifest {
  return { name, members, fonts: [], fontFiles: [], linkedCasts: [] };
}
