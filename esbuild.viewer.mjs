import * as esbuild from 'esbuild';

const production = process.argv.includes('production');

const options = {
  entryPoints: ['viewer/index.ts'],
  bundle: true,
  target: 'es2020',
  format: 'iife',
  outfile: 'viewer/dist/viewer.js',
  minify: production,
  sourcemap: production ? false : 'inline',
};

if (production) {
  await esbuild.build(options);
  console.log('Viewer build complete (production)');
} else {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('Watching viewer for changes...');
}
