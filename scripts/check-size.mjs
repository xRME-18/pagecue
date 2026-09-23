import { readFile, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const max = 35 * 1024;
const chunks = await readdir(new URL('../dist/chunks/', import.meta.url));
for (const entry of ['index.js', 'auto.js']) {
  let total = gzipSync(await readFile(new URL(`../dist/${entry}`, import.meta.url))).length;
  for (const chunk of chunks) total += gzipSync(await readFile(new URL(`../dist/chunks/${chunk}`, import.meta.url))).length;
  console.log(`${entry} + ${chunks.length} shared chunk(s): ${total} gzip bytes (max ${max})`);
  if (total > max) process.exitCode = 1;
}
