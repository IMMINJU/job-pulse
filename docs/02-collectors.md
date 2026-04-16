# 02. Collectors

## 계약

```ts
interface RawJob {
  source: Source
  externalId: string
  postedAt?: Date | null
  title: string
  company?: string | null
  location?: string | null
  remote?: boolean | null
  tags?: string[] | null
  segment?: string | null     // 세그먼트별 쿼리 소스는 이 시점에 라벨링
  raw: unknown                // 원본 JSON (job_postings_raw.raw_json)
}

interface CollectorContext {
  segments: Segment[]
  countries?: string[]
  now: Date
}

interface Collector {
  name: Source
  collect(ctx: CollectorContext): Promise<RawJob[]>
}
```

- **`externalId`는 소스 내에서 유일**해야 함 (`(source, external_id)` UNIQUE)
- Adzuna처럼 country별로 같은 id가 나오는 경우 `${country}:${id}`로 prefix
- `raw`는 그대로 JSONB에 보존 (미래 분석·쿼터 초과 시 back-fill용)
- 모든 collector는 `User-Agent: job-pulse/0.1 (+https://github.com/IMMINJU/job-pulse)` 헤더 필수

## 세그먼트 할당 (하이브리드)

| 소스 그룹 | 방식 |
|---|---|
| Adzuna, JSearch | `segments[].query`로 **세그먼트별 쿼리** → 결과 전체를 해당 세그먼트로 라벨링 |
| Remotive, HN | 한 번 **전량 수집** → `segments[].keywords`로 `title`/`tags` 단어 경계 매칭 → **매칭 수가 가장 많은** 세그먼트 |

- 매처(`src/segment/match.ts`)는 `(?<![a-z0-9])kw(?![a-z0-9])` 정규식. `ai`가 `chains`에 오탐되지 않음. 공백·하이픈 포함 키워드(`"front-end"`, `"machine learning"`)도 그대로 지원
- 동점 세그먼트는 `config.yml`의 순서가 이김
- 어느 세그먼트에도 매칭 안 된 공고는 `__unassigned__`로 집계 (튜닝 지표)

## 소스별 특이사항

### Remotive (`src/collectors/remotive.ts`)

- `https://remotive.com/api/remote-jobs` — 무인증, JSON
- 응답에 **법적 경고 + 일 최대 4회 호출 권장**이 섞여 있음. 우리는 daily 1회
- 리모트 전용. `remote: true` 고정
- 재배포 금지 — 집계·통계만 Chat으로 보내며 개별 공고 URL은 노출하지 않음

### Arbeitnow (`src/collectors/arbeitnow.ts`) — 비활성

> config.yml에서 `enabled: false`. 개발자 공고 비율 12%로 낮고 API에 카테고리 필터가 없어 unassigned 88% 발생. 재활성화하려면 config만 변경.

- `https://www.arbeitnow.com/api/job-board-api` — 무인증, 페이지네이션
- 100건/페이지, 최근 생성 순. 최근 7일 cutoff로 페이지 돌다가 중단 (MAX_PAGES=5 안전장치)

### Adzuna (`src/collectors/adzuna.ts`)

- `https://api.adzuna.com/v1/api/jobs/{country}/search/1` — `app_id` + `app_key`
- `country × segment` 루프 (us/gb/de × 6 = 18콜)
- `max_days_old=7`, `results_per_page=50`
- **중복 처리**: 같은 회사·직무가 여러 국가에 나올 수 있어 `external_id`에 `country:` prefix. 리포트는 `global`(비-Adzuna) / `adzuna` 두 버킷으로 **분리 표기**해 교차 합산을 피함 (`src/report/aggregate.ts`의 `BUCKETS`)

### JSearch (`src/collectors/jsearch.ts`)

- `https://jsearch.p.rapidapi.com/search` — `x-rapidapi-key`
- 세그먼트당 1콜 (`num_pages=1`, 10건)
- `date_posted=week` 필터

### Hacker News "Who is Hiring" (`src/collectors/hn.ts`)

- Firebase API (`hacker-news.firebaseio.com/v0`)
- `whoishiring` 사용자의 `submitted[0:12]`에서 `"Ask HN: Who is hiring?"` 제목 + 45일 이내 스레드 선택
- 댓글(kids) 전체 fetch (batch 20), HTML strip
- OpenAI `gpt-4.1-mini`로 40개/배치 구조화 추출. `response_format: json_object` + zod 파싱
- LLM이 `location`을 string 또는 array로 반환할 수 있어서 zod union + transform으로 정규화
- LLM 실패 시 해당 배치만 드랍, 나머지 배치는 정상 진행 (per-batch try-catch)

## 쿼터 예산

| 소스 | 한도 | 사용 | 여유 |
|---|---|---|---|
| Remotive | 무제한 (일 4회 권장) | 일 1회 | 안전 |
| ~~Arbeitnow~~ | ~~무제한~~ | ~~비활성~~ | — |
| Adzuna | ~1,000/월 | 6 × 3 × 2/주 × 4.3주 ≈ 155/월 | 84% 여유 |
| JSearch | 200/월 | 6 × 4.3 ≈ 26/월 | 87% 여유 |
| HN | 무제한 | 월 1회, ~500 댓글 fetch | 안전 |

## Compliance (외부 API TOS)

