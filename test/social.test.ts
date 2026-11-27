import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSocialClient, publishDue, SocialError, type PostContent, type SocialClient, type SocialPage } from '../src/services/social.js';
import { loginAdmin, setupApp, teardown, type TestContext } from './helpers.js';

// A small JPEG is enough: the site only passes it on.
const PHOTO = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 0xff, 0xd9]).toString('base64')}`;
const META = { META_APP_ID: '1234567890', META_APP_SECRET: 'app-secret-for-tests', PUBLIC_URL: 'https://gamerxp.test' };

function fakeSocial() {
  const state = {
    pages: [{ id: '111', name: 'Gamer Xperience', token: 'PAGE-TOKEN-111', instagram: { id: '999', username: 'gamerxp' } }] as SocialPage[],
    facebook: [] as PostContent[],
    instagram: [] as PostContent[],
    instagramFails: '' as string,
  };
  const client: SocialClient = {
    loginUrl: (s, redirect) => `https://facebook.test/dialog?state=${s}&redirect_uri=${encodeURIComponent(redirect)}`,
    pagesFromCode: async (code) => {
      if (code !== 'good-code') throw new SocialError('Deze code klopt niet.');
      return state.pages;
    },
    postToFacebook: async (page, post) => {
      expect(page).toEqual({ id: '111', token: 'PAGE-TOKEN-111' });
      state.facebook.push(post);
      return { id: `111_${state.facebook.length}`, url: `https://www.facebook.com/111_${state.facebook.length}` };
    },
    postToInstagram: async (account, post) => {
      expect(account).toEqual({ id: '999', token: 'PAGE-TOKEN-111' });
      if (state.instagramFails) throw new SocialError(state.instagramFails);
      state.instagram.push(post);
      return { id: `ig${state.instagram.length}`, url: `https://www.instagram.com/p/ig${state.instagram.length}/` };
    },
  };
  return { client, state };
}

describe('social media: not set up', () => {
  let ctx: TestContext;
  let auth: { authorization: string };
  beforeAll(async () => {
    ctx = await setupApp();
    auth = { authorization: `Bearer ${await loginAdmin(ctx)}` };
  });
  afterAll(() => teardown(ctx));

  it('says so, and places nothing', async () => {
    const page = (await ctx.app.inject({ url: '/api/admin/social', headers: auth })).json();
    expect(page.configured).toBe(false);
    expect(page.redirectUri).toBe('http://localhost:3000/admin/');
    expect((await ctx.app.inject({ method: 'POST', url: '/api/admin/social/connect', headers: auth })).statusCode).toBe(409);
    const made = await ctx.app.inject({ method: 'POST', url: '/api/admin/social/posts', headers: auth, payload: { text: 'Hallo', facebook: true } });
    expect(made.statusCode).toBe(409);
    expect((await ctx.app.inject({ url: '/api/admin/social' })).statusCode).toBe(401);
  });
});

