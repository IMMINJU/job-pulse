# 03. Pipeline

## 스케줄

GitHub Actions cron 4개. 모두 UTC 기준.

| 워크플로 | cron | 대상 |
|---|---|---|
| `collect-daily.yml` | `0 2 * * *` | remotive |
| `collect-weekly.yml` | `0 2 * * 1` / `0 2 * * 4` | mon: adzuna + jsearch / thu: adzuna |
| `collect-monthly.yml` | `0 2 1 * *` | hn (매월 1일) |
| `report.yml` | `0 1 * * 1` | 주간 리포트 (월 01:00 UTC / KST 10:00) |

각 워크플로는 `workflow_dispatch`도 열려 있어 수동 실행 가능. `report.yml`은 `dry_run` 입력 지원.

## 스케줄 이중 가드

워크플로 cron이 "언제 실행하는가"를 결정하지만, `src/config.ts`의 `shouldRunToday(schedule, now)`가 **런타임에도 한 번 더 필터**한다.

- `schedule: daily` → 항상 true
- `schedule: mon` / `"mon,thu"` → 요일 매칭
- `schedule: "monthly:1"` → `now.getUTCDate() === 1`

이유: 워크플로를 병합하거나 `workflow_dispatch`로 아무 요일에 돌려도 `config.yml`의 의도와 맞지 않으면 collector가 스스로 skip. `--force` 플래그로만 우회 가능.

## 멱등성

- `job_postings_raw`: `UNIQUE (source, external_id)` + `ON CONFLICT DO NOTHING` → 같은 날 여러 번 돌아도 중복 없음
- `job_snapshots`: `ON CONFLICT (date, source, segment) DO UPDATE SET count = EXCLUDED.count` → 재실행하면 **덮어쓰기** (단조 증가가 아닌 최신값 반영)
- `report_runs`: `UNIQUE (week_start)` + `ON CONFLICT DO UPDATE` → 주당 1건. `sent=true`면 `--force` 없이 재전송 차단

## 재시도

**자동 재시도는 없다.** GitHub Actions가 실패하면 수동 `workflow_dispatch`로 재실행. 이유:

- 수집은 하루 1회라 미스 1건이 치명적이지 않음
- 자동 재시도는 쿼터를 두 배로 씀 → Adzuna·JSearch에 위험
- 실패의 90%는 외부 API 일시 오류 → 다음 스케줄까지 기다려도 됨

재시도가 정말 필요하면 워크플로 레벨에서 `continue-on-error: false` + 외부 알림을 보고 사람이 재실행.

## 관측성

대시보드 없이 Chat-first로 운영하므로 **실패·이상치는 전부 Chat으로**.

- `FAILURE_WEBHOOK_URL`로 스택 요약 전송 (없으면 `GOOGLE_CHAT_WEBHOOK_URL` 재사용)
- 수집 건수 0 / 급락(>50%) 경고 (TODO)
- LLM 호출 비용은 `report_runs.insight_cost`에 USD 누적 기록. 집계 쿼리로 월별 추이 확인 가능

## DB 접근 원칙

ORM 없이 `@neondatabase/serverless` + 템플릿 리터럴 SQL로 시작. 규모가 커지면 Drizzle로 전환하되, 그 시점의 전환 비용을 낮추기 위한 규칙:

- **모든 SQL은 `src/db/queries.ts` 한 곳에.** Collector·report는 이 파일만 import → 전환 시 이 파일만 교체
- **row 타입은 `src/db/types.ts`에 수동 선언.** ORM 도입 시 `InferSelectModel<>` 로 대체
- **쿼리는 템플릿 리터럴로만.** 문자열 concat 금지 (SQL injection 방지 + 전환 호환성)
- **마이그레이션은 `NNN_name.sql` 순번 파일로 누적.** `schema_migrations` 테이블이 적용 이력 자동 관리

전환 트리거 (미래 신호):
- 테이블 8개 초과 / 관계(FK) 필요
- 같은 쿼리 반복으로 DRY 필요
- 스키마 변경이 잦아 수동 타입 싱크가 버그의 원천이 됨

## 시크릿 관리

모든 민감 값은 GitHub Actions secrets로만. 로컬은 `.env` (gitignore됨). `.env.example`에 키 목록만 공개.

