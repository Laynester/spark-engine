/**
 * Legacy-page global reclaim.
 *
 * `<spark-player>` is meant to be dropped into hotel pages, and those pages
 * routinely still ship a 2008-era script bundle: Habbo's own
 * `web-gallery/static/js/visual.js` is Prototype 1.6.0.2 plus the old page
 * chrome (HabboView / Rounder / Ajax). Prototype predates ES5 and extends the
 * shared realm destructively, which breaks PixiJS before the movie can boot:
 *
 *   - it REPLACES native Array.prototype.reduce/map/filter/some/every/find/
 *     entries and Array.from with its own versions. Pixi builds its uniform-type
 *     lookup table with Array.prototype.reduce, and Prototype's `reduce` returns
 *     `this` when length > 1, so the "table" handed back was the raw type list
 *     and every uniform read as unsupported:
 *
 *       Uniform type vec4<f32> is not supported. Supported uniform types are:
 *       f32, i32, vec2<f32>, vec3<f32>, vec4<f32>, ...
 *
 *     -- a message that lists the very type it just rejected.
 *   - it ADDS its Enumerable helpers to Array.prototype as ENUMERABLE
 *     properties, so Pixi's `for (i in systems)` over an array picked up
 *     'each' / 'collect' / ... and called `new undefined()`:
 *     "ClassRef is not a constructor".
 *   - it also adds Array/String/Number `toJSON`, which hijacks JSON.stringify
 *     (JSON.stringify([1, 2]) becomes the string "[1, 2]").
 *   - it methodizes Element.Methods onto HTMLElement.prototype, where its
 *     `remove()` shadows the native Element.remove() and throws on a detached
 *     node (the native one is a no-op). Pixi calls element.remove() during
 *     postrender, so that threw once per frame.
 *
 * None of that is fixable from inside Pixi, and requiring every hotel to patch
 * their page is not an option, so the runtime repairs the realm itself: see
 * reclaimLegacyGlobals(), called from the module graph before pixi.js is
 * evaluated (index.ts / stage/pixi.ts import order) and again at element boot.
 *
 * The repair is deliberately conservative -- natives are restored and legacy
 * ADDITIONS are only hidden from for..in (made non-enumerable, exactly what
 * Prototype 1.7 does itself) so the legacy page's own code keeps working. The
 * pristine reference values come from a throwaway same-origin iframe, whose
 * realm no page script can have touched.
 */

type Ctor = { prototype: object } & Record<string, unknown>;

/** The global objects we snapshot, in the poisoned realm and in a clean one. */
export interface Realm {
  array: Ctor;
  string: Ctor;
  number: Ctor;
  function: Ctor;
  regexp: Ctor;
  date: Ctor;
  object: Ctor;
  element?: Ctor;
  html?: Ctor;
  htmlInput?: Ctor;
  htmlSelect?: Ctor;
  htmlTextarea?: Ctor;
  htmlForm?: Ctor;
  htmlAnchor?: Ctor;
}

export interface ReclaimReport {
  /** Number of repairs; 0 means the realm was already clean. */
  changed: number;
  /** Standard members a legacy script had replaced, e.g. "Array.prototype.reduce". */
  restored: string[];
  /** Added members deleted because they shadowed a standard one, e.g. "HTMLElement.prototype.remove". */
  unshadowed: string[];
  /** Added members hidden from for..in, e.g. "Array.prototype.each". */
  hidden: string[];
  /** Added `toJSON` hooks removed, e.g. "Array.prototype.toJSON". */
  dropped: string[];
}

const DOM_CTORS: Array<[keyof Realm, string]> = [
  ['element', 'Element.prototype'],
  ['html', 'HTMLElement.prototype'],
  ['htmlInput', 'HTMLInputElement.prototype'],
  ['htmlSelect', 'HTMLSelectElement.prototype'],
  ['htmlTextarea', 'HTMLTextAreaElement.prototype'],
  ['htmlForm', 'HTMLFormElement.prototype'],
  ['htmlAnchor', 'HTMLAnchorElement.prototype'],
];

