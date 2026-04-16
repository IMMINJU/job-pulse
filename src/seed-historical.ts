import { loadConfig } from './config.ts'
import { adzuna } from './collectors/adzuna.ts'
import { jsearch } from './collectors/jsearch.ts'
import { hn } from './collectors/hn.ts'
import { insertRawJobs, upsertSnapshots } from './db/queries.ts'
import type { JobPostingRawInsert, JobSnapshotRow, Source } from './db/types.ts'
import { UNASSIGNED_SEGMENT } from './db/types.ts'
import type { RawJob } from './collectors/index.ts'

const cfg = loadConfig()

function toInsert(j: RawJob, fetchedAt: Date): JobPostingRawInsert {
  return {
    source: j.source,
    external_id: j.externalId,
    fetched_at: fetchedAt,
    posted_at: j.postedAt ?? null,
    title: j.title,
    company: j.company ?? null,
    location: j.location ?? null,
    remote: j.remote ?? null,
    tags: j.tags ?? null,
    segment: j.segment ?? null,
    raw_json: j.raw,
  }
}

function buildSnapshots(jobs: RawJob[], date: string): JobSnapshotRow[] {
  const counts = new Map<string, number>()
  for (const j of jobs) {
    const seg = j.segment ?? UNASSIGNED_SEGMENT
    const key = `${j.source}\u0001${seg}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const rows: JobSnapshotRow[] = []
  for (const [key, count] of counts) {
    const [source, segment] = key.split('\u0001') as [Source, string]
    rows.push({ date, source, segment, count })
  }
  return rows
}

async function seedDate(label: string, date: string, fetchedAt: Date, collectors: Array<{ name: string; fn: () => Promise<RawJob[]> }>) {
  for (const c of collectors) {
    try {
      const jobs = await c.fn()
      const inserts = jobs.map((j) => toInsert(j, fetchedAt))
      const inserted = await insertRawJobs(inserts)
      await upsertSnapshots(buildSnapshots(jobs, date))
      console.log(`[${label}][${c.name}] fetched=${jobs.length} inserted=${inserted}`)
    } catch (err) {
      console.error(`[${label}][${c.name}] failed:`, err instanceof Error ? err.message : err)
    }
  }
}

async function main() {
  const countries = cfg.collectors.adzuna.countries
  const segments = cfg.segments

  // 3 weekly seed dates (Mon)
  const weeks = [
    { label: 'week-0401', date: '2026-04-01', fetchedAt: new Date('2026-04-01T02:00:00Z') },
    { label: 'week-0407', date: '2026-04-07', fetchedAt: new Date('2026-04-07T02:00:00Z') },
    { label: 'week-0414', date: '2026-04-14', fetchedAt: new Date('2026-04-14T02:00:00Z') },
  ]

  for (const week of weeks) {
    console.log(`\n=== ${week.label} (${week.date}) ===`)
    await seedDate(week.label, week.date, week.fetchedAt, [
      {
        name: 'adzuna',
        fn: () => adzuna.collect({ segments, countries, now: week.fetchedAt }),
      },
      {
        name: 'jsearch',
        fn: () => jsearch.collect({ segments, now: week.fetchedAt }),
      },
    ])
  }

  // HN March thread — seed as 2026-03-02
  console.log('\n=== HN March 2026 ===')
  const marchDate = '2026-03-02'
  const marchFetched = new Date('2026-03-02T02:00:00Z')
  // Override the thread search: hn.collect will find the latest "Who is hiring?" thread.
  // Since March thread (47219668) is within 45 days of marchFetched, it should be picked up.
  // But our `now` is marchFetched which is March 2 — the thread was posted March 2, so age=0 → OK.
  try {
    const jobs = await hn.collect({ segments, now: marchFetched })
    const inserts = jobs.map((j) => toInsert(j, marchFetched))
    const inserted = await insertRawJobs(inserts)
    await upsertSnapshots(buildSnapshots(jobs, marchDate))
    console.log(`[hn-march] fetched=${jobs.length} inserted=${inserted}`)
  } catch (err) {
    console.error('[hn-march] failed:', err instanceof Error ? err.message : err)
  }

  console.log('\ndone')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
