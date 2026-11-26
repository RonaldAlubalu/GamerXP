import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSite } from '../src/site.js';
import { loginAdmin, setupApp, teardown, type TestContext } from './helpers.js';

const PUBLIC_DIR = path.resolve(import.meta.dirname, '../public');

describe('website pages', async () => {
  const site = await loadSite('https://gamerxp.nl');

  it('keeps every URL of the old Squarespace site', () => {
    for (const route of [
      '/', '/pakketten-prijzen', '/reserveer', '/about', '/contact', '/ervaringen', '/gaming-evenement-op-locatie',
      '/game-kinderfeestje-in-eindhoven', '/game-kinderfeestje-in-utrecht', '/gaming-birthday-party-netherlands',
      '/verhalen', '/algemene-voorwaarden', '/lan-party-toernooien',
      '/verhalen/30-kids-op-een-evenement-zo-vermaken-wij-grote-groepen-zonder-chaos-',
      '/verhalen/game-kinderfeestje-thuis-vs-trampolinepark-vs-gamestate-wat-past-bij-jouw-kind',
      '/verhalen/gamefeestje-voor-alle-leeftijden-hoe-cht-iedereen-mee-kan-doen',
      '/verhalen/help-mijn-kind-wil-een-fortnite-feestje',
      '/verhalen/hoe-we-een-minecraft-droom-redden',
      '/verhalen/zelf-een-lan-party-organiseren',
    ]) {
      expect(site.pages.has(route), route).toBe(true);
    }
    expect(site.redirects['/home']).toBe('/');
  });

  it.each([...site.pages.entries(), ['/404', site.notFound] as [string, string]])(
    '%s renders completely with existing local assets',
    (route, html) => {
      expect(html).not.toMatch(/\{\{/);
      expect(html).toMatch(/<title>[^<]{10,}<\/title>/);
      expect(html).toContain(`<link rel="canonical" href="https://gamerxp.nl${route === '/404' ? '/404' : route}">`);
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"#?]+)"/g)].map((m) => m[1]!);
      for (const asset of assets) expect(existsSync(path.join(PUBLIC_DIR, asset)), `${route}: ${asset}`).toBe(true);
      // No leftover references to the old Squarespace CDN.
      expect(html).not.toContain('squarespace');
    },
  );

  it('internal links point to existing pages', () => {
    const known = new Set([...site.pages.keys(), ...Object.keys(site.redirects), '/admin/']);
    for (const [route, html] of site.pages) {
      for (const [, href] of html.matchAll(/href="(\/[^"#?]*)/g)) {
        if (href!.startsWith('/assets/')) continue;
        expect(known.has(href!), `${route} links to ${href}`).toBe(true);
      }
    }
  });
});

describe('website routes', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await setupApp();
  });
  afterAll(() => teardown(ctx));

  it('serves pages, redirects, sitemap and a 404 page', async () => {
    const home = await ctx.app.inject('/');
    expect(home.statusCode).toBe(200);
    expect(home.headers['content-type']).toContain('text/html');
    expect(home.body).toContain('Het ultieme');

    const redirect = await ctx.app.inject('/home');
    expect([redirect.statusCode, redirect.headers.location]).toEqual([301, '/']);

    const sitemap = await ctx.app.inject('/sitemap.xml');
    expect(sitemap.body).toContain('/verhalen/help-mijn-kind-wil-een-fortnite-feestje</loc>');
    expect(sitemap.body).not.toContain('/status');

    const missing = await ctx.app.inject('/bestaat-niet');
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain('Game over');

    expect((await ctx.app.inject('/admin/')).statusCode).toBe(200);
  });

  it('labels pages for search engines', async () => {
    const data = async (url: string) => {
      const html = (await ctx.app.inject(url)).body;
      const json = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1];
      return json ? (JSON.parse(json)['@graph'] as { '@type': string; [key: string]: unknown }[]) : [];
    };
    const home = await data('/');
    expect(home.find((x) => x['@type'] === 'LocalBusiness')).toMatchObject({ name: 'Gamer Xperience', telephone: '+31634206753' });
    const faq = home.find((x) => x['@type'] === 'FAQPage') as unknown as { mainEntity: { name: string; acceptedAnswer: { text: string } }[] };
    expect(faq.mainEntity.length).toBeGreaterThan(5);
    expect(faq.mainEntity[0]).toMatchObject({ name: 'Heb ik veel ruimte nodig in huis?' });
    expect(faq.mainEntity[0]!.acceptedAnswer.text).not.toContain('<');

    const story = await data('/verhalen/help-mijn-kind-wil-een-fortnite-feestje');
    expect(story.find((x) => x['@type'] === 'BlogPosting')).toMatchObject({ headline: 'Help, mijn kind wil een Fortnite-feestje!', datePublished: '2026-02-12' });
    // Pages kept out of search engines get no labels.
    expect(await data('/status')).toEqual([]);
  });

  it('lets browsers pick up new styles and scripts right away', async () => {
    expect((await ctx.app.inject('/assets/styles.css')).headers['cache-control']).toBe('no-cache');
    expect((await ctx.app.inject('/assets/site.js')).headers['cache-control']).toBe('no-cache');
    expect((await ctx.app.inject('/admin/')).headers['cache-control']).toBe('no-cache');
  });
});

