# 04. LLM & Reporting

## LLM 사용 지점

총 **두 곳**에서만 LLM을 사용한다. 모두 OpenAI `gpt-4.1-mini` 기본.

| 용도 | 위치 | 입력 | 출력 |
|---|---|---|---|
| HN "Who is Hiring" 댓글 파싱 | `src/collectors/hn.ts` | 40개 댓글 텍스트 | `{company, role, location, remote, stack}[]` JSON |
| 주간 인사이트 코멘트 | `src/report/insight.ts` | 집계 요약 JSON | 중립 어조 한 문단 (≤80단어) |

## 모델 선택

**`gpt-4.1-mini` 기본**인 이유:
- 1M 컨텍스트 → HN 월간 스레드(~500 댓글)를 청킹 부담 없이 처리
- `$0.20 / $0.80 (1M 토큰)` → 월 예상 비용 $0.5 미만
- Instruction following·JSON 안정성이 4o-mini보다 낫다

대안:
- `gpt-4.1-nano` ($0.05/$0.20) → HN 파싱엔 충분, 인사이트는 품질 저하 가능
- `gpt-5-mini` 이상 → reasoning이라 오버킬

`OPENAI_MODEL` 환경변수로 오버라이드. 작업별 분리가 필요하면 collector/insight 각각 별도 env를 받도록 확장 가능.

## 프롬프트 규약

### HN 파서 (구조화 추출)

```
SYSTEM: Extract hiring posts from HN "Who is hiring?" comments.
        Each top-level comment is one posting. Return ONLY valid JSON
        matching the schema. If not a job posting, omit from output.

USER:   Schema: { "jobs": [{ comment_id, company, role, location, remote, stack }] }
        Comments:
        --- id=... ---
        <HTML-stripped text>
```

- `response_format: { type: 'json_object' }` 강제
- 응답은 `ExtractedBatchSchema` (zod)로 검증 → 포맷 이탈 시 throw
- 배치 단위 실패는 해당 배치만 드랍, 전체 수집은 계속

### Insight 생성 (문단)

```
SYSTEM: You analyze weekly developer hiring trends.
        Return ONE concise paragraph (3-5 sentences, under 80 words).
        Focus on directional signals. Neutral tone; no marketing;
        no emojis; no bullet points.

USER:   Weekly hiring data (JSON). Write one insight paragraph.
        <compactAggregate JSON>
```

- 입력은 세그먼트 합계·변화율·상위 무브·신규 태그(상위 10)로 압축해서 토큰 절약
- 전부 0건이면 LLM 호출 skip → `"No data collected this week"` 반환

## 비용 추적

- OpenAI 응답의 `usage.prompt_tokens` / `completion_tokens` × 환경변수 단가
- `OPENAI_INPUT_USD_PER_MTOK` (기본 0.20), `OPENAI_OUTPUT_USD_PER_MTOK` (기본 0.80)
- `report_runs.insight_cost`에 USD NUMERIC(10,6)으로 누적
- 월별 추이는 `SELECT date_trunc('month', generated_at), SUM(insight_cost) FROM report_runs GROUP BY 1`

## 리포트 파이프라인

```
buildWeeklyAggregate(now, { newTagMinCount, segments })
  ├─ weekStartUTC(now) - 7일  — 집계 대상은 '막 끝난 주'
  ├─ getSnapshotsInRange     — 이번 주 + 전주 (job_snapshots.count = posted_at 기준 신규 공고 수)
  ├─ sumDailyBySegment       — 세그먼트별 7일 배열
  ├─ changePct 계산          — prevTotal>=10인 경우만 top mover 후보
  └─ getNewTagsSince         — first_seen>=weekStart AND total_count>=min

generateInsight(agg)
  └─ compactAggregate → LLM → { text, costUsd }

buildReportMessage(agg, insightText)
  ├─ sections: Segments / Top movers / New tags / Insight
  ├─ sparkline (▁▂▃▄▅▆▇█ 8단계)
  ├─ arrow (↑ ↓ → —, |%|<1은 →)
  └─ footer: 'Sources: Remotive, Adzuna, JSearch, Hacker News "Who is Hiring"'
```

