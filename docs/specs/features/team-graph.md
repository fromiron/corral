# 기능 명세: 팀 그래프 모델

- 상태: implemented
- 기준: [제품 계약](../product-contract.md) §2.1, §3, [기술 설계](../technical-design.md) §4. 노드·포트·상자·병렬·컴파일 규칙의 정본은 이 문서다.
- 비목표: 실행 중 구조 변경, 사용자 코드·수식 평가, 범용 데이터 타입 설계기. 단계별 hook(도구 사용 전 동작, 에이전트에게 추가 메시지 보내기를 GUI로 붙이는 것)은 없다. 편집 화면의 조작은 [팀 편집기](canvas.md)가 정한다.

## 사용자 관측 동작

1. **여섯 종류의 노드.** 팀은 Agent, Decision, Loop, Team, Join, Output으로 만든다. Agent는 `scheduled`, `callable`, `observer` 중 하나다. `observer`는 실행 순서에 들지 않고 다른 Agent를 지켜보는 [감독](advisor.md)이다. Decision은 `review`, `approval`, `rule`, `check`, `router` 중 하나이며 모드마다 나가는 포트가 다르다.
2. **상자.** Loop와 Team은 다른 노드를 담는 상자다. 상자 안에 상자를 담을 수 있다. 루프를 몇 개 두든, 팀을 루프로 감싸든, 루프 안에 팀을 두든 정의할 수 있다.
3. **루프.** 몸체는 노드 하나 이상이다. 다시 도는 길(`repeat`)은 결정 노드에서만 들어오고, 끝나는 길(`exit`)이 있어야 한다. 반복 상한은 1 이상의 정수이며 시스템 상한은 없다. 상한을 두지 않을 수도 있다. 상한이나 정체 감지에 걸렸을 때 할 일은 팀을 만들 때 Loop마다 정한다: 끝내기, 안쪽 에이전트의 추론 수준을 올려 더 돌기, 정해 둔 상위 모델로 바꿔 더 돌기. 끝낼 때는 `exhausted`로 나가고, 연결이 없으면 Run이 실패한다. 어느 경우에도 사용자에게 묻지 않는다.
4. **병렬과 합류.** 한 출력 포트에 연결을 여러 개 두면 그 대상들이 동시에 실행되는 분기가 된다. 동시에 살아 있을 수 있는 분기가 다시 만나는 곳은 Join이어야 한다. Join은 모든 분기(`all`) 또는 첫 분기(`any`)를 기다린다. 결정의 서로 다른 분기처럼 동시에 살아 있을 수 없는 경로는 Join 없이 한 노드로 모일 수 있다.
5. **실패 경로.** Agent는 실패하면 정한 횟수만큼 다시 시도한다. 그래도 실패하면 `error` 포트로 나가며, 연결이 없으면 Run이 실패한다.
6. **팀 상자의 두 출처.** 같은 정의 안에서 노드를 묶은 팀(`inline`)과, 저장된 다른 팀의 정해진 revision을 가져다 쓰는 팀(`reference`)이 있다. 참조 팀은 원본이 바뀌어도 고정한 revision을 쓴다.
7. **메모.** 모든 노드에 실행에 쓰이지 않는 메모를 달 수 있다.
8. **진단.** 컴파일러가 구조 문제를 노드·연결 단위로 돌려준다. 오류가 있으면 실행할 수 없다. 경고는 실행을 막지 않는다.

## 계약

### 정의 스키마

정본은 `packages/contracts/src/definition.ts`의 Zod다. 아래는 그 요약이다.

| 노드 | 필드 |
|---|---|
| 공통 | `id`, `type`, `label`, `parentId?`(담고 있는 Loop 또는 Team), `note?`(실행에 쓰지 않음, 정의 revision에는 포함) |
| Agent | `roleId`, `invocation`, `inputBindings`, `outputName`, `retry?: { maxAttempts }`(0 이상, 없으면 0). `observer`는 `review?: { interval, maxRequestsPerReview }`(1 이상, 기본 3과 8)를 갖고 `inputBindings`·`retry`를 쓰지 않는다 |
| Decision | `mode`, `inputBindings`(1개 이상). `review`·`approval`·`rule`은 모드별 `rule` 하나. `check`는 `checkIds`(등록 검사 1개 이상). `router`는 `routes: { id, label, description? }[]`(2개 이상, id 고유)와 선택적 `modelProfile` |
| Loop | `maxIterations?`(1 이상), `limitPolicy?`(없으면 `exhaust`), `stallDetection?`(없으면 끔), `reviewRecipe?`([하네스 계약](../harness-contract.md) H6) |
| Team | `source: { kind: 'inline' } \| { kind: 'reference', corralId, definitionRevision }`, `inputBindings?`(reference Team만) |
| Join | `policy: 'all' \| 'any'` |
| Output | `inputBindings`(1개 이상), `requireApproval` |

