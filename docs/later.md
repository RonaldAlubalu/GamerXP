# For later

Ideas the owner wants kept, not planned or started.

## Reusing the backend for other businesses (noted 25 November 2026)

The booking system could serve other businesses, each with their own branding.

- The engine is reusable: pipeline, checklist, payments and invoices, inventory, messages, users,
  backups, deploy. Prices and rules are already settings (`src/config.ts`).
- Tied to Gamer Xperience today: the name, "Eindhoven" and "Ronald" in mail texts, invoices and
  notifications (about 70 places outside the public site), the checklist tasks, the console
  fields in the inventory, the hand-written public pages, Dutch only, and the fixed ledger code
  and invoice template for e-Boekhouden.
- Realistic route: one installation per business (own folder and database on the server), with a
  "Branding" settings page for name, logo, colours, contact details, mail signature and checklist,
  and the public pages as a template. Rough estimate: one to two weeks of building.
- Not advised as a first step: one platform where businesses sign up themselves. That needs
  per-business separation in every table, sign-up, billing and support.
- Open question: which kind of business would be second. The closer to "parties at a customer's
  address", the more carries over unchanged.