## Report 메시지 모델

```ts
interface ReportMessage {
  title: string
  summary: string           // 플랫폼이 카드 미지원일 때 fallback
  sections: ReportSection[]
  footer?: string           // 소스 attribution
}

interface ReportSection {
  heading?: string
  body: string
  mono?: boolean            // true = 고정폭(코드블럭), false/undefined = 평문
}
```

**포맷 중립**: 메시지는 플랫폼 독립. 각 notifier가 자기 방식으로 렌더링.

## Notifier 인터페이스

```ts
interface Notifier {
  name: string
  send(message: ReportMessage): Promise<void>
}
```

현재 구현: `makeGChatNotifier(webhookUrl)` — GChat 마크다운 (`*bold*`, `_italic_`, `` ```code``` ``)을 `text` 필드 한 개에 담아 POST.

`config.notifier.type`으로 선택. Slack/generic webhook은 `factory.ts`의 switch에 분기 추가하면 됨.

## 재전송 규칙

- `report_runs.week_start` UNIQUE. 같은 주 재실행 시 UPSERT
- `sent=true`면 `--force` 없이는 재전송 차단 (중복 알림 방지)
- `npm run report` (dry run)만 돌리면 `sent=false`로 DB 기록 → 나중에 `--send`만 추가 실행 가능

## 리포트 출력 예시

```
Developer Hiring Weekly (4/7 – 4/13)

Weekly hiring summary, UTC Mon-Sun. 7123 postings tracked across 2 source groups.

Global (Remotive + JSearch + HN)
frontend      684   ↓ 5%     ▁▃▅▄▂▃▄
backend       812   ↑ 3%     ▂▃▃▄▅▅▆
ai            287   ↑ 47%    ▁▂▂▃▅▇█
devops        223   →        ▃▃▄▄▃▄▃
mobile        151   ↓ 8%     ▄▄▃▃▂▂▂
data          224   ↑ 2%     ▃▃▄▄▄▃▄

Global (Remotive + JSearch + HN) · top movers
  · ai ↑ 47%  (prev 195)
  · frontend ↓ 5%  (prev 720)

Adzuna (3-country aggregate)
frontend      600   ↑ 12%    ▂▃▄▃▄▄▅
backend       800   ↑ 5%     ▃▄▄▄▅▅▆
ai            200   ↑ 60%    ▁▁▂▃▄▆█
devops        400   ↓ 2%     ▄▄▄▃▄▃▄
mobile        150   ↓ 15%    ▅▄▃▃▂▂▂
data          300   ↑ 8%     ▃▃▄▄▄▄▄

Adzuna (3-country aggregate) · top movers
  · ai ↑ 60%  (prev 125)
  · mobile ↓ 15%  (prev 176)

New tags
  · "ai agent engineer" (x7)
  · "prompt ops" (x5)

Insight
This week, AI engineering roles continue their sharp climb...

Sources: Remotive, Adzuna, JSearch, Hacker News "Who is Hiring"
```

두 버킷으로 분리된 이유는 Adzuna가 3국가 × 6세그먼트로 호출되어 같은 다국적 공고가 여러 번 카운트되기 때문. 합산하면 값이 부풀려지므로 `global` 버킷(단일 수집 소스들) 옆에 `adzuna` 버킷을 나란히 표기해 해석을 독자에게 넘긴다.

## Audit Rules

### [E-1][BLOCK] LLM 사용 지점 제한

- **Why**: LLM 호출이 여기저기 흩어지면 비용·모델 정책을 일관 적용할 수 없다.
- **Check**: (자동) `OpenAI` import는 `src/collectors/hn.ts`, `src/report/insight.ts` 두 곳만.
- **Scope**: `src/**`
- **Source**: ADR, `A-2`

### [E-2][BLOCK] 모델 ID는 환경변수 우선

