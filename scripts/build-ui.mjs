import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const uiDir = join(root, 'src', 'ui');
const distDir = join(root, 'dist');

mkdirSync(distDir, { recursive: true });

const jsResult = await esbuild.build({
  entryPoints: [join(uiDir, 'app.js')],
  bundle: true,
  write: false,
  format: 'iife',
  target: ['es2022'],
  minify: true,
});

const bundledJs = jsResult.outputFiles[0].text;
const css = readFileSync(join(uiDir, 'styles.css'), 'utf8');
const template = readFileSync(join(uiDir, 'app.html'), 'utf8');

const html = template
  .replace('/* __INLINE_CSS__ */', () => css)
  .replace('/* __INLINE_JS__ */', () => bundledJs);

writeFileSync(join(distDir, 'app.html'), html);
console.log(`Built dist/app.html (${html.length} bytes)`);
