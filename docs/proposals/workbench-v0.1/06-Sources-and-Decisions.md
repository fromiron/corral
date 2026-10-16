# 근거·설계 결정·확인 필요 항목

## 1. 자료의 우선순위

현재 구현 진단은 아래 기준 커밋의 GitHub 소스가 우선이다. 이전 MVP PDF는 제품의 합의와 범위 이력을 설명하는 자료이며 현재 구현 전체의 증거로 사용하지 않는다. 본 패키지의 개선 구조·상한·일정·성능 목표는 새 설계 제안이다.

기준 저장소: `fromiron/corral`.
기준 커밋: `a9ecda50175e614fe1f559152dd1974e016883e8`.
확인일: 2026-10-16. 앱을 실행하거나 사용자 테스트를 하지는 않았다.

## 2. 저장소 근거

| ID | 확인한 사실/자료 | 원본 |
|---|---|---|
| R01 | 저장소 목적·패키지 구조·기존 v0.2 기능 설명 | [README](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/README.md) |
| R02 | RunOutput이 첫 output artifact를 선택하고 Markdown으로 표시 | [RunView.tsx](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/packages/react/src/components/RunView.tsx) |
| R03 | Artifact의 이전 버전 비교·입력·directive lineage가 이미 존재 | [ArtifactViewer.tsx](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/packages/react/src/components/ArtifactViewer.tsx) |
| R04 | RunSessionStore는 단일 Run view/receipt/stream 상태이며 loadOutput은 첫 결과를 로드 | [run/session.ts](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/packages/react/src/run/session.ts) |
| R05 | 정의·Run 중심 홈/라우트, graph·tree·detail 중심 RunPage | [router.tsx](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/apps/studio/src/router.tsx), [WorkspacePage.tsx](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/apps/studio/src/pages/WorkspacePage.tsx), [RunPage.tsx](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/apps/studio/src/pages/RunPage.tsx) |
| R06 | 작업 도구 search/read_document/write_artifact, 출력 계약 text/notes/draft/review, CorralDefinition에 input 포함 | [definition.ts](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/packages/contracts/src/definition.ts) |
| R07 | 기존 후속 기능은 특정 artifact 본문을 새 Run brief로 복사하고 startedFrom을 기록 | [CR-007](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/docs/change-requests/CR-007-new-run-from-version.md) |
| R08 | SQLite의 기존 table·immutable trigger·numbered migration·WAL/FULL/foreign keys | [database.ts](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/packages/storage-sqlite/src/database.ts) |
| R09 | 현재 workspace 아래 .corral/corral.db와 설정 파일 | [workspace.ts](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/apps/server/src/workspace.ts) |
| R10 | Studio가 이미 사용하는 Router/React Flow/React/Zustand/i18n/test 도구 | [Studio package.json](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/apps/studio/package.json) |
| R11 | react-virtual·react-markdown·Storybook·Testing Library 등 기존 의존성 | [React package.json](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/packages/react/package.json) |
| R12 | Coordinator의 단일 결정 경로·effect intent·단일 활성 Run 검사 | [coordinator.ts](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/packages/core/src/coordinator.ts) |
| R13 | 요구·명세·테스트·CR·live opt-in·비밀정보·dependency 검증 규칙 | [AGENTS.md](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/AGENTS.md) |

R01/R03/R07/R09/R12는 직전 검토에서 같은 고정 커밋을 읽은 자료를 포함한다. 이번에 main이 동일 커밋인지 다시 확인했고, R02/R04/R05/R06/R08/R10/R11/R13을 재조회했다. 모든 원본 기능을 실행해서 확인했다는 뜻은 아니다.

## 3. 외부 1차 자료

