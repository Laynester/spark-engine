import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DirectorEngine } from '../engine/engine.js';
import { compileHandlerBody } from '../lingo/jit.js';
import { Env, ExitSignal, ReturnSignal } from '../lingo/interpreter.js';
import {
  LEMPTY,
  LList,
  LPropList,
  LSymbol,
  PropPairs,
  VOID,
  asNum,
  isTruthy,
  lingoEquals,
  lingoNegate,
} from '../lingo/values.js';

function compileAndMake(handler: Parameters<typeof compileHandlerBody>[0]): { fn: Function; nodes: unknown[] } | null {
  const c = compileHandlerBody(handler, new Set());
  if (!c) return null;
  const fn = new Function(
    'env', 'I', 'args', 'N', 'Ret', 'Exit', 'ExitR', 'NextR',
    'LList', 'LPropList', 'PropPairs', 'LSym', 'LEMPTY', 'VOID',
    'asNum', 'isTruthy', 'lingoEquals', 'lingoNegate',
    c.src,
  ) as Function;
  return { fn, nodes: c.nodes };
}

function handlerOf(engine: DirectorEngine, scriptName: string, handlerName: string) {
  const s = engine.resolveScript(scriptName);
  assert.ok(s, `script ${scriptName} resolves`);
  const h = s!.handlers.find((x) => x.name.toLowerCase() === handlerName);
  assert.ok(h, `handler ${handlerName} exists`);
  return { script: s!, handler: h! };
}

function interpRun(engine: DirectorEngine, handler: Parameters<typeof compileHandlerBody>[0], params: string[], argVals: unknown[], globals = new Set<string>()) {
  const env = new Env(null, globals);
  let offset = 0;
  if (handler.params.length > 0 && handler.params[0].toLowerCase() === 'me') offset = 1;
  for (let i = offset; i < params.length; i++) {
    env.setLower(params[i].toLowerCase(), argVals[i - offset] === undefined ? VOID : (argVals[i - offset] as never));
  }
  try {
    engine.interp.execBody(handler.body, env);
  } catch (e) {
    if (e instanceof ReturnSignal) return e.value;
    if (e instanceof ExitSignal) return VOID;
    throw e;
  }
  return VOID;
}

function jitRun(engine: DirectorEngine, entry: { fn: Function; nodes: unknown[] }, argVals: unknown[], globals = new Set<string>()) {
  const env = new Env(null, globals);
  const r = entry.fn(
    env, engine.interp, argVals, entry.nodes,
    ReturnSignal, ExitSignal,
    class ExitRepeatSignal {}, class NextRepeatSignal {},
    LList, LPropList, PropPairs, LSymbol, LEMPTY, VOID,
    asNum, isTruthy, lingoEquals, lingoNegate,
  );
  return r === undefined ? VOID : r;
}

test('jit: loop/arith/case handler compiles and matches the interpreter exactly', () => {
  const e = new DirectorEngine();
  e.addScriptMember('T', 'movie', [
    'on compute tN',
    '  tSum = 0',
    '  repeat with tK = 1 to tN',
    '    tSum = tSum + tK * 2',
    '    if tSum mod 3 = 0 then tSum = tSum + 1',
    '  end repeat',
    '  case tN of',
    '    0: tSum = tSum + 10',
    '    1: tSum = tSum + 20',
    '    otherwise: tSum = tSum + 30',
    '  end case',
    '  return tSum',
    'end',
  ].join('\n'));
  const { script, handler } = handlerOf(e, 'T', 'compute');
  const entry = compileAndMake(handler);
  assert.ok(entry, 'pure handler compiles');
  for (const n of [0, 1, 2, 5, 12]) {
    const interp = interpRun(e, handler, ['tn'], [n]);
    const jit = jitRun(e, entry!, [n]);
    assert.equal(jit, interp, `divergence at tN=${n}`);
  }
});

