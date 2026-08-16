#!/usr/bin/env node
// Compute the next release version from git tags: patch bump over the newest
// vX.Y.Z tag (v0.1.0 when no tags exist yet). Prints the full tag, e.g. v0.1.1.
//
// Simple model: every master push that passes CI becomes a release with the
// next patch version. If you want semantic versions later (feat -> minor,
// BREAKING -> major), parse `git log <last-tag>..HEAD --format=%s` here and
// bump accordingly.
import { execSync } from 'node:child_process';

const tag = (() => {
  try {
    return execSync('git describe --tags --abbrev=0 --match "v*"', { encoding: 'utf8' }).trim();
  } catch {
    return null; // no tags yet
  }
})();

let major = 0;
let minor = 1;
let patch = 0;
if (tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!m) {
    console.error(`next-version: unexpected tag format "${tag}" (want vX.Y.Z)`);
    process.exit(1);
  }
  major = Number(m[1]);
  minor = Number(m[2]);
  patch = Number(m[3]) + 1;
}
console.log(`v${major}.${minor}.${patch}`);
