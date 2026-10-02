// Packages the 3 plugin files + metadata/checksum into a bundle directory.
// Run by .github/workflows/faroe-artifact.yml only after check/build/E2E all
// succeeded. No external dependencies.
//
// usage: node tools/faroe/package-bundle.mjs <outDir>
// env:   GITHUB_SHA GITHUB_RUN_ID GITHUB_RUN_ATTEMPT GITHUB_REPOSITORY GITHUB_REF_NAME
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PLUGIN_ID = 'vault-gantt';
const FILES = ['main.js', 'manifest.json', 'styles.css'];

function fail(message) {
  console.error(`package-bundle: ${message}`);
  process.exit(1);
}

function requireEnv(name, pattern) {
  const value = process.env[name];
  if (!value || !pattern.test(value)) fail(`env ${name} is missing or malformed`);
  return value;
}

const outDir = process.argv[2];
if (!outDir) fail('usage: node tools/faroe/package-bundle.mjs <outDir>');

const commit = requireEnv('GITHUB_SHA', /^[0-9a-f]{40}$/);
const runId = requireEnv('GITHUB_RUN_ID', /^\d+$/);
const runAttempt = requireEnv('GITHUB_RUN_ATTEMPT', /^\d+$/);
const repository = requireEnv('GITHUB_REPOSITORY', /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
const ref = requireEnv('GITHUB_REF_NAME', /^\S+$/);

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (head !== commit) fail(`checked-out HEAD ${head} differs from GITHUB_SHA ${commit}`);

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
if (manifest.id !== PLUGIN_ID) fail(`manifest id is "${manifest.id}", expected "${PLUGIN_ID}"`);

mkdirSync(outDir, { recursive: true });
if (readdirSync(outDir).length > 0) fail(`${outDir} is not empty`);

const files = {};
const sums = [];
for (const name of FILES) {
  const size = statSync(name).size;
  if (size === 0) fail(`${name} is empty`);
  copyFileSync(name, join(outDir, name));
  const sha256 = createHash('sha256').update(readFileSync(join(outDir, name))).digest('hex');
  files[name] = { sha256, size };
  sums.push(`${sha256}  ${name}`);
}

const metadata = {
  schema: 1,
  commit,
  runId,
  runAttempt,
  repository,
  ref,
  manifestId: manifest.id,
  manifestVersion: manifest.version,
  files,
};
writeFileSync(join(outDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
writeFileSync(join(outDir, 'SHA256SUMS'), `${sums.join('\n')}\n`);
console.log(`bundle written to ${outDir}: ${[...FILES, 'metadata.json', 'SHA256SUMS'].join(', ')}`);