- `controlEdges`는 `{ id, source, sourcePort, target, targetPort }`다. `sourcePort`는 아래 포트 표의 이름이거나 router의 route id다.
- `capabilityLinks`(`delegate`, `question`, `advise`)는 허용 관계이며 순서가 아니다. `delegate`와 `question`의 의미는 [제품 계약](../product-contract.md) §7을, `advise`의 의미는 [감독](advisor.md)을 따른다.
- `limitPolicy`는 `{ kind: 'exhaust' }`, `{ kind: 'raise_reasoning', level }`, `{ kind: 'upper_model', modelProfile }`, `{ kind: 'unlimited' }` 중 하나다. `level`은 추론 수준, `modelProfile`은 모델 profile id다. 의미는 [루프 실행](#루프-실행)을 따른다.
- `limits.maxDelegationDepth`는 1 이상의 정수다(기본 2). `limits.maxSpawns`는 1 이상의 정수다.
- `entryNodeId`는 최상위의 유일한 시작 노드다. 시작 노드는 scheduled Agent, Loop, Team 중 하나다.

### 포트 표

포트 표는 `@corral/core` compiler 한 곳에서 정의하고, 편집기의 연결 규칙과 compiler가 함께 쓴다.

| 노드 | 들어오는 포트 | 나가는 포트 |
|---|---|---|
| Agent (scheduled) | `in` | `out`, `error` |
| Agent (callable) | 없음 (capability link의 대상) | 없음 |
| Agent (observer) | 없음 (`advise` link의 출발) | 없음 |
| Decision `review` | `in` | `pass`, `revise` |
| Decision `approval` | `in` | `approve`, `reject` |
| Decision `rule` | `in` | `yes`, `no` |
| Decision `check` | `in` | `pass`, `fail` |
| Decision `router` | `in` | route id마다 하나 |
| Loop | 밖에서 `enter`, 안에서 `repeat`·`exit` | 안으로 `body`, 밖으로 `next`·`exhausted` |
| Team | 밖에서 `enter`, 안에서 `exit` | 안으로 `body`, 밖으로 `next` |
| Join | `in` (2개 이상) | `out` |
| Output | `in` | 없음 |

### 구조 규칙

compiler는 아래 규칙을 순서와 무관하게 모두 검사하고, 어긴 곳마다 진단을 만든다.

1. **소속.** `parentId`는 같은 정의의 Loop 또는 `inline` Team을 가리킨다. 소속은 순환하지 않는다. `reference` Team은 구성원을 가질 수 없다.
2. **상자 경계.** control edge는 다음 경우만 허용한다.
   - 같은 상자 안의 두 노드 사이.
   - 같은 상자 안의 노드에서 이웃 상자의 `enter`로.
   - 상자의 `body`에서 그 상자의 직접 구성원으로.
   - 상자 안의 노드에서 자신을 담은 어느 조상 상자의 `exit`, 또는 조상 Loop의 `repeat`로. 여러 겹을 한 번에 나갈 수 있다.
   - 상자의 `next`·`exhausted`에서 그 상자와 같은 상자 안의 노드로.

   바깥에서 상자의 구성원으로 바로 들어가는 연결은 거절한다.
3. **순환.** control 순환은 Loop의 `repeat`를 거칠 때만 허용한다.
4. **루프 완결성.**
   - `body`에 연결이 하나 이상 있다.
   - `exit`로 들어오는 연결이 하나 이상 있다.
   - `repeat`로 들어오는 연결이 하나 이상 있고, 모두 Decision 포트에서 나온다.
   - 몸체에서 시작한 모든 경로는 이 Loop나 조상 상자의 `exit`·`repeat`, Output, 또는 `error` 경로에서 끝난다.
   - `limitPolicy`가 `unlimited`이면 `maxIterations`를 두지 않는다. 그 밖에는 `maxIterations`가 있어야 한다.
   - `reviewRecipe`가 있는 Loop의 `limitPolicy`는 `exhaust`다. 레시피의 시도 수가 상한이다.
   - `raise_reasoning`의 `level`은 `off`가 아니다.
   - `upper_model`의 `modelProfile`은 허용 목록에 있고, Loop 안 Agent의 역할마다 그 모델로 모델 기능 호환 검사를 통과한다.
   - Loop 안 Agent는 `parentId`를 따라 올라가면 이 Loop에 닿는 Agent 노드다. 안쪽 Loop와 `inline` Team의 구성원이 든다. `reference` Team 안의 Agent는 들지 않는다.
5. **팀 완결성.** `inline` Team은 구성원이 하나 이상이고 `body`가 연결돼 있다. `next`가 연결돼 있으면 `exit`로 들어오는 연결이 하나 이상 있다. `inline` Team에는 `inputBindings`를 두지 않는다. 구성원이 앞 단계를 이름으로 읽는다.
6. **참조 팀.**
   - 참조한 Corral과 revision은 compiler에 주입한 정의 출처에서 찾을 수 있고, 그 자체로 컴파일되어야 한다.
   - 참조는 직접이든 간접이든 순환하지 않는다. 같은 Corral의 다른 revision을 참조해도 순환으로 본다.
   - 참조 팀은 원본의 시작 노드가 `enter`가 되고, 원본의 Output이 `exit`가 된다. 원본 Output의 `requireApproval`은 `exit` 전 승인으로 유지한다.
   - 참조 팀은 구성원을 갖지 않으므로 `body`를 연결하지 않고, `next`를 연결한다.
   - `task_output` 입력은 scheduled Agent나 참조 팀을 읽는다. `inline` Team은 읽을 수 없다.
7. **병렬과 합류.**
   - 한 포트의 연결이 둘 이상이면 동시에 실행되는 분기다.
   - Join이 아닌 노드나 상자 포트로 들어오는 연결 가운데, 동시에 살아 있을 수 있는 분기에서 온 것이 둘 이상이면 오류다.
   - Join으로 들어오는 연결이 하나뿐이면 경고다.
   - 분기는 다시 모인 뒤에만 끝날 수 있다. 아직 Join으로 모이지 않은 분기에서 Output으로 가거나, 그 분기를 낳은 출력 포트가 든 상자의 `exit`·`repeat`로 가는 연결은 오류다.
   - Join 하나는 출력 포트 하나의 분기를 모은다. 들어오는 연결은 그 포트의 서로 다른 분기에서 오고 모든 분기가 들어와야 하며, 그 밖의 바깥 분기 처지는 서로 같아야 한다. 어기면 오류다. 들어오는 연결이 모두 같은 분기에서 오면 Join은 들어온 길을 그대로 잇는다. 모든 분기가 Join으로 모인 포트는 닫혀서, 그 뒤의 바깥 Join에서는 분기로 세지 않는다.
8. **같은 작업 사본에 쓰는 병렬 분기.** 파일을 쓰는 도구를 가진 Agent가 동시에 살아 있을 수 있는 분기에 둘 이상 있으면 경고한다. 분기들은 같은 세션 작업 사본을 쓰며 파일 효과는 분기마다 격리되지 않는다.
9. **연결되지 않은 출구.**
   - Decision과 router의 출구, Loop의 `exhausted`, Agent의 `error`가 연결되지 않아도 정의는 유효하다.
   - 연결 안 된 Decision 출구는 경고한다.
   - 실행 중 연결 안 된 출구가 선택되면 Run은 그 노드에서 `needs_user`로 실패한다. 이유에 노드와 출구가 남는다. 연결 안 된 `reject`가 선택되면 Run은 취소된다. Loop의 `exhausted`는 [루프 실행](#루프-실행)의 소진을 따른다.
   - router는 route가 둘 미만이면 오류다.
10. **시작점과 도달.** 최상위에 들어오는 control edge가 없는 시작 노드가 정확히 하나 있고 `entryNodeId`와 같아야 한다. 모든 scheduled 노드는 시작 노드에서 도달할 수 있어야 한다. callable Agent는 유효한 capability 경로가 있으면 고립으로 보지 않는다. observer Agent는 `advise` 연결이 있으면 고립으로 보지 않는다.
11. **감독.**
    - observer Agent는 control edge를 갖지 않고 어느 상자에도 속하지 않는다. `delegate`·`question` 연결의 출발이나 대상이 될 수 없다.
    - observer Agent는 `advise` 연결을 하나 이상 갖는다. `advise` 연결의 출발은 observer Agent, 대상은 scheduled 또는 callable Agent다. 다른 observer, Decision, 상자, Join, Output을 대상으로 할 수 없다.
    - observer 역할의 작업 도구는 `search`, `read_document`, `list_files`, `read_file` 가운데에서만 고르고, 협업 도구는 `read_artifact`와 `advise`로 고정한다. 다른 도구를 가진 역할을 observer 노드에 쓰면 오류다.
    - 다른 호출 방식의 Agent 역할은 `advise` 도구를 가질 수 없다.
    - 시작 노드가 될 수 없고, `task_output` 입력의 생산자가 될 수 없다.
12. **그 밖의 검사.** 스키마·버전, 중복 id, 존재하지 않는 참조, 포트 방향, 입력 바인딩의 생산자, review 계약, 모델 기능 호환, 허용 목록을 기존처럼 검사한다. 정의 규모는 개수만으로 거절하지 않는다([제품 계약](../product-contract.md) §9).

### 진단

진단은 `{ code, severity, message, nodeId?, edgeId?, linkId? }`이고 `severity`는 `error` 또는 `warning`이다. `code`는 `packages/core/src/compiler`의 고정 enum이며 UI 문구는 메시지 카탈로그에서 code로 찾는다. 위 규칙마다 code가 하나씩 있다. 편집기는 진단을 해당 노드·연결 위에 표시한다.

### 루프 실행

- **진입.** Loop의 `enter`로 들어오거나 Loop가 시작 노드이면 1회차를 연다. 들어올 때마다 회차 번호와 정체 비교를 새로 시작한다.
- **회차 기록.** 회차는 그때 열려 있는 바깥 Loop의 회차를 부모로 기록한다(`loop.iteration_started.parentIterationId`). 이전 회차 출력(`previous_iteration_output`)은 같은 진입의 바로 앞 회차에서만 오며, 1회차에는 없다.
- **다시 돌기.** Decision이 `repeat`로 보내면 차례로 확인한다.
  1. 이번 진입에서 끝난 회차 수가 회차 상한에 닿았다: `cap_reached`. 한도 정책을 적용한 뒤에는 그 뒤에 끝난 회차만 센다. 상한은 `maxIterations`이고, `loop_limit` 패치가 있으면 그 값이다. `unlimited`인 Loop는 패치가 없으면 상한이 없다. 리뷰 레시피가 있으면 레시피의 시도 수를 넘지 않는다. 설치 상한은 없다.
  2. 정체했다: `stalled`.

  어느 것에도 걸리지 않으면 이 회차를 `revise`로 끝내고 다음 회차를 연다. 걸리면 한도 정책을 따른다.
- **정체.** `stallDetection`이 켜져 있을 때, 이번 회차와 그 안쪽 Loop 회차에서 제출한 산출물의 내용 hash 집합이 같은 진입의 바로 앞 회차와 같으면 정체다. 검토 결과(`review` 출력 계약)는 비교하지 않는다. 비교할 산출물이 없는 회차는 정체로 보지 않는다.
- **한도 정책.** 걸렸을 때 할 일은 Loop의 `limitPolicy`가 정한다. 사용자에게 묻지 않는다.
  - `exhaust`, `unlimited`: 소진이다.
  - `raise_reasoning`: Loop 안 Agent의 추론 수준을 `level`로 고정한다. 모델이 `level`을 지원하지 않으면 그 모델이 지원하는 `level` 이하의 가장 높은 수준을 쓴다. 이미 그 수준 이상으로 고정된 Agent와 쓸 수준이 없는 모델의 Agent는 바꾸지 않는다.
  - `upper_model`: Loop 안 Agent의 모델을 `modelProfile`로 바꾼다. 추론 설정은 그대로 둔다. 이미 그 모델을 쓰는 Agent는 바꾸지 않는다.
  - 올리기와 바꾸기는 한 진입에서 한 번만 한다. 이미 했거나 바뀌는 Agent가 하나도 없으면 소진이다.
  - 적용하면 `loop.escalated`를 남기고, 이 회차를 `revise`로 끝내고 다음 회차를 연다. 회차 번호는 이어지고 상한은 그 자리부터 다시 센다. 정체 비교는 이어진다.
  - 바뀐 모델과 추론 수준은 그 진입이 끝날 때까지 Loop 안 Agent의 새 실행(execution)에 쓰인다. 진행 중인 실행은 바꾸지 않는다. 다시 들어오면 정의의 값으로 시작한다.
  - 사람이 `node_future` 패치로 모델이나 추론을 정한 Agent는 그 항목을 바꾸지 않는다. 뒤에 온 사람의 패치가 앞선다.
- **소진.** 회차를 걸린 이유(`cap_reached`·`stalled`)로 끝내고 Loop를 떠난다. `exhausted`에 연결이 있으면 그리로 간다. 연결이 없으면 Run이 실패로 끝난다. 이유(`loop_exhausted`)에 Loop와 걸린 이유가 남고, 그때까지 제출한 산출물은 실패한 Run의 부분 결과로 남는다.
- **나가기.** Loop의 `exit`로 들어오면 회차를 `pass`로 끝내고 `next`로 간다. 여러 겹 바깥 상자의 `exit`나 `repeat`로 바로 가면, 그 사이 안쪽 Loop의 열린 회차는 모두 `pass`로 끝난다.

### 재시도와 실패 경로

- **재시도.** scheduled Agent의 실행(execution)이 `failed`로 끝나고 Run이 아직 진행 중이면, 같은 Task의 다음 시도를 곧바로 시작한다. `retry.maxAttempts`번까지 다시 시도하므로 시도는 모두 `1 + maxAttempts`번이다.
  - 다음 시도는 `attemptNo`가 하나 크고 `previousExecutionId`로 앞 시도를 가리키며, 같은 회차에 속한다.
  - 입력은 앞 시도와 같은 입력 버전에 `previous_attempt_error` 하나를 더한 것이다. 앞 시도의 오류 문구이며 2,000자까지 자른다. 앞 시도의 기록과 산출물은 그대로 남는다.
  - 취소로 끝난 실행, 종료를 확인하지 못한 실행, Run이 진행 중이 아닐 때 끝난 실행은 다시 시도하지 않는다. 일시정지 중이면 재개한 뒤 시작한다.
  - 시도마다 모델 호출은 admission을 따른다.
- **실패 경로.** 마지막 시도까지 실패하면 `error`에 연결이 있을 때 그리로 간다. 그 연결이 바로 가리키는 Agent는 입력 `step_error`를 더 받는다: 실패한 단계 이름, 시도 수, 마지막 오류 문구(2,000자까지). `error`에 연결이 없으면 Run은 `execution_failed`로 실패한다.

### router 실행

- **고르는 실행.** router에 닿으면 router 노드의 새 Task로 실행 하나를 시작한다. 이 실행은 내장 선택 역할로 돈다: 정해진 지시문, 도구 없음, `text` 출력. 모델은 router의 `modelProfile`, 없으면 첫 `task_output` 입력을 만든 Agent 역할의 모델, 그것도 없으면 정의의 첫 역할 모델이다. Run 시작에서 다른 모델과 함께 고정한다.
- **입력.** router의 입력 바인딩과 `routes` 입력 하나를 받는다. `routes`는 route마다 id, 이름, 설명이다. Loop 안이면 그 회차의 실행이다.
- **선택.** 제출한 글을 앞뒤 공백 없이 route id와 비교해 같은 route를 고른다(`reasonCode: model_route`). 고른 route에 연결이 없으면 [연결되지 않은 출구](#구조-규칙)처럼 처리한다. 선택 실행은 재시도하지 않는다.
- **사람이 고르기.** 제출이 route id가 아니거나 선택 실행이 실패하면 `route` 승인으로 사람에게 묻는다. 승인에는 연결된 route만 정의 순서대로 보인다. 사람이 route 하나를 골라 승인하면 그 route로 간다(`reasonCode: human_route`). 거절하면 Run이 취소된다. 확인 대상은 router 입력 버전과 선택 실행의 제출이고, 둘 다 없으면 Run 기준 버전이다.
- **기록.** 어느 쪽이든 `workflow.branch_selected`(`mode: router`)를 남기며, 선택 실행의 제출과 승인을 근거로 단다.

### check 실행

- **시작 조건.** check Decision이 있는 Run은 작업 세션에서 시작해야 한다. Run 시작은 그 세션 프로젝트의 등록 검사 설정을 고정하고(`RunSnapshot.checks`: 프로젝트, 설정 revision·hash, 모든 check Decision의 `checkIds`), 그 Run이 신뢰된 작업 사본을 쓰게 한다. 세션이 없거나, 세션에 작업 사본이 없거나, 검사가 등록돼 있지 않거나, 검사 실행기를 쓸 수 없으면 `CAPABILITY_DENIED`로 거절하고 Run을 만들지 않는다. 작업 사본은 사람이 세션에서 만든다. Run 시작이 대신 만들지 않는다.
- **검사 실행.** check에 닿으면 check 노드의 새 Task로 내장 검사 실행 하나를 시작한다. 모델을 부르지 않고, 노드의 `checkIds`를 순서대로 고정한 설정의 `run_check`로 작업 사본에서 실행한 뒤 결과 요약을 제출한다. 신뢰하지 않은 fingerprint는 지금처럼 검사 실행 승인을 받는다([하네스 계약](../harness-contract.md) H5). Loop 안이면 그 회차의 실행이다.
- **판정.**
  - 바뀌지 않은 tree에서 끝까지 돌아 `fail`이 나온 검사가 하나라도 있으면 `fail`로 간다.
  - 모든 검사가 바뀌지 않은 tree에서 끝까지 돌아 `pass`이면 `pass`로 간다.
  - 그 밖(오류, 시간 초과, 취소, 실행 중 바뀐 tree, 판정 불가, 실행 승인 거절, 검사 실행 자체의 실패)은 판정이 없다. 판정 없는 결과를 `pass`나 `fail`로 바꾸지 않는다.
- **판정이 없을 때.** `check` 승인으로 사람을 기다린다. 승인하면 같은 Task의 다음 시도로 검사를 다시 실행하고 같은 규칙으로 판정한다. 거절하면 Run이 취소된다. 확인 대상은 검사 실행의 제출이고, 없으면 Run 기준 버전이다.
- **기록.** `workflow.branch_selected`(`mode: check`, `reasonCode: check_verdict`)에 검사 보고서와 요약을 근거로 단다.

### 병렬 실행

- **갈라지기.** 한 출력 포트에 연결이 둘 이상이면 그 대상들을 동시에 시작한다. 분기마다 따로 진행하며, Join 말고는 서로를 기다리지 않는다. Loop 안에서 갈라지면 같은 회차에 속하고, 회차마다 새로 갈라진다.
- **`all` Join.** 그 포트의 모든 분기가 도착하면 `out`으로 한 길이 이어진다.
- **`any` Join.** 첫 분기가 도착하면 `out`으로 이어지고, 같은 포트의 나머지 분기를 멈춘다. 실행의 성공은 멈춘 분기가 실제로 끝난 뒤에 확정하므로 작업 사본은 종료 확인과 함께 돌려준다. 멈춘 분기의 종료를 확인하지 못하면 실행은 성공이 아니라 실패다.
  - 실행 중인 실행(execution)은 취소된다. 사람에게 다시 시작을 묻지 않는다.
  - 그 분기의 단계가 기다리던 승인은 거둬진다(`approval.resolved`, `reason: cancelled`).
  - 그 분기 안에서 열린 Loop 회차는 `cancelled`로 끝난다.
  - 멈춘 분기의 기록과 산출물은 남는다. 늦게 도착한 분기는 무시한다.
- **기록.** Join이 이어질 때 `workflow.joined`(Join, 회차, 정책, 멈춘 분기의 단계)를 남긴다.
- **사람을 기다리기.** 한 단계가 승인·선택·다시 확인을 기다리면 그 단계만 멈춘다. 다른 분기와 실행은 계속 진행한다. Run 전체에 걸린 한도(무진전)는 Run 단위 개입이므로 하나만 열리고, 거기 닿은 실행은 모두 그 하나를 기다린다.
- **끝나기.** 한 분기가 Run을 끝내면(실패 경로 없는 실패, `needs_user`, 거절, 회차 상한에서 멈춤) 다른 분기도 함께 멈춘다.
- **작업 사본.** 분기들은 같은 세션 작업 사본을 쓰며 파일 작업은 하나씩 차례로 적용된다. 분기마다 사본을 나누지 않는다.

### 팀 실행

- **inline Team.** `enter`로 들어오면 `body`에 연결된 구성원부터 실행한다. Team은 회차를 열지 않으며, 바깥 Loop 회차 안에 있으면 그 회차에 속한다.
  - 구성원은 Team 밖 단계와 같은 Run에서 같은 규칙(재시도와 실패 경로, 병렬과 Join, 사람을 기다리기)으로 실행한다.
  - 구성원이 `exit`에 닿으면 Team 안에서 열린 Loop 회차를 `pass`로 닫고 `next`로 이어진다.
  - 구성원이 조상 상자의 `exit`·`repeat`로 바로 나가면 Team도 함께 나간다.
- **참조 팀.** Run을 시작할 때 고정한 revision의 정의를 그 Team 안에 펼쳐 Run 스냅샷에 고정한다. 펼친 뒤에는 `inline` Team처럼 실행하며, 새 Run이나 별도 실행 경계를 만들지 않는다.
  - 펼친 노드·역할·연결·capability link의 id는 `<Team id>.<원래 id>`다. 참조 팀 안의 참조 팀도 같은 방식으로 펼친다.
  - 원본의 callable Agent는 원본에서처럼 어느 상자에도 속하지 않고, capability link로 부르는 구성원이 그대로 부른다.
  - 원본의 시작 노드가 Team의 `body`로 이어진다. 원본 Output으로 들어오던 연결은 Team의 `exit`로 간다.
  - 원본 Output이 `requireApproval`이면 그 자리에 Output과 같은 입력을 읽는 approval Decision(`<Team id>.<Output id>`)을 둔다. 승인하면 `exit`로 가고, 거절하면 Run이 취소된다.
  - 구성원이 읽는 `run_input` brief는 Team의 `inputBindings`로 바뀐다. Team에 입력이 없으면 Run의 brief를 읽는다. criteria는 Run의 것을 읽는다. 원본의 리뷰 레시피가 Run과 다른 criteria hash를 고정했으면 실행 시작에서 거절한다.
  - 다른 단계가 Team을 `task_output`으로 읽으면 원본 Output이 모은 입력을 받는다. 원본 Output이 여럿이면 그 입력을 모두 optional로 받는다.
  - 원본의 `limits`, `input`, `planOwnerRoleId`는 쓰지 않고 Run의 것을 따른다.

### 실행 한도

런타임은 위 모델 전체를 실행한다. `limits.maxSpawns`가 설치 정책의 하위 실행 상한([제품 계약](../product-contract.md) §9)보다 크면 실행은 설치 상한까지만 하위 실행을 만든다. compiler는 제품 상한(32)을 넘는 값에 `SPAWNS_CAPPED` 경고를 낸다. Run이 실제로 쓰는 한도는 `run.started`의 `limits`에 남고 실행 정보에 보인다.

### 계획 IR

유효한 정의만 `CompiledPlan`이 된다. 계획은 다음을 담는다.

- 시작 단계
- 단계별 다음 단계 목록(병렬이면 여럿)
- 상자 트리와 Loop별 회차 상한
- Join 정책
- callable 관계
- 참조 팀마다 그 팀의 컴파일된 계획(팀 노드 id 아래)
- 요약

Loop는 회차 한 번을 실행하는 함수와 상한 검사로 바뀌며, 화살표를 따라 무한히 도는 탐색으로 실행하지 않는다.

## 수용 시나리오

```gherkin
Scenario: 설치 상한보다 큰 하위 실행 수는 상한으로 실행한다
  Given maxSpawns가 40이고 설치 정책의 하위 실행 상한이 32인 정의
  When 정의를 컴파일한다
  Then 오류는 없고 SPAWNS_CAPPED 경고가 있다
  When 이 정의로 실행을 시작한다
  Then Run이 시작되고 run.started의 limits.maxSpawns는 32다
  When 하위 실행 32개를 만든 뒤 하나 더 만들려 한다
  Then 거절되고 limit.reached(spawns)가 남는다

Scenario: 루프 두 개를 차례로 돈다
  Given 최상위에 Loop A와 Loop B를 차례로 두고 각 Loop 안의 검토가 첫 회차에 revise, 둘째 회차에 pass를 고른다
  When 실행한다
  Then A가 2회차를 마친 뒤 B가 1회차부터 2회차까지 돌고 Run이 끝난다

Scenario: 안쪽 루프는 바깥 회차마다 1회차부터 다시 돈다
  Given Loop A 안에 Loop B가 있고 A의 검토가 첫 회차에 revise, 둘째 회차에 pass를 고른다
  When 실행한다
  Then B의 회차는 A의 회차마다 1부터 시작하고 부모 회차로 그 A 회차를 기록한다
  And 같은 단계가 A의 서로 다른 회차에서 각각 새 Task로 실행된다
  And B의 1회차는 앞 진입의 산출물을 이전 회차 출력으로 받지 않는다

Scenario: 바깥 루프의 출구로 바로 나가면 안쪽 회차도 끝난다
  Given Loop B 안의 검토가 pass를 바깥 Loop A의 exit에 잇는다
  When 검토가 pass를 고른다
  Then B와 A의 열린 회차가 모두 pass로 끝나고 A의 next로 간다

Scenario: 회차 상한에서 exhausted로 나간다
  Given maxIterations 2인 Loop의 검토가 늘 revise를 고르고 exhausted가 Agent F로 이어진다
  When 실행한다
  Then 2회차가 cap_reached로 끝나고 사용자에게 묻지 않고 F가 실행된다

Scenario: exhausted가 없으면 Run이 실패로 끝난다
  Given maxIterations 1인 Loop의 검토가 revise를 고르고 exhausted에 연결이 없다
  When 첫 회차가 다시 돌기를 요청한다
  Then 사용자에게 묻지 않고 첫 회차가 cap_reached로 끝난다
  And Run이 실패로 끝나고 이유에 그 Loop와 cap_reached가 남는다
  And 첫 회차가 제출한 산출물은 부분 결과로 읽을 수 있다

Scenario: 상한에서 추론 수준을 올려 더 돈다
  Given maxIterations 2이고 limitPolicy가 raise_reasoning(high)인 Loop 안에 추론 수준이 medium으로 고정된 Agent W가 있다
  And 검토가 늘 revise를 고르고 exhausted가 Agent F로 이어진다
  When 실행한다
  Then 2회차가 revise로 끝나고 loop.escalated가 남는다
  And 3회차와 4회차의 W는 high로 요청한다
  And 4회차가 cap_reached로 끝나고 사용자에게 묻지 않고 F가 실행된다

Scenario: 상한에서 상위 모델로 바꿔 더 돈다
  Given maxIterations 1이고 limitPolicy가 upper_model(U)인 Loop 안에 Agent W가 있다
  When 첫 회차가 다시 돌기를 요청한다
  Then 2회차의 W는 U로 요청한다
  When 2회차가 다시 돌기를 요청한다
  Then 2회차가 cap_reached로 끝나고 소진된다

Scenario: 정체해도 한도 정책을 따른다
  Given 정체 감지를 켠, limitPolicy가 upper_model(U)인 Loop의 작성 단계가 두 회차 연속 같은 내용을 제출한다
  When 둘째 회차가 다시 돌기를 요청한다
  Then 둘째 회차가 revise로 끝나고 셋째 회차의 작성 단계는 U로 요청한다
  When 셋째 회차도 같은 내용을 제출한다
  Then 셋째 회차가 stalled로 끝나고 소진된다

Scenario: 바뀌는 Agent가 없으면 바로 소진된다
  Given limitPolicy가 raise_reasoning(high)인 Loop 안의 Agent가 모두 high 이상으로 고정돼 있다
  When 상한에 닿는다
  Then loop.escalated 없이 그 회차가 cap_reached로 끝난다

Scenario: 다시 들어오면 정의의 값으로 시작한다
  Given 바깥 Loop A 안의 Loop B가 추론 수준을 한 번 올린 뒤 끝났다
  When A의 다음 회차에서 B에 다시 들어온다
  Then B 안 Agent는 정의의 추론 수준으로 요청한다
  And B는 상한에서 다시 한 번 올린다

Scenario: 사람이 바꾼 Agent는 그대로 둔다
  Given 사람이 node_future 패치로 Loop 안 Agent W의 모델을 M으로 바꿨다
  When 그 Loop가 upper_model(U)을 적용한다
  Then W는 계속 M으로 요청하고 Loop 안의 다른 Agent는 U로 요청한다

Scenario: 상한 없는 Loop
  Given limitPolicy가 unlimited이고 maxIterations가 없는 Loop의 검토가 30번 revise를 고른 뒤 pass를 고른다
  When 실행한다
  Then 사용자에게 묻지 않고 31회차가 pass로 끝난다

Scenario: 한도 정책의 구조 오류
  Given limitPolicy가 unlimited인데 maxIterations가 있는 Loop
  Then 오류다
  Given limitPolicy가 unlimited가 아닌데 maxIterations가 없는 Loop
  Then 오류다
  Given reviewRecipe가 있는 Loop의 limitPolicy가 raise_reasoning이다
  Then 오류다
  Given upper_model의 modelProfile이 허용 목록에 없다
  Then 오류다

Scenario: 같은 산출물을 다시 내면 정체로 본다
  Given 정체 감지를 켠 Loop의 작성 단계가 두 회차 연속 같은 내용을 제출하고 exhausted가 Agent F로 이어진다
  When 둘째 회차가 다시 돌기를 요청한다
  Then 둘째 회차가 stalled로 끝나고 F가 실행된다

Scenario: 설치 상한보다 많은 회차를 정할 수 있다
  Given maxIterations 25인 Loop
  When 정의를 컴파일하고 실행을 시작한다
  Then 오류 없이 Run이 시작된다

Scenario: 루프로 시작하는 팀
  Given 시작 노드가 Loop인 정의
  When 실행한다
  Then Loop의 1회차부터 실행된다

Scenario: inline Team을 지나간다
  Given P → inline Team T(body → A → exit) → Q 순서의 정의
  When 실행한다
  Then P, A, Q가 차례로 실행되고 Run이 끝난다
  Given 시작 노드가 inline Team인 정의
  Then Team의 첫 구성원부터 실행된다

Scenario: 루프 안의 팀과 팀 안의 루프
  Given Loop A 안에 inline Team C가 있고, C 안의 review Decision이 revise를 A의 repeat에, pass를 A의 exit에 잇는다
  When 검토가 첫 회차에 revise, 둘째 회차에 pass를 고른다
  Then C의 구성원이 A의 회차마다 새 Task로 실행되고 A의 next로 간다
  Given inline Team T 안의 Loop L 안에서 Decision이 T의 exit로 바로 나간다
  Then L의 열린 회차가 pass로 끝나고 T의 next로 간다

Scenario: 참조 팀을 펼쳐 실행한다
  Given 저장된 팀 Y(시작 W → Output, W는 run_input brief를 읽음)를 참조하는 Team T가 P의 출력을 입력으로 받고, T 다음 Q가 T를 읽는다
  When 실행한다
  Then Run 스냅샷에 T.W가 T 안의 구성원으로 있고, T.W는 brief 대신 P의 출력을 받는다
  And Q는 T.W의 출력을 받고 Run이 끝난다
  When 그 뒤 Y가 새 revision으로 저장된다
  Then 이미 시작한 Run의 스냅샷은 바뀌지 않는다

Scenario: 참조 팀 Output의 승인
  Given 참조한 팀의 Output이 requireApproval이다
  When 그 Team의 마지막 단계가 끝난다
  Then T.output 승인을 요청하고, 승인하면 Team 다음 단계로 간다
  When 다른 Run에서 거절한다
  Then 그 Run은 취소된다

Scenario: 참조 팀의 리뷰 레시피가 다른 criteria를 고정했다
  Given 참조한 팀의 Loop 리뷰 레시피 criteria hash가 Run의 criteria와 다르다
  When 실행을 시작한다
  Then 거절되고 Run이 만들어지지 않는다

Scenario: inline Team은 입력을 받거나 읽히지 않는다
  Given inputBindings를 둔 inline Team이나, inline Team을 task_output으로 읽는 Agent
  When 정의를 컴파일한다
  Then 그 노드에 오류가 있다

Scenario: 실패한 Agent를 다시 시도한다
  Given retry.maxAttempts 2인 Agent W의 첫 시도가 실패한다
  When 실행한다
  Then W의 같은 Task에 attemptNo 2인 시도가 시작되고, 첫 시도와 같은 입력 버전과 첫 시도의 오류를 받는다
  When 둘째 시도가 성공한다
  Then Run은 W의 다음 단계로 이어지고 첫 시도의 기록이 남는다

Scenario: 재시도를 다 쓰면 실패 경로로 간다
  Given retry.maxAttempts 1인 Agent W가 매번 실패하고 W의 error가 Agent F로 이어진다
  When 실행한다
  Then W는 두 번 시도되고 F가 W의 이름, 시도 수, 마지막 오류를 step_error로 받아 실행된다
  Given W의 error에 연결이 없다
  Then Run은 execution_failed로 실패한다

Scenario: 취소된 실행은 다시 시도하지 않는다
  Given retry.maxAttempts 2인 Agent W가 실행 중이다
  When 사용자가 Run을 취소한다
  Then W의 새 시도는 시작되지 않는다

Scenario: router가 모델로 route를 고른다
  Given route fix와 ship이 모두 연결된 router R의 선택 실행이 "ship"을 제출한다
  When 실행한다
  Then ship으로 가고 workflow.branch_selected에 model_route와 그 제출이 근거로 남는다

Scenario: router가 고르지 못하면 사람이 고른다
  Given router R의 선택 실행이 route id가 아닌 글을 제출한다
  When 실행한다
  Then 연결된 route를 보이는 route 승인을 요청한다
  When 사용자가 fix를 골라 승인한다
  Then fix로 가고 human_route가 남는다
  When 다른 Run에서 사용자가 같은 승인을 거절한다
  Then 그 Run은 취소된다

Scenario: check가 검사 결과로 갈래를 고른다
  Given 세션 프로젝트에 등록된 검사 types와 tests를 고르는 check Decision이 있다
  When types가 pass, tests가 fail로 끝난다
  Then fail로 가고, check 노드의 검사 실행이 두 검사의 보고서를 근거로 남긴다
  When 다른 Run에서 두 검사가 모두 pass로 끝난다
  Then pass로 간다

Scenario: 판정이 없으면 다시 돌릴지 묻는다
  Given check Decision의 검사가 오류로 끝난다
  Then check 승인을 요청하고 pass나 fail로 가지 않는다
  When 사용자가 승인하고 다시 돈 검사가 pass로 끝난다
  Then 같은 Task의 둘째 시도가 pass로 간다
  When 다른 Run에서 사용자가 거절한다
  Then 그 Run은 취소된다

Scenario: 검사를 실행할 수 없으면 시작하지 않는다
  Given 세션 없이 시작하거나, 작업 사본이 없는 세션에서 시작하거나, 세션 프로젝트에 등록되지 않은 검사를 고른 check Decision
  When 실행을 시작한다
  Then CAPABILITY_DENIED로 거절되고 Run이 만들어지지 않는다

Scenario: 연결 안 된 출구를 고르면 Run이 멈춘다
  Given review Decision의 revise에 연결이 없다
  When 검토가 revise를 고른다
  Then Run은 needs_user로 실패한다

Scenario: 루프 안의 루프와 팀을 감싼 루프를 정의한다
  Given Loop A 안에 Loop B와 inline Team C가 있고 C 안에 Agent와 review Decision이 있다
  When 정의를 컴파일한다
  Then 소속·경계 오류는 없다

Scenario: 조상 루프의 출구로 여러 겹을 한 번에 나간다
  Given Team C 안의 review Decision이 pass를 Loop A의 exit에, revise를 Loop A의 repeat에 잇는다
  When 정의를 컴파일한다
  Then 경계 오류는 없다

Scenario: 다시 도는 길은 결정에서만 들어온다
  Given Loop 안의 Agent out이 그 Loop의 repeat로 이어진다
  When 정의를 컴파일한다
  Then 그 연결에 오류가 있다

Scenario: 끝나는 길이 없는 루프
  Given exit로 들어오는 연결이 없는 Loop
  When 정의를 컴파일한다
  Then 그 Loop에 오류가 있다

Scenario: 바깥에서 상자 구성원으로 바로 들어갈 수 없다
  Given 최상위 Agent의 out이 Loop 안의 Agent in으로 이어진다
  When 정의를 컴파일한다
  Then 그 연결에 경계 오류가 있다

Scenario: 병렬 분기가 합류 없이 만나면 오류다
  Given Agent P의 out이 Agent A와 B로 이어지고 A와 B의 out이 모두 Agent C로 이어진다
  When 정의를 컴파일한다
  Then C로 들어오는 연결에 오류가 있다
  When C를 Join(all)으로 바꾼다
  Then 그 오류는 없다

Scenario: 결정의 두 분기는 합류 없이 모일 수 있다
  Given review Decision의 pass와 revise가 모두 Agent C로 이어진다
  When 정의를 컴파일한다
  Then 병렬 합류 오류는 없다

Scenario: 두 분기를 동시에 돌리고 all Join에서 모은다
  Given Agent P의 out이 Agent A와 B로 이어지고 둘이 all Join J로 모인다
  When 실행한다
  Then A와 B가 동시에 실행되고, 둘 다 끝난 뒤에 J 다음 단계가 한 번 실행된다

Scenario: any Join은 첫 분기로 이어지고 나머지를 멈춘다
  Given A와 B가 any Join J로 모이고 B는 오래 걸린다
  When A가 먼저 끝난다
  Then J 다음 단계가 실행되고 B의 실행은 취소되며 workflow.joined에 B가 멈춘 분기로 남는다
  Given B가 사람의 승인을 기다리고 있었다
  Then 그 승인은 cancelled로 거둬진다

Scenario: 한 분기가 실패하면 Run이 끝난다
  Given 두 분기 중 A가 실패 경로 없이 실패한다
  Then Run은 execution_failed로 끝나고 B도 멈춘다

Scenario: 모이기 전에 끝나는 분기는 오류다
  Given 분기 A가 Output으로, 분기 B가 Join으로 간다
  When 정의를 컴파일한다
  Then A의 연결에 오류가 있다
  Given Loop 안에서 갈라진 분기 A가 그 Loop의 exit로 간다
  Then 그 연결에 오류가 있다

Scenario: Join은 한 포트의 모든 분기를 모은다
  Given 세 갈래로 갈라진 분기 중 둘만 Join J로 들어간다
  When 정의를 컴파일한다
  Then J에 오류가 있다

Scenario: 분기 안의 루프
  Given 분기 A 안에 Loop L이 있고 L의 next가 Join으로 간다
  When 실행한다
  Then L의 회차가 A 안에서 돌고 끝난 뒤 A가 Join에 도착한다

Scenario: 같은 작업 사본에 쓰는 병렬 분기는 경고한다
  Given 파일 쓰기 도구를 가진 Agent 둘이 서로 다른 병렬 분기에 있다
  When 정의를 컴파일한다
  Then 두 Agent에 경고가 있고 정의는 유효하다

Scenario: 참조 팀의 순환
  Given 팀 X가 팀 Y의 revision을 참조하고 Y가 X의 revision을 참조한다
  When X를 컴파일한다
  Then 참조 순환 오류가 있다

Scenario: 찾을 수 없는 참조 팀
  Given 정의 출처에 없는 revision을 참조하는 Team
  When 정의를 컴파일한다
  Then 그 Team에 오류가 있다

Scenario: route가 하나뿐인 router
  Given route가 하나인 router Decision
  When 정의를 컴파일한다
  Then 그 Decision에 오류가 있다

Scenario: 정한 깊이까지 위임한다
  Given maxDelegationDepth가 3이고 scheduled Agent A가 B에, B가 C에, C가 D에, D가 C에 위임할 수 있는 정의
  When 정의를 컴파일한다
  Then 오류가 없다
  When 실행에서 A가 B를, B가 C를, C가 D를 부른다
  Then D의 실행은 깊이 3으로 만들어진다
  When D가 C를 부르려 한다
  Then 깊이 한도로 거절되고 limit.reached(depth)가 남는다

Scenario: 이해하지 못하는 필드
  Given 스키마에 없는 필드가 든 정의를 가져온다
  Then 조용히 버리지 않고 오류로 거절한다
```

## 보안·성능·접근성

- 사용자 코드와 수식을 평가하지 않는다. router는 이름 붙인 route 중 하나를 모델이 고르게 하며, 그 모델 호출은 admission을 따른다. check는 등록 검사만 실행한다.
- 참조 팀은 같은 사용자가 읽을 수 있는 정의만 가져온다. Run 시작 시 펼친 정의를 스냅샷으로 고정하고, 원본이 바뀌어도 그 Run은 바뀌지 않는다.
- 가져오기 크기 제한(1 MiB)과 strict schema는 그대로다. 참조 순환을 금지하므로 펼친 결과는 유한하다.
- 편집 화면의 접근성과 성능은 [팀 편집기](canvas.md)가 정한다.
