-- Drop emails with double opt-in. Only the server reads or writes these tables.
--
-- Tokens are never stored. Each link token is an HMAC of a random nonce under the server's key,
-- so the server can rebuild a link when it sends, but someone reading the database can't.
-- The *_hash columns (sha256 of the token) are only there to find the row when a link is used.
CREATE TABLE IF NOT EXISTS subscribers (
  email           text PRIMARY KEY,              -- lowercased
  created_at      timestamptz NOT NULL,
  confirmed       boolean NOT NULL DEFAULT false,
  confirmed_at    timestamptz,
  confirm_nonce   text,                          -- emptied once used
  confirm_hash    text UNIQUE,
  confirm_sent_at timestamptz,
  unsub_nonce     text NOT NULL,
  unsub_hash      text NOT NULL UNIQUE
);

-- Every email Lowball sends goes through here, so the daily cap covers all of it.
-- Unsubscribing deletes the subscriber, and the cascade deletes anything still queued for them.
CREATE TABLE IF NOT EXISTS outbox (
  id         bigserial PRIMARY KEY,
  email      text NOT NULL REFERENCES subscribers (email) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('confirm', 'drop')),
  drop_id    text NOT NULL DEFAULT '',           -- '' for confirmations
  drop_info  jsonb,                              -- what the drop email says, fixed when it was announced
  created_at timestamptz NOT NULL,
  claimed_at timestamptz,
  sent_at    timestamptz,
  attempts   integer NOT NULL DEFAULT 0,
  last_error text,
  UNIQUE (email, kind, drop_id)
);

CREATE INDEX IF NOT EXISTS outbox_waiting ON outbox (created_at) WHERE sent_at IS NULL;

-- How many emails went out on each UTC day, for the cap.
CREATE TABLE IF NOT EXISTS mail_days (
  day  date PRIMARY KEY,
  sent integer NOT NULL
);
