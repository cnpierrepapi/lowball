-- The mission moves to Solana developer tools: two new places to listen, the Solana forum and
-- the chain itself (failed transactions on popular programs, read from a public RPC).
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_source_check;
ALTER TABLE posts ADD CONSTRAINT posts_source_check CHECK (source IN ('hn', 'github', 'stackoverflow', 'reddit', 'devto', 'lobsters', 'forum', 'chain'));
