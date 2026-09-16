import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureRealm, reclaimRealm, looksLikeLegacyPage, type Realm } from '../legacy/reclaim.js';

/**
 * The reclaim logic normally runs against the *global* realm in a browser, so
 * these tests drive it with two hand-built realms: a "pristine" one shaped like a
 * native realm and a "poisoned" one carrying what Prototype 1.6 does to a page.
 */

function ctor(prototype: object): { prototype: object } {
  return { prototype };
}

/** A native-shaped prototype: members are writable, configurable, NOT enumerable. */
function protoWith(members: Record<string, unknown>): object {
  const proto: Record<string, unknown> = {};
  for (const key of Object.keys(members)) {
    Object.defineProperty(proto, key, { value: members[key], writable: true, configurable: true, enumerable: false });
  }
  return proto;
}

/** A realm's prototype as a mutable bag, for arranging/asserting in tests. */
function protoOf(realm: Realm, key: keyof Realm): Record<string, (...args: never[]) => unknown> {
  return (realm[key] as { prototype: Record<string, (...args: never[]) => unknown> }).prototype;
}

/**
 * A native-shaped realm: every call builds its own function objects whose source
 * matches the other realm's -- which is how two real realms look to the reclaim
 * (distinct objects, identical "[native code]" behaviour).
 */
function makeRealm(): Realm {
  return {
    array: ctor(protoWith({ reduce: function reduce(): void {}, find: function find(): void {} })),
    string: ctor(protoWith({ trim: function trim(): string { return ''; } })),
    number: ctor(protoWith({ toFixed: function toFixed(): string { return ''; } })),
    function: ctor(protoWith({ bind: function bind(): void {} })),
    regexp: ctor(protoWith({ test: function test(): boolean { return false; } })),
    date: ctor(protoWith({ toJSON: function toJSON(): string { return '""'; } })),
    object: ctor(protoWith({ hasOwnProperty: function hasOwnProperty(): boolean { return false; } })),
  };
}

test('reclaims the built-ins a Prototype-era page replaces, keyed off Array.prototype.reduce', () => {
  const pristine = makeRealm();
  (pristine.array as { from?: unknown }).from = function nativeFrom(): unknown[] {
    return [];
  };
  const poisoned = makeRealm();
  // Prototype 1.6's reduce returns `this` when length > 1 -- this is what turned
  // Pixi's uniform-type lookup table into the raw type list.
  protoOf(poisoned, 'array').reduce = function prototypReduce(this: { length: number }): unknown {
    return this.length > 1 ? this : [];
  };
  protoOf(poisoned, 'array').find = function prototypDetect(): void {};
  protoOf(poisoned, 'function').bind = function prototypBind(): void {};
  (poisoned.array as { from?: unknown }).from = function prototypFrom(): unknown[] {
    return [];
  };

  const report = reclaimRealm(poisoned, pristine);

  assert.equal(protoOf(poisoned, 'array').reduce, protoOf(pristine, 'array').reduce, 'native reduce restored');
  assert.equal(protoOf(poisoned, 'array').find, protoOf(pristine, 'array').find, 'native find restored');
  assert.equal(protoOf(poisoned, 'function').bind, protoOf(pristine, 'function').bind, 'native bind restored');
  assert.equal(poisoned.array.from, pristine.array.from, 'native Array.from restored');
  assert.ok(report.restored.includes('Array.prototype.reduce'));
  assert.ok(report.restored.includes('Function.prototype.bind'));
  assert.ok(report.restored.includes('Array.from'));
  assert.ok(report.changed >= 4);
  // A clean realm is untouched, and running twice repairs nothing extra.
  assert.equal(reclaimRealm(pristine, pristine).changed, 0);
  assert.equal(reclaimRealm(poisoned, pristine).changed, 0, 'idempotent');
});

test('does not churn the realm when a member is just another realm\'s own copy of the same native', () => {
  const pristine = makeRealm();
  const target = makeRealm();

  const report = reclaimRealm(target, pristine);

  assert.equal(report.changed, 0);
  assert.notEqual(protoOf(target, 'array').reduce, protoOf(pristine, 'array').reduce, 'local copy kept');
});

