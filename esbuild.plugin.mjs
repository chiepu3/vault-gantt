import * as esbuild from 'esbuild';
import sveltePlugin from 'esbuild-svelte';
import { rename } from 'node:fs/promises';

const production = process.argv.includes('production');

async function renameCssOutput() {
  try {
    await rename('main.css', 'styles.css');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
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
      name: 'rename-css-to-styles',
      setup(build) {
        build.onEnd(renameCssOutput);
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
