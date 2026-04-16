import { sql } from './index.ts'
import type {
  JobPostingRawInsert,
  JobSnapshotRow,
  ReportRunRow,
  Source,
  TagHistoryRow,
} from './types.ts'

// `as unknown as T` casts below are needed because the Neon HTTP driver
// returns Record<string, unknown>[] for raw SELECTs; each SELECT's projection
// is manually kept in sync with the target row type declared in ./types.ts.

export async function insertRawJobs(rows: JobPostingRawInsert[]): Promise<number> {
  if (rows.length === 0) return 0
  let inserted = 0
  for (const r of rows) {
    const result = await sql`
      INSERT INTO job_postings_raw (
        source, external_id, fetched_at, posted_at,
        title, company, location, remote, tags, segment, raw_json
      )
      VALUES (
        ${r.source}, ${r.external_id}, ${r.fetched_at}, ${r.posted_at ?? null},
        ${r.title}, ${r.company ?? null}, ${r.location ?? null},
        ${r.remote ?? null}, ${r.tags ?? null}, ${r.segment ?? null},
        ${JSON.stringify(r.raw_json)}::jsonb
      )
      ON CONFLICT (source, external_id) DO NOTHING
      RETURNING id
    `
    inserted += result.length
  }
  return inserted
}

export async function upsertSnapshots(rows: JobSnapshotRow[]): Promise<void> {
  for (const r of rows) {
    await sql`
      INSERT INTO job_snapshots (date, source, segment, count)
      VALUES (${r.date}, ${r.source}, ${r.segment}, ${r.count})
      ON CONFLICT (date, source, segment) DO UPDATE
        SET count = EXCLUDED.count
    `
  }
}

export async function getSnapshotsInRange(
  startDate: string,
  endDate: string,
): Promise<JobSnapshotRow[]> {
  const rows = await sql`
    SELECT date::text AS date, source, segment, count
    FROM job_snapshots
    WHERE date >= ${startDate} AND date <= ${endDate}
    ORDER BY date ASC
  `
  return rows as unknown as JobSnapshotRow[]
}

export async function upsertTagHistory(
  tag: string,
  seenOn: string,
  countDelta: number,
): Promise<void> {
  await sql`
    INSERT INTO tag_history (tag, first_seen, last_seen, total_count)
    VALUES (${tag}, ${seenOn}, ${seenOn}, ${countDelta})
    ON CONFLICT (tag) DO UPDATE
      SET last_seen = GREATEST(tag_history.last_seen, EXCLUDED.last_seen),
          total_count = tag_history.total_count + EXCLUDED.total_count
  `
}

export async function getNewTagsSince(since: string, minCount: number): Promise<TagHistoryRow[]> {
  const rows = await sql`
    SELECT tag, first_seen::text AS first_seen, last_seen::text AS last_seen, total_count
    FROM tag_history
    WHERE first_seen >= ${since} AND total_count >= ${minCount}
    ORDER BY total_count DESC
  `
  return rows as unknown as TagHistoryRow[]
}

export async function findReportRun(weekStart: string): Promise<ReportRunRow | null> {
  const rows = await sql`
    SELECT id, week_start::text AS week_start, generated_at, sent, payload, insight_cost
    FROM report_runs
    WHERE week_start = ${weekStart}
    LIMIT 1
  `
  return (rows[0] as unknown as ReportRunRow) ?? null
}

export async function upsertReportRun(row: {
  week_start: string
  payload: unknown
  sent: boolean
  insight_cost: number | null
}): Promise<void> {
  await sql`
    INSERT INTO report_runs (week_start, payload, sent, insight_cost)
    VALUES (${row.week_start}, ${JSON.stringify(row.payload)}::jsonb, ${row.sent}, ${row.insight_cost})
    ON CONFLICT (week_start) DO UPDATE
      SET payload = EXCLUDED.payload,
          sent = EXCLUDED.sent,
          insight_cost = EXCLUDED.insight_cost,
          generated_at = now()
  `
}

export async function countPostingsPerSegment(
  date: string,
): Promise<Array<{ source: Source; segment: string; count: number }>> {
  const rows = await sql`
    SELECT source, COALESCE(segment, '__unassigned__') AS segment, COUNT(*)::int AS count
    FROM job_postings_raw
    WHERE fetched_at::date = ${date}
    GROUP BY source, COALESCE(segment, '__unassigned__')
  `
  return rows as unknown as Array<{ source: Source; segment: string; count: number }>
}