- **Remotive**: 출처 표기 필수 → 리포트 footer `Sources: Remotive, Adzuna, JSearch, HN` 자동 포함
- **Remotive**: 3자 플랫폼 재배포 금지 → 집계만 전송, 개별 공고 URL 노출 금지
- **Arbeitnow**: 비활성. 재활성화 시 링크백 필요
- **Adzuna**: `app_id` 유출 금지 → GitHub secrets로만 관리, `.env.example`에 빈 값
- **HN Firebase API**: 무제한이지만 과도한 병렬 호출 회피 (batch 20)

## 실패 처리

- collector가 throw하면 `src/collect.ts`의 루프가 **다른 collector 실행은 계속**, 프로세스는 **마지막에 `exit(1)`**
- 로그에 `[${name}] failed:` 스택 요약
- 반복 실패는 `FAILURE_WEBHOOK_URL`로 알림 (자세한 것은 `03-pipeline.md`)

## Audit Rules

### [B-1][BLOCK] Collector 계약 구현

- **Why**: `Collector` 인터페이스에서 벗어나면 `collect.ts`의 REGISTRY 루프가 깨진다.
- **Check**: (자동·에이전트) `src/collectors/*.ts`(`index.ts` 제외)가 모두 `name: Source` 필드와 `collect(ctx): Promise<RawJob[]>` 메서드를 export. `RawJob.externalId`·`title`은 반드시 채워짐.
- **Scope**: `src/collectors/*.ts`
- **Source**: `ARCH`, ADR

### [B-2][BLOCK] User-Agent 헤더 필수

- **Why**: 무인증 API(Remotive 등)는 identifiable UA 없으면 차단·rate limit 가능. TOS에 명시됨.
- **Check**: (자동) 모든 `fetch(` 호출에 `user-agent` 헤더가 붙어 있다. 정규식으로 확인.
- **Scope**: `src/collectors/**/*.ts`
- **Source**: `SONAR`(Reliability), Remotive TOS

### [B-3][BLOCK] externalId 유일성

- **Why**: `(source, external_id)` UNIQUE 제약. Adzuna처럼 국가별 중복 가능한 소스는 prefix 필요.
- **Check**: (에이전트) Adzuna collector의 `externalId`는 `${country}:${id}` 형식. 다른 collector의 `externalId`는 소스 내 유일함을 주석 또는 명백한 필드 유래로 입증.
- **Scope**: `src/collectors/*.ts`
- **Source**: `ARCH`, 스키마 제약

### [B-4][BLOCK] 쿼터 예산 준수

- **Why**: API 한도 초과는 즉시 차단되고 다음 달까지 복구 불가.
- **Check**: (에이전트) Adzuna 호출 = `countries.length × segments.length × 스케줄 주당 횟수 × 4.3 ≤ 1,000/월`. JSearch 호출 = `segments.length × 스케줄 주당 횟수 × 4.3 ≤ 200/월`. 현재 config와 코드 결합으로 계산.
- **Scope**: `src/collectors/adzuna.ts`, `src/collectors/jsearch.ts`, `config.yml`
- **Source**: API TOS, `12F`(Disposability)

### [B-5][MAJOR] 세그먼트 할당 방식 분리

- **Why**: 쿼터 있는 소스(Adzuna/JSearch)는 쿼리 단계 라벨링, 무쿼터는 `matchSegment`. 혼용하면 분포가 왜곡.
- **Check**: (에이전트) Adzuna/JSearch collector는 `segment: segment.key`로 직접 할당 (matchSegment 호출 X). Remotive/HN는 `matchSegment()`를 호출. (Arbeitnow 비활성이지만 코드는 matchSegment 사용.)
- **Scope**: `src/collectors/*.ts`
- **Source**: ADR

### [B-6][MAJOR] Remotive TOS — 재배포 금지

- **Why**: Remotive TOS는 개별 공고 URL 재배포 금지. 집계·통계만 전송 가능.
- **Check**: (에이전트) 리포트 포맷에 개별 공고 `url`·`redirect_url`·링크가 렌더되지 않는다. footer에 "Sources: ..." 표기 있음.
- **Scope**: `src/report/format.ts`, `src/notifier/**/*.ts`
- **Source**: Remotive TOS, `B-1`

### [B-7][MAJOR] raw_json 원본 보존

- **Why**: 수집 시점 스키마를 보존해야 추후 재해석·백필 가능.
- **Check**: (에이전트) 모든 `RawJob.raw`는 원본 페이로드(또는 최소한 원본 job + 추가 메타) 포함. `raw: {}` 또는 가공된 파생값만 담는 경우 FAIL.
- **Scope**: `src/collectors/*.ts`
- **Source**: `12F`(Concurrency/Backing services)

### [B-8][MINOR] HN 45일 룩백

- **Why**: whoishiring 계정은 같은 달 Who is hiring / Freelancer / Who wants 3개 스레드를 올림. 45일 필터가 빠지면 엉뚱한 스레드를 파싱.
- **Check**: (에이전트) `hn.ts`에 `age < 45 * 24 * 3600 * 1000` 또는 동등 필터가 있고, 제목이 `"Ask HN: Who is hiring?"`으로 시작하는 것만 선택.
- **Scope**: `src/collectors/hn.ts`
- **Source**: 구현 메모