필수: `DATABASE_URL`, `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, `RAPIDAPI_KEY`, `OPENAI_API_KEY`, `GOOGLE_CHAT_WEBHOOK_URL`

선택: `OPENAI_MODEL`, `OPENAI_INPUT_USD_PER_MTOK`, `OPENAI_OUTPUT_USD_PER_MTOK`, `FAILURE_WEBHOOK_URL`, `PIPELINE_SECRET`

## Audit Rules

### [C-1][BLOCK] 스케줄 이중 가드

- **Why**: cron 단독으론 수동 실행이나 주기 변경 시 의도 벗어난 실행 위험.
- **Check**: (자동·에이전트) `src/collect.ts`가 collector 실행 전 `shouldRunToday(spec.schedule, now)`를 호출하고 `--force` 플래그로만 우회 가능.
- **Scope**: `src/collect.ts`, `src/config.ts`
- **Source**: ADR, `12F`(Admin Processes)

### [C-2][BLOCK] 시크릿 평문 금지

- **Why**: API 키·webhook URL이 레포에 들어가면 즉시 유출·과금.
- **Check**: (자동) `.github/workflows/*.yml`의 `env:` 블록은 `${{ secrets.* }}`만 사용. 소스코드·`.env.example`·config.yml에 실제 키 형태(`eyJ...`, `sk-...`, 32자+ hex 등) 없음.
- **Scope**: `.github/workflows/**`, `src/**`, `config.yml`, `.env.example`
- **Source**: `SONAR`(Security), `12F`(Config)

### [C-3][BLOCK] 필수 env 검증

- **Why**: 런타임 초반에 env 부재를 발견해야 조용한 실패 대신 즉시 종료.
- **Check**: (자동) 각 collector·notifier는 필요한 env 부재 시 throw. `DATABASE_URL`은 `src/db/index.ts`에서 검증.
- **Scope**: `src/db/index.ts`, `src/collectors/adzuna.ts`, `src/collectors/jsearch.ts`, `src/collectors/hn.ts`, `src/notifier/factory.ts`
- **Source**: `12F`(Config), `SONAR`(Reliability)

### [C-4][BLOCK] 멱등성

- **Why**: 재시도·수동 재실행 시 데이터 중복·덮어쓰기 오류 방지.
- **Check**: (에이전트) `job_postings_raw` insert는 `ON CONFLICT DO NOTHING`, `job_snapshots` insert는 `ON CONFLICT DO UPDATE`, `report_runs` insert는 `ON CONFLICT DO UPDATE`. 마이그레이션 러너는 `schema_migrations`로 중복 실행 방지.
- **Scope**: `src/db/queries.ts`, `src/db/migrate.ts`
- **Source**: `ARCH`, `12F`(Disposability)

### [C-5][MAJOR] 자동 재시도 금지

- **Why**: 쿼터 있는 API에 자동 재시도는 한도 두 배 사용 위험.
- **Check**: (에이전트) collector 내부에 `while` 루프로 재시도하거나 `retry(`, `backoff(` 호출 없음. workflow YAML에도 retry 설정 없음.
- **Scope**: `src/collectors/**`, `.github/workflows/**`
- **Source**: ADR, Remotive/Adzuna TOS

### [C-6][MAJOR] 실패 알림 경로

- **Why**: 대시보드 없는 Chat-first 운영. 실패가 조용히 묻히면 감지 불가.
- **Check**: (에이전트) collector·report 실패 시 `FAILURE_WEBHOOK_URL`(없으면 `GOOGLE_CHAT_WEBHOOK_URL`)로 알림 발송. 또는 최소한 `console.error`로 스택 출력 후 `exit(1)`.
- **Scope**: `src/collect.ts`, `src/report.ts`
- **Source**: `12F`(Logs), 구현 메모

### [C-7][MAJOR] 워크플로 스케줄 문서 일치

- **Why**: `.github/workflows/*.yml`의 cron이 이 문서의 스케줄 표와 다르면 실제 동작과 설계가 어긋남.
- **Check**: (자동·에이전트) 각 워크플로 `on.schedule.cron`이 문서 표의 시각·요일과 일치.
- **Scope**: `.github/workflows/**/*.yml`
- **Source**: `ARCH`, ADR

### [D-1][BLOCK] SQL 단일 통로

- **Why**: `queries.ts` 외부 SQL은 미래 ORM 전환 비용을 높이고 멱등성·타입 검증이 빠질 위험.
- **Check**: (자동) `src/collectors/**`, `src/report/**`, `src/collect.ts`, `src/report.ts`에 SQL 문자열(`SELECT `, `INSERT INTO`, `UPDATE `, `DELETE FROM`, `CREATE TABLE`) 없음. `sql\`` 템플릿 리터럴은 `src/db/**`만.
- **Scope**: `src/**` (제외: `src/db/**`)
- **Source**: ADR, `A-2`

### [D-2][BLOCK] 런타임 파라미터 SQL concat 금지

- **Why**: SQL injection + 추후 ORM 전환 호환성 훼손.
- **Check**: (자동) `src/db/**/*.ts`에서 **런타임 파라미터**(함수 인자·env·API 응답 등)를 SQL 문자열에 concat하지 않는다. 모든 런타임 값은 태그드 템플릿(`` sql`... ${x}` ``)의 보간을 통해서만 전달된다. 금지 패턴: `sql('SELECT ... ' + x)`, `` sql(`SELECT ... ${x}`) `` (템플릿을 따옴표 없는 plain string으로 먼저 만들어 query에 넘기는 것).
- **Exception**: `src/db/migrate.ts`는 checked-in `.sql` 파일을 `sql.query(stmt)`로 실행한다. 이 경로는 (1) 사용자·외부 API 입력이 섞이지 않는 DDL 전용, (2) `;` 기준 분리가 태그드 템플릿으로는 표현되지 않음이라는 두 근거로 명시적 예외이다. 새 DB 접근 경로가 이 예외를 확장하려면 PR에서 근거를 기록한다.
- **Scope**: `src/db/**` (제외: `src/db/migrate.ts`)
- **Source**: `SONAR`(Security), ADR

### [D-3][MAJOR] 마이그레이션 순번 누적

- **Why**: 순번 뒤집기·동일 파일 수정은 재현성 파괴.
- **Check**: (자동) `src/db/migrations/*.sql`이 `NNN_name.sql` 형식. 이미 기록된 `schema_migrations.name`의 파일 내용 변경 금지(에이전트가 git log로 확인).
- **Scope**: `src/db/migrations/**`
- **Source**: ADR, `12F`(Dev/Prod Parity)

### [D-4][MAJOR] row 타입 수동 선언 일치

- **Why**: ORM 없이 시작하는 대신 타입을 스키마와 수동 동기화. 어긋나면 런타임 필드 undefined.
- **Check**: (에이전트) `src/db/types.ts`의 row 타입 필드가 `001_init.sql`의 컬럼과 (이름·nullability) 일치.
- **Scope**: `src/db/types.ts`, `src/db/migrations/**`
- **Source**: ADR
