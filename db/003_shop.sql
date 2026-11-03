-- Build packs, the drops that sell them, and the copies held while a buyer pays.

-- A pack: what she found and wrote up. The teaser is free to read; the body is what's sold.
CREATE TABLE IF NOT EXISTS packs (
  id          text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{3,32}$'),  -- 32 bytes max: the onchain receipt stores it
  title       text NOT NULL,
  blurb       text NOT NULL,
  teaser      text NOT NULL,                 -- markdown, free: the problem, the evidence, the whitespace check
  body        text NOT NULL,                 -- markdown, paid: plan, build prompt, tests, risks
  score       integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  lead_id     text,                          -- the research lead it came from
  hash        text NOT NULL,                 -- sha256 of the pack, for the onchain record
  onchain_tx  text,                          -- set once the hash is written onchain
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A drop: a few copies of one pack, on sale in a time window. A pack is only ever dropped once
-- ("I don't restock"); a cancelled drop doesn't count.
CREATE TABLE IF NOT EXISTS drops (
  id           text PRIMARY KEY,
  pack_id      text NOT NULL REFERENCES packs (id),
  copies       integer NOT NULL CHECK (copies BETWEEN 1 AND 100),
  opens_at     timestamptz NOT NULL,
  closes_at    timestamptz NOT NULL,
  cancelled_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (closes_at > opens_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS drops_one_per_pack ON drops (pack_id) WHERE cancelled_at IS NULL;

-- A copy set aside for a buyer who just shook hands, keyed by the signed offer's nonce.
-- It counts as taken until it is known to be unpaid (released_at set).
CREATE TABLE IF NOT EXISTS holds (
  nonce       text PRIMARY KEY,
  drop_id     text NOT NULL REFERENCES drops (id),
  price       bigint NOT NULL,
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  sold_at     timestamptz,
  released_at timestamptz
);
CREATE INDEX IF NOT EXISTS holds_by_drop ON holds (drop_id);

-- Small switches the admin dashboard sets (admin password hash, mail on or off).
CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value text NOT NULL
);
