import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DirectorEngine } from '../engine/engine.js';
import { PARK_LINGO, PARK_PAYLOAD } from './fixtures/park-data.js';

// EXACT v31 Connection_Instance_Class GetIntFrom/GetStrFrom (exported Lingo,
// verbatim) + v31 Room_Handler_Class parseActiveObject/handle_activeobjects.
// The only deviation: the furnidata branch is stubbed so positive classIDs
// are visible (diagnostic), everything else is byte-for-byte the export.
// Source shared with the VM equivalence test: see fixtures/park-data.ts.
const LINGO = PARK_LINGO;

test('park_a ACTIVE_OBJECTS parse through our engine matches the reference', () => {
  const e = new DirectorEngine();
  e.addScriptMember('Park Parse Probe', 'parent', LINGO);
  const script = e.resolveScript('Park Parse Probe')!;
  const inst = e.interp.newInstance(script, []);
  // Mirror forwardMsg: pMsgStruct carries #connection + #content and is passed
  // to the registered handler as tMsg.
  const struct = e.interp.evalExpressionString('[:]') as any;
  (struct as any).props.set('connection', inst);
  (struct as any).props.set('content', PARK_PAYLOAD);
  // msghandler mutates the shared pMsgStruct property on the connection
  // (line 805: pMsgStruct.setaProp(#content, tParams)) before calling the
  // handler, and GetIntFrom/GetStrFrom read pMsgStruct.
  (inst as any).props.set('pMsgStruct', struct);
  const r = e.interp.callObjectHandler(inst, 'handle_activeobjects', [struct]) as any;
  console.log('return:', String(r), 'logs:', JSON.stringify(e.logs.slice(-8)));
  const list = r && typeof r === 'object' && 'items' in r ? (r as any).items : r;
  const arr = Array.isArray(list) ? list : [];
  console.log('parsed count:', arr.length);
  const clsCount: Record<string, number> = {};
  let badDims = 0;
  let dirs = new Set<number>();
  let xs: number[] = [];
  let ys: number[] = [];
  let ids: number[] = [];
  if (arr.length > 0) {
    const first = arr[0] as any;
    const fk: string[] = [];
    (first.props as any).forEach((v: unknown, k: string) => fk.push(String(k)));
    console.log('first object prop keys:', JSON.stringify(fk));
  }
  for (const o of arr) {
    const props: any = o && o.props ? o.props : new Map();
    const g = (k: string) => props.get(k) ?? props.get('#' + k) ?? props.get(k.toLowerCase());
    const cls = String(g('class'));
    clsCount[cls] = (clsCount[cls] || 0) + 1;
    const dims = g('dimensions');
    if (!dims || !(dims as any).items || (dims as any).items.length !== 2) badDims++;
    const dir = g('direction');
    if (dir && (dir as any).items && (dir as any).items.length >= 1) {
      dirs.add(Number((dir as any).items[0]));
    }
    xs.push(Number(g('x')));
    ys.push(Number(g('y')));
    ids.push(Number(g('id')));
  }
  console.log('classes:', JSON.stringify(clsCount));
  console.log('non-list dims:', badDims);
  console.log('dirs:', [...dirs].sort((a, b) => a - b).join(','));
  console.log('x range:', Math.min(...xs), '-', Math.max(...xs), 'y range:', Math.min(...ys), '-', Math.max(...ys));
  console.log('id range:', Math.min(...ids), '-', Math.max(...ids));
  assert.equal(arr.length, 31, 'expected 31 objects');
  assert.equal(clsCount['queue_tile2'], 31, 'all objects must be queue_tile2');
  assert.equal(badDims, 0, 'all dimensions must be lists [1,1]');
  assert.deepEqual([...dirs].sort((a, b) => a - b), [0, 2, 4], 'directions 0,2,4');
});
