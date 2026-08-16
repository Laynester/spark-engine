#!/usr/bin/env node
// Bump the workspace package versions to <x.y.z> (arg 1) and sync the
// lockfile. Idempotent: when the version is unchanged, nothing is written and
// the lockfile is left alone, so the release job's "no changes" check works.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ver = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(ver)) {
  console.error(`bump-versions: usage <x.y.z>, got "${ver}"`);
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const files = [
  'packages/runtime/package.json',
  'packages/bundler/package.json',
  'packages/lingo-lsp/package.json',
  'apps/lingo-vscode/package.json',
];

let changed = false;
for (const rel of files) {
  const p = join(root, rel);
  const pkg = JSON.parse(readFileSync(p, 'utf8'));
  if (pkg.version !== ver) {
    pkg.version = ver;
    writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
    changed = true;
    console.log(`bumped ${rel} -> ${ver}`);
  }
}

// Keep the lockfile's workspace entries in sync. Only touches the lockfile
// when a version actually changed (npm leaves it untouched otherwise).
if (changed) {
  execSync('npm install --package-lock-only --ignore-scripts --no-audit --no-fund', {
    cwd: root,
    stdio: 'inherit',
  });
}
