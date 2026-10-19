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
      '/verhalen', '/algemene-voorwaarden',
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
});
