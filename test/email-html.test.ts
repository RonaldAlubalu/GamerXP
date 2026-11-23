import { describe, expect, it } from 'vitest';
import { renderEmailHtml } from '../src/lib/email-html.js';
import { withSignature } from '../src/lib/emails.js';

const look = { publicUrl: 'https://gamerxp.nl', reviewUrl: 'https://g.page/r/abc/review' };

describe('email in the look of the website', () => {
  it('turns status, payment and review links into buttons and keeps other links', () => {
    const html = renderEmailHtml(
      'Hoi Joyce,\n\nBetaal hier: https://gamerxp.nl/betalen/tok/aanbetaling\n\nVoorwaarden: https://gamerxp.nl/algemene-voorwaarden\n\nVolg de voortgang van je feest: https://gamerxp.nl/status?t=tok\n\nReview: https://g.page/r/abc/review',
      look,
    );
    expect(html).toContain('>Online betalen</a>');
    expect(html).toContain('>Volg je feest</a>');
    expect(html).toContain('>Schrijf een review</a>');
    expect(html).toContain('>gamerxp.nl/algemene-voorwaarden</a>');
    expect(html).not.toContain('Volg de voortgang van je feest:');
  });

  it('shows the booking details as a table and lists as lists', () => {
    const html = renderEmailHtml('Hoi,\n\nReferentie: GXP-ABC234\nPakket: Ultimate\nDatum: zaterdag 12 december\n\n- een\n- twee', look);
    expect(html).toMatch(/<td[^>]*>Referentie<\/td><td[^>]*>GXP-ABC234<\/td>/);
    expect(html).toContain('<li style="margin-bottom:4px">een</li>');
  });

  it('escapes what a customer or admin typed and styles the sign-off', () => {
    const html = renderEmailHtml(withSignature('Hoi <script>alert(1)</script> & co'), look);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; co');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Game on!</p>');
    expect(html).toContain('https://gamerxp.nl/assets/img/logo.png');
  });
});
