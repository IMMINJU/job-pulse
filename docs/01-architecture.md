# 01. Architecture

## 요약

job-pulse는 **대시보드 없는 Chat-first 배치 파이프라인**이다. 외부 채용 API들에서 공고를 주기적으로 수집해 Neon(PostgreSQL)에 저장하고, 매주 월요일 09:00 UTC에 집계·LLM 인사이트를 붙여 Google Chat 웹훅으로 전송한다.

## 실행 환경

- **스케줄러**: GitHub Actions cron (4개 워크플로)
- **런타임**: Node.js 20+ · TypeScript 6 · tsx (컴파일 없이 실행)
- **DB**: Neon serverless PostgreSQL, HTTP 드라이버 (`@neondatabase/serverless`)
- **LLM**: OpenAI (`gpt-4.1-mini` 기본)
- **전송**: Google Chat Incoming Webhook (Notifier 인터페이스로 추상화)

## 데이터 흐름

```
[daily 02:00 UTC]                  [mon,thu 02:00 UTC]          [mon 02:00 UTC]
  remotive ──┤  → normalize          adzuna ─┐                    jsearch ─┐
             │      ├─ title/tags     (per segment × country)      (per segment)
             │      ├─ title/tags 매칭 → segment 라벨링           → segment 라벨링
             ▼      ▼                      │                             │
          job_postings_raw (UNIQUE: source, external_id) ←───────────────┘
             │
             └─→ job_snapshots (UPSERT: date, source, segment)

[monthly 1st 02:00 UTC]
  hn_who_is_hiring
    ├─ whoishiring 계정 submitted에서 최신 "Who is hiring?" 스레드 탐색 (45일 내)
    ├─ Firebase API로 댓글(kids) 전체 fetch + HTML strip
    ├─ LLM(gpt-4.1-mini)으로 {company, role, location, remote, stack} JSON 추출 (40개/배치)
    ├─ keyword 매칭 → segment 라벨링
    └─ job_postings_raw / job_snapshots 적재

[weekly mon 09:00 UTC]
  report generator
    ├─ 주/월 집계 (UTC 월~일)
    ├─ 상위 무브 TOP 3 (전주 대비)
    ├─ 신규 태그/키워드 감지 (min_count 임계치)
    ├─ LLM 인사이트 코멘트 1문단
    ├─ report_runs 이력 기록
    └─ notifier.send() → 웹훅 전송
```

## 계층

| 계층 | 책임 | 파일 |
|---|---|---|
| Config | config.yml 로더 + zod 검증, `shouldRunToday` | `src/config.ts` |
| Collectors | 외부 API 호출 → `RawJob[]` | `src/collectors/*` |
| Segment | 키워드 기반 분류 (단어 경계 + 최다 득점) | `src/segment/match.ts` |
| DB | Neon 클라이언트·타입·쿼리·마이그레이션 | `src/db/*` |
| Report | 집계 / LLM 인사이트 / 메시지 포맷 | `src/report/*` |
| Notifier | 채널 어댑터 인터페이스 | `src/notifier/*` |
| Entry | CLI 파싱 → 오케스트레이션 | `src/collect.ts`, `src/report.ts` |

## 확장 포인트

- **새 수집 소스**: `src/collectors/<name>.ts`에 `Collector` 구현 → `src/collect.ts`의 REGISTRY에 등록 → `config.yml`에 `collectors.<name>` 블록 추가
- **새 세그먼트**: `config.yml`의 `segments[]`에 `key/query/keywords` 추가 (코드 변경 없음)
- **새 전송 채널**: `src/notifier/<platform>.ts`에 `Notifier` 구현 → `factory.ts`의 switch에 분기 추가

## 디렉토리 구조

```
job-pulse/
├── .github/workflows/       # 4개 cron 워크플로
├── docs/                    # 이 문서들
├── src/
│   ├── collectors/          # 외부 API 수집기
│   ├── segment/             # 분류 로직
│   ├── db/                  # Neon 클라이언트·타입·쿼리
│   │   ├── migrations/      # NNN_name.sql 순번 누적
│   │   ├── index.ts
│   │   ├── types.ts
│   │   ├── queries.ts
│   │   └── migrate.ts
│   ├── report/              # 집계·LLM·포맷
│   ├── notifier/            # 채널 어댑터 + failure 알림
│   │   ├── index.ts
│   │   ├── gchat.ts
│   │   ├── factory.ts
│   │   └── failure.ts
│   ├── config.ts            # config 로더
│   ├── collect.ts           # 수집 CLI 엔트리
│   └── report.ts            # 리포트 CLI 엔트리
├── config.yml               # 세그먼트·collector·report·notifier 설정
└── package.json
```

## 설계 원칙

