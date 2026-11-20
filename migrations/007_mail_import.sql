-- Emails imported from the mailbox. The Message-ID keeps an email from being imported twice.
ALTER TABLE communications ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX communications_external_id_idx ON communications (external_id) WHERE external_id IS NOT NULL;