describe('social media', () => {
  let ctx: TestContext;
  let auth: { authorization: string };
  const fake = fakeSocial();
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) => ctx.app.inject({ method, url: `/api/admin${url}`, headers: auth, ...(payload ? { payload } : {}) });
  const connect = async () => {
    const { url } = (await call('POST', '/social/connect')).json();
    return call('POST', '/social/callback', { code: 'good-code', state: new URL(url).searchParams.get('state')! });
  };

  beforeAll(async () => {
    ctx = await setupApp(META, null, fake.client);
    auth = { authorization: `Bearer ${await loginAdmin(ctx)}` };
  });
  afterAll(() => teardown(ctx));

  it('connects the page after the owner said yes at Facebook', async () => {
    const { url } = (await call('POST', '/social/connect')).json();
    expect(url).toContain(encodeURIComponent('https://gamerxp.test/admin/'));
    const state = new URL(url).searchParams.get('state')!;
    // Someone else's link, or a second use of the same one, does nothing.
    expect((await call('POST', '/social/callback', { code: 'good-code', state: 'made-up' })).statusCode).toBe(400);
    expect((await call('POST', '/social/callback', { code: 'good-code', state })).statusCode).toBe(400);

    expect((await connect()).json()).toEqual({ result: 'connected' });
    const page = (await call('GET', '/social')).json();
    expect(page.connection).toMatchObject({ page: 'Gamer Xperience', instagram: 'gamerxp' });
    // The page key stays on the server, and is not readable in the database.
    expect(JSON.stringify(page)).not.toContain('PAGE-TOKEN');
    const stored = await ctx.db.query<{ value: string }>("SELECT value FROM app_settings WHERE key = 'social_connection'");
    expect(stored.rows[0]!.value).not.toContain('PAGE-TOKEN');
  });

  it('lets the owner choose when there is more than one page', async () => {
    fake.state.pages.push({ id: '222', name: 'Andere pagina', token: 'PAGE-TOKEN-222', instagram: null });
    await call('DELETE', '/social/connection');
    expect((await connect()).json()).toEqual({ result: 'choose' });
    const page = (await call('GET', '/social')).json();
    expect(page.connection).toBeNull();
    expect(page.choose).toEqual([{ id: '111', name: 'Gamer Xperience', instagram: 'gamerxp' }, { id: '222', name: 'Andere pagina', instagram: '' }]);
    expect((await call('POST', '/social/page', { id: '333' })).statusCode).toBe(404);
    expect((await call('POST', '/social/page', { id: '111' })).statusCode).toBe(200);
    expect((await call('GET', '/social')).json().connection.page).toBe('Gamer Xperience');
    fake.state.pages.pop();
  });

  it('places a post with a photo on both, and hands out the photo at a public address', async () => {
    const made = await call('POST', '/social/posts', { text: 'De website is vernieuwd!', image: PHOTO, facebook: true, instagram: true });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ ok: true, scheduled: false });
    expect(fake.state.facebook).toHaveLength(1);
    expect(fake.state.instagram).toHaveLength(1);
    const { imageUrl } = fake.state.instagram[0]!;
    expect(imageUrl).toMatch(/^https:\/\/gamerxp\.test\/api\/social-image\/[\w-]+\.jpg$/);
    const photo = await ctx.app.inject({ url: new URL(imageUrl!).pathname });
    expect(photo.statusCode).toBe(200);
    expect(photo.headers['content-type']).toBe('image/jpeg');
    expect((await ctx.app.inject({ url: '/api/social-image/aaaaaaaaaaaaaaaaaaaaaaaa.jpg' })).statusCode).toBe(404);

    const [post] = (await call('GET', '/social')).json().posts;
    expect(post).toMatchObject({
      status: 'done', text: 'De website is vernieuwd!',
      facebook: { placed: true, url: 'https://www.facebook.com/111_1', error: '' },
      instagram: { placed: true, url: 'https://www.instagram.com/p/ig1/', error: '' },
    });
  });

  it('refuses a post that cannot be placed', async () => {
    const bad = async (payload: object) => (await call('POST', '/social/posts', payload)).statusCode;
    expect(await bad({ text: 'Zonder kanaal' })).toBe(400);
    expect(await bad({ facebook: true })).toBe(400);
    expect(await bad({ text: 'Instagram zonder foto', instagram: true })).toBe(400);
    expect(await bad({ text: 'x'.repeat(2201), facebook: true })).toBe(400);
    expect(await bad({ text: 'Geen jpeg', image: 'data:image/png;base64,AAAA', facebook: true })).toBe(400);
    expect(await bad({ text: 'Gisteren', facebook: true, scheduledAt: new Date(Date.now() - 86_400_000).toISOString() })).toBe(400);
    expect(fake.state.facebook).toHaveLength(1);
  });

  it('keeps what went wrong, and tries again only where it failed', async () => {
    fake.state.instagramFails = 'Instagram kon de foto niet verwerken.';
    const made = (await call('POST', '/social/posts', { text: 'Tweede post', image: PHOTO, facebook: true, instagram: true })).json();
    expect(made.ok).toBe(false);
    let post = (await call('GET', '/social')).json().posts.find((p: { id: number }) => p.id === made.id);
    expect(post).toMatchObject({ status: 'failed', facebook: { placed: true }, instagram: { placed: false, error: 'Instagram kon de foto niet verwerken.' } });
    expect(fake.state.facebook).toHaveLength(2);

    fake.state.instagramFails = '';
    expect((await call('POST', `/social/posts/${made.id}/retry`)).json()).toEqual({ ok: true });
    post = (await call('GET', '/social')).json().posts.find((p: { id: number }) => p.id === made.id);
    expect(post).toMatchObject({ status: 'done', instagram: { placed: true, error: '' } });
    // Facebook already had it: not twice.
    expect(fake.state.facebook).toHaveLength(2);
    expect((await call('POST', `/social/posts/${made.id}/retry`)).statusCode).toBe(409);
  });

  it('places a planned post when its time has come, and mails when that fails', async () => {
    const at = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const made = (await call('POST', '/social/posts', { text: 'Voor later', facebook: true, scheduledAt: at })).json();
    expect(made).toMatchObject({ scheduled: true, ok: true });
    expect(await publishDue(ctx.app)).toBe(0);
    expect(fake.state.facebook).toHaveLength(2);
    expect((await call('GET', '/social')).json().posts[0]).toMatchObject({ id: made.id, status: 'scheduled', facebook: { placed: false, error: '' } });

    await ctx.db.query("UPDATE social_posts SET scheduled_at = now() - interval '1 minute' WHERE id = $1", [made.id]);
    expect(await publishDue(ctx.app)).toBe(1);
    expect(fake.state.facebook.at(-1)).toEqual({ text: 'Voor later', imageUrl: null });
    expect(await publishDue(ctx.app)).toBe(0);

    // Planned, but by then the connection is gone.
    const second = (await call('POST', '/social/posts', { text: 'Gaat mis', facebook: true, scheduledAt: at })).json();
    await call('DELETE', '/social/connection');
    await ctx.db.query("UPDATE social_posts SET scheduled_at = now() - interval '1 minute' WHERE id = $1", [second.id]);
    ctx.sent.length = 0;
    await publishDue(ctx.app);
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]).toMatchObject({ to: 'owner@gamerxp.nl', subject: 'Een ingeplande post is niet geplaatst' });
    expect(ctx.sent[0]!.text).toContain('Facebook: Niet verbonden met Facebook');

    // A planned post can be called off; one from the list goes without touching what is online.
    expect((await call('DELETE', `/social/posts/${second.id}`)).statusCode).toBe(204);
    expect((await call('GET', '/social')).json().posts.some((p: { id: number }) => p.id === second.id)).toBe(false);
  });
});

