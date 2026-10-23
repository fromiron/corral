# CR-046 P18-B — execution 근거 이동과 Reins 대상 고정

범위: CRL-WBD-015 / C-159 / TC-WBD-015-H,N,F. 세션 도킹의 execution 제어에서 그 execution이 남긴 파일·결과·검사로 이동하는 기능과, 확인 뒤 보내는 Run 명령이 다른 Run에 닿지 않게 하는 고정의 검증 기록이다. 설치판·다른 OS·스크린리더를 포함하는 release gate가 아니다. 계약은 [CR-046](../change-requests/CR-046-development-workbench.md)의 P18 절을 따른다.

## 환경

- 기준 commit `09d8b37`(P18-A) 위의 작업 트리. 이 기록은 그 위의 P18-B commit에 포함된다.
- Linux, Node 24.14.0, pnpm 10.30.3, Chromium(인앱 브라우저).
- agent는 서버의 결정적 `ScriptedAgentAdapter`(`--no-live`)였다. 유료 모델·외부 호출은 쓰지 않았다.

## red 확인

구현 전에 새 시험이 실패했다.

- `RunActions`를 단독으로 렌더한 시험: 취소 확인을 연 뒤 store가 다른 Run으로 바뀌어도 확인 버튼이 남았다. `RunView` 안에서는 Run마다 다시 마운트되어 이미 안전했으므로 그 경로의 시험은 처음부터 통과했다.
- `ReinsPanel`: execution 취소 확인이 다른 Run에서도 남았다.
- `ExecutionEvidence`: 모듈이 없었다.
- 인앱 확인 중 P18-A의 결함을 하나 찾았다. 다른 탭 뒤에 숨은 팀 그래프의 canvas 노드가 대화 위에 그려졌다. Dockview는 숨긴 탭을 `visibility: hidden`으로 감추는데, ReactFlow 노드가 인라인 `visibility: visible`로 이를 덮었다. 회귀 시험을 먼저 추가해 실패를 확인하고, 숨은 그래프 탭은 렌더링에서 빼도록(`hidden`) 고쳤다.

## 결과

| 시험 | 결과 |
|---|---|
| `packages/react` 단위 전체 | 31 파일 190건 통과 |
| Studio 단위 전체 | 59 파일 261건 통과 |
| `pnpm build` | 통과 |
| `pnpm spec:check` | 통과(커밋 전 실행) |

- H: execution 근거에는 그 run·execution의 파일 쓰기만 나온다. 각 파일은 Run 비교의 해당 파일(`scope=run&runId&file`)로 연결된다. 결과는 결과 보기를 연다. 그 execution이 소유한 검사만 Checks로 연결된다. 결과를 모르는 쓰기는 따로 표시된다.
- N: Run 전체·execution 취소 확인을 연 뒤 view가 다른 Run을 따라가면 확인이 사라진다. 원래 Run으로 돌아와도 되살아나지 않으며 명령은 보내지지 않는다. 숨은 그래프 탭은 그리지 않는다.
- F: 세션을 바꾼 뒤 도착한 이전 세션의 파일 기록은 표시되지 않는다.

기존 시험은 바꾸지 않았다. `sendCommand(command)` 호출 형태를 단언하는 기존 Reins 시험도 그대로 통과한다.

## 인앱 확인

`node apps/server/src/main.ts --no-live --static apps/studio/dist`로 임시 workspace의 서버를 띄웠다. 인앱 브라우저(1280×800)에서 확인했다.

1. 저장 팀(`write_file` 허용)을 지정한 세션에서 사본을 만들고 “Write the notes”를 보냈다. 결정적 Run이 `notes/writer.md`를 썼다.
2. 실행 pane에서 writer execution의 제어를 열었다. Reins 아래에 “파일: notes/writer.md”, “결과: text · v1”이 보였다. 이 execution이 소유한 검사는 없어 검사 묶음은 나오지 않았다.
3. 파일을 누르자 그 Run 비교의 검토 화면이 열렸다. `notes/writer.md`가 선택돼 있었고 출처는 Corral이었다.
4. 대화 탭으로 돌아왔을 때 뒤쪽 팀 그래프 탭의 노드는 더 이상 대화 위에 보이지 않았다. 수정 전에는 보였다.

확인 뒤 시험 사본과 이번 확인에서 생긴 빈 사본·검사 폴더를 지웠다.

## 한계와 남은 일

- host 전환은 services마다 Run store를 따로 쓰는 기존 구조에 맡겼고 따로 시험하지 않았다.
- attempt가 바뀐 뒤의 restart는 기존 `expectedControlRevision` 검사로 막는다. 이번에는 새 반례를 더하지 않았다.
- 검사 소유가 execution인 경로(agent의 검사 도구)는 단위 시험으로만 확인했다. 인앱 Run은 검사를 실행하지 않았다.
- 전체 Run 페이지(`/runs/:id`)에는 execution 근거를 넣지 않았다. 세션을 모르는 화면이기 때문이다.
- 다른 OS·설치판·실제 스크린리더는 확인하지 않았다.
