import { createHash } from 'node:crypto';
import type { Db } from '../db/pool.js';

// What the owner changed on the website from the admin: pieces of text, and the photo strip.
//
// The page files in site/ hold the original wording. A piece of text is the content of one
// heading, paragraph, list item, button and so on. A change is stored by the original wording,
// so it keeps applying as long as that wording is still in the file.

export interface SiteContent {
  // file ("pages/index.html", "partials/footer.html") -> original wording -> new wording.
  texts: Map<string, Map<string, string>>;
  // The photo strip, replacing site/partials/gallery.html.
  gallery?: string;
}

export interface TextBlock {
  tag: string;
  original: string;
}

export const META_KEYS = ['@title', '@description'] as const;
export const textKey = (original: string) => createHash('sha256').update(original).digest('hex');

// Elements whose content counts as one piece of text...
const BLOCK = 'h[1-6]|p|li|summary|figcaption|legend|th|td|blockquote|dt|dd|button|label|a|span|small|strong|option';
// ...as long as none of these is inside it: then the pieces inside it are found instead.
const STRUCTURE =
  'p|li|ul|ol|h[1-6]|div|section|article|table|tr|td|th|thead|tbody|details|summary|form|fieldset|legend|input|select|textarea|option|button|label|img|picture|video|iframe|figure|figcaption|blockquote|nav|header|footer|script|style|svg|dl|dt|dd';
const WALK = new RegExp(
  `<(script|style|svg)\\b[\\s\\S]*?<\\/\\1>|<(${BLOCK})\\b([^>]*)>((?:(?!<\\/?(?:${STRUCTURE})\\b|<\\2\\b)[\\s\\S])*?)<\\/\\2>`,
  'g',
);

const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
// Text that a script fills in, or that holds a placeholder, is left alone.
const editable = (inner: string) => plain(inner) !== '' && !/\{\{|\sid=|<script/i.test(inner);

function walk(source: string, visit: (tag: string, inner: string) => string | undefined): string {
  return source.replace(WALK, (all, skipped: string | undefined, tag: string, attrs: string, inner: string) => {
    if (skipped || !editable(inner)) return all;
    const text = inner.trim();
    const next = visit(tag.toLowerCase(), text);
    if (next === undefined) return all;
    const lead = inner.slice(0, inner.length - inner.trimStart().length);
    const tail = inner.slice(inner.trimEnd().length);
    return `<${tag}${attrs}>${lead}${next}${tail}</${tag}>`;
  });
}

export function textBlocks(source: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  const seen = new Set<string>();
  walk(source, (tag, original) => {
    if (!seen.has(original)) blocks.push({ tag, original });
    seen.add(original);
    return undefined;
  });
  return blocks;
}

export function applyTexts(source: string, changes: Map<string, string> | undefined): string {
  if (!changes?.size) return source;
  return walk(source, (_tag, original) => changes.get(original));
}

const INLINE = new Set(['a', 'strong', 'b', 'em', 'i', 'u', 'span', 'br', 'small', 'sup', 'sub', 'time', 'mark']);
const SAFE_ATTR: Record<string, RegExp> = {
  href: /^(https?:\/\/|mailto:|tel:|\/|#)[^\s"<>]*$/i,
  class: /^[\w\s-]*$/,
  target: /^_blank$/,
  rel: /^[\w\s-]*$/,
  datetime: /^[\w:.+-]*$/,
};
const escapeText = (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\{\{/g, '{ {');

// Keeps the wording and simple mark-up (bold, links, a coloured word); everything else goes.
export function cleanText(html: string): string {
  const TAG = /<(\/?)([a-zA-Z][\w-]*)\b([^<>]*)>/g;
  let out = '';
  let last = 0;
  for (const m of html.replace(/<!--[\s\S]*?-->/g, '').matchAll(TAG)) {
    const source = m.input!;
    out += escapeText(source.slice(last, m.index));
    last = m.index! + m[0].length;
    const tag = m[2]!.toLowerCase();
    if (!INLINE.has(tag)) continue;
    if (m[1]) {
      if (tag !== 'br') out += `</${tag}>`;
      continue;
    }
    let attrs = '';
    for (const a of m[3]!.matchAll(/([\w-]+)(?:\s*=\s*"([^"]*)")?/g)) {
      const name = a[1]!.toLowerCase();
      // What the site's own scripts and screen readers go by stays as it was.
      if (/^(aria|data)-[\w-]+$/.test(name)) attrs += a[2] ? ` ${name}="${a[2]}"` : ` ${name}`;
      else if (a[2] !== undefined && SAFE_ATTR[name]?.test(a[2])) attrs += ` ${name}="${a[2]}"`;
    }
    out += `<${tag}${attrs}>`;
  }
  const rest = html.replace(/<!--[\s\S]*?-->/g, '');
  out += escapeText(rest.slice(last));
  return out.replace(/&nbsp;/g, ' ').replace(/[ \t\r\n]+/g, ' ').trim();
}

export interface SitePhoto {
  id: number;
  url: string;
  alt: string;
  width: number;
  height: number;
  hidden: boolean;
  own: boolean;
}

export async function listPhotos(db: Db): Promise<SitePhoto[]> {
  const { rows } = await db.query<{ id: number; src: string; alt: string; width: number; height: number; hidden: boolean }>(
    'SELECT id::int, src, alt, width, height, hidden FROM site_photos ORDER BY position, id',
  );
  return rows.map((r) => ({ id: r.id, url: r.src || `/api/site-photo/${r.id}`, alt: r.alt, width: r.width, height: r.height, hidden: r.hidden, own: !r.src }));
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function galleryHtml(photos: SitePhoto[]): string {
  const shown = photos.filter((p) => !p.hidden);
  if (!shown.length) return '';
  const images = shown.map((p) => `        <img src="${attr(p.url)}" alt="${attr(p.alt)}" loading="lazy" width="${p.width}" height="${p.height}">`);
  return `<section class="gallery-section" aria-label="Foto's van onze feestjes">\n      <div class="gallery">\n${images.join('\n')}\n      </div>\n    </section>\n`;
}

export async function loadSiteContent(db: Db): Promise<SiteContent> {
  const texts = new Map<string, Map<string, string>>();
  const { rows } = await db.query<{ file: string; original: string; replacement: string }>('SELECT file, original, replacement FROM site_texts');
  for (const r of rows) {
    if (!texts.has(r.file)) texts.set(r.file, new Map());
    texts.get(r.file)!.set(r.original, r.replacement);
  }
  return { texts, gallery: galleryHtml(await listPhotos(db)) };
}
