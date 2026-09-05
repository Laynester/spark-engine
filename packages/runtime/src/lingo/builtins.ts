import type { Handler, Script } from './ast.js';
import type { Interpreter } from './interpreter.js';
import {
  asNum, duplicateValue, ilkOf, keyOf, rawKeyOf, lingoListCompare, toLingoString, VOID,
  type LVal, type LMemberRef, type LObject, type LSpriteRef, type LStageRef,
  type LWindowRef, type LCastLibRef, LSymbol, LList, LPoint, LPropList, LRect, LImage, LSpriteRef as LSpriteRefClass,
  LColor, colorFrom, hexColor, intColor,
  LMemberRef as LMemberRefClass, LObject as LObjectClass, LScriptRef as LScriptRefClass,
} from './values.js';

const SYSTEM_PALETTE: number[][] = [[255, 255, 255]];

export interface BuiltinBackend {
  log(msg: string): void;
  warn(msg: string): void;
  getMember(number: number, castLibNumber?: number): LMemberRef | null;
  getMemberByName(name: string): LMemberRef | null;
  getMemberByNameInCast(name: string, castLibNumber: number): LMemberRef | null;
  getMemberByImage(image: LImage): LMemberRef | null;
  resetTimer(): void;
  resolvePaletteTable(value: LVal): number[][] | null;
  newMember(kind: string, castLibNumber: number): LMemberRef | null;
  createNamedMember(name: string, kind: string, castLibNumber: number): number;
  getMemberProp(m: LMemberRef, prop: string): LVal;
  getSprite(channel: number): LSpriteRef;
  getCastLib(arg: LVal): LCastLibRef | null;
  getWindow(id: string): LWindowRef | null;
  createWindow(id: string): LWindowRef | null;
  removeWindow(id: string): void;
  windowExists(id: string): boolean;
  getWindowIdList(): string[];
  getStage(): LStageRef;
  globalGet(name: string): LVal | undefined;
  globalSet(name: string, value: LVal): void;
  go(frame: LVal): void;
  resolveScript(name: string): Script | null;
  resolveScriptByNumber(number: number): Script | null;
  makeObject(script: Script): LObject;
  getObjectById(id: string): LObject | null;
  setObjectById(id: string, obj: LObject): void;
  removeObjectById(id: string): void;
  getUniqueId(): string;
  netGetNetText(url: string): number;
  getStreamStatus(id: number): LVal;
  importFileInto(member: LVal, url: string): number;
  netDone(id: number | undefined): number;
  netError(id: number | undefined): string;
  netTextResult(id: number | undefined): string;
  preloadNetThing(url: string): number;
  puppetSound(channel: number, member: LVal): void;
  queueSoundOnChannel(member: LVal, channel: number, props?: LVal): void;
  startSoundChannelBuiltin(channel: number): number;
  stopSoundChannelBuiltin(channel: number): number;
  playSoundInChannelBuiltin(member: LVal, channel: number): number;
  getSoundChannel(channel: number): LVal;
  dispatchMessage(msgName: string, data: LVal): void;
  registerListener(connId: string, objId: string, msgs: LVal): void;
  registerCommands(connId: string, objId: string, cmds: LVal): void;
  unregisterListener(connId: string, objId: string): void;
  getConnection(id: string): LVal;
  connectionExists(id: string): boolean;
  removeConnection(id: string): void;
  getPref(name: string): string;
  setPref(name: string, value: string): void;
  rollover(): number;
  rolloverSprite?(n: number): boolean;
  setRollover(n: number): void;
  paletteColor(index: number): LColor;
  adoptImagePalette(ref: LMemberRef): void;
  setPuppet(channel: number, flag: number): void;
  setFrameTempo(n: number): void;
  timeout(name: string): LObject;
  xtraInstance(name: string): LObject;
  externalParamValue(v: LVal): LVal;
  externalParamCount(): number;
  externalParamName(n: number): LVal;
}

export type BuiltinFn = (b: BuiltinBackend, args: LVal[], interp: Interpreter) => LVal;

function numArgs(args: LVal[], i: number): number {
  return asNum(args[i]);
}

function roundHalfAway(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}


