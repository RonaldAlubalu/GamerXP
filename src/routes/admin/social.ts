import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../../lib/errors.js';
import {
  choosePage, createPost, disconnect, finishConnect, getConnection, listPosts, pendingPages, publishPost, redirectUri, startConnect,
} from '../../services/social.js';

// Social media from the admin: connect the Facebook page, write a post, place it now or later.

const idParam = z.object({ id: z.coerce.number().int().positive() });
// Instagram takes 2200 characters and ten photos at most.
const MAX_TEXT = 2200;
const MAX_PHOTOS = 10;

function requireOwner(req: FastifyRequest) {
  if (req.admin?.role !== 'owner') throw new HttpError(403, 'Alleen een eigenaar kan op social media plaatsen.', 'forbidden');
}

export const socialRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => requireOwner(req));

  app.get('/social', async () => {
    const connection = app.social ? await getConnection(app) : null;
    const pending = app.social && !connection ? await pendingPages(app) : null;
    return {
      configured: Boolean(app.social),
      // The address the owner fills in at Meta as the place to come back to.
      redirectUri: redirectUri(app.config),
      connection: connection && { page: connection.pageName, instagram: connection.instagramName || (connection.instagramId ? 'Instagram' : ''), connectedAt: connection.connectedAt },
      choose: pending?.map((p) => ({ id: p.id, name: p.name, instagram: p.instagram?.username ?? '' })) ?? null,
      posts: await listPosts(app),
    };
  });

  app.post('/social/connect', async (req) => ({ url: await startConnect(app, req.admin!.id) }));

  app.post('/social/callback', async (req) => {
    const { code, state } = z.object({ code: z.string().min(1).max(2000), state: z.string().min(1).max(200) }).parse(req.body);
    return { result: await finishConnect(app, req.admin!.id, code, state) };
  });

  app.post('/social/page', async (req) => {
    const { id } = z.object({ id: z.string().regex(/^\d{1,30}$/) }).parse(req.body);
    await choosePage(app, id);
    return { ok: true };
  });

  app.delete('/social/connection', async (_req, reply) => {
    await disconnect(app);
    return reply.status(204).send();
  });

  // A new post. Without a moment it goes out right away, and the answer says how that went.
  app.post('/social/posts', { bodyLimit: 9 * 1024 * 1024 }, async (req, reply) => {
    const body = z
      .object({
        text: z.string().trim().max(MAX_TEXT, `De tekst mag ${MAX_TEXT} tekens lang zijn.`).default(''),
        images: z.array(z.string().max(850_000, 'Deze foto is te groot.').regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/, 'Deze foto kan niet worden gebruikt.'))
          .max(MAX_PHOTOS, `Een post kan hooguit ${MAX_PHOTOS} foto's hebben.`).default([]),
        facebook: z.boolean().default(false),
        instagram: z.boolean().default(false),
        scheduledAt: z.iso.datetime({ offset: true }).nullable().default(null),
      })
      .parse(req.body);
    if (!app.social || !(await getConnection(app))) throw new HttpError(409, 'Verbind eerst je Facebook-pagina.', 'not_connected');
    if (!body.facebook && !body.instagram) throw new HttpError(400, 'Kies waar de post heen moet: Facebook, Instagram of allebei.', 'no_channel');
    if (!body.text && !body.images.length) throw new HttpError(400, 'Schrijf een tekst of kies een foto.', 'empty');
    if (body.instagram && !body.images.length) throw new HttpError(400, 'Instagram heeft een foto nodig.', 'image_needed');
    const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : null;
    if (scheduledAt && scheduledAt.getTime() < Date.now() + 60_000) throw new HttpError(400, 'Kies een moment in de toekomst.', 'in_the_past');
    if (scheduledAt && scheduledAt.getTime() > Date.now() + 366 * 86_400_000) throw new HttpError(400, 'Plan een post hooguit een jaar vooruit.', 'too_far');
    const id = await createPost(
      app,
      { text: body.text, images: body.images.map((image) => Buffer.from(image.split(',')[1]!, 'base64')), facebook: body.facebook, instagram: body.instagram, scheduledAt },
      req.admin!.name || req.admin!.email,
    );
    const placed = scheduledAt ? null : await publishPost(app, id);
    return reply.status(201).send({ id, scheduled: Boolean(scheduledAt), ok: placed?.ok ?? true });
  });

  // Once more, for the channels the post did not reach.
  app.post('/social/posts/:id/retry', async (req) => {
    const { id } = idParam.parse(req.params);
    const { rowCount } = await app.db.query("SELECT 1 FROM social_posts WHERE id = $1 AND status = 'failed'", [id]);
    if (!rowCount) throw new HttpError(409, 'Deze post kan niet opnieuw worden geplaatst.', 'not_failed');
    return publishPost(app, id);
  });

  // Takes a post off the list. One that is already online stays online.
  app.delete('/social/posts/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { rowCount } = await app.db.query("DELETE FROM social_posts WHERE id = $1 AND status <> 'posting'", [id]);
    if (!rowCount) throw new HttpError(409, 'Deze post wordt net geplaatst of bestaat niet meer.', 'busy');
    return reply.status(204).send();
  });
};
