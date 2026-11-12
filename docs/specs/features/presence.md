# 기능 명세: 표시 상태

- 상태: accepted
- 비목표: 저장되는 상태 값의 추가([헌장 §3](../constitution.md)의 집합은 그대로다), 서버가 표시 상태를 계산해 내려주는 것, 세션을 미뤄 두는 상태, 세션 목록 묶음의 구성 변경

## 사용자 관측 동작

실행(Run), 실행 단위(Execution), 세션이 화면에 보이는 상태는 한 규칙으로 정한다. 사이드바의 세션 행, 프로젝트 세션 탭의 묶음, 활동 바, 대화의 실행 행 머리 줄, 실행 기록의 머리와 실행 선택기, 현황, 상태 배지가 모두 이 규칙의 결과를 쓴다. 같은 실행이 화면마다 다른 낱말이나 다른 색으로 보이지 않는다.

표시 상태는 아래 표에서 위에서부터 먼저 맞는 것이다.

| 표시 상태 | 조건 | 화면 이름 (KO / EN) | 톤 | 킷 표식 |
|---|---|---|---|---|
| `awaiting_user` | Run이 `awaiting_user`이거나, 실행 단위가 `waiting_approval`이거나, 그 Run에 열린 사용자 질문·확장 요청이 있다 | 응답 대기 / Waiting for you | warning | waiting |
| `failed` | `failed` | 실패 / Failed | danger | failed |
| `interrupted` | Run이 `interrupted` | 중단됨 / Interrupted | danger | failed |
| `stopping` | `cancelling` | 중지하는 중 / Stopping | active | running |
| `pausing` | `pausing` | 일시정지하는 중 / Pausing | active | running |
| `paused` | `paused` | 일시정지됨 / Paused | warning | stopped |
| `starting` | Run이 `created`·`validating`, 실행 단위가 `queued`·`ready` | 시작하는 중 / Starting | active | queued |
| `working` | Run이 `running`, 실행 단위가 `active`·`waiting_children`·`waiting_message` | 작업 중 / Working | active | running |
| `succeeded` | `succeeded` | 완료 / Completed | success | done |
| `cancelled` | `cancelled` | 취소됨 / Cancelled | neutral | stopped |
| `ready` | 세션에 실행이 없고 요청·목적·회의 중 하나가 있다 | 실행 전 / No run yet | neutral | 없음 |
| `empty` | 세션에 실행도 요청·목적·회의도 없다 | 빈 세션 / Empty session | neutral | 없음 |

Run의 표시 상태는 Run의 상태가 정한다. 그 Run의 실행 단위와 열린 요청은 응답 대기를 찾는 데만 쓴다. 끝나지 않은 Run 안에서 실패했거나 취소된 실행 단위는 Run을 실패나 취소됨으로 보이게 하지 않는다. 그 사실은 그 실행 단위의 행이 보인다. 실행 단위의 표시 상태는 그 실행 단위의 상태가 정한다.

`pausing`과 `stopping`은 요청을 접수했고 아직 적용되지 않았다는 뜻이다. `paused`와 `cancelled`로 바뀌기 전에 적용된 것처럼 보이지 않는다.

`awaiting_user`는 무엇을 기다리는지를 함께 갖는다. 열린 요청 가운데 가장 먼저 생긴 것의 종류다. 열린 요청이 없고 승인을 기다리는 실행 단위가 있으면 `approval`이다. 열린 요청도 승인 대기도 없이 `awaiting_user`인 Run(필수 작업이 취소돼 다시 시작할지 끝낼지를 기다리는 Run)은 `continue`다.

| 필요한 것 | 열린 요청 | 화면 이름 (KO / EN) |
|---|---|---|
| `approval` | 도구·출력·검사·route·중단점 승인 | 승인 / Approval |
| `question` | 사용자 질문, 확장 요청 | 질문 / Question |
| `continue` | 계속할지 묻는 승인(Loop 회차, 무진전, 무인 실행 예산, 회의 연쇄) | 계속 여부 / Continue? |

`working`인 실행 단위는 세부를 가질 수 있다. 세부는 상태 이름을 대신하지 않고 그 옆의 활동 글자가 된다.

| 세부 | 조건 | 화면 이름 (KO / EN) |
|---|---|---|
| `waiting_agents` | `waiting_children` | 하위 에이전트 대기 / Waiting for agents |
| `waiting_reply` | 감독이 아닌 실행 단위의 `waiting_message` | 답 대기 / Waiting for a reply |
| `watching` | [감독](advisor.md) 실행 단위의 `waiting_message` | 지켜보는 중 / Watching |

