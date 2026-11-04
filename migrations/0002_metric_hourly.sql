-- Hourly averaged measurements from Logpush (DEX HTTP test duration/failures, WARP handshake latency).
-- Stored as count + total so averages over any window are exact: AVG = SUM(total) / SUM(n).
CREATE TABLE metric_hourly (
	metric TEXT NOT NULL,
	dimension TEXT NOT NULL, -- 'pop' or 'country'
	hour INTEGER NOT NULL,
	key TEXT NOT NULL,
	n INTEGER NOT NULL,
	total REAL NOT NULL,
	PRIMARY KEY (metric, dimension, hour, key)
) WITHOUT ROWID;
