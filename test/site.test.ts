import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSite } from '../src/site.js';
import { setupApp, teardown, type TestContext } from './helpers.js';

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
