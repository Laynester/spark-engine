// Regenerates syntaxes/lingo.tmLanguage.json from the LSP's keyword data
// (packages/lingo-lsp/dist/keywords.js) so the grammar and the language
// server never drift. Run via `npm run build` in this extension.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEYWORDS, CONSTANTS, THE_PROPS, BUILTIN_DOCS } from '../../../packages/lingo-lsp/dist/keywords.js';
// Full builtin list straight from the runtime's builtin table (144 names vs
// the ~100 curated docs) — the table is Node-safe (no pixi chain).
import { createBuiltinTable } from '../../../packages/runtime/dist/lingo/builtins.js';

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, '..', 'syntaxes', 'lingo.tmLanguage.json');
mkdirSync(dirname(outFile), { recursive: true });

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const kw = KEYWORDS.map((k) => esc(k.name)).join('|');
const consts = CONSTANTS.map((c) => esc(c.name)).join('|');
const builtinNames = new Set([...Object.keys(BUILTIN_DOCS), ...createBuiltinTable().keys()]);
const builtins = [...builtinNames].map(esc).join('|');
const theProps = THE_PROPS.map((p) => esc(p.name)).join('|');

const grammar = {
  $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
  name: 'Lingo',
  scopeName: 'source.lingo',
  patterns: [
    { include: '#comments' },
    { include: '#strings' },
    { include: '#handler-def' },
    { include: '#the-props' },
    { include: '#keywords' },
    { include: '#builtins' },
    { include: '#constants' },
    { include: '#symbols' },
    { include: '#numbers' },
  ],
  repository: {
    comments: {
      patterns: [
        { name: 'comment.block.lingo', begin: '--\\[\\[', end: '\\]\\]' },
        { name: 'comment.line.double-dash.lingo', match: '--.*$' },
      ],
    },
    strings: {
      name: 'string.quoted.double.lingo',
      begin: '"',
      end: '"',
      patterns: [{ name: 'constant.character.escape.lingo', match: '""' }],
    },
    'handler-def': {
      match: `^\\s*(\\bon\\b)(\\s+)([A-Za-z_][A-Za-z0-9_]*)`,
      captures: {
        1: { name: 'keyword.control.lingo' },
        3: { name: 'entity.name.function.lingo' },
      },
    },
    'the-props': {
      match: `(\\bthe\\b)(\\s+)(${theProps})\\b`,
      captures: {
        1: { name: 'keyword.control.lingo' },
        3: { name: 'support.variable.lingo' },
      },
    },
    keywords: { match: `\\b(?:${kw})\\b`, name: 'keyword.control.lingo' },
    // Builtins are called with or without parens in Lingo, so no `(` guard.
    builtins: { match: `\\b(?:${builtins})\\b`, name: 'support.function.lingo' },
    constants: { match: `\\b(?:${consts})\\b`, name: 'support.constant.lingo' },
    symbols: { match: `#[A-Za-z0-9_.-]+`, name: 'constant.other.symbol.lingo' },
    numbers: { match: `\\b(?:\\d+(?:\\.\\d+)?|\\.\\d+)\\b`, name: 'constant.numeric.lingo' },
  },
};

writeFileSync(outFile, JSON.stringify(grammar, null, 2) + '\n');
console.log(`wrote ${outFile} (${KEYWORDS.length} keywords, ${theProps.split('|').length} the-props, ${builtinNames.size} builtins)`);
