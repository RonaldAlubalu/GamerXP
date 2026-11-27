import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { generateSessionToken, hashToken } from '../lib/auth.js';
import { HttpError } from '../lib/errors.js';

// Posting to the owner's Facebook page and the Instagram account that hangs on it, through
// Meta's Graph API and the owner's own Meta app.

export interface SocialPage {
  id: string;
  name: string;
  token: string;
  instagram: { id: string; username: string } | null;
}
export interface PostContent {
  text: string;
  // Public addresses of the photos; Meta fetches them from there.
  imageUrls: string[];
}
export interface Placed {
  id: string;
  url: string;
}
export interface SocialClient {
  loginUrl(state: string, redirectUri: string): string;
  // After the owner said yes at Facebook: the pages they manage, each with its own key.
  pagesFromCode(code: string, redirectUri: string): Promise<SocialPage[]>;
  postToFacebook(page: { id: string; token: string }, post: PostContent): Promise<Placed>;
  postToInstagram(account: { id: string; token: string }, post: PostContent): Promise<Placed>;
}

const SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish'];
// Meta's code for a key that no longer works.
const EXPIRED = 190;

export class SocialError extends Error {
  constructor(message: string, public expired = false) {
    super(message);
  }
}

export function createSocialClient(config: Config, pause = 3000): SocialClient | null {
  if (!config.META_APP_ID || !config.META_APP_SECRET) return null;
  const base = config.META_GRAPH_URL.replace(/\/$/, '');

  async function call<T>(method: 'GET' | 'POST', path: string, params: Record<string, string>): Promise<T> {
    const query = new URLSearchParams(params);
    let res: Response;
    try {
      res = await fetch(method === 'GET' ? `${base}${path}?${query}` : `${base}${path}`, {
        method,
        ...(method === 'POST' ? { body: query } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new SocialError('Facebook is niet bereikbaar. Probeer het later opnieuw.');
    }
    const body = (await res.json().catch(() => null)) as (T & { error?: { message?: string; code?: number; error_user_msg?: string } }) | null;
    if (!res.ok || !body || body.error) {
      const error = body?.error;
      if (error?.code === EXPIRED) throw new SocialError('De koppeling met Facebook is verlopen. Verbind opnieuw.', true);
      throw new SocialError(error?.error_user_msg || error?.message || `Facebook gaf een fout (${res.status}).`);
    }
    return body;
  }

  return {
    loginUrl(state, redirectUri) {
      const query = new URLSearchParams({ client_id: config.META_APP_ID, redirect_uri: redirectUri, state, scope: SCOPES.join(','), response_type: 'code' });
      return `${config.META_LOGIN_URL}?${query}`;
    },

    async pagesFromCode(code, redirectUri) {
      const app = { client_id: config.META_APP_ID, client_secret: config.META_APP_SECRET };
      const short = await call<{ access_token: string }>('GET', '/oauth/access_token', { ...app, redirect_uri: redirectUri, code });
      // The long-lasting key: page keys made from it do not run out.
      const long = await call<{ access_token: string }>('GET', '/oauth/access_token', { ...app, grant_type: 'fb_exchange_token', fb_exchange_token: short.access_token });
      const pages = await call<{ data: { id: string; name: string; access_token: string; instagram_business_account?: { id: string; username?: string } }[] }>(
        'GET', '/me/accounts', { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '100', access_token: long.access_token });
      return pages.data.map((p) => ({
        id: p.id,
        name: p.name,
        token: p.access_token,
        instagram: p.instagram_business_account ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username ?? '' } : null,
      }));
    },

    async postToFacebook(page, post) {
      if (!post.imageUrls.length) {
        const made = await call<{ id: string }>('POST', `/${page.id}/feed`, { message: post.text, access_token: page.token });
        return { id: made.id, url: `https://www.facebook.com/${made.id}` };
      }
      if (post.imageUrls.length === 1) {
        const made = await call<{ id: string; post_id?: string }>('POST', `/${page.id}/photos`, { url: post.imageUrls[0]!, caption: post.text, access_token: page.token });
        return { id: made.post_id ?? made.id, url: `https://www.facebook.com/${made.post_id ?? made.id}` };
      }
      // Several photos: each is handed over unseen first, then one post shows them together.
      const attached: Record<string, string> = {};
      for (const [i, url] of post.imageUrls.entries()) {
        const photo = await call<{ id: string }>('POST', `/${page.id}/photos`, { url, published: 'false', access_token: page.token });
        attached[`attached_media[${i}]`] = JSON.stringify({ media_fbid: photo.id });
      }
      const made = await call<{ id: string }>('POST', `/${page.id}/feed`, { message: post.text, ...attached, access_token: page.token });
      return { id: made.id, url: `https://www.facebook.com/${made.id}` };
    },

    async postToInstagram(account, post) {
      if (!post.imageUrls.length) throw new SocialError('Instagram heeft een foto nodig.');
      // Instagram fetches a photo first; that takes a moment.
      const ready = async (id: string) => {
        for (let attempt = 0; ; attempt++) {
          const state = await call<{ status_code?: string }>('GET', `/${id}`, { fields: 'status_code', access_token: account.token });
          if (!state.status_code || state.status_code === 'FINISHED') return id;
          if (state.status_code === 'ERROR' || state.status_code === 'EXPIRED') throw new SocialError('Instagram kon de foto niet verwerken.');
          if (attempt >= 20) throw new SocialError('Instagram deed te lang over de foto. Probeer het opnieuw.');
          await new Promise((resolve) => setTimeout(resolve, pause));
        }
      };
      const media = (params: Record<string, string>) => call<{ id: string }>('POST', `/${account.id}/media`, { ...params, access_token: account.token }).then((made) => ready(made.id));
      let container: string;
      if (post.imageUrls.length === 1) {
        container = await media({ image_url: post.imageUrls[0]!, caption: post.text });
      } else {
        // A carousel: every photo apart, then the whole.
        const children: string[] = [];
        for (const url of post.imageUrls) children.push(await media({ image_url: url, is_carousel_item: 'true' }));
        container = await media({ media_type: 'CAROUSEL', children: children.join(','), caption: post.text });
      }
      const made = await call<{ id: string }>('POST', `/${account.id}/media_publish`, { creation_id: container, access_token: account.token });
      const link = await call<{ permalink?: string }>('GET', `/${made.id}`, { fields: 'permalink', access_token: account.token }).catch(() => ({ permalink: '' }));
      return { id: made.id, url: link.permalink ?? '' };
    },
  };
}

// The connection ---------------------------------------------------------------------------

export interface Connection {
  pageId: string;
  pageName: string;
  pageToken: string;
  instagramId: string;
  instagramName: string;
  connectedAt: string;
}

// The page key is kept locked with the app secret, so a copy of the database alone cannot post.
function keyOf(config: Config): Buffer {
  return createHash('sha256').update(`gamerxp-social|${config.META_APP_SECRET}`).digest();
}
function lock(config: Config, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(config), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}
function unlock<T>(config: Config, stored: string): T | null {
  try {
    const [iv, tag, data] = stored.split('.').map((part) => Buffer.from(part, 'base64')) as [Buffer, Buffer, Buffer];
    const decipher = createDecipheriv('aes-256-gcm', keyOf(config), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')) as T;
  } catch {
    return null;
  }
}

async function readSetting(db: Db, key: string): Promise<string | null> {
  const { rows } = await db.query<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}
async function writeSetting(db: Db, key: string, value: string | null): Promise<void> {
  if (value === null) await db.query('DELETE FROM app_settings WHERE key = $1', [key]);
  else await db.query('INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
}

export async function getConnection(app: FastifyInstance): Promise<Connection | null> {
  const stored = await readSetting(app.db, 'social_connection');
  return stored ? unlock<Connection>(app.config, stored) : null;
}

// The pages to choose from, when the owner manages more than one.
export async function pendingPages(app: FastifyInstance): Promise<SocialPage[] | null> {
  const stored = await readSetting(app.db, 'social_pending');
  const pending = stored ? unlock<{ pages: SocialPage[]; until: number }>(app.config, stored) : null;
  return pending && pending.until > Date.now() ? pending.pages : null;
}

export const redirectUri = (config: Config) => `${config.PUBLIC_URL.replace(/\/$/, '')}/admin/`;

function client(app: FastifyInstance): SocialClient {
  if (!app.social) throw new HttpError(409, 'De koppeling met Facebook is nog niet ingesteld.', 'not_configured');
  return app.social;
}

// Step one: the address at Facebook where the owner gives permission.
export async function startConnect(app: FastifyInstance, userId: number): Promise<string> {
  const state = generateSessionToken();
  await writeSetting(app.db, 'social_state', JSON.stringify({ hash: hashToken(state), userId, until: Date.now() + 15 * 60_000 }));
  return client(app).loginUrl(state, redirectUri(app.config));
}

async function connect(app: FastifyInstance, page: SocialPage): Promise<void> {
  const connection: Connection = {
    pageId: page.id, pageName: page.name, pageToken: page.token,
    instagramId: page.instagram?.id ?? '', instagramName: page.instagram?.username ?? '',
    connectedAt: new Date().toISOString(),
  };
  await writeSetting(app.db, 'social_connection', lock(app.config, connection));
  await writeSetting(app.db, 'social_pending', null);
}

// Step two: Facebook sent the owner back with a code.
export async function finishConnect(app: FastifyInstance, userId: number, code: string, state: string): Promise<'connected' | 'choose'> {
  const stored = JSON.parse((await readSetting(app.db, 'social_state')) ?? 'null') as { hash: string; userId: number; until: number } | null;
  await writeSetting(app.db, 'social_state', null);
  if (!stored || stored.hash !== hashToken(state) || stored.userId !== userId || stored.until < Date.now()) {
    throw new HttpError(400, 'Deze poging om te verbinden is verlopen. Begin opnieuw.', 'state_mismatch');
  }
  const pages = await client(app).pagesFromCode(code, redirectUri(app.config)).catch((err) => {
    throw new HttpError(502, (err as Error).message, 'social_failed');
  });
  if (!pages.length) {
    throw new HttpError(409, 'Facebook gaf geen pagina door. Vink bij het verbinden je pagina aan, en controleer dat je er beheerder van bent.', 'no_pages');
  }
  if (pages.length === 1) {
    await connect(app, pages[0]!);
    return 'connected';
  }
  await writeSetting(app.db, 'social_pending', lock(app.config, { pages, until: Date.now() + 30 * 60_000 }));
  return 'choose';
}

export async function choosePage(app: FastifyInstance, pageId: string): Promise<void> {
  const page = (await pendingPages(app))?.find((p) => p.id === pageId);
  if (!page) throw new HttpError(404, 'Deze pagina staat niet meer klaar. Verbind opnieuw.', 'not_found');
  await connect(app, page);
}

export async function disconnect(app: FastifyInstance): Promise<void> {
  await writeSetting(app.db, 'social_connection', null);
  await writeSetting(app.db, 'social_pending', null);
}

// Posts ------------------------------------------------------------------------------------

export interface NewPost {
  text: string;
  images: Buffer[];
  facebook: boolean;
  instagram: boolean;
  scheduledAt: Date | null;
}
interface PostRow {
  id: string; body: string; to_facebook: boolean; to_instagram: boolean; scheduled_at: Date | null;
  facebook_id: string; instagram_id: string;
}

export const imageUrl = (config: Config, key: string) => `${config.PUBLIC_URL.replace(/\/$/, '')}/api/social-image/${key}.jpg`;

export async function createPost(app: FastifyInstance, post: NewPost, actor: string): Promise<number> {
  const client = await app.db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO social_posts (body, to_facebook, to_instagram, scheduled_at, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id::int`,
      [post.text, post.facebook, post.instagram, post.scheduledAt, actor],
    );
    for (const [i, image] of post.images.entries()) {
      await client.query('INSERT INTO social_post_images (post_id, position, image, image_key) VALUES ($1, $2, $3, $4)', [rows[0]!.id, i + 1, image, randomBytes(18).toString('base64url')]);
    }
    await client.query('COMMIT');
    return rows[0]!.id;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Places a post on every channel it has not reached yet. Never throws: what went wrong is kept with the post.
export async function publishPost(app: FastifyInstance, id: number): Promise<{ ok: boolean }> {
  const claimed = await app.db.query<PostRow>(
    `UPDATE social_posts SET status = 'posting', updated_at = now() WHERE id = $1 AND status IN ('scheduled', 'failed')
     RETURNING id, body, to_facebook, to_instagram, scheduled_at, facebook_id, instagram_id`,
    [id],
  );
  const post = claimed.rows[0];
  if (!post) return { ok: false };
  const connection = app.social ? await getConnection(app) : null;
  const photos = await app.db.query<{ image_key: string }>('SELECT image_key FROM social_post_images WHERE post_id = $1 ORDER BY position', [id]);
  const content: PostContent = { text: post.body, imageUrls: photos.rows.map((p) => imageUrl(app.config, p.image_key)) };
  const attempt = async (wanted: boolean, done: string, run: () => Promise<Placed>): Promise<{ placed?: Placed; error: string }> => {
    if (!wanted || done) return { error: '' };
    try {
      return { placed: await run(), error: '' };
    } catch (err) {
      if (!(err instanceof SocialError) && !(err instanceof HttpError)) app.log.error({ err }, 'Social post failed');
      return { error: err instanceof SocialError || err instanceof HttpError ? err.message : 'Er ging iets mis bij het plaatsen.' };
    }
  };
  const missing = async (): Promise<Placed> => {
    throw new SocialError('Niet verbonden met Facebook. Verbind opnieuw.');
  };
  const facebook = await attempt(post.to_facebook, post.facebook_id, () =>
    connection ? app.social!.postToFacebook({ id: connection.pageId, token: connection.pageToken }, content) : missing());
  const instagram = await attempt(post.to_instagram, post.instagram_id, () => {
    if (!connection) return missing();
    if (!connection.instagramId) throw new SocialError('Er hangt geen Instagram-account aan je Facebook-pagina.');
    return app.social!.postToInstagram({ id: connection.instagramId, token: connection.pageToken }, content);
  });
  const ok = !facebook.error && !instagram.error;
  await app.db.query(
    `UPDATE social_posts SET status = $2, updated_at = now(), posted_at = CASE WHEN $2 = 'done' THEN now() ELSE posted_at END,
            facebook_id = CASE WHEN $3 <> '' THEN $3 ELSE facebook_id END, facebook_url = CASE WHEN $3 <> '' THEN $4 ELSE facebook_url END, facebook_error = $5,
            instagram_id = CASE WHEN $6 <> '' THEN $6 ELSE instagram_id END, instagram_url = CASE WHEN $6 <> '' THEN $7 ELSE instagram_url END, instagram_error = $8
      WHERE id = $1`,
    [id, ok ? 'done' : 'failed', facebook.placed?.id ?? '', facebook.placed?.url ?? '', facebook.error, instagram.placed?.id ?? '', instagram.placed?.url ?? '', instagram.error],
  );
  // A post that was planned fails while nobody is looking: tell the owner.
  if (!ok && post.scheduled_at && app.config.OWNER_EMAIL) {
    await app.mailer
      .send({
        to: app.config.OWNER_EMAIL,
        subject: 'Een ingeplande post is niet geplaatst',
        text: [
          'Een post die je had ingepland voor social media is niet (helemaal) geplaatst.',
          '',
          ...(facebook.error ? [`Facebook: ${facebook.error}`] : []),
          ...(instagram.error ? [`Instagram: ${instagram.error}`] : []),
          '',
          `Bekijk het in het beheer: ${app.config.PUBLIC_URL.replace(/\/$/, '')}/admin/#/social`,
        ].join('\n'),
        plain: true,
      })
      .catch((err) => app.log.error({ err }, 'Could not mail about a failed social post'));
  }
  return { ok };
}

// Called every minute: places the posts whose time has come.
export async function publishDue(app: FastifyInstance): Promise<number> {
  // A post that was cut off halfway (a restart) may or may not have gone out: leave that to the owner.
  await app.db.query(
    `UPDATE social_posts SET status = 'failed', updated_at = now(),
            facebook_error = CASE WHEN to_facebook AND facebook_id = '' THEN $1 ELSE facebook_error END,
            instagram_error = CASE WHEN to_instagram AND instagram_id = '' THEN $1 ELSE instagram_error END
      WHERE status = 'posting' AND updated_at < now() - interval '10 minutes'`,
    ['Het plaatsen is onderbroken. Kijk eerst of de post er al staat voordat je het opnieuw probeert.'],
  );
  const due = await app.db.query<{ id: number }>(
    "SELECT id::int FROM social_posts WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= now() ORDER BY scheduled_at LIMIT 5",
  );
  for (const { id } of due.rows) await publishPost(app, id);
  return due.rows.length;
}

export async function listPosts(app: FastifyInstance) {
  const { rows } = await app.db.query<{
    id: number; body: string; images: string[]; to_facebook: boolean; to_instagram: boolean; scheduled_at: Date | null; status: string;
    facebook_id: string; facebook_url: string; facebook_error: string; instagram_id: string; instagram_url: string; instagram_error: string;
    created_at: Date; posted_at: Date | null;
  }>(
    `SELECT p.id::int, p.body, p.to_facebook, p.to_instagram, p.scheduled_at, p.status, p.facebook_id, p.facebook_url, p.facebook_error,
            p.instagram_id, p.instagram_url, p.instagram_error, p.created_at, p.posted_at,
            ARRAY(SELECT i.image_key FROM social_post_images i WHERE i.post_id = p.id ORDER BY i.position) AS images
       FROM social_posts p ORDER BY (status = 'scheduled') DESC, coalesce(scheduled_at, created_at) DESC LIMIT 60`,
  );
  const channel = (wanted: boolean, id: string, url: string, error: string) => (wanted ? { placed: Boolean(id), url, error } : null);
  return rows.map((p) => ({
    id: p.id,
    text: p.body,
    images: p.images.map((key) => `/api/social-image/${key}.jpg`),
    status: p.status,
    scheduledAt: p.scheduled_at,
    createdAt: p.created_at,
    postedAt: p.posted_at,
    facebook: channel(p.to_facebook, p.facebook_id, p.facebook_url, p.facebook_error),
    instagram: channel(p.to_instagram, p.instagram_id, p.instagram_url, p.instagram_error),
  }));
}