/** The prototypes whose standard members we restore / whose additions we hide. */
const PROTO_PAIRS: Array<[keyof Realm, string]> = [
  ['array', 'Array.prototype'],
  ['string', 'String.prototype'],
  ['number', 'Number.prototype'],
  ['function', 'Function.prototype'],
  ['regexp', 'RegExp.prototype'],
  ['date', 'Date.prototype'],
  ['object', 'Object.prototype'],
  ...DOM_CTORS,
];

/** Snapshot the global objects of a realm (works for a pristine iframe window). */
export function captureRealm(win: Window & typeof globalThis): Realm {
  const w = win as unknown as Record<string, Ctor | undefined>;
  return {
    array: w.Array!,
    string: w.String!,
    number: w.Number!,
    function: w.Function!,
    regexp: w.RegExp!,
    date: w.Date!,
    object: w.Object!,
    element: w.Element,
    html: w.HTMLElement,
    htmlInput: w.HTMLInputElement,
    htmlSelect: w.HTMLSelectElement,
    htmlTextarea: w.HTMLTextAreaElement,
    htmlForm: w.HTMLFormElement,
    htmlAnchor: w.HTMLAnchorElement,
  };
}

/** A descriptor we are allowed to (re)define: natives are writable + non-enumerable. */
function reinstallable(desc: PropertyDescriptor): PropertyDescriptor {
  if (desc.get || desc.set) {
    return { get: desc.get, set: desc.set, configurable: true, enumerable: false };
  }
  return { value: desc.value, writable: true, configurable: true, enumerable: false };
}

const nativeSource = (fn: unknown): string => Function.prototype.toString.call(fn);

/**
 * Are these two properties the same implementation? Values from a second realm
 * are never the same object, so natives are recognised by their name/length and
 * by `toString()` reading "[native code]" -- Prototype's replacements print their
 * own source, which is exactly what we need to detect.
 */
function sameMember(have: PropertyDescriptor, want: PropertyDescriptor): boolean {
  if (have.value === want.value) return true;
  const a = have.value;
  const b = want.value;
  if (typeof a === 'function' && typeof b === 'function') {
    const fa = a as (...args: unknown[]) => unknown;
    const fb = b as (...args: unknown[]) => unknown;
    if (fa.name !== fb.name || fa.length !== fb.length) return false;
    try {
      return nativeSource(fa) === nativeSource(fb);
    } catch {
      return false;
    }
  }
  return false;
}

function reclaimProto(target: object, pristine: object, label: string, report: ReclaimReport): void {
  // 1. Put back every standard member a legacy script replaced or removed.
  for (const key of Object.getOwnPropertyNames(pristine)) {
    const want = Object.getOwnPropertyDescriptor(pristine, key);
    if (!want) continue;
    const have = Object.getOwnPropertyDescriptor(target, key);
    if (have && sameMember(have, want)) continue;
    try {
      Object.defineProperty(target, key, reinstallable(want));
      report.restored.push(`${label}.${key}`);
    } catch {
      // Non-configurable member of a foreign realm -- leave it alone.
    }
  }
  // 2. Hide (or drop) what the legacy script ADDED on top of the standard set.
  for (const key of Object.getOwnPropertyNames(target)) {
    const desc = Object.getOwnPropertyDescriptor(target, key);
    if (!desc) continue;
    if (Object.prototype.hasOwnProperty.call(pristine, key)) continue;
    const bag = target as Record<string, unknown>;
    if (key === 'toJSON') {
      // No standard realm has a prototype toJSON; this hook only hijacks
      // JSON.stringify (arrays/strings/numbers would serialize as their source).
      delete bag[key];
      report.dropped.push(`${label}.${key}`);
      continue;
    }
    if (key in pristine) {
      // It shadows a standard member inherited from further up the chain
      // (HTMLElement.prototype.remove vs Element.prototype.remove). Delete the
      // own property so the standard one shows through again.
      delete bag[key];
      report.unshadowed.push(`${label}.${key}`);
      continue;
    }
    if (desc.enumerable) {
      try {
        Object.defineProperty(target, key, { ...desc, enumerable: false });
        report.hidden.push(`${label}.${key}`);
      } catch {
        // ignore
      }
    }
  }
}

/** Repair `target` using `pristine` as the source of truth for standard members. */
export function reclaimRealm(target: Realm, pristine: Realm): ReclaimReport {
  const report: ReclaimReport = { changed: 0, restored: [], unshadowed: [], hidden: [], dropped: [] };
  for (const [key, label] of PROTO_PAIRS) {
    const t = target[key];
    const p = pristine[key];
    if (!t || !p || !t.prototype || !p.prototype) continue;
    reclaimProto(t.prototype, p.prototype, label, report);
  }
  const from = pristine.array.from;
  if (typeof from === 'function' && target.array.from !== from) {
    target.array.from = from;
    report.restored.push('Array.from');
  }
  report.changed = report.restored.length + report.unshadowed.length + report.hidden.length + report.dropped.length;
  return report;
}

/** Cheap detection of the legacy bundles that need reclaiming (no iframe yet). */
export function looksLikeLegacyPage(win: Window & typeof globalThis): boolean {
  const w = win as unknown as {
    Prototype?: unknown;
    Array?: { prototype: Record<string, unknown> };
    String?: { prototype: Record<string, unknown> };
  };
  if (typeof w.Prototype !== 'undefined') return true;
  const arrayProto = w.Array?.prototype;
  const stringProto = w.String?.prototype;
  if (!arrayProto || !stringProto) return false;
  return (
    typeof arrayProto.each === 'function' ||
    typeof arrayProto.include === 'function' ||
    typeof stringProto.blank === 'function' ||
    'toJSON' in arrayProto
  );
}

function globalsOf(win?: Window, doc?: Document): { win: Window & typeof globalThis; doc: Document } | null {
  const w = win ?? (typeof window !== 'undefined' ? window : undefined);
  const d = doc ?? (typeof document !== 'undefined' ? document : undefined);
  if (!w || !d) return null;
  return { win: w as Window & typeof globalThis, doc: d };
}

let cached: ReclaimReport | null | undefined;

/**
 * Repair the page realm once, using a pristine same-origin iframe as reference.
 * Returns null when there is no DOM (workers, node) or no host to mount the
 * reference frame in. Safe to call repeatedly: the result is memoized.
 */
export function reclaimLegacyGlobals(win?: Window, doc?: Document): ReclaimReport | null {
  if (cached !== undefined) return cached;
  const g = globalsOf(win, doc);
  if (!g) return null;
  // An IIFE bundle can run from <head>, where document.body does not exist yet;
  // <html> does, and the reference frame only has to be in *a* document.
  const host = g.doc.body ?? g.doc.documentElement;
  if (!host) return null;
  const frame = g.doc.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
  host.appendChild(frame);
  try {
    const clean = frame.contentWindow as (Window & typeof globalThis) | null;
    if (!clean || !clean.Array || !clean.Object) return null;
    const report = reclaimRealm(captureRealm(g.win), captureRealm(clean));
    cached = report;
    return report;
  } catch {
    return null;
  } finally {
    frame.parentNode?.removeChild(frame);
  }
}

/**
 * Reclaim, but only when the page actually looks Prototype-era. Cheap when it
 * does not (a few property reads, no iframe). Called at import time by the
 * modules that must be safe before pixi.js is evaluated.
 */
export function reclaimIfLegacyPage(win?: Window, doc?: Document): ReclaimReport | null {
  if (cached !== undefined) return cached;
  const g = globalsOf(win, doc);
  if (!g) return null;
  if (!looksLikeLegacyPage(g.win)) {
    return null;
  }
  return reclaimLegacyGlobals(g.win, g.doc);
}

/** Repair done when the runtime module graph was evaluated (before pixi.js). */
export const legacyReclaimReport: ReclaimReport | null = reclaimIfLegacyPage();
