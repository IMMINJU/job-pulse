import type { Segment } from '../config.ts'
import type { Source } from '../db/types.ts'

export interface RawJob {
  source: Source
  externalId: string
  postedAt?: Date | null
  title: string
  company?: string | null
  location?: string | null
  remote?: boolean | null
  tags?: string[] | null
  segment?: string | null
  raw: unknown
}

export interface CollectorContext {
  segments: Segment[]
  countries?: string[]
  now: Date
}

export interface Collector {
  name: Source
  collect(ctx: CollectorContext): Promise<RawJob[]>
}
