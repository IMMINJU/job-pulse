export type Source = 'remotive' | 'arbeitnow' | 'adzuna' | 'jsearch' | 'hn'

export const UNASSIGNED_SEGMENT = '__unassigned__'

export interface JobPostingRawRow {
  id: number
  source: Source
  external_id: string
  fetched_at: Date
  posted_at: Date | null
  title: string
  company: string | null
  location: string | null
  remote: boolean | null
  tags: string[] | null
  segment: string | null
  raw_json: unknown
}

export interface JobPostingRawInsert {
  source: Source
  external_id: string
  fetched_at: Date
  posted_at?: Date | null
  title: string
  company?: string | null
  location?: string | null
  remote?: boolean | null
  tags?: string[] | null
  segment?: string | null
  raw_json: unknown
}

export interface InsertedRawRef {
  source: Source
  segment: string | null
  posted_at: Date | null
  fetched_at: Date
}

export interface JobSnapshotRow {
  date: string // YYYY-MM-DD
  source: Source
  segment: string
  count: number
}

export interface TagHistoryRow {
  tag: string
  first_seen: string
  last_seen: string
  total_count: number
}

export interface ReportRunRow {
  id: number
  week_start: string
  generated_at: Date
  sent: boolean
  payload: unknown
  insight_cost: string | null
}
