# UI 마스터플랜 v1.1에서 남긴 것: 작업 계획

"Pi Native ADE 통합 아키텍처 및 UI 실행 마스터플랜 v1.1"(저장소에 없다. UI-01~08, D01~D12, PR 1~6으로 된 원안)을 2026-11-26에 `develop` @ `b57445d3`의 코드와 명세에 대조했다. 원안은 코드 식별자는 맞게 인용했지만 [명세](../specs/README.md)를 읽지 않아, 이미 있는 화면을 새로 만들고 이미 뺀 것을 다시 넣는 항목이 대부분이었다. 이 계획은 그 대조에서 남은 것만 싣는다. 만들 것은 둘이고 관문만 확인할 것이 하나다.

이 문서는 승인이 아니다. 단계는 사용자가 요청할 때 시작한다. 단계는 서로 기대지 않으므로 각자 그때의 `develop`에서 분기한다. 단계마다 명세 → 실패하는 테스트 → 구현 순서이고 `pnpm lint`, `pnpm typecheck`, 관련 테스트를 돌린다. 계약 타입을 바꾸면 `pnpm contracts:check`도 돌린다. E2E는 건드린 스펙만 돌린다.

| 단계 | 내용 | 상태 |
|---|---|---|
| A | 변경 검토의 실행별 묶음 | 만들었다. `feat/review-run-groups`에 있고 `develop`에 합치지 않았다 |
| B | 추천 패키지 목록 | 시작 전. 관문 B0이 먼저다 |
| C | 주석의 소스 위치 | 관문만. 통과하면 따로 계획한다 |

## 사용자가 정한 것 (2026-11-26)

- 대조의 판정대로 이 계획을 다시 쓴다. 원안의 PR 6개는 쓰지 않는다.

## 조정자가 정한 것 (2026-11-26)

사용자가 따로 정하지 않았다. 다르게 정하면 바꾼다.

