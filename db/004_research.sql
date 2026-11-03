-- Her research notebook. Posts she read, the leads she grouped them into with every part of
-- the score, the checks before spending money, and what each model call cost.

CREATE TABLE IF NOT EXISTS posts (
  id         text PRIMARY KEY,               -- source:id, e.g. hn:41234567, gh:org/repo#12
  source     text NOT NULL CHECK (source IN ('hn', 'github')),
  url        text NOT NULL,
  title      text NOT NULL,
  excerpt    text NOT NULL,
  author     text NOT NULL,
  repo       text,                           -- github: the repo the issue is in
  engagement integer NOT NULL DEFAULT 0,     -- points + comments
  posted_at  timestamptz NOT NULL,
  seen_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_by_time ON posts (posted_at);

-- A lead: posts about the same missing tool. The id is its first post, so it stays put
-- between runs as new posts join it.
CREATE TABLE IF NOT EXISTS leads (
  id            text PRIMARY KEY,
  title         text NOT NULL,
  terms         text[] NOT NULL,
  post_ids      text[] NOT NULL,
  score         jsonb NOT NULL,              -- every component and its inputs, for the notebook
  total         integer NOT NULL,
  verdict       text NOT NULL CHECK (verdict IN ('IGNORE', 'WATCH', 'INVESTIGATE')),
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'investigated', 'skipped', 'packed', 'failed')),
  checks        jsonb,                       -- the coordinator's last answers
  investigation jsonb,                       -- what the web search found
  pack_id       text,
  first_seen    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS leads_by_total ON leads (total DESC);

-- Every paid model call, so the monthly cap is checked against what was really spent.
CREATE TABLE IF NOT EXISTS research_spend (
  id         bigserial PRIMARY KEY,
  lead_id    text,
  step       text NOT NULL,
  cost_usd   numeric(10, 4) NOT NULL,
  detail     jsonb,
  created_at timestamptz NOT NULL
);
