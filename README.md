# job-pulse

글로벌 개발자 채용 시장의 주간 변화를 다중 소스에서 수집해 Google Chat(또는 호환 웹훅)으로 전달하는 비동기 인텔리전스 파이프라인. 대시보드 없이 **Chat-first**로 동작한다.

## 개요

- **수집**: GitHub Actions cron (소스별 주기 차등) → 소스별 collector → Neon(PostgreSQL) 원본 + 집계 2단 저장
- **리포트**: 매주 월요일 09:00 UTC → 전주/전월 비교(UTC 월~일) + LLM 인사이트 코멘트 → Chat 웹훅
- **감지**: 신규 태그/키워드 첫 등장 자동 감지 (임계치 기반 노이즈 필터)
- **확장**: `config.yml` 수정만으로 세그먼트·국가 추가/제거
- **노티파이어**: `notifier` 인터페이스로 추상화 — 기본 Google Chat 구현 포함, 타 플랫폼 어댑터 추가 용이

## 지원 소스

| 소스 | 인증 | 쿼터 | 수집 주기 | 세그먼트 전략 |
|---|---|---|---|---|
| Remotive | 없음 | 무제한 | daily | 전량 수집 후 키워드 매칭 |
| Adzuna | app_id + app_key | ~1,000/월 | 월·목 (주 2회) | 세그먼트별 쿼리 (6 × 국가 × 2회) |
| JSearch (RapidAPI) | API Key | 200/월 | 월요일 (주 1회) | 세그먼트별 쿼리 (6 × 1회) |
| Hacker News "Who is Hiring" | 없음 | 무제한 | 월 1회 (매월 1일) | LLM 파싱 후 키워드 매칭 |

## 빠른 시작

```bash
npm install
cp .env.example .env        # 값 채우기
npm run migrate             # DB 스키마 생성
npm run collect -- --sources remotive --force   # 첫 수집
npm run report              # 리포트 미리보기 (dry run)
```

자세한 CLI 플래그·환경변수는 [docs/05-operations.md](docs/05-operations.md).

## 문서

설계·계약·운영 규칙은 6개 문서로 분리되어 있다. PR은 해당하는 문서의 계약·감사 규칙(`Audit Rules`)을 같이 갱신한다.

- [00. Audit Framework](docs/00-audit.md) — 감사 프레임워크·카테고리·규칙 형식·참조 프레임워크(ADR/FIT/ARCH/SONAR/12F 등)
- [01. Architecture](docs/01-architecture.md) — 실행 환경·데이터 흐름·계층·디렉토리 구조 + Audit Rules
- [02. Collectors](docs/02-collectors.md) — `Collector` 계약·세그먼트 매칭·소스별 특이사항·쿼터·TOS + Audit Rules
- [03. Pipeline](docs/03-pipeline.md) — 스케줄·멱등성·재시도·관측성·DB 접근 원칙·시크릿 + Audit Rules
- [04. LLM & Reporting](docs/04-llm-and-reporting.md) — 모델 선택·프롬프트 규약·비용 추적·리포트 포맷·Notifier + Audit Rules
- [05. Operations](docs/05-operations.md) — 로컬 실행·CLI·환경변수·마이그레이션·확장 체크리스트 + Audit Rules
- [06. Running the Audit](docs/06-running-audit.md) — 감사 서브에이전트 실행 방법

## 주간 리포트 예시

```
Developer Hiring Weekly (4/7 – 4/13)

Global (Remotive + JSearch + HN)
frontend      684   ↓ 5%     ▁▃▅▄▂▃▄
backend       812   ↑ 3%     ▂▃▃▄▅▅▆
ai            287   ↑ 47%    ▁▂▂▃▅▇█
devops        223   →        ▃▃▄▄▃▄▃
mobile        151   ↓ 8%     ▄▄▃▃▂▂▂
data          224   ↑ 2%     ▃▃▄▄▄▃▄

Adzuna (3-country aggregate)
frontend      600   ↑ 12%    ▂▃▄▃▄▄▅
...

New tags
  · "ai agent engineer" (x7)
  · "prompt ops" (x5)

Insight
This week, AI engineering roles continue their sharp climb,
with "ai agent" emerging as a distinct category...

Sources: Remotive, Adzuna, JSearch, Hacker News "Who is Hiring"
```
