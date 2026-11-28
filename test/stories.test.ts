import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addStoryCards, parseDutchDate, renderBody, slugify } from '../src/services/stories.js';
import { loginAdmin, setupApp, teardown, type TestContext } from './helpers.js';

const PHOTO = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 0xff, 0xd9]).toString('base64')}`;

describe('the text of a story', () => {
  it('turns the simple marks into headings, lists, bold and links', () => {
    const html = renderBody(['Eerste alinea,', 'tweede regel.', '', '## Een kop', '### Kleiner', '- een', '- **twee**', '', '1. eerst', '2. dan', '', '> Mooi gezegd', '',
      'Lees [hoe het werkt](/reserveer) of kijk op [Google](https://google.com/?a=1&b=2). Dat is *echt* zo.'].join('\n'));
    expect(html).toContain('<p>Eerste alinea,<br>tweede regel.</p>');
    expect(html).toContain('<h2>Een kop</h2>\n<h3>Kleiner</h3>');
    expect(html).toContain('<ul><li>een</li><li><strong>twee</strong></li></ul>');
    expect(html).toContain('<ol><li>eerst</li><li>dan</li></ol>');
    expect(html).toContain('<blockquote><p>Mooi gezegd</p></blockquote>');
    expect(html).toContain('<a href="/reserveer">hoe het werkt</a>');
    expect(html).toContain('<a href="https://google.com/?a=1&amp;b=2" target="_blank" rel="noopener">Google</a>');
    expect(html).toContain('<em>echt</em>');
  });

  it('shows anything else as it was typed, never as code', () => {
    const html = renderBody('<script>alert(1)</script> & <b>vet</b>\n\n[klik](javascript:alert(1))\n\n[x](/a" onclick="y)\n\n[foto 99]');
    expect(html).not.toMatch(/<script|<b>|href="javascript|onclick="y/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;vet&lt;/b&gt;');
    // A photo that is not there leaves nothing behind.
    expect(html).not.toContain('<img');
    expect(renderBody('[foto 7]', new Map([[7, { id: 7, width: 800, height: 600, alt: 'Game "zone"' }]])))
      .toBe('<img class="article-photo" src="/api/story-image/7" alt="Game &quot;zone&quot;" loading="lazy" width="800" height="600">');
  });

  it('makes an address from a title, and reads the dates on the overview page', () => {
    expect(slugify('Zo vier je een Roblox-feestje thuis! (én óók buiten)')).toBe('zo-vier-je-een-roblox-feestje-thuis-en-ook-buiten');
    expect(slugify('!!!')).toBe('');
    expect(parseDutchDate('<p class="muted small">1 september 2026 · 3 min lezen</p>')).toBe('2026-09-01');
    expect(addStoryCards('<div class="posts">x</div>', [])).toBe('<div class="posts">x</div>');
  });
});

describe('stories from the admin', () => {
  let ctx: TestContext;
  let auth: { authorization: string };
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => ctx.app.inject({ method, url: `/api/admin${url}`, headers: auth, ...(payload ? { payload } : {}) });
  const page = (url: string) => ctx.app.inject({ url });
  const story = { title: 'Zo vier je een Roblox-feestje thuis', intro: 'Alles wat je moet weten over een Roblox-feestje.', body: 'Roblox is **enorm** populair.\n\n## Wat heb je nodig?\n\n- een tafel\n- een stopcontact', publishedOn: '2026-10-05' };
  let id: number;

  beforeAll(async () => {
    ctx = await setupApp({ PUBLIC_URL: 'https://gamerxp.test' });
    auth = { authorization: `Bearer ${await loginAdmin(ctx)}` };
  });
  afterAll(() => teardown(ctx));

  it('keeps a draft off the website', async () => {
    id = (await call('POST', '/stories')).json().id;
    expect((await call('POST', `/stories/${id}/publish`, { published: true })).statusCode).toBe(400);
    expect((await call('PUT', `/stories/${id}`, story)).statusCode).toBe(200);
    expect((await call('GET', '/stories')).json()).toMatchObject([{ id, title: story.title, published: false, slug: null }]);
    expect((await page('/verhalen/zo-vier-je-een-roblox-feestje-thuis')).statusCode).toBe(404);
    expect((await page('/verhalen')).body).not.toContain('Roblox-feestje thuis');
    expect((await ctx.app.inject({ url: '/api/admin/stories' })).statusCode).toBe(401);
  });

  it('shows how it will look without putting it online', async () => {
    const { html } = (await call('POST', `/stories/${id}/preview`, { ...story, title: 'Een andere titel' })).json();
    expect(html).toContain('<h1>Een andere titel</h1>');
    expect(html).toContain('<h2>Wat heb je nodig?</h2>');
    expect(html).toContain('content="noindex"');
    // The call to action that every story has is filled in.
    expect(html).not.toContain('{{');
    expect((await call('GET', `/stories/${id}`)).json().title).toBe(story.title);
  });

  it('publishes it as a page, on the overview and in the sitemap', async () => {
    const res = (await call('POST', `/stories/${id}/publish`, { published: true })).json();
    expect(res).toMatchObject({ slug: 'zo-vier-je-een-roblox-feestje-thuis', url: '/verhalen/zo-vier-je-een-roblox-feestje-thuis' });
    const shown = await page(res.url);
    expect(shown.statusCode).toBe(200);
    expect(shown.body).toContain('<title>Zo vier je een Roblox-feestje thuis | Gamer Xperience</title>');
    expect(shown.body).toContain('<time datetime="2026-10-05">5 oktober 2026</time>');
    expect(shown.body).toContain('<p>Roblox is <strong>enorm</strong> populair.</p>');
    expect(shown.body).toContain('"@type":"BlogPosting"');
    expect(shown.body).toContain('<link rel="canonical" href="https://gamerxp.test/verhalen/zo-vier-je-een-roblox-feestje-thuis">');
    expect((await page('/sitemap.xml')).body).toContain('<loc>https://gamerxp.test/verhalen/zo-vier-je-een-roblox-feestje-thuis</loc>');

    // On the overview it stands between the others by date: after 24 November, before 1 September.
    const overview = (await page('/verhalen')).body;
    const at = (text: string) => overview.indexOf(text);
    expect(at('Zo vier je een Roblox-feestje thuis')).toBeGreaterThan(at('Wat kost een game kinderfeestje thuis?'));
    expect(at('Zo vier je een Roblox-feestje thuis')).toBeLessThan(at('30+ Kids?'));
    expect(overview).toContain('<p>Alles wat je moet weten over een Roblox-feestje.</p>');
    expect(overview.match(/class="post-card"/g)).toHaveLength(8);
    // The pages that were there keep working.
    expect((await page('/verhalen/help-mijn-kind-wil-een-fortnite-feestje')).statusCode).toBe(200);
  });

  it('takes photos: one at the top, more in the text', async () => {
    const photo = { image: PHOTO, width: 1200, height: 800 };
    const cover = (await call('POST', `/stories/${id}/photos`, { ...photo, cover: true })).json();
    const inText = (await call('POST', `/stories/${id}/photos`, { ...photo, alt: 'De opstelling' })).json();
    expect((await call('PUT', `/stories/${id}`, { ...story, body: `${story.body}\n\n[foto ${inText.id}]` })).statusCode).toBe(200);
    const shown = (await page('/verhalen/zo-vier-je-een-roblox-feestje-thuis')).body;
    expect(shown).toContain(`<img class="article-hero" src="/api/story-image/${cover.id}"`);
    expect(shown).toContain(`<img class="article-photo" src="/api/story-image/${inText.id}" alt="De opstelling"`);
    expect(shown).toContain(`<meta property="og:image" content="https://gamerxp.test/api/story-image/${cover.id}">`);
    expect((await page('/verhalen')).body).toContain(`<img src="/api/story-image/${cover.id}"`);
    const file = await page(`/api/story-image/${cover.id}`);
    expect(file.headers['content-type']).toBe('image/jpeg');
    // A new photo at the top takes the place of the old one.
    const second = (await call('POST', `/stories/${id}/photos`, { ...photo, cover: true })).json();
    expect((await page(`/api/story-image/${cover.id}`)).statusCode).toBe(404);
    expect((await call('GET', `/stories/${id}`)).json()).toMatchObject({ coverId: second.id, photos: [{ id: inText.id }, { id: second.id }] });
    expect((await call('DELETE', `/stories/${id}/photos/${second.id}`)).statusCode).toBe(204);
    expect((await page('/verhalen/zo-vier-je-een-roblox-feestje-thuis')).body).not.toContain('article-hero');
  });

  it('shows a change right away, and keeps the address when the title changes', async () => {
    expect((await call('PUT', `/stories/${id}`, { ...story, title: 'Roblox-feestje: zo doe je dat' })).statusCode).toBe(200);
    const shown = (await page('/verhalen/zo-vier-je-een-roblox-feestje-thuis')).body;
    expect(shown).toContain('<h1>Roblox-feestje: zo doe je dat</h1>');
    expect((await call('PUT', `/stories/${id}`, { ...story, intro: '' })).statusCode).toBe(400);
  });

  it('takes it offline again, and gives a second story with the same title its own address', async () => {
    expect((await call('POST', `/stories/${id}/publish`, { published: false })).json()).toMatchObject({ url: null });
    expect((await page('/verhalen/zo-vier-je-een-roblox-feestje-thuis')).statusCode).toBe(404);
    expect((await page('/sitemap.xml')).body).not.toContain('roblox');

    const other = (await call('POST', '/stories')).json().id;
    await call('PUT', `/stories/${other}`, { ...story, title: 'Zo vier je een Roblox-feestje thuis' });
    expect((await call('POST', `/stories/${other}/publish`, { published: true })).json().slug).toBe('zo-vier-je-een-roblox-feestje-thuis-2');
    // The title of a story that came with the site is taken too.
    const clash = (await call('POST', '/stories')).json().id;
    await call('PUT', `/stories/${clash}`, { ...story, title: 'Hoe we een Minecraft-droom redden' });
    expect((await call('POST', `/stories/${clash}/publish`, { published: true })).json().slug).toBe('hoe-we-een-minecraft-droom-redden-2');
    expect((await page('/verhalen/hoe-we-een-minecraft-droom-redden')).body).toContain('Woerden');

    expect((await call('POST', `/stories/${id}/publish`, { published: true })).json().slug).toBe('zo-vier-je-een-roblox-feestje-thuis');
    expect((await call('DELETE', `/stories/${id}`)).statusCode).toBe(204);
    expect((await page('/verhalen/zo-vier-je-een-roblox-feestje-thuis')).statusCode).toBe(404);
    expect((await call('GET', `/stories/${id}`)).statusCode).toBe(404);
  });
});
