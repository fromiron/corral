# 통합 흐름: 작업 계획

세션 작업 화면을 `입력 → 실행·실시간 감독 → 중간 개입·인용 → 결과 확인` 한 줄기로 다시 짠다. 화면은 이식된 디자인 킷을 다시 배치해서 만들고, 그 흐름이 기대는 백엔드 경로 가운데 약한 곳을 먼저 고친다. 감독 역할(Advisor), 실행 중 합류·끼어들기, 단일 상태 판정과 활동 바, 답변 인용, 회의 무응답 정책을 이 흐름 안에 넣는다.

이 문서는 계획이다. 동작의 정본은 [명세](../specs/README.md)이고, 아래 결정은 S0에서 명세에 먼저 적은 뒤 구현한다. 근거가 된 조사(샘플 레포 3개, Corral 현황)는 Git 이력과 대화 기록에 있고 여기 옮기지 않는다.

선행: [세션 사용성 개선](session-usability.md)의 병합된 단계 위에서 작업한다. 그 계획의 B3(세션 단위 압축)·B4(판정 모델 GPU)는 이 계획 범위가 아니다.

## 0. 진행 표

| 단계 | 내용 | 상태 |
|---|---|---|
| S0 | 명세 변경(오케스트레이터) | 완료 |
| 백본 | B1–B10 | 진행 중(B1·B7·B8 병합) |
| 화면 | K1, U1–U14 | 진행 중(K1·U1 병합) |
| 회의 | M1–M4 | 대기 |
| 감독 | A1–A9 | 대기 |
| 검증 | V1(기준선), V2(최종 장면) | 진행 중(V1 수정) |

태스크별 상태는 §7 표의 마지막 열에 적는다. 단계를 끝낸 커밋에서 이 표를 고친다.

## 1. 목표와 합격 기준

화면이 지금 약한 이유는 부품이 아니라 조합이다. 킷의 `ToolCallCard`, `Skeleton`, `AgentHandoff`, `Keycap`은 Studio에서 한 번도 쓰이지 않고, 같은 실행 상태를 열네 곳이 따로 판정하며, 대화 본문에는 조건부로 나타났다 사라지는 블록이 스무 개 가까이 있다. 그래서 목표는 새 부품이 아니라 아래 열 가지다. 열 가지를 모두 통과해야 끝난 것으로 본다(항목당 10점).

| # | 기준 | 판정 방법 |
|---|---|---|
| 1 | 입력 동선이 하나다. 대화·팀 실행·회의가 같은 컴포저를 쓰고, 보내기 전에 그 입력이 어디로 가는지 보인다 | 장면 ①③, 회의 장면 |
| 2 | 보낸 메시지가 어떻게 됐는지 그 메시지 아래 한 줄에서 끝까지 보인다 | 장면 ③ |
| 3 | 상태가 바뀔 때 화면이 튀지 않는다(기존 항목의 위치 변화 1px 이하) | §9 이동 측정기 |
| 4 | 같은 대상의 상태 이름은 한 화면에 한 번만 나온다 | 같은 값의 `[data-presence-label]` 가시 개수 |
| 5 | 사람의 응답이 필요한 것은 한 자리에 있고, 대화·확인 필요·실행 기록이 같은 카드를 쓴다 | 장면 ④ |
| 6 | 여러 역할이 동시에 일할 때 한 줄로 파악되고, 조작 두 번 안에 특정 역할에 합류한다 | 장면 ② |
| 7 | 답변 일부를 골라 다음 입력에 싣고, 보낸 뒤 원문 위치로 돌아갈 수 있다 | 장면 ⑤ |
| 8 | ①~⑤를 키보드만으로 할 수 있다 | 장면별 키보드 실행 |
| 9 | 밀도: 1280×800에서 상단 줄 + 쉬는 컴포저(활동 바·입력 한 줄·도구 줄·세션 누계 줄)가 200px 이하, 본문 열 720–760px. V1 기준선은 265px과 680px이다 | 측정기 |
| 10 | 킷 언어만 쓴다. 토큰 밖의 색·간격·반경이 없고 모션은 킷 토큰만 쓰며 reduced motion에서 읽힌다 | diff 검토, 장면 reduced motion |

## 2. 결정 사항

기존 명세와 부딪치는 곳은 아래처럼 정했다. 이유는 한 줄씩만 적는다.

**D1. 실행 중 입력의 기본은 합류다.** 실행이 돌고 지시를 받을 수 있는 대상이 있으면 보내기 키는 합류(다음 모델 요청에 실림)다. 끼어들기와 다음 요청은 같은 입력창의 다른 키다. 지금은 가장 잦은 의도(지금 하는 일 고치기)가 선택 두 번을 거쳐야 한다. [workbench.md](../specs/workbench.md) 154행의 "기본 입력은 다음 요청이며 지시는 사용자가 명시적으로 선택한다"와 156행의 선택 표시 규칙을 바꾼다. 대상은 한 역할 실행이면 그 실행, 팀 실행이면 활동 바에서 고른 실행이고 고르지 않았으면 대화에 답을 쓰는 실행이다. 첫 글자에서 대상을 고정하는 규칙은 유지한다.

**D2. 끼어들기는 지시의 두 번째 전달 방식이다.** `steer`의 `delivery`에 `interrupt`를 더한다. 모델 응답이 흐르는 중이면 그 응답을 끊고 다음 요청에 바로 싣는다. 도구가 실행 중이면 끊지 않고 그 도구가 끝난 직후에 싣는다. 끊긴 응답은 지금의 중단된 출력 규칙으로 남고 사용량은 보고·추정·미확인 중 하나로 기록한다. 어댑터가 지원할 때만 화면에 나온다. 지시 전달 상태 집합([헌장](../specs/constitution.md) §3)은 바꾸지 않는다.

**D3. 읽히지 못한 합류 메시지는 서버가 다음 요청으로 넘긴다.** 대상이 성공으로 끝나 지시가 `expired`가 되면 그 메시지를 대기열 맨 앞의 대기 요청으로 바꾸고, 자동 시작 설정과 무관하게 Run이 끝나는 대로 시작한다. 지금 하는 일에 반영하려던 말이라 뒤에 쌓인 다음 요청보다 먼저다. 메시지 아래 줄에 "먼저 끝나 새 요청으로 시작"이라고 적는다. 대상이 실패했거나 사용자가 취소해서 못 읽힌 경우는 넘기지 않고 다시 보내기만 둔다.

**D4. 대기 요청은 서버가 시작한다.** 지금은 실행 종료를 본 탭만 다음 요청을 시작해서, 탭을 닫으면 대기열이 멈춘다. 자동 시작 설정은 세션에 저장하고 `localStorage`의 `corral:auto-queue:*`는 지운다. 기본값은 켬으로 바꾼다(지금은 끔). D1 뒤로 다음 요청은 사용자가 따로 고른 전송이라, 실행이 끝나면 시작되는 쪽이 기대와 맞다.

**D5. 상태 판정은 함수 하나가 한다.** `packages/react/src/run/presence.ts`가 실행·실행 단위·세션의 표시 상태를 정하고 열네 곳이 이것만 쓴다. `pausing`은 "일시정지하는 중", `cancelling`은 "중지하는 중"으로 따로 보인다(접수와 적용을 구분). 문구는 `Presence` 네임스페이스 하나에 둔다. [용어집](../specs/glossary.md) "남은 불일치"의 상태 어휘 항목이 이것으로 닫힌다.

**D6. 작업 중에서 벗어날 때 2초 유예한다.** 실행이 끝나고 다음 실행이 곧 이어질 때 행이 묶음을 오가는 것을 막는다. 응답 대기와 실패, 사람이 누른 일시정지·중지는 유예 없이 바로 보인다. 유예는 실행이 끝난 시각부터 2초이고, 끝난 지 2초가 넘은 실행에는 없다.

**D7. 실행 상태 줄은 컴포저 위 활동 바 하나다.** 상단 줄의 실행 알약(`DockRunControls`), 컴포저 머리의 전송 방식·대상 선택, 컴포저 위 행동 배너, 대화 위 유실 알림을 없애고 활동 바가 맡는다. 일시정지·재개·중지는 활동 바를 펼친 곳과 입력이 비었을 때의 보내기 버튼 자리에 둔다. [workbench.md](../specs/workbench.md) 154행의 "Run 전체 중지는 상단 바의 실행 조작에서"를 바꾼다. 활성 실행 단위가 하나면 중지에 확인을 묻지 않는다. 둘 이상을 함께 멈출 때만 확인한다.

**D8. 대화 본문은 고정 자리 구조다.** §4.3의 규칙 일곱 개를 [채팅 위젯 계약](../specs/chat-widgets-contract.md)에 넣는다.

**D9. 답변 인용은 첨부의 한 종류다.** 텍스트 첨부 출처에 `reply`를 더한다. 합류·끼어들기에도 텍스트 첨부를 싣는다([workbench.md](../specs/workbench.md) 220행의 "`next`와 `queue`에 보존"을 넓힌다). 이미지는 지금처럼 새 요청에만 싣는다.

**D10. 감독 역할은 팀 그래프의 세 번째 호출 방식이다.** 노드 `invocation`에 `observer`를, 능력 연결에 `advise`를 더한다. 감독 노드는 제어 흐름 간선을 갖지 않고 `advise` 연결로 지켜볼 역할을 가리킨다. 같은 Run 안의 실행 단위로 돌아 허가와 사용량이 기존 경로로 정산된다. 조언은 권한을 바꾸지 못하는 지시이고, 종료된 실행을 다시 깨우지 않는다(헌장: 종료 상태에서 돌아가지 않는다). 일반 대화에서는 세션 설정으로 켠다.

**D11. 조용한 상한은 두지 않고, 무인 구간에는 사람 확인을 둔다.** [제품 계약](../specs/product-contract.md) 283행과 [하네스 계약](../specs/harness-contract.md) 47행의 "모델 요청 수 상한을 두지 않는다"를 고친다. 시간·토큰·비용 상한은 지금처럼 없다. 더하는 것은 두 가지다.
- 무인 실행 예산: 대화에 직접 답하는 실행을 뺀 모든 실행 단위(팀 역할, 동적 자식, 감독)에 모델 요청 예산을 둔다. 기본값은 팀 역할 400, 동적 자식 200, 감독 60이다. 예산에 닿으면 마무리 지시, 1.5배에서 결과 제출 지시, 그 뒤 5회 안에 끝나지 않으면 "계속" 승인을 기다린다. 무진전 승인과 같은 장치를 쓰고 조용히 끝내지 않는다. `run_limits` 패치로 50–2000 또는 0(끔)으로 바꾼다.
- 회의 연쇄 확인: 사람 메시지 없이 참가자 멘션으로 이어진 라운드가 8개가 되면 멈추고 "계속"을 묻는다. 지금은 A가 B를, B가 다시 A를 부르는 일이 끝없이 이어질 수 있다.

**D12. 회의 선택은 점수와 정책으로 나눈다.** 선택기는 참가자별 점수만 내고, 누구를 몇 명 고를지는 `packages/core`의 코드가 정한다. 선택 결과(방법, 점수, 이유)를 라운드에 남기고 화면에서 볼 수 있게 한다. "아무도 답하지 않음"은 사용자가 수신자를 "없음"으로 고를 때와, 선택기가 응답 필요 점수를 낼 때만 쓴다. 지금의 임베딩 선택기는 그 점수를 내지 않으므로 자동 무응답은 생기지 않는다. 임계값을 보정 없이 넣으면 답이 조용히 빠지기 때문이다. 이름·대화 규칙은 바꾸지 않는다.

**D13. 끊긴 스트림은 내용에 따라 다시 보낸다.** 지금은 조각이 하나라도 나온 뒤 끊기면 실행이 실패한다. 나온 것이 생각 조각이나 공백뿐이면 일시적 오류에 한해 다시 보낸다. 본문이나 도구 호출이 나왔으면 지금처럼 다시 보내지 않는다. [LLM 런타임](../specs/llm-runtime.md) 15행을 고친다.

**D14. 질문도 대화 안에서 답한다.** `ask_user` 질문은 지금 실행 탭으로 가야 답할 수 있다. 승인과 같은 자리(§4.3 규칙 2)에서 같은 카드로 답한다.

**D15. 어긋난 것을 정리한다.**
- Studio 컴포저의 `explain` 분기와 그것만 쓰는 클라이언트 호출을 지운다(명세는 이미 쓰지 않는다고 한다).
- [기술 설계](../specs/technical-design.md) 217–236행의 `AgentHandle`을 실제 포트(`requestCompaction`, `pushDirective`, 새 `interrupt`)로 고친다. `requestPause`는 없다.
- 자동 압축도 `context.compaction_changed`를 낸다.
- 압축 진입점 셋을 `/compact`와 활동 바의 컨텍스트 상세 둘로 줄인다.
- 영문 화면의 conversation/session, pane/panel 혼용을 한쪽으로 맞춘다.

**하지 않기로 한 것.** 세션 미뤄 두기(snooze), 재시작 뒤 효과 재실행 분류, 스트림 도중 규칙 개입, 다른 실행 엔진 어댑터, 원격·모바일, 이벤트 로그 정리는 이 계획에 넣지 않는다(§11).

## 3. 결합 구조

```
입력                    실행·감독                          개입·인용                 결과
────                    ─────────                          ─────────                 ────
컴포저 ─ 새 요청 ─────▶ Coordinator ─▶ 어댑터 worker
   │                        │  ▲            │
   │                        │  │ 지시       │ model.finished / tool.finished
   ├─ 합류(next_request) ───┤  │            ▼
   ├─ 끼어들기(interrupt) ──┤  └──── 감독 실행 단위 ── advise ─▶ 문지기 ─▶ 조언(지시)
   ├─ 다음 요청(대기열) ──▶ 서버 대기열 ─ 실행 종료 때 시작      (중복·빈말·예산)
   │                        │
   └─ 인용 칩(reply 첨부) ──┘ 어느 전송에도 실림

이벤트 ─▶ presence(단일 판정) ─▶ 활동 바 · 사이드바 행 · 실행 행 머리 줄
                                 └ 응답 필요 ─▶ 대화 끝의 "지금 필요한 것" = 확인 필요의 같은 카드
보낸 메시지 ─▶ 메타 줄: 합류 대기 → 읽힘 / 끼어듦 / 새 요청으로 시작
```

