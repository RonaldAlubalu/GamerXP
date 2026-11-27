import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../../lib/errors.js';
import { cleanText, listPhotos, META_KEYS, pageImages, textBlocks, textKey } from '../../services/site-content.js';
import { listHtml, SITE_DIR } from '../../site.js';

// The website from the admin: the wording per page, and the photos in the strip.

const PARTIAL_LABELS: Record<string, string> = {
  header: 'Menu bovenaan',
  footer: 'Voettekst onderaan',
  cta: 'Oproep onderaan de pagina',
  'article-cta': 'Oproep onder een verhaal',
  faq: 'Veelgestelde vragen',
  games: 'Games',
  packages: 'Pakketten',
  reviews: 'Reviews (kort)',
  'reviews-full': 'Reviews (alle)',
  'reviews-panel': 'Reviews (paneel)',
  stats: 'Cijfers',
};
const META_RE = /^\s*<!--\s*(\{[\s\S]*?\})\s*-->/;
const idParam = z.object({ id: z.coerce.number().int().positive() });

function requireOwner(req: FastifyRequest) {
  if (req.admin?.role !== 'owner') throw new HttpError(403, 'Alleen een eigenaar kan de website aanpassen.', 'forbidden');
}

interface SiteFile {
  file: string;
  label: string;
  route: string | null;
  group: 'page' | 'shared';
}

async function siteFiles(): Promise<SiteFile[]> {
  const files: SiteFile[] = [];
  for (const name of await listHtml(path.join(SITE_DIR, 'pages'))) {
    const source = await readFile(path.join(SITE_DIR, 'pages', name), 'utf8');
    const meta = JSON.parse(META_RE.exec(source)?.[1] ?? '{}') as { title?: string };
    const route = name === 'index.html' ? '/' : `/${name.replace(/\.html$/, '')}`;
    files.push({ file: `pages/${name}`, label: route === '/' ? 'Home' : (meta.title ?? route).split('|')[0]!.trim(), route: route === '/404' ? null : route, group: 'page' });
  }
  for (const name of await listHtml(path.join(SITE_DIR, 'partials'))) {
    const key = name.replace(/\.html$/, '');
    if (key === 'gallery') continue;
    files.push({ file: `partials/${name}`, label: PARTIAL_LABELS[key] ?? key, route: null, group: 'shared' });
  }
  return files;
}

async function sourceOf(file: string): Promise<{ info: SiteFile; source: string }> {
  const info = (await siteFiles()).find((f) => f.file === file);
  if (!info) throw new HttpError(404, 'Deze pagina bestaat niet.', 'not_found');
  return { info, source: await readFile(path.join(SITE_DIR, info.file), 'utf8') };
}

async function reload(app: FastifyInstance) {
  await app.reloadSite();
}

