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