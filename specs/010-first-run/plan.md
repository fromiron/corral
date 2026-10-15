# 010-first-run — 데모 템플릿(A1)과 Run 화면 재구성(A2) 계획

> 상태: **승인됨(2026-10-15).** §6의 세 결정은 권장안으로 확정했다. A1(C-063, C-064)부터 진행한다.
> 기준: [제품 스펙](../../Corral-Spec-v0.1.md) §1.2·§4.1·§4.3·§4.4·§6, [009-demo-release](../009-demo-release/spec.md).

## 0. 목적과 범위

P9까지의 runtime은 위임·질문·검토 반려·승인·Steer를 모두 지원한다. 그런데 공개 데모와 Run 화면은 이 기능을 거의 보여주지 않는다.

- `/demo`의 기본 정의는 `Agent → Output` 하나다. 위임·질문·Loop·승인이 첫 실행에 나오지 않는다.
- `/runs/$runId`는 세로 한 줄짜리 문서다. 스펙 §4.1이 정한 그래프·실행 트리·Task Board·Timeline·Artifacts·Reins 구성 중 **그래프가 없다**.
- 데모 출력이 디버그 문자열(`inputs: brief@run_input directives: none …`)이다.

이번 변경은 **스펙을 바꾸지 않는다.** 이미 있는 요구(CRL-DEV-005, CRL-OBS-001, CRL-UX-001, CRL-UX-002)를 더 충실히 만족시키는 작업이다. 새 요구 ID를 만들지 않고 기존 테스트 ID를 사용한다.

**범위 밖:** 실행별 대화(transcript) 뷰(A3), Timeline 문장화·예산 미터 축약(A4), 한국어 locale, 새 provider/도구, runtime·contract·DB 변경. A2에서 화면 위치는 바꾸지만 각 패널의 내용 표현은 이번 범위가 아니다.

## 1. 태스크

| ID | 작업 | 요구 | 주요 파일 |
|---|---|---|---|
| C-063 | 데모 템플릿과 시나리오 응답 | CRL-DEV-005 | `apps/studio/src/demo/`, `demo.worker.ts`, `router.tsx` |
| C-064 | 데모 진행 가이드 | CRL-DEV-005, CRL-UX-001 | `apps/studio/src/demo/DemoGuide.tsx` |
| C-065 | 읽기 전용 Run 캔버스 | CRL-OBS-001, CRL-UX-002 | `packages/react/src/components/RunCanvas.tsx`, `NodeViews.tsx` |
| C-066 | Run 화면 레이아웃 재구성 | CRL-OBS-001, CRL-UX-001 | `apps/studio/src/pages/RunPage.tsx`, `packages/react/src/components/RunHeader.tsx` 외 |

`contracts/backlog.json`에 위 4개를 추가하고 `pnpm spec:check`를 통과시킨다.

## 2. A1 — 데모 템플릿

### 2.1 무엇을 바꾸는가

1. **영문 데모 템플릿** `apps/studio/src/demo/research-team.ts`. `examples/research-team.corral.json`과 같은 구조다(Research → Loop[Writer → Reviewer → Review Decision] → Final approval → Output, Research→Helper 위임, Writer→Responder 질문). 역할 이름·프롬프트·입력만 영어로 쓴다. 원본 예제는 contract 테스트가 쓰므로 수정하지 않는다.
2. **`/demo` 기본값을 이 템플릿으로 바꾼다.** 지금의 `Agent → Output`은 `/demo?template=starter`로 유지한다. 템플릿 선택 메뉴를 툴바에 둔다(Research team / Starter).
3. **역할별 시나리오 응답** `apps/studio/src/demo/script.ts`. `ScriptedAgentAdapter`의 `reply`에 넘긴다. role·round·입력 버전에 따라 그럴듯한 Markdown(조사 노트, 초안 v1/v2, 답변)을 만든다. **전달된 directive는 응답에 그대로 반영해** Steer 효과가 결과에 보이게 한다. 리뷰 JSON은 기존 `scriptedReview`를 그대로 쓴다(1회차 revise, 2회차 pass). 데모가 실제 LLM인 척하지 않도록 `Demo / Simulated agents` 배지와 응답 첫 줄의 "simulated" 표시는 유지한다.
4. 데모 지연 기본값을 시나리오 속도에 맞춰 조정한다(`?delay=`는 그대로 지원).

### 2.2 데모 진행 가이드 (C-064)

캔버스 옆에 접을 수 있는 체크리스트를 둔다. 모달 투어는 쓰지 않는다. 각 단계는 **commit된 projection에서만** 완료로 표시한다. UI 클릭만으로 완료 처리하지 않는다(AGENTS 5).

1. Run을 시작한다.
2. Research가 Helper 2명에게 위임했다 → 실행 트리에서 확인.
3. Writer가 질문했고 답을 받았다.
4. Reviewer가 1회차 초안을 반려했다 → **2회차 Writer에게 Steer해 보세요**(이 단계에서 해당 실행의 Steer 입력으로 바로 이동하는 버튼). Steer 범위는 선택한 실행 하나이므로(§8.1) 이미 제출된 1회차 초안에는 적용되지 않는다.
5. 2회차 초안이 통과했다 → Steer가 2회차 요청에 전달됐는지 확인.
6. 최종 승인 대기 → Approve 또는 Reject.

