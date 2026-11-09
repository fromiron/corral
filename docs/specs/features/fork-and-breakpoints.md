# 기능 명세: 포크와 중단점

- 상태: implemented
- 비목표: 실행 중인 Run을 그 자리에서 되감기, 상자(Loop·Team) 안이나 병렬 분기 안의 단계에서 포크, 저장된 팀 없이 시작한 Run(대화의 자동 팀)에서 포크, 끝난 뒤 멈추는 중단점, 작업 사본 파일을 그 시점으로 되돌리기, 중단점을 팀 정의에 저장하기

둘 다 실행 옵션이다. 팀 정의에 저장하지 않고 Run을 시작할 때나 실행 중에 고른다. 그래프 실행 규칙은 [팀 그래프 모델](team-graph.md)을 따른다.

## 사용자 관측 동작

**포크.** 저장된 팀으로 시작해 끝난 Run의 실행 화면에서 최상위 단계를 골라 "여기서 다시 실행"을 누른다. 같은 세션에 새 Run이 시작되고 그 Run으로 이동한다. 새 Run은 그 단계부터 돈다. 그 앞 단계는 다시 돌지 않고, 원래 Run에서 제출한 결과를 새 Run으로 복사해 쓴다. 팀은 지금 저장된 버전(포크 전에 고친 지시·모델 포함)을 쓰고, 요청과 기준은 원래 Run이 시작할 때의 것을 쓴다. 작업 사본 파일은 지금 상태 그대로다. 원래 Run의 기록은 바뀌지 않는다. 새 Run이 성공하면 원래 Run의 단계 결과는 같은 세션의 다른 Run과 같이 해제된다. 새 Run의 실행 정보는 어느 Run의 어느 단계에서 갈라졌는지 보이고 원래 Run으로 이어진다. 앞 단계 결과가 남아 있지 않은 Run(같은 세션에서 더 나중에 시작한 Run이 성공한 경우)에는 이 동작이 보이지 않는다.

**중단점.** 팀 편집기에서 실행하기 전에 단계에 중단점을 걸어 두면 그 실행에 쓰인다. 실행 중에도 실행 화면에서 단계를 골라 걸거나 뗄 수 있다. 중단점이 걸린 단계는 시작하기 직전에 멈춘다. 그 단계가 받을 입력을 보고, 필요하면 그 단계의 앞으로의 설정(지시·모델·추론)을 바꾼 뒤 "계속"을 누르면 시작한다. "중단"을 누르면 Run을 취소한다. 멈춘 동안 다른 갈래는 계속 진행한다. Loop 안의 단계는 회차마다 멈춘다.

## 계약

### 포크

- `POST /runs`의 `forkFrom: { runId, nodeId }`. 팀은 요청의 `corralId`·`definitionRevision`으로 정한다. 정의를 직접 보내는 시작(브라우저 데모)은 보낸 정의를 쓴다. `input`·`startFrom`·`references`와 함께 보내면 `SCHEMA_INVALID`로 거절한다.
- 원래 Run은 끝났고 요청과 같은 세션(둘 다 세션 없음 포함)이어야 한다. 아니면 `TARGET_NOT_FOUND`.
- 포크할 수 있는 단계: 원래 Run의 정의와 지금 정의 모두에 있고, 지금 정의의 최상위(상자 밖) scheduled Agent·Loop·Team이며, 병렬 분기 안에 있지 않다. 그 단계에서 갈 수 있는 모든 모으는 Join의 갈라지는 지점도 그 단계에서 갈 수 있어야 한다. 단계가 어느 정의에도 없으면 `TARGET_NOT_FOUND`, 있지만 포크할 수 없으면 `GRAPH_INVALID`.
- 새 Run은 그 단계를 시작 단계로 삼아 그 단계에서 갈 수 있는 단계만 실행한다. 정의의 시작 단계와 나머지 그래프는 바꾸지 않는다.
- 다시 돌지 않는 단계의 결과: 새 Run에서 실행될 수 있는 노드(갈 수 있는 단계, Output, callable Agent)가 `task_output`으로 읽는 노드 중 포크 단계에서 갈 수 없는 노드마다, 원래 Run에서 그 노드가 마지막으로 완료 제출한 버전의 본문을 새 Run의 새 ID로 복사한다. 새 Run은 원래 Run의 버전을 읽지 않는다. 그런 노드의 `task_output`은 복사본을 읽는다. 원래 Run에 그 결과가 없거나 본문이 해제되었고 바인딩이 optional이 아니면 `TARGET_NOT_FOUND`로 거절하고 Run을 만들지 않는다. 복사한 본문 합계가 산출물 크기 상한을 넘으면 `LIMIT_REACHED`.
- 요청과 기준은 원래 Run 정의의 `input`을 쓴다. 나머지(역할·노드·연결·한도)는 지금 정의를 쓴다.
- `run.started`는 `forkedFrom: { runId, nodeId, carried: [{ nodeId, artifactVersionIds }] }`를 남긴다. 복사본 본문은 같은 저장 트랜잭션에 기록한다.
- 같은 commandId와 본문의 재시도는 같은 결과를 돌려준다.

