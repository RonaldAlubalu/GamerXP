import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../../lib/errors.js';
import { photoUrl, slugify, STORY_COLUMNS, storyPage, storyPhotos, toStory } from '../../services/stories.js';

// Stories (blog posts) from the admin: write, look at it, publish.

const idParam = z.object({ id: z.coerce.number().int().positive() });
const content = z.object({
  title: z.string().trim().max(150, 'De titel mag 150 tekens lang zijn.'),
  intro: z.string().trim().max(400, 'De samenvatting mag 400 tekens lang zijn.'),
  body: z.string().max(60_000, 'Dit verhaal is te lang.'),
  publishedOn: z.iso.date('Kies een datum.'),
});

function requireOwner(req: FastifyRequest) {
  if (req.admin?.role !== 'owner') throw new HttpError(403, 'Alleen een eigenaar kan verhalen schrijven.', 'forbidden');
}

interface Row {
  id: number; slug: string | null; title: string; intro: string; body: string; published_on: string; cover_id: number | null; published: boolean;
}

async function find(app: FastifyInstance, id: number): Promise<Row> {
  const { rows } = await app.db.query<Row>(`SELECT ${STORY_COLUMNS}, published FROM stories WHERE id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Dit verhaal bestaat niet meer.', 'not_found');
  return rows[0];
}

// An address that is still free: not a page of the site, not another story.
async function freeSlug(app: FastifyInstance, title: string, id: number): Promise<string> {
  const base = slugify(title);
  if (!base) throw new HttpError(400, 'Geef het verhaal een titel met letters of cijfers.', 'no_slug');
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const taken = await app.db.query('SELECT 1 FROM stories WHERE slug = $1 AND id <> $2', [slug, id]);
    if (!taken.rowCount && !app.sitePaths.has(`/verhalen/${slug}`)) return slug;
  }
}

export const storyRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => requireOwner(req));

  app.get('/stories', async () => {
    const { rows } = await app.db.query(
      `SELECT id::int, slug, title, published, to_char(published_on, 'YYYY-MM-DD') AS "publishedOn", cover_id::int AS "coverId", updated_at AS "updatedAt"
         FROM stories ORDER BY published, published_on DESC, id DESC`,
    );
    return rows.map((r) => ({ ...r, cover: r.coverId ? photoUrl(r.coverId) : null }));
  });

  // A new story starts as an empty draft, so photos have something to hang on.
  app.post('/stories', async (_req, reply) => {
    const { rows } = await app.db.query<{ id: number }>('INSERT INTO stories DEFAULT VALUES RETURNING id::int');
    return reply.status(201).send({ id: rows[0]!.id });
  });

  app.get('/stories/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const story = await find(app, id);
    const photos = await storyPhotos(app.db, id);
    return {
      id, slug: story.slug, title: story.title, intro: story.intro, body: story.body, publishedOn: story.published_on, published: story.published,
      coverId: story.cover_id,
      photos: [...photos.values()].map((p) => ({ ...p, url: photoUrl(p.id) })),
    };
  });

  app.put('/stories/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = content.parse(req.body);
    const story = await find(app, id);
    if (story.published && (!body.title || !body.intro || !body.body.trim())) {
      throw new HttpError(400, 'Een verhaal dat online staat heeft een titel, een samenvatting en tekst nodig.', 'incomplete');
    }
    await app.db.query('UPDATE stories SET title = $2, intro = $3, body = $4, published_on = $5, updated_at = now() WHERE id = $1', [id, body.title, body.intro, body.body, body.publishedOn]);
    if (story.published) await app.reloadSite();
    return { ok: true };
  });

  // Online or offline. The address is made at the first publication and stays, so links keep working.
  app.post('/stories/:id/publish', async (req) => {
    const { id } = idParam.parse(req.params);
    const { published } = z.object({ published: z.boolean() }).parse(req.body);
    const story = await find(app, id);
    if (published && (!story.title || !story.intro || !story.body.trim())) {
      throw new HttpError(400, 'Vul eerst de titel, de samenvatting en de tekst in, en sla op.', 'incomplete');
    }
    const slug = story.slug ?? (published ? await freeSlug(app, story.title, id) : null);
    await app.db.query('UPDATE stories SET published = $2, slug = $3, updated_at = now() WHERE id = $1', [id, published, slug]);
    await app.reloadSite();
    return { ok: true, slug, url: slug && published ? `/verhalen/${slug}` : null };
  });

  // The page as it will look, without putting it online.
  app.post('/stories/:id/preview', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = content.parse(req.body);
    const story = await find(app, id);
    const page = storyPage(toStory({ ...story, ...body, published_on: body.publishedOn, slug: story.slug ?? 'voorbeeld' }, await storyPhotos(app.db, id)));
    return { html: await app.renderSitePage({ ...page.meta, noindex: true }, page.body, `/verhalen/${story.slug ?? 'voorbeeld'}`) };
  });

  // A photo: the one at the top of the story, or one for in the text.
  app.post('/stories/:id/photos', { bodyLimit: 1300 * 1024 }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        image: z.string().max(1_200_000, 'Deze foto is te groot.').regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/, 'Deze foto kan niet worden gebruikt.'),
        width: z.number().int().min(100).max(4000),
        height: z.number().int().min(100).max(4000),
        alt: z.string().trim().max(150).default(''),
        cover: z.boolean().default(false),
      })
      .parse(req.body);
    const story = await find(app, id);
    const count = await app.db.query('SELECT 1 FROM story_images WHERE story_id = $1', [id]);
    if ((count.rowCount ?? 0) >= 30) throw new HttpError(400, "Een verhaal kan hooguit 30 foto's hebben.", 'too_many');
    const { rows } = await app.db.query<{ id: number }>(
      'INSERT INTO story_images (story_id, data, width, height, alt) VALUES ($1, $2, $3, $4, $5) RETURNING id::int',
      [id, Buffer.from(body.image.split(',')[1]!, 'base64'), body.width, body.height, body.alt],
    );
    if (body.cover) {
      // The photo it replaces at the top goes, unless the text still shows it.
      const old = story.cover_id;
      await app.db.query('UPDATE stories SET cover_id = $2, updated_at = now() WHERE id = $1', [id, rows[0]!.id]);
      if (old && !new RegExp(`\\[foto ${old}\\]`, 'i').test(story.body)) await app.db.query('DELETE FROM story_images WHERE id = $1', [old]);
    }
    if (story.published) await app.reloadSite();
    return reply.status(201).send({ id: rows[0]!.id, url: photoUrl(rows[0]!.id) });
  });

  app.delete('/stories/:id/photos/:photoId', async (req, reply) => {
    const { id, photoId } = z.object({ id: z.coerce.number().int().positive(), photoId: z.coerce.number().int().positive() }).parse(req.params);
    const story = await find(app, id);
    await app.db.query('UPDATE stories SET cover_id = NULL WHERE id = $1 AND cover_id = $2', [id, photoId]);
    await app.db.query('DELETE FROM story_images WHERE id = $1 AND story_id = $2', [photoId, id]);
    if (story.published) await app.reloadSite();
    return reply.status(204).send();
  });

  app.delete('/stories/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await find(app, id);
    await app.db.query('DELETE FROM stories WHERE id = $1', [id]);
    await app.reloadSite();
    return reply.status(204).send();
  });
};
