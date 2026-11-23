-- How much of an invoice the bookkeeping reports as paid, so a payment is registered once.
ALTER TABLE invoices ADD COLUMN paid_cents INTEGER NOT NULL DEFAULT 0;
