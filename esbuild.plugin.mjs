import * as esbuild from 'esbuild';
import sveltePlugin from 'esbuild-svelte';
import { rename, copyFile, mkdir } from 'node:fs/promises';

const production = process.argv.includes('production');

const DEPLOY_TARGETS = [
  '/mnt/d/vault-gantt-plugin',
  '/mnt/c/Users/ryory/Obsidian/Obsidian Vault/.obsidian/plugins/vault-gantt',
];
const DEPLOY_FILES = ['main.js', 'styles.css', 'manifest.json'];

async function renameCssOutput() {
  try {
    await rename('main.css', 'styles.css');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function deployToDrives() {
  for (const dest of DEPLOY_TARGETS) {
    try {
      await mkdir(dest, { recursive: true });
      await Promise.all(DEPLOY_FILES.map((f) => copyFile(f, `${dest}/${f}`)));
      console.log(`Deployed → ${dest}`);
    } catch (err) {
      console.warn(`Deploy skipped (${dest}): ${err.message}`);
    }
  }
}

const options = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  target: 'es2020',
  format: 'cjs',
  outfile: 'main.js',
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
  ],
  plugins: [
    sveltePlugin(),
    {
      name: 'rename-and-deploy',
      setup(build) {
        build.onEnd(async () => {
          await renameCssOutput();
          await deployToDrives();
        });
      },
    },
  ],
  minify: production,
  sourcemap: production ? false : 'inline',
};

if (production) {
  await esbuild.build(options);
  console.log('Build complete (production)');
} else {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('Watching for changes...');
}
