export interface ReportSection {
  heading?: string
  body: string
  mono?: boolean // true = 고정폭(코드블럭), false/undefined = 평문
}

export interface ReportMessage {
  title: string
  summary: string // plain-text fallback (used when platform doesn't support rich format)
  sections: ReportSection[]
  footer?: string // e.g. source attribution
}

export interface Notifier {
  name: string
  send(message: ReportMessage): Promise<void>
}
