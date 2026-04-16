import { getSnapshotsInRange, getNewTagsSince } from '../db/queries.ts'
import type { JobSnapshotRow, Source, TagHistoryRow } from '../db/types.ts'

const DAY_MS = 24 * 60 * 60 * 1000

export function weekStartUTC(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const dow = d.getUTCDay()
  const offset = (dow + 6) % 7
  d.setUTCDate(d.getUTCDate() - offset)
  return d
}

export function addDaysUTC(d: Date, days: number): Date {
  const next = new Date(d)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export interface SegmentStat {
  segment: string
  total: number
  prevTotal: number
  changePct: number | null
  daily: number[]
}

export interface BucketStat {
  key: string           // 'global' | 'adzuna'
  label: string         // display name
  segments: SegmentStat[]
  topMovers: Array<{ segment: string; changePct: number; total: number; prevTotal: number }>
}

export interface WeeklyAggregate {
  weekStart: string
  weekEnd: string
  prevWeekStart: string
  prevWeekEnd: string
  buckets: BucketStat[]
  newTags: TagHistoryRow[]
}

// Adzuna is counted separately because country × segment loops cause cross-country duplication
// when summed globally. Non-Adzuna sources are remote-only or single-query so their segment
// counts are genuinely disjoint.
const GLOBAL_SOURCES: readonly Source[] = ['remotive', 'arbeitnow', 'jsearch', 'hn']
const ADZUNA_SOURCES: readonly Source[] = ['adzuna']

const BUCKETS: Array<{ key: string; label: string; sources: readonly Source[] }> = [
  { key: 'global', label: 'Global (Remotive + Arbeitnow + JSearch + HN)', sources: GLOBAL_SOURCES },
  { key: 'adzuna', label: 'Adzuna (3-country aggregate)', sources: ADZUNA_SOURCES },
]

function sumDailyBySegment(
  rows: JobSnapshotRow[],
  weekStart: Date,
  sources: readonly Source[],
): Map<string, number[]> {
  const allowed = new Set<string>(sources)
  const map = new Map<string, number[]>()
  for (const r of rows) {
    if (!allowed.has(r.source)) continue
    const idx = Math.floor((Date.parse(r.date) - weekStart.getTime()) / DAY_MS)
    if (idx < 0 || idx > 6) continue
    const arr = map.get(r.segment) ?? Array(7).fill(0)
    arr[idx] = (arr[idx] ?? 0) + r.count
    map.set(r.segment, arr)
  }
  return map
}

function buildBucket(
  bucket: { key: string; label: string; sources: readonly Source[] },
  thisRows: JobSnapshotRow[],
  prevRows: JobSnapshotRow[],
  weekStart: Date,
  prevStart: Date,
  segmentKeys: string[],
): BucketStat {
  const thisDaily = sumDailyBySegment(thisRows, weekStart, bucket.sources)
  const prevDaily = sumDailyBySegment(prevRows, prevStart, bucket.sources)

  const segments: SegmentStat[] = segmentKeys.map((segKey) => {
    const daily = thisDaily.get(segKey) ?? Array(7).fill(0)
    const prevArr = prevDaily.get(segKey) ?? Array(7).fill(0)
    const total = daily.reduce((a, b) => a + b, 0)
    const prevTotal = prevArr.reduce((a, b) => a + b, 0)
    const changePct = prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : null
    return { segment: segKey, total, prevTotal, changePct, daily }
  })

  const topMovers = segments
    .filter((s) => s.changePct !== null && s.prevTotal >= 10)
    .map((s) => ({
      segment: s.segment,
      changePct: s.changePct as number,
      total: s.total,
      prevTotal: s.prevTotal,
    }))
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, 3)

  return { key: bucket.key, label: bucket.label, segments, topMovers }
}

export async function buildWeeklyAggregate(
  now: Date,
  opts: { newTagMinCount: number; segments: string[] },
): Promise<WeeklyAggregate> {
  const ws = weekStartUTC(now)
  const prevStart = addDaysUTC(ws, -7)
  const thisEnd = addDaysUTC(ws, 6)
  const prevEnd = addDaysUTC(prevStart, 6)

  const [thisRows, prevRows] = await Promise.all([
    getSnapshotsInRange(toIsoDate(ws), toIsoDate(thisEnd)),
    getSnapshotsInRange(toIsoDate(prevStart), toIsoDate(prevEnd)),
  ])

  const buckets = BUCKETS.map((b) =>
    buildBucket(b, thisRows, prevRows, ws, prevStart, opts.segments),
  )

  const newTags = await getNewTagsSince(toIsoDate(ws), opts.newTagMinCount)

  return {
    weekStart: toIsoDate(ws),
    weekEnd: toIsoDate(thisEnd),
    prevWeekStart: toIsoDate(prevStart),
    prevWeekEnd: toIsoDate(prevEnd),
    buckets,
    newTags,
  }
}