가져온 것과 Corral에서 붙는 자리:

| 가져온 설계 | Corral에서의 자리 |
|---|---|
| 감독 모델과 조언 문지기 | `observer` 노드, 같은 Run의 실행 단위, `submit_advice` 명령, 기존 지시 전달 경로 |
| 합류·끼어들기, 읽힐 때까지 추적 | `steer`의 두 전달 방식, 지시 전달 상태, 사용자 메시지 메타 줄 |
| 읽히지 못한 메시지 넘겨받기 | 서버 대기열 |
| 단일 상태 함수, 이탈 유예 | `presence.ts`, `useSettledPresence` |
| 컴포저 위 활동 바, 보이는 것은 빼기 | 킷 `AgentStatusPill` 조합, 화면 노출 관찰 |
| 답변 일부 인용 | 텍스트 첨부 `reply`, 기존 캡처 브리지 |
| 점수는 모델·정책은 코드, 무응답 | `selectSpeakers` 정책, 라운드의 선택 기록 |
| 에이전트끼리 한 일의 상한 | 무인 실행 예산, 회의 연쇄 확인 |
| 재시도 안전 판정 | `managedRetryStream`의 조건 |

## 4. 화면 청사진

### 4.1 화면 틀

```
┌───────────────┬───────────────────────────────────────────────────────────────────────┐
│ 사이드바       │ 상단 줄 52   프로젝트 › 세션 제목              대화 · 파일 · 변경 · 실행 │
│               ├───────────────────────────────────────────────────────────────────────┤
│ ＋ 새 대화     │                                                                       │
│ ● 확인 필요 2  │        타임라인 (본문 열 720–760, 가운데)                               │
│ ▣ 라이브러리   │                                                                       │
│ ◷ 자동화       │        사용자 메시지                                                   │
│               │        └ 메타 줄                                                       │
│ 프로젝트 A     │        실행 행: 머리 줄 / 본문 / 꼬리 줄                                │
│  ◔ 세션 1      │                                                                       │
│  ● 세션 2      │        지금 필요한 것 (있을 때만, 언제나 맨 끝)                          │
│  ○ 세션 3      │                                                                       │
│               │   ╭───────────────────────────────────────────────────────────────╮   │
│               │   │ 활동 바                                                        │   │
│               │   │ 칩 줄(인용·첨부, 있을 때만 위로 자람)                            │   │
│               │   │ 입력                                                           │   │
│               │   │ 도구 줄: 대상 · 모델 · 추론 · 팀                 키 안내 · 보내기 │   │
│               │   ╰───────────────────────────────────────────────────────────────╯   │
└───────────────┴───────────────────────────────────────────────────────────────────────┘
```

- 컴포저는 타임라인 위에 뜬 바닥 면이다(킷의 올라온 면). 타임라인의 형제 상자가 아니다.
- 상단 줄에는 실행 상태를 두지 않는다. 경로와 창 전환만 있다.
- 치수는 킷의 크기 토큰이 정한다. 고정하는 것은 "줄 수"다. 활동 바 한 줄, 도구 줄 한 줄, 사용자 메시지 메타 줄 한 줄, 실행 행 머리·꼬리 한 줄씩. V1이 실제 높이를 재어 기준선에 적는다.

### 4.2 킷 조합표

| 자리 | 쓰는 킷 부품 | 없애는 것 |
|---|---|---|
| 활동 바 | `AgentStatusPill`(상태·라벨·`detail`·경과·`steps`·승인 버튼·펼친 곳의 일시정지/재개/중지), `LiveDot`, `AgentStatusLabel` | `DockRunControls`, `ComposerHeader`의 선택 두 개, `ComposerDock`의 행동 `Banner`, `RunStateIcon` |
| 활동 바를 펼친 곳 | pill의 패널 + `AgentStatusLabel` 행(역할별), `Meter`(컨텍스트 %) | Overview의 `AgentsWidget` 중복 표시 |
| 입력 | `InputMessage`, `Textarea` 어댑터 | — |
| 키 안내 | `Kbd` | 전송 방식 `Select` |
| 보내기 | `Button` + `Menu`(합류·끼어들기·다음 요청) | — |
| 대상 표시 | `KitBadge` + `Menu` | 대상 `Select`, 1.5초 폴링 표시 |
| 대기 요청 | `QueuedStack`(지금과 같음) | — |
| 인용·첨부 칩 | 기존 `SourceAttachments` 칩 | — |
| 선택 툴바 | `Popover` + `Button` + `Kbd` | — |
| 사용자 메시지 | `KitChatMessage` + 메타 줄(`AgentStatusLabel` 크기의 한 줄) | `DeliveryStatus` 문단, 상태 문단 |
| 실행 행 머리 줄 | `AgentStatusLabel`, `RollNumber`(경과), `MetaDot` | 종료 `Banner`, 자체 아이콘 매핑 |
| 작업 과정 | `ThinkingSteps`, `ToolCallGroup`/`ToolCallCard`, `Collapse` | 자체 도구 행 |
| 로딩 | `Skeleton`(실제 행과 같은 줄 구성) | 자체 스켈레톤 |
| 응답 카드 | 기존 `ApprovalPanel`·`UserQuestionPrompt`(로직 유지), "계속"류는 킷 `DecisionInbox`(이식) | 실행 행 안의 승인 패널, 질문의 실행 탭 이동 |
| 사이드바 행 | 킷 `Sidebar*`, `StatusDot` | 자체 최신 실행 정렬, `ENDED` 사본 |
| 팀 편집기의 감독 노드 | 기존 노드·`InspectorSheet` 부품 | — |

원본 킷(`/home/bell/Toys/design_kit`)에서 새로 들이는 것은 `components/agent/decision-inbox.tsx` 하나다. 선택 툴바와 겹친 표식은 원본에도 전용 부품이 없어 위 조합으로 만든다.

### 4.3 튐 제로 규칙

1. 컴포저 높이가 변해도 타임라인 항목의 화면 위치는 변하지 않는다. 타임라인은 컴포저 높이만큼 아래 여백을 갖고, 끝을 따라가는 중이면 끝을 유지한다.
2. 사람의 응답이 필요한 카드는 타임라인의 맨 끝 한 자리에만 그린다. 실행 행 중간에 끼워 넣지 않는다.
3. 실행 행은 머리 줄·본문·꼬리 줄로 고정한다. 머리 줄과 꼬리 줄은 실행이 시작될 때부터 자리를 차지한다. 상태가 바뀌면 같은 줄 안에서 글자만 바뀐다. 본문은 아래로만 자란다.
4. 사용자 메시지 아래에는 메타 줄 한 줄이 언제나 있다. 전달 상태, 인용 수, 다시 보내기가 여기 온다.
5. 타임라인 위쪽이나 중간에 새 블록을 끼워 넣지 않는다. 연결 끊김·유실은 활동 바가 말한다.
6. 항목 수에 따라 배치 방식을 바꾸지 않는다.
7. 사이드바 행은 유예 동안 묶음을 옮기지 않고, 행 높이는 상태와 무관하다.

모션은 킷의 `spring`·`tween` 토큰과 `Collapse`만 쓴다. 글자 교체는 pill의 교차 페이드, 높이 변화는 `Collapse`다.

### 4.4 상태별 화면

① 대기

```
   나                                                             14:02
   로그인이 느린 원인을 찾아 줘
   새 요청 · 실행 3

   Corral · 완료 · 2:14
   ▸ 작업 과정   읽음 9 · 검색 3 · 명령 2
   원인은 세션 조회가 요청마다 사용자 수만큼 반복되는 것입니다. …
   변경 3 · 결과 1 · 검사 통과 2

 ╭──────────────────────────────────────────────────────────────────────╮
 │ ✓ 완료 · 계획 5/5 · 변경 3                           컨텍스트 41%  ⌄ │
 │ 다음 요청을 입력…                                                    │
 │ ＋  모델 ▾  추론 ▾  팀 ▾                                 ↵ 보내기  ➤ │
 ╰──────────────────────────────────────────────────────────────────────╯
```

② 여러 역할이 동시에 작업

```
   Corral · 작업 중 · 1:08
   ▾ 작업 과정
     ◔ 리서처   문서 읽는 중
     ◔ 구현자   src/auth/session.ts 고치는 중
     ◌ 검토자   구현자를 기다리는 중
   (대화에 답하는 역할의 본문이 아래로 자람)
   변경 2 · 결과 — · 검사 —

 ╭──────────────────────────────────────────────────────────────────────╮
 │ ◔ 역할 3 작업 중 · 구현자: session.ts 고치는 중 · 1:08    ⌄   ⏸  ■ │
 │ ┌ 펼친 곳 ─────────────────────────────────────────────────────────┐ │
 │ │ ◔ 리서처   문서 읽는 중            0:51      보기   여기에 합류    │ │
 │ │ ◔ 구현자   session.ts 고치는 중    1:08      보기   합류 대상 ✓    │ │
 │ │ ◌ 검토자   구현자를 기다리는 중                보기                 │ │
 │ │ ◇ 감독     지켜보는 중 · 조언 1                보기                 │ │
 │ └──────────────────────────────────────────────────────────────────┘ │
 │ 입력…                                                                │
 │ → 구현자   모델 ▾                    ↵ 합류 · ⌘↵ 끼어들기 · ⌥↵ 다음  ➤ │
 ╰──────────────────────────────────────────────────────────────────────╯
```

활동 바의 닫힌 한 줄은 화면에 이미 보이는 실행 행의 역할을 빼고 말한다. 펼친 곳의 "보기"는 그 역할의 행으로 스크롤하고, "여기에 합류"는 입력 대상을 바꾼다.

③ 실행 중 합류와 끼어들기

```
   Corral · 작업 중 · 0:42
   ▸ 작업 과정   읽음 4
   먼저 세션 저장소를 살펴보겠습니다. …

   나                                                             14:03
   테스트도 같이 돌려 줘
   합류 대기 · 다음 단계에 읽힘            ──▶   읽힘 · 구현자

   나                                                             14:04
   그 파일 말고 session.ts를 봐
   끼어듦 · 응답을 끊고 전달됨 · 구현자

 ╭──────────────────────────────────────────────────────────────────────╮
 │ ◔ 구현자: session.ts 읽는 중 · 0:47                        ⌄   ⏸  ■ │
 │ 입력…                                                                │
 │ → 구현자   모델 ▾                    ↵ 합류 · ⌘↵ 끼어들기 · ⌥↵ 다음  ➤ │
 ╰──────────────────────────────────────────────────────────────────────╯
```

끊긴 응답은 제자리에서 "중단된 출력"으로 남는다. 메타 줄의 글자만 바뀌고 줄 수는 그대로다.

④ 승인·입력 대기

```
   Corral · 응답 대기 · 1:20
   ▸ 작업 과정   읽음 6 · 명령 1
   변경 1 · 결과 — · 검사 —

   ┌ 지금 필요한 것 ────────────────────────────────────────────────────┐
   │ 구현자가 명령을 실행하려 합니다                                     │
   │ pnpm test --filter auth                                            │
   │ ▸ 상세                         거절    이 실행 동안 허용    한 번 허용 │
   └────────────────────────────────────────────────────────────────────┘

 ╭──────────────────────────────────────────────────────────────────────╮
 │ ◔ 리서처: 문서 읽는 중 · 1:20                              ⌄   ⏸  ■ │
 │ 입력…                                                                │
 │ → 구현자 · 결정 뒤에 읽힘                                  ↵ 합류   ➤ │
 ╰──────────────────────────────────────────────────────────────────────╯
```

카드가 화면에 보이면 활동 바는 응답 대기를 다시 말하지 않고 다른 역할의 활동을 보인다. 카드가 화면 밖이면 활동 바가 "응답 대기 · 구현자: 명령 실행"과 승인·거절을 한 줄에 보인다. 질문(`ask_user`)과 "계속" 카드도 같은 자리에 온다. 답하면 카드는 제자리에서 한 줄 결과로 접힌다.

⑤ 답변 일부 인용

```
   Corral · 완료 · 2:14
   원인은 세션 조회가 요청마다 사용자 수만큼 ▛반복되는 것입니다. 캐시를
   두면 줄어듭니다.▟ 다만 무효화 시점을 …
                                   ┌──────────────┐
                                   │ ❝ 인용  Alt Q │
                                   └──────────────┘

 ╭──────────────────────────────────────────────────────────────────────╮
 │ ✓ 완료 · 계획 5/5 · 변경 3                           컨텍스트 41%  ⌄ │
 │ ❝ 반복되는 것입니다. 캐시를 두면 줄어…  ✕                             │
 │ 이 부분, 캐시 대신 조인으로 풀 수 있어?                               │
 │ ＋  모델 ▾  추론 ▾  팀 ▾                                 ↵ 보내기  ➤ │
 ╰──────────────────────────────────────────────────────────────────────╯
```

보낸 메시지에는 같은 칩이 남고, 누르면 원문 위치로 스크롤해 그 구절을 잠깐 강조한다. 칩 줄은 입력 위로 자라므로 입력 줄의 아래 가장자리는 움직이지 않는다.

### 4.5 입력 규칙