Run이 취소·실패·반려로 끝나면 남은 단계는 "이번 실행에서 일어나지 않음"으로 표시한다. 완료로 숨기지 않는다.

## 3. A2 — Run 화면

### 3.1 레이아웃 (1280px 이상)

```
┌ RunHeader: Corral 이름 · runId · 상태 배지 · 단계/Loop 회차/완료 필수 Task 수/활성 요청 수 · [Pause] [Cancel run] ┐
├ 실행 트리(좌, 접기 가능) ┬ 읽기 전용 캔버스(중앙) ┬ 컨텍스트 패널(우) ─┤
│                          │ 노드 상태·인스턴스 수  │ 승인 대기 > 선택 산출물 > Reins │
├──────────────────────────┴───────────────────────┴──────────────────────┤
│ 하단 탭: Output · Tasks · Questions · Activity(Timeline) · Budget           │
└──────────────────────────────────────────────────────────────────────────┘
```

- **헤더:** 스펙 §4.3대로 진행률(%)은 표시하지 않는다. Run 전체 Pause/Cancel은 헤더에만 둔다. 개별 실행 취소는 선택한 실행의 Reins 안에만 둔다(§4.4).
- **캔버스:** 노드에 활성/대기/완료 인스턴스 수를 표시한다. 노드를 클릭하면 그 노드의 실행 목록이 열리고, 하나를 고르면 `?execution=`이 바뀐다. 실행 트리에서 고르면 해당 노드를 강조한다. capability link는 허용 관계일 뿐이므로 호출이 일어난 것처럼 표시하지 않는다(§5.2).
- **우측 패널:** 승인 요청이 열려 있으면 맨 위에 둔다. 그 아래에 `?artifact=` 산출물, 그 아래에 선택 실행의 Reins를 둔다.
- **Run이 성공하면** 하단 탭이 Output으로 열리고 최종 산출물이 Markdown으로 보인다.
- **1280px 미만:** 중앙·우측을 탭(Graph / Details)으로 전환한다. 헤더의 Pause/Cancel은 어느 폭에서도 가려지지 않는다.

### 3.2 캔버스 레이아웃의 출처 — 결정 필요

Run 스냅샷에는 정의만 있고 레이아웃이 없다(`getRunDefinition`).

- **(권장) 저장소의 현재 레이아웃 + 자동 배치 fallback.** `repository.get(corralId)`의 레이아웃에서 스냅샷 노드 ID와 일치하는 좌표만 쓴다. 없는 노드는 control edge 기준으로 단순 계층 배치한다. 레이아웃은 실행 의미가 아니므로(§4.2) 스냅샷과 달라도 기록을 왜곡하지 않는다. 화면에 "Layout from the current Corral" 같은 문구를 둔다. contract 변경이 없다.
- 대안: Run 시작 시 레이아웃 스냅샷도 저장한다. 정확하지만 start 명령·SQLite·export 계약을 바꾸므로 CR이 필요하다.

### 3.3 구현 메모

- 지금 `CorralCanvas`는 editor store에 묶여 있다. 노드 뷰(`NodeViews.tsx`)는 그대로 재사용하고, `RunCanvas`는 `definition + layout`을 props로 받는 읽기 전용 컴포넌트로 분리한다. 드래그·연결·삭제·키보드 편집은 끈다.
- 노드 상태는 지금처럼 노드별 selector(`nodeRunStatus`)로 구독한다. 스트림 프레임이 캔버스를 다시 그리지 않아야 한다(CRL-UX-002).
- 에디터의 `/demo` 화면 오른쪽 패널(RunView + Reins)은 그대로 둔다. 실행 중에도 "Open run page"로 새 화면에 갈 수 있다.
- 기존 E2E가 쓰는 `run-status`, `run-output`, `execution-*`, `live-text`, `Reins` region 이름은 유지한다.

## 4. 테스트 (구현 전에 실패를 확인)

