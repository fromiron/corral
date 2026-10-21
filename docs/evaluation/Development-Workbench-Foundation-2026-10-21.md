# 개발 Workbench 기반 구현·qualification — 2026-10-21

- 기준: `071276873dee4bb51491bf608e604fbb4e123475`, 계획/계약 commit `9a7a8aa`. 구현 후보는 이 기록을 포함한 commit의 tree로 식별한다.
- 범위: CR-046 / CRL-WBD-001 / C-142 진행·C-143 구현 / TC-WBD-001-H,N,F. [계획](../plans/workbench-development-implementation-plan-2026-10-21.md).
- 환경: Linux x64, Node 24.19.0, pnpm 10.30.3. 임시 SQLite/Git와 격리 fixture를 사용했다. 기존 4317 서버·사용자 DB·credential은 변경하지 않았다.

## 구현과 회귀

`workspace_access` 하나로 기존 Run과 사용자 작업의 writer 예약을 통합했다. Run API는 adapter로 유지하고 사용자 operation은 가짜 Run 없이 별도 receipt를 기록한다. 같은 ID/같은 요청은 원래 결과를 반환하고 접수·완료와 예약 변화는 같은 transaction이다. 재시작/불확실 상태는 늦은 완료로 해제하지 않는다.

schema 29는 기존 active/uncertain/released 예약과 pinned reader tree를 보존한다. 사본 row가 없는 orphan 예약도 LEFT JOIN으로 유지한다. canonical path만 writer uniqueness에 사용해 다른 generation으로 불확실 소유자를 우회하지 못한다. 이전 schema 28 fixture와 닫힌 DB backup 보존을 확인했다.

WorktreeView와 demo/client에 bindingId·copyGeneration을 연결했고 재생성 시 증가한다. active/uncertain reader도 사본 제거를 막는다. 제거와 Run acquire가 겹치면 Coordinator가 해석하는 ToolRefusal 충돌을 돌려준다. 외부에서 사라진 사본의 기존 제거 동작은 유지한다. worker recovery는 Run 예약만 해제한다. manual LSP 적용과 검사 준비는 공통 writer를 확인한다. 검사는 기존 별도 고정 검사 사본을 사용한다.

실제 red 확인:

- 기존 Run adapter가 동일 ID의 다른 generation을 허용; schema 28 upgrade에 generation 열 없음.
- WorktreeView identity 없음; active reader 중 사본 제거 성공.
- 사용자 writer 중 manual LSP apply/verify 성공; missing 사본 제거의 새 ENOENT 회귀.
- 새 receipt 모듈 부재; receipt 저장 실패 transaction/재시작 시나리오를 먼저 선언.
- 읽기 전용 리뷰가 발견한 삭제 중 acquire의 WorkspaceError를 Coordinator가 STORAGE_UNAVAILABLE로 바꾸는 오류: 기존 시험을 ToolRefusal 검증으로 강화해 red 후 수정.

검증 명령은 아래 모두 Node 24.19.0 PATH를 사용한다.

| 명령/범위 | 결과 |
|---|---|
| `pnpm exec vitest run apps/server/test/workbench-operations.test.ts apps/server/test/workspace-access.test.ts packages/storage-sqlite/test/workbench-migration.test.ts packages/storage-sqlite/test/sqlite.test.ts apps/server/test/command-broker.test.ts apps/server/test/workspace-ownership.test.ts packages/core/test/coordinator-store.test.ts --maxWorkers=2` | 7 files / 77 tests PASS |
| `pnpm exec vitest run apps/server/test/files.test.ts apps/server/test/concurrent-files.test.ts --maxWorkers=2` | 최종 ToolRefusal 수정 후 2 files / 49 tests PASS |
| `pnpm typecheck` | 15 workspace packages와 tools/live 타입 검사 PASS |
| `pnpm spec:check` / `pnpm contracts:check` / `pnpm deps:check` | 문서 2352 checks·304/304 tags / generated schema / dependency review PASS |
| 변경 신규 store/migration/tests Biome, `git diff --check` | PASS. 기존 service의 경고를 일괄 수정하지 않음 |

새 E2E와 시간 성능 기준을 추가하지 않았다. 이번 126개는 서로 다른 9개 파일의 관련 회귀이며 중간 재실행을 중복 합산하지 않았다. 문서/계약 검사는 제품 통합·출시 검증과 구분한다.

