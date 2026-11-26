# UI 마스터플랜 v1.1에서 남긴 것: 작업 계획

"Pi Native ADE 통합 아키텍처 및 UI 실행 마스터플랜 v1.1"(저장소에 없다. UI-01~08, D01~D12, PR 1~6으로 된 원안)을 2026-11-26에 `develop` @ `b57445d3`의 코드와 명세에 대조했다. 원안은 코드 식별자는 맞게 인용했지만 [명세](../specs/README.md)를 읽지 않아, 이미 있는 화면을 새로 만들고 이미 뺀 것을 다시 넣는 항목이 대부분이었다. 이 계획은 그 대조에서 남은 것만 싣는다. A는 만들었고, B와 C는 관문에서 접었다.

이 문서는 승인이 아니다. 단계는 사용자가 요청할 때 시작한다. 단계는 서로 기대지 않으므로 각자 그때의 `develop`에서 분기한다. 단계마다 명세 → 실패하는 테스트 → 구현 순서이고 `pnpm lint`, `pnpm typecheck`, 관련 테스트를 돌린다. 계약 타입을 바꾸면 `pnpm contracts:check`도 돌린다. E2E는 건드린 스펙만 돌린다.

| 단계 | 내용 | 상태 |
|---|---|---|
| A | 변경 검토의 실행별 묶음 | 만들어 `develop`에 합쳤다([fromiron/corral#253](https://github.com/fromiron/corral/pull/253)) |
| B | 추천 패키지 목록 | 관문 B0에서 접었다. 만든 것이 없다 |
| C | 주석의 소스 위치 | 관문에서 접었다. 만든 것이 없다 |

## 사용자가 정한 것 (2026-11-26)

- 대조의 판정대로 이 계획을 다시 쓴다. 원안의 PR 6개는 쓰지 않는다.
- 작업은 브랜치에서 하고 PR로 올린다.
- B의 판단은 조정자에게 맡긴다. 후보 확장은 조정자가 직접 돌려 보고 판단해도 된다.
- C부터 남은 것도 조정자에게 맡긴다.

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
- 걷는 동안 diff 하이라이트 워커가 `Theme "pierre-dark" has not been resolved`를 콘솔에 남겼다. 묶지 않는 실행 범위만 열어도 남고 diff는 그려진다. 이 단계가 건드리지 않은 코드이고, 앞선 revision과 견주지 않았다.
- 대화 옆의 좁은 패널에서는 접힌 목록의 높이가 정해져 있어 묶음의 머리만큼 한 번에 보이는 행이 준다.

## B. 추천 패키지 목록

원안 UI-07에서 남긴 것이다. 신뢰와 활성의 분리, 해시별 신뢰, 고정 버전 `npm:` · git 가져오기, Pi 홈 가져오기는 이미 있다([Harness 계약](../specs/harness-contract.md#h3-리소스역할ui)). 없는 것은 무엇을 가져올지 알려 주는 목록이었다. 조정자가 관문 B0의 읽는 부분을 하고 이 단계를 접었다. 만든 것이 없고 명세와 코드는 그대로다.

### 관문 B0

후보 패키지마다 아래를 확인하고, 통과한 것만 목록에 싣기로 했다. 하나도 통과하지 못하면 접는다.

1. 패키지가 실제로 있고, 고정할 버전과 라이선스가 확인된다.
2. 그 버전이 검토 → 설치 → 신뢰 → 활성 → 실행까지 실제로 된다.
3. 그 실행에 `unsupported` 알림이 남았는지, 남았다면 어느 UI API인지.

Corral이 이미 하는 일을 대신하는 확장은 목록에 넣지 않는다.

### 읽은 것 (2026-11-26)

npm 등록 정보와 고정 버전의 소스를 읽기만 했다. 내려받아 설치하거나 실행하지 않았으므로 2와 3은 확인한 것이 없다.

| 후보 | 버전 | 라이선스 | 결과 |
|---|---|---|---|
| `@juicesharp/rpiv-ask-user-question` | 2.15.0 | MIT | 뺀다. 모델이 사람에게 묻는 도구이고 그 일은 Corral의 `ask_user`가 한다([Desktop 계약](../specs/desktop-contract.md#3-전체-범위와-재사용)) |
| `@juicesharp/rpiv-todo` | 2.15.0 | MIT | 뺀다. 모델의 할 일 목록이고 그 일은 Corral의 `update_plan`이 한다([채팅 위젯 계약](../specs/chat-widgets-contract.md#51-새-todo-저장-엔진은-만들지-않음)). 목록을 보이는 오버레이는 `setWidget`을 부르고, Corral은 그 UI API를 받지 않는다(`packages/adapter-pi/src/extension-ui.ts`) |
| `@plannotator/pi-extension` | 0.29.4 | MIT OR Apache-2.0 | 읽기만으로는 정하지 못했다. 등록 정보의 설명은 계획과 코드를 검토하는 화면이고, 풀면 75.7 MB다. 소스는 읽지 않았다 |
| `pi-web-access` | 0.48.0 | MIT | 읽기만으로는 정하지 못했다. 웹 검색과 가져오기는 Corral의 `search` · `read_document`보다 넓다([API 계약](../specs/api-contract.md#1-명령과-조회)). 브라우저의 쿠키 저장소를 읽어 푸는 코드가 있고, 그 패키지의 설정 `allowBrowserCookies`를 켜야 돈다 |

- 네 패키지 모두 설치 스크립트를 선언하지 않는다. Corral은 `npm --ignore-scripts`로 설치한다(`packages/adapter-pi/src/package-worker-main.ts`).
- `pi-package` 키워드의 인기 패키지 60개는 이름과 설명만 훑었다. MCP 어댑터, 서브에이전트, 웹 접근, 계획 모드, 권한, 터미널 UI 꾸밈이 많았고, Corral이 하지 않는 일을 하는 것이 눈에 띄지 않았다.

### 접은 이유

사용자는 후보를 조정자가 직접 돌려 보고 판단해도 된다고 했다. 돌리지 않았고, 접은 채로 둔다.

1. 시험이 판정을 바꾸지 못한다. 규칙으로 빠지지 않은 후보는 둘이고, 둘이 모두 통과해도 목록은 둘이다. Pi SDK나 패키지의 버전을 올릴 때마다 관문을 다시 해야 하는 값에 견주어 얻는 것이 작다. 조정자의 판단이다.
2. 조정자가 혼자 볼 수 있는 것은 활성까지다. 실행은 모델이 확장의 도구를 불러야 하고, 모델을 쓰는 서버는 저장된 로그인과 키를 읽는다(`apps/server/src/models/codex-login.ts`, `credential-store.ts`). 실행용 HOME/XDG 분리는 OS 격리가 아니다([Harness 계약](../specs/harness-contract.md#h3-리소스역할ui)). 키 하나만 떼어 격리한 환경에 넣는 것은 에이전트가 비밀 값을 다루는 일이라 하지 않는다. 그래서 관문의 2와 3은 채우지 못한다.

### 다시 여는 조건

- Corral이 하지 않는 일을 하고 Corral에서 실행까지 확인된 확장이 목록으로 둘 만큼 모였을 때. 위의 두 후보도 그렇게 확인되면 센다.
- Corral이 `setWidget`이나 `custom` 같은 확장 UI를 받게 되어 후보가 넓어졌을 때.

다시 열면 만들 것은 작다. 패키지 화면(`apps/studio/src/workbench/harness/PackageManager.tsx`)에 서버가 싣는 정적 목록을 두고, 항목(이름, 한 줄, 고정 버전의 source 문자열)을 고르면 source 칸이 채워져 지금의 검토 흐름으로 간다. 자동 설치와 자동 신뢰는 없다.

만들지 않는 것은 그대로다. 패키지 카드에 "관측된 미지원 UI API"를 자동으로 보이지 않는다. 알림(`ExtensionUiNotice`)은 어느 확장이 불렀는지 담지 않는다. 한 세션의 확장들이 UI 컨텍스트 하나를 나눠 쓰기 때문이다(`packages/adapter-pi/src/sdk-worker.ts`의 `bindExtensions`).

## C. 주석의 소스 위치 (관문만)

원안 UI-03에서 이미 없는 것은 "고른 요소의 소스 위치" 하나다. 이동 세대, 보내기 직전의 재확인, 입력 칸 가림, 콘솔, 첨부는 [브라우저 주석](../specs/features/browser-annotate.md)에 있다. 지금 주석이 보내는 요소 자료(`packages/contracts/src/page-annotation.ts`)는 태그, 이름표, 역할, 선택자, 글, 자리, 스타일이고 소스 위치는 없다.

관문: 미리보기 페이지에서 고른 요소의 소스 파일과 줄을 프로젝트에 의존성을 더하지 않고 얻을 수 있는지 읽기만으로 확인한다. 프레임워크마다 길이 다르다. 통과하지 못하면 접고, 뜻이 다른 작은 것을 대신 만들지 않는다. 에이전트는 지금도 선택자와 글로 소스를 찾는다.

### 통과 기준

읽기 전에 정했다. 아래가 모두 서야 통과다.

1. 프로젝트의 의존성과 설정을 바꾸지 않는다. 프레임워크의 dev 서버를 그대로 띄운 페이지에서 얻는다.
2. 얻는 것은 원본 소스의 파일과 줄이다. 변환된 코드의 줄은 세지 않는다.
3. 길이 버틴다. 프레임워크가 dev에서 남긴다고 문서에 적었거나 자기 도구로 드러낸 표시만 센다. 비공개 내부 필드를 직접 읽는 길은 판마다 깨지므로 세지 않는다.
4. React가 든다. 미리보기에 뜨는 페이지의 다수가 React라서, React에서 안 되면 대부분의 주석에 위치가 없다. React 말고는 Vue, Svelte, Astro 가운데 둘 이상에서 된다.
5. 주석 bridge가 그 자리를 읽을 수 있다.

싣는 값은 프로젝트 기준의 상대 경로다. 로컬 절대 경로를 싣지 않는다.

### 읽은 것 (2026-11-26)

문서와 Corral의 코드를 읽기만 했다.

- **주석 bridge**: 페이지를 읽는 길은 메인 프로세스가 격리된 세계에서 스크립트를 돌리는 길 하나다([브라우저 주석](../specs/features/browser-annotate.md#계약), `apps/desktop/src/browser-annotate.ts`의 `AGENT_WORLD`). 격리된 세계는 페이지와 DOM을 나누지만 페이지의 스크립트가 만든 값은 보지 못한다. Chrome의 content script 문서가 드는 예에서는 요소에 붙인 JS 속성도 세계마다 따로다. 그래서 HTML 속성으로 남은 표시만 읽을 수 있다.
- **React**: 문서에 있는 길은 `captureOwnerStack`이다. 인자를 받지 않고, 렌더 · effect · React의 이벤트 핸들러 · 오류 핸들러 안에서만 값을 주며, 직접 단 DOM 이벤트 핸들러에서는 늦다고 적혀 있다. 이미 그려진 요소의 소스를 바깥 스크립트가 얻는 문서화된 길은 React 19 업그레이드 안내와 이 API의 참조 문서에서 찾지 못했다.
- **Vue**: `data-v-inspector` 표시는 `vite-plugin-vue-inspector`를 프로젝트에 깔아야 생긴다.
- **Svelte**: 요소의 파일 위치를 보이는 inspector는 설정으로 켜야 하고, 다음 major에서 다른 패키지로 옮긴다고 적혀 있다. inspector 없이 요소에 남는 표시가 있는지는 확인하지 못했다.
- **Astro**: dev 도구 모음 문서에서 요소의 소스 표시를 찾지 못했다. 확인하지 못한 채로 둔다.

### 결과: 접는다

- 판정은 기준 5에서 난다. React가 내놓는 것은 JS 쪽의 API와 값이고, 문서에 있든 없든 페이지의 세계에 있어서 주석 bridge가 닿지 못한다. 그래서 React가 들어야 한다는 기준 4가 서지 않는다.
- 기준 3을 채우는 React의 길도 읽은 문서에서는 찾지 못했다. React의 CHANGELOG는 읽지 못했다.
- 기준 1이 Vue를 뺀다. 프로젝트에 플러그인을 더해야 한다. Svelte와 Astro는 확인하지 못했고, 둘이 되더라도 React가 빠지면 통과가 아니다.
- 기준 5는 명세가 정한 경계다. 소스 위치 하나를 얻으려고 Corral의 스크립트를 페이지의 세계에서 돌리지 않는다.

뜻이 다른 작은 것을 대신 만들지 않는다. 에이전트는 지금처럼 선택자와 글로 소스를 찾는다. React가 그려진 요소의 소스 위치를 HTML 속성이나 문서화된 API로 내놓으면 다시 연다.

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
| UI-07에서 남긴 추천 패키지 목록 | [B](#b-추천-패키지-목록)의 관문에서 접었다. 후보 넷 가운데 둘은 Corral의 도구가 하는 일이고, 남은 둘로는 목록을 둘 만하지 않다 | `ask_user`, `update_plan`: [Desktop 계약](../specs/desktop-contract.md#3-전체-범위와-재사용). 패키지의 검토 · 신뢰 흐름: [Harness 계약](../specs/harness-contract.md#h3-리소스역할ui) |
| UI-03에서 남긴 주석의 소스 위치 | [C](#c-주석의-소스-위치-관문만)의 관문에서 접었다. 주석은 격리된 세계에서만 페이지를 읽어 React의 JS 쪽 값에 닿지 못하고, 그려진 요소의 소스를 바깥에서 얻는 문서화된 길도 읽은 문서에서 찾지 못했다 | [브라우저 주석](../specs/features/browser-annotate.md#계약) |

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
- Corral이 확장에 넘기는 `hasUI`와 `mode`. B의 후보가 Corral에서 실제로 어떻게 도는지는 아는 것이 없다.
- Astro와 Svelte가 dev에서 요소에 남기는 소스 표시, React의 CHANGELOG. C의 판정은 주석 bridge에서 났으므로 더 읽지 않았다.
- `deployment-tasks.ts`와 사본 명령에 준비 단계 구실을 하는 것이 있는지.
- UI-08의 판정은 `design-review.ts`만 읽고 내렸다.
