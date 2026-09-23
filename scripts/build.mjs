import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
await build({
  absWorkingDir: new URL('../', import.meta.url).pathname,
  entryPoints: { index: 'src/index.js', auto: 'src/init.js' },
  outdir: 'dist',
  bundle: true,
  splitting: true,
  format: 'esm',
  target: ['es2022'],
  minify: true,
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  legalComments: 'none',
});
