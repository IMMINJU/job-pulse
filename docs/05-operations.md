# 05. Operations

## 로컬 실행

```bash
npm install
cp .env.example .env                              # 값 채우기
npm run migrate                                   # 모든 마이그레이션 적용 (idempotent)
npm run collect                                   # 스케줄에 해당하는 collector만 실행
npm run collect -- --sources remotive --force     # 특정 소스 강제 실행 (스케줄 무시)
npm run report                                    # 리포트 생성 (콘솔 출력, 전송 없음)
npm run report -- --send                          # Chat 전송
npm run report -- --send --force                  # 이미 전송한 주 재전송
npm run typecheck                                 # tsc --noEmit
```

## CLI 플래그

### `collect`

- `--sources=<csv>` — 실행할 collector 목록. 기본은 REGISTRY 전체
- `--force` — `config.yml`의 `schedule` 조건 무시하고 강제 실행

### `report`

- `--send` — notifier로 실제 전송 (없으면 콘솔 출력 + `sent=false`로 DB 저장)
- `--force` — `report_runs.sent=true`여도 재실행·재전송

## 환경변수

`.env.example` 참조.

### 필수
- `DATABASE_URL` — Neon connection string
- `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` — https://developer.adzuna.com
- `RAPIDAPI_KEY` — RapidAPI JSearch 구독 (무료)
- `OPENAI_API_KEY` — HN 파싱 + 주간 인사이트
- `GOOGLE_CHAT_WEBHOOK_URL` — 리포트 전송 채널

### 선택
- `OPENAI_MODEL` — 기본 `gpt-4.1-mini`
- `OPENAI_INPUT_USD_PER_MTOK`, `OPENAI_OUTPUT_USD_PER_MTOK` — 비용 추정 단가 (기본 0.20/0.80)
- `FAILURE_WEBHOOK_URL` — 실패 알림 별도 채널 (없으면 기본 웹훅 재사용)
- `PIPELINE_SECRET` — 수동 트리거용 공유 시크릿

## 마이그레이션

- `src/db/migrations/NNN_name.sql` 순번 파일로 누적
- `npm run migrate`가 `schema_migrations` 테이블을 조회해 **아직 적용 안 된 파일만** 순서대로 실행
- idempotent — 매 실행마다 불필요한 재실행 없음
- 문장 분리는 `;` 기준 단순 split. `$$` 포함 블록 같은 복잡한 PL/pgSQL이 필요해지면 파서 교체

## GitHub Actions 운영

4개 워크플로 모두:
- `workflow_dispatch`로 수동 실행 가능
- `actions/setup-node@v4` + `cache: npm`으로 의존성 캐시
- 비밀값은 `${{ secrets.* }}`로 주입, 워크플로 YAML에 평문 금지

실패 시:
1. Actions UI에서 로그 확인
2. 쿼터 초과/API 일시 장애면 다음 스케줄까지 대기
3. 코드 버그면 수정 → 수동 `workflow_dispatch`로 재실행
4. DB 중복 방지는 UPSERT로 보장되므로 같은 날 여러 번 돌려도 안전

## DB 직접 조회

빠른 상태 체크용 쿼리들.

```sql
-- 최근 수집 현황
SELECT source, COUNT(*) AS total, MAX(fetched_at) AS last
FROM job_postings_raw
WHERE fetched_at >= now() - interval '7 days'
GROUP BY source;

-- 세그먼트별 이번 주 분포
SELECT segment, SUM(count) AS total
FROM job_snapshots
WHERE date >= (date_trunc('week', now() AT TIME ZONE 'UTC'))::date
GROUP BY segment
ORDER BY total DESC;

-- LLM 비용 월별 합계
SELECT date_trunc('month', generated_at) AS month,
       ROUND(SUM(insight_cost)::numeric, 4) AS usd
FROM report_runs
GROUP BY 1 ORDER BY 1 DESC;

-- 신규 태그 후보
SELECT tag, first_seen, total_count
FROM tag_history
WHERE first_seen >= now()::date - 7
ORDER BY total_count DESC LIMIT 20;
```

