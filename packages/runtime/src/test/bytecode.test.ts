import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLingo } from '../lingo/parser.js';
import { encodeScript, decodeScript } from '../lingo/bytecode.js';

function norm(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(norm);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>)) {
      const val = (v as Record<string, unknown>)[k];
      if (val === undefined) continue;
      out[k] = norm(val);
    }
    return out;
  }
  return v;
}

function roundTrip(source: string): void {
  const parsed = parseLingo(source);
  const bytes = encodeScript(parsed);
  const decoded = decodeScript(bytes);
  assert.deepStrictEqual(norm(decoded), norm(parsed), `round-trip mismatch for:\n${source}`);
}

test('bytecode round-trips every statement + expression kind', () => {
  roundTrip(`-- Cast member: Kitchen Sink
-- Type: Parent
property pCounter, pName
global gA, gB
on new me
  return me
end
on run me, n
  global gA
  pCounter = pCounter + 1
  put "hello" into pName
  put 5 after pName
  put "x" before gA
  delete the last char of pName
  if pCounter > 10 then
    return 1
  else if pCounter = 5 then
    return 2
  else
    return 3
  end if
end
on multi me
  case pCounter of
    1:
      return "one"
    2, 3, 4:
      return "small"
    otherwise:
      return "big"
  end case
end
on loops me
  repeat with i = 1 to 10
    if i mod 2 = 0 then next repeat
    put i
  end repeat
  repeat with i = 10 down to 1
    exit repeat
  end repeat
  repeat while pCounter < 100
    pCounter = pCounter * 2
  end repeat
  repeat with x in gA
    put x
  end repeat
  repeat with e in [1, 2, 3]
    put e
  end repeat
end
on exprs me
  put [#key: "value", #num: 42]
  put [1, "two", 3.5, -4, not true]
  put (3 + 4) * 5 - 2 / 1 & "x"
  put 1 < 2 and 3 >= 2 or not (1 <> 2)
  put "abc" contains "b"
  put "abc" starts with "a"
  put 5.0 / 2.0
  put char 2 of "abc"
  put word 1 to 2 of "a b c"
  put item 3 of gA
  put the mouseLoc
  put the date
  put the seconds
  put value("123")
  put 123 string
  put string(123)
  put the length of pName
  put void
end
on myHandler me, a, b
  return a
  return
end
`);
});

test('bytecode round-trips script types and header comments', () => {
  roundTrip(`-- Cast member: Score Loop
-- Type: Score
on exitFrame me
  go(the frame)
end
`);
  roundTrip(`-- Cast member: Movie One
-- Type: Movie
on startMovie
  go to frame 1
end
`);
  roundTrip(`-- Cast member: Behavior
-- Type: Behavior
property pSprite
on beginSprite me
  pSprite = sprite(me.spriteNum)
end
`);
  roundTrip(`on untitled me
  return me
end
`);
});

test('bytecode round-trips property lists and `the` chains faithfully', () => {
  roundTrip(`on chain me
  put the number of lines of the text of member("entry_text")
  put the locH of the loc of sprite 5
  put aList[1]
  put tProps[#key]
  put tProps.key
  put valueOf(me).item
  put (me).prop
end
`);
});

test('bytecode decode rejects garbage', () => {
  assert.throws(() => decodeScript(new Uint8Array([0x4c, 0x42, 0x43, 0x58, 1])));
  const parsed = parseLingo('on x\n  return 1\nend\n');
  const bytes = encodeScript(parsed);
  bytes[7] = 99; // corrupt a tag
  assert.throws(() => decodeScript(bytes));
});