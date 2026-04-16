import { z } from 'zod'
import type { Collector, CollectorContext, RawJob } from './index.ts'

const JSearchJobSchema = z.object({
  job_id: z.string(),
  job_title: z.string(),
  employer_name: z.string().optional().nullable(),
  job_city: z.string().optional().nullable(),
  job_state: z.string().optional().nullable(),
  job_country: z.string().optional().nullable(),
  job_is_remote: z.boolean().optional().nullable(),
  job_posted_at_datetime_utc: z.string().optional().nullable(),
  job_employment_type: z.string().optional().nullable(),
})

const JSearchResponseSchema = z.object({
  status: z.string(),
  data: z.array(JSearchJobSchema.passthrough()),
})

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

function joinLocation(j: z.infer<typeof JSearchJobSchema>): string | null {
  const parts = [j.job_city, j.job_state, j.job_country].filter((s): s is string => !!s)
  return parts.length > 0 ? parts.join(', ') : null
}

export const jsearch: Collector = {
  name: 'jsearch',

  async collect(ctx: CollectorContext): Promise<RawJob[]> {
    const key = requireEnv('RAPIDAPI_KEY')

    const out: RawJob[] = []
    for (const segment of ctx.segments) {
      const url = new URL('https://jsearch.p.rapidapi.com/search')
      url.searchParams.set('query', segment.query)
      url.searchParams.set('page', '1')
      url.searchParams.set('num_pages', '1')
      url.searchParams.set('date_posted', 'week')

      const res = await fetch(url, {
        headers: {
          accept: 'application/json',
          'x-rapidapi-key': key,
          'x-rapidapi-host': 'jsearch.p.rapidapi.com',
          'user-agent': 'job-pulse/0.1 (+https://github.com/IMMINJU/job-pulse)',
        },
      })
      if (!res.ok) throw new Error(`jsearch ${segment.key} ${res.status} ${res.statusText}`)
      const body = JSearchResponseSchema.parse(await res.json())

      for (const j of body.data) {
        out.push({
          source: 'jsearch',
          externalId: j.job_id,
          postedAt: j.job_posted_at_datetime_utc ? new Date(j.job_posted_at_datetime_utc) : null,
          title: j.job_title,
          company: j.employer_name ?? null,
          location: joinLocation(j),
          remote: j.job_is_remote ?? null,
          tags: j.job_employment_type ? [j.job_employment_type] : null,
          segment: segment.key,
          raw: j,
        })
      }
    }
    return out
  },
}