현재 사용자 save/PTY/Git 공개 API는 아직 없다. 따라서 이 기반 통과를 사용자 코드 편집 기능 완료로 표시하지 않는다. WorkbenchOperations 호출자는 신뢰·target generation·path를 먼저 해석해야 하며 P04에서 실제 저장 경로에 연결한다. uncertain 사용자 operation의 복구 UI도 후속이다.

## A: 기존 셸 + 공개 엔진 fixture

격리 경로 `/tmp/corral-workbench-frontend-qualification`, exact lock/metadata/보고서와 `iab-language.png`를 보존했다. 저장소 manifest/lockfile에는 새 엔진을 추가하지 않았다.

- Dockview와 dockview-react 8.6.1, Monaco 0.57.0, 기존 React 19.3.1. 모두 MIT이며 Monaco의 bundled notice는 별도 보존 대상이다.
- 설치·TS 6.0.3 타입 검사·Vite 8.3.4 production build PASS. Corral Studio와 같은 CSP에서 실제 인앱 브라우저를 사용했다.
- 두 view의 shared model, dirty 편집→배치 저장/이동/복원→undo clean→redo dirty, 두 view 닫기(모델 2/editor 0)→재열기(모델 2/editor 2), 20개 임시 모델 dispose 후 baseline 2 확인.
- 실제 TypeScript worker 5.9.3가 math.ts의 add 정의와 TS2322 진단을 반환했다. 이는 주어진 fixture 모델의 언어 동작이며 현재 프로젝트 tsconfig 탐색/host LSP 통합 증거가 아니다.
- 전체 entry baseline main JS 4,596,060 bytes(gzip 1,177,970), TS worker 6,928,036 bytes. 제품 통합에서는 editor/language를 지연 로드하고 대화 초기 경로에 전체 엔진을 넣지 않는다.
- 공개 React binding은 `dockview-react`이며 Monaco 타입 API는 `monaco.typescript`다. 내장 keyboard docking은 Enterprise; 공개 moveTo/focus API를 일반 명령에 연결한 fixture만 시험했다. 새 DnD 엔진은 만들지 않았다.
- Monaco의 vendored DOMPurify 3.4.15에 low advisory 2개. 확인한 sanitizer 호출은 IN_PLACE를 쓰지 않았지만 완전한 보안 검토는 아니다. dependency override만으로 vendored source가 바뀐다고 주장하지 않는다.

