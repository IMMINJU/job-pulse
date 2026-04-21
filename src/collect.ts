import { parseArgs } from 'node:util'
import { loadConfig, shouldRunToday, type CollectorName } from './config.ts'
import type { Collector, RawJob } from './collectors/index.ts'
import { remotive } from './collectors/remotive.ts'
// import { arbeitnow } from './collectors/arbeitnow.ts' // disabled: 개발자 공고 12%, API 필터 미지원
import { adzuna } from './collectors/adzuna.ts'
import { jsearch } from './collectors/jsearch.ts'
import { hn } from './collectors/hn.ts'
import { insertRawJobs, upsertSnapshots } from './db/queries.ts'
import type { InsertedRawRef, JobPostingRawInsert, JobSnapshotRow } from './db/types.ts'
import { UNASSIGNED_SEGMENT } from './db/types.ts'
import { notifyFailure } from './notifier/failure.ts'

const REGISTRY: Partial<Record<CollectorName, Collector>> = {
  remotive,
  // arbeitnow, // disabled
  adzuna,
  jsearch,
  hn_who_is_hiring: hn,
}

function toInsert(j: RawJob, now: Date): JobPostingRawInsert {
  return {
    source: j.source,
    external_id: j.externalId,
    fetched_at: now,
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

// Snapshots count *new* postings per (posted_at date, source, segment). posted_at
// anchors the row to when the job was listed, not when our cron happened to run.
function buildSnapshots(inserted: InsertedRawRef[]): JobSnapshotRow[] {
  const rows: JobSnapshotRow[] = []
  for (const r of inserted) {
    const anchor = r.posted_at ?? r.fetched_at
    const date = anchor.toISOString().slice(0, 10)
    const segment = r.segment ?? UNASSIGNED_SEGMENT
    const existing = rows.find(
      (x) => x.date === date && x.source === r.source && x.segment === segment,
    )
    if (existing) existing.count += 1
    else rows.push({ date, source: r.source, segment, count: 1 })
  }
  return rows
}

async function runOne(
  name: CollectorName,
  collector: Collector,
  ctx: { segments: ReturnType<typeof loadConfig>['segments']; countries?: string[]; now: Date },
): Promise<{ fetched: number; inserted: number }> {
  const jobs = await collector.collect(ctx)
  const inserts = jobs.map((j) => toInsert(j, ctx.now))
  const insertedRefs = await insertRawJobs(inserts)
  await upsertSnapshots(buildSnapshots(insertedRefs))
  console.log(`[${name}] fetched=${jobs.length} inserted=${insertedRefs.length}`)
  return { fetched: jobs.length, inserted: insertedRefs.length }
}

async function main() {
  const { values } = parseArgs({
    options: {
      sources: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
  })

  const cfg = loadConfig()
  const now = new Date()

  const requested = (values.sources?.split(',').map((s) => s.trim()).filter(Boolean) ??
    (Object.keys(REGISTRY) as CollectorName[])) as CollectorName[]

  let hadFailure = false
  for (const name of requested) {
    const collector = REGISTRY[name]
    if (!collector) {
      console.warn(`[${name}] not implemented yet, skipping`)
      continue
    }
    const spec = cfg.collectors[name]
    if (!spec.enabled) {
      console.log(`[${name}] disabled in config, skipping`)
      continue
    }
    if (!values.force && !shouldRunToday(spec.schedule, now)) {
      console.log(`[${name}] not scheduled today (${spec.schedule}), skipping`)
      continue
    }
    const countries = 'countries' in spec ? spec.countries : undefined
    try {
      await runOne(name, collector, { segments: cfg.segments, countries, now })
    } catch (err) {
      hadFailure = true
      console.error(`[${name}] failed:`, err)
      await notifyFailure(`collector:${name}`, err)
    }
  }

  if (hadFailure) process.exit(1)
}

main().catch(async (err) => {
  console.error(err)
  await notifyFailure('collect:main', err)
  process.exit(1)
})