test('jit: nested repeat-with-in over lists matches the interpreter (slot shadowing regression)', () => {
  const e = new DirectorEngine();
  e.addScriptMember('T2', 'movie', [
    'on run',
    '  t = [#a: [1, 2], #b: [3]]',
    '  tSum = 0',
    '  repeat with tItem in t',
    '    repeat with tN in tItem',
    '      tSum = tSum + tN',
    '    end repeat',
    '  end repeat',
    '  return tSum',
    'end',
  ].join('\n'));
  const { script, handler } = handlerOf(e, 'T2', 'run');
  const entry = compileAndMake(handler);
  assert.ok(entry, 'nested loops compile');
  const interp = interpRun(e, handler, [], []);
  const jit = jitRun(e, entry!, []);
  assert.equal(jit, 6);
  assert.equal(jit, interp);
});

test('jit: method handler with me and prop assignment matches the interpreter', () => {
  const e = new DirectorEngine();
  e.addScriptMember('Counter', 'parent', [
    'on construct me',
    '  me.pN = 0',
    'end',
    'on bump me, x',
    '  me.pN = me.pN + x',
    '  return me.pN',
    'end',
  ].join('\n'));
  const { handler } = handlerOf(e, 'Counter', 'bump');
  const c = compileHandlerBody(handler, new Set());
  assert.ok(c, 'method handler compiles');
  const obj = e.interp.newInstance(e.resolveScript('Counter')!, []);
  const env = new Env(null, new Set());
  env.me = obj;
  const out = new Function(
    'env', 'I', 'args', 'N', 'Ret', 'Exit', 'ExitR', 'NextR',
    'LList', 'LPropList', 'PropPairs', 'LSym', 'LEMPTY', 'VOID',
    'asNum', 'isTruthy', 'lingoEquals', 'lingoNegate', c!.src,
  )(env, e.interp, [4], c!.nodes, ReturnSignal, ExitSignal,
    class {}, class {}, LList, LPropList, PropPairs, LSymbol, LEMPTY, VOID,
    asNum, isTruthy, lingoEquals, lingoNegate);
  assert.equal(out, 4, 'compiled bump me,4 returns me.pN=4');
  assert.equal(obj.props.get('pN'), 4, 'instance prop written through the compiled path');
  // Second call proves instance state persists through repeated compiled calls.
  const env2 = new Env(null, new Set());
  env2.me = obj;
  const out2 = new Function(
    'env', 'I', 'args', 'N', 'Ret', 'Exit', 'ExitR', 'NextR',
    'LList', 'LPropList', 'PropPairs', 'LSym', 'LEMPTY', 'VOID',
    'asNum', 'isTruthy', 'lingoEquals', 'lingoNegate', c!.src,
  )(env2, e.interp, [1], c!.nodes, ReturnSignal, ExitSignal,
    class {}, class {}, LList, LPropList, PropPairs, LSymbol, LEMPTY, VOID,
    asNum, isTruthy, lingoEquals, lingoNegate);
  assert.equal(out2, 5);
});

test('jit: local next/exit repeat use jumps and preserve nested loop control', () => {
  const source = [
    'on run',
    '  total = 0',
    '  repeat with i = 5 down to 1',
    '    if i = 4 then next repeat',
    '    repeat with v in [1, 2, 3]',
    '      if v = 2 then next repeat',
    '      n = 0',
    '      repeat while n < 4',
    '        n = n + 1',
    '        if n = 1 then next repeat',
    '        if n = 3 then exit repeat',
    '        total = total + i + v + n',
    '      end repeat',
    '      if i = 2 then exit repeat',
    '    end repeat',
    '  end repeat',
    '  return total',
    'end',
  ].join('\n');
  const baseline = new DirectorEngine();
  const compiled = new DirectorEngine();
  baseline.addScriptMember('Control', 'movie', source);
  compiled.addScriptMember('Control', 'movie', source);
  const { handler: h0 } = handlerOf(baseline, 'Control', 'run');
  const { handler } = handlerOf(compiled, 'Control', 'run');
  const body = compileHandlerBody(handler, new Set());
  assert.ok(body);
  assert.doesNotMatch(body.src, /throw new (NextR|ExitR)/);
  const entry = compileAndMake(handler);
  assert.ok(entry);
  assert.equal(jitRun(compiled, entry, []), interpRun(baseline, h0, [], []));
});