function stripLingoComments(input: string): string {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (ch === '"') inString = false;
      i++;
    } else if (ch === '"') {
      out += ch;
      inString = true;
      i++;
    } else if (ch === '-' && input[i + 1] === '-') {
      while (i < input.length && input[i] !== '\n' && input[i] !== '\r') i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function stripLingoContinuations(input: string): string {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '"') {
      inString = !inString;
      out += ch;
      i++;
    } else if (ch === '\\' && !inString) {
      if (input[i + 1] === '\r' || input[i + 1] === '\n') i++;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function trimUnbalancedBrackets(input: string): string {
  let depthSquare = 0;
  let depthParen = 0;
  let inString = false;
  let lastBalancedEnd = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      if (ch === '"') inString = false;
    } else {
      switch (ch) {
        case '"': inString = true; break;
        case '[': depthSquare++; break;
        case ']': depthSquare--; break;
        case '(': depthParen++; break;
        case ')': depthParen--; break;
      }
    }
    if (depthSquare === 0 && depthParen === 0 && !inString) lastBalancedEnd = i + 1;
  }
  if (depthSquare === 0 && depthParen === 0 && !inString) return input;
  return input.slice(0, lastBalancedEnd);
}

function truncateToFirstBalancedList(input: string): string {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('[')) return input;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '"') {
      inString = !inString;
    } else if (!inString) {
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) return trimmed.slice(0, i + 1);
      }
    }
  }
  return input;
}

