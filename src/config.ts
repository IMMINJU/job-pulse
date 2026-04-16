import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { load } from 'js-yaml'
import { z } from 'zod'

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
type Dow = (typeof DOW)[number]

const ScheduleSchema = z.union([
  z.literal('daily'),
  z.string().regex(/^(sun|mon|tue|wed|thu|fri|sat)(,(sun|mon|tue|wed|thu|fri|sat))*$/),
  z.string().regex(/^monthly:([1-9]|[12]\d|3[01])$/),
])

const SegmentSchema = z.object({
  key: z.string().min(1),
  query: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1),
})

const CollectorBaseSchema = z.object({
  enabled: z.boolean(),
  schedule: ScheduleSchema,
})

const AdzunaSchema = CollectorBaseSchema.extend({
  countries: z.array(z.string().length(2)).min(1),
})

const CollectorsSchema = z.object({
  remotive: CollectorBaseSchema,
  arbeitnow: CollectorBaseSchema,
  adzuna: AdzunaSchema,
  jsearch: CollectorBaseSchema,
  hn_who_is_hiring: CollectorBaseSchema,
})

const ReportSchema = z.object({
  week_boundary: z.literal('utc'),
  new_tag: z.object({
    min_count: z.number().int().positive(),
  }),
})

const NotifierSchema = z.object({
  type: z.enum(['google_chat', 'slack', 'webhook']),
  webhook_url_env: z.string().min(1),
})

const ConfigSchema = z.object({
  segments: z.array(SegmentSchema).min(1),
  collectors: CollectorsSchema,
  report: ReportSchema,
  notifier: NotifierSchema,
})

export type Config = z.infer<typeof ConfigSchema>
export type Segment = z.infer<typeof SegmentSchema>
export type CollectorName = keyof Config['collectors']

const here = dirname(fileURLToPath(import.meta.url))
const defaultConfigPath = join(here, '..', 'config.yml')

export function loadConfig(path: string = defaultConfigPath): Config {
  const raw = readFileSync(path, 'utf8')
  const parsed = load(raw)
  return ConfigSchema.parse(parsed)
}

export function shouldRunToday(
  schedule: z.infer<typeof ScheduleSchema>,
  now: Date = new Date(),
): boolean {
  if (schedule === 'daily') return true
  const monthly = /^monthly:(\d+)$/.exec(schedule)
  if (monthly) return now.getUTCDate() === Number(monthly[1])
  const dow = DOW[now.getUTCDay()] as Dow
  return schedule.split(',').includes(dow)
}
