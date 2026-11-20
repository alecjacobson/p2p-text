import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

const [template, css, result] = await Promise.all([
  readFile(new URL('./src/index.html', import.meta.url), 'utf8'),
  readFile(new URL('./src/style.css', import.meta.url), 'utf8'),
  build({ entryPoints: ['src/app.js'], bundle: true, write: false, format: 'esm', supported: { 'inline-script': false } })
]);
const html = template.replace('/* APP_STYLES */', () => css)
  .replace('/* APP_SCRIPT */', () => result.outputFiles[0].text);
const dist = new URL('./dist/', import.meta.url);
await mkdir(dist, { recursive: true });
await writeFile(new URL('index.html', dist), html);
