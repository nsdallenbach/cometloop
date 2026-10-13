#!/usr/bin/env node
// Cut a desktop release in one command (DAT-237):
//
//   cd desktop && npm run release -- 0.3.1
//
// Bumps "version" in package.json + package-lock.json, commits, tags
// v<version> and pushes both. The Desktop release workflow builds every
// platform on the tag and publishes the installers plus the electron-updater
// feed to GitHub Releases; installed builds pick the new version up on their
// next hourly check (or "check now" in the sidebar) and apply it on quit.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2] ?? '';
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: npm run release -- <major.minor.patch>');
  process.exit(1);
}

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: desktop, encoding: 'utf8' }).trim();

if (git('status', '--porcelain')) {
  console.error('the working tree has uncommitted changes; commit or stash them first');
  process.exit(1);
}
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') {
  console.error(`release from main (this is ${branch}): what the feed serves must be what main shipped`);
  process.exit(1);
}
git('fetch', '-q', 'origin', 'main', '--tags');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) {
  console.error('local main differs from origin/main; pull or push first');
  process.exit(1);
}
let tagExists = true;
try {
  git('rev-parse', '-q', '--verify', `refs/tags/v${version}`);
} catch {
  tagExists = false;
}
if (tagExists) {
  console.error(`tag v${version} already exists; pick the next version`);
  process.exit(1);
}
const current = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8')).version;
const num = (v) => v.split('.').map(Number);
const [a, b, c] = num(version);
const [x, y, z] = num(current);
if (a < x || (a === x && (b < y || (b === y && c <= z)))) {
  console.error(`v${version} is not newer than the current v${current}`);
  process.exit(1);
}

for (const file of ['package.json', 'package-lock.json']) {
  const p = path.join(desktop, file);
  const json = JSON.parse(readFileSync(p, 'utf8'));
  json.version = version;
  if (json.packages?.['']) json.packages[''].version = version;
  writeFileSync(p, `${JSON.stringify(json, null, 2)}\n`);
}

git('add', 'package.json', 'package-lock.json');
git('commit', '-q', '-m', `Desktop v${version}`);
git('tag', '-a', `v${version}`, '-m', `Desktop v${version}`);
git('push', '-q', 'origin', 'HEAD', `v${version}`);
console.log(`v${version} pushed. The Desktop release workflow is building it:
  gh run list --workflow desktop-release.yml --limit 1
  gh run watch --exit-status
Installed builds update on their next check; the sidebar footer shows it arrive.`);
