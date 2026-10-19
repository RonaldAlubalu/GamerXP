# Gamer Xperience

Self-hosted website and booking system for [gamerxp.nl](https://gamerxp.nl): gaming parties at home (kids' birthdays, 6–14) and gaming events on location.

It replaces the Squarespace site with one app you run yourself:

- **Website** (`site/`): all pages of the old site with the same URLs, text and photos, in the Gamer Xperience style. It also serves a sitemap, robots.txt and redirects for old links.
- **Booking form** (`/reserveer`): visitors pick a package and extra stations, then choose a date and time slot from a calendar that only shows what's still free. The chosen slot is reserved straight away.
- **Admin** (`/admin`): everything to run the business.
  - **Pipeline:** every booking as a card per phase. Each card shows whose turn it is, the payment status and checklist progress, and the top of the page shows what needs your attention.
  - **Booking page:** customer details and planning, price calculation, payments, agreements, the conversation (send emails, log WhatsApp and calls), checklist, Google review and a timeline.
  - **Agenda:** month view of booked, free and closed time slots.
  - **Berichten:** contact form messages as conversations you can answer.
  - **Reviews:** who still needs to be asked for a Google review.
  - **Beschikbaarheid:** weekly schedule per time slot, slot hours, capacity, blocked days and exceptions.
  - **Pakketten:** packages and prices.
  - **Theme:** a light or dark admin theme.
- **Parent status page** (`/status`): a private link in every email where parents follow their party's progress.

**Stack:** Node.js 22 + TypeScript, Fastify, PostgreSQL 16, Docker Compose, and Caddy (automatic HTTPS). There are no third-party scripts, fonts or cookies on the website.

## Deploying to a VPS

You need a Linux VPS (for example Hetzner, TransIP or DigitalOcean; 1 vCPU and 1–2 GB RAM is plenty) with Docker installed.

1. **DNS:** point the `A` (and `AAAA`) records of `gamerxp.nl` and `www.gamerxp.nl` at the VPS IP address.
2. **Get the code and configure it:**
   ```sh
   git clone https://github.com/RonaldAlubalu/GamerXP.git && cd GamerXP
   cp .env.example .env
   nano .env   # set POSTGRES_PASSWORD, SMTP settings, OWNER_EMAIL, GOOGLE_REVIEW_URL
   ```
3. **Start it:**
   ```sh
   docker compose up -d --build
   ```
   Database migrations run automatically on startup and create the Standaard (€275) and Ultimate (€350) packages. Caddy fetches an HTTPS certificate once DNS points to the server.
4. **Create your admin login:**
   ```sh
   docker compose exec app npm run create-admin -- ronald@gamerxp.nl
   ```
   Then log in at `https://gamerxp.nl/admin`. Running the command again for the same email resets the password.
5. **Set your availability** in the admin under *Beschikbaarheid*. The starting schedule is a guess: Wednesday afternoon, Friday afternoon and evening, and all day at the weekend.

### Updating

```sh
git pull && docker compose up -d --build
```

### Email

Use the SMTP details of your mail provider (for example the mailbox of contact@gamerxp.nl, Brevo, Postmark or Amazon SES). Until `SMTP_HOST` is set, emails are only written to the log (`docker compose logs app`) and the admin shows a warning. Set up SPF/DKIM for `gamerxp.nl` so mail doesn't land in spam.

Emails you send from the admin come from `MAIL_FROM`. Customers' replies land in that mailbox. Log important replies on the booking ("WhatsApp / telefoon vastleggen", channel *E-mail*) so the conversation stays complete and "whose turn" stays correct.

### Backups

The `backup` service writes a compressed database dump to `./backups` every day and keeps the last 14 days (`BACKUP_KEEP_DAYS`). **Copy these off the server too**, for example with your VPS provider's backup feature or `rclone`. To restore a dump:

```sh
gunzip -c backups/gamerxp-YYYY-MM-DD_HHMM.sql.gz | docker compose exec -T db psql -U gamerxp gamerxp
```

## Configuration

Server settings live in `.env` (see [`.env.example`](.env.example)). Availability (schedule, slot hours, capacity, booking window) is set in the admin page instead.

| Variable | Meaning |
| --- | --- |
| `OWNER_EMAIL` | Receives notifications of new bookings and contact messages. |
| `GOOGLE_REVIEW_URL` | Your Google review link (Google Business Profile → "Ask for reviews"). Enables one-click review requests. |
| `PAYMENT_INFO` | Optional payment instructions (e.g. IBAN) added to the confirmation email. |
| `DEPOSIT_CENTS` | Deposit asked on confirmation. Default `10000` (€100). |
| `EXTRA_STATION_CENTS` | Price per extra game station. Default `2500` (€25). |
| `TRAVEL_CENTS_PER_KM` / `TRAVEL_MAX_CENTS` | Travel costs per km of the round trip and the maximum. Defaults: €0.50 and €100. |
| `EVENING_SURCHARGE_CENTS` | Evening surcharge (party ends after 19:30). Default `5000` (€50). |
| `BASE_LOCATION` | Where the bus leaves from, for distance calculation. Default `5611AB Eindhoven`; set your own postcode. |

## How a booking flows

1. A parent books on `/reserveer`: package, extra stations, date and time slot (only free slots are shown), address and optional details. The slot is reserved immediately, the parent gets a confirmation with a link to their status page, and you get an email.
2. The driving distance from `BASE_LOCATION` is looked up automatically. It uses PDOK (the Dutch government address service) and OSRM routing, both free. The travel costs then appear in the price. For Belgian addresses or if the lookup fails, enter the km yourself on the booking.
3. In the admin the booking starts in **Nieuw** with *Jouw beurt*. Every message you send makes it *Wacht op klant*, and every customer message you log makes it *Jouw beurt*. You can also change this by hand.
4. Move it through the phases: **Nieuw → Contact opgenomen → Bevestigd → Aanbetaling ontvangen → Ingepland → Feest geweest → Afgerond**. Moving to *Bevestigd*, *Aanbetaling ontvangen*, *Afgerond* or *Geannuleerd* offers to email the parent. The confirmation asks for the €100 deposit within 5 days, as in the terms and conditions.
5. Register payments (deposit, payments, borg received/returned) on the booking. The admin shows whether the deposit is paid and what is still outstanding.
6. Each phase has a checklist based on the terms and conditions (travel costs, evening surcharge, games updated 48 hours before, borg for Standaard, and so on). You can add your own tasks.
7. After the party, *Afgerond* sends a thank-you with the Google review link. The *Reviews* page shows who still needs asking.

## Editing the website

Pages are HTML files in `site/pages/`: `index.html` is the homepage and `verhalen/foo.html` is `/verhalen/foo`. Each page starts with a comment holding its title and description:

```html
<!--{"title": "Pakketten en prijzen | Gamer Xperience", "description": "..."}-->
<section class="section">...</section>
```

Shared parts are in `site/partials/` and included with `{{> name}}`: the header, footer, reviews, FAQ, packages, photo gallery and call-to-action. The layout around every page is `site/layout.html`. Images go in `public/assets/img/` and styles in `public/assets/styles.css`. Old URLs that moved are listed in `site/redirects.json`.

In development (`npm run dev`) page edits show up on refresh without a restart. A new blog post is a new file in `site/pages/verhalen/` plus a card in `site/pages/verhalen.html`.

## Development

Requires Node.js 22 and a local PostgreSQL.

```sh
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/gamerxp_dev
npm run create-admin:dev -- you@example.com
npm run dev          # http://localhost:3000
```

Tests run against a real PostgreSQL database. The test database is wiped on every run, so use a dedicated one. Tests never call the distance service; it is replaced by a stub.

```sh
createdb gamerxp_test
DATABASE_URL=postgres://user:pass@localhost:5432/gamerxp_test npm test
npm run typecheck
```

### Project layout

```
site/                  website pages, partials, layout and redirects
public/                assets (styles, scripts, images, fonts) and the admin app
src/
  server.ts            entry point (runs migrations, starts the server)
  app.ts               Fastify app: security headers, error handling, static files
  site.ts              renders site/ pages, sitemap.xml and robots.txt
  config.ts            environment variables (validated)
  routes/public.ts     /api/packages, /availability, /bookings, /quote, /status, /contact
  routes/admin/        /api/admin/* (login, bookings, messages, availability, packages)
  services/            availability, bookings, pipeline, pricing, distance, communications
  lib/                 auth, email templates, dates, validation schemas
  scripts/             create-admin
migrations/            SQL migrations, applied in filename order
deploy/                Caddyfile and backup script
```

To change the database, add a new file such as `migrations/006_something.sql`. Never edit a migration that has already run in production.

## Moving over from Squarespace

1. Deploy on the VPS and test it using a temporary subdomain (for example set `DOMAIN=nieuw.gamerxp.nl` and `PUBLIC_URL=https://nieuw.gamerxp.nl`).
2. Check the texts. A few things to review:
   - The booking page says all Fridays are fully booked until January. Close Fridays in *Beschikbaarheid* or remove that line from `site/pages/reserveer.html`.
   - On the old site the FAQ said "€31,25 per kind" for €275 and 8 children. The new site says €34,38, which is the correct amount. The city pages used older FAQ copy (e.g. "€250 voor 3 uur") and now share the corrected homepage FAQ.
   - The English page keeps its own text as it was.
3. Fill in the placeholders in `site/pages/privacy.html` (retention period, address).
4. Re-enter open bookings from Squarespace via the website form or ask the parents to book again, then set their phase in the admin.
5. Lower the DNS TTL a day in advance, then switch the DNS records to the VPS and set `DOMAIN=gamerxp.nl`.
6. Cancel Squarespace once everything works. If your domain is registered through Squarespace, transfer it to a registrar first.

## Privacy (AVG/GDPR)

The system stores personal data of parents and, if they fill it in, the first name and age of the birthday child. The website sets no tracking cookies and loads nothing from third parties. Only the postcode and city are sent to PDOK and OSRM for the distance. Admin passwords are hashed with bcrypt, and only hashes of session tokens are stored. Remember to:

- finish the privacy statement,
- sign a data processing agreement (verwerkersovereenkomst) with your VPS and email providers,
- delete old bookings once the retention period has passed.