export function createBuiltinTable(): Map<string, BuiltinFn> {
  const t = new Map<string, BuiltinFn>();
  const set = (names: string[], fn: BuiltinFn) => {
    for (const n of names) t.set(n.toLowerCase(), fn);
  };

  set(['abs'], (b, a) => Math.abs(numArgs(a, 0)));
  set(['sqrt'], (b, a, interp) => interp.markFloatValue(Math.sqrt(numArgs(a, 0))));
  set(['sqr'], (b, a) => numArgs(a, 0) * numArgs(a, 0));
  set(['power'], (b, a, interp) => {
    const out = Math.pow(numArgs(a, 0), numArgs(a, 1));
    return interp.isFloatValue(a[0]) || interp.isFloatValue(a[1]) ? interp.markFloatValue(out) : out;
  });
  set(['integer'], (b, a, interp) => {
    const v = a[0];
    if (typeof v === 'string') {
      const s = v.trim();
      if (s === '') return 0;
      if (s.length > 1 && s[0] === '*') {
        const hex = parseInt(s.slice(1), 16);
        if (!Number.isNaN(hex) && /^[0-9a-fA-F]+$/.test(s.slice(1))) return interp.clearFloatMark(hex);
        return VOID;
      }
      if (/^[+-]?\d+$/.test(s)) return interp.clearFloatMark(parseInt(s, 10));
      if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return interp.clearFloatMark(roundHalfAway(Number(s)));
      return VOID;
    }
    return interp.clearFloatMark(roundHalfAway(numArgs(a, 0)));
  });
  set(['float'], (b, a, interp) => interp.markFloatValue(numArgs(a, 0)));
  set(['trunc'], (b, a, interp) => interp.clearFloatMark(Math.trunc(numArgs(a, 0))));
  set(['random'], (b, a) => {
    const n = Math.floor(numArgs(a, 0));
    return n <= 0 ? 0 : 1 + Math.floor(Math.random() * n);
  });
  set(['min'], (b, a, interp) => {
    const vals = a.length === 1 && a[0] instanceof LList ? a[0].items : a;
    if (!vals.length) return 0;
    const nums = vals.map((v) => numArgs([v], 0));
    const out = Math.min(...nums);
    return vals.some((v) => interp.isFloatValue(v)) ? interp.markFloatValue(out) : out;
  });
  set(['max'], (b, a, interp) => {
    const vals = a.length === 1 && a[0] instanceof LList ? a[0].items : a;
    if (!vals.length) return 0;
    const nums = vals.map((v) => numArgs([v], 0));
    const out = Math.max(...nums);
    return vals.some((v) => interp.isFloatValue(v)) ? interp.markFloatValue(out) : out;
  });
  set(['bitAnd'], (b, a) => Math.round(numArgs(a, 0)) & Math.round(numArgs(a, 1)));
  set(['bitOr'], (b, a) => Math.round(numArgs(a, 0)) | Math.round(numArgs(a, 1)));
  set(['bitXor'], (b, a) => Math.round(numArgs(a, 0)) ^ Math.round(numArgs(a, 1)));
  set(['bitNot'], (b, a) => ~Math.round(numArgs(a, 0)));
  set(['sin'], (b, a) => Math.sin((numArgs(a, 0) * Math.PI) / 180));
  set(['cos'], (b, a) => Math.cos((numArgs(a, 0) * Math.PI) / 180));

  set(['updatestage'], () => VOID);
  set(['beep'], () => VOID);
  set(['cursor'], () => VOID);
  set(['dontpassevent'], () => VOID);
  set(['starttimer'], (b) => {
    b.resetTimer();
    return VOID;
  });
  set(['gotonetpage'], (b, a) => {
    const url = toLingoString(a[0] ?? VOID);
    const target =
      a[1] === undefined ? '_blank' :
        a[1] instanceof LSymbol ? a[1].name :
          toLingoString(a[1]);
    const g = globalThis as { open?: (u: string, t: string) => unknown };
    if (url !== '' && typeof g.open === 'function') {
      try { g.open(url, target); } catch {  }
    } else {
      b.log(`gotoNetPage(${url}, ${target})`);
    }
    return VOID;
  });
  set(['callancestor'], (b, a, interp) => {
    const handlerName = a[0] instanceof LSymbol ? a[0].name : toLingoString(a[0]);
    const target = a[1];
    const rest = a.slice(2);
    const targets = target instanceof LList ? target.items : [target];
    const currentScript = interp.currentScript;
    let last = VOID;
    for (const t of targets) {
      if (!(t instanceof LObjectClass)) continue;
      let cur = t.props.get('ancestor');
      let found: { script: Script; handler: Handler } | null = null;
      let hops = 0;
      while (cur instanceof LObjectClass) {
        const h = cur.handlers.get(handlerName.toLowerCase());
        if (h && cur.script && cur.script !== currentScript) { found = { script: cur.script, handler: h }; break; }
        if (++hops > 32) break;
        const next = cur.props.get('ancestor');
        cur = next instanceof LObjectClass ? next : null;
      }
      if (found) last = interp.callHandler(found.script, found.handler, rest, t, new Set());
      else b.warn(`callAncestor(#${handlerName}): no ancestor handler on ${t.scriptName}`);
    }
    return last;
  });

  set(['length'], (b, a) => {
    const v = a[0];
    if (v === null || v === undefined) return 0;
    return typeof v === 'string' ? v.length : toLingoString(v).length;
  });
  set(['string'], (b, a) => {
    const v = a[0];
    if (v === null || v === undefined) return '';
    if (v instanceof LSymbol) return v.name;
    return toLingoString(v);
  });
  const normalizeValueExpr = (input: string): string => {
    let s = stripLingoComments(input);
    s = stripLingoContinuations(s);
    s = trimUnbalancedBrackets(s.trim());
    return truncateToFirstBalancedList(s);
  };

  set(['value'], (b, a, interp) => {
    const v = a[0];
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const cleaned = normalizeValueExpr(v);
      const direct = interp.evalExpressionString(cleaned);
      if (direct === cleaned && v.includes(',')) {
        const wrapped = interp.evalExpressionString('[' + v + ']');
        if (wrapped instanceof LList) return wrapped;
      }
      return direct === cleaned ? v : direct;
    }
    return v ?? VOID;
  });
  set(['symbol'], (b, a) => {
    const v = a[0];
    if (v instanceof LSymbol) return v;
    if (typeof v === 'string') return new LSymbol(v);
    return VOID;
  });
  set(['offset'], (b, a) => {
    const needle = toLingoString(a[0]);
    const haystack = toLingoString(a[1]);
    const i = haystack.indexOf(needle);
    return i === -1 ? 0 : i + 1;
  });
  set(['charToNum'], (b, a) => {
    const s = toLingoString(a[0]);
    return s.length > 0 ? s.charCodeAt(0) : 0;
  });
  set(['numToChar'], (b, a) => String.fromCharCode(Math.round(numArgs(a, 0))));

  set(['ilk'], (b, a) => {
    const sym = ilkOf(a[0]);
    if (a[1] instanceof LSymbol) {
      return sym.name.toLowerCase() === a[1].name.toLowerCase() ? 1 : 0;
    }
    return sym;
  });
  set(['voidp'], (b, a) => (a[0] === null ? 1 : 0));
  set(['objectp'], (b, a) => (a[0] instanceof LObjectClass ? 1 : 0));
  set(['stringp'], (b, a) => (typeof a[0] === 'string' ? 1 : 0));
  set(['integerp'], (b, a) => (typeof a[0] === 'number' && Number.isInteger(a[0]) ? 1 : 0));
  set(['floatp'], (b, a) => (typeof a[0] === 'number' && !Number.isInteger(a[0]) ? 1 : 0));
  set(['symbolp'], (b, a) => (a[0] instanceof LSymbol ? 1 : 0));
  set(['listp'], (b, a) => (a[0] instanceof LList || a[0] instanceof LPropList ? 1 : 0));
  set(['count'], (b, a) => {
    const v = a[0];
    if (v instanceof LList) return v.items.length;
    if (v instanceof LPropList) return v.props.size;
    if (typeof v === 'string') return v.length;
    if (v instanceof LPoint) return 2;
    return 0;
  });
  set(['pointp'], (b, a) => (a[0] instanceof LPoint ? 1 : 0));
  set(['memberp'], (b, a) => (a[0] instanceof LMemberRefClass ? 1 : 0));
  set(['image'], (b, a) => {
    const img = new LImage(Math.round(numArgs(a, 0)), Math.round(numArgs(a, 1)));
    if (a[2] !== undefined) {
      const d = Math.round(numArgs(a, 2));
      if (d > 0) img.depth = d;
    }
    if (a[3] !== undefined) {
      img.paletteRef = a[3];
      if (a[3] instanceof LMemberRefClass) b.adoptImagePalette(a[3]);
      const table = b.resolvePaletteTable(a[3]);
      if (table) img.palette = table;
    }
    else if (img.depth <= 8) img.palette = SYSTEM_PALETTE;
    const fw = Math.max(0, Math.round(img.width));
    const fh = Math.max(0, Math.round(img.height));
    if (fw > 0 && fh > 0 && img.depth <= 8) {
      const buf = img.ensure();
      let fr = 255, fg = 255, fb = 255;
      const table = a[3] !== undefined ? b.resolvePaletteTable(a[3]) : SYSTEM_PALETTE;
      if (table && table.length > 0) {
        fr = table[0][0];
        fg = table[0][1];
        fb = table[0][2];
      }
      for (let i = 0; i < fw * fh; i++) {
        buf[i * 4] = fr;
        buf[i * 4 + 1] = fg;
        buf[i * 4 + 2] = fb;
        buf[i * 4 + 3] = 255;
      }
      img.dirty = true;
    }
    return img;
  });
  set(['createMask'], (b, a) => {
    const img = a[0];
    if (!(img instanceof LImage)) return VOID;
    const w = Math.max(0, Math.round(img.width));
    const h = Math.max(0, Math.round(img.height));
    const mask = new LImage(w, h);
    const m = mask.ensure();
    const s = img.ensure();
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      const luma = (s[o] * 299 + s[o + 1] * 587 + s[o + 2] * 114) / 1000;
      m[o] = 255;
      m[o + 1] = 255;
      m[o + 2] = 255;
      m[o + 3] = luma < 128 ? 255 : 0;
    }
    mask.dirty = true;
    return mask;
  });
  set(['date'], () => new Date().toLocaleDateString('en-US'));
  set(['time'], () => new Date().toLocaleTimeString('en-US'));

  set(['chars'], (b, a) => {
    const s = toLingoString(a[0]);
    const from = Math.round(numArgs(a, 1));
    const to = a[2] !== undefined ? Math.round(numArgs(a, 2)) : s.length;
    const f = Math.max(1, from);
    const t = Math.min(s.length, to);
    if (f > t) return '';
    return s.slice(f - 1, t);
  });

  set(['list'], (b, a) => new LList(a.slice()));
  set(['point'], (b, a) => new LPoint(numArgs(a, 0), numArgs(a, 1)));
  set(['rect'], (b, a) => {
    if (a.length === 2 && a[0] instanceof LPoint && a[1] instanceof LPoint) {
      return new LRect(a[0].locH, a[0].locV, a[1].locH, a[1].locV);
    }
    return new LRect(numArgs(a, 0), numArgs(a, 1), numArgs(a, 2), numArgs(a, 3));
  });
  const isEmptyRect = (r: LRect) => r.right <= r.left || r.bottom <= r.top;
  const rectArg = (v: LVal | undefined): LRect | null => (v instanceof LRect ? v : null);
  set(['union'], (b, a) => {
    if (a.length < 2) return VOID;
    const f = rectArg(a[0]);
    const s = rectArg(a[1]);
    if (!f || !s) return VOID;
    const fe = isEmptyRect(f);
    const se = isEmptyRect(s);
    if (fe && se) return new LRect(0, 0, 0, 0);
    if (fe) return s;
    if (se) return f;
    return new LRect(Math.min(f.left, s.left), Math.min(f.top, s.top), Math.max(f.right, s.right), Math.max(f.bottom, s.bottom));
  });
  set(['intersect'], (b, a) => {
    if (a.length < 2) return VOID;
    const f = rectArg(a[0]);
    const s = rectArg(a[1]);
    if (!f || !s) return VOID;
    const left = Math.max(f.left, s.left);
    const top = Math.max(f.top, s.top);
    const right = Math.min(f.right, s.right);
    const bottom = Math.min(f.bottom, s.bottom);
    if (right <= left || bottom <= top) return new LRect(0, 0, 0, 0);
    return new LRect(left, top, right, bottom);
  });
  set(['rgb'], (b, a) => {
    if (a.length >= 3) {
      return new LColor(Math.round(numArgs(a, 0)), Math.round(numArgs(a, 1)), Math.round(numArgs(a, 2)));
    }
    return colorFrom(a[0] ?? VOID) ?? new LColor(0, 0, 0);
  });
  set(['color'], (b, a) => {
    if (a.length >= 3) {
      return new LColor(Math.round(numArgs(a, 0)), Math.round(numArgs(a, 1)), Math.round(numArgs(a, 2)));
    }
    if (typeof a[0] === 'number') return intColor(a[0]);
    if (typeof a[0] === 'string') return hexColor(a[0]) ?? new LColor(0, 0, 0);
    return colorFrom(a[0] ?? VOID) ?? new LColor(0, 0, 0);
  });
  set(['paletteIndex'], (b, a) => b.paletteColor(Math.round(asNum(a[0]))));

  set(['externalParamValue'], (b, a) => b.externalParamValue(a[0]));
  set(['externalParamCount'], (b) => b.externalParamCount());
  set(['externalParamName'], (b, a) => b.externalParamName(Math.round(numArgs(a, 0))));
  set(['script'], (b, a) => {
    const v = a[0];
    let script: Script | null = null;
    if (typeof v === 'string') script = b.resolveScript(v);
    else if (v instanceof LSymbol) script = b.resolveScript(v.name);
    else if (typeof v === 'number') script = b.resolveScriptByNumber(Math.round(v));
    else if (v instanceof LMemberRefClass) script = v.host?.memberScript(v) ?? null;
    if (!script) {
      b.warn(`script(): unknown script ${toLingoString(v)}`);
      return VOID;
    }
    return new LScriptRefClass(script);
  });
  set(['param'], (b, a, interp) => interp.param(Math.round(asNum(a[0]))));
  set(['member'], (b, a) => {
    const v = a[0];
    let castLibNum: number | undefined;
    const cArg = a[1];
    if (cArg !== undefined && cArg !== null) {
      if (typeof cArg === 'string' || cArg instanceof LSymbol) {
        const cl = b.getCastLib(cArg);
        castLibNum = cl ? cl.number : undefined;
      } else {
        castLibNum = Math.round(asNum(cArg));
      }
    }
    if (typeof v === 'number') return b.getMember(Math.round(v), castLibNum) ?? VOID;
    if (typeof v === 'string') {
      if (castLibNum !== undefined) return b.getMemberByNameInCast(v, castLibNum) ?? VOID;
      return b.getMemberByName(v) ?? VOID;
    }
    if (v instanceof LMemberRefClass) return v;
    if (v instanceof LImage) return b.getMemberByImage(v) ?? VOID;
    return VOID;
  });
  set(['createmember'], (b, a) => {
    const name = toLingoString(a[0]);
    const kind = a[1] instanceof LSymbol ? a[1].name : toLingoString(a[1] ?? 'bitmap');
    const castNum = a[2] !== undefined && a[2] !== null ? Math.round(asNum(a[2])) : 1;
    return b.createNamedMember(name, kind, castNum);
  });
  set(['field'], (b, a) => {
    const v = a[0];
    let castLibNum: number | undefined;
    const cArg = a[1];
    if (cArg !== undefined && cArg !== null) {
      const cl = b.getCastLib(cArg);
      castLibNum = cl ? cl.number : undefined;
    }
    let ref: LMemberRef | null = null;
    if (typeof v === 'number') ref = b.getMember(Math.round(v), castLibNum);
    else if (typeof v === 'string') ref = castLibNum !== undefined ? b.getMemberByNameInCast(v, castLibNum) : b.getMemberByName(v);
    else if (v instanceof LMemberRefClass) ref = v;
    if (!ref) return VOID;
    return b.getMemberProp(ref, 'text');
  });
  set(['sprite'], (b, a) => b.getSprite(Math.round(numArgs(a, 0))));
  set(['castLib'], (b, a) => b.getCastLib(a[0]) ?? VOID);
  set(['window'], (b, a) => b.getWindow(toLingoString(a[0])) ?? VOID);
  set(['timeout'], (b, a) => b.timeout(toLingoString(a[0])));
  set(['xtra'], (b, a) => b.xtraInstance(toLingoString(a[0])));
  set(['getPref'], (b, a) => b.getPref(toLingoString(a[0] ?? '')));
  set(['setPref'], (b, a) => {
    b.setPref(toLingoString(a[0] ?? ''), toLingoString(a[1] ?? ''));
    return VOID;
  });
  set(['deletePref'], (b, a) => {
    b.setPref(toLingoString(a[0] ?? ''), '');
    return VOID;
  });
  set(['pass'], () => VOID);
  set(['stopEvent'], (b) => {
    (b as unknown as { _stopEventPending: boolean })._stopEventPending = true;
    return VOID;
  });
  set(['new'], (b, a, interp) => {
    const type = a[0];
    if (type instanceof LObjectClass && type.scriptName.startsWith('xtra:')) {
      const name = type.props.get('name') ?? type.scriptName.slice(5);
      return b.xtraInstance(toLingoString(name));
    }
    if (type instanceof LSymbol && type.name.toLowerCase() === 'script') {
      const name = typeof a[1] === 'string' ? a[1] : toLingoString(a[1]);
      const script = b.resolveScript(name);
      if (!script) {
        b.warn(`new(script): unknown script ${name}`);
        return VOID;
      }
      return interp.newInstance(script, a.slice(2));
    }
    if (type instanceof LScriptRefClass) {
      return interp.newInstance(type.script, a.slice(1));
    }
    if (type instanceof LSymbol) {
      const kindMap: Record<string, string> = {
        field: 'text',
        text: 'text',
        bitmap: 'bitmap',
        sound: 'sound',
        font: 'font',
        palette: 'palette',
      };
      const kind = kindMap[type.name.toLowerCase()];
      if (kind) {
        const castArg = a[1] ?? 1;
        const cast = b.getCastLib(castArg);
        const castNum = cast ? cast.number : 1;
        const ref = b.newMember(kind, castNum);
        if (ref) return ref;
      }
      b.warn(`new(#${type.name}, ...) member creation is a stub`);
      return VOID;
    }
    return VOID;
  });
  set(['go', 'goToLoop', 'goNext', 'goPrevious'], (b, a) => {
    b.go(a[0]);
    return VOID;
  });
  set(['puppetSprite'], (b, a) => {
    b.setPuppet(Math.round(numArgs(a, 0)), Math.round(numArgs(a, 1)));
    return VOID;
  });
  set(['puppetSound'], (b, a) => {
    b.puppetSound(Math.round(numArgs(a, 0)), a[1]);
    return VOID;
  });
  set(['sound'], (b, a) => b.getSoundChannel(Math.round(numArgs(a, 0))));
  set(['queueSound'], (b, a) => {
    b.queueSoundOnChannel(a[0], Math.round(numArgs(a, 1)), a[2]);
    return VOID;
  });
  set(['startSoundChannel'], (b, a) => b.startSoundChannelBuiltin(Math.round(numArgs(a, 0))));
  set(['stopSoundChannel'], (b, a) => b.stopSoundChannelBuiltin(Math.round(numArgs(a, 0))));
  set(['playSoundInChannel'], (b, a) => b.playSoundInChannelBuiltin(a[0], Math.round(numArgs(a, 1))));
  set(['moveToFront', 'moveToBack', 'moveForward', 'moveBackward'], () => VOID);
  set(['puppetTempo'], (b, a) => {
    b.setFrameTempo(Math.round(numArgs(a, 0)));
    return VOID;
  });

  set(['getNetText'], (b, a) => b.netGetNetText(toLingoString(a[0])));
  set(['netDone'], (b, a) => b.netDone(typeof a[0] === 'number' ? a[0] : undefined));
  set(['getStreamStatus'], (b, a) => b.getStreamStatus(typeof a[0] === 'number' ? a[0] : 0));
  set(['netError'], (b, a) => b.netError(typeof a[0] === 'number' ? a[0] : undefined));
  set(['netTextResult'], (b, a) => b.netTextResult(typeof a[0] === 'number' ? a[0] : undefined));
  set(['netAbort'], () => VOID);
  set(['preloadNetThing'], (b, a) => b.preloadNetThing(toLingoString(a[0])));
  set(['downloadNetThing'], (b, a) => b.preloadNetThing(toLingoString(a[0])));
  set(['importFileInto'], (b, a) => b.importFileInto(a[0], toLingoString(a[1])));

  set(['getVariable'], (b, a) => {
    const v = b.globalGet(toLingoString(a[0]));
    if (v !== undefined && v !== null) return v;
    return a[1] ?? VOID;
  });
  set(['getVariableValue'], (b, a) => {
    const v = b.globalGet(toLingoString(a[0]));
    if (v !== undefined && v !== null) return v;
    return a[1] ?? VOID;
  });
  set(['setVariable'], (b, a) => {
    b.globalSet(toLingoString(a[0]), a[1] ?? VOID);
    return VOID;
  });
  set(['getIntVariable'], (b, a) => {
    const v = b.globalGet(toLingoString(a[0]));
    const def = a[1] !== undefined ? asNum(a[1]) : 0;
    if (v === undefined || v === null) return def;
    const n = asNum(v);
    return Number.isFinite(n) ? Math.round(n) : def;
  });
  set(['variableExists'], (b, a) => (b.globalGet(toLingoString(a[0])) !== undefined ? 1 : 0));
  const dumpField = (b: BuiltinBackend, a: LVal[]): LVal => {
    const member = b.getMemberByName(toLingoString(a[0]));
    const text = (member as unknown as { text?: string })?.text;
    if (typeof text === 'string') {
      let count = 0;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        let key: string;
        let value: string;
        const tab = trimmed.indexOf('\t');
        const eq = trimmed.indexOf('=');
        if (tab > 0 && (eq < 0 || tab < eq)) {
          key = trimmed.slice(0, tab).trim();
          value = trimmed.slice(tab + 1).trim();
        } else if (eq > 0) {
          key = trimmed.slice(0, eq).trim();
          value = trimmed.slice(eq + 1).trim();
        } else {
          continue;
        }
        if (key) {
          b.globalSet(key, value);
          count++;
        }
      }
      return count > 0 ? 1 : 0;
    }
    return 0;
  };

  set(['dumpVariableField', 'dumpTextField'], dumpField);
  set(['getText'], (b, a) => {
    const member = b.getMemberByName(toLingoString(a[0]));
    const text = (member as unknown as { text?: string })?.text;
    if (typeof text === 'string') return text;
    return a[1] ?? VOID;
  });

  set(['getObject'], (b, a) => {
    const key = keyOf(a[0]);
    if (key === undefined) return VOID;
    return b.getObjectById(key) ?? VOID;
  });
  set(['objectExists'], (b, a) => {
    const key = keyOf(a[0]);
    return key !== undefined && b.getObjectById(key) !== null ? 1 : 0;
  });
  set(['removeObject'], (b, a) => {
    const key = keyOf(a[0]);
    if (key !== undefined) b.removeObjectById(key);
    return VOID;
  });
  set(['newObject'], (b, a, interp) => {
    const script = b.resolveScript(toLingoString(a[0]));
    if (!script) {
      b.warn(`newObject: unknown class ${toLingoString(a[0])}`);
      return VOID;
    }
    const obj = interp.newInstance(script, []);
    const params = a[1];
    if (params instanceof LPropList) {
      for (const [k, v] of params.props) obj.props.set(k, v);
    }
    return obj;
  });
  set(['getUniqueID', 'getUniqueId'], (b) => b.getUniqueId());

  set(['executeMessage'], (b, a) => {
    const msg = a[0] instanceof LSymbol ? a[0].name : toLingoString(a[0]);
    b.dispatchMessage(msg, a[1] ?? VOID);
    return VOID;
  });
  set(['createWindow'], (b, a) => b.createWindow(toLingoString(a[0])) ?? VOID);
  set(['removeWindow'], (b, a) => {
    b.removeWindow(toLingoString(a[0]));
    return VOID;
  });
  set(['windowExists'], (b, a) => (b.windowExists(toLingoString(a[0])) ? 1 : 0));
  set(['error'], (b, a) => {
    b.warn(`ERROR: ${toLingoString(a[1] ?? '')} (handler ${toLingoString(a[2] ?? '')})`);
    return VOID;
  });
  set(['warning'], (b, a) => {
    b.warn(`warning: ${toLingoString(a[1] ?? a[0] ?? '')}`);
    return VOID;
  });

  set(['getConnection'], (b, a) => b.getConnection(toLingoString(a[0])));
  set(['connectionExists'], (b, a) => (b.connectionExists(toLingoString(a[0])) ? 1 : 0));
  set(['removeConnection'], (b, a) => {
    b.removeConnection(toLingoString(a[0]));
    return VOID;
  });
  set(['registerListener'], (b, a) => {
    b.registerListener(toLingoString(a[0]), toLingoString(a[1]), a[2]);
    return VOID;
  });
  set(['registerCommands'], (b, a) => {
    b.registerCommands(toLingoString(a[0]), toLingoString(a[1]), a[2]);
    return VOID;
  });
  set(['unregisterListener'], (b, a) => {
    b.unregisterListener(toLingoString(a[0]), toLingoString(a[1]));
    return VOID;
  });


  set(['setRollover'], (b, a) => {
    b.setRollover(Math.round(numArgs(a, 0)));
    return VOID;
  });

  set(['connectionSend'], (b, a) => {
    const params = a[2] && !(a[2] === null) ? ` ${toLingoString(a[2])}` : '';
    b.log(`CONN ${toLingoString(a[0])} <- ${toLingoString(a[1])}${params}`);
    return VOID;
  });

  set(['add'], (b, a) => {
    if (a[0] instanceof LList) a[0].items.push(a[1] ?? VOID);
    return VOID;
  });
  set(['sort'], (b, a) => {
    if (a[0] instanceof LList) {
      a[0].items.sort(lingoListCompare);
    }
    return VOID;
  });
  set(['getAt'], (b, a) => {
    const c = a[0];
    const i = Math.round(asNum(a[1]));
    if (c instanceof LList) return i >= 1 && i <= c.items.length ? c.items[i - 1] : VOID;
    if (c instanceof LPropList) {
      const values = [...c.props.values()];
      return i >= 1 && i <= values.length ? values[i - 1] : VOID;
    }
    return VOID;
  });
  set(['getAProp'], (b, a) => {
    const c = a[0];
    const key = keyOf(a[1]);
    if (c instanceof LPropList && key !== undefined) return c.props.get(key) ?? VOID;
    if (c instanceof LList && typeof a[1] === 'number') {
      const i = Math.round(a[1]);
      return i >= 1 && i <= c.items.length ? c.items[i - 1] : VOID;
    }
    return VOID;
  });
  set(['setAProp'], (b, a) => {
    const c = a[0];
    const key = keyOf(a[1]);
    if (c instanceof LPropList && key !== undefined) c.props.set(key, a[2] ?? VOID);
    else if (c instanceof LList && typeof a[1] === 'number') {
      const i = Math.round(a[1]);
      if (i >= 1) {
        while (c.items.length < i) c.items.push(VOID);
        c.items[i - 1] = a[2] ?? VOID;
      }
    }
    return VOID;
  });
  set(['addAProp'], (b, a) => {
    const c = a[0];
    const key = keyOf(a[1]);
    if (c instanceof LPropList && key !== undefined) c.props.append(key, a[2] ?? VOID);
    else if (c instanceof LList) c.items.push(a[2] ?? VOID);
    return VOID;
  });
  set(['deleteAProp'], (b, a) => {
    const c = a[0];
    const key = keyOf(a[1]);
    if (c instanceof LPropList && key !== undefined) c.props.delete(key);
    return VOID;
  });
  set(['countAProp'], (b, a) => {
    const c = a[0];
    if (c instanceof LPropList) return c.props.size;
    if (c instanceof LList) return c.items.length;
    return 0;
  });
  set(['getPropAt'], (b, a) => {
    const c = a[0];
    const i = Math.round(asNum(a[1]));
    if (c instanceof LPropList) {
      const keys = [...c.props.keys()];
      return i >= 1 && i <= keys.length ? rawKeyOf(keys[i - 1]) : VOID;
    }
    if (c instanceof LList) return i >= 1 && i <= c.items.length ? c.items[i - 1] : VOID;
    return VOID;
  });
  set(['duplicate'], (b, a) => duplicateValue(a[0]));

  set(['rollover'], (b, a) => {
    if (a.length === 0) return b.rollover();
    const target = a[0] instanceof LSpriteRefClass ? a[0].channel : Math.round(asNum(a[0]));
    if (b.rolloverSprite) return b.rolloverSprite(target) ? 1 : 0;
    return b.rollover() === target ? 1 : 0;
  });
  set(['inside'], (b, a) => {
    const p = a[0];
    const r = a[1];
    if (p instanceof LPoint && r instanceof LRect) {
      return p.locH >= r.left && p.locH < r.right && p.locV >= r.top && p.locV < r.bottom ? 1 : 0;
    }
    return 0;
  });
  set(['getWindowIdList'], (b) => new LList(b.getWindowIdList()));

  set(['stopClient'], (b) => {
    b.log('stopClient: client stopped');
    return VOID;
  });

  set(
    ['noop', 'setCallback', 'updateStage', 'unloadCast', 'loadCast', 'startTimer', 'stopTimer', 'cursor', 'setCursor', 'pauseUpdate', 'nothing', 'beep', 'delay', 'alert', 'quit', 'halt', 'restart'],
    () => VOID,
  );

  return t;
}