| 상황 | 보내기 키 | 끼어들기 키 | `⌥↵` | 도구 줄의 대상 |
|---|---|---|---|---|
| 실행 없음 | 새 요청 | — | — | 없음 |
| 실행 중, 합류할 대상 있음 | 합류 | 끼어들기(어댑터가 지원할 때) | 다음 요청 | → 역할 |
| 실행 중, 대상 없음 | 다음 요청 | — | — | 이유 한 줄 |
| 응답 대기 | 합류(결정 뒤에 읽힘) | — | 다음 요청 | → 역할 · 결정 뒤에 읽힘 |
| 회의 | 회의에 보내기 | — | — | 수신자: 자동 · 지정 · 없음 |

보내기 키는 지금의 설정(`isSendKey`)을 따른다. 보내기 키가 `↵`이면 끼어들기는 `⌘/Ctrl ↵`, 보내기 키가 `⌘/Ctrl ↵`이면 끼어들기는 `⌘/Ctrl ⇧ ↵`다. 인용은 `Alt Q`다(S0에서 단축키 등록부와 대조하고 겹치면 그때 바꿔 명세에 적는다). `/next`, `/steer`는 남기고 `/interrupt`를 더한다.

메타 줄의 문구(지시 전달 상태에서 파생, 상태 집합은 그대로):

| 전달 상태와 조건 | 메타 줄 |
|---|---|
| `accepted`·`queued` | 합류 대기 · 다음 단계에 읽힘 |
| `queued`이고 대상이 승인·질문 대기 | 결정 뒤에 읽힘 |
| `attached_to_request` | 전달하는 중 |
| `delivered`(합류) | 읽힘 · 역할 |
| `delivered`(끼어들기) | 끼어듦 · 응답을 끊고 전달됨 · 역할 |
| `expired`, 넘겨받아 Run 종료를 기다림 | 먼저 끝나 다음 요청으로 대기 |
| `expired`, 넘겨받아 시작됨 | 먼저 끝나 새 요청으로 시작 |
| `not_delivered`, 또는 `expired`인데 넘겨받지 않음 | 전달되지 않음 · 다시 보내기 |
| `delivery_unknown` | 전달 여부를 확인하지 못함 |

## 5. 명세 변경안

S0에서 오케스트레이터가 직접 쓴다. 판단이 드는 일이라 빌더에게 넘기지 않는다.

새 기능 명세([틀](../specs/features/_template.md)):

| 파일 | 담는 것 |
|---|---|
| `features/composer-flow.md` | D1–D4, D7, D8, D14, §4.3 규칙, §4.5 표, 활동 바의 우선순위와 "보이는 것은 뺀다" |
| `features/presence.md` | D5, D6, 판정 우선순위 표, 문구 네임스페이스 |
| `features/reply-citation.md` | D9, 위치 복원 규칙, 길이 상한 |
| `features/advisor.md` | D10, 검토 입력, 문지기 규칙, 전달 채널 표, 예산, 표시 |

고치는 문장:

| 파일 | 위치 | 바꾸는 내용 |
|---|---|---|
| `workbench.md` | 154, 156 | 기본 입력·전송 방식 선택·중지 위치를 `composer-flow.md`로 옮기고 링크 |
| `workbench.md` | 220 | 텍스트 첨부를 합류·끼어들기에도 싣는다 |
| `workbench.md` | 17 | 회의 수신자 "없음" |
| `workbench.md` | 345–361 | 묶음 판정은 `presence.md`를 따른다. 유예 규칙 링크 |
| `chat-widgets-contract.md` | 11, 20, 27, 29, 39, 230 | 한 줄 상태를 활동 바로, 상단 줄 배치에서 실행 조작 제거, 표시 우선순위를 `presence.md`로 |
| `features/reins.md` | §2, §7 | 전달 방식 `interrupt`, 넘겨받기, 조언이 지시로 들어오는 경우의 행위자 |
| `features/inbox.md` | 묶음 표 | 검토 묶음에 `advice`. 계속 여부 승인은 기존 `decision` 항목이다 |
| `product-contract.md` | 283, 289–299, §7.2 | D11의 두 장치, 한도 표에 무인 실행 예산, 능력 연결에 `advise` |
| `harness-contract.md` | 47 | "모델 호출 상한은 없다"를 D11로 |
| `features/local-intelligence.md` | 63–75 | 점수와 정책의 분리, 선택 기록, 무응답 조건, 연쇄 확인 |
| `llm-runtime.md` | 15 | D13 |
| `technical-design.md` | 217–236 | 실제 `AgentHandle` |
| `features/team-graph.md` | 노드·연결 절 | `observer`, `advise`, 컴파일 규칙 |
| `features/execution-monitor.md` | 관계·판단 기록 | 조언 접수·억제·전달 기록 |
| `api-contract.md` | 명령·이벤트 절 | `steer.delivery`, `steer.attachments`, `submit_advice`, `advice.*`, 세션 `autoStart` |
| `glossary.md` | 표, 남은 불일치 | 합류, 끼어들기, 감독, 활동 바, 인용 추가. 닫힌 불일치 삭제 |

[헌장](../specs/constitution.md)의 동결 상태 집합은 건드리지 않는다. 감독 실행 단위는 `waiting_message`로 쉬고, 예산 확인은 `waiting_approval`을 쓴다.

## 6. 실행 파이프라인

**오케스트레이터(메인 세션).** Fable 5.2, 추론 노력 xhigh로 돈다. 세션을 이어받았을 때 모델이나 추론 노력이 이와 다르면 태스크를 내기 전에 맞춘다. 목표를 §7의 태스크로 나눠 순서대로 낸다. 명세(S0), 병합, 진행 표, 리뷰 결과에 따른 수정 지시, 디자인 검수가 메인 세션의 일이다. 구현을 직접 하지 않는다.

**빌더.** 태스크 하나에 빌더 하나, 전용 작업 사본(worktree)에서 일한다. 모델은 Opus 5.5이고 추론 노력은 medium이 기본이자 하한이다. Opus를 low로 낮추지 않는다. low면 충분할 만큼 단순한 태스크는 Sonnet 5.5 high에 맡긴다(배정은 §7). 브리프가 탐색을 대신하므로 노력을 더 올리는 것은 예외다. 같은 태스크가 `revise`를 두 번 받으면 한 단계 올려 다시 낸다(Sonnet 5.5 high → Opus 5.5 medium → Opus 5.5 high). `develop`에서 가른 통합 브랜치 `feat/unified-flow`에서 `flow/<id>-<이름>`으로 갈라 일한다. §8의 브리프가 그 태스크의 전부이며, 브리프 밖의 파일을 고쳐야 하면 멈추고 보고한다. 순서는 명세 확인, 실패하는 테스트, 구현, 검사 명령이다.

**리뷰어.** Fable 5.2, 태스크마다 새로 띄운다. 빌더의 요약을 읽지 않는다. `git diff feat/unified-flow...flow/<id>` 전체를 읽고, 브리프의 완료 체크 명령과 해당 장면(§9)의 측정을 다시 돌려 판정한다. 리뷰어가 보는 것은 코드, 테스트, 장면의 수치다. 디자인 판정은 하지 않는다. 판정 형식:

```
verdict: pass | revise
commands: [{ cmd, exit, 요약 }]
diff_findings: [{ file:line, 문제, 근거 }]
visual: [{ scene, maxShiftPx, labelCount, screenshots[] }]
unverified: [ … ]
```

`revise`면 메인 세션이 `diff_findings`를 같은 빌더 브랜치에 수정 지시로 보낸다. `pass`이고 화면을 바꾸지 않는 태스크면 통합 브랜치에 로컬 병합한다. 화면을 바꾸는 태스크(K1, U1–U14, M3, M4, A7–A9)는 디자인 검수까지 통과해야 병합한다.

**디자인 검수.** 메인 세션이 직접 하고 서브에이전트에 넘기지 않는다. 리뷰어가 `pass`를 낸 화면 태스크마다 메인 세션이 그 브랜치의 화면을 실제 브라우저에서 열어 눈으로 확인한다. 절차와 기준은 §9다. 지적은 메인 세션이 화면 근거(장면, 위치, 캡처)와 함께 수정 지시로 써서 같은 빌더 브랜치에 보내고, 고친 뒤 다시 본다.

**서브에이전트.** 비용이므로 서로 기대지 않는 일에만 쓴다. 동시에 도는 빌더는 최대 4개, 레인마다 1개다. 레인이 달라도 대상 파일이 겹치는 두 태스크는 동시에 내지 않는다. 여러 태스크가 건드리는 파일(`messages/{en,ko}.json`, 계약 생성물)의 충돌은 오케스트레이터가 병합할 때 풀고, 계약 생성물은 병합 뒤 `pnpm contracts:generate`로 다시 만든다. 조사용 에이전트는 경계가 분명한 질문과 표 형식 출력으로만 쓴다.

**오류 복구.** 빌드·타입·테스트·렌더링 오류는 멈출 이유가 아니다. 빌더와 리뷰어는 원인을 읽고 고쳐 완료 체크가 통과할 때까지 이어 간다. 같은 오류로 세 번 실패하면 시도한 것과 로그를 붙여 오케스트레이터에 넘기고, 오케스트레이터가 브리프를 고치거나 태스크를 나눈다.

**공통 규칙(모든 브리프에 적용).**
- 검사: `pnpm lint`, `pnpm typecheck`, 브리프의 테스트. 계약을 바꿨으면 `pnpm contracts:check`.
- 킷 파일(`packages/react/src/design-kit/`)은 브리프가 말할 때만 고치고, 고치면 그 README의 적응 기록과 지문을 갱신한다.
- 라이브러리를 더하지 않는다. 필요하면 멈추고 보고한다.
- 화면 문구는 `packages/react/src/messages/{en,ko}.json`에 두고 [용어집](../specs/glossary.md)을 따른다. 설명 문구를 덧붙이지 않는다.
- 유료 모델·검색 호출을 하지 않는다. 테스트는 스크립트 어댑터와 가짜 응답만 쓴다.
- Task 완료·사용량은 Coordinator 명령 경로로만 확정한다. 취소·패치는 시도·범위·revision을 확인한다.
- 지우기로 한 형식은 옮기지 않고 지운다(개발 중에는 마이그레이션을 두지 않는다).
- 화면 태스크는 `apps/server/resources/builtin/design/skills/`의 `review-components`, `review-motion`, `check-accessibility`와 [DESIGN.md](../../DESIGN.md)의 킷 우선 규칙을 따른다.
- 마지막 보고: 바꾼 파일, 실행한 명령과 결과, 통과하지 못한 체크.
- 브리프를 읽은 뒤 §8 끝의 "명세가 정한 차이"에서 자기 태스크 줄을 확인한다. 그 줄과 명세가 브리프보다 우선한다.

**빌더 작업 환경.**
- 작업 사본은 빌더 전용 git worktree다. 원본 체크아웃(`/home/bell/Toys/corral`)과 다른 worktree·브랜치는 건드리지 않는다.
- 시작: `git checkout -b flow/<id>-<이름> feat/unified-flow`, 이어서 `pnpm install --frozen-lockfile --offline`. `e2e/flow`를 돌리거나 화면을 브라우저로 확인하는 태스크는 `pnpm --filter @corral/studio build`도 한다(E2E 하네스가 `apps/studio/dist`를 정적으로 제공한다).
- 셸: `ls`는 별칭이라 경로 인자를 주면 실패한다. `command ls`나 `find`를 쓴다. zsh이므로 글롭은 따옴표로 감싼다.
- 명세(`docs/specs`)와 이 플랜은 고치지 않는다. 명세와 브리프가 다르면 명세를 따르고 차이를 보고한다.
- 커밋: 바꾼 파일만 경로를 적어 add 한다(`git add -A` 금지). 메시지는 영어 한 줄(Conventional Commits). 서명·attribution 줄을 넣지 않는다. push와 PR은 하지 않는다.
- localhost 밖으로 나가는 네트워크 호출을 하지 않는다.
- 보고 형식(마지막 메시지는 이것만):

```
branch: flow/<id>-<이름>
worktree: <절대 경로>
commits: <해시와 제목>
files_changed: <경로 목록>
commands: <실행한 명령 · 종료 코드 · 한 줄 요약>
checks_not_passed: <없으면 none>
notes: <브리프와 다르게 한 것, 발견한 문제. 없으면 none>
```

## 7. 태스크 분해표

레인은 같은 파일을 고치는 일을 한 줄로 세운 것이다. 레인 안은 순서대로, 레인끼리는 동시에 돈다.

- 레인 K(계약·Coordinator·worker): B7 → B3 → B6 → B5 → B9 → A1 → A2 → A5 → A9
- 레인 P(재시도·대기열·회의·순수 코어): B8 → B4 → B10 → M1 → M2 → B2 → A3 → A4 → A6
- 레인 U(대화 화면): V1 → K1 → U1 → U2 → U3 → U4 → U5 → U6 → U7 → U9 → U11 → M3 → M4 → A8 → U13 → V2
- 레인 L(목록·주변 화면): B1 → U8 → U10 → U12 → A7 → U14

빌더 배정:

- Sonnet 5.5 high: K1(이식), B8(조건 하나), U12, U13(삭제), U14(문구). 대상이 파일 한두 개이고 판단할 것이 브리프에 다 적힌 태스크다.
- Opus 5.5 medium: 그 밖의 빌더 태스크 전부(34개).
- S0은 오케스트레이터가 직접 한다.

