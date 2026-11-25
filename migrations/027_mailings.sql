-- A mailing to (earlier) customers: the people it can go to, the mailings themselves and who got
-- which one. Someone who unsubscribes gets no further mailing.
CREATE TABLE mail_contacts (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL UNIQUE,
  unsubscribed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mail_contacts_email ON mail_contacts (lower(email));

CREATE TABLE mailings (
  id BIGSERIAL PRIMARY KEY,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE mailing_recipients (
  mailing_id BIGINT NOT NULL REFERENCES mailings(id) ON DELETE CASCADE,
  contact_id BIGINT NOT NULL REFERENCES mail_contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  sent_at TIMESTAMPTZ,
  PRIMARY KEY (mailing_id, contact_id)
);
