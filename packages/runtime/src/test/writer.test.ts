import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DirectorEngine } from '../engine/engine.js';
import { LObject } from '../lingo/values.js';
import { rasterizeTextMember } from '../stage/text.js';

// Real exported v31 Writer Class (0069) driven like the navigator does:
//   pWriterPlainNormWrap: setFont(tPlain) + define([#wordWrap: 1]) +
//   define([#rect: rect(0,0,tWidth,0)]) + render(tRoomDesc)
//   pWriterPlainBoldLeft: setFont(tBold) + render(tHeaderTxt)  (pTxtRect VOID)

const WRITER = [
  'property pMember',
  'property pDefRect',
  'property pTxtRect',
  'property pFntStru',
  'property pTextRenderMode',
  'property pUnderliningDisabled',
  'property pDontProfile',
  'on construct me',
  '  pDefRect = rect(0, 0, 480, 480)',
  '  pTxtRect = VOID',
  '  pFntStru = VOID',
  '  pMember = member(getResourceManager().createMember("writer_" & getUniqueID(), #text))',
  '  if variableExists("text.render.compatibility.mode") then',
  '    pTextRenderMode = getVariable("text.render.compatibility.mode")',
  '  else',
  '    pTextRenderMode = 1',
  '  end if',
  '  if variableExists("text.underlining.disabled") then',
  '    pUnderliningDisabled = getVariable("text.underlining.disabled")',
  '  else',
  '    pUnderliningDisabled = 0',
  '  end if',
  '  me.setProfiling()',
  '  if pMember.number = 0 then',
  '    return 0',
  '  else',
  '    pMember.alignment = #left',
  '    pMember.wordWrap = 0',
  '    return 1',
  '  end if',
  'end',
  'on setProfiling',
  '  if voidp(pDontProfile) then',
  '    pDontProfile = 1',
  '    if getObjectManager().managerExists(#variable_manager) then',
  '      if variableExists("profile.fields.enabled") then',
  '        pDontProfile = 0',
  '      end if',
  '    end if',
  '  end if',
  'end',
  'on define me, tMetrics',
  '  if not ilk(tMetrics, #propList) then',
  '    return 0',
  '  end if',
  '  if stringp(tMetrics[#font]) then',
  '    if pMember.font <> tMetrics.font then',
  '      pMember.font = tMetrics.font',
  '    end if',
  '  end if',
  '  if listp(tMetrics[#fontStyle]) then',
  '    if pMember.fontStyle <> tMetrics.fontStyle then',
  '      pMember.fontStyle = tMetrics.fontStyle',
  '    end if',
  '  end if',
  '  if symbolp(tMetrics[#alignment]) then',
  '    if pMember.alignment <> tMetrics.alignment then',
  '      pMember.alignment = tMetrics.alignment',
  '    end if',
  '  end if',
  '  if ilk(tMetrics[#color], #color) then',
  '    if pMember.color <> tMetrics.color then',
  '      pMember.color = tMetrics.color',
  '    end if',
  '  end if',
  '  if ilk(tMetrics[#bgColor], #color) then',
  '    if pMember.bgColor <> tMetrics.bgColor then',
  '      pMember.bgColor = tMetrics.bgColor',
  '    end if',
  '  end if',
  '  if integerp(tMetrics[#wordWrap]) then',
  '    if pMember.wordWrap <> tMetrics.wordWrap then',
  '      pMember.wordWrap = tMetrics.wordWrap',
  '    end if',
  '  end if',
  '  if integerp(tMetrics[#fontSize]) then',
  '    if pMember.fontSize <> tMetrics.fontSize then',
  '      pMember.fontSize = tMetrics.fontSize',
  '    end if',
  '  end if',
  '  if ilk(tMetrics[#rect], #rect) then',
  '    if pMember.width <> tMetrics.rect.width then',
  '      pMember.rect = tMetrics.rect',
  '    end if',
  '  end if',
  '  if pMember.fixedLineSpace <> pMember.fontSize then',
  '    pMember.fixedLineSpace = pMember.fontSize',
  '  end if',
  '  if integerp(tMetrics[#fixedLineSpace]) then',
  '    tTopSpacing = tMetrics.fixedLineSpace - pMember.fontSize',
  '    if pMember.topSpacing <> tTopSpacing then',
  '      pMember.topSpacing = tTopSpacing',
  '    end if',
  '  end if',
  '  executeMessage(#invalidateCrapFixRegion)',
  '  pTxtRect = tMetrics[#rect]',
  '  return 1',
  'end',
  'on render me, tText, tRect',
  '  if tText = VOID then',
  '    tText = EMPTY',
  '  end if',
  '  pMember.text = tText',
  '  if tRect.ilk = #rect then',
  '    if pMember.width <> tRect.width then',
  '      pMember.rect = tRect',
  '    end if',
  '  else',
  '    if voidp(pTxtRect) then',
  '      tAlignment = pMember.alignment',
  '      pMember.alignment = #left',
  '      pMember.rect = pDefRect',
  '      tTotal = length(tText.line[1])',
  '      tWidth = pMember.charPosToLoc(tTotal).locH',
  '      if tText.line.count > 1 then',
  '        repeat with i = 2 to tText.line.count',
  '          tTotal = tTotal + length(tText.line[i]) + 1',
  '          tNext = pMember.charPosToLoc(tTotal).locH',
  '          if tNext > tWidth then',
  '            tWidth = tNext',
  '          end if',
  '        end repeat',
  '      end if',
  '      tWidth = tWidth + pMember.fontSize',
  '      pMember.rect = rect(0, 0, tWidth, pMember.height)',
  '      pMember.alignment = tAlignment',
  '    else',
  '      if pMember.width <> pTxtRect.width then',
  '        pMember.rect = pTxtRect',
  '      end if',
  '    end if',
  '  end if',
  '  executeMessage(#invalidateCrapFixRegion)',
  '  tImage = pMember.image',
  '  return tImage',
  'end',
  'on setFont me, tStruct',
  '  if pMember.font <> tStruct.getaProp(#font) then',
  '    pMember.font = tStruct.getaProp(#font)',
  '  end if',
  '  if pMember.fontSize <> tStruct.getaProp(#fontSize) then',
  '    pMember.fontSize = tStruct.getaProp(#fontSize)',
  '  end if',
  '  if pMember.fontStyle <> tStruct.getaProp(#fontStyle) then',
  '    pMember.fontStyle = tStruct.getaProp(#fontStyle)',
  '  end if',
  '  if pMember.color <> tStruct.getaProp(#color) then',
  '    pMember.color = tStruct.getaProp(#color)',
  '  end if',
  '  if pMember.fixedLineSpace <> pMember.fontSize then',
  '    pMember.fixedLineSpace = pMember.fontSize',
  '  end if',
  '  tLineHeight = pMember.fontSize + pMember.topSpacing',
  '  if tLineHeight <> tStruct.getaProp(#lineHeight) then',
  '    pMember.topSpacing = tStruct.getaProp(#lineHeight) - pMember.fontSize',
  '  end if',
  '  executeMessage(#invalidateCrapFixRegion)',
  '  return 1',
  'end',
].join('\n');