test('jit: chunk reads compile and match the interpreter', () => {
  const e = new DirectorEngine();
  e.addScriptMember('T3', 'movie', [
    'on a tS',
    '  tN = "hello world again"',
    '  tW = tN.word[2]',
    '  return tN.word.count + length(tW) + tN.char[6..7]',
    'end',
  ].join('\n'));
  const { handler: hA } = handlerOf(e, 'T3', 'a');
  const entryA = compileAndMake(hA);
  assert.ok(entryA, 'chunk handler compiles');
  for (const arg of ['hello there world', 'x y', '']) {
    assert.equal(jitRun(e, entryA!, [arg]), interpRun(e, hA, ['ts'], [arg]));
  }
});

test('jit: float channels match the interpreter exactly (division, float literals, props, globals)', () => {
  const e = new DirectorEngine();
  e.addScriptMember('Tf', 'movie', [
    'on div tA',
    '  tX = tA / 2',
    '  tY = tX + 1',
    '  return tY',
    'end',
    'on lit',
    '  tX = 2.0',
    '  tY = tX + 1',
    '  return tY / 3',
    'end',
    'on litsub',
    '  tX = -(2.0)',
    '  return tX / 3',
    'end',
    'on declareGlobal',
    '  global gN',
    'end',
    'on g',
    '  gN = 2.0',
    '  return gN / 3',
    'end',
  ].join('\n'));
  // Only unary/literal float propagation survives division observably: plain
  // integer division truncates, and a float 1.0 is indistinguishable from
  // integer 1 as a JS number.
  const cases: [string, string[], unknown[], boolean][] = [
    ['div', ['ta'], [5], false],
    ['div', ['ta'], [5.0], false],
    ['div', ['ta'], [7], false],
    ['lit', [], [], false],
    ['litsub', [], [], true],
    ['g', [], [], true],
  ];
  for (const [name, params, args, expectFloat] of cases) {
    const { handler } = handlerOf(e, 'Tf', name);
    const entry = compileAndMake(handler);
    assert.ok(entry, `handler ${name} compiles`);
    const globals = name === 'g' ? new Set(['gn']) : new Set<string>();
    const jit = jitRun(e, entry!, args, globals);
    const interp = interpRun(e, handler, params, args, globals);
    assert.equal(jit, interp, `float divergence at ${name}`);
    assert.equal(Number.isInteger(jit), !expectFloat, `${name} result ${jit} floatness`);
  }
});

test('jit: float prop channels match the interpreter (cross-statement and cross-object)', () => {
  const e = new DirectorEngine();
  e.addScriptMember('Tfp', 'parent', [
    'on bump me',
    '  me.pN = 2.0',
    '  return me.pN / 3',
    'end',
    'on sub me',
    '  me.pM = -(2.0)',
    '  return me.pM / 3',
    'end',
  ].join('\n'));
  for (const name of ['bump', 'sub']) {
    const { script, handler } = handlerOf(e, 'Tfp', name);
    const entry = compileAndMake(handler);
    assert.ok(entry, `${name} compiles`);
    const obj = e.interp.newInstance(script, []);
    const env = new Env(null, new Set());
    env.me = obj;
    const r = entry.fn(
      env, e.interp, [], entry.nodes,
      ReturnSignal, ExitSignal,
      class {}, class {}, LList, LPropList, PropPairs, LSymbol, LEMPTY, VOID,
      asNum, isTruthy, lingoEquals, lingoNegate,
    );
    const objI = e.interp.newInstance(script, []);
    const envI = new Env(null, new Set());
    envI.me = objI;
    let ri: unknown;
    try {
      e.interp.execBody(handler.body, envI);
    } catch (err) {
      if (err instanceof ReturnSignal) ri = err.value;
      else throw err;
    }
    assert.equal(r, ri, `${name} float prop divergence`);
    assert.ok(typeof r === 'number' && !Number.isInteger(r), `${name} result ${r} should be float`);
  }
});

test('jit: the-expressions do not compile (host curEnv routing keeps them interpreted)', () => {
  const e = new DirectorEngine();
  e.addScriptMember('T3b', 'movie', [
    'on a',
    '  return the floatPrecision',
    'end',
    'on b',
    '  the itemDelimiter = ","',
    '  t = "x,y"',
    '  return t.item[2]',
    'end',
  ].join('\n'));
  for (const name of ['a', 'b']) {
    const { handler } = handlerOf(e, 'T3b', name);
    assert.equal(compileHandlerBody(handler, new Set()), null, `handler ${name} must not compile`);
  }
});

test('an interpreted handler keeps its parameters when called as a global function', () => {
  // `args` never carries `me` (Lingo passes it implicitly), so the interpreter
  // must skip a leading `me` param the same unconditional way Gen.run() does.
  // It only skipped it when an instance was present, so a handler the JIT
  // declines — here `the itemDelimiter` — reached as a plain function call
  // (`parseState("...")`) bound args[0] to `me` and shifted everything: the
  // state string went into the me slot and the last parameter came out VOID.
  // hh_roomdimmer's Furniture_Roomdimmer::setState parses its furniture state
  // exactly this way.
  const e = new DirectorEngine();
  e.addScriptMember('Tglob', 'movie', [
    'on parseState me, tState',
    '  the itemDelimiter = ","',
    '  return [string(tState), tState.item.count, tState.item[2], tState.item[5]]',
    'end',
  ].join('\n'));
  const { handler } = handlerOf(e, 'Tglob', 'parsestate');
  assert.equal(compileHandlerBody(handler, new Set()), null, 'the-itemDelimiter handler stays interpreted');

  const out = e.interp.evalExpressionString('parseState("2,1,1,#74f5f5,120")');
  assert.ok(out instanceof LList, 'returns the list');
  assert.deepEqual((out as LList).items, ['2,1,1,#74f5f5,120', 5, '1', '120'], 'parameters are not shifted');
});

test('jit: experimental scalar the reads remain opt-in and match isolated interpreter runs', () => {
  const source = [
    'on compute me, count',
    '  total = 0',
    '  repeat with i = 1 to count',
    '    total = total + the milliseconds',
    '  end repeat',
    '  return total + the floatPrecision',
    'end',
  ].join('\n');
  for (const count of [0, 1, 7]) {
    const interpreted = new DirectorEngine();
    const compiled = new DirectorEngine();
    const reads: string[][] = [[], []];
    for (const [i, engine] of [interpreted, compiled].entries()) {
      engine.addScriptMember('Scalar', 'movie', source);
      let n = 0;
      engine.getThe = (head) => {
        n++;
        reads[i].push(head.toLowerCase());
        return head.toLowerCase() === 'milliseconds' ? n * 10 : 4;
      };
    }
    const { script: scriptI, handler: handlerI } = handlerOf(interpreted, 'Scalar', 'compute');
    const { script, handler } = handlerOf(compiled, 'Scalar', 'compute');
    assert.equal(compileHandlerBody(handler, new Set()), null);
    const body = compileHandlerBody(handler, new Set(), { scalarTheReads: true });
    assert.ok(body, 'explicit experiment compiles selected scalar reads');
    const fn = new Function(
      'env', 'I', 'args', 'N', 'Ret', 'Exit', 'ExitR', 'NextR',
      'LList', 'LPropList', 'PropPairs', 'LSym', 'LEMPTY', 'VOID',
      'asNum', 'isTruthy', 'lingoEquals', 'lingoNegate', body.src,
    );
    const expected = interpreted.interp.callHandler(scriptI, handlerI, [count], null, new Set());
    assert.equal(jitRun(compiled, { fn, nodes: body.nodes }, [count]), expected);
    assert.deepEqual(reads[1], reads[0], 'every read stays ordered and is not hoisted');
    assert.equal(
      compiled.interp.callHandler(script, handler, [count], null, new Set()),
      interpreted.interp.callHandler(scriptI, handlerI, [count], null, new Set()),
    );
  }
});