test('legacy additions are hidden from for..in instead of deleted, so the page keeps working', () => {
  const pristine = makeRealm();
  const poisoned = makeRealm();
  const arrayProto = protoOf(poisoned, 'array');
  // Object.extend(Array.prototype, Enumerable) -- plain assignment, so enumerable.
  arrayProto.each = function prototypEach(): void {};
  arrayProto.collect = function prototypCollect(): void {};
  arrayProto.include = function prototypInclude(): boolean {
    return false;
  };
  protoOf(poisoned, 'string').blank = function prototypBlank(): boolean {
    return true;
  };

  const report = reclaimRealm(poisoned, pristine);

  for (const key of ['each', 'collect', 'include']) {
    assert.equal(typeof arrayProto[key], 'function', `${key} still callable`);
    assert.equal(Object.getOwnPropertyDescriptor(poisoned.array.prototype, key)?.enumerable, false, `${key} hidden from for..in`);
    assert.ok(report.hidden.includes(`Array.prototype.${key}`));
  }
  assert.equal(Object.getOwnPropertyDescriptor(poisoned.string.prototype, 'blank')?.enumerable, false);
  // for..in over something inheriting that prototype no longer sees the additions
  // -- the shape Pixi's `for (i in systems)` over an array runs into.
  const fake = Object.create(arrayProto) as Record<string, unknown>;
  fake[0] = 'a';
  fake[1] = 'b';
  const seen: string[] = [];
  for (const key in fake) seen.push(key);
  assert.deepEqual(seen, ['0', '1']);
});

/**
 * Prototype 1.6 adds Array/String/Number/Date `toJSON` (and hash), and the two
 * callers of a `toJSON` are the reason the reclaim cannot simply delete them:
 *
 *   Prototype:  Object.toJSON(value) -> `if (value.toJSON) return value.toJSON()`
 *               -- NO argument, and the result IS the JSON text.
 *   JSON:       JSON.stringify(v)    -> `v.toJSON(key)`, and the result is the
 *               VALUE to serialize.
 *
 * Deleting the hooks (the first attempt at this) left every page-side
 * `Object.toJSON`/`Ajax.Request(..., postBody: Object.toJSON({...}))` throwing
 * `E.toJSON is not a function` -- measured on the real client page. Keeping them
 * as-is hands JSON.stringify a JSON *string* instead of the array. Distinguishing
 * the two contracts by the argument JSON.stringify always passes satisfies both.
 */
test('an added toJSON keeps Prototype working AND stops hijacking JSON.stringify', () => {
  const pristine = makeRealm();
  const poisoned = makeRealm();
  protoOf(poisoned, 'array').toJSON = function prototypArrayToJSON(this: unknown[]): string {
    return "'[" + this.length + "]'";
  };
  protoOf(poisoned, 'string').toJSON = function prototypStringToJSON(this: string): string {
    return "'" + this + "'";
  };

  const report = reclaimRealm(poisoned, pristine);

  const arrayHook = protoOf(poisoned, 'array').toJSON as (key?: unknown) => unknown;
  const stringHook = protoOf(poisoned, 'string').toJSON as (key?: unknown) => unknown;
  // Prototype's contract: no argument -> the JSON text.
  assert.equal(arrayHook.call([1, 2]), "'[2]'");
  assert.equal(stringHook.call('ab'), "'ab'");
  // JSON.stringify's contract: it passed a key -> hand back the VALUE.
  const arr = [1, 2];
  assert.equal(arrayHook.call(arr, '0'), arr);
  assert.equal(stringHook.call('ab', 0), 'ab');
  assert.ok(report.bridged.includes('Array.prototype.toJSON'));
  assert.ok(report.bridged.includes('String.prototype.toJSON'));
  // Hidden from for..in like every other legacy addition (Prototype's own 1.7
  // behaviour), so an aliasing `for (i in systems)` sees only the indices.
  assert.equal(Object.getOwnPropertyDescriptor(poisoned.array.prototype, 'toJSON')?.enumerable, false);
});

/**
 * The same fix against the REAL realm: poison the prototypes the way Prototype
 * does, snapshot a pristine reference realm BEFORE that, reclaim, then run the
 * two callers for real (@see the note above). Only the real Array.prototype can
 * make `JSON.stringify([1, 2])` observable.
 */
/**
 * A reference realm whose prototypes are COPIES of the real ones (as they were
 * before the poisoning). The reclaim compares descriptors member by member, so a
 * descriptor copy behaves exactly like the throwaway same-origin iframe the
 * browser path snapshots -- while still pointing at the same function objects.
 */
