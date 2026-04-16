# 00. Audit Framework

이 문서는 `job-pulse`의 **감사(audit) 기준**을 정의한다. Claude Code 서브에이전트들이 이 문서와 각 docs 파일의 `Audit Rules` 섹션을 읽어 병렬로 감사 리포트를 생성한다.

## 목적

> "결정이 기록만 되고 강제되지 않으면 그건 문서 연극(documentation theater)이다."
> — ADR + Fitness Functions 패턴의 기본 전제

각 규칙은 **(a) 출처**, **(b) 판정 방법**, **(c) 범위(파일 경로)** 를 명시한다. 감사 에이전트는 이 정보만으로 PASS/FAIL을 판정할 수 있어야 한다.

## 참고한 업계 프레임워크

감사 카테고리·규칙은 다음 소스들에서 관련 있는 것만 선별·발췌했다. 각 규칙 끝에 출처 약어 표기.

| 약어 | 출처 | 이 프로젝트에서 차용한 영역 |
|---|---|---|
| `ADR` | [Architectural Decision Records](https://adr.github.io/) | 주요 결정의 기록·근거 형식 |
| `FIT` | [Fitness Functions (Lukas Niessen)](https://lukasniessen.medium.com/fitness-functions-automating-your-architecture-decisions-08b2fe4e5f34) | "결정이 지켜지는가"를 자동 검증 |
| `ARCH` | [ArchUnitTS rule catalog](https://lukasniessen.github.io/ArchUnitTS/) | 계층·순환·위치 규칙 |
| `DEP` | [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) | import 경로·계층 간 의존 금지 규칙 |
| `SONAR` | [SonarQube rules (MQR: security/reliability/maintainability)](https://docs.sonarsource.com/sonarqube-server/quality-standards-administration/managing-rules/rules) | 품질 카테고리 분류 |
| `CLN` | [Clean Code TypeScript](https://github.com/labs42io/clean-code-typescript) | 네이밍·함수·주석 원칙 |
| `12F` | [The Twelve-Factor App](https://12factor.net/) | 설정·로그·admin process |
| `OPA` | [Conftest / OPA policy-as-code](https://www.conftest.dev/) | 규칙 = 데이터, 테스트 가능 |

각 규칙은 위 프레임워크 중 하나 이상에 근거한다.

## 감사 카테고리

웹앱 감사와 달리 이 프로젝트는 **배치 파이프라인 + 외부 API 다수 + LLM 사용**이 핵심이라 6개 카테고리로 나눈다.

| # | 카테고리 | 다루는 문서 | 주요 질문 |
|---|---|---|---|
| A | Architecture & Boundaries | `01-architecture.md` | 계층 경계가 지켜지는가 |
| B | Collectors & External APIs | `02-collectors.md` | Collector 계약·TOS·쿼터 준수 |
| C | Pipeline & Operations | `03-pipeline.md`, `05-operations.md` | 스케줄·멱등성·시크릿·관측성 |
| D | Data & Schema | `03-pipeline.md` (DB 섹션) | 스키마·마이그레이션·쿼리 원칙 |
| E | LLM & Reporting | `04-llm-and-reporting.md` | 모델·프롬프트·비용·포맷 |
| F | Code Quality & Conventions | (횡단) | 네이밍·주석·타입·에러 처리 |

## 규칙 작성 규약

각 docs 파일 끝의 `Audit Rules` 섹션은 다음 형식을 따른다:

```markdown
## Audit Rules

### [CATEGORY-N] 규칙 제목

- **Why**: 왜 이 규칙이 필요한가 (한 문장)
- **Check**: 어떻게 판정하는가 (자동/수동 + 구체 방법)
- **Scope**: 검사 대상 파일/경로 (glob)
- **Source**: `ARCH`, `12F`, ... (위 표의 약어)
```

- **자동 판정**: grep, tsc, 파일 존재 여부 등 스크립트로 확인 가능
- **수동 판정 (에이전트)**: "읽고 해석해야 하는" 규칙. LLM 에이전트가 근거 인용과 함께 PASS/FAIL 작성
- 한 규칙은 **한 가지**만 검사. 복합 규칙은 쪼갠다

## Scope 해석 원칙 (중요)

각 규칙의 `Scope:` 라인은 **상한(upper bound)**이다. 감사 에이전트는 Scope에 명시된 파일·glob 밖을 **읽지 않는다**.

- 예: `[C-2]`의 Scope가 `.github/workflows/**, src/**, config.yml, .env.example`이라면 `.env`·`.env.local`은 절대 읽지 않는다. `[C-2]`는 "레포 커밋에 시크릿이 들어가지 않는가"를 보는 규칙이지, "로컬 머신에 시크릿이 있는가"를 보는 규칙이 아니다.
- gitignored 파일(`.env`, `scratch/`, `tmp/`, `node_modules/`, `.audit/` 등)은 규칙이 명시적으로 포함하지 않는 한 **항상 감사 대상 밖**이다. 의심 신호가 있어도 읽지 않는다.
- Scope 밖 파일을 열어 FAIL을 판정하면 **에이전트 오버리치**로 간주하고 해당 findings은 무효 처리한다.

이 원칙은 각 에이전트 정의(`.claude/agents/*.md`)의 Strict constraints에도 중복 명시된다.

## 감사 리포트 형식

각 서브에이전트는 자신이 담당한 카테고리의 `Audit Rules`를 순회하며 `.audit/<category>.md`를 생성한다.

```markdown
# Audit: <Category>
- Agent: <agent-name>
- Scope: <file globs>
- Generated: <ISO timestamp>
- Rules checked: N (passed M, failed K, skipped S)

## [RULE-ID] 제목  — PASS | FAIL | SKIP

**Finding**: (FAIL이면 무엇을 위반했는지, 파일:라인 인용)
**Evidence**: 해당 코드/설정 스니펫
**Recommendation**: 수정 방향 (FAIL일 때만)
```

## 감사 심각도

- **BLOCK**: 수집/리포트가 실제로 틀리게 동작. 머지 금지
- **MAJOR**: 문서된 계약 위반이나 즉각 사고는 없음. PR 전 수정 권장
- **MINOR**: 스타일/관용. 한꺼번에 모아 처리 가능

각 규칙은 심각도를 명시한다. `[CATEGORY-N][BLOCK]` 형식.

## 감사 주기

- PR 단위: 변경된 파일이 속한 카테고리만
- 주기적: 전체 감사 (월 1회 또는 배포 전)
- 회귀: FAIL 있던 규칙은 수정 후 재감사

실제 서브에이전트 호출 방법은 `.claude/agents/` (생성 예정).
