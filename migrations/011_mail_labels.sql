-- The label last put on a booking's emails in the mailbox, so they are relabelled when the stage changes.
ALTER TABLE bookings ADD COLUMN mail_label TEXT;