| ID | 이름 | 선행 | 주 대상 | 상태 |
|---|---|---|---|---|
| S0 | 명세 변경 | — | `docs/specs` | 완료 |
| V1 | 장면 하네스와 이동 측정기(기준선) | — | `apps/studio/e2e/flow` | 보강 중 |
| B1 | 단일 상태 판정 모듈 | S0 | `packages/react/src/run/presence.ts` | 완료 |
| B2 | 검증 안 된 경로의 반례 테스트 | B6 | `packages/core/test`, `packages/adapter-pi/test` | 대기 |
| B3 | 지시에 텍스트 첨부 싣기 | S0 | `contracts/commands.ts`, `coordinator.ts`, `adapter-pi` | 리뷰 중 |
| B4 | 서버 대기열 시작 | S0 | `core/repository`, `apps/server/src/app.ts` | 재검토 중 |
| B5 | 읽히지 못한 합류 넘겨받기 | B4, B6 | `coordinator.ts`, `core/repository` | 대기 |
| B6 | 끼어들기 전달 | B3, B7 | `contracts`, `coordinator.ts`, `adapter-pi` | 대기 |
| B7 | 자동 압축의 이벤트 | S0 | `adapter-pi/worker.ts`, `sdk-worker.ts` | 완료 |
| B8 | 재시도 안전 판정 | S0 | `adapter-pi/request-retry.ts` | 완료 |
| B9 | 무인 실행 예산 | B5 | `contracts/definition.ts`, `core/admission`, `coordinator.ts` | 대기 |
| B10 | 응답 중간 끊김의 재시도 분류 | B8 | `adapter-pi/ported/dsh/retry.ts`, `model-bridge.ts`, `apps/server/src/models/registry.ts` | 수정 중 |
| K1 | 킷 `DecisionInbox` 이식 | S0 | `packages/react/src/design-kit` | 완료 |
| U1 | 컴포저 분해(동작 유지) | S0 | `workbench/session/Composer.tsx` | 완료 |
| U2 | 타임라인 틀과 끝 추적 | V1 | `workbench/ChatView.tsx` | 구현 중 |
| U3 | 실행 행 고정 구조 | U2 | `workbench/RunMessage.tsx`, `TurnProcess.tsx` | 대기 |
| U4 | "지금 필요한 것" 자리, 질문 인라인 | U3, K1 | `ChatView.tsx`, `WorkTab.tsx`, `RunResponseArea.tsx` | 대기 |
| U5 | 전송 모델 | U1, B3, B6 | `composerIntent.ts`, 컴포저 전송 모듈 | 대기 |
| U6 | 사용자 메시지 메타 줄 | U5, B5 | `session/SessionEntries.tsx` | 대기 |
| U7 | 활동 바 | B1, U5 | `packages/react/src/components/ActivityBar.tsx`, 배선 | 대기 |
| U8 | 상태 적용 A: 사이드바·목록·유예 | B1 | `Sidebar.tsx`, `sessionList.ts`, `RunList.tsx`, `Breadcrumbs.tsx` | 보완 중 |
| U9 | 상태 적용 B: 대화·위젯 | B1, U7 | `widgets/*`, `agentSummary.ts`, `StatusBadge.tsx`, `agentStatus.ts` | 대기 |
| U10 | 인용 A: 계약·브리지·칩 | B3 | `contracts/attachments.ts`, `workbench/context/*` | 대기 |
| U11 | 인용 B: 선택 툴바·원문 복귀 | U10, U3 | `RunMessage.tsx`, 새 `ReplySelection.tsx` | 대기 |
| U12 | 확인 필요: 같은 응답 영역, 계속 여부 카드 | U4 | `pages/InboxPage.tsx` | 대기 |
| U13 | 중복·사문 제거 | U7 | `Composer`, `RunStatusCards.tsx`, 클라이언트 | 대기 |
| U14 | 영문 문구 정리 | U9 | `messages/en.json` | 대기 |
| M1 | 회의 점수·정책 분리, 선택 기록, 무응답 | S0 | `core/meeting.ts`, `local-intelligence/.../selector.ts`, `contracts/meeting.ts` | 리뷰 중 |
| M2 | 회의 연쇄 확인 | M1 | `core/meeting.ts` | 대기 |
| M3 | 회의 화면을 공용 타임라인·컴포저로 | U5, M1 | `pages/MeetingPage.tsx` | 대기 |
| M4 | 회의 선택 기록 표시, 계속 카드 | M2, M3, K1 | `pages/MeetingPage.tsx` | 대기 |
| A1 | 감독 계약 | B9 | `contracts/definition.ts`, `commands.ts`, `events.ts` | 대기 |
| A2 | 감독 컴파일 규칙 | A1 | `core/compiler` | 대기 |
| A3 | 조언 문지기와 전달 채널(순수) | A1 | `core/src/advisor/guard.ts`, `channel.ts` | 대기 |
| A4 | 검토 입력 작성기 | A1 | `core/src/advisor/delta.ts` | 대기 |
| A5 | 감독 실행 단위와 조언 처리 | A2, A3, A4 | `coordinator.ts`, `apps/server/src/app.ts` | 대기 |
| A6 | `advise` 도구와 검토 요청 전달 | A5 | `adapter-pi/worker-tools.ts`, `worker.ts` | 대기 |
| A7 | 팀 편집기의 감독 노드 | A2 | `packages/react/src/team-editor` | 대기 |
| A8 | 조언 표시 | A6, U7, U6 | `RunMessage.tsx`, `ActivityBar`, 확인 필요 | 대기 |
| A9 | 대화의 감독 설정 | A5 | 세션 설정, 대화 정의 생성부 | 대기 |
| V2 | 최종 장면 | 전부 | `apps/studio/e2e/flow` | 대기 |

백본 신뢰 게이트: B2가 통과하기 전에는 U5·U6·A5를 병합하지 않는다. 지금 테스트가 하나도 없는 경로(실행이 돌지 않을 때 버려지는 지시, 승인·질문 대기 중의 지시, 대기열 자동 시작, 관찰자 연결, 조각이 나온 뒤 끊긴 스트림) 위에 화면을 얹지 않기 위해서다.

## 8. 빌더 브리프

경로 약어: `S/` = `apps/studio/src/`, `W/` = `apps/studio/src/workbench/`, `R/` = `packages/react/src/`, `K/` = `packages/react/src/design-kit/`, `C/` = `packages/core/src/`, `T/` = `packages/contracts/src/`, `P/` = `packages/adapter-pi/src/`.

### V1 장면 하네스와 이동 측정기
- 명세: 이 문서 §9.
- 대상: 새 `apps/studio/playwright.flow.config.ts`(testDir `./e2e/flow`, workers 1, retries 0, 1280×800), 새 `apps/studio/e2e/flow/probe.ts`, 새 `apps/studio/e2e/flow/baseline.spec.ts`. 기존 `apps/studio/e2e/server/harness.ts`의 `test`를 그대로 가져다 쓴다(빌드 산출물이 필요하다, 같은 파일 15·67–69행).
- 구현: `probe.ts`는 페이지에 스크립트를 넣어 `[data-chat-item]`과 사이드바 세션 행의 위치를 프레임마다 기록한다. 기록 값은 스크롤 컨테이너 기준 위치(`rect.top - 컨테이너.top + scrollTop`)와 화면 기준 위치 둘 다다. `start(name)`/`stop()`이 구간 안에서 기존 항목별 최대 이동(px)을 돌려준다. `baseline.spec.ts`는 지금 화면에서 실행 시작, 스트리밍, 승인 대기 진입, 실행 종료 네 전이의 이동량과 고정 영역 높이를 재어 `test-results/flow/baseline.json`에 쓴다. 승인·질문 상태는 `e2e/server/run-page.spec.ts` 533행과 `m1-interactions.spec.ts` 42행의 방법을, 응답을 붙잡아 두는 것은 `contextual-settings.spec.ts` 180–195행의 방법을 따른다.
- 하지 말 것: `toHaveScreenshot` 기준 이미지 커밋, 앱 코드 수정(`data-` 속성이 없으면 있는 선택자로 잰다).
- 완료 체크: `pnpm --filter @corral/studio exec playwright test --config playwright.flow.config.ts` 통과, `baseline.json`에 네 전이의 수치가 있음, `pnpm lint`·`pnpm typecheck`.

### B1 단일 상태 판정 모듈
- 명세: `features/presence.md`.
- 대상: 새 `R/run/presence.ts`, 새 `packages/react/test/presence.test.ts`, `R/messages/{en,ko}.json`에 `Presence` 네임스페이스.
- 구현: React에 기대지 않는 순수 함수 셋. `executionPresence(execution)`, `runPresence(run, executions, pending)`, `sessionPresence(latestRun, terminalAttention)`. 반환은 `{ kind, need?, tone, labelKey }`. `kind`의 우선순위는 `awaiting_user` > `failed`·`interrupted` > `stopping`(cancelling) > `pausing` > `paused` > `starting` > `working`(세부 `waiting_agents`) > `succeeded` > `cancelled` > `ready` > `empty`. `need`는 `approval`·`question`·`continue`. 입력 타입은 `T/states.ts`의 상태 enum을 쓴다. 유예는 같은 파일의 `settle(prev, next, now)`로 둔다(벗어나는 쪽이 `starting`·`working`이고 새 값이 `awaiting_user`·`failed`·`interrupted`가 아니면 2,000ms 동안 이전 값, 끝난 지 60,000ms가 넘었으면 유예 없음). `now`는 인자로 받는다.
- 하지 말 것: 호출부 교체(U8·U9의 일), 새 상태 값.
- 완료 체크: `pnpm vitest run packages/react/test/presence.test.ts`가 헌장 §3의 Run·Execution 상태 전부에 대한 표 테스트, 우선순위 충돌(응답 대기와 실패가 함께), 유예 세 경우를 통과.

### B2 검증 안 된 경로의 반례 테스트
- 명세: `features/reins.md` §2, `features/composer-flow.md`.
- 대상(테스트만): `packages/core/test/reins-delivery-gaps.test.ts`(새), `packages/adapter-pi/test/directive-gaps.test.ts`(새).
- 구현: (1) worker가 `running`이 아닐 때 보낸 지시가 worker 시작 때 `pendingDirectives`로 읽혀 전달되는지(`P/adapter.ts` 189–192행, `C/coordinator.ts` 8079–8085행). (2) 대상이 승인 대기·질문 대기일 때 보낸 지시가 `queued`로 남고 결정 뒤 첫 요청에 실리는지. (3) 대상이 지시를 읽기 전에 스스로 끝나면 `expired`, 취소로 끝나면 `not_delivered`인지. (4) 조각이 나온 뒤 스트림이 끊기면 실행이 `failed`이고 부분 출력이 남는지. (5) 끼어들기 뒤의 사용량이 0으로 기록되지 않는지.
- 하지 말 것: 구현 수정. 실패하는 테스트는 `it.fails`로 두지 말고 그대로 두고 실패 내용을 보고한다(오케스트레이터가 수정 태스크를 낸다).
- 완료 체크: 두 파일이 실행되고, 통과·실패 목록이 보고에 있음.

### B3 지시에 텍스트 첨부 싣기
- 명세: `workbench.md` 220행 수정분, `api-contract.md`.
- 대상: `T/commands.ts`(`SteerCommand` 30–38행), `T/attachments.ts`, `C/coordinator.ts`의 `steer`(3259–3335행)와 `prepareModelRequest`의 지시 부착부(8301–8616행), `P/adapter.ts`(189–192행), `P/worker.ts`(132–135, 260–271, 458–471행), `P/sdk-worker.ts`(123–129행).
- 구현: `payload.attachments`(텍스트 첨부 배열, 선택)를 더한다. 새 요청의 텍스트 첨부와 같은 스키마·상한을 쓴다. 지시가 모델 요청에 실릴 때 첨부를 본문 앞의 출처 표시 블록으로 붙인다(새 요청이 첨부를 싣는 표현과 같게). 이미지 첨부는 스키마에서 거절한다. `payloadHash`에 첨부가 들어가 같은 commandId·다른 첨부는 충돌이 된다.
- 완료 체크: `packages/core/test/coordinator.test.ts`에 첨부가 실린 지시의 전달과 해시 충돌 테스트 추가 후 통과, `packages/adapter-pi/test/pi-adapter.test.ts`에 첨부가 요청 본문에 들어가는 테스트 통과, `pnpm contracts:check`.

### B4 서버 대기열 시작
- 명세: `features/composer-flow.md`(D4).
- 대상: `C/repository/index.ts`(세션 항목 392–615행), `packages/storage-sqlite`의 `work_sessions`, `apps/server/src/app.ts`, `packages/client/src`(세션 설정 API).
- 구현: 세션에 `autoStart: boolean`(기본 true, 지금 클라이언트 기본값은 false다)을 저장한다. 서버가 그 세션의 Run이 종료 상태가 되는 것을 보고(`C/meeting.ts` 899–946행의 `watch`가 Run 종료를 따라가는 방식과 같게) `queued` 항목이 있으면 맨 앞 것을 그 항목의 commandId로 시작한다. 시작 조건은 `autoStart`이거나 그 항목에 `carriedFrom`이 있는 것이다(`carriedFrom` 필드는 이 태스크가 항목 스키마에 더하고, 값은 B5가 채운다). 시작 경로는 지금 클라이언트가 부르는 것과 같은 서버 진입점이다. 서버 재시작 뒤에는 이미 종료된 Run 뒤의 `queued` 항목을 자동으로 시작하지 않는다(불확실한 것은 사람이 시작).
- 하지 말 것: `W/session/Composer.tsx` 수정(클라이언트 자동 시작 제거는 U5).
- 완료 체크: `apps/server/test/`에 새 테스트: 실행 종료 뒤 다음 항목이 한 번만 시작됨, 같은 commandId로 클라이언트가 다시 불러도 두 번 시작되지 않음, `autoStart=false`면 시작 안 함, 재시작 뒤 자동 시작 안 함.

### B5 읽히지 못한 합류 넘겨받기
- 명세: `features/reins.md` 수정분(D3).
- 대상: `C/coordinator.ts`의 `settle`(5269–5389행), `C/repository/index.ts`, `T/events.ts`.
- 구현: 대상 실행이 `succeeded`로 끝나 지시가 `expired`가 될 때, 그 지시의 세션 항목을 대기열 맨 앞의 `queued` 새 요청으로 바꾸고(본문·첨부 유지) 항목의 `carriedFrom`에 원래 지시 id를 적는다. 시작은 B4의 대기열이 Run 종료 때 한다. 대상이 `failed`로 끝난 `expired`, 취소(`not_delivered`), `delivery_unknown`은 넘기지 않는다. 감독의 조언에서 온 지시는 넘기지 않는다.
- 완료 체크: `packages/core/test/`에 네 경우(성공으로 끝남 → 맨 앞으로 넘김, 실패 → 안 넘김, 취소 → 안 넘김, 조언 → 안 넘김)와 같은 지시가 두 번 넘어가지 않는 테스트. `apps/server/test/`에 `autoStart=false`여도 넘겨받은 항목은 Run 종료 때 시작되는 테스트.