function cloneRealm(realm: Realm): Realm {
  const out: Record<string, unknown> = {};
  for (const [key, ctor] of Object.entries(realm)) {
    if (!ctor) {
      out[key] = undefined;
      continue;
    }
    const prototype = Object.defineProperties(
      {},
      Object.getOwnPropertyDescriptors((ctor as { prototype: object }).prototype),
    );
    out[key] = { prototype, from: (ctor as { from?: unknown }).from };
  }
  return out as unknown as Realm;
}

test('the real JSON.stringify survives a reclaimed Prototype toJSON hook', () => {
  const pristine = cloneRealm(captureRealm(globalThis as unknown as Window & typeof globalThis));
  const target = captureRealm(globalThis as unknown as Window & typeof globalThis);
  const proto = Array.prototype as unknown as Record<string, unknown>;
  const before = Object.getOwnPropertyDescriptor(proto, 'toJSON');
  try {
    Object.defineProperty(proto, 'toJSON', {
      value: function prototypArrayToJSON(this: unknown[]): string {
        return "'[" + this.length + "]'";
      },
      writable: true,
      configurable: true,
      enumerable: true,
    });
    const report = reclaimRealm(target, pristine);
    assert.ok(report.bridged.includes('Array.prototype.toJSON'), 'the hook was recognised and bridged');
    assert.equal(JSON.stringify([1, 2]), '[1,2]', 'JSON.stringify sees the array, not the hook');
    assert.equal(JSON.stringify([[1, 2], 'ab']), '[[1,2],"ab"]');
    assert.equal(
      (Array.prototype as unknown as { toJSON: () => string }).toJSON.call([1, 2]),
      "'[2]'",
      'and the page-side 0-argument contract still answers',
    );
  } finally {
    if (before) Object.defineProperty(proto, 'toJSON', before);
    else delete proto.toJSON;
  }
});

test('a replaced native (Date.prototype.toJSON) is restored, not dropped', () => {
  const pristine = makeRealm();
  const poisoned = makeRealm();
  protoOf(poisoned, 'date').toJSON = function prototypDateToJSON(): string {
    return '"prototype-date"';
  };

  const report = reclaimRealm(poisoned, pristine);

  assert.equal(protoOf(poisoned, 'date').toJSON, protoOf(pristine, 'date').toJSON);
  assert.equal(report.bridged.length, 0);
});

test('unshadows Prototype Element.Methods on the DOM prototypes (HTMLElement.prototype.remove)', () => {
  const pristineElementProto = { remove: function nativeRemove(): void {} };
  const pristine = makeRealm();
  pristine.element = ctor(pristineElementProto);
  pristine.html = ctor(Object.create(pristineElementProto));
  const poisoned = makeRealm();
  poisoned.element = ctor({ remove: function nativeRemove(): void {} });
  // Prototype assigns its own version onto HTMLElement.prototype even though the
  // standard one lives on Element.prototype -- and it throws on detached nodes.
  poisoned.html = ctor(
    Object.assign(Object.create({ remove: function nativeRemove(): void {} }), {
      remove: function prototypRemove(this: { parentNode: unknown }): void {
        if (!this.parentNode) throw new TypeError("Cannot read properties of null (reading 'removeChild')");
      },
    }),
  );

  const report = reclaimRealm(poisoned, pristine);

  assert.ok(!Object.prototype.hasOwnProperty.call(poisoned.html!.prototype, 'remove'), 'shadow deleted');
  assert.equal(typeof (poisoned.html!.prototype as { remove?: unknown }).remove, 'function', 'standard remove shows through');
  assert.ok(report.unshadowed.includes('HTMLElement.prototype.remove'));
});

test('looksLikeLegacyPage spots a Prototype page and leaves a clean page alone', () => {
  const clean = { Array: { prototype: {} }, String: { prototype: {} } } as unknown as Window & typeof globalThis;
  assert.equal(looksLikeLegacyPage(clean), false);

  const withPrototype = { Prototype: {}, Array: { prototype: {} }, String: { prototype: {} } } as unknown as Window & typeof globalThis;
  assert.equal(looksLikeLegacyPage(withPrototype), true);

  const withEnumerable = { Array: { prototype: { each: () => {} } }, String: { prototype: {} } } as unknown as Window & typeof globalThis;
  assert.equal(looksLikeLegacyPage(withEnumerable), true);
});
