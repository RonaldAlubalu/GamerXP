import type { Db } from '../db/pool.js';

// Stories the owner writes in the admin: from the simple marks in the text to a page of the site.

export interface StoryPhoto {
  id: number;
  width: number;
  height: number;
  alt: string;
}
export interface Story {
  slug: string;
  title: string;
  intro: string;
  body: string;
  // YYYY-MM-DD
  publishedOn: string;
  cover: StoryPhoto | null;
  photos: Map<number, StoryPhoto>;
}

const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function dutchDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
// "12 februari 2026" back to 2026-02-12, for putting stories in order.
export function parseDutchDate(text: string): string | null {
  const m = /(\d{1,2}) ([a-z]+) (\d{4})/.exec(text);
  const month = m ? MONTHS.indexOf(m[2]!) : -1;
  return m && month >= 0 ? `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : null;
}

export const photoUrl = (id: number) => `/api/story-image/${id}`;

// The last part of the address, made from the title.
export function slugify(title: string): string {
  return title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
}

// Bold, italic and links inside a line. Everything else is shown as typed.
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|\/|mailto:|tel:)[^\s)]*)\)/g, (_, label: string, url: string) =>
      /^https?:/.test(url) ? `<a href="${url}" target="_blank" rel="noopener">${label}</a>` : `<a href="${url}">${label}</a>`)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
}

// The text of a story as HTML: "## " a heading, "### " a smaller one, "- " a list, "1. " a
// numbered list, "> " a quote, "[foto 12]" a photo; an empty line starts a new paragraph.
export function renderBody(source: string, photos: Map<number, StoryPhoto> = new Map()): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  const flush = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
    if (list) out.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${list.tag}>`);
    paragraph = [];
    list = null;
  };
  for (const raw of source.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    const item = /^(?:[-•]\s+|(\d+)[.)]\s+)(.*)$/.exec(line);
    const photo = /^\[foto (\d+)\]$/i.exec(line);
    if (!line) flush();
    else if (line.startsWith('### ')) { flush(); out.push(`<h3>${inline(line.slice(4))}</h3>`); }
    else if (line.startsWith('## ')) { flush(); out.push(`<h2>${inline(line.slice(3))}</h2>`); }
    else if (line.startsWith('> ')) { flush(); out.push(`<blockquote><p>${inline(line.slice(2))}</p></blockquote>`); }
    else if (photo) {
      flush();
      const p = photos.get(Number(photo[1]));
      if (p) out.push(`<img class="article-photo" src="${photoUrl(p.id)}" alt="${escapeHtml(p.alt)}" loading="lazy" width="${p.width}" height="${p.height}">`);
    } else if (item) {
      const tag = item[1] ? 'ol' : 'ul';
      if (paragraph.length || (list && list.tag !== tag)) flush();
      list ??= { tag, items: [] };
      list.items.push(item[2]!);
    } else {
      if (list) flush();
      paragraph.push(line);
    }
  }
  flush();
  return out.join('\n');
}

export const readingMinutes = (body: string) => Math.max(1, Math.round(body.split(/\s+/).filter(Boolean).length / 200));

const byline = (s: Story) => `${dutchDate(s.publishedOn)} · ${readingMinutes(s.body)} min lezen`;

// The page of one story, in the shape of the stories that came with the site.
export function storyPage(s: Story): { meta: { title: string; description: string; imageUrl?: string }; body: string } {
  const cover = s.cover
    ? `\n        <img class="article-hero" src="${photoUrl(s.cover.id)}" alt="${escapeHtml(s.cover.alt)}" width="${s.cover.width}" height="${s.cover.height}">`
    : '';
  const body = `
    <section class="section">
      <article class="wrap narrow prose">
        <a class="back" href="/verhalen">← Alle verhalen</a>
        <h1>${escapeHtml(s.title)}</h1>
        <p class="muted small"><time datetime="${s.publishedOn}">${dutchDate(s.publishedOn)}</time> · Ronald, Gamer Xperience · ${readingMinutes(s.body)} min lezen</p>${cover}

${renderBody(s.body, s.photos)}

        {{> article-cta}}
      </article>
    </section>
`;
  return {
    meta: { title: `${s.title} | Gamer Xperience`, description: s.intro, ...(s.cover ? { imageUrl: photoUrl(s.cover.id) } : {}) },
    body,
  };
}

// The card of a story on the overview page.
export function storyCard(s: Story): string {
  const image = s.cover ? photoUrl(s.cover.id) : '/assets/img/nummer-1-game-feestje.webp';
  return `<a class="post-card" href="/verhalen/${s.slug}">
            <img src="${image}" alt="" loading="lazy" width="600" height="375">
            <div><p class="muted small">${byline(s)}</p><h2>${escapeHtml(s.title)}</h2><p>${escapeHtml(s.intro)}</p></div>
          </a>`;
}

// Puts the cards of new stories between the ones on the overview page, newest first.
export function addStoryCards(page: string, stories: Story[]): string {
  if (!stories.length) return page;
  return page.replace(/(<div class="posts">)([\s\S]*?)(\n\s*<\/div>\s*<\/div>\s*<\/section>)/, (_, open: string, inner: string, close: string) => {
    const cards = [...inner.matchAll(/<a class="post-card"[\s\S]*?<\/a>/g)].map((m) => ({ html: m[0], date: parseDutchDate(m[0]) ?? '0000-00-00' }));
    for (const s of stories) cards.push({ html: storyCard(s), date: s.publishedOn });
    // A stable sort: stories of the same day keep the order they had.
    cards.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return `${open}\n          ${cards.map((c) => c.html).join('\n          ')}${close}`;
  });
}

interface Row {
  id: number; slug: string | null; title: string; intro: string; body: string; published_on: string; cover_id: number | null;
}

export async function storyPhotos(db: Db, storyId: number): Promise<Map<number, StoryPhoto>> {
  const { rows } = await db.query<StoryPhoto>('SELECT id::int, width, height, alt FROM story_images WHERE story_id = $1 ORDER BY id', [storyId]);
  return new Map(rows.map((p) => [p.id, p]));
}

export function toStory(row: Row, photos: Map<number, StoryPhoto>): Story {
  return {
    slug: row.slug ?? '', title: row.title, intro: row.intro, body: row.body, publishedOn: row.published_on,
    cover: (row.cover_id && photos.get(row.cover_id)) || null, photos,
  };
}

export const STORY_COLUMNS = `id::int, slug, title, intro, body, to_char(published_on, 'YYYY-MM-DD') AS published_on, cover_id::int`;

// The stories that are on the website.
export async function publishedStories(db: Db): Promise<Story[]> {
  const { rows } = await db.query<Row>(`SELECT ${STORY_COLUMNS} FROM stories WHERE published AND slug IS NOT NULL ORDER BY published_on DESC, id DESC`);
  const stories: Story[] = [];
  for (const row of rows) stories.push(toStory(row, await storyPhotos(db, row.id)));
  return stories;
}