### B6 끼어들기 전달
- 명세: `features/reins.md` 수정분(D2), `technical-design.md`의 `AgentHandle`.
- 대상: `T/commands.ts`, `T/ports.ts`(`AgentHandle` 245–250행), `C/coordinator.ts`의 `steer`, `P/adapter.ts`, `P/worker.ts`(117–135, 660–668행), `P/sdk-worker.ts`.
- 구현: `delivery`에 `interrupt`. `AgentHandle.interrupt?(directive)`를 더하고 없는 어댑터에서는 Coordinator가 `next_request`로 낮추며 receipt에 그 사실을 적는다. pi-core worker는 `interrupt` 프레임을 받으면 표시를 세우고 진행 중인 모델 스트림만 끊는다. 스트림이 `aborted`로 끝났고 표시가 있으면 실행을 정산하지 않고 지시를 사용자 메시지로 붙여 같은 에이전트로 이어 간다. 도구가 실행 중이면 끊지 않고 그 도구 결과 뒤 첫 요청에 붙인다. pi-sdk worker는 세션의 중단 뒤 지시로 다시 시작한다. 끊긴 호출은 `model.finished`에 `interrupted: true`로 기록하고 사용량은 보고된 값, 없으면 미확인이다. 부분 출력은 지금의 저장 경로를 그대로 탄다.
- 하지 말 것: 실행 취소 경로(`settle('cancelled')`)의 의미 변경, 도구 효과 중단.
- 완료 체크: `packages/adapter-pi/test/`에 스트림 중 끼어들기(끊기고 다음 요청에 지시가 있음, 실행은 계속), 도구 중 끼어들기(도구가 끝난 뒤 전달), 미지원 어댑터의 낮춤. `packages/core/test/reins.test.ts`에 receipt·전달 상태. `pnpm contracts:check`.

### B7 자동 압축의 이벤트
- 대상: `P/worker.ts`(281–403행), `P/sdk-worker.ts`(1177–1242행), `C/coordinator.ts`(8247–8296행).
- 구현: 자동 압축도 수동 압축과 같은 `compaction_report`를 보내 `context.compaction_changed`가 나오게 한다. 수동 압축의 commandId 자리는 자동임을 뜻하는 값으로 채운다.
- 완료 체크: `packages/core/test/compaction.test.ts`와 `packages/adapter-pi/test/pi-adapter.test.ts`에 자동 압축 뒤 이벤트가 한 번 나오는 테스트.

### B8 재시도 안전 판정
- 명세: `llm-runtime.md` 15행 수정분(D13).
- 대상: `P/request-retry.ts`, `packages/adapter-pi/test/request-retry.test.ts`.
- 구현: "조각이 하나도 없을 때만 재시도"를 "다시 보내면 안 되는 조각이 없을 때만 재시도"로 바꾼다. 다시 보내면 안 되는 조각은 공백이 아닌 본문 텍스트, 도구 호출, 이미지다. 생각 조각과 공백은 괜찮다. 횟수·대기·오류 종류는 그대로다.
- 완료 체크: 생각만 나온 뒤 끊김 → 재시도, 본문 뒤 끊김 → 재시도 안 함, 도구 호출 뒤 끊김 → 재시도 안 함.

### B9 무인 실행 예산
- 명세: `product-contract.md` §9 수정분(D11).
- 대상: `T/definition.ts`(`RunLimits` 265–281행), `C/limits.ts`, `C/admission/index.ts`(241–253행의 무진전 게이트가 본보기), `C/coordinator.ts`의 `prepareModelRequest`, `T/commands.ts`의 `run_limits` 패치.
- 구현: `RunLimits.requestBudget`(역할 400·자식 200·감독 60을 기본으로 주는 구조, 패치 50–2000 또는 0). 실행 단위별 모델 요청 수를 세고, 대화에 직접 답하는 실행은 세지 않는다. 예산에서 마무리 지시, 1.5배에서 제출 지시(둘 다 시스템이 낸 지시로 기록), 그 뒤 5회째 요청에서 게이트가 `require_approval`을 돌려 `limit.reached(kind: request_budget)`와 공유 승인을 만든다. 승인이면 예산을 한 번 더 주고, 거절이면 무진전 거절과 같은 경로로 멈춘다.
- 완료 체크: `packages/core/test/`에 세 단계 각각, 대화 실행 제외, 패치로 끄기, 승인 뒤 계속. `pnpm contracts:check`.

### B10 응답 중간 끊김의 재시도 분류
- 명세: `llm-runtime.md` 15행(D13). B8 리뷰에서 나온 태스크다. 지금 분류로는 200 응답 뒤 중간에 끊긴 스트림이 대부분 `UNKNOWN`이 되어 B8의 판정이 실제로는 쓰이지 않는다.
- 대상: `P/ported/dsh/retry.ts`(`providerFailure`), `P/model-bridge.ts`(184행 근처의 오류 분류), `apps/server/src/models/registry.ts`(오류를 분류해 worker에 넘기는 곳), `P/request-retry.ts`, 각 테스트.
- 구현: 응답 이벤트가 하나라도 온 뒤 연결이 끊겨 끝난 스트림(`terminated`, `premature close`, `ECONNRESET`, `socket hang up`, `other side closed`)과 응답 중에 온 공급자 과부하 알림(`overloaded`, 529)을 일시적 오류로 분류한다. 응답 이벤트 없이 끊긴 연결은 지금처럼 `UNKNOWN`이다(전달 여부를 모르는 요청). 사용자 취소는 지금처럼 `CANCELLED`다. 분류는 원문을 볼 수 있는 쪽에서 하고 원문은 지금처럼 남기지 않는다. 재시도 여부는 B8의 판정을 그대로 탄다.
- 하지 말 것: 재시도 횟수·대기 변경, 응답 시작 전 끊김의 재시도. 실패 코드 enum을 늘려 계약(`packages/contracts`)을 바꿔야 하면 멈추고 보고.
- 완료 체크: 생각만 나온 뒤 `terminated` → 재시도, 본문 뒤 `terminated` → 재시도 안 함(끊긴 출력으로 남음), 응답 이벤트 없이 `terminated` → 재시도 안 함, 취소 → 재시도 안 함, 응답 중 과부하 알림 → 재시도. worker 경로(host가 분류해 넘긴 값)와 host 직접 경로 둘 다.

### K1 킷 `DecisionInbox` 이식
- 대상: `/home/bell/Toys/design_kit/components/agent/decision-inbox.tsx`를 `K/components/agent/decision-inbox.tsx`로, `K/index.ts` export, `K/README.md`의 적응 기록과 지문, 스토리 `R/components/DecisionInbox.stories.tsx`.
- 구현: 원본을 그대로 들이고 import 경로와 문구 주입만 Corral 방식에 맞춘다.
- 완료 체크: `pnpm typecheck`, 스토리가 렌더됨(Storybook 브라우저 테스트 구성으로 실행), README 지문 갱신.

### U1 컴포저 분해
- 대상: `W/session/Composer.tsx`(2,127행)를 `W/session/composer/` 아래로 나눈다: `send.ts`(848–968행의 전송 경로), `queue.ts`(1100–1173행), `commands.ts`(1381–1457행), `dialogs.tsx`, 남는 `Composer.tsx`는 조립만.
- 구현: 동작을 바꾸지 않는다. 전송 경로는 훅이 아닌 함수로 뽑아 단위 테스트가 되게 한다.
- 완료 체크: 기존 테스트 전부 통과(`W/session/*.test.tsx`, `S/pages/SessionPage.context.test.tsx`, `W/composerIntent.test.ts`), 새 `composer/send.test.ts`가 새 요청·대기열·지시 세 경로의 호출 인자를 고정, `Composer.tsx` 600행 이하.

### U2 타임라인 틀과 끝 추적
- 명세: `features/composer-flow.md` 규칙 1·5·6.
- 대상: `W/ChatView.tsx`(347–509행), `W/ChatView.test.tsx`, `S/pages/SessionPage.tsx`(229–239행의 유실 알림).
- 킷: 올라온 면(`Elevated`), `ScrollArea`.
- 구현: 컴포저 컨테이너를 타임라인의 형제에서 타임라인 위 바닥 고정 면으로 옮긴다. `ResizeObserver`로 컴포저 높이를 `--composer-h`에 넣고 타임라인의 아래 여백으로 쓴다. 끝을 따라가는 중이면 높이 변화 뒤에도 끝에 붙인다. 항목 40개 기준의 배치 전환을 없애고 한 방식만 쓴다. 대화 위의 유실 알림을 지우고 그 사실을 context로 내려 U7이 활동 바에서 쓰게 한다. `data-chat-item`을 모든 행에 단다.
- 완료 체크: `ChatView.test.tsx`에 컴포저 높이가 바뀌어도 추적 상태가 유지되는 테스트, V1 측정기로 "컴포저 높이 변화" 전이의 이동 1px 이하.

### U3 실행 행 고정 구조
- 명세: `features/composer-flow.md` 규칙 3, `chat-widgets-contract.md`.
- 대상: `W/RunMessage.tsx`(852행), `W/TurnProcess.tsx`, `W/RunMessage.*.test.tsx`.
- 킷: `AgentStatusLabel`, `RollNumber`, `MetaDot`, `ThinkingSteps`, `ToolCallGroup`, `Collapse`, `Skeleton`, `ThinkingIndicator`.
- 구현: 행을 머리 줄(역할 · 상태 · 경과), 본문, 꼬리 줄(변경 · 결과 · 검사)로 나눈다. 머리·꼬리 줄은 실행이 생길 때부터 한 줄 높이를 차지하고 값이 없으면 줄표를 보인다. 종료 배너(426–464행)를 머리 줄의 상태 글자로, 도구 주의 목록·이유·팀 활동(465–538행)을 작업 과정 안으로 옮긴다. 스켈레톤은 세 줄 구조와 같게 한다. 생각 표시와 첫 본문 줄은 같은 줄 높이를 쓴다. 승인 패널(405–425행)은 이 파일에서 뺀다(U4가 그린다). 상태 글자는 임시로 지금의 매핑을 쓰고 U9가 presence로 바꾼다.
- 완료 체크: 기존 `RunMessage.*.test.tsx` 통과(구조 변경에 맞춰 단언 갱신, 약화 금지), 새 테스트: 실행 중→완료에서 행의 자식 줄 수가 같음. V1 측정기로 스트리밍 시작·종료 전이 1px 이하.

### U4 "지금 필요한 것" 자리와 질문 인라인
- 명세: `features/composer-flow.md` 규칙 2(D14), `features/inbox.md`.
- 대상: `W/ChatView.tsx`, `W/session/WorkTab.tsx`, `W/RunResponseArea.tsx`, `R/components/ApprovalPanel.tsx`·`InteractionPanel.tsx`(표시만), 새 `W/session/PendingTray.tsx`.
- 킷: `DecisionInbox`(계속 카드), `Collapse`.
- 구현: 타임라인 마지막 항목 뒤에 `PendingTray`를 둔다. 이 세션의 활성 Run이 기다리는 승인·질문·확장 질문·계속을 `RunResponseArea`로 그린다(확인 필요와 실행 기록이 쓰는 그 컴포넌트). `RunMessage`의 `showRelatedPanels={!sessionId}` 숨김을 없앤다. 답하면 카드가 제자리에서 한 줄 결과로 접힌다. 승인은 지금처럼 명시적 버튼으로만 보낸다(Enter·Escape로 결정하지 않는다). 트레이에 `data-pending-tray`를 달고 화면 노출 여부를 context로 내보낸다(U7이 쓴다).
- 완료 체크: `W/session/PendingTray.test.tsx`: 승인·질문이 같은 자리에 뜸, 같은 요청이 화면에 한 번만 있음, 답한 뒤 접힘. 기존 `ApprovalWaiting.once.test.tsx`, `questionNotice.test.tsx` 통과. 장면 ④의 이동 1px 이하.

### U5 전송 모델
- 명세: `features/composer-flow.md` §입력 규칙(D1), 이 문서 §4.5.
- 대상: `W/composerIntent.ts`(21–58행)와 테스트, `W/session/composer/send.ts`, `W/session/Composer.tsx`(조립), `W/ComposerInput.tsx`(키), `W/session/ComposerStatus.tsx`.
- 킷: `Kbd`, `Button`, `Menu`, `KitBadge`.
- 구현: `resolveIntent`를 §4.5 표대로 다시 쓴다(실행 중이고 대상이 있으면 기본이 `steer`). 전송에 `delivery`를 넘긴다. 키: 보내기 키는 합류, 끼어들기 키와 `⌥↵`는 §4.5. 도구 줄 오른쪽에 키 안내 한 줄(실행이 없을 때는 보내기만)을 항상 같은 높이로 둔다. 보내기 버튼 옆 메뉴에 세 가지를 둔다. 대상은 도구 줄 왼쪽의 배지이고 누르면 대상 메뉴가 열린다. `ComposerHeader`의 선택 두 개와 대상 1.5초 폴링 표시를 없앤다(대상 목록은 Run 투영에서 읽는다). 텍스트 첨부를 합류·끼어들기에도 싣는다(1345행의 차단 제거, 이미지는 유지). 클라이언트 자동 시작(1255–1265행)과 `corral:auto-queue` 저장을 지우고 세션의 `autoStart`를 읽고 쓴다. `/interrupt` 명령을 더한다.
- 하지 말 것: 접근성 이름 "보내기" 변경, IME 조합 중 전송.
- 완료 체크: `composerIntent.test.ts`가 §4.5의 다섯 행과 대상 고정 규칙을 고정, `composer/send.test.ts`에 `delivery` 두 값과 첨부, `ComposerInput.test.tsx`에 키 세 가지와 IME. 장면 ③ 키보드 실행.

