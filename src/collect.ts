import { parseArgs } from 'node:util'
import { loadConfig, shouldRunToday, type CollectorName } from './config.ts'
import type { Collector, RawJob } from './collectors/index.ts'
import { remotive } from './collectors/remotive.ts'
// import { arbeitnow } from './collectors/arbeitnow.ts' // disabled: 개발자 공고 12%, API 필터 미지원
import { adzuna } from './collectors/adzuna.ts'
import { jsearch } from './collectors/jsearch.ts'
import { hn } from './collectors/hn.ts'
import { insertRawJobs, upsertSnapshots } from './db/queries.ts'
import type { JobPostingRawInsert, JobSnapshotRow, Source } from './db/types.ts'
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

function buildSnapshots(jobs: RawJob[], fetchedAt: Date): JobSnapshotRow[] {
  const date = fetchedAt.toISOString().slice(0, 10)
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

async function runOne(
  name: CollectorName,
  collector: Collector,
  ctx: { segments: ReturnType<typeof loadConfig>['segments']; countries?: string[]; now: Date },
): Promise<{ fetched: number; inserted: number }> {
  const jobs = await collector.collect(ctx)
  const inserts = jobs.map((j) => toInsert(j, ctx.now))
  const inserted = await insertRawJobs(inserts)
  await upsertSnapshots(buildSnapshots(jobs, ctx.now))
  console.log(`[${name}] fetched=${jobs.length} inserted=${inserted}`)
  return { fetched: jobs.length, inserted }
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
