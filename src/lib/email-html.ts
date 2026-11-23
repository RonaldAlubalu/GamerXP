// Turns the plain text of an email into a version in the look of the website:
// logo on a dark header, the booking details in a table, and links as buttons.
// The plain text is still sent along for mail programs that prefer it.

const NAVY = '#070b1f';
const GREEN = '#52cc18';
const CYAN = '#0de8fb';
const PINK = '#f60383';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const URL_RE = /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)]/g;

export interface EmailLook {
  publicUrl: string;
  reviewUrl?: string;
}

// The label of the button a link becomes, or undefined for an ordinary link.
function buttonLabel(url: string, look: EmailLook): string | undefined {
  if (url.startsWith(`${look.publicUrl}/betalen/`)) return 'Online betalen';
  if (url.startsWith(`${look.publicUrl}/status`)) return 'Volg je feest';
  if (look.reviewUrl && url === look.reviewUrl) return 'Schrijf een review';
  return undefined;
}

const button = (url: string, label: string) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 18px"><tr><td style="background:${GREEN};border-radius:999px">` +
  `<a href="${esc(url)}" style="display:inline-block;padding:12px 26px;font:700 15px Arial,Helvetica,sans-serif;color:${NAVY};text-decoration:none">${label}</a></td></tr></table>`;

const link = (url: string) => `<a href="${esc(url)}" style="color:#0a7d8c">${esc(url.replace(/^https?:\/\//, ''))}</a>`;

// One paragraph of text: links become buttons (on their own line) or ordinary links.
function paragraph(text: string, look: EmailLook): string {
  const buttons: string[] = [];
  let html = '';
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0];
    html += esc(text.slice(last, match.index));
    const label = buttonLabel(url, look);
    if (label) buttons.push(button(url, label));
    else html += link(url);
    last = match.index + url.length;
  }
  html += esc(text.slice(last));
  // "Volg de voortgang van je feest: " reads oddly without its link; the button says it.
  html = html.replace(/[^.!?\n]*:\s*$/, (tail) => (buttons.length ? '' : tail)).trim();
  const lines = html ? `<p style="margin:0 0 16px">${html.replace(/\n/g, '<br>')}</p>` : '';
  return lines + buttons.join('');
}

// "Referentie: GXP-…" style lines become a small table.
function details(lines: string[]): string {
  const rows = lines
    .map((line) => {
      const i = line.indexOf(': ');
      return (
        `<tr><td style="padding:6px 14px 6px 0;color:#5b6478;white-space:nowrap;vertical-align:top">${esc(line.slice(0, i))}</td>` +
        `<td style="padding:6px 0;font-weight:600">${esc(line.slice(i + 2))}</td></tr>`
      );
    })
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 18px;padding:10px 16px;background:#f3f6fb;border-left:4px solid ${GREEN};border-radius:6px;width:100%;font-size:15px">${rows}</table>`;
}

const isDetailLine = (line: string) => /^[A-ZÀ-Ü][\wÀ-ü' -]{1,28}: \S/.test(line) && !/https?:\/\//.test(line.split(': ')[0]!);

export function renderEmailHtml(text: string, look: EmailLook): string {
  // The sign-off at the end gets its own look.
  const signAt = text.lastIndexOf('\n\nGame on!');
  const main = signAt === -1 ? text : text.slice(0, signAt);

  const body = main
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n');
      const detailLines = lines.filter(isDetailLine);
      if (detailLines.length >= 3 && detailLines.length === lines.length) return details(lines);
      // A bulleted list.
      if (lines.every((l) => l.startsWith('- '))) {
        return `<ul style="margin:0 0 16px;padding-left:20px">${lines.map((l) => `<li style="margin-bottom:4px">${paragraph(l.slice(2), look).replace(/^<p[^>]*>|<\/p>$/g, '')}</li>`).join('')}</ul>`;
      }
      return paragraph(block, look);
    })
    .join('\n');

  const signature =
    signAt === -1
      ? ''
      : `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px;border-top:1px solid #e3e8f0;padding-top:16px;width:100%"><tr><td>` +
        `<p style="margin:0 0 6px;font:700 17px Arial,Helvetica,sans-serif;color:${PINK}">Game on!</p>` +
        `<p style="margin:0;color:#1c2233"><strong>Ronald</strong><br>Gamer Xperience</p></td></tr></table>`;

  return `<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#eef1f6">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#eef1f6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden">
<tr><td align="center" style="background:${NAVY};padding:22px 20px;border-bottom:3px solid ${GREEN}">
<a href="${esc(look.publicUrl)}" style="text-decoration:none"><img src="${esc(look.publicUrl)}/assets/img/logo.png" alt="Gamer Xperience" width="84" style="display:block;border:0;margin:0 auto 6px"></a>
<div style="font:700 13px Arial,Helvetica,sans-serif;letter-spacing:.08em;color:${CYAN};text-transform:uppercase">Het ultieme gamefeestje bij jou thuis</div>
</td></tr>
<tr><td style="padding:28px 28px 26px;font:16px/1.6 Arial,Helvetica,sans-serif;color:#1c2233">
${body}
${signature}
</td></tr>
<tr><td align="center" style="background:${NAVY};padding:18px 20px;font:13px/1.6 Arial,Helvetica,sans-serif;color:#aab3c8">
<a href="mailto:contact@gamerxp.nl" style="color:${CYAN};text-decoration:none">contact@gamerxp.nl</a> &nbsp;·&nbsp;
<a href="https://wa.me/31634206753" style="color:${CYAN};text-decoration:none">+31 (0)6 3420 6753</a> &nbsp;·&nbsp;
<a href="${esc(look.publicUrl)}" style="color:${CYAN};text-decoration:none">gamerxp.nl</a>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}