1. [하지 않는 것](#하지-않는-것)의 항목은 표에 적은 이유가 바뀌기 전에는 다시 제안하지 않는다.
2. 새 저장소, 새 상태 계층, 분류·계측을 위한 LLM 호출을 만들지 않는다는 원안의 원칙은 그대로 따른다.
3. 이 계획은 원안이 붙인 이름(Story, Decision Inbox, Oracle, Dispatch, Surgery, Design Guard, Point & Speak 등)을 쓰지 않는다. 화면의 말은 각 단계의 명세가 [용어집](../specs/glossary.md)에 맞춰 정한다. A는 "실행별 묶음"이라 부른다.

## A. 변경 검토의 실행별 묶음

원안 UI-05(Story Hunk)에서 남긴 것이다. 동작과 계약은 [변경 검토의 실행별 묶음](../specs/features/review-run-groups.md)이 정한다. 이 절은 진행만 적는다.

### 한 것

- 명세: 새 기능 명세를 쓰고 [명세 지도](../specs/README.md), [API 계약](../specs/api-contract.md), [Workbench](../specs/workbench.md)에서 잇는다.
- 서버: `apps/server/src/files/service.ts`의 `changes()`가 `group=run`을 받아 파일마다 실행을 싣는다. 클라이언트는 `packages/client/src/index.ts`다.
- 화면: `apps/studio/src/pages/changes/ReviewPage.tsx`가 대화 전체 범위에서 묶음을 그린다. 묶는 규칙은 `apps/studio/src/workbench/changeGroups.ts`다.

### 명세를 쓰며 조정자가 정한 것

사용자가 따로 정하지 않았다. 다르게 정하면 바꾼다.

1. 묶음은 조회가 청할 때만 싣는다(`group=run`). 파일 탭과 첨부 확인처럼 묶음을 보이지 않는 조회의 비용이 늘지 않게 한 것이다.
2. 비교 범위 선택에서 다른 실행 항목을 뺐다. 묶음의 머리와 대화의 변경 링크가 그 길이다. 묶음과 따로 되돌릴 수 있는 결정이다.
3. 출처 표시의 도움말을 "명령이나 Corral 밖에서 바뀜"으로 바꿨다. 에이전트의 셸 명령이 바꾼 파일도 그 표시를 받으므로 "Corral이 바꾸지 않음"은 맞지 않는다.
4. 구간의 경로 집합을 기억한다(tree 쌍마다, 1,000개까지). 재고 나서 뒀다. 실행 60개인 세션에서 묶지 않은 조회가 약 30 ms일 때 묶은 첫 조회가 약 320 ms였고, 기억한 뒤 다시 읽으면 약 31 ms, 파일을 하나 더 고친 뒤에는 약 33 ms다. 한 기기에서 한 번 잰 값이다.

### 확인한 것

- `pnpm lint`, `pnpm typecheck`, `pnpm contracts:check`가 통과한다. 계약 검사는 `packages/contracts`의 스키마를 보므로 이 조회의 모양은 다루지 않는다.
- 서버의 `files.test.ts`와 `server.test.ts`, Studio의 `pages/changes`, `changeGroups.test.ts`, `FilePanel.results.test.tsx`, `RunChanges` 테스트가 통과한다. 묶음의 반례(셸 명령만으로 바뀐 파일, 실행 사이의 변경, 실행 뒤에 다시 고친 파일, 겹쳐 돈 실행, 두 tree가 없는 실행, 진행 중인 실행, 막 끝난 실행, 되돌린 파일, 추가 · 삭제 · 바이너리 · 이름 변경, 지금 사본보다 앞선 실행)가 거기 있다.
- E2E는 검토 목록을 쓰는 두 자리만 돌렸고 통과한다: `e2e/server/files.spec.ts`, 그리고 `e2e/server/desktop-capabilities.spec.ts`에서 목록의 두 행을 고르는 테스트.
- 모델 없는 서버와 Vite로 실제 화면을 걸었다(1280x800, 영어, 포인터). 대화 옆 456px, 넓힌 1016px, 가장 좁은 360px 패널에서 묶음 셋이 새 실행부터 놓이고, 세 묶음에 든 파일의 세 행이 함께 고른 것으로 보이고, 묶음의 머리가 그 실행 범위를 연다. 360px에서 목록이 좌우로 넘치지 않는 것을 쟀다. 다른 폭은 재지 않고 화면만 봤다.
- 화면에서 걷지 않고 테스트로만 본 것: 다음 · 이전 파일 이동, 찾기 · 종류 · 검토하지 않은 것만 보기, 생성 · 잠금 파일의 접힌 묶음, 묶음이 하나일 때의 묶지 않은 목록, 읽음 기록 이후 범위, 겹쳐 돈 실행과 진행 중인 실행, 한국어 문구.

### 남은 것

- 전체 E2E는 돌리지 않았다.
- 실행 묶음 아래의 행은 대화 전체의 상태와 줄 수를 보인다. 실행 #2가 두 줄을 지운 파일이 "실행 #2" 아래에서 `A +1`로 보이므로, 그 실행이 파일을 더했다고 읽힐 수 있다. 명세대로지만 써 보고 정할 일이다.
- 실행 묶음의 머리는 버튼인데 누를 수 있다는 표시가 "실행 밖"의 글자와 다르지 않다.
- [Workbench](../specs/workbench.md)와 [API 계약](../specs/api-contract.md)은 `external_observed`를 "Corral이 바꾸지 않음"이라고 적는다. 에이전트의 셸 명령도 그 값을 받으므로 명세의 말이 코드보다 좁다. 화면의 도움말만 고쳤고 그 두 문장은 사용자가 정할 때까지 그대로 뒀다.
- 걷는 동안 diff 하이라이트 워커가 `Theme "pierre-dark" has not been resolved`를 콘솔에 남겼다. 묶지 않는 실행 범위만 열어도 남고 diff는 그려진다. 이 단계가 건드리지 않은 코드이고, 앞선 revision과 견주지 않았다.
- 대화 옆의 좁은 패널에서는 접힌 목록의 높이가 정해져 있어 묶음의 머리만큼 한 번에 보이는 행이 준다.

## B. 추천 패키지 목록

원안 UI-07에서 남긴 것이다. 신뢰와 활성의 분리, 해시별 신뢰, 고정 버전 `npm:` · git 가져오기, Pi 홈 가져오기는 이미 있다([Harness 계약](../specs/harness-contract.md#h3-리소스역할ui)). 없는 것은 무엇을 가져올지 알려 주는 목록이다.

### 관문 B0 (코드 전, 읽기와 시험만)

후보 패키지마다 아래를 확인하고 결과를 이 계획에 적는다. 통과한 것만 목록에 든다. 하나도 통과하지 못하면 이 단계를 접는다.

1. 패키지가 실제로 있고, 고정할 버전과 라이선스가 확인된다.
2. 그 버전이 검토 → 설치 → 신뢰 → 활성 → 실행까지 실제로 된다.
3. 그 실행에 `unsupported` 알림이 남았는지, 남았다면 어느 UI API인지.

확장은 Worker의 OS 권한으로 도는 남의 코드다. 그래서 2의 내려받기와 실행은 사람이 하고, 에이전트는 남은 실행 기록을 읽어 3을 적는다. 원안의 후보 이름(`@juicesharp/rpiv-ask-user-question`, `@juicesharp/rpiv-todo`, `@plannotator/pi-extension`, `pi-web-access`)은 실재를 확인하지 않았다.

### 만들 것

- 패키지 화면(`apps/studio/src/workbench/harness/PackageManager.tsx`)에 추천 목록을 둔다. 항목은 이름, 한 줄, 고정 버전의 source 문자열이다. 고르면 source 칸이 채워지고 지금의 검토 흐름으로 간다. 자동 설치와 자동 신뢰는 없다.
- 목록은 서버가 싣는 정적 자료 하나다. Pi SDK나 패키지의 버전을 올릴 때마다 B0을 다시 해야 하므로 짧게 시작한다.
- 이미 Corral이 하는 일을 대신하는 확장(MCP 어댑터, 서브에이전트, 구독 라우터 등)은 목록에 넣지 않는다.

### 만들지 않는 것

패키지 카드에 "관측된 미지원 UI API"를 자동으로 보이는 것. 알림(`ExtensionUiNotice`)은 어느 확장이 불렀는지 담지 않는다. 한 세션의 확장들이 UI 컨텍스트 하나를 나눠 쓰기 때문이다(`packages/adapter-pi/src/sdk-worker.ts`의 `bindExtensions`). 목록의 미지원 표기는 B0에서 사람이 적은 값이다. 실행 화면의 알림은 지금대로 둔다.

## C. 주석의 소스 위치 (관문만)

원안 UI-03에서 이미 없는 것은 "고른 요소의 소스 위치" 하나다. 이동 세대, 보내기 직전의 재확인, 입력 칸 가림, 콘솔, 첨부는 [브라우저 주석](../specs/features/browser-annotate.md)에 있다. 지금 주석이 보내는 요소 자료(`packages/contracts/src/page-annotation.ts`)는 태그, 이름표, 역할, 선택자, 글, 자리, 스타일이고 소스 위치는 없다.

관문: 미리보기 페이지에서 고른 요소의 소스 파일과 줄을 프로젝트에 의존성을 더하지 않고 얻을 수 있는 경우가 얼마나 되는지 읽기만으로 확인한다. 프레임워크마다 길이 다르다. 통과하지 못하면 접고, 뜻이 다른 작은 것을 대신 만들지 않는다. 에이전트는 지금도 선택자와 글로 소스를 찾는다.

## 하지 않는 것

| 원안 | 하지 않는 이유 | 이미 있는 곳 |
|---|---|---|
| UI-01 전체 활성 Run의 Decision Inbox | 모든 프로젝트의 대기 요청을 모아 같은 화면에서 기존 패널로 답하는 화면과 사이드바 배지가 있다. 인스펙터에 모든 Run을 실시간으로 띄우면 Run마다 store와 이벤트 재생이 든다 | [확인 필요](../specs/features/inbox.md) |
| UI-02 Context Inspector의 4단계 출처 | provider 보고값과 추정 분해를 섞지 않고 부분 측정과 누락 사유를 가르는 계약이 있다. 판정 기록(장치, 시간, fallback)도 보인다. 이름만 바꾸는 일이다 | [채팅 위젯 계약](../specs/chat-widgets-contract.md#42-contextinspector의-정보-계층), [추론 판정](../specs/features/effort-routing.md) |
| UI-04 계획 승인 단계 | 계획의 revision은 있다. 승인 관문을 기본으로 두지 않는다는 결정(2026-11-11)과 반대다. 작업 계획은 활동 바의 Todo에서 읽는다 | [채팅 위젯 계약](../specs/chat-widgets-contract.md) |
| D03 Dispatch · Canvas · Surgery 레이아웃 프리셋 | 틀과 패널 상태 다섯, 탭의 기억이 정해져 있다. 프리셋은 한두 번 누르는 일에 이름을 붙이는 것이고, 패널 폭을 앱에 하나로 기억하는 규칙과 맞지 않는다. Plan 탭은 없고 "Canvas"는 팀 편집기의 이름이다 | [세션 패널](../specs/features/session-panel.md) |
| D04 Sprint · Verified · Ultra · Custom Corral 실행 프리셋 | Ultra는 제거됐다. 입력창에서 요청 옵션을 고르지 않는다. 팀 없음과 저장한 Corral은 팀 칩에 있고, 요청별 추론과 판정 엔진 설정은 이미 다른 화면이다 | [모델과 리소스](../specs/models-and-resources.md#ultra-제거), [채팅 위젯 계약](../specs/chat-widgets-contract.md) |
| D11 Corral 안에서 디자인 스킬의 Python 스크립트 전환 | 제품 코드에 Python을 띄우는 경로가 없다. 스크립트 17개는 upstream을 바이트 그대로 싣는 묶음의 것이라 여기서 고치면 고정한 커밋과 갈라진다. `zod`는 서버의 의존성이라 에이전트의 셸에서 따로 도는 스크립트가 쓸 수 없다 | [기본 제공 묶음](../specs/features/builtin-crew.md), [NOTICE](../../apps/server/resources/builtin/design/NOTICE.md) |
| UI-06 Paddock 준비의 3구간 계측 | Paddock 만들기는 `git worktree add` 한 번이다. `files/`, `preview/`, 계약에서 의존성 준비 단계를 찾지 못했다. 잴 구간이 없다 | |
| UI-08 Design Guard 규칙 화면, D12 PR 증거 내보내기와 디자인 패키지 분리 | 필수 검사의 통과는 `packages/core/src/design-review.ts`가 이미 확인한다. 규칙을 설정하는 화면이 푸는 문제가 확인되지 않았다. 미룬다 | [풀 리퀘스트](../specs/features/pull-requests.md) |

원안의 D01, D02, D10은 지금 코드와 원칙을 적은 것이라 할 일이 없다. D05는 B가, D08은 A와 C가, D06 · D07 · D09는 위 표의 UI-06 · UI-02 · UI-08 행이 다룬다.

## 이 계획 밖의 후보

대조하다 드러난 것이다. 원안에 없던 일이므로 사용자가 따로 요청해야 시작한다.

- **Paddock 준비 명령.** 새 사본에는 의존성이 없다. 계측이 아니라 사본을 만든 뒤 한 번 도는 준비 명령이 필요한지를 정할 일이다. 먼저 새 Paddock에서 미리보기 시작이 어떻게 실패하는지 본다.
- **디자인 스킬 스크립트의 런타임.** 바꾸려면 upstream(`leeskills`)에서 바꾸고 고정 커밋을 올린다. 깨끗한 운영체제에는 Python도 Node도 PATH에 없을 수 있으므로 언어를 바꾸는 것만으로는 풀리지 않는다.
- **릴리스 도구의 Python.** `tools/release/inventory.ts`가 `jsonschema`를 쓴다. 제품이 아니라 릴리스 절차의 의존이다.
- **패널 지름길.** "변경을 넓게", "브라우저 열기" 같은 한 번의 조작이 필요하면 명령 팔레트 항목으로 충분하다. 새 상태는 필요 없다.

## 아직 확인하지 못한 것

- 원안 §1.1의 `Coordinator` · `ModelBridge` 소유권 서술과 `EffortRoutingSettings`의 내용. 파일과 식별자의 존재, 설정 화면이 입력창과 따로라는 것만 확인했다.
- 에이전트가 디자인 스킬의 스크립트를 스킬의 가상 경로로 실제 실행할 수 있는지.
- 설치 검토 화면이 trusted-native 확장의 OS 권한을 사실대로 말하는지.
- `deployment-tasks.ts`와 사본 명령에 준비 단계 구실을 하는 것이 있는지.
- UI-08의 판정은 `design-review.ts`만 읽고 내렸다.
