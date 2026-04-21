-- job_snapshots.count redefined: "number of postings that first appeared on this date"
-- (was: "API response count on this date"). Date basis is posted_at with fetched_at fallback.
-- Clearing old rows because they carry the old meaning; backfill replays job_postings_raw.

TRUNCATE TABLE job_snapshots;

INSERT INTO job_snapshots (date, source, segment, count)
SELECT
  COALESCE(posted_at, fetched_at)::date AS date,
  source,
  COALESCE(segment, '__unassigned__')    AS segment,
  COUNT(*)::int                          AS count
FROM job_postings_raw
GROUP BY 1, 2, 3;