test('real Writer Lingo renders the navigator node description (rect height 0 wrap)', () => {
  const { document } = globalThis as { document?: unknown };
  const draws: Array<[string, number, number]> = [];
  const ctxMock = {
    font: '', fillStyle: '', textAlign: '', textBaseline: '',
    measureText: (s: string) => ({ width: s.length * 8, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }),
    fillRect: () => undefined,
    fillText: (t: string, x: number, y: number) => { draws.push([t, x, y]); },
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  };
  (globalThis as Record<string, unknown>).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctxMock }),
  };
  try {
    const e = new DirectorEngine();
    e.getCastLib('Internal');
    e.textRasterizer = rasterizeTextMember;

    // Global stubs for the Writer's dependencies.
    e.addScriptMember(
      'Globals',
      'movie',
      [
        'on getResourceManager',
        '  return getObject(#rm)', // set below
        'end',
        'on getUniqueID',
        '  return 7',
        'end',
        'on getObjectManager',
        '  return getObject(#om)',
        'end',
        'on variableExists t',
        '  return 0',
        'end',
        'on getVariable t',
        '  return 0',
        'end',
      ].join('\n'),
    );
    const rmScript = e.addScriptMember('RM', 'parent', [
      'on createMember me, tMemName, ttype',
      '  tmember = new(ttype, castLib(1))',
      '  tmember.name = tMemName',
      '  return tmember.number',
      'end',
      'on removeMember me, tMemName',
      '  return 1',
      'end',
      'on getmemnum me, tMemName',
      '  return 0',
      'end',
    ].join('\n'));
    const rm = e.interp.newInstance(rmScript.script!, []);
    const omScript = e.addScriptMember('OM', 'parent', ['on managerExists me, tName', '  return 0', 'end'].join('\n'));
    const om = e.interp.newInstance(omScript.script!, []);
    e.setObjectById('rm', rm);
    e.setObjectById('om', om);

    const wScript = e.addScriptMember('Writer', 'parent', WRITER);
    const mkWriter = (): LObject => {
      const w = e.interp.newInstance(wScript.script!, []);
      e.interp.callObjectHandler(w, 'construct', []);
      return w;
    };

    // struct.font.plain / bold equivalents (navigator createImgResources).
    const plain = e.interp.evalExpressionString(
      '[#font: "Volter", #fontSize: 9, #fontStyle: [#plain], #color: rgb(0, 0, 0), #lineHeight: 10]',
    );
    const bold = e.interp.evalExpressionString(
      '[#font: "Volter", #fontSize: 9, #fontStyle: [#bold], #color: rgb(0, 0, 0), #lineHeight: 10]',
    );

    // pWriterPlainBoldLeft: setFont(tBold) then render(2-line header) (pTxtRect VOID).
    const hd = mkWriter();
    e.interp.callObjectHandler(hd, 'setFont', [bold]);
    const hdImg = e.interp.callObjectHandler(hd, 'render', ['Roomname\r(2/25) Owner: Bob']) as {
      width: number; height: number;
    };
    assert.ok(hdImg && hdImg.height > 10, `2-line header renders content-tall (${hdImg?.width}x${hdImg?.height})`);
    draws.length = 0;

    // pWriterPlainNormWrap: setFont(tPlain) + define([#wordWrap:1]) + define([#rect: rect(0,0,260,0)]) + render(desc).
    const tWidth = 260;
    const w = mkWriter();
    e.interp.callObjectHandler(w, 'setFont', [plain]);
    e.interp.callObjectHandler(w, 'define', [e.interp.evalExpressionString('[#wordWrap: 1]')]);
    e.interp.callObjectHandler(w, 'define', [e.interp.evalExpressionString(`[#rect: rect(0, 0, ${tWidth}, 0)]`)]);
    const descImg = e.interp.callObjectHandler(
      w,
      'render',
      ['Welcome to my room! This is a fairly long description that will definitely wrap onto multiple lines here.'],
    ) as { width: number; height: number };
    assert.ok(descImg && descImg.height > 10, `desc image content-tall, got ${descImg?.height}`);
    assert.equal(descImg.width, tWidth, 'desc width stays the defined box width');
    assert.ok(draws.length > 2, `wrapped into ${draws.length} lines`);
  } finally {
    if (document) (globalThis as Record<string, unknown>).document = document;
    else delete (globalThis as Record<string, unknown>).document;
  }
});