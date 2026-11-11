-- Contiguous coverage intervals per Logpush dataset: [start_hour, end_hour] (inclusive UTC
-- hour starts) built from the hours that actually contain ingested records. Unlike
-- logpush_sources' first_record/last_record endpoints, holes inside a span stay uncovered,
-- so a sparse or dead-lettered object can't make the whole span look ingested.
CREATE TABLE logpush_coverage (
	source TEXT NOT NULL,
	start_hour INTEGER NOT NULL, -- unix seconds, start of first covered UTC hour
	end_hour INTEGER NOT NULL,   -- unix seconds, start of last covered UTC hour (inclusive)
	PRIMARY KEY (source, start_hour)
) WITHOUT ROWID;
