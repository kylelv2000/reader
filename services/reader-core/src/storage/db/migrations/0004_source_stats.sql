-- Per-user source usage statistics, decoupled from the source JSON so that
-- shared/system sources never get copied into a user's namespace just to
-- track how well they work for that user.
CREATE TABLE IF NOT EXISTS source_stats (
    user_ns TEXT NOT NULL,
    source_url TEXT NOT NULL,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_streak INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_ns, source_url)
);