export const siteRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => requireOwner(req));

  app.get('/site/files', async () => {
    const changed = await app.db.query<{ file: string; count: number }>('SELECT file, count(*)::int AS count FROM site_texts GROUP BY file');
    const counts = new Map(changed.rows.map((r) => [r.file, r.count]));
    return (await siteFiles()).map((f) => ({ ...f, changed: counts.get(f.file) ?? 0 }));
  });

  // Every piece of text of one page, with what it says now.
  app.get('/site/file', async (req) => {
    const { file } = z.object({ file: z.string().max(300) }).parse(req.query);
    const { info, source } = await sourceOf(file);
    const { rows } = await app.db.query<{ original: string; replacement: string }>('SELECT original, replacement FROM site_texts WHERE file = $1 ORDER BY updated_at', [file]);
    const changes = new Map(rows.map((r) => [r.original, r.replacement]));
    const blocks = textBlocks(source.replace(META_RE, ''));
    const known = new Set(blocks.map((b) => b.original));
    const meta = info.group === 'page' ? (JSON.parse(META_RE.exec(source)?.[1] ?? '{}') as { title?: string; description?: string }) : null;
    const replaced = await app.db.query<{ id: number; slot: string }>('SELECT id::int, slot FROM site_images WHERE file = $1', [file]);
    const newImage = new Map(replaced.rows.map((r) => [r.slot, `/api/site-image/${r.id}`]));
    return {
      ...info,
      images: pageImages(source).map((i) => ({ ...i, current: newImage.get(i.slot) ?? i.original, changed: newImage.has(i.slot) })),
      meta: meta && [
        { key: '@title', original: meta.title ?? '', current: changes.get('@title') ?? meta.title ?? '', changed: changes.has('@title') },
        { key: '@description', original: meta.description ?? '', current: changes.get('@description') ?? meta.description ?? '', changed: changes.has('@description') },
      ],
      blocks: blocks.map((b) => ({ ...b, current: changes.get(b.original) ?? b.original, changed: changes.has(b.original) })),
      // Changes to wording that is no longer in the page: they do nothing any more.
      stale: rows.filter((r) => !known.has(r.original) && !(META_KEYS as readonly string[]).includes(r.original)),
    };
  });

  // Changes one piece of text, or puts the original back (replacement: null).
  app.put('/site/text', async (req) => {
    const body = z.object({ file: z.string().max(300), original: z.string().min(1).max(20_000), replacement: z.string().max(20_000).nullable() }).parse(req.body);
    const { info, source } = await sourceOf(body.file);
    const isMeta = (META_KEYS as readonly string[]).includes(body.original);
    if (body.replacement === null) {
      await app.db.query('DELETE FROM site_texts WHERE file = $1 AND key = $2', [body.file, textKey(body.original)]);
      await reload(app);
      return { current: null };
    }
    if (isMeta ? info.group !== 'page' : !textBlocks(source.replace(META_RE, '')).some((b) => b.original === body.original)) {
      throw new HttpError(409, 'Deze tekst staat niet meer zo op de pagina. Ververs de pagina en probeer het opnieuw.', 'text_gone');
    }
    const replacement = isMeta ? body.replacement.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : cleanText(body.replacement);
    if (!replacement.replace(/<[^>]+>/g, '').trim()) throw new HttpError(400, 'De tekst mag niet leeg zijn.', 'validation_error');
    await app.db.query(
      `INSERT INTO site_texts (file, key, original, replacement) VALUES ($1, $2, $3, $4)
       ON CONFLICT (file, key) DO UPDATE SET replacement = EXCLUDED.replacement, updated_at = now()`,
      [body.file, textKey(body.original), body.original, replacement],
    );
    await reload(app);
    return { current: replacement };
  });

  // Puts a photo of your own in place of one on a page, or the original back (image: null).
  app.put('/site/image', { bodyLimit: 1200 * 1024 }, async (req) => {
    const body = z
      .object({
        file: z.string().max(300),
        slot: z.string().min(1).max(300),
        image: z.string().max(1_100_000).regex(/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/, 'Deze foto kan niet worden gebruikt.').nullable(),
        width: z.number().int().min(100).max(4000).optional(),
        height: z.number().int().min(100).max(4000).optional(),
      })
      .parse(req.body);
    const { source } = await sourceOf(body.file);
    // The old photo goes: a new one gets a new address, so no browser keeps showing the old one.
    await app.db.query('DELETE FROM site_images WHERE file = $1 AND slot = $2', [body.file, body.slot]);
    if (body.image !== null) {
      if (!pageImages(source).some((i) => i.slot === body.slot)) throw new HttpError(409, 'Deze foto staat niet meer op de pagina. Ververs de pagina en probeer het opnieuw.', 'image_gone');
      if (!body.width || !body.height) throw new HttpError(400, 'Deze foto kan niet worden gebruikt.', 'validation_error');
      const [head, data] = body.image.split(',') as [string, string];
      await app.db.query('INSERT INTO site_images (file, slot, mime, data, width, height) VALUES ($1, $2, $3, $4, $5, $6)', [body.file, body.slot, head.includes('png') ? 'image/png' : 'image/jpeg', Buffer.from(data, 'base64'), body.width, body.height]);
    }
    await reload(app);
    return { ok: true };
  });

  app.get('/site/photos', async () => listPhotos(app.db));

  // A photo of your own. The admin page makes it small enough before sending.
  app.post('/site/photos', { bodyLimit: 1200 * 1024 }, async (req, reply) => {
    const body = z
      .object({
        image: z.string().max(1_100_000).regex(/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/, 'Deze foto kan niet worden gebruikt.'),
        alt: z.string().trim().max(150).default(''),
        width: z.number().int().min(100).max(4000),
        height: z.number().int().min(100).max(4000),
      })
      .parse(req.body);
    const [head, data] = body.image.split(',') as [string, string];
    const { rows } = await app.db.query<{ id: number }>(
      `INSERT INTO site_photos (position, alt, width, height, mime, data)
       VALUES ((SELECT coalesce(max(position), 0) + 1 FROM site_photos), $1, $2, $3, $4, $5) RETURNING id::int`,
      [body.alt, body.width, body.height, head.includes('png') ? 'image/png' : 'image/jpeg', Buffer.from(data, 'base64')],
    );
    await reload(app);
    return reply.status(201).send({ id: rows[0]!.id });
  });

  app.patch('/site/photos/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ alt: z.string().trim().max(150).optional(), hidden: z.boolean().optional() }).parse(req.body);
    const { rowCount } = await app.db.query('UPDATE site_photos SET alt = COALESCE($2, alt), hidden = COALESCE($3, hidden) WHERE id = $1', [id, body.alt ?? null, body.hidden ?? null]);
    if (!rowCount) throw new HttpError(404, 'Deze foto bestaat niet meer.', 'not_found');
    await reload(app);
    return { ok: true };
  });

  // The order of the strip: every photo, first to last.
  app.put('/site/photos/order', async (req) => {
    const { ids } = z.object({ ids: z.array(z.number().int().positive()).max(500) }).parse(req.body);
    await app.db.query(
      `UPDATE site_photos p SET position = o.position::int
         FROM unnest($1::bigint[]) WITH ORDINALITY AS o(id, position) WHERE p.id = o.id`,
      [ids],
    );
    await reload(app);
    return { ok: true };
  });

  // A photo of your own goes for good; one that came with the site can only be hidden.
  app.delete('/site/photos/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { rowCount } = await app.db.query("DELETE FROM site_photos WHERE id = $1 AND src = ''", [id]);
    if (!rowCount) throw new HttpError(409, 'Deze foto hoort bij de website zelf. Je kunt hem wel verbergen.', 'built_in');
    await reload(app);
    return reply.status(204).send();
  });
};