### U6 사용자 메시지 메타 줄
- 명세: `features/composer-flow.md` 규칙 4, 이 문서 §4.5의 문구 표.
- 대상: `W/session/SessionEntries.tsx`(58–62, 87–99, 205–227, 355–430행), `SessionEntries.turn.test.tsx`.
- 킷: `AgentStatusLabel` 크기의 한 줄, `Button`(다시 보내기).
- 구현: 사용자 메시지 아래에 한 줄을 항상 둔다. 지시의 전달 상태를 Run 투영에서 읽어(2초 폴링 제거) §4.5 문구로 보인다. 상태 문단·거절 도움말·전달 상태 문단을 이 줄로 모은다. 줄의 높이는 내용과 무관하다. 넘겨받은 항목(`carriedFrom`)은 새 요청 메시지 하나로만 보이고 원래 지시 줄과 겹치지 않는다.
- 완료 체크: 표의 아홉 행 각각에 대한 테스트, 상태가 바뀌어도 줄 수가 같음, 장면 ③의 이동 1px 이하.

### U7 활동 바
- 명세: `features/composer-flow.md` §활동 바(D7), `chat-widgets-contract.md`.
- 대상: 새 `R/components/ActivityBar.tsx`와 `ActivityBar.stories.tsx`(표시), 새 `W/session/useActivity.ts`(데이터), `W/widgets/ChatWidgets.tsx`(`ComposerDock` 513–722행), `W/docking/DockTopBar.tsx`, `S/pages/SessionPage.tsx`(458–483행). 삭제: `W/DockRunControls.tsx`와 테스트.
- 킷: `AgentStatusPill`, `AgentStatusLabel`, `LiveDot`, `Meter`.
- 구현: `ActivityBar`는 props만 받는 조합이다. 닫힌 한 줄의 내용 우선순위는 (1) 화면에 보이지 않는 응답 대기(하나면 pill의 승인·거절, 여럿이면 건수와 "보기") (2) 화면에 보이지 않는 작업 중 역할 (3) 합류 대상 실행의 현재 활동 (4) 쉬는 상태의 요약(끝난 실행 상태 · 계획 n/m · 변경 n)이다. `detail`에 계획과 변경, 오른쪽에 컨텍스트 %. `steps`에는 계획 항목을 넣어 펼치면 Todo가 보이게 한다. 펼친 곳에 역할 행(보기 · 여기에 합류)과 일시정지·재개·중지를 둔다. `useActivity`는 B1의 presence와 U4의 트레이 노출, 실행 행의 화면 노출(`IntersectionObserver` 하나)을 묶는다. 연결 끊김·유실도 이 줄이 말한다. 바는 실행이 없어도 같은 높이를 차지한다. 상태 이름에는 `data-presence-label`을 단다. 중지는 활성 실행 단위가 둘 이상일 때만 확인한다.
- 하지 말 것: 경과 초를 라이브 영역 안에 두기(상태가 바뀔 때만 알린다), 실행 상태를 상단 줄에 다시 두기.
- 완료 체크: 스토리 다섯 개(쉬는 상태, 한 역할 작업, 세 역할 작업, 응답 대기, 끊김)가 렌더되고 접근성 검사 통과, `useActivity.test.ts`: 화면에 보이는 역할은 닫힌 줄에서 빠짐·응답 대기가 가장 앞. 장면 ②④에서 가시 `data-presence-label` 중복 0.

### U8 상태 적용 A: 사이드바·목록·유예
- 명세: `features/presence.md`, `workbench.md` 345–361행.
- 대상: `W/Sidebar.tsx`(241, 313, 667, 833–845, 904–914행), `W/sessionList.ts`, `W/RunList.tsx`, `W/Breadcrumbs.tsx`, 각 테스트.
- 킷: `StatusDot`, 킷 `Sidebar*`.
- 구현: 자체 최신 실행 정렬과 `ENDED` 사본을 지우고 `sessionPresence`를 쓴다. 행과 묶음에 `settle`을 적용한다(`now`는 주입). 행 높이를 상태와 무관하게 고정한다. 배지 수의 정의(`features/inbox.md` 29행)는 그대로다. 세션 행에 `data-session-row`.
- 완료 체크: `Sidebar.test.tsx`: 작업 중 → 완료 → 2초 안에 다음 실행 시작이면 묶음을 옮기지 않음, 응답 대기는 즉시. `sessionList.test.ts` 갱신 통과. V2의 사이드바 장면.

### U9 상태 적용 B: 대화·위젯
- 대상: `W/widgets/OverviewWidgets.tsx`(626, 678행), `W/widgets/selectors.ts`(432–485, 541, 873행), `W/agentSummary.ts`, `W/TurnProcess.tsx`(182–191, 216–230, 298–330행), `W/RunMessage.tsx`의 머리 줄, `W/RunActivity.tsx`, `R/components/StatusBadge.tsx`, `R/components/agentStatus.ts`, `S/pages/RunPage.tsx`(1109–1121행), `W/widgets/RunStatusAnnouncement.tsx`, `R/messages/{en,ko}.json`.
- 구현: 위 위치의 자체 판정을 `executionPresence`·`runPresence`로 바꾼다. 문구는 `Presence` 네임스페이스만 쓰고 `RunStatus`·`Status`·`RunPage`·`RunReasons`에 흩어진 같은 뜻의 키를 지운다. 색은 presence의 `tone`만 따른다.
- 완료 체크: 각 파일의 기존 테스트 통과, `grep`으로 위 파일들에 상태 문자열 비교(`=== 'running'` 등)가 presence 밖에 남지 않음, 지운 메시지 키를 참조하는 곳 없음(`pnpm typecheck`).

### U10 인용 A: 계약·브리지·칩
- 명세: `features/reply-citation.md`.
- 대상: `T/attachments.ts`(64–114행), `W/context/bridge.ts`, `W/context/SourceAttachments.tsx`, `W/TextAttachments.tsx`, 각 테스트.
- 구현: 출처 종류 `reply`: `{ runId, modelCallId, start, end, prefix, suffix }`(오프셋은 렌더된 본문 텍스트의 UTF-16 위치, 앞뒤 문맥 32자), 본문 8,000자 이하, 덧붙인 말 2,000자 이하. `beginAttachmentCapture`/`appendComposerAttachment`가 이 종류를 받는다. 칩은 인용 표식과 첫 40자를 보인다.
- 완료 체크: 계약 테스트(길이·`end > start`·빈 본문 거절), 브리지 테스트(초안 revision 고정이 그대로 동작), `pnpm contracts:check`.

### U11 인용 B: 선택 툴바와 원문 복귀
- 대상: 새 `W/ReplySelection.tsx`와 테스트, `W/RunMessage.tsx`(본문 감싸기), `W/session/SessionEntries.tsx`(보낸 칩의 클릭).
- 킷: `Popover`, `Button`, `Kbd`.
- 구현: 답변 본문 안에서 선택이 끝나면 선택 위에 작은 툴바를 띄운다(인용, 단축키 `Alt Q`). 누르면 U10의 브리지로 칩을 붙이고 입력에 포커스를 준다. 선택이 여러 답변에 걸치면 툴바를 띄우지 않는다. 보낸 칩을 누르면 그 답변으로 스크롤하고 오프셋으로 구절을 찾아 잠깐 강조한다. 오프셋이 맞지 않으면 앞뒤 문맥으로 찾고, 못 찾으면 칩이 "원문 위치를 찾지 못함"을 보인다. 툴바는 본문 흐름 밖에 떠서 줄을 밀지 않는다.
- 완료 체크: 선택 → 칩, 걸친 선택 무시, 오프셋 복원·문맥 복원·실패 세 경우 테스트. 장면 ⑤ 키보드 실행과 이동 1px 이하.

### U12 확인 필요: 같은 응답 영역, 계속 여부 카드
- 명세: `features/inbox.md`.
- 대상: `S/pages/InboxPage.tsx`(638행 부근)와 테스트.
- 구현: `decision` 항목은 U4의 지금 필요한 것과 같은 `RunResponseArea`를 쓴다(이미 그렇다면 그대로). 계속 여부 승인(`loop_cap`, 무진전, `request_budget`)이 같은 카드로 보이고 답할 수 있어야 한다. 답한 뒤의 동작은 지금 명세 그대로다: 포커스가 다음 항목으로 가고, 답한 항목의 상세는 "실행 열기"를 유지하며, 다른 항목을 자동으로 고르지 않는다.
- 완료 체크: 확인 필요와 대화가 같은 응답 컴포넌트를 쓰는 테스트(가져오기 경로 단언), 계속 여부 카드에 답하는 테스트, 기존 확인 필요 테스트 통과.

### U13 중복·사문 제거
- 대상: `W/session/composer/send.ts`의 `explain` 분기와 `packages/client/src`의 `startExplain`(다른 호출자가 없을 때만), `W/RunStatusCards.tsx`(273–315행의 압축), `S/pages/SessionPage.context.test.tsx`(411–434행).
- 구현: 쓰이지 않는 `explain` 경로를 지운다. 서버 라우트는 다른 호출자(CLI 등)를 확인하고, 있으면 남긴다. 압축은 `/compact`와 활동 바의 컨텍스트 상세만 남긴다.
- 완료 체크: 지운 식별자 참조 0(`pnpm typecheck`), 관련 테스트 갱신 통과.

### U14 영문 문구 정리
- 대상: `R/messages/en.json`, [용어집](../specs/glossary.md).
- 구현: 화면의 session을 conversation으로, panel을 pane으로 맞춘다(옆·아래 영역 전체를 가리키는 곳 포함). 코드·URL 이름은 그대로다. `edit-copy` 스킬을 따른다.
- 완료 체크: en.json의 값에 대소문자 무시 `session`·`panel`이 용어집이 허용한 곳에만 남음, 문구를 단언하는 테스트 갱신 통과.

### M1 회의 점수·정책 분리, 선택 기록, 무응답
- 명세: `features/local-intelligence.md` 63–75행 수정분(D12).
- 대상: `packages/local-intelligence/src/meeting/selector.ts`(102–142행), `T/meeting.ts`(25–36, 101–109행), `C/meeting.ts`(592–660행), 새 `C/meeting-policy.ts`, 각 테스트.
- 구현: 선택기는 `{ scores: { participantId, score }[], needsReply?: number } | null`을 돌려준다. `selectSpeakers(candidates, result, policy, { continuityId })`가 코드에서 고른다: 후보에 없는 id와 유한하지 않은 점수는 버림, 기본 한 명(최고점, 동점은 명단 순서), `needsReply`가 있고 정책 문턱보다 낮으면 빈 배열(직전 발화자가 이어지는 경우 제외). `needsReply`가 없으면 지금과 같은 결과가 나와야 한다. 라운드에 `selection: { strategy: explicit|mention|address|selector|fallback|none, scores?, reason }`를 저장한다. 요청의 수신자에 "없음"을 받아 답이 0개인 라운드를 만든다.
- 하지 말 것: 이름·호칭 규칙 변경, 임베딩 점수에 절대 문턱 적용.
- 완료 체크: `packages/core/test/meeting.test.ts`: 기존 선택 테스트 전부 그대로 통과, 정책 단위 테스트(후보 밖 id, 동점, `needsReply` 문턱, 연속성), 수신자 "없음" 라운드, `selection` 저장. `pnpm contracts:check`.

### M2 회의 연쇄 확인
- 명세: D11.
- 대상: `C/meeting.ts`의 `followMentions`(861–897행), `T/meeting.ts`.
- 구현: 마지막 사람 메시지 뒤에 `message: null`로 이어진 라운드 수를 세고 8이면 새 라운드를 만들지 않고 회의에 `hold: { kind: 'chain', after: roundId }`를 남긴다. 사람이 "계속"을 누르거나 메시지를 보내면 풀린다.
- 완료 체크: 8번째에서 멈춤, 사람 메시지로 초기화, 계속으로 재개(기존 812–836행의 연쇄 테스트는 8 미만에서 그대로 통과).

### M3 회의 화면을 공용 타임라인·컴포저로
- 대상: `S/pages/MeetingPage.tsx`(1,185행: `MeetingComposer` 688행, `MeetingRecipients` 1127행), `W/session/composer/`.
- 구현: 회의도 U2의 타임라인 틀과 U5의 컴포저를 쓴다. 컴포저에 "전송 대상 어댑터"를 넣어 회의에서는 도구 줄의 대상 배지가 수신자(자동 · 지정 · 없음)를 고르게 한다. 자체 컴포저를 지운다. 참가자 줄(`W/MeetingParticipants.tsx`)은 활동 바를 펼친 곳의 역할 행과 같은 부품으로 그린다.
- 완료 체크: 회의 화면의 기존 테스트 통과, 새 테스트: 수신자 세 가지가 요청에 반영됨, 회의와 대화의 컴포저가 같은 컴포넌트임(가져오기 경로 단언).

### M4 회의 선택 기록 표시, 계속 카드
- 대상: `S/pages/MeetingPage.tsx`(534–541, 588행).
- 킷: `DecisionInbox`, `Popover`.
- 구현: 자동으로 고른 라운드의 메타 줄에 선택 표식을 두고 누르면 방법과 점수를 보인다. 답이 0개인 라운드는 메타 줄에 "답변 없음"만 보인다. 연쇄 hold는 타임라인 끝의 계속 카드로 보인다.
- 완료 체크: 세 표시 각각의 테스트, 회의 장면의 이동 1px 이하.