## 확장 체크리스트

### 새 수집 소스 추가

1. `src/collectors/<name>.ts` 작성 — `Collector` 구현
2. `src/collect.ts`의 `REGISTRY`에 등록
3. `config.yml`의 `collectors.<name>` 블록 추가 (`enabled`, `schedule`)
4. `src/config.ts`의 `CollectorsSchema` 확장
5. 필요하면 GitHub Actions 워크플로에 env 시크릿 추가
6. `docs/02-collectors.md`에 소스 문서화

### 새 notifier 추가

1. `src/notifier/<platform>.ts` — `makeXNotifier(url): Notifier` 팩토리
2. `src/notifier/factory.ts`의 switch에 분기 추가
3. `src/config.ts`의 notifier `type` enum에 추가
4. `docs/04-llm-and-reporting.md`에 메시지 렌더링 방식 기록

### 새 세그먼트 추가

- `config.yml`의 `segments[]`에 `key/query/keywords` 추가. 코드 변경 없음
- 키워드는 다른 세그먼트와 **겹치지 않게** 구성 (단어 경계 매칭이 오탐은 막아주지만, 동일 키워드 중복은 첫 번째 세그먼트만 이김)

## 테스트

현재 자동화 테스트 없음. 수동 smoke test:

```bash
npm run collect -- --sources remotive --force
# → "[remotive] fetched=N inserted=N" 출력 확인

npm run report
# → 콘솔에 섹션 4개(Segments / Top movers / New tags / Insight) + footer 출력 확인
```

픽스처 기반 단위 테스트가 필요하면 vitest + HTTP 모킹(nock/MSW) 추천. 우선순위는 매처(`segment/match.ts`) > 집계(`report/aggregate.ts`) > collector.

## Audit Rules

### [C-8][BLOCK] CLI 플래그 문서 일치

- **Why**: `--send`·`--force`·`--sources` 플래그가 문서와 실제 구현이 다르면 운영 실수로 재전송·중복 수집 발생.
- **Check**: (자동·에이전트) 이 문서에 명시된 플래그가 `src/collect.ts`·`src/report.ts`의 `parseArgs` options와 일치.
- **Scope**: `src/collect.ts`, `src/report.ts`
- **Source**: ADR, `12F`(Admin Processes)

### [C-9][MAJOR] 환경변수 문서 일치

- **Why**: 런타임에 env 읽는 코드와 문서의 env 목록이 어긋나면 GitHub secrets·로컬 `.env` 누락 원인.
- **Check**: (자동·에이전트) 코드에서 `process.env.X`로 읽는 모든 X가 `.env.example`에 있고 이 문서의 env 섹션에도 있다.
- **Scope**: `src/**/*.ts`, `.env.example`, `docs/05-operations.md`
- **Source**: `12F`(Config)

### [C-10][MAJOR] 마이그레이션 실행 경로

- **Why**: 신규 환경에서 `npm run migrate`가 빠지면 테이블 없는 DB에서 조용히 실패.
- **Check**: (에이전트) 이 문서 "로컬 실행" 섹션의 명령 순서가 `migrate → collect → report`. `package.json`에 `migrate` 스크립트 존재.
- **Scope**: `package.json`, `docs/05-operations.md`
- **Source**: `12F`(Dev/Prod Parity)

### [C-11][MINOR] 확장 체크리스트 유지

- **Why**: 새 collector·notifier·segment 추가 절차를 문서화해야 기여자 혼동 방지.
- **Check**: (수동) 이 문서의 "확장 체크리스트" 섹션이 현재 REGISTRY·factory·CollectorsSchema와 일치.
- **Scope**: `docs/05-operations.md`
- **Source**: `ARCH`
