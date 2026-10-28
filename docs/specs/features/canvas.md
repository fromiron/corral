# 기능 명세: Canvas — 정의를 만드는 경험

- 상태: accepted (2026-10-15)
- 기준: [스펙](../product-contract.md) §4.1–4.2, §5, [기술 설계](../technical-design.md) §4, §13
- 비목표: Loop·Decision의 **실행**(GraphRunner·검토 루프는 [기술 설계](../technical-design.md)), 서버 저장, 실행 중 구조 변경, 자동 레이아웃

## 사용자 관측 동작

1. **네 종류의 노드.** 팔레트에서 Agent, Decision, Loop, Output을 드롭하거나 추가한다. Agent는 `scheduled`/`callable`을 고른다. Decision은 `review`/`approval`/`rule` 중 하나이며 모드에 따라 출구 포트가 다르다.
   가로 팔레트에서도 네 추가 버튼은 별도의 팔레트 스크롤 없이 보이며, 좁은 배치에서는 항목을 줄바꿈한다. 추가와 D&D는 같은 노드 생성 경로를 유지한다. 진단이 많아지면 진단 영역만 스크롤하며, 추가 버튼과 캔버스의 드롭·연결 영역을 가리지 않는다.
2. **두 종류의 선.** control edge는 실행 순서다. capability link(`delegate`, `question`)는 호출 허용이며 순서가 아니다. 두 선은 모양·핸들·범례로 구별된다. 선택·비선택 상태 모두에서 노드 카드가 핸들의 포인터 입력을 가리지 않는다. 연결을 끄는 동안 유효한 대상과 거절 이유를 보여준다.
3. **Loop 영역.** Loop는 노드를 담는 영역이다. 노드를 영역 안으로 끌면 본문에 들어가고(정의 변경, hash 변경), 영역을 움직이면 본문 노드가 함께 움직인다(레이아웃만 변경, hash 불변). 경계를 잘못 넘는 연결은 위치와 함께 표시한다.
4. **실행 전 검증.** 문제 목록의 각 항목은 해당 노드·연결로 이동한다. 오류가 있으면 실행을 시작할 수 없다. 편집기 검증은 신뢰 경계가 아니며, 같은 compiler를 runtime이 다시 쓴다.
5. **입력 바인딩.** 노드 속성에서 입력의 출처(run 입력, 앞 작업 출력, 이전 회차 출력 등)를 고른다. 연결할 때 기본 바인딩을 제안하지만 사용자가 바꿀 수 있다.
6. **저장과 이동.** 작업 공간(`/`)에서 Corral을 만들고, 열고, 복제한다. 편집은 `/corrals/:id/edit`. 정의와 레이아웃은 따로 저장되며 각자 revision을 가진다. JSON으로 내보내고 가져온다. 이해하지 못하는 버전·필드는 오류로 거절한다.
7. **되돌리기.** Undo/Redo는 편집기의 미실행 변경만 되돌린다. 드래그 한 번은 되돌리기 한 번이다. 텍스트 입력 중에는 브라우저 기본 되돌리기를 쓴다.
8. **키보드.** 포인터 없이 노드 추가·선택·이동·연결·삭제를 할 수 있다. IME 조합 중 Enter는 아무 동작도 하지 않는다.

## 계약

- **정의 원본:** `packages/contracts`의 Zod. JSON Schema는 생성물(`packages/contracts/generated/`)이며 `pnpm contracts:check`가 최신인지 검사한다. 생성물과 seed schema(`contracts/*.schema.json`)와 Zod는 같은 fixture에 같은 판정을 내야 한다.
- **포트 표:** 한 곳(`@corral/core` compiler)에서 정의하고 캔버스 연결 규칙과 compiler가 함께 쓴다.

| 노드 | 들어오는 포트 | 나가는 포트 |
|---|---|---|
| Agent (scheduled) | `in` | `out` |
| Agent (callable) | 없음 (capability link의 대상) | 없음 |
| Decision `review` | `in` | `pass`, `revise` |
| Decision `approval` | `in` | `approve`, `reject` |
| Decision `rule` | `in` | `yes`, `no` |
| Loop | `enter`, `repeat`, `exit` | `body`, `next` |
| Output | `in` | 없음 |

- **진단:** `{ code, severity, message, nodeId?, edgeId?, linkId? }`. `code`는 고정 enum이며 UI 문구는 메시지 카탈로그에서 code로 찾는다.
- **IR:** 유효한 정의만 `CompiledPlan`(entry, 단계별 다음 노드, Loop 본문·회차 상한, callable 관계, 요약)으로 바뀐다.
- **저장 revision:** 저장 시 definitionHash가 바뀌면 `definitionRevision`이 1 오르고, 레이아웃이 바뀌면 `layoutRevision`이 1 오른다. 서로 독립이다.
- **저장 표시:** 성공한 저장은 경로·팀 목록·세션의 팀 요약과 역할 안내에 즉시 반영한다. 미저장 초안과 이미 시작한 실행의 정의는 바꾸지 않는다.
- **템플릿 사본:** 템플릿 편집 진입만으로 저장하지 않는다. 이름과 사본 저장을 확인한 뒤 편집기를 열며, 같은 프로젝트의 동명 사본은 번호로 구별한다. 사본 이름에 번호가 붙으면 저장 대화상자가 같은 이름 계산으로 저장될 이름을 미리 알려 준다.
- **호출 연결 폼:** 좁은 속성 패널에서도 종류·대상·추가 동작을 함께 읽고 조작할 수 있도록 줄바꿈한다.

## 수용 시나리오

[canvas.feature](canvas.feature).

## 보안·성능·접근성

- 가져오기 파일은 신뢰하지 않는다. strict schema로 거절하고 크기를 제한한다(1 MiB).
- 노드 상태와 오류는 색만이 아니라 기호·문구로 표시한다. 핸들에 금지된 ARIA 속성을 두지 않는다.
- 캔버스 노드는 자기 상태만 구독한다.