// The real client, against a stand-in for Meta's Graph API.
describe('social media: talking to Meta', () => {
  let server: Server;
  let client: SocialClient;
  const seen: { method: string; path: string; params: Record<string, string> }[] = [];
  let polls = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const url = new URL(req.url!, 'http://meta.test');
        const params = Object.fromEntries(req.method === 'POST' ? new URLSearchParams(raw) : url.searchParams);
        seen.push({ method: req.method!, path: url.pathname, params });
        const answer = (body: object, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
        if (params.access_token === 'DEAD') return answer({ error: { message: 'Session has expired', code: 190 } }, 400);
        if (url.pathname === '/oauth/access_token') return answer({ access_token: params.code ? 'SHORT' : 'LONG' });
        if (url.pathname === '/me/accounts') {
          return answer({ data: [
            { id: '111', name: 'Gamer Xperience', access_token: 'PAGE', instagram_business_account: { id: '999', username: 'gamerxp' } },
            { id: '222', name: 'Zonder Instagram', access_token: 'PAGE2' },
          ] });
        }
        if (url.pathname === '/111/photos') return answer({ id: '5', post_id: '111_5' });
        if (url.pathname === '/111/feed') return answer({ id: '111_6' });
        if (url.pathname === '/999/media') return answer({ id: 'container1' });
        if (url.pathname === '/container1') return answer({ status_code: ++polls < 3 ? 'IN_PROGRESS' : 'FINISHED' });
        if (url.pathname === '/999/media_publish') return answer({ id: 'media1' });
        if (url.pathname === '/media1') return answer({ permalink: 'https://www.instagram.com/p/abc/' });
        return answer({ error: { message: 'Unknown path', code: 100 } }, 400);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { loadConfig } = await import('../src/config.js');
    client = createSocialClient({ ...loadConfig(), ...META, META_GRAPH_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }, 1)!;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it('is off without the app id and secret', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(createSocialClient(loadConfig())).toBeNull();
  });

  it('asks Facebook for the right permissions', () => {
    const url = new URL(client.loginUrl('abc', 'https://gamerxp.test/admin/'));
    expect(url.origin + url.pathname).toBe('https://www.facebook.com/v27.0/dialog/oauth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: '1234567890', redirect_uri: 'https://gamerxp.test/admin/', state: 'abc', response_type: 'code',
      scope: 'pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish',
    });
  });

  it('turns the code into the pages, with a key that lasts', async () => {
    const pages = await client.pagesFromCode('the-code', 'https://gamerxp.test/admin/');
    expect(pages).toEqual([
      { id: '111', name: 'Gamer Xperience', token: 'PAGE', instagram: { id: '999', username: 'gamerxp' } },
      { id: '222', name: 'Zonder Instagram', token: 'PAGE2', instagram: null },
    ]);
    expect(seen[0]!.params).toMatchObject({ client_secret: 'app-secret-for-tests', code: 'the-code', redirect_uri: 'https://gamerxp.test/admin/' });
    expect(seen[1]!.params).toMatchObject({ grant_type: 'fb_exchange_token', fb_exchange_token: 'SHORT' });
    expect(seen[2]!.params.access_token).toBe('LONG');
  });

  it('places on Facebook, with and without a photo', async () => {
    seen.length = 0;
    expect(await client.postToFacebook({ id: '111', token: 'PAGE' }, { text: 'Met foto', imageUrl: 'https://gamerxp.test/a.jpg' })).toEqual({ id: '111_5', url: 'https://www.facebook.com/111_5' });
    expect(seen[0]).toEqual({ method: 'POST', path: '/111/photos', params: { url: 'https://gamerxp.test/a.jpg', caption: 'Met foto', access_token: 'PAGE' } });
    expect(await client.postToFacebook({ id: '111', token: 'PAGE' }, { text: 'Alleen tekst', imageUrl: null })).toEqual({ id: '111_6', url: 'https://www.facebook.com/111_6' });
    expect(seen[1]).toEqual({ method: 'POST', path: '/111/feed', params: { message: 'Alleen tekst', access_token: 'PAGE' } });
  });

  it('places on Instagram once the photo has been taken in', async () => {
    seen.length = 0;
    expect(await client.postToInstagram({ id: '999', token: 'PAGE' }, { text: 'Hallo', imageUrl: 'https://gamerxp.test/a.jpg' })).toEqual({ id: 'media1', url: 'https://www.instagram.com/p/abc/' });
    expect(seen.map((s) => s.path)).toEqual(['/999/media', '/container1', '/container1', '/container1', '/999/media_publish', '/media1']);
    expect(seen[0]!.params).toEqual({ image_url: 'https://gamerxp.test/a.jpg', caption: 'Hallo', access_token: 'PAGE' });
    expect(seen[4]!.params).toEqual({ creation_id: 'container1', access_token: 'PAGE' });
  });

  it('says so when the connection has run out', async () => {
    const error = await client.postToFacebook({ id: '111', token: 'DEAD' }, { text: 'x', imageUrl: null }).catch((err) => err);
    expect(error).toBeInstanceOf(SocialError);
    expect(error.expired).toBe(true);
    expect(error.message).toBe('De koppeling met Facebook is verlopen. Verbind opnieuw.');
  });
});