세션의 표시 상태는 그 세션의 최신 실행의 표시 상태다. 종료 확인이 필요한 터미널이 있으면 실행이 없어도 확인 필요에 든다. 세션 탭의 묶음은 [Workbench](../workbench.md#세션-목록의-상태와-처리할-항목)의 규칙을 그대로 쓰고, 표시 상태는 다음처럼 묶음에 대응한다.

| 묶음 | 표시 상태 |
|---|---|
| 확인 필요 | `awaiting_user`, `failed`, `interrupted`, `paused`, 또는 종료 확인이 필요한 터미널 |
| 진행 중 | `starting`, `working`, `pausing`, `stopping` |
| 완료 | `succeeded` |
| 취소됨 | `cancelled` |
| 실행 전 | `ready` |
| 빈 세션 | `empty` |

검토 묶음은 인박스 항목이 정하며 표시 상태와 무관하다.

### 벗어날 때의 유예

실행이 끝나 `starting`이나 `working`에서 `succeeded`나 `cancelled`로 바뀔 때 화면은 그 실행이 끝난 시각부터 2초 동안 이전 표시 상태를 유지한다. 실행 하나가 끝나고 대기 요청이 곧 시작될 때 세션 행이 묶음을 오가거나 상태 글자가 깜박이지 않게 하기 위해서다. 유예 안에 다음 실행이 `starting`·`working`이 되면 유예는 끝나고 그 상태를 보인다. 세션 행은 그동안 진행 중 묶음을 떠나지 않는다.

- 그 밖의 변화는 유예하지 않는다. `awaiting_user`, `failed`, `interrupted`는 바로 보이고, 사람이 누른 일시정지와 중지(`pausing`, `paused`, `stopping`)도 바로 보인다.
- 끝난 지 2초가 넘은 실행에는 유예가 없다(화면을 열었거나 다시 연결했을 때 이미 끝나 있던 실행). 끝난 시각을 모르면 그 변화를 처음 본 시각부터 2초다.
- 유예가 끝나는 시각은 한 번 정해지면 다시 물어도 뒤로 밀리지 않는다.
- 유예는 표시만 늦춘다. 대기 요청의 시작, 명령의 접수, 알림은 늦추지 않는다.

### 한 화면에 한 번

한 화면에서 같은 대상의 상태 이름은 글자로 한 번만 보인다. 그 대상을 가리키는 다른 자리는 점이나 표식만 쓰거나 상태를 생략한다. 묶음 이름이 상태를 말하면 그 안의 행은 상태 이름을 다시 쓰지 않는다.

## 계약

- 판정은 React에 기대지 않는 순수 함수이고 `packages/react/src/run/presence.ts`에 있다. 실행 단위, Run(그 실행 단위들과 열린 요청), 세션(최신 실행과 터미널 확인 항목) 세 가지 입력을 받는다. 입력의 상태 값은 `packages/contracts`의 enum이다.
- 결과는 표시 상태, 필요한 것(있을 때), 세부(있을 때), 톤, 킷 표식, 문구 키다. 화면은 상태 값을 직접 비교하지 않고 이 결과만 쓴다.
- 유예는 같은 파일의 순수 함수가 이전 결과, 새 결과, 실행이 끝난 시각(모르면 변화를 처음 본 시각), 현재 시각을 받아 보일 상태와 유예가 끝나는 시각을 돌려준다. 현재 시각은 인자로 받는다.
- 화면 문구는 `packages/react/src/messages/{en,ko}.json`의 `Presence` 네임스페이스 하나에 둔다. `Status` 네임스페이스는 Task, 지시 전달, receipt, 질문 상태의 낱말만 갖는다.
- 상태 이름을 글자로 보이는 요소는 `data-presence-label`을 갖는다.
- 표시 상태는 저장하지 않고 이벤트 투영과 실행 목록에서 매번 계산한다. 사이드바 배지의 정의는 [확인 필요](inbox.md)를 따른다.

## 수용 시나리오

```gherkin
Given 실행 단위 하나가 승인을 기다리고 다른 실행 단위가 실패한 Run
When 그 Run의 표시 상태를 정한다
Then 응답 대기이고 필요한 것은 승인이다

Given 실행 단위 하나가 실패했고 다른 실행 단위가 일하고 있는, 끝나지 않은 Run
Then 그 Run은 작업 중으로 보이고 실패한 실행 단위의 행만 실패로 보인다

Given 일시정지를 요청했고 아직 안전한 경계에 닿지 않은 Run
Then 일시정지하는 중으로 보이고 일시정지됨으로 보이지 않는다

Given 취소를 요청했고 종료가 확정되지 않은 Run
Then 중지하는 중으로 보이고 취소됨으로 보이지 않는다

Given 작업 중이던 세션의 실행이 완료됐고 대기 요청이 1초 뒤 시작됐다
Then 세션 행은 진행 중 묶음에 그대로 있다

Given 작업 중이던 실행이 응답 대기가 됐다
Then 세션 행은 유예 없이 확인 필요로 옮겨 간다

Given 5분 전에 끝난 실행이 있는 세션을 연다
Then 완료로 바로 보인다

Given 사이드바, 활동 바, 실행 행이 같은 실행을 보이는 화면
Then 그 실행의 상태 이름은 글자로 한 번만 보인다
```

## 보안·성능·접근성

- 상태는 색만으로 구분하지 않는다. 글자 또는 접근 가능한 이름을 가진 표식이 함께 있다.
- 상태 변화의 알림은 표시 상태가 바뀔 때만 낸다. 경과 시간은 알림 영역에 넣지 않는다. 유예 중에도 응답 대기와 실패의 알림은 바로 낸다.
- 판정은 이미 받은 투영과 실행 목록만 쓰며 조회를 더하지 않는다.
