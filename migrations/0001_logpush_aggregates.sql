-- Hourly traffic totals aggregated from Logpush files in R2.
-- dimension: 'pop' (key = Cloudflare colo IATA code) or 'country' (key = ISO 3166-1 alpha-2, '' when unknown).
CREATE TABLE traffic_hourly (
	dataset TEXT NOT NULL,
	dimension TEXT NOT NULL,
	hour INTEGER NOT NULL, -- unix seconds, start of the UTC hour
	key TEXT NOT NULL,
	value INTEGER NOT NULL,
	PRIMARY KEY (dataset, dimension, hour, key)
) WITHOUT ROWID;

-- One row per Logpush object that has been aggregated. Written in the same batch as the
-- aggregates, so each object is counted exactly once even with at-least-once queue delivery.
CREATE TABLE ingested_objects (
	key TEXT PRIMARY KEY,
	source TEXT NOT NULL,
	records INTEGER NOT NULL,
	ingested_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Time span covered per Logpush dataset (e.g. gateway_dns), used to decide when Logpush can
-- answer a query instead of the GraphQL Analytics API.
CREATE TABLE logpush_sources (
	source TEXT PRIMARY KEY,
	first_record INTEGER NOT NULL, -- unix seconds of the earliest record ingested
	last_record INTEGER NOT NULL,  -- unix seconds of the latest record ingested
	updated_at INTEGER NOT NULL
) WITHOUT ROWID;