- **Why**: 모델 교체가 코드 배포 없이 가능해야 한다.
- **Check**: (자동) LLM 호출 파일에서 `process.env.OPENAI_MODEL ?? '<default>'` 패턴 사용. 하드코딩된 모델 ID(`'gpt-...'`)가 이 fallback 외 위치에 있으면 FAIL.
- **Scope**: `src/collectors/hn.ts`, `src/report/insight.ts`
- **Source**: `12F`(Config)

### [E-3][BLOCK] LLM 출력 zod 검증

- **Why**: `response_format: json_object`라도 스키마 이탈 가능. 런타임 검증 없으면 downstream 크래시.
- **Check**: (자동) LLM 응답을 `JSON.parse` 후 zod 파서를 통과시킨다. `as any`/`as unknown as T`로 강제 캐스팅만 하고 끝나면 FAIL.
- **Scope**: `src/collectors/hn.ts`, `src/report/insight.ts`
- **Source**: `SONAR`(Reliability), `F-3`

### [E-4][BLOCK] 비용 추적

- **Why**: LLM 비용은 조용히 누적. 기록 안 하면 예산 초과를 사후에 발견.
- **Check**: (에이전트) `report_runs.insight_cost`에 USD가 기록된다. `insight.ts`는 `usage.prompt_tokens`·`completion_tokens`로 계산.
- **Scope**: `src/report/insight.ts`, `src/report.ts`
- **Source**: `12F`(Logs), ADR

### [E-5][MAJOR] 인사이트 출력 한국어

- **Why**: 리포트 언어 일관성. 사용자 결정.
- **Check**: (에이전트) `insight.ts` system prompt가 한국어 출력을 요구. 기본 오류 메시지("이번 주 수집된 데이터가 없습니다." 등)도 한국어.
- **Scope**: `src/report/insight.ts`
- **Source**: ADR

### [E-6][MAJOR] 프롬프트 규약

- **Why**: "버킷 간 합산 금지", "이모지·목록 금지" 같은 제약이 빠지면 잘못된 수치 해석이 나온다.
- **Check**: (에이전트) `insight.ts`의 system에 (a) 버킷 간 합산 금지, (b) 한 문단 제한, (c) 중립 톤 조건이 포함되어 있다. `hn.ts` system에 (a) JSON-only, (b) "not a job posting이면 omit" 조건이 포함된다.
- **Scope**: `src/collectors/hn.ts`, `src/report/insight.ts`
- **Source**: ADR

### [E-7][MAJOR] Notifier 포맷 중립성

- **Why**: `ReportMessage`가 특정 플랫폼 포맷(Slack blocks 등)을 품으면 어댑터 교체 때 재작성 필요.
- **Check**: (에이전트) `ReportMessage`의 필드는 `title`, `summary`, `sections`, `footer`만. 플랫폼 특이 필드(`blocks`, `cardsV2`, `embeds`) 금지. 렌더링은 각 notifier 구현 내부에서만.
- **Scope**: `src/notifier/index.ts`, `src/notifier/*.ts`
- **Source**: `ARCH`, ADR

### [E-8][MAJOR] 소스 attribution

- **Why**: Remotive TOS 요구. 빠지면 차단 사유.
- **Check**: (자동) `format.ts`가 반환하는 `message.footer`에 "Remotive", "Adzuna", "JSearch", "Hacker News" 포함. (Arbeitnow 비활성이라 제외 OK.)
- **Scope**: `src/report/format.ts`
- **Source**: Remotive TOS, `B-6`

### [E-9][MAJOR] 버킷 분리 표기

- **Why**: Adzuna 중복 집계 문제의 해결책. 합산 표시하면 원래 문제 재발.
- **Check**: (에이전트) `aggregate.ts`의 `BUCKETS` 상수에 `global`과 `adzuna` 두 버킷이 분리되어 있고, `format.ts`가 버킷마다 별도 섹션을 렌더.
- **Scope**: `src/report/aggregate.ts`, `src/report/format.ts`
- **Source**: ADR