test('jit: chain-free reads without script properties match isolated interpreter runs', () => {
  const source = [
    'on run me, count',
    '  total = 0',
    '  repeat with i = 1 to count',
    '    total = total + the frameTempo',
    '  end repeat',
    '  return [total, the platform, the itemDelimiter, the mouseH, the key, the floatPrecision]',
    'end',
  ].join('\n');
  for (const count of [0, 1, 5]) {
    const interpreted = new DirectorEngine();
    const compiled = new DirectorEngine();
    for (const engine of [interpreted, compiled]) {
      engine.frameTempo = 37;
      engine.setThe('itemDelimiter', [], '|');
      engine.addScriptMember('Wide', 'movie', source);
    }
    const { handler: baseline } = handlerOf(interpreted, 'Wide', 'run');
    const { handler } = handlerOf(compiled, 'Wide', 'run');
    assert.equal(compileHandlerBody(handler, new Set()), null);
    const body = compileHandlerBody(handler, new Set(), { scalarTheReads: true });
    assert.ok(body, 'chain-free reads without properties compile');
    const fn = new Function(
      'env', 'I', 'args', 'N', 'Ret', 'Exit', 'ExitR', 'NextR',
      'LList', 'LPropList', 'PropPairs', 'LSym', 'LEMPTY', 'VOID',
      'asNum', 'isTruthy', 'lingoEquals', 'lingoNegate', body.src,
    );
    const expected = interpRun(interpreted, baseline, baseline.params, [count]);
    const actual = jitRun(compiled, { fn, nodes: body.nodes }, [count]);
    assert.deepEqual(actual, expected);
    assert.ok(actual instanceof LList);
    assert.equal(actual.items[0], count * 37);
    assert.deepEqual(compiled.logs, interpreted.logs);
  }
});

test('jit: experimental scalar reads reject chains, writes, and property-bound handlers', () => {
  const e = new DirectorEngine();
  e.addScriptMember('Guarded', 'parent', [
    'property pValue',
    'on chain me, lib',
    '  return the number of castMembers of castLib lib',
    'end',
    'on write me',
    '  the itemDelimiter = ","',
    '  return the milliseconds',
    'end',
    'on other me',
    '  return the frameTempo',
    'end',
    'on collision me, pValue, x',
    '  return x + the milliseconds',
    'end',
    'on propertyRead me',
    '  return pValue + the milliseconds',
    'end',
  ].join('\n'));
  for (const name of ['chain', 'write', 'other', 'collision', 'propertyread']) {
    const { script, handler } = handlerOf(e, 'Guarded', name);
    assert.equal(compileHandlerBody(handler, new Set(script.props.map((p) => p.toLowerCase())), { scalarTheReads: true }), null, name);
  }
});

test('jit: put/delete handlers do not compile (interpreter keeps them)', () => {
  const e = new DirectorEngine();
  e.addScriptMember('T4', 'movie', [
    'on b',
    '  put "x"',
    'end',
    'on c tS',
    '  delete char 1 of tS',
    '  return tS',
    'end',
  ].join('\n'));
  for (const name of ['b', 'c']) {
    const { handler } = handlerOf(e, 'T4', name);
    assert.equal(compileHandlerBody(handler, new Set()), null, `handler ${name} must not compile`);
  }
});