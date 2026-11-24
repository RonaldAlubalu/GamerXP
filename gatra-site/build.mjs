// Puts the pages in src/pages into the layout and writes them to public/.
// Run: node build.mjs            (add "serve" to also look at the result on http://localhost:8090)
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');
const layout = read('src/layout.html');

for (const file of readdirSync(join(root, 'src/pages'))) {
  const slug = file.replace(/\.html$/, '');
  const source = read(`src/pages/${file}`);
  const meta = JSON.parse(source.match(/^<!--\s*(\{.*\})\s*-->/)[1]);
  const content = source.replace(/^<!--.*-->\n/, '').replace(/\{\{> (\w+)\}\}/g, (_, name) => read(`src/${name}.html`).trim());
  const html = layout
    .replace('{{title}}', meta.title)
    .replace('{{description}}', meta.description)
    .replace('{{slug}}', slug === 'index' ? 'home' : slug)
    .replace(/\{\{nav:([\w-]+)\}\}/g, (_, name) => (name === slug ? ' aria-current="page"' : ''))
    .replace('{{content}}', content.trim());
  const out = slug === 'index' ? 'public/index.html' : `public/${slug}/index.html`;
  mkdirSync(dirname(join(root, out)), { recursive: true });
  writeFileSync(join(root, out), html);
  console.log('written', out);
}

if (process.argv[2] === 'serve') {
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2', '.pdf': 'application/pdf' };
  createServer((req, res) => {
    let path = join(root, 'public', decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
    if (!existsSync(path)) { res.writeHead(404); res.end('Niet gevonden'); return; }
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
    res.end(readFileSync(path));
  }).listen(8090, () => console.log('http://localhost:8090'));
}
