# 문서 분류·상태 대조 — 2026-10-21

기준 commit: `373764467a52a7c6978de1272ac8253c73a27077`. 사용자 요청: 문서 정리 진행, PDF 삭제, AI 에이전트의 현재/미래/역사 혼동 방지. 제품 기능 추가·제거·권한 변경·유료 호출·배포는 이번 범위가 아니다.

## 대조와 상태 정정

| 태스크 | 이전 → 정정 | 현재 코드·기존 실행 근거 |
|---|---|---|
| C-077 | planned → implemented | adapter `sdk-worker.ts`·protocol/worker, core harness, [H2 보고](Personal-Harness-Validation-2026-10-18.md) |
| C-078 | planned → implemented | server harness service·불변 profile, Studio harness 편집/선택, 같은 보고의 H3 |
| C-079 | planned → implemented | server files service·LSP read/edit, adapter 도구 연결, 같은 보고의 H4 |
| C-080 | planned → implemented | server 등록 검사·fingerprint·취소/보고서, 같은 보고의 H5 |
| C-081 | planned → implemented | core review recipe와 CLI eval, 같은 보고의 H6·fixture 결과 |
| C-082 | planned → implemented | core items 처리·부모 취소 회귀, 같은 보고의 H7 |
| C-083 | planned → implemented | adapter MCP/codemode, server mcp credentials·LSP edit, 같은 보고의 H8 |
| C-084 | planned → implemented | core reasoning/patch·adapter reasoning·ONNX worker, [추론 wire·패키지 결과](Reasoning-Controls-2026-10-18.md) |
| C-085 | planned → implemented | server harness·MCP probe/receipt·Studio ResourceEditor/McpEditor, [관리·실제 실행 결과](Resource-Management-2026-10-18.md) |
| C-118 | planned → in_progress | core ultra-team/auto-team·adapter reasoning, [M4 부분 구현과 명시 잔여](Integrated-Improvement-M4-2026-10-19.md) |

태스크는 134개 그대로이며 상태는 implemented 128, in_progress 5, planned 1이다. ID·완료 조건·요구·의존 관계는 보존했다. C-114의 helper를 전체 후보 기능으로 인정하지 않았고 C-125·128·135·136은 진행 상태를 유지했다. CR-036 M4-3/4와 CR-033 M4-5는 활성 계획에서 승인된 잔여 범위로 보존했다.

위 정정은 현재 소스 경로·연결된 회귀와 기존 실행 기록의 대조다. 이번에 하네스·실모델·Desktop 전체를 다시 실행한 결과나 hosted exact-head 성공이 아니다. 과거 사용성/Workbench 후보의 미확인 항목도 제안 지도에 보존했다.

## 최종 문서 정책

- 사용자 요청에 따라 완료·대체된 계획, 초기 제안 패키지, checksum/index, 과거 조사는 작업 트리에서 삭제한다. 별도 아카이브를 유지하지 않는다. 원문은 Git 이력으로 조회한다.
- 현재 제품·Desktop·하네스·위젯 계약과 승인된 잔여 작업은 유지한다. 초기 위젯 상단 바는 CR-041의 후속 사용자 정정에 따라 오른쪽 위 카드·팝오버로 정리했다.
- 실행 증거는 evaluation에 유지하며 과거 문서의 근거 인용은 검증한 `commit:원래 경로`로 표시한다. 이는 현재 작업 지시나 과거 권한의 재사용 허가가 아니다.
- PDF와 중복 Workbench 합본은 삭제했다. 요구·태스크·TC, 완료 조건과 기존 실행 결과·hash는 바꾸지 않는다. runtime 코드는 변경하지 않았다.

## 완료 태스크의 Git 증거

아래는 기존 계획 안에만 있던 실행 기록의 위치다. 이번 문서 정리에서 재실행한 결과가 아니다. 전체 원문은 `git show <commit>:<path>`로 조회한다.

| 태스크 | 고정 원문 | 당시 결과와 한계 |
|---|---|---|
| C-063–066 | `373764467a52:specs/010-first-run/plan.md` §8·§10 | A1: unit 462, E2E 54. A2: unit 470, E2E 66, 성능 2 통과. 타입/lint/build·화면 확인 기록. 전체 release gate는 미실행 |
| C-086 | `373764467a52:docs/plans/UI-Structure-Plan.md` 완료 증거·최종 검증 절 | 설정 왕복·초안/선택·Reins·D&D·리소스 scope·좁은 화면·패키지 검증. 구체적인 후보·명령·결과·제한은 해당 절을 따른다 |

## 이번 검사

- 수정 전 `pnpm spec:check`: 없는 과거 자료 안내 링크에서 실패를 확인했다.
- 제품 상한 회귀: 새 정본 경로를 먼저 연결해 파일 부재로 실패하는 것을 확인했다. 문서 이관 후 같은 단언을 다시 실행한다.
- 환경: Node 24.15.0, pnpm 10.30.3. Python jsonschema는 `/tmp` 전용 venv에 설치해 시스템 Python·제품 의존성을 바꾸지 않았다.
- 제품 상한 회귀: 이관 후 기존 단언 1개 통과(이름 필터로 나머지 35개 미실행).
- `pnpm contracts:check`: 생성 JSON Schema 일치. `pnpm deps:check`: 설치 버전·Node/peer 호환성 통과.
- 별도 release traceability 검사에서 기존 `TC-ABS-008-N` 연결 누락을 발견했다. baseline에도 누락됐으며 `schedules.test.ts` 그룹명이 비정식 `TC-ABS-08`이었다. 기존 중복 tick·놓친 실행·비활성화 경합·재시작·DST 반례를 읽고 정식 H/N 태그로 연결했다. 테스트 로직·단언·카탈로그 ID는 바꾸지 않았다.
- 예약 실행 회귀 9개 통과. release traceability는 정정 전 실패 → 정정 후 293/293 연결 통과. 이는 전체 release gate 실행이 아니다.
- ID·태스크 완료 조건·의존 관계·요구/TC/traceability JSON 보존, evidence 경로 존재, PDF 삭제와 활성 계획 경계를 별도 assert로 확인했다.
- 변경한 테스트 파일의 Biome 검사와 `git diff --check` 통과. 제품 전체 unit/E2E·패키지 UI·유료 provider·공개 배포·hosted CI는 재실행하지 않았다.

1차 분류 시 `pnpm spec:check`: 문서팩 2,521 checks PASS, TC 태그 293/293 연결. 이후 사용자 요청으로 아카이브를 제거했으며 최종 검사는 아래에 별도 기록한다.

아카이브 제거 후 최종 검사: `pnpm spec:check` 2,085 checks PASS, TC 태그 293/293. 삭제 문서의 Git 원문 40개와 남은 고정 Git 참조 18개를 확인했다. 태스크 evidence 경로와 ID·완료 조건·요구/테스트 원장은 보존했다. 제품 테스트는 문서·참조만 바뀌어 추가 실행하지 않았다.

PR 준비 시 원격 main과 비교해, 선행 커밋에서 삭제됐던 실제 차용물 고지 `THIRD-PARTY-NOTICES/Open-Claude-UI.md`를 main 원문대로 유지했다. 해당 UI 구현은 남아 있으며 출처 고지는 과거 계획과 함께 삭제할 대상이 아니다. 사용자는 이번 문서 정리 PR의 CI/CD 대기 없이 즉시 머지를 명시했으며, 이 예외는 이번 전달에만 적용한다.
