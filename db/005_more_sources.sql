-- More places to listen, and cross-checking. Posts can now come from six sources, and a post
-- the cross-check found for a lead is remembered on that lead (cross_ids), so it stays attached
-- between runs.
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_source_check;
ALTER TABLE posts ADD CONSTRAINT posts_source_check CHECK (source IN ('hn', 'github', 'stackoverflow', 'reddit', 'devto', 'lobsters'));
ALTER TABLE posts ADD COLUMN IF NOT EXISTS found_by text NOT NULL DEFAULT 'watch';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS cross_ids text[] NOT NULL DEFAULT '{}';