- **ORM 없이 시작** (`@neondatabase/serverless` + 템플릿 리터럴 SQL). 테이블 4개·고정 쿼리 패턴에 ORM 이득 적음. 규모 커지면 Drizzle로 전환 경로 확보 — 자세한 것은 `03-pipeline.md`
- **포맷 중립 `ReportMessage`** — GChat뿐 아니라 Slack/Discord 어댑터 추가 시 재사용. 자세한 것은 `04-llm-and-reporting.md`
- **외부 API의 TOS/쿼터가 1급 요구사항** — 수집 주기·country 수·결과 크기 모두 쿼터 역산. 자세한 것은 `02-collectors.md`

## Audit Rules

감사 프레임워크 전체는 `00-audit.md` 참조.

### [A-1][BLOCK] 계층 간 import 방향

- **Why**: `collectors/`가 `report/`를 import하면 데이터 흐름이 역전돼 파이프라인 단계가 뒤섞인다.
- **Check**: (자동) `src/collectors/**/*.ts`가 `src/report/**`, `src/notifier/**`를 import하지 않는다. `src/report/**/*.ts`가 `src/collectors/**`를 import하지 않는다. grep 기반으로 확인 가능.
- **Scope**: `src/collectors/**`, `src/report/**`, `src/notifier/**`
- **Source**: `ARCH`, `DEP`

### [A-2][BLOCK] DB 접근 단일 통로

- **Why**: 여러 파일에서 SQL을 쓰기 시작하면 추후 ORM 전환·쿼리 튜닝이 파편화된다.
- **Check**: (자동) `@neondatabase/serverless`의 `neon`/`sql` import는 `src/db/**` 외부에 없다. 즉 collector·report 파일에서 `from '@neondatabase/serverless'` 금지.
- **Scope**: `src/**/*.ts` (제외: `src/db/**`)
- **Source**: `ARCH`, ADR (ORM 없이 시작)

### [A-3][MAJOR] 순환 의존 없음

- **Why**: 순환 import는 초기화 순서 버그와 번들러 경고의 원인.
- **Check**: (에이전트 보조) `src/**/*.ts` import 그래프를 읽고 순환이 있는지 확인. dependency-cruiser 도입 전까지는 수동.
- **Scope**: `src/**/*.ts`
- **Source**: `ARCH`, `DEP`

### [A-4][MAJOR] 디렉토리 구조 준수

- **Why**: 문서에 선언된 계층과 실제 파일 배치가 어긋나면 신규 기여자가 계약을 잘못 학습한다.
- **Check**: (자동) 이 문서 "디렉토리 구조" 섹션의 트리와 실제 `src/` 트리가 일치. 추가된 디렉토리는 문서에 반영됐다.
- **Scope**: `src/**`
- **Source**: `ARCH`

### [A-5][MINOR] 엔트리포인트 책임 제한

- **Why**: `src/collect.ts`, `src/report.ts`는 **CLI 파싱 + 오케스트레이션만**. 비즈니스 로직은 하위 모듈에 있어야 재사용 가능.
- **Check**: (에이전트) `collect.ts`/`report.ts`에 SQL·fetch·정규식 등 도메인 로직이 인라인으로 있는지 확인.
- **Scope**: `src/collect.ts`, `src/report.ts`
- **Source**: `CLN`(Functions), `12F`(Admin Processes)

### [F-1][MAJOR] 네이밍 일관성

- **Why**: `camelCase` / `kebab-case` 등이 섞이면 import 경로 실수를 유발.
- **Check**: (자동) `src/**/*.ts` 파일명은 `kebab-case.ts` 또는 `index.ts`. 내부 심볼은 `camelCase` (클래스만 `PascalCase`). 테스트 파일은 `*.test.ts` 또는 `*.spec.ts`.
- **Scope**: `src/**/*.ts`
- **Source**: `CLN`, `ARCH`

### [F-2][MAJOR] 타입 안정성

- **Why**: `any`·암묵 `any`·타입 단언 남용은 외부 API 스키마 변경을 감지 못 한다.
- **Check**: (자동) `tsc --noEmit` 통과. `as unknown as X` 단언은 DB 쿼리 결과에 한정하고 주석 동반. 파일 전역 `: any`·`<any>` 사용 없음.
- **Scope**: `src/**/*.ts`
- **Source**: `SONAR`(Reliability), `CLN`

### [F-3][MAJOR] 외부 입력은 zod 검증

- **Why**: 외부 API 응답·config 파일·LLM 출력은 언제든 스키마 이탈 가능. 런타임 검증 없으면 silent corruption.
- **Check**: (자동·에이전트) `fetch(...).json()` 결과와 `OpenAI` 응답은 zod 파싱을 거친다. `src/config.ts`의 config 로드는 zod 파싱을 거친다.
- **Scope**: `src/collectors/**`, `src/config.ts`, `src/report/insight.ts`
- **Source**: `SONAR`(Reliability), `CLN`(Error Handling)

### [F-4][MINOR] 주석 최소주의

- **Why**: 코드가 설명하면 주석 불필요. 주석은 "왜"만. "무엇"은 이름으로.
- **Check**: (에이전트) 함수 본문 내부에 "무엇"을 설명하는 주석 있는지 스팟체크.
- **Scope**: `src/**/*.ts`
- **Source**: `CLN`(Comments)

