-- Which invoice a payment was registered for, so every paid invoice is counted exactly once,
-- also after an invoice was unlinked and linked again or a payment was removed by hand.
ALTER TABLE payments ADD COLUMN invoice_number TEXT;
UPDATE payments SET invoice_number = substring(note from '^Factuur (\S+) betaald$') WHERE actor = 'e-Boekhouden';
CREATE INDEX payments_invoice_number ON payments (invoice_number) WHERE invoice_number IS NOT NULL;
