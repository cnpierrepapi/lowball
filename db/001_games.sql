-- Games the shopkeeper offers mid-haggle. One row per game. The row is what makes a game
-- single use: Start only works while started_at is empty, Finish only while finished_at is.
-- The seed stays here until Start, so the browser can't see the game before the clock runs.
CREATE TABLE IF NOT EXISTS games (
  id          uuid PRIMARY KEY,
  haggle      uuid NOT NULL,          -- the haggle it was offered in
  kind        text NOT NULL CHECK (kind IN ('snake', 'stack')),
  seed        char(32) NOT NULL,      -- 128 random bits, hex
  offered_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz,
  score       integer,                -- worked out by the server's replay, never sent by the browser
  outcome     text                    -- scored, bad_log, too_fast
);

CREATE INDEX IF NOT EXISTS games_haggle ON games (haggle);
