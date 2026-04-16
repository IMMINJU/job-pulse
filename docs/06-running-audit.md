# 06. Running the Audit

감사는 Claude Code 서브에이전트 5개를 **병렬**로 실행한 뒤 요약 에이전트가 결과를 합치는 구조이다.

## 에이전트

`.claude/agents/` 아래에 정의되어 있다.

| 에이전트 | 담당 카테고리 | 출력 |
|---|---|---|
| `audit-architecture` | A, F (01 문서) | `.audit/A-architecture.md` |
| `audit-collectors` | B (02 문서) | `.audit/B-collectors.md` |
| `audit-pipeline` | C (03·05 문서) | `.audit/C-pipeline.md` |
| `audit-data` | D (03 문서, DB 쪽) | `.audit/D-data.md` |
| `audit-llm-reporting` | E (04 문서) | `.audit/E-llm-reporting.md` |
| `audit-summary` | (집계 전용, 소스 X) | `.audit/SUMMARY.md` |

모두 읽기 전용 도구(`Read`, `Grep`, `Glob`, `Bash`)만 허용. `src/`·`config.yml`·`docs/`를 수정하지 않는다. `.audit/` 디렉토리에만 쓴다.

## 실행 방법

### 1. 병렬 실행 (권장)

Claude Code 세션에서 한 번에 5개 에이전트를 띄운다.

```
다음 5개 감사를 병렬로 실행해:
- audit-architecture
- audit-collectors
- audit-pipeline
- audit-data
- audit-llm-reporting

각자 .audit/<category>.md에 결과를 쓰고 끝나면 audit-summary로 합쳐줘.
```

Claude Code가 Agent 도구 호출 5개를 한 번에 보낸 다음, 전부 완료되면 `audit-summary` 에이전트를 호출해 `.audit/SUMMARY.md`를 만든다.

### 2. 단일 카테고리

회귀 확인이나 특정 파일만 수정했을 때.

```
audit-collectors만 돌려줘. .audit/B-collectors.md를 갱신해.
```

### 3. Summary만 재생성

카테고리 리포트 중 일부를 수동 수정하거나 추가한 뒤 합산만 다시 하고 싶을 때.

```
audit-summary로 .audit/SUMMARY.md만 다시 써줘.
```

## 산출물 구조

```
.audit/
├── A-architecture.md       # 카테고리 A + F
├── B-collectors.md
├── C-pipeline.md
├── D-data.md
├── E-llm-reporting.md
└── SUMMARY.md
```

`.audit/`는 git 추적 대상에서 제외한다 (리포트는 언제든 재생성 가능).

## 리포트 포맷

각 카테고리 리포트는 `docs/00-audit.md`에 정의된 포맷을 따른다.

```markdown
# Audit: <Category>
- Agent: <agent-name>
- Scope: <file globs>
- Generated: <ISO8601 UTC>
- Rules checked: N (passed M, failed K, skipped S)

## [RULE-ID] 제목 — PASS | FAIL | SKIP
**Finding**: ...
**Evidence**: `file:line` 스니펫
**Recommendation**: (FAIL일 때만)
```

## 감사 주기 권장

- **PR 단위**: 변경된 파일이 속한 카테고리 에이전트만 실행
- **주기 전체**: 월 1회 전체 + 중요 변경 병합 직전
- **회귀**: 이전 감사의 FAIL을 수정한 PR에서 해당 에이전트 단독 재실행

## 규칙 추가·수정

1. 해당 docs 파일의 `Audit Rules` 섹션에 규칙 추가 (`[X-N][심각도]` 형식, Why/Check/Scope/Source 4요소)
2. 에이전트 본문의 procedure에 해당 규칙 처리 방법이 이미 커버되는지 확인, 필요 시 에이전트 본문도 갱신
3. 한 규칙은 한 가지만 검사 (복합 규칙은 쪼갠다)
4. `Source:`에는 `00-audit.md`의 약어(`ARCH`, `SONAR`, `12F` 등)를 쓴다

## 주의

- 감사 에이전트는 **실제 동작 검증을 하지 않는다.** 외부 API 호출·DB 쿼리 실행·LLM 호출은 모두 감사 범위 밖. 감사는 "문서화된 계약과 코드가 일치하는가"만 확인.
- 실제 동작 검증은 `npm run migrate` → `npm run collect` → `npm run report` 순으로 사람이 수행.
- FAIL이 나왔다고 곧바로 코드를 고치지 않는다. 먼저 **규칙이 현재 설계 의도와 맞는지** 재검토 — 설계가 바뀌었다면 규칙을 갱신하는 게 올바른 반응일 수 있다.
