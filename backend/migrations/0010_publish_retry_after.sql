-- Apply once after 0005, before deploying the unified backend.
ALTER TABLE publish_jobs ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
