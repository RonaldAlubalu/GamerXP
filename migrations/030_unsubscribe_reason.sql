-- Why someone left the mailing list, when they chose to say so.
ALTER TABLE mail_contacts ADD COLUMN unsubscribe_reason TEXT NOT NULL DEFAULT '';