### A1 감독 계약
- 명세: `features/advisor.md`, `features/team-graph.md`.
- 대상: `T/definition.ts`(113행 `invocation`, 61–70행 `CollaborationTool`, 255–262행 `CapabilityLink`), `T/commands.ts`, `T/events.ts`.
- 구현: `invocation`에 `observer`, `CapabilityLink.kind`에 `advise`, `CollaborationTool`에 `advise`. 명령 `submit_advice { observerExecutionId, attemptNo, targetExecutionId, severity: nit|concern|blocker, note(1–1000자) }`. 이벤트 `advice.admitted { adviceId, severity, channel: aside|steer|interrupt|preserve }`, `advice.suppressed { reason: duplicate|noise|over_budget|target_terminal }`. 지시에 `origin: user|advice|system`. 감독 노드 설정 `review: { interval(기본 1), maxRequestsPerReview(기본 8) }`.
- 완료 체크: 스키마 테스트, `pnpm contracts:check`.

### A2 감독 컴파일 규칙
- 대상: `C/compiler/`(포트 규칙은 `ports.ts`), 테스트.
- 구현: 감독 노드는 제어 흐름 간선을 가질 수 없고 `advise` 연결을 하나 이상 가져야 한다. `advise`의 출발은 감독 노드, 도착은 `agent` 노드다. 감독 역할의 작업 도구는 읽기(`search`, `read_document`, `list_files`, `read_file`)만, 협업 도구는 `read_artifact`와 `advise`로 고정한다. 감독이 감독을 가리킬 수 없다. 위반은 지금의 컴파일 오류 형식으로 낸다.
- 완료 체크: 규칙마다 반례 테스트 하나씩.

### A3 조언 문지기와 전달 채널
- 대상: 새 `C/advisor/guard.ts`, `C/advisor/channel.ts`, 테스트.
- 구현: 둘 다 순수 함수다. `admit(state, { severity, note })`는 소문자·NFKC·글자와 숫자 밖은 공백으로 정규화한 뒤, 빈 것과 빈말 목록(stop, done, ok, lgtm, looks good, continue, no issue continue와 한국어 대응)은 `noise`, 이미 본 키이고 이전 심각도가 같거나 높으면 `duplicate`, 한 번의 검토에서 차단이 아닌 조언이 3개를 넘으면 `over_budget`로 돌려준다. 이력은 감독 실행 단위마다 512개까지다. `resolveChannel({ severity, target })`는 대상이 작업 중이면 nit는 `aside`, concern은 `steer`, blocker는 `interrupt`(대상 어댑터가 못 하면 `steer`), 대상이 사람을 기다리면 그대로 두고 결정 뒤에 전달, 대상이 종료면 nit는 억제(`target_terminal`), 나머지는 `preserve`다.
- 완료 체크: 정규화 표 테스트("Stop.", "*stop*", "  STOP " 가 같은 키), 중복·심각도 상승 통과, 예산, 채널 표 전부.

### A4 검토 입력 작성기
- 대상: 새 `C/advisor/delta.ts`, 테스트. 읽는 곳: `C/projection.ts`(`modelCalls` 243행, `toolCalls` 245행, `responseRef` 92행), 응답 산출물(`response_<id>`).
- 구현: `buildReviewInput(run, executionId, cursor)`가 커서 뒤의 모델 호출을 순서대로 모은다. 호출마다 답변 본문(6,000자까지)과 그 호출의 도구 행(이름, 대상, 상태, 요약)을 넣는다. 첫 검토에는 그 역할의 작업 입력을 앞에 붙인다. 전체 24,000자를 넘으면 오래된 도구 요약부터 줄이고 줄인 개수를 한 줄로 적는다. 새 커서를 함께 돌려준다. 자격 증명·내부 경로를 넣지 않는다(공개 이벤트와 같은 규칙).
- 완료 체크: 커서 진행, 길이 상한, 첫 검토의 입력 포함, 변화가 없으면 빈 결과.

### A5 감독 실행 단위와 조언 처리
- 명세: `features/advisor.md`.
- 대상: `C/coordinator.ts`, `C/admission/index.ts`(관찰자 118–148행), `apps/server/src/app.ts`(673–725행의 `new Coordinator`), 새 `C/advisor/service.ts`, 테스트.
- 구현: 서버가 Coordinator에 `admission.observers`로 감독 서비스를 넘긴다(지금은 관찰자가 0개다). 서비스는 지켜보는 실행의 `model.finished`를 받아 간격을 채웠으면 검토를 예약한다. 검토가 도는 중이면 새 것과 합친다. 감독 실행 단위는 첫 검토 때 그 Run 안에 만들고 검토 사이에는 `waiting_message`로 둔다. 검토 요청은 A4의 입력을 메시지로 넣어 깨운다. `submit_advice`는 시도 번호를 확인하고 A3의 `admit`과 `resolveChannel`을 거쳐 이벤트를 남기고, 전달할 조언은 `origin: advice`인 지시로 기존 경로에 넣는다. `preserve`는 확인 필요 항목 `advice`가 된다. 지켜보던 실행이 모두 끝나면 남은 입력으로 마지막 검토를 한 번 하고 감독 실행 단위를 끝낸다. 감독의 요청 예산은 B9를 따른다. 조언은 승인·취소·패치를 할 수 없다.
- 완료 체크: `packages/core/test/advisor.test.ts`(스크립트 어댑터): 검토가 예약되고 합쳐짐, 조언이 지시로 전달됨, 억제 사유가 도구 결과에 그대로 돌아감, 종료된 대상은 깨우지 않음, 사용량이 같은 Run에 기록됨, Run 취소가 감독 실행 단위까지 닿음, 서버 관찰자 연결 테스트.

### A6 `advise` 도구와 검토 요청 전달
- 대상: `P/worker-tools.ts`, `P/worker.ts`, `P/sdk-worker.ts`, 테스트.
- 구현: 협업 도구 `advise(severity, note, target?)`가 `submit_advice`를 부르고 결과(접수 또는 억제 사유)를 도구 결과로 돌려준다. 쉬고 있는 감독 worker는 검토 요청 메시지를 받아 한 번의 검토를 돌고 다시 쉰다(질문에 답하고 대기를 잇는 `parentQuestions` 흐름이 본보기). 지시가 모델에 실릴 때 `origin: advice`는 `<advisory severity="…" from="역할 이름">…</advisory>`로 감싼다.
- 완료 체크: `packages/adapter-pi/test/`에 도구 호출과 결과, 검토 뒤 다시 대기, 감싼 표현.

### A7 팀 편집기의 감독 노드
- 명세: `features/team-graph.md`, `features/canvas.md`.
- 대상: `R/team-editor/`(`InspectorSheet.tsx` 128행, `NodeSettings.tsx` 80–206행, 노드·연결 렌더), 테스트.
- 킷: 기존 노드 부품, `KitRadioGroup`, `KitInputField`, `Select`.
- 구현: 호출 방식 라디오(121–134행)에 감독을 더한다. 감독 노드는 제어 흐름 포트를 보이지 않고 `advise` 연결만 그을 수 있다. 연결은 다른 능력 연결과 구분되는 선 모양으로 그린다(색만으로 구분하지 않는다). 속성 패널에 검토 간격을 두고, 도구 선택은 읽기 도구만 보인다. 자동 배치가 감독 노드를 지켜보는 역할 옆에 놓는다.
- 완료 체크: 편집기 테스트: 감독 노드 추가·연결·저장·다시 열기, 컴파일 오류 표시. 스토리 하나.

### A8 조언 표시
- 대상: `W/RunMessage.tsx`(작업 과정), `R/components/ActivityBar.tsx`(역할 행), `W/inbox.ts`, `S/pages/InboxPage.tsx`, `R/run/flow.ts`(관계·판단 기록).
- 킷: `AgentStatusLabel`, `KitBadge`, `Collapse`.
- 구현: 전달된 조언은 지켜보던 역할의 작업 과정 안에 한 줄(감독 · 심각도 · 첫 줄 · 전달 상태)로 보인다. 억제된 조언은 대화에 보이지 않고 실행 기록의 관계·판단 기록에만 남는다. 활동 바를 펼친 곳에 감독 행(지켜보는 중 · 조언 n). `preserve` 조언은 확인 필요의 검토 묶음과 그 실행 행의 꼬리 줄에 보인다.
- 완료 체크: 세 표시의 테스트, 억제된 조언이 대화에 없음, 장면 ②에서 감독 행이 보임.

### A9 대화의 감독 설정
- 대상: 세션 설정 저장부, 대화 실행의 정의를 만드는 곳(`C/`의 대화 에이전트 정의 생성부), 컴포저 도구 줄의 메뉴.
- 구현: 세션 설정 `advisor: { modelProfile } | null`. 켜면 대화 실행의 정의에 감독 노드와 `advise` 연결을 더한다. 새 요청부터 적용하고 진행 중인 실행의 snapshot은 바꾸지 않는다. 도구 줄의 팀 메뉴 옆에서 켜고 끈다.
- 완료 체크: 설정이 다음 실행의 정의에 반영됨, 진행 중 실행은 그대로, 끄면 사라짐.

### 명세가 정한 차이

S0에서 명세를 쓰면서 브리프와 달라진 곳이다. 이 줄과 명세가 위 브리프보다 우선한다.