| ID | 실제 확인 범위 | 원본 |
|---|---|---|
| S01 | Git worktree의 작업 트리 분리·공유 Git metadata·porcelain 출력 | [Git worktree](https://git-scm.com/docs/git-worktree.html) |
| S02 | Git diff 범위·rename·외부 helper/textconv 제어 | [Git diff](https://git-scm.com/docs/git-diff) |
| S03 | Monaco의 model/URI/dispose·ESM 통합·VS Code 확장과의 차이·mobile 미지원 | [Monaco README](https://github.com/microsoft/monaco-editor/blob/main/README.md) |
| S04 | Monaco 저장소의 MIT license 표기 | [Monaco LICENSE](https://github.com/microsoft/monaco-editor/blob/main/LICENSE.txt) |
| S05 | resizable panels의 layout·keyboard separator·MIT license 표기 | [react-resizable-panels](https://github.com/bvaughn/react-resizable-panels) |

외부 자료는 2026-10-16 열람 기준이며 최신 버전 설치·peer compatibility·취약점 검사를 대신하지 않는다. 다른 제품과의 기능 우열·비용 절감·상용 안정성을 증명하는 자료로 사용하지 않았다. 필요한 것은 선정 PR에서 다시 검증한다.

## 4. 제공된 리뷰 문서

F01: `agent-harness-mvp-spec_v1.1.pdf`, 2026-10-14.

- 1쪽: D&D와 실시간 개입을 제품 핵심으로 명시.
- 2쪽: 코딩·파일 동시 수정은 기존 MVP의 제외 범위였음.
- 3쪽: 설계 그래프/실행 호출 트리/협업 기록과 상태 소유 원칙.
- 8–9쪽: 작업·지시·설정의 앞방향 스티어링, 실행 중 graph 구조 변경 제외.

이번 개선은 이 합의를 보존하면서 코딩/파일 작업을 **새 단계의 제안**으로 연다. 과거 MVP가 이미 filesystem 도구를 포함했다고 재해석하지 않는다.

## 5. 핵심 설계 결정 (모두 제안 상태)

| ID | 결정 | 대안과 이유 |
|---|---|---|
| WB-ADR-01 | 사용자 탐색은 Project→Session→Run | 정의/Run만으로는 지속 목적의 재방문이 약함. 내부 execution은 상세로 유지 |
| WB-ADR-02 | Corral/Team과 RunInput 분리 | 매번 목적 수정으로 템플릿이 변하는 문제를 줄임. legacy adapter로 과거 해시 보존 |
| WB-ADR-03 | Workspace를 Project와 분리 | 같은 repo의 작업 복사본·파일 없는 프로젝트를 지원 |
| WB-ADR-04 | Result는 복수의 버전 참조 집합 | 단일 Markdown과 Git patch만의 두 극단을 피함 |
| WB-ADR-05 | native Git + 불변 파일 versions + 관리된 operation 기록 | Git diff 하나로 실행자 귀속·과거 결과를 모두 설명할 수 없음 |
| WB-ADR-06 | 기존 폴더는 먼저 관측만, 쓰기는 managed worktree | 큰 범위를 한번에 열지 않음. Git worktree의 보안 한계는 명시 |
| WB-ADR-07 | 기존 전역 단일 활성 Run 제한 유지 | Session UI와 병렬 쓰기를 동시에 바꾸지 않음. 향후 workspace writer lease로 확장 |
| WB-ADR-08 | Coordinator의 상태 확정 경로 유지 | WorkbenchService를 두 번째 Task/Run 상태 주인으로 만들지 않음 |
| WB-ADR-09 | 새 API와 schema reader는 additive/versioned | 기존 Run·artifact·deep link·보관 기록 보호 |
| WB-ADR-10 | Diff 의견은 batch·version·target에 고정 | 줄마다 자동 실행/최신 파일로 암묵 재부착을 방지 |
| WB-ADR-11 | 승인·반영·복원을 분리 | 취소=rollback, 승인=push 같은 오해를 방지 |
| WB-ADR-12 | Monaco·panel만 우선 추가 | UI 개선 때문에 ORM·런타임·desktop shell 전체를 갈아엎지 않음 |

## 6. 착수 전 확정·검증할 항목

기본안을 다음처럼 정하되, 실제 착수에서 확인한다.

- 첫 파일 쓰기 환경은 Git 기반 trusted managed worktree. 비Git 폴더는 우선 read-only/import다. 비Git 쓰기는 후속 별도 검토.
- 기본 시작 기준은 사용자 선택 commit. dirty overlay 자동 복사 기능은 첫 beta에 넣지 않는다.
- 사용자 결과 리뷰에서 일반 파일 단위 읽음·의견을 먼저 제공하고 hunk 적용/부분 stage는 미룬다.
- 첫 지원 OS는 기존 개발/CI 환경을 확인해 지정한다. 지원하지 않는 OS도 된다고 쓰지 않는다. file/path/process 취소 테스트가 통과한 OS만 쓰기 일반 제공.
- Monaco·panel의 도입 version/license/worker/CSP·기존 Node/React와 호환성은 dependency lock PR에서 확인.
- 기존 `.corral` DB를 app-data로 옮길지는 별도 사용자 동의. 자동 이동하지 않는다.
- scope·크기·성능 budget은 representative fixture 측정 후 정한다. 설계 목표와 측정 결과를 구분한다.

## 7. 알려진 제한

이 문서는 도입 후보를 정했지만 새 코드·schema·Git effect·browser interaction을 실행하지 않았다. read/compare 후 파일 교체는 비협조적 외부 writer와 완전 원자 CAS가 아니다. 실제 검증 명령은 임의 프로젝트 코드를 실행할 수 있다. DB와 filesystem 전체를 한 원자 transaction으로 묶을 수 있다고 가정하지 않는다. 이러한 경계를 지원 문서와 UI에 남기는 것이 이번 개선의 신뢰 계약이다.
