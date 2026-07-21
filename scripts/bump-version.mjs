#!/usr/bin/env node
/**
 * Version bump script for Vault Gantt.
 * Updates package.json, manifest.json, and versions.json atomically.
 *
 * Usage:
 *   npm run version 0.2.0
 *   node scripts/bump-version.mjs 0.2.0
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const newVersion = process.argv[2];
if (!newVersion) {
  console.error('Usage: node scripts/bump-version.mjs <version>');
  console.error('Example: node scripts/bump-version.mjs 0.2.0');
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
  console.error(`Invalid version format: "${newVersion}" — expected X.Y.Z`);
  process.exit(1);
}

function readJson(file) {
  return JSON.parse(readFileSync(resolve(root, file), 'utf8'));
}

function writeJson(file, data) {
  writeFileSync(resolve(root, file), JSON.stringify(data, null, '\t') + '\n');
}

const pkg = readJson('package.json');
const manifest = readJson('manifest.json');
const versions = readJson('versions.json');

const oldVersion = pkg.version;

pkg.version = newVersion;
manifest.version = newVersion;
versions[newVersion] = manifest.minAppVersion;

writeJson('package.json', pkg);
writeJson('manifest.json', manifest);
writeJson('versions.json', versions);

console.log(`Bumped ${oldVersion} → ${newVersion}`);
console.log('Updated: package.json, manifest.json, versions.json');
console.log('');
console.log('Next steps:');
console.log(`  git add package.json manifest.json versions.json`);
console.log(`  git commit -m "chore: bump version to ${newVersion}"`);
console.log(`  git tag v${newVersion}`);
console.log(`  git push && git push --tags`);