- **B4·U5·B5 (시작 요청 스냅샷).** 대기 항목만으로는 서버가 시작 요청을 만들 수 없다(모델·추론·팀 선택이 브라우저에만 있다). 세션 항목이 `start`(시작 요청에서 `commandId`·`brief`·`throughRunId`·`references`를 뺀 것)를 갖는다. B4가 필드와 서버 사용을, U5가 화면에서 새 요청과 다음 요청을 기록할 때 `start`를 채우는 일을, B5가 넘겨받은 항목에 대상 Run을 시작한 항목의 `start`를 복사하는 일을 맡는다. 그 항목에 `start`가 없으면 넘겨받지 않는다.
- **V1 (측정기).** 추적 대상이 없으면 최상위 값은 0이 아니라 `null`이고 표본 수를 함께 낸다. 항목은 식별 값(`data-chat-item` 값)으로 따라가 같은 값의 새 노드로 바뀌어도 이어서 재고, 사라진 항목은 결과에 따로 적는다. 세로와 가로 이동을 모두 잰다. 입력 줄과 끝 간격의 첫 표본은 `start()` 안에서 읽는다. 전이 구간은 붙잡아 둔 응답으로 만들고 구간 사이에 빈틈을 두지 않는다. `e2e/flow`는 `playwright.flow.config.ts`로만 돌고 확장 구성(`playwright.extended.config.ts`)에서는 뺀다.
- **B8 (초과 복구와 취소).** 컨텍스트 초과 복구도 같은 판정을 쓴다(생각·공백만 나왔을 때만 강제 압축 뒤 한 번 다시 보냄). 붙잡은 이벤트의 취소 경계 두 가지(붙잡은 중 취소, 재시도 대기 중 취소)를 테스트로 고정한다.
- **B1 (유예).** 유예는 `starting`·`working`에서 `succeeded`·`cancelled`로 바뀔 때만 있고 실행이 끝난 시각부터 2초다(끝난 시각을 모르면 변화를 처음 본 시각부터). 60초 규칙은 없다. 유예가 끝나는 시각은 다시 물어도 밀리지 않는다. 열린 요청도 승인 대기도 없는 `awaiting_user` Run의 필요한 것은 `continue`다.
- **B3 (첨부의 자리).** 브리프의 "본문 앞"과 달리 사람의 글이 먼저 오고 첨부가 뒤에 붙는다(새 요청과 같은 순서). 첨부 본문 뒤에 사람의 글이 오면 첨부가 경계를 흉내 낼 수 있기 때문이다. 구분선은 쓰지 않는다. 보호 컨텍스트에는 첨부의 이름·종류·크기·hash만 든다.
- **B3 (남긴 비용).** 첨부가 실린 지시는 이벤트와 투영에 본문 전체가 남는다(지시 하나에 최대 약 320KiB). 인용처럼 작은 첨부가 보통이라 따로 저장하지 않았다.
- **B3 (B7이 남긴 반례).** 같은 파일을 고치는 김에 `packages/adapter-pi/test/pi-adapter.test.ts`에 자동 압축이 실패하면 `started`·`failed` 이벤트가 한 번씩 나오고 실행이 예전처럼 실패로 끝나는 테스트를 더한다(자동 실패를 다시 던지는 줄이 빠지면 실패해야 한다).
- **U3·U7·U8·U9 (상태 이름의 대상).** `data-presence-label`의 값은 `run:<runId>` 또는 `execution:<executionId>`다. 사이드바의 세션 행은 상태 이름을 글자로 쓰지 않고 킷 표식과 접근 이름만 쓴다(U8). 대화에서 Run 전체를 나타내는 실행 행의 머리 줄은 `run:<runId>`, 팀 안 역할의 행은 `execution:<id>`를 쓴다(U3·U9). 활동 바는 자기가 말하는 대상의 값을 쓰고, 같은 값의 행이 화면에 보이면 그 상태 이름을 쓰지 않는다(U7). 측정기는 값으로 센다(V1).
- **B7 (자동 압축의 보고).** 자동 압축도 수동과 같은 단계(`started` 뒤 `completed`·`failed`·`cancelled`·`skipped`)를 보고하므로 이벤트는 단계마다 하나다. 자동은 보고에 `trigger: 'automatic'`을 싣고 이벤트 envelope의 commandId는 비운다.
- **B9 (§9 표 테스트).** `apps/server/test/server.test.ts`의 제품 계약 §9 표 테스트에 무인 실행 예산·감독 예산 행이 코드 기본값과 같다는 단언을 더한다.
- **B4 (리뷰에서 정한 것).** `carriedFrom`은 HTTP로 받지 않는다(서버만 적는다). 항목의 권한 방식과 `start`의 권한 방식이 다르면 저장을 거절한다. 서버가 쓰는 `throughRunId`는 화면과 같은 규칙으로 고른다(같은 commandId의 payload가 같아야 한다). 대기 항목이 더해질 때 열린 Run이 없으면 대기열을 바로 살핀다. `start`는 시작 요청에서 `commandId`·`brief`·`throughRunId`·`references`·`sessionId`·`schemaVersion`을 뺀 것이다.
- **U5·B5 (`start`의 모양과 서버의 시작 요청).** `start`는 `{ harness?, permissionMode?, taskScope?, verificationScope?, choice, mode, startFrom?, team? }`다(스키마 `SessionEntryStart`, `packages/core/src/repository/index.ts`). `start.permissionMode`는 항목의 `permissionMode`와 같아야 저장된다(둘 다 없거나 같음). 서버는 `{ ...start, commandId: queuedSessionCommandId(sessionId, entry), sessionId, brief: entry.text, conversation?: { throughRunId }, references?: entry.attachments }`로 시작한다. `throughRunId`는 그 세션의 Run을 시작 시각 순으로 놓았을 때 마지막 종료 Run이다(화면과 같은 규칙). 화면이 같은 항목을 시작할 때도 같은 payload여야 충돌이 없다.
- **B4 (남긴 한계).** 서버가 Run을 시작한 뒤 항목에 기록하기 전에 죽으면 그 항목은 대기로 남고, 다음 패스에서 같은 commandId가 충돌해 뒤 항목을 막는다. 사람이 그 항목을 편집하거나 지우면 풀린다. 드문 경우라 복구 코드를 넣지 않았다.
- **B9·A5 (감독의 예산).** 감독은 예산(기본 60)을 다 쓰면 승인을 묻지 않고 끝난다. 계속 여부 승인은 팀 역할(400)과 동적 하위 실행(200)에만 있다. 승인의 kind는 `request_budget`이다.
- **A1·A3 (조언의 전달).** 전달 방식의 이름은 `next_request`, `interrupt`, `preserve`다(`aside`, `steer`는 없다). `nit`과 `concern`은 `next_request`, `blocker`는 `interrupt`(대상이 못 받으면 `next_request`), 대상이 끝났으면 `nit`은 버리고 나머지는 `preserve`다. 대상이 사람을 기다리는 경우는 따로 다루지 않고 지시의 일반 규칙대로 결정 뒤에 읽힌다. `advice.suppressed`는 조언의 글을 싣지 않는다.
- **A1·A5 (검토).** 검토 간격의 기본값은 3이다. 한 번의 검토는 실행 단위 하나의 기록만 다루므로 `advise` 도구는 대상을 인자로 받지 않는다. 지켜보던 실행 단위가 끝나면 마지막 검토를 한 번 하고, 그동안 Run은 끝나지 않는다. 감독의 Task는 Run의 필수 작업이 아니다.
- **U3·U6 (행 안쪽 조각).** 실행 행의 머리 줄·본문·꼬리 줄에 `data-chat-part="head|body|tail"`, 사용자 메시지의 메타 줄에 `data-chat-part="meta"`를 단다. 측정기가 이 조각의 이동도 잰다. `data-chat-item`은 이미 있다(`ChatView.tsx`).
- **U4 (실행 기록 창).** 세션 화면에서는 대화의 지금 필요한 것이 그 요청에 답하는 하나뿐인 자리다. 같은 세션의 실행 기록 창은 기다리는 요청을 읽기로만 보이고 "응답하기"로 그 자리에 보낸다. `respond` 표시가 있는 링크는 세션의 Run이면 대화의 지금 필요한 것으로 간다.
- **K1 (낙관적 응답 끄기).** 킷 `DecisionInbox`에 적응 둘을 더한다: `optimistic`(기본 true, false면 누를 때 확인 표시를 띄우지 않고 `onDecide`만 부른다)와 결정의 `pending`(보낸 뒤 receipt를 기다리는 동안 버튼이 기다림 상태). Corral은 `optimistic={false}`로만 쓰고 확인 표시는 `resolution`으로 준다([DESIGN.md](../../DESIGN.md)의 `DecisionInbox` 줄). 스토리는 계속 여부 예만 든다.
- **U4·M4·U12 (`DecisionInbox` 쓰는 법).** 반드시 `optimistic={false}`로 쓴다(기본값은 킷 원본의 낙관적 응답이다). `onDecide` 안에서 그 결정의 `pending`을 바로 세워 두 번 보내지 않게 하고, receipt가 오면 `resolution`을 주거나 행을 뺀다. 거절되면 `pending`을 풀고 이유를 그 자리에 보인다. 키보드로 답하면 누른 버튼이 사라지며 초점이 본문으로 떨어지므로, 답한 뒤 초점은 다음 열린 결정의 첫 버튼으로, 없으면 입력창으로 옮긴다. 이 세 가지를 호출부 테스트로 고정한다.
- **U4 (킷 `DecisionInbox`의 머리줄).** 킷은 답한 행을 부모가 목록에서 뺄 때까지 남겨 두고 머리줄에 열린 수를 보인다. 답한 행이 남은 동안 머리줄이 "0건…"으로 읽히지 않게 `heading(0)`은 비운 머리줄 문구를 돌려주고, 서버가 요청을 닫으면 행을 바로 뺀다.
- **U7 (세션 누계 줄).** 입력창 아래의 세션 누계 한 줄(실행 수·단계 수·토큰·캐시 적중률)은 그대로 둔다. 쉬는 컴포저의 높이 목표는 이 줄을 포함해 148px 이하다.
- **U9·U14 (용어집).** 용어집 "남은 불일치"의 세 항목은 해당 태스크가 병합될 때 오케스트레이터가 지운다.
- **M1 (빈 선택).** 빈 선택의 저장 방식은 이미 있다(`local-intelligence.md` 75행). 더하는 것은 사람이 고른 "없음"과 정책의 `needsReply` 경로, 그리고 선택 기록이다.
- **M2 (계속).** 회의의 계속은 `POST /sessions/:id/meeting/continue`다.

### V2 최종 장면
- 대상: `apps/studio/e2e/flow/{idle,multi-agent,join-interrupt,awaiting,citation,sidebar,meeting}.spec.ts`.
- 구현: §9의 절차를 그대로 테스트로 만든다.
- 완료 체크: §9의 합격선 전부, 결과를 `test-results/flow/report.json`에 기록.

## 9. 시각 검증 프로토콜

**도구.** Playwright(Chromium), `apps/studio/playwright.flow.config.ts`. 서버는 `e2e/server/harness.ts`의 하네스로 띄운다. 스크립트 어댑터와 가짜 응답만 쓰고 외부 호스트는 하네스가 막는다. 표시 부품은 Storybook의 브라우저 테스트 구성(`packages/react/vitest.storybook.config.ts`)으로 따로 본다.

**측정.** `probe.ts`가 구간마다 다음을 잰다.
- 기존 항목 이동: 구간 시작 때 있던 `[data-chat-item]`과 `[data-session-row]`의 컨테이너 기준 위치 변화. 합격선 1px 이하.
- 따라가기: 끝을 따라가는 중에는 타임라인 마지막 항목의 아래 가장자리와 컴포저 위 가장자리의 간격 변화 1px 이하. 위로 올려 둔 상태에서는 화면 기준 위치 변화 1px 이하.
- 입력 줄: 입력 상자 아래 가장자리의 화면 위치 변화 0px.
- 상태 이름: 화면에 보이는 `[data-presence-label]` 가운데 같은 값(대상, `run:<id>`·`execution:<id>`)이 둘 이상이면 실패. 사이드바의 세션 행에는 이 속성이 없어야 한다.
- 고정 영역: 상단 줄과 쉬는 컴포저 높이의 합 200px 이하(세션 누계 줄 포함), 본문 열 너비 720–760px.

**장면.** 각 장면은 전이 직전·직후 화면을 `test-results/flow/<장면>/<단계>.png`로 남긴다.

| 장면 | 만드는 방법 | 재는 전이 | 추가 확인 |
|---|---|---|---|
| ① 대기 | 실행 하나가 끝난 세션 | 빈 세션 → 요청 전송 → 실행 시작 → 완료 | 활동 바가 실행 전후 같은 높이, 밝은·어두운 테마 |
| ② 여러 역할 | 병렬 분기 팀(`e2e/server/team-graph.spec.ts` 104행의 방식)에 응답을 붙잡아 세 역할을 동시에 작업 중으로 둠 | 역할 하나씩 풀어 완료시키며 세 번 | 닫힌 활동 바가 화면에 보이는 역할을 말하지 않음, 펼쳐서 "여기에 합류" 두 번의 조작, reduced motion |
| ③ 합류·끼어들기 | 응답을 붙잡은 실행 | 메시지 입력 → 보내기 키 → 붙잡은 것 해제 → 메타 줄이 읽힘으로. 두 번째 메시지 → 끼어들기 키 → 응답이 끊기고 전달됨 | 키보드만으로, 끊긴 응답이 제자리에 남음, 실행이 먼저 끝나는 경우의 "새 요청으로 시작" |
| ④ 승인·입력 대기 | 승인 팀(`run-page.spec.ts` 533행)과 `ask_user`(`m1-interactions.spec.ts` 42행) | 작업 중 → 응답 대기 진입 → 답함 → 작업 중. 카드를 화면 밖으로 올린 뒤 활동 바에서 승인 | 같은 요청이 화면에 한 번, 입력해 둔 초안 보존, Enter로 승인되지 않음, 어두운 테마 |
| ⑤ 인용 | 끝난 답변 | 구절 선택 → 툴바 → 칩 → 전송 → 보낸 칩 클릭 → 원문 강조 | 키보드만으로(`Alt Q`), 칩이 늘어도 입력 아래 가장자리 고정 |
| 사이드바 | 대기 요청이 있는 세션 | 실행 종료 → 2초 안에 다음 실행 시작 | 행이 묶음을 옮기지 않음, 응답 대기는 즉시 이동 |
| 회의 | 참가자 셋, 스크립트 응답 | 사람 메시지 → 자동 선택 → 답변, 수신자 "없음", 연쇄 8회에서 계속 카드 | 대화와 같은 컴포저 |

**메인 세션의 디자인 검수.** 수치가 통과한 뒤 메인 세션이 직접 본다. 병합 전 브랜치는 검수 전용 작업 사본 `.claude/worktrees/flow-review`에서 본다. 그 사본을 `git checkout --detach flow/<id>`로 맞추고 미리보기 서버(`.claude/launch.json`의 `review-studio` 5174, 모의 실행 서버 `review-server` 4318, 부품은 `review-storybook` 6007)를 띄워 내장 브라우저에서 화면을 열고, 전이를 직접 일으켜 보며 밝은·어두운 테마와 reduced motion을 확인한다. 모의 실행 서버의 작업 폴더는 `.claude/worktrees/flow-review-ws`다. 병합된 통합 브랜치는 `studio`·`storybook`으로 본다. 하네스로만 만들 수 있는 상태(붙잡아 둔 응답, 동시에 작업 중인 세 역할)는 그 장면이 남긴 전이 전후 캡처로 본다. 기준은 `verify-changes`, `review-visuals`, `review-motion`, `check-accessibility` 스킬이다. 보는 것은 정보 위계(가장 먼저 읽히는 것이 지금 필요한 것인가), 같은 정보의 반복, 설명 문구의 유무, 킷 밖의 시각 값이다. 엔지니어가 만든 화면처럼 보이면(표 같은 폼, 설명 캡션, 상태의 반복) 수치와 무관하게 `revise`다.

**실행 시점.** V1이 지금 화면의 기준선을 남긴다. 화면 태스크마다 리뷰어가 그 태스크가 건드린 장면의 수치를 재고, 메인 세션이 같은 장면을 디자인 검수한다. V2가 전부를 한 번에 돌리고, 메인 세션이 일곱 장면 전체를 마지막으로 검수한다.

**오류가 났을 때.** 빌드 산출물이 없다, 포트가 쓰이고 있다, 선택자가 바뀌었다, 렌더링이 실패했다 같은 일반 오류에서 멈추지 않는다. 로그를 읽고 고쳐서(산출물 다시 만들기, 다른 포트, 선택자 갱신, 구현 수정) 합격선을 통과할 때까지 다시 돌린다. 합격선을 낮추거나 장면을 지워서 통과시키지 않는다.

## 10. 행동 경계

승인 없이 하는 것: 저장소와 샘플 코드 읽기, 화면 배치와 상태 선택자의 전면 재설계, 위 결정에 따른 명세 덮어쓰기, 로컬 빌드·테스트·헤드리스 브라우저 검증, 읽기 전용이거나 로컬에서 끝나는 오류의 재시도, 작업 브랜치와 작업 사본 만들기, 통합 브랜치로의 로컬 병합.

먼저 묻는 것: 사용자 데이터나 브랜치 삭제(끝난 태스크 브랜치 정리 포함), 원격으로 올리기와 PR, 외부 배포, 로컬 테스트 환경 밖으로 나가는 네트워크 호출(유료 모델·검색 포함), 새 라이브러리.

## 11. 범위 밖

- 세션 미뤄 두기: 확인 필요가 이미 사람이 봐야 할 것을 따로 모은다. 상태를 하나 더 늘리지 않는다.
- 재시작 뒤 효과 재실행 분류: 재시작하면 살아 있던 Run이 `interrupted`로 끝나므로 다시 돌릴 효과의 소비자가 없다.
- 스트림 도중 규칙 개입: 위반 메시지를 잘라내는 방식이 과거 컨텍스트를 덮어쓰지 않는다는 원칙과 부딪친다.
- 자동 회의 무응답: 선택기가 응답 필요 점수를 낼 때까지 켜지 않는다(M1이 받을 자리만 만든다).
- 도구 승인 카드의 킷 `PermissionRequest` 전환, 다른 실행 엔진 어댑터, 원격·모바일, 이벤트 로그 정리.
