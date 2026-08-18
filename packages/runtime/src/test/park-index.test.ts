import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DirectorEngine } from '../engine/engine.js';
import { BundleLoader } from '../bundle/loader.js';

const SPARK = readFileSync(
  '/Users/laynester/Projects/habbo26/habbo-sw-js/apps/demo/public/casts/31/hh_room_park.spark',
);
const RM_SCRIPT = readFileSync(
  '/Users/laynester/Projects/habbo26/habbo-sw-js/exported/31/fuse_client/scripts/0030_script_Resource_Manager_Class.ls',
  'utf8',
);

test('preIndexMembers registers park members AND aliases into pAllMemNumList', async () => {
  const loader = new BundleLoader();
  loader.register(SPARK);
  const e = new DirectorEngine();
  const manifest = await e.loadCast(loader, 'hh_room_park');
  assert.ok(manifest, 'park cast must load');
  // find the cast the engine actually created
  const cast = e.casts.find((c) => c.name === 'hh_room_park');
  assert.ok(cast, 'park cast shell exists');
  console.log('park cast number:', cast.number, 'members:', cast.members.size);

  // Register the REAL Resource Manager + Variable Container scripts (verbatim).
  e.addScriptMember('Resource Manager Class', 'parent', RM_SCRIPT);
  const script = e.resolveScript('Resource Manager Class')!;
  const rm = e.interp.newInstance(script, []);
  const VC_SCRIPT = readFileSync(
    '/Users/laynester/Projects/habbo26/habbo-sw-js/exported/31/fuse_client/scripts/0047_script_Variable_Container_Class.ls',
    'utf8',
  );
  e.addScriptMember('Variable Container Class', 'parent', VC_SCRIPT);
  const vcScript = e.resolveScript('Variable Container Class')!;
  const vc = e.interp.newInstance(vcScript, []);
  vc.props.set('pItemList', e.interp.evalExpressionString('[:]'));
  // bare handler so the corpus's getVariableManager() resolves to the vc
  e.globals.set('__vcProbe', vc);
  e.addScriptMember('Variable API Probe', 'movie', 'on getVariableManager\n  return __vcProbe\nend');
  e.addScriptMember('Object Manager Stub', 'movie', 'on getObjectManager\n  return 0\nend');

  // Isolate the crash: run dump(1) directly (the step preIndexMembers hits
  // for the park cast, which HAS a variable.index member).
  let dumpThrown: string | null = null;
  try {
    e.interp.callObjectHandler(vc, 'dump', [1, 'RETURN', 0]);
  } catch (err) {
    dumpThrown = err instanceof Error ? err.message : String(err);
  }
  console.log('dump(1) thrown:', dumpThrown);
  // preIndexMembers resets pAllMemNumList when called with no args; give it a fresh proplist
  rm.props.set('pAllMemNumList', e.interp.evalExpressionString('[:]'));
  // Mirror the live client: the System_Props variables ARE defined there.
  e.interp.evalExpressionString('setVariable("props.index.field", "variable.index")');
  e.interp.evalExpressionString('setVariable("override.props.index.field", "override.variable.index")');
  e.interp.evalExpressionString('setVariable("alias.index.field", "memberalias.index")');
  e.interp.evalExpressionString('setVariable("class.index.field", "class.index")');
  e.interp.evalExpressionString('setVariable("thread.index.field", "thread.index")');
  e.interp.evalExpressionString('setVariable("texts.index.field", "text.index")');

  let thrown: string | null = null;
  let r: unknown = null;
  try {
    r = e.interp.callObjectHandler(rm, 'preIndexMembers', [cast.number]);
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
  }
  console.log('preIndexMembers result:', String(r), thrown ? 'THREW: ' + thrown : '');

  const list = rm.props.get('pAllMemNumList') as any;
  const entries: string[] = [];
  if (list && list.props) {
    for (const [k, v] of (list.props as any).entries ? (list.props as any).entries() : []) {
      if (String(k).includes('queue_tile')) entries.push(k + '=' + v);
    }
  }
  console.log('list size:', list && list.props ? list.props.size : 'n/a', 'queue entries:', JSON.stringify(entries));
  assert.ok(entries.some((x) => x.startsWith('s_queue_tile2_a_0_1_1_0_0=')), 'dir-0 member registered');
  assert.ok(entries.some((x) => x.startsWith('s_queue_tile2_a_0_1_1_4_0=-')), 'dir-4 alias registered (negative)');
});