describe('a test address stays out of search engines', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await setupApp({ SITE_NOINDEX: true });
  });
  afterAll(() => teardown(ctx));

  it('marks pages and files as not to be listed', async () => {
    const page = await ctx.app.inject({ method: 'GET', url: '/' });
    expect(page.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(page.body).toContain('<meta name="robots" content="noindex">');
    const file = await ctx.app.inject({ method: 'GET', url: '/assets/styles.css' });
    expect(file.headers['x-robots-tag']).toBe('noindex, nofollow');
  });
});

describe('stylesheets', () => {
  // One stray "}" silently switches off the rule that follows it.
  it('have balanced braces', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const file of ['assets/styles.css', 'admin/admin.css']) {
      const css = (await readFile(path.join(PUBLIC_DIR, file), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
      let depth = 0;
      for (const ch of css) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
        expect(depth, `${file}: a "}" without a "{"`).toBeGreaterThanOrEqual(0);
      }
      expect(depth, `${file}: a "{" is never closed`).toBe(0);
    }
  });
});

describe('website from the admin', () => {
  let ctx: TestContext;
  let token: string;
  const admin = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    ctx.app.inject({ method, url: `/api/admin${url}`, headers: { authorization: `Bearer ${token}` }, payload });
  const home = async () => (await ctx.app.inject({ url: '/' })).body;

  beforeAll(async () => {
    ctx = await setupApp();
    token = await loginAdmin(ctx);
  });
  afterAll(async () => teardown(ctx));

  it('changes a text on a page, keeps it safe, and puts the original back', async () => {
    const files = (await admin('GET', '/site/files')).json();
    expect(files.find((f: { file: string }) => f.file === 'pages/index.html')).toMatchObject({ label: 'Home', route: '/', changed: 0 });
    const page = (await admin('GET', '/site/file?file=pages/index.html')).json();
    const heading = page.blocks.find((b: { tag: string }) => b.tag === 'h1');
    expect(await home()).toContain(heading.original);

    const saved = await admin('PUT', '/site/text', { file: 'pages/index.html', original: heading.original, replacement: 'Nieuwe <strong onclick="x()">kop</strong><script>alert(1)</script> <div>hier</div> 1 < 2' });
    expect(saved.json().current).toBe('Nieuwe <strong>kop</strong>alert(1) hier 1 &lt; 2');
    expect(await home()).toContain('Nieuwe <strong>kop</strong>');
    expect(await home()).not.toContain(heading.original);
    expect((await admin('GET', '/site/file?file=pages/index.html')).json().blocks.find((b: { tag: string }) => b.tag === 'h1')).toMatchObject({ changed: true, original: heading.original });

    await admin('PUT', '/site/text', { file: 'pages/index.html', original: '@title', replacement: 'Een andere titel' });
    expect(await home()).toContain('<title>Een andere titel</title>');

    expect((await admin('PUT', '/site/text', { file: 'pages/index.html', original: 'Dit staat er niet', replacement: 'x' })).statusCode).toBe(409);
    expect((await admin('PUT', '/site/text', { file: 'pages/index.html', original: heading.original, replacement: ' <br> ' })).statusCode).toBe(400);
    expect((await admin('GET', '/site/file?file=../package.json')).statusCode).toBe(404);

    await admin('PUT', '/site/text', { file: 'pages/index.html', original: heading.original, replacement: null });
    await admin('PUT', '/site/text', { file: 'pages/index.html', original: '@title', replacement: null });
    expect(await home()).toContain(heading.original);
  });

  it('manages the photo strip: add, describe, reorder, hide and remove', async () => {
    const start = (await admin('GET', '/site/photos')).json();
    expect(start).toHaveLength(21);
    const image = `data:image/png;base64,${Buffer.from('not really a picture').toString('base64')}`;
    const made = await admin('POST', '/site/photos', { image, alt: 'Nieuw "feest"', width: 1200, height: 900 });
    expect(made.statusCode).toBe(201);
    const { id } = made.json();
    expect(await home()).toContain(`<img src="/api/site-photo/${id}" alt="Nieuw &quot;feest&quot;" loading="lazy" width="1200" height="900">`);
    const served = await ctx.app.inject({ url: `/api/site-photo/${id}` });
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.body).toBe('not really a picture');

    // To the front, and the first built-in photo hidden.
    await admin('PUT', '/site/photos/order', { ids: [id, ...start.map((p: { id: number }) => p.id)] });
    await admin('PATCH', `/site/photos/${start[0].id}`, { hidden: true });
    const html = await home();
    expect(html).not.toContain(start[0].url);
    expect(html.indexOf(`/api/site-photo/${id}`)).toBeLessThan(html.indexOf(start[1].url));

    expect((await admin('DELETE', `/site/photos/${start[1].id}`)).statusCode).toBe(409);
    expect((await admin('DELETE', `/site/photos/${id}`)).statusCode).toBe(204);
    expect((await ctx.app.inject({ url: `/api/site-photo/${id}` })).statusCode).toBe(404);
  });
});