| 테스트 ID | 종류 | 정상 | 반례 |
|---|---|---|---|
| TC-DEV-005-H | unit | 데모 템플릿이 `compileDefinition`을 통과하고 위임·질문 링크, Loop, 승인을 포함하며 레이아웃이 모든 노드를 덮는다 | — |
| TC-DEV-005-H | E2E | `/demo`(offline)에서 Run → Helper 2개가 Research 아래에 표시, 질문·답변, 1회차 revise, 2회차 pass, 승인 후 Succeeded. 네트워크 요청 0 | — |
| TC-DEV-005-N | E2E | 2회차 Writer 실행의 첫 요청 중 Steer → 그 실행의 다음 요청과 최종 출력에 directive가 반영되고, 이미 끝난 1회차 Writer 응답에는 없다 | 승인 Reject → Succeeded가 아님. 중간 Run 취소 → 가이드의 남은 단계가 완료로 표시되지 않음 |
| TC-OBS-001-H | E2E | Run 화면 캔버스의 노드 상태·인스턴스 수가 projection과 일치(Writer 2회). 노드 클릭 → 실행 목록 → `?execution=` 설정 → Reins 대상 일치. 새로고침 후 선택 유지 | — |
| TC-OBS-001-N | E2E | 존재하지 않는 `?execution=`은 "찾을 수 없음"으로 표시하고 다른 실행을 대상으로 삼지 않는다. 저장소 레이아웃이 없거나 노드가 빠져도 스냅샷의 모든 노드가 보인다. 캔버스에서 드래그·Delete가 정의를 바꾸지 않는다 | — |
| TC-UX-002-H/N | unit | 스트림 프레임 수신 중 `RunCanvas` commit 수 0(기존 render-budget 테스트 확장) | — |
| TC-UX-001-H/N | E2E·axe | Run 화면 axe 위반 0, 탭/패널 키보드 이동, 1280·1024px에서 Pause/Cancel 보임 | — |

기존 데모 E2E 3개는 URL만 `/demo?template=starter`로 바꾸고 **단언은 그대로 둔다.** `pnpm release:gate`와 `pnpm test:performance`를 다시 실행해 결과를 기록한다(성능 fixture는 `CorralCanvas`·`RunView`를 직접 쓰므로 영향 여부를 확인한다).

## 5. 순서와 추정

| 순서 | 내용 | 추정 |
|---|---|---:|
| 1 | backlog 등록, 실패하는 unit/E2E 작성 | 3–4h |
| 2 | C-063 템플릿·시나리오 응답·`?template=` | 4–6h |
| 3 | C-064 가이드 | 3–5h |
| 4 | C-065 RunCanvas 분리·레이아웃 fallback | 5–8h |
| 5 | C-066 RunPage 레이아웃·헤더·하단 탭·반응형 | 6–10h |
| 6 | 기존 E2E·axe·성능·release gate, 스크린샷 증거 | 3–4h |
| | **합계** | **24–37h** |

A1(1–3)만 먼저 PR로 낼 수 있다. A2는 A1의 템플릿이 있어야 의미 있는 화면 검증이 되므로 그 뒤에 둔다.

## 6. 결정 (2026-10-15 확정)

1. `/demo` 기본값을 Research team으로 바꾸고 기존 데모는 `?template=starter`로 옮긴다.
2. Run 캔버스 레이아웃은 저장소 레이아웃 + 자동 배치 fallback으로 하고 contract는 바꾸지 않는다.
3. 데모 템플릿 언어는 UI와 같은 영어로 한다. 한국어는 locale 작업에서 함께 한다.

## 7. 구현 메모 (A1)

- `ScriptedAgentAdapter`는 위임·질문·답변 결과를 `notes`로 모아 마지막 응답 뒤에 원문 그대로 붙인다(`read artv_…`, `answer: …`). 데모가 이 내용을 문장으로 쓰도록 `reply`에 `notes`를 넘기고, `appendNotes: false`로 덧붙이기를 끌 수 있게 한다. 기본값은 지금 동작을 유지한다.
- 기본 속도(요청당 1.5초)에서는 2회차 Writer가 Steer 버튼이 나타난 뒤 3–4초 안에 끝나 직접 써보면 놓치기 쉬웠다. 가이드에 opt-in 체크박스 "Pause the run when the round 2 Writer starts"를 두었다. 체크하면 2회차 Writer가 시작될 때 일반 `pause` 명령을 Coordinator로 보내고 Reins 대상을 그 실행으로 맞춘다. 자동 승인·자동 지시는 하지 않는다.
- Responder는 질문 하나에 요청 1회만 하므로 데모 응답은 질문 배정이면 1회차를 최종 응답으로 쓴다.
- 캔버스는 저장된 viewport(`draft.viewport`)를 처음 열 때 적용한다. 기존 Corral의 기본값 `{0,0,1}`은 그대로이고, 데모 팀은 1280px에서 전체가 보이도록 zoom 0.75를 쓴다.

## 8. 검증 기록 (A1, 2026-10-15)

| 검사 | 결과 |
|---|---|
| 새 테스트를 구현 전에 실행 | unit(testkit 1, studio 모듈 없음)·E2E 5개 실패 확인. 기존 데모 E2E 3개는 `?template=starter`에서 통과 |
| `pnpm test` | 462 passed (68 files), 이후 studio/testkit/react 재실행 119 passed |
| `pnpm exec playwright test` chromium·firefox·server | 54 passed |
| `pnpm build`, typecheck, `biome check .` | 통과 |
| `pnpm spec:check` | pack validation PASS (763 checks), 112/112 시나리오 태그 |
| 브라우저 수동 확인(1280×800) | 기본 속도에서 체크박스로 2회차 Writer 시작 시 Paused, Steer 단계 Now 확인 |

`pnpm release:gate`와 `pnpm test:performance`는 아직 실행하지 않았다. A2 후 함께 실행한다.
