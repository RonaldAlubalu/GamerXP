import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

// Server-rendered website pages.
//
// Every file in site/pages becomes a page: site/pages/index.html is "/",
// site/pages/verhalen/foo.html is "/verhalen/foo". A page starts with a JSON
// comment holding its metadata, e.g. <!--{"title": "...", "description": "..."}-->,
// followed by its HTML. Pages are wrapped in site/layout.html and can include
// shared blocks from site/partials with {{> name}}.

export const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../site');

export interface PageMeta {
  title: string;
  description: string;
  // Extra scripts, e.g. ["/assets/booking.js"].
  scripts?: string[];
  // Social media preview image, relative to /assets/img.
  image?: string;
  noindex?: boolean;
  lang?: string;
}

export interface Site {
  pages: Map<string, string>;
  sitemap: string[];
  notFound: string;
  redirects: Record<string, string>;
}

const META_RE = /^\s*<!--\s*(\{[\s\S]*?\})\s*-->/;

const escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function listHtml(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) files.push(...(await listHtml(path.join(dir, e.name), `${prefix}${e.name}/`)));
    else if (e.name.endsWith('.html')) files.push(`${prefix}${e.name}`);
  }
  return files.sort();
}

function routeFor(file: string): string {
  const route = `/${file.replace(/\.html$/, '')}`;
  return route === '/index' ? '/' : route;
}

function includePartials(html: string, partials: Map<string, string>, depth = 0): string {
  return html.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, name: string) => {
    const partial = partials.get(name);
    if (partial === undefined) throw new Error(`Unknown partial "${name}"`);
    return depth < 5 ? includePartials(partial, partials, depth + 1) : partial;
  });
}

export async function loadSite(publicUrl: string, dir: string = SITE_DIR): Promise<Site> {
  const layout = await readFile(path.join(dir, 'layout.html'), 'utf8');
  const partials = new Map<string, string>();
  for (const file of await listHtml(path.join(dir, 'partials'))) {
    partials.set(file.replace(/\.html$/, ''), await readFile(path.join(dir, 'partials', file), 'utf8'));
  }

  const render = (meta: PageMeta, body: string, route: string) => {
    const vars: Record<string, string> = {
      title: escapeAttr(meta.title),
      description: escapeAttr(meta.description),
      canonical: `${publicUrl}${route}`,
      image: `${publicUrl}/assets/img/${meta.image ?? 'nummer-1-game-feestje.webp'}`,
      robots: meta.noindex ? 'noindex' : 'index, follow',
      lang: meta.lang ?? 'nl',
      scripts: (meta.scripts ?? []).map((s) => `<script type="module" src="${escapeAttr(s)}"></script>`).join('\n  '),
      year: String(new Date().getFullYear()),
    };
    const html = includePartials(layout.replace('{{content}}', () => body), partials);
    return html.replace(/\{\{(\w+)\}\}/g, (m, key: string) => vars[key] ?? m);
  };

  const pages = new Map<string, string>();
  const sitemap: string[] = [];
  let notFound = '';
  for (const file of await listHtml(path.join(dir, 'pages'))) {
    const source = await readFile(path.join(dir, 'pages', file), 'utf8');
    const match = META_RE.exec(source);
    if (!match) throw new Error(`site/pages/${file} must start with a <!--{...}--> metadata comment`);
    const meta = JSON.parse(match[1]!) as PageMeta;
    const route = routeFor(file);
    const html = render(meta, source.slice(match[0].length), route);
    if (route === '/404') {
      notFound = html;
      continue;
    }
    pages.set(route, html);
    if (!meta.noindex) sitemap.push(route);
  }

  const redirects = JSON.parse(await readFile(path.join(dir, 'redirects.json'), 'utf8')) as Record<string, string>;
  return { pages, sitemap, notFound, redirects };
}

export async function registerSite(app: FastifyInstance): Promise<void> {
  const { PUBLIC_URL, NODE_ENV } = app.config;
  let site = await loadSite(PUBLIC_URL);
  // In development pages are re-read on every request, so edits show up without a restart.
  const current = async () => (NODE_ENV === 'development' ? (site = await loadSite(PUBLIC_URL)) : site);

  for (const route of site.pages.keys()) {
    app.get(route, async (req, reply) => {
      const html = (await current()).pages.get(route);
      if (!html) return reply.callNotFound();
      return reply.type('text/html; charset=utf-8').send(html);
    });
  }

  for (const [from, to] of Object.entries(site.redirects)) {
    app.get(from, async (_req, reply) => reply.redirect(to, 301));
  }

  app.get('/sitemap.xml', async (_req, reply) => {
    const urls = (await current()).sitemap.map((r) => `  <url><loc>${PUBLIC_URL}${r === '/' ? '' : r}</loc></url>`);
    return reply
      .type('application/xml')
      .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
  });

  app.get('/robots.txt', async (_req, reply) =>
    reply.type('text/plain').send(`User-agent: *\nDisallow: /admin/\nDisallow: /api/\nDisallow: /status\n\nSitemap: ${PUBLIC_URL}/sitemap.xml\n`),
  );

  app.decorate('notFoundPage', async () => (await current()).notFound);
}

declare module 'fastify' {
  interface FastifyInstance {
    notFoundPage: () => Promise<string>;
  }
}