포크에 필요한 앞 단계 결과의 보관은 [본문 수명 계약](../api-contract.md#산출물-본문-수명)이 정한다.

### 중단점

- 시작 요청의 `breakpoints: nodeId[]`, 실행 중 명령 `set_breakpoints { nodeIds }`(목록 전체를 바꾼다). 둘 다 그 Run 정의의 scheduled Agent와 Decision만 받는다(상자 안 포함). 없는 노드나 다른 종류가 하나라도 있으면 `TARGET_NOT_FOUND`로 거절하고 목록은 바뀌지 않는다.
- 이벤트 `breakpoints.changed { nodeIds }`. 시작 요청의 목록은 `run.started` 뒤에 남는다. 실행 중 바뀐 목록은 다음에 시작하는 단계부터 적용한다. 이미 멈춘 단계의 승인은 그대로 남는다. 같은 목록으로 바꾸면 이벤트 없이 적용된다.
- 중단점 단계가 시작하려 하면 `approval.requested { kind: 'breakpoint', nodeId, subjectVersionIds }`를 남기고 그 단계만 기다린다. 대상은 그 단계가 받을 입력 버전이고, 입력 버전이 없으면 현재 기준 버전이다. 병렬 분기의 다른 단계는 계속한다.
- `approve`면 그 시점의 control revision(앞서 적용한 `node_future` 패치 포함)으로 단계를 시작한다. `reject`면 사용자의 Run 취소와 같이 `cancel.requested`(scope run, reason `breakpoint_rejected`)로 Run을 끝낸다.
- 단계가 갈래 정지로 멈추면 그 승인은 취소로 닫힌다. Run 취소는 열린 중단점 승인을 함께 닫는다.

## 수용 시나리오

```gherkin
Scenario: 고친 팀으로 가운데 단계부터 다시 실행한다
  Given A → B → C 팀으로 끝난 Run R과, 그 뒤 B의 지시를 고쳐 저장한 팀
  When R의 B에서 포크한다
  Then 새 Run이 B부터 시작하고 A는 실행되지 않는다
  And B는 R에서 A가 제출한 본문을 복사한 새 버전을 입력으로 받고 고친 지시를 쓴다
  And 새 Run의 요청과 기준은 R과 같고 run.started에 forkedFrom이 남는다
  And 포크는 R의 기록과 산출물을 바꾸지 않는다. 새 Run이 성공하면 R의 단계 결과는 본문 수명에 따라 해제된다

Scenario: 포크한 Run에서 다시 포크한다
  Given R의 B에서 포크해 성공한 Run F
  When F의 C에서 포크한다
  Then A와 B의 결과는 F가 가진 본문에서 복사된다

Scenario: 포크할 수 없는 단계
  Given 병렬 분기 안의 단계, Loop 안의 단계, Output, 또는 지금 정의에 없는 단계
  When 그 단계에서 포크한다
  Then GRAPH_INVALID 또는 TARGET_NOT_FOUND로 거절되고 Run이 만들어지지 않는다

Scenario: 필요한 앞 결과가 없다
  Given R에서 A가 결과를 제출하지 않았고 B가 A를 optional 아닌 task_output으로 읽는다
  When R의 B에서 포크한다
  Then TARGET_NOT_FOUND로 거절된다

Scenario: 앞 결과가 해제된 Run
  Given R 뒤에 같은 세션에서 시작한 Run이 성공했다
  When R의 B에서 포크한다
  Then TARGET_NOT_FOUND로 거절되고 실행 화면에 포크 동작이 보이지 않는다

Scenario: 다른 세션이나 끝나지 않은 Run
  Given 실행 중인 Run이나 다른 세션의 Run
  When 그 Run에서 포크한다
  Then TARGET_NOT_FOUND로 거절된다

Scenario: 중단점에서 멈추고 고친 뒤 계속한다
  Given A → B 팀을 B에 중단점을 걸고 시작했다
  When A가 끝난다
  Then B가 시작하지 않고 breakpoint 승인을 기다리며 A가 제출한 버전이 그 대상이다
  When B의 지시를 node_future 패치로 바꾼 뒤 승인한다
  Then B가 바뀐 지시로 시작한다

Scenario: 중단점에서 멈추기를 고른다
  Given B의 중단점 승인을 기다린다
  When 거절한다
  Then Run이 취소되고 B는 시작하지 않는다

Scenario: 실행 중에 중단점을 건다
  Given A → B → C 팀이 A를 실행 중이다
  When C에 중단점을 건다
  Then breakpoints.changed가 남고 B는 멈추지 않고 C가 시작 전에 멈춘다

Scenario: 병렬 분기의 한쪽만 멈춘다
  Given 병렬 분기 P와 Q 중 P에 중단점이 있다
  When 두 분기가 시작하려 한다
  Then P만 기다리고 Q는 실행된다

Scenario: Loop 안의 중단점은 회차마다 멈춘다
  Given Loop 안의 W에 중단점이 있다
  When 둘째 회차가 시작한다
  Then W가 다시 시작 전에 멈춘다

Scenario: 중단점 대상이 아닌 노드
  Given callable Agent나 Output에 중단점을 걸려 한다
  Then TARGET_NOT_FOUND로 거절되고 목록이 바뀌지 않는다

Scenario: 취소가 열린 중단점을 닫는다
  Given B의 중단점 승인을 기다린다
  When Run을 취소한다
  Then 그 승인은 취소로 닫히고 B는 시작하지 않는다
```

## 보안·성능·접근성

- 포크는 같은 세션의 Run 결과만 복사한다. 복사는 산출물 크기 상한을 따른다. 원래 Run의 권한·도구 허용은 넘어오지 않고 지금 정의의 역할을 쓴다.
- 단계 결과 보관은 Run마다 노드당 마지막 제출 하나로 제한하고, 같은 세션의 다음 성공 Run이 해제한다.
- 중단점 승인은 다른 승인과 같은 대응 영역에 보이고 키보드로 다룰 수 있다.
