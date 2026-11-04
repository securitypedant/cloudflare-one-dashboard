-- Logpush objects that could not be ingested: rejected by ingestion limits, or dead-lettered after
-- exhausting queue retries. Replay by re-uploading the object (see README "Replaying failed objects").
CREATE TABLE dead_letters (
	key TEXT PRIMARY KEY,
	reason TEXT NOT NULL,
	attempts INTEGER NOT NULL,
	received_at INTEGER NOT NULL
) WITHOUT ROWID;