공식 근거: [Dockview licence](https://dockview.dev/docs/overview/licence/), [keyboard](https://dockview.dev/docs/advanced/keyboard/), [Monaco v0.57.0](https://github.com/microsoft/monaco-editor/tree/v0.57.0), [advisory 1](https://github.com/cure53/DOMPurify/security/advisories/GHSA-p98j-92pf-mc4p), [advisory 2](https://github.com/cure53/DOMPurify/security/advisories/GHSA-6688-9rhm-gjv2).

## Native PTY qualification

격리 경로 `/tmp/corral-workbench-pty-qualification`에 probe/cleanup/capacity 스크립트와 JSON 결과·lock·integrity/hash를 보존했다.

- stable node-pty 1.1.0, xterm/headless 6.0.0, serialize 0.14.0 (MIT). Linux source build와 실제 Node 24.19(ABI 137)에서 stdin·Unicode·101×37 resize·ANSI/alt screen·명시 exit PASS.
- 같은 native binary를 Electron 44.4.5 RUN_AS_NODE(Node 24.21, ABI 149)에서도 시험했다. 실제 제품은 Electron main이 아니라 bundled Node 24.19 sidecar에서 native 의존성을 로드한다. 설치판 UI 검증과 구분한다.
- 기존 공유 capacity primitive에서 12개 예약/13번째 거절/확인된 release 뒤 재접수 PASS. PTY 제품 통합 완료는 아니다.
- 재현된 제한 1: `BASE\r\n\x1b[3`을 serialize 후 tail `1mRED`를 붙이면 원본 RED와 복원된 1mRED가 다르다. serialize는 미완료 escape parser 상태를 보존하지 않는다.
- 재현된 제한 2: interactive bash의 background sleep은 다른 PGID/같은 SID였다. 기존 shell group kill 후 sleep이 살아남았다. 정확한 테스트 child는 별도로 종료 확인했다. P07에서 세션/job 소유 종료와 replay 한계를 해결해야 한다.
- node-pty Linux native binary 75,888 bytes이나 npm tarball unpacked는 다른 플랫폼 prebuilts를 포함해 64,363,742 bytes다. 둘을 패키지 비용으로 혼동하지 않는다. 해당 격리 production dependency audit은 알려진 advisory 0건이며 전체 보안 보증이 아니다.

공식 근거: [node-pty v1.1.0](https://github.com/microsoft/node-pty/blob/v1.1.0/README.md), [xterm security](https://xtermjs.org/docs/guides/security/). headless/serialize tarball에 별도 LICENSE 파일이 없어 제품 배포 시 같은 upstream commit의 MIT notice를 함께 보존한다.

## B: Theia 비교

격리 경로 `/tmp/corral-workbench-theia-u3qalj4f`에 설치/빌드/언어/파일/PTY 결과와 `COMPARISON.md`, audit, exact metadata를 보존했다.

- Theia 1.76.0의 browser shell 설치·빌드 성공. 실제 Corral SettingsPage/CorralCanvas/ReinsPanel을 ReactWidget에 넣었고 인앱 브라우저에서 세 화면 전환을 확인했다. renderer fixture store만 사용했고 별도 Coordinator·DB는 만들지 않았다.
- 임시 bridge의 CommonJS __esModule 누락으로 첫 frontend start가 실패했다. upstream 형식으로 고친 뒤 실제 ready 상태를 확인했다. CLI 실행 수명 종료가 추가로 발생해 생성된 backend를 독립 실행했다. 이 두 fixture 문제를 라이브러리 자체의 불가능 판정으로 사용하지 않는다.
- 실제 브라우저에서 main.ts를 열어 주석 입력→Ctrl+S→독립 disk readback으로 저장을 확인했다. Terminal 메뉴로 만든 PTY에서 PTY-IAB-OK와 `stty size` 20 168 출력 확인.
- Node fixture는 F5로 첫 줄 stopOnEntry의 노란 정지 표시와 Continue 동작을 확인하고, F5 후 Debug Console의 Hello Corral·Stopped를 확인했다. 실제 DAP startup/continue 증거이며 사용자 breakpoint·전체 stack/변수 기능 검증은 아니다. `iab-debug-paused.png`와 `iab-terminal.png`를 보존했다.
- 기본 filesystem/terminal/pluginhost는 Corral writer/권한 경로를 통과하지 않는다. 도입 시 provider/process adapter와 공유 React context/route/focus 전략이 필요하다. 임시 bridge의 포커스 복귀 경고는 아직 남아 있다.
- React 19/Node 24 호환. @theia/electron의 Electron peer는 42.8.1로 Corral 44.4.5와 다르다. stable Theia가 node-pty 1.2.0-beta.12와 xterm 5.3을 전이 의존한다.
- Theia 핵심 라이선스는 EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0이며 MIT 라이브러리와 동일 취급하지 않는다. 전체 dev+prod audit의 61개 advisory 경로는 실제 도달성 판정이 아니다. shipping 전 별도 심사가 필요하다.

공식 근거: [Theia v1.76.0](https://github.com/eclipse-theia/theia/releases/tag/v1.76.0), [extensions](https://theia-ide.org/docs/authoring_extensions/), [builtins](https://github.com/eclipse-theia/vscode-builtin-extensions/releases/tag/1.108.2).

## 다음 범위와 한계

첫 구현은 기존 셸의 권한·설정 수명을 재사용하는 A를 우선 검토한다. B의 실행 가능성을 확인했지만 엔진 자체가 Corral의 owner 계약을 대신하지는 못한다. G0 전체 통과·최종 dependency 채택은 아직 선언하지 않는다.

실제 사용자 파일 save UI, PTY 복구/후손 종료 통합, 도킹 전체 이관, 물리 IME·screen reader, Windows/macOS/ARM64, 설치판·remote-host·외부 Git·유료 provider는 미검증이다. 기존 제품 서버를 재시작하지 않았으며 push/PR/merge도 하지 않았다. DB rollback은 서버를 종료한 뒤 업그레이드 전 backup과 호환 binary를 함께 복구하는 절차다.

## 기반 결정 후속 — ADR-040

A/B qualification을 위 pass/fail/unknown 근거로 마무리하고 기존 셸에 공개 엔진을 연결하는 A를 선택했다. C-142는 기반 비교/계약 결정 태스크로 완료하며 실제 편집/PTY/도킹 기능 또는 모든 플랫폼 지원의 완료로 취급하지 않는다. P07의 ANSI parser·후손 종료, P06의 worker/보안 inventory·지연 로딩, P10의 키보드 배치 및 P29의 설치판 검증은 그대로 남아 있다. 결정 이유는 [ADR-040](../Decisions.md)에 기록했다.
