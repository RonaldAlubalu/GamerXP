# GamerXP

Self-hosted website and booking backend for [gamerxp.nl](https://gamerxp.nl): gaming LAN parties at home for kids' birthday parties (ages 6–14).

It replaces the website-builder site with one app you run yourself:

- **Public website** (Dutch): homepage with packages, FAQ and contact form, a booking page with live date availability, a privacy statement and a 404 page.
- **Booking backend**: party packages, an availability calendar with daily capacity, blocked dates, booking requests that can't be double-booked, and a contact form.
- **Email notifications**: the parent gets a confirmation of their request, you get notified of every new booking and message, and the parent is emailed again when you confirm or cancel.
- **Admin page** at `/admin`: manage bookings (confirm, cancel, complete, internal notes), blocked dates, contact messages and packages.

**Stack:** Node.js 22 + TypeScript, Fastify, PostgreSQL 16, Docker Compose, and Caddy (automatic HTTPS).

## Deploying to a VPS

You need a Linux VPS (for example Hetzner, TransIP or DigitalOcean; 1 vCPU and 1–2 GB RAM is plenty) with Docker installed.

1. **DNS:** point the `A` (and `AAAA`) records of `gamerxp.nl` and `www.gamerxp.nl` at the VPS IP address.
2. **Get the code and configure it:**
   ```sh
   git clone https://github.com/RonaldAlubalu/GamerXP.git && cd GamerXP
   cp .env.example .env
   nano .env   # set POSTGRES_PASSWORD, SMTP settings and OWNER_EMAIL
   ```
3. **Start it:**
   ```sh
   docker compose up -d --build
   ```
   Database migrations run automatically on startup. Caddy fetches an HTTPS certificate once DNS points to the server.
4. **Add the example packages** (optional; you can edit them in the admin page later):
   ```sh
   docker compose exec app npm run seed
   ```
5. **Create your admin login:**
   ```sh
   docker compose exec app npm run create-admin -- you@gamerxp.nl
   ```
   Then log in at `https://gamerxp.nl/admin`. Running the command again for the same email resets the password.

### Updating

```sh
git pull && docker compose up -d --build
```

### Email

Use the SMTP details of your mail provider (for example your domain's mailbox, Brevo, Postmark or Amazon SES). Until `SMTP_HOST` is set, emails are only written to the log (`docker compose logs app`). Set up SPF/DKIM for `gamerxp.nl` so mail doesn't land in spam.

### Backups

The `backup` service writes a compressed database dump to `./backups` every day and keeps the last 14 days (`BACKUP_KEEP_DAYS`). **Copy these off the server too**, for example with your VPS provider's backup feature or `rclone`. To restore a dump:

```sh
gunzip -c backups/gamerxp-YYYY-MM-DD_HHMM.sql.gz | docker compose exec -T db psql -U gamerxp gamerxp
```

## Configuration

All settings live in `.env`; see [`.env.example`](.env.example). The most important ones:

| Variable | Meaning |
| --- | --- |
| `DAILY_CAPACITY` | How many parties can take place on the same day (how many setups you own). Default `1`. |
| `MIN_LEAD_DAYS` | Minimum number of days between booking and party. Default `3`. |
| `MAX_ADVANCE_DAYS` | How far ahead parents can book. Default `365`. |
| `OWNER_EMAIL` | Receives new-booking and contact notifications. |

## How bookings work

1. A parent picks a package and a date on `/boeken`. Dates that are blocked or fully booked are flagged straight away.
2. The booking is saved as **Aanvraag** (pending) and counts toward that day's capacity right away. A per-date database lock makes sure two parents can never grab the last slot at the same time.
3. You review it in `/admin` and click **Bevestigen** (confirmed) or **Annuleren** (cancelled). You choose whether the parent gets an email. A cancelled booking frees up the date again.
4. After the party, mark it **Afgerond** (completed).

## Development

Requires Node.js 22 and a local PostgreSQL.

```sh
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/gamerxp_dev
npm run seed:dev
npm run create-admin:dev -- you@example.com
npm run dev          # http://localhost:3000
```

Tests run against a real PostgreSQL database. The test database is wiped on every run, so use a dedicated one:

```sh
createdb gamerxp_test
DATABASE_URL=postgres://user:pass@localhost:5432/gamerxp_test npm test
npm run typecheck
```

### Project layout

```
src/
  server.ts            entry point (runs migrations, starts the server)
  app.ts               Fastify app: security headers, error handling, static files
  config.ts            environment variables (validated)
  routes/public.ts     /api/packages, /api/availability, /api/bookings, /api/contact
  routes/admin/        /api/admin/* (login/sessions, bookings, packages, dates, messages)
  services/            booking and availability logic
  lib/                 auth, email, dates, validation schemas
  scripts/             create-admin, seed
migrations/            SQL migrations, applied in filename order
public/                website (HTML/CSS/JS) and admin page
deploy/                Caddyfile and backup script
```

To change the schema, add a new file such as `migrations/002_something.sql`. Never edit a migration that has already run in production.

## Moving over from the website builder

1. Deploy on the VPS and test it using the server's IP address or a temporary subdomain (for example set `DOMAIN=nieuw.gamerxp.nl`).
2. Copy your real texts, photos (put them in `public/assets/`), prices and FAQ from the old site into `public/index.html` and the packages in the admin page.
3. Fill in the placeholders in `public/privacy.html` (company name, KvK number, address, retention period).
4. Re-enter any open bookings from the old site via the admin page, or ask the parents to book again.
5. Lower the DNS TTL a day in advance, then switch the DNS records to the VPS and set `DOMAIN=gamerxp.nl`.
6. Cancel the website-builder subscription once everything works. If your domain is registered through the builder, transfer it to a registrar first.

## Privacy (AVG/GDPR)

The site stores personal data of parents and the first name and age of children. It sets no tracking cookies and logs no form contents. Admin passwords are hashed with bcrypt, and only hashes of session tokens are stored. Remember to:

- finish the privacy statement,
- sign a data processing agreement (verwerkersovereenkomst) with your VPS and email providers,
- delete old bookings once the retention period has passed.
