import { z } from 'zod'
import type { Collector, CollectorContext, RawJob } from './index.ts'

const AdzunaJobSchema = z.object({
  id: z.string(),
  title: z.string(),
  company: z.object({ display_name: z.string().optional().nullable() }).partial().nullable().optional(),
  location: z
    .object({ display_name: z.string().optional().nullable(), area: z.array(z.string()).optional() })
    .partial()
    .nullable()
    .optional(),
  created: z.string().optional().nullable(),
  redirect_url: z.string().optional().nullable(),
  category: z.object({ label: z.string().optional(), tag: z.string().optional() }).partial().nullable().optional(),
  salary_min: z.number().optional().nullable(),
  salary_max: z.number().optional().nullable(),
  contract_type: z.string().optional().nullable(),
})

const AdzunaResponseSchema = z.object({
  count: z.number(),
  results: z.array(AdzunaJobSchema.passthrough()),
})

const PAGE_SIZE = 50 // max per Adzuna docs
// 6 segs × 3 countries × 2 runs/week × 3 pages × 4.3 weeks ≈ 465 calls/month vs 1,000 quota.
const MAX_PAGES = 3

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

export const adzuna: Collector = {
  name: 'adzuna',

  async collect(ctx: CollectorContext): Promise<RawJob[]> {
    const appId = requireEnv('ADZUNA_APP_ID')
    const appKey = requireEnv('ADZUNA_APP_KEY')
    const countries = ctx.countries ?? []
    if (countries.length === 0) throw new Error('adzuna: no countries configured')

    const out: RawJob[] = []
    for (const country of countries) {
      for (const segment of ctx.segments) {
        for (let page = 1; page <= MAX_PAGES; page++) {
          const url = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/${page}`)
          url.searchParams.set('app_id', appId)
          url.searchParams.set('app_key', appKey)
          url.searchParams.set('what', segment.query)
          url.searchParams.set('results_per_page', String(PAGE_SIZE))
          url.searchParams.set('content-type', 'application/json')
          url.searchParams.set('max_days_old', '7')

          const res = await fetch(url, {
            headers: {
              accept: 'application/json',
              'user-agent': 'job-pulse/0.1 (+https://github.com/IMMINJU/job-pulse)',
            },
          })
          if (res.status === 404) {
            console.warn(`[adzuna] ${country}/${segment.key} p${page} 404 — country may not be supported, skipping`)
            break
          }
          if (!res.ok) throw new Error(`adzuna ${country}/${segment.key} p${page} ${res.status} ${res.statusText}`)
          const body = AdzunaResponseSchema.parse(await res.json())

          for (const j of body.results) {
            out.push({
              source: 'adzuna',
              externalId: `${country}:${j.id}`,
              postedAt: j.created ? new Date(j.created) : null,
              title: j.title,
              company: j.company?.display_name ?? null,
              location: j.location?.display_name ?? null,
              remote: null,
              tags: j.category?.tag ? [j.category.tag] : null,
              segment: segment.key,
              raw: { country, count: body.count, page, job: j },
            })
          }

          if (body.results.length < PAGE_SIZE) break
        }
      }
    }
    return out
  },
}
