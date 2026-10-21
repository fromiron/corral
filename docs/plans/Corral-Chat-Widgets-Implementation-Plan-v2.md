---
name: Corral chat widgets and live work plan v2
overview: 오른쪽 패널 접기 대신 채팅 상단의 상황별 정보 위젯, 입력창 위의 실제 WorkPlan, 단일 활동 표시를 구현한다. 화면 표현과 Corral 데이터 공급 경로를 필수 납품물로 고정한다.
status: proposed
review_date: 2026-10-19
corral_baseline: e160c6411955193bd92e44f3088a0dce07cc5f0c
supersedes_plan: Corral-Chat-View-Improvement-Plan.md
must_ship:
  - 채팅 타임라인 외부 상단에 실제 마운트된 상황별 위젯 바
  - 컨텍스트 게이지와 구성별 상세 팝오버 및 측정 데이터 공급
  - 입력창 바로 위에 실제 update_plan으로 갱신되는 Todo
  - 중복을 줄인 단일 실행 활동 표시와 항상 접근 가능한 사용자 대응 정보
  - 실행 중/갱신/종료/오류/좁은 화면의 브라우저 증거
not_completion:
  - CompactRunWorkspace만 수정함
  - 기존 RunStatusCards를 disclosure 안으로 옮김
  - Storybook 또는 하드코딩 mock에서만 위젯이 보임
  - update_plan 발행 경로 없이 WorkPlanPanel을 이동함
  - 측정 경로 없이 컨텍스트 알 수 없음 카드만 만듦
  - README에 참고 링크만 추가함
  - 위젯과 Todo를 선택 기능 또는 후속 작업으로 미룸
todos:
  - id: requirements-and-origin-map
    content: 필수 UI 계약·결정적 fixture·실패 테스트를 등록한다.
    status: pending
  - id: session-surface-and-store
    content: 현재 실행/패널 탐색/다음 요청을 분리하고 위젯·Todo·활성 카드의 공유 읽기 계층과 실제 슬롯을 연결한다.
    status: pending
  - id: work-plan-vertical-slice
    content: 기본 Auto의 기존 update_plan 권한과 공개 작업 규약을 연결하고 ComposerWorkPlan을 실행 갱신 경로로 완성한다.
    status: pending
  - id: context-measurement
    content: 메시지 추정과 전체 요청 추정을 구별하고 구성별 컨텍스트 측정·참조·선택자를 추가한다.
    status: pending
  - id: widget-presentation
    content: 게이지·상태 표시·접힘 표현을 Corral 토큰과 공용 컨트롤로 실제 화면에 연결한다.
    status: pending
  - id: unified-activity-and-actions
    content: 일상적인 도구 기록을 통합하고 승인·질문·실패·불명확 효과를 접힘에 묻히지 않게 한다.
    status: pending
  - id: results-and-demo-cleanup
    content: 선택 산출물 우선 패널, embedded 상태 중복 정리, 데모 진단 본문 분리를 적용한다.
    status: pending
  - id: integrated-evidence
    content: 늦은 응답·대상 보존·IME·스크롤·가상화·접근성·구독 수를 검증하고 시각 증거를 기록한다.
    status: pending
---

# Corral 채팅 위젯·실시간 작업 계획 구현 플랜 v2

## 0. 결론과 검토 범위

다른 에이전트의 안은 선택한 산출물을 먼저 읽게 만드는 오른쪽 패널 개선이다. 이 안만 구현하면 상단 위젯, 입력창 위 Todo, 그 갱신 데이터 경로는 생기지 않는다. 패널 개선은 이 플랜의 후반부 하위 작업으로 편입한다.

이번 플랜은 **보여줄 위치, 화면 표현, 데이터를 만드는 경로, 실행별 표시 상태, 완료 증거**를 하나의 납품 범위로 묶는다. 위젯을 특정 기존 컴포넌트의 이름으로 부르는 것이 아니라 실제 사용자 화면에 나타나는 동작으로 검증한다.

검토 시 GitHub의 Corral main은 e160c641이었다. 사용자가 제시한 화면 상태를 로컬에서 직접 재현하거나 앱을 빌드·테스트한 결과는 아니다. 작업 트리의 미커밋 변경은 확인하지 않았다. 구현 착수 시 현재 diff를 먼저 확인하고 이미 구현된 항목은 이 계약의 인수 기준으로 검증한다.

스크린샷은 원하는 정보 계층과 Todo 배치의 근거다.

### 다른 에이전트 안의 처리

| 제안 | 처리 |
|---|---|
| 선택 산출물을 패널 본문 첫 내용으로 배치 | 채택. 단, 미해결 승인·질문·복구 경고는 별도 대응 영역에서 유지 |
| compact 헤더에서 종료된 작업 수·0개 요청·일상 종료 이유 축소 | 채택. 전체 실행 상세는 보존 |
| RunStatusCards와 ExecutionTree를 기본 접힘 | 채택. 상단 위젯을 만든 뒤 중복 상세를 정리하는 단계로 제한 |
| ApprovalPanel도 같은 disclosure에 넣기 | 수정. 미해결 의사결정은 접힘 바깥에서 대응 가능해야 함 |
| 채팅의 도구 목록·작업 기록·입력창을 그대로 유지 | 불채택. 실제 위젯과 Todo 슬롯 및 중복 활동 정리가 필요 |
| CompactRunWorkspace만 변경 | 불채택. 이번 요구의 완료로 인정하지 않음 |
| 실행 상태는 별개 사실이므로 ResultReader에도 늘 반복 | 수정. 의미는 보존하되 같은 패널의 실행 헤더 아래에는 재표시하지 않음 |

## 1. 필수 화면 계약

### 1.1 배치

```text
SessionHeader
SessionWidgetBar                          ← 채팅 상단, 타임라인 바깥
  ContextUsageChip / AgentActivityChip / RunChangesChip / EnvironmentChip

ChatTimeline                              ← 주 스크롤 영역, 기존 가상화 유지
  사용자 요청
  공개 진행 메시지
  답변 또는 산출물 카드
  작업 기록 진입점

ComposerDock                              ← 채팅 하단, 타임라인 바깥
  ActionRequiredBar                       ← 필요한 승인·질문·오류에만 표시
  ComposerWorkPlan                        ← 입력창 바로 위, 진행 중 기본 펼침
  RunActivityWidget                       ← 현재 단계·실행 경과·기록 진입점
  ComposerSurface.Host                    ← 기존 입력 DOM 유지
  ComposerSurface.ContextStrip            ← 다음 요청의 중요한 조건만

RightPanel                                ← 기존 보조 패널, 제3열 추가 없음
  선택한 결과 / diff / 실행 상세
```

실제 배치 예시(수치와 작업명은 테스트용 설계 예시):

```text
[컨텍스트 약 18% ▾]  [에이전트 3 · 작업 중 2 ▾]  [이번 실행 변경 4개 ▾]
────────────────────────────────────────────────────────────
사용자 요청과 답변
────────────────────────────────────────────────────────────
작업 계획                 실행 A / Writer            2/7 완료 ▾
  완료      관련 코드 확인
  완료      변경 계획 작성
  진행 중   채팅 레이아웃 수정
  예정      회귀 테스트
  예정      결과 정리
  전체 7개 보기

현재: 채팅 레이아웃 수정 · 실행 경과 2분             작업 기록 ▸
[메시지 입력                                                  ]
[첨부·템플릿]                           [모델·추론 선택] [전송]
```

현재 작업의 문구가 Todo 헤더에 이미 보이면 RunActivityWidget은 동일 문구를 다시 반복하지 않고 실행 경과·기록 진입점만 제공한다. Todo가 접혀 있거나 없으면 활동 위젯에 현재 단계 요약을 표시한다. 승인 대기 같은 우선 상태는 ActionRequiredBar가 담당한다.

### 1.2 공간과 상호작용

- 상단은 한 줄의 낮은 위젯 바로 시작한다. 커다란 KPI 카드 세 개 또는 네 개의 알 수 없음 카드를 기본으로 쌓지 않는다.
- Todo와 입력창은 같은 콘텐츠 폭과 좌우 기준선을 사용한다. 단일 외곽선과 얕은 배경 단계로 묶으며 중첩 테두리·그림자를 반복하지 않는다.
- 제안 시작값: 상단 위젯 바 36–44px, Todo 행 30–36px, 펼친 Todo 본문 최대 min(16rem, 30dvh). 실제 콘텐츠·확대·키보드 조건으로 조정하며 이 숫자는 기존 제품의 검증된 상수가 아니다.
- 기본 Todo는 최대 5개 행을 읽을 수 있게 보여준다. 더 긴 계획은 완료 수와 전체 목록 진입점을 유지하고 전체 보기에서 제한된 높이의 스크롤을 제공한다.
- Todo 항목의 텍스트 줄바꿈을 허용한다. 사용자가 보고 있는 항목을 이벤트마다 정렬·삭제·자동 스크롤하지 않는다.
- 좁은 채팅 열에서는 위젯 텍스트를 축약하고 우선순위가 낮은 항목을 더보기로 옮긴다. 전체 화면 폭이 아니라 채팅 컨테이너 폭이 기준이다.
- 낮은 화면·200% 확대·가상 키보드에서는 Todo를 요약형으로 시작할 수 있지만, 키보드로 모든 계획에 접근할 수 있어야 한다. 미해결 승인·오류와 전송 컨트롤을 가리지 않는다.
- viewport 위에 임의 fixed overlay를 얹지 않는다. 기존 flex/grid 안에서 공간을 확보하고 타임라인의 실제 가용 높이를 측정한다.

### 1.3 상황별 위젯은 허용된 종류에서 결정적으로 선택

위젯 종류·표시 여부는 Corral의 검증된 이벤트와 selector가 정한다. 모델이 HTML/JSX를 생성해 실행하거나 임의 UI 명령으로 권한을 변경하는 구조가 아니다. 사용자에게 적절한 위젯이 보인다는 것은 현재 데이터와 작업 상태에 맞는 미리 정의된 표현이 활성화된다는 뜻이다.

## 2. 표현 경계

아래 파일명은 제안 이름이지 현재 존재하는 파일이라는 뜻이 아니다.

- 게이지와 분절 막대는 표시 전용이다. 고정 모델 목록, 고정 창 크기, 샘플 토큰, input/output/cache 합산으로 비율을 만들지 않는다. 기존 모델 선택 컨트롤을 대체하지 않는다. 같은 요청의 추정값으로 링·범례가 갱신되고 트리거로 상세가 열린다.
- 진행 중에도 사용자가 접을 수 있다. auto/open/closed 선호와 실행 상태를 분리하고, 완료 후 auto만 축약한다. 헤더는 공용 Button과 disclosure다. 접힌 본문은 키보드·접근성 트리에 남지 않는다. 비공개 추론 원문을 요구하지 않는다.
- 활동 표시는 Corral 토큰을 쓴다. 실행 상태에 따라 정지·진행이 바뀌고 reduced motion에서는 정적이다.
- Todo는 입력창 위의 형제 영역이다. 입력 DOM과 다음 요청 컨트롤은 유지한다. 샘플 retry, localStorage queue, 별도 전송 shortcut은 넣지 않는다.
- 좁은 폭은 채팅 컨테이너 기준이다. 스크롤 소유자는 기존 ChatView다. Todo나 헤더 높이가 바뀌어도 과거 anchor와 최신 추적을 각각 유지한다.
- 기존 Button, Popover, Dialog와 Corral의 색·타이포그래피·reduced motion을 쓴다. 새 폰트, 음원, Electron 코드, 패키지는 추가하지 않는다.

## 3. 현재 실행·오른쪽 탐색·다음 요청 분리

### 3.1 대상

| 대상 | 소유 정보 | 변경 계기 |
|---|---|---|
| presentationRunId | 상단 위젯·현재 Todo·활동 표시 | 현재 세션의 확정된 활성 Run. 없으면 마지막 실행 |
| inspectedRunId / selectedResultId | 오른쪽 패널의 조회 대상 | URL과 사용자 탐색 |
| composerDraft | 다음 본문·모드·모델·추론·첨부·시작 기준 | 사용자 입력·명시 설정 변경 |

과거 결과를 열어도 presentationRunId나 composerDraft를 바꾸지 않는다. 마지막 실행을 보여줄 때는 마지막 실행 기준임을 표시한다. 빈 세션에 과거 컨텍스트를 가져오지 않는다. 다른 세션에만 활성 실행이 있는 경우 현재 세션의 진행 위젯으로 표시하지 않는다.

새 요청 전송 클릭만으로 현재 Todo를 지우지 않는다. 새 Run 생성이 확정되면 전환하고, 생성 실패 시 초안과 마지막 계획을 보존한다. 원래 실행의 결과 카드 또는 기록에서 해당 과거 계획으로 접근할 수 있어야 한다.

### 3.2 store와 구독

현재 useCorralRun은 호출별로 createRunSession을 만든다. 위젯마다 이 훅을 부르면 구독과 읽기 상태가 늘어날 수 있다. 현재 실행은 하나의 소유 store를 공유하고, 상단 위젯·Todo·활성 RunMessage는 목적별 selector로 읽는다. SessionPage의 기존 store 소유권을 먼저 확인해 재사용한다.

과거 실행을 보는 store는 현재 실행의 open(runId)를 갈아끼우지 않는 별도 읽기 대상으로 둔다. 같은 runId를 두 영역에서 읽을 때의 재사용과 transport/프로젝트/세션 경계를 명시하고, 구독 해제는 실제 소유자가 담당한다. 전역 상태 관리 전체 교체로 확대하지 않는다.

위젯별 새 SSE·interval polling을 추가하지 않는다. 요청 기록과 WorkPlan bodyRef 변경 시에만 필요한 참조를 로딩한다. 스트리밍 토큰마다 전체 이벤트를 스캔하거나 private 본문을 다시 파싱하지 않는다.

## 4. 상단 위젯 명세

### 4.1 표시 조건

| 위젯 | 표시 조건 | 기본 내용 | 클릭 |
|---|---|---|---|
| ContextUsageChip | 현재/마지막 실행에 기록 또는 측정 상태가 있음 | 전체 요청 추정이 가능하면 약 N%; 메시지만 있으면 메시지 약 Nk | ContextInspector |
| AgentActivityChip | 다중 에이전트, 위임, 또는 사용자가 추적해야 하는 에이전트 대기 | 전체 수와 작업/대기/실패 수를 구분 | 역할별 실행 상태·계획 선택 |
| RunChangesChip | 작업 사본·변경 기준이 적용됨 | 이번 실행 변경 수와 알려진 줄 수 | 같은 실행·tree 범위의 diff |
| EnvironmentChip | 시뮬레이션, 제한/격리 상태, 확인이 필요한 실행 조건 | 시뮬레이션 등 중요한 차이 | 실제 환경 상세 |

일상적인 단일 에이전트에서 Assistant 1개·프로필 1개·모델 호출 0개·진행 없음은 별도 카드로 표시하지 않는다. 모델 연결 등록 수를 연결 정상 상태 또는 활성 에이전트 수로 표시하지 않는다.

측정이 없는 ContextUsageChip은 숫자 대신 컨텍스트 정보/측정 전 등 작은 중립 트리거로 제공할 수 있다. 실제 runtime에서 측정 가능한데 구현하지 않은 상태를 영구적인 미지원으로 분류해서는 안 된다. 로딩·미지원·오류·부분 측정은 상세에서 이유를 구별한다.

### 4.2 ContextInspector의 정보 계층

상단: 대상 실행·에이전트·모델, 전체/부분 측정 구분, 마지막 요청 시점.

본문: 사용량 / 유효 창, 분절 막대, 같은 기준으로 계산한 구성별 행.

하단: 정책에서 확인된 출력 예약·압축 임계치와 현재 compact 상태, 기존 명시적 compact 조작 또는 해당 상세로 가기.

구성별 후보 행은 아래와 같다. 실제 포함된 항목과 측정 근거가 있을 때만 수치를 제공한다.

| 범주 | 산정 대상 |
|---|---|
| Messages | 사용자·assistant·tool 결과 등 실제 포함된 대화. system 영역은 제외 |
| System prompt | 시스템 본문 중 별도 집계한 스킬·파일·서버 지시문 등을 제외한 부분 |
| System tools | 이번 요청에 포함된 내장 도구 정의 |
| MCP tools | 이번 요청에 실제 포함된 MCP 도구 정의 |
| Skills | 실제 로드되어 요청에 포함된 스킬 본문 |
| Memory / instruction files | 실제 요청에 포함된 지침·메모 파일. 파일 존재만으로 집계하지 않음 |
| MCP server instructions / agent instructions | 실제 포함된 해당 지시문. 다른 범주와 중복되지 않음 |
| Other / unclassified | 동일 산정 방식으로 측정되지만 출처가 분류되지 않은 부분 |

활성 도구 개수와 도구 호출 횟수는 다른 값으로 표시한다. deferred 목록은 현재 runtime이 실제로 지연 로딩 상태를 제공하는 경우에만 별도 행에 두며 활성 점유량에 더하지 않는다. disabled/unloaded를 임의로 deferred라고 부르지 않는다. Since last update는 전체의 일부인지 추가 추정인지 명확한 데이터가 없으면 제공하지 않는다.

### 4.3 컨텍스트 데이터 공급도 필수 구현 범위

현재 request-record.ts의 contextEstimate는 context.messages의 estimateTokens 합이고 method는 pi-1.3.0-messages다. sections에는 bytes/hash 등이 있으나 화면 예시와 같은 범주별 token 점유량을 기록하지 않는다. 이 값을 전체 요청 사용량으로 이름만 바꾸면 안 된다.

구현은 다음을 포함한다.

1. 요청 조립 지점에서 실제 messages/system sections/tool schema의 출처를 구조적으로 수집한다. 최종 payload hook 이후 포함 범위를 대조한다. 본문 키워드로 출처를 추측하지 않는다.
2. 같은 기준의 추정기를 사용해 범주별 추정량을 만든다. provider가 확인한 입력 usage는 별도 측정 기준으로 보존하고 추정 breakdown과 섞어 맞추지 않는다. 한국어·일본어·도구 JSON·첨부가 포함된 fixture에서 한계를 기록한다.
3. context usage snapshot에 최소한 runId, executionId, attemptNo, modelCallId, 기록 시점, 적용 컨텍스트 창, method, coverage, completeness, 구성별 수치/누락 이유를 결합한다. 전체인지 메시지 전용인지 타입으로 구분한다.
4. 계측 본문은 기존 private record/참조 경로를 우선 확장한다. 공개 이벤트에는 필요한 참조·집계만 둔다. 키·원문 프롬프트·메모 본문·로컬 경로를 새 public 로그로 내보내지 않는다.
5. 기존 model.request_recorded 등의 계약에 optional/versioned 필드를 추가할 필요가 있으면 CR·schema·생성 계약·replay 테스트를 함께 갱신한다. 과거 이벤트·snapshot·hash를 재작성하지 않는다.
6. 현재 두 runtime(pi-core/pi-sdk)을 연결한다. 지원하지 않는 provider payload 표현이나 미측정 이미지·도구 확장이 있으면 부분 측정으로 명시하고 전체 비율/정확한 free space를 표시하지 않는다.
7. 계측 실패는 미측정/오류로 전달한다. 위젯 때문에 추가 LLM 호출을 만들거나 permit·기존 검증을 건너뛰지 않는다. 기존 보호·권한 검증 실패와 계측 실패를 혼동하지 않는다.

### 4.4 수치 불변식

- usedTokens는 동일 요청·같은 측정 기준에서 서로 겹치지 않는 범주를 합한 값이어야 한다.
- 대화 안에 이미 들어 있는 스킬·지침을 system prompt 전체와 다시 합산하지 않는다.
- 누적 usage나 여러 모델 호출의 토큰 합을 단일 컨텍스트 점유량으로 쓰지 않는다.
- input/output/cache 토큰을 무조건 합산하지 않는다.
- 출력 예약은 점유한 입력과 분리해 표시한다. 예약의 정의·적용 범위가 확인되지 않으면 free space 계산에서 빼지 않는다.
- 전체 범위가 추정 가능하고 유효 창이 알려졌을 때만 약 N%와 추정 잔여 공간을 표시한다. 막대 렌더는 범위를 제한하되 수치 초과 자체를 숨기지 않는다.
- context window는 해당 Run/호출의 고정 snapshot에 따른다. 다음 요청의 모델 선택을 바꿔 과거 요청 분모를 바꾸지 않는다.
- compact 성공 receipt만으로 사용량 감소를 그리지 않는다. 새 snapshot 전까지 이전 요청 기준·갱신 대기임을 표시한다.
- Ultra는 execution별 분모가 다르므로 가상 합산 창을 만들지 않는다. 선택한 대상 또는 가장 높은 알려진 비율을 표시할 때 대상·미측정 수를 함께 밝힌다.

### 4.5 변경사항

RunChanges와 기존 비교 범위를 재사용한다. 실행 중에는 잠정 값, 종료 후에는 해당 Run의 고정 tree 기준임을 구별한다. 기준 없음·조회 실패·미집계·바이너리를 0개 변경으로 처리하지 않는다. 위젯 조회 자체가 snapshot 생성이나 파일 수정을 일으키면 안 된다. diff를 열 때 run/scope/from/to를 보존한다.

## 5. ComposerWorkPlan: 실제 진행되는 Todo

### 5.1 새 Todo 저장 엔진은 만들지 않음

기존 update_plan → Coordinator → projection.workPlans → private bodyRef → WorkPlan 파싱 경로를 재사용한다. 현재 WorkPlan 상태는 pending/in_progress/completed이며 항목 수는 1–20개, 계획 하나의 in_progress는 최대 하나다.

WorkPlanPanel의 본문 로딩·검증을 공용 useWorkPlanSnapshot/selector로 추출하고 새 Dock과 전체 상세가 동일 결과를 사용하게 한다. UI가 임의로 완료 상태를 저장하지 않는다.

### 5.2 시각 상태

| 데이터 상태 | 표현 |
|---|---|
| pending | 점선 원 또는 비활성 원 + 예정이라는 접근 가능한 상태 이름 |
| in_progress | 진행 원/작은 활동 표시 + 강조된 현재 항목 |
| completed | 체크가 있는 원 + 낮은 대비의 완료 항목 |
| 실행 실패/취소/승인 대기 | 계획 항목 enum을 바꾸지 않고 실행 상태를 별도 배너로 표시 |

체크 표시는 읽기 전용이다. 클릭 가능한 checkbox로 완료시킬 수 있게 하지 않는다. 리스트는 안정적인 item.id로 갱신하고 항목의 완료만 바뀌면 해당 행과 카운트만 바뀐다.

2/7은 계획 항목 완료 수이며 전체 실행 시간의 28.6%라는 뜻이 아니다. 남은 시간을 추정하지 않는다. 새 계획에서 항목 수가 늘어 완료 비율이 내려가는 것은 정상이며 가짜 단조 증가를 만들지 않는다.

### 5.3 상태 전환 계약

| 상태/사건 | 동작 |
|---|---|
| 간단한 요청, 계획 없음 | Todo를 표시하지 않음. 일반 실행 상태는 활동 위젯에서 확인 |
| 계획 참조 도착, 본문 로딩 | Todo 슬롯에 로딩 상태 표시 |
| 유효한 계획 최초 수신 | 실행 중 auto 모드에서 기본 펼침 |
| revision 갱신 | 현재 항목·완료 수 갱신. 수동 펼침 선택 유지 |
| 유효 본문이 늦게 도착 | 최신 참조와 맞는 본문만 적용. 이전 본문은 명시적으로 이전 revision 표시 |
| 모든 계획 완료, Run 진행 중 | 계획 N/N · 실행 중 |
| Run 성공, 계획 일부 예정 | 실제 완료 수를 보존하고 실행 종료와 미완료 항목을 구분 |
| 성공 종료 | auto만 요약형으로 축소. 수동 open은 유지 |
| 실패/취소/입력 대기 | 실행 상태 노출, 마지막 실제 계획과 부분 결과 접근 보존 |
| 오래된 criteria/attempt | 이전 기준임을 표시하고 현재 유효한 검증으로 취급하지 않음 |
| 새 Run 생성 확정 | 새 대상 계획으로 전환. 입력 DOM은 유지, 이전 계획은 기록에 보존 |

선호 키는 session/run/scope/owner/attempt 단위로 구성하고 auto/open/closed를 분리한다. 같은 계획의 revision이 바뀌었다고 초기화하지 않는다. 탭을 다시 열었을 때도 사용자 선택을 같은 정책으로 복원한다.

### 5.4 계획 발행 경로: 위젯만 만들고 끝내지 않음

현재 autoDefinition은 각 역할의 allowedCollaborationTools에 update_plan을 이미 추가한다. 이 권한을 활용하되 기존 사용자 저장 역할을 자동 수정하지 않는다.

- 여러 단계의 구현·조사·검증 작업에서는 해당 실행의 첫 실질 작업 전과 의미 있는 단계 전환 시 기존 update_plan을 사용하도록 공개 작업 규약을 보완한다.
- 필요할 때만 계획을 만든다. 모든 인사·짧은 질문에 같은 3단계 계획을 강제하지 않는다.
- UI에서 자연어 체크박스를 파싱하거나 도구 호출 횟수·시간 지연으로 항목을 체크하지 않는다.
- 테스트용 script는 실제 host.invokeTool(update_plan) 경로로 revision을 만들고 Coordinator 이벤트를 UI가 받아야 한다. setState로 가짜 진행을 주입한 Storybook만으로 완료하지 않는다.
- 실제 LLM의 계획 발행 여부는 별도 opt-in·기존 한도 내 smoke로 확인한다. 일반 CI는 결정적 fixture를 사용한다. 실제 LLM이 계획을 발행하지 않은 경우 UI에 가짜 계획을 생성하지 않는다.
- 검증 필수 항목은 기존 Coordinator의 run_check immutable evidence 검증을 따른다. artifact 존재·model 완료·submit_result 성공으로 대체하지 않는다.

### 5.5 Ultra와 팀 계획의 정적 소유자 문제

이번 수정에서는 **팀 계획이 존재한다는 이유만으로 항상 팀 계획을 우선하지 않는다.** 현재 팀 계획은 planOwnerRoleId와 첫 소유 execution에 묶인다. 그 planner가 종료한 뒤 worker가 수행하는 단계가 팀 체크리스트에 자동 반영된다고 가정하면 화면이 정적으로 남을 수 있다.

- 기본은 현재 작업을 수행하는 execution의 유효 계획을 보여준다. 단일 실행에서는 선택기 없이 표시한다.
- 복수 실행에서는 역할별 선택기를 제공한다. auto-follow는 정해진 기준으로 선택하고, 이벤트가 가장 최근에 왔다는 이유로 역할을 계속 바꾸지 않는다.
- 사용자가 역할을 선택하면 종료·재시도에도 대상과 상태를 분명히 보여주며 수동 선택을 조용히 바꾸지 않는다. auto-follow 복귀는 별도 조작이다.
- 팀 범위 계획은 선택 가능한 상위 계획으로 제공한다. 소유자가 종료했다면 마지막 팀 계획임을 표시한다. 실행별 완료 수와 더하지 않는다.
- 라이브 팀 계획을 기본으로 승격하려면 해당 소유자의 실제 갱신 수명주기가 검증되어야 한다. writer가 planner 대신 팀 계획을 갱신하도록 권한을 우회하거나 UI에서 task 완료를 끼워 넣지 않는다.
- 팀 생성용 TeamPlan과 작업 checklist WorkPlan, 도메인 TaskBoard는 구별한다.

## 6. 실행 활동과 대응 영역

### 6.1 RunActivityWidget

현재 실행의 진행 상태는 입력창 근처의 단일 활동 위젯이 담당한다. 계획이 없을 때도 작동한다. 표시 우선순위는 사용자 응답 필요 → 실패/불명확 효과 → 현재 도구/계획 단계 → 실행 중 일반 상태다. 정확한 단계가 없으면 작업 중이라고 표시하며 검증 중 등 구체적 단계를 추측하지 않는다.

실행 경과는 기록된 시작·종료 시각에 근거한다. 단계 시작 시각을 알 수 없으면 전체 경과를 단계 경과로 표시하지 않는다. 종료 후에는 경과가 계속 증가하지 않는다.

현재 실행의 RunMessage에는 같은 진행 도구 목록을 다시 펼치지 않고 활동 위젯 또는 같은 기록의 진입점을 연결한다. 실행이 끝나면 해당 Run의 카드 아래에 접힌 작업 기록이 남는다. 기록 상세의 기본 호스트는 하나이며, 다른 위치는 같은 대상에 대한 진입점이다.

### 6.2 도구와 모델 원문

도구 라이프사이클은 toolCallId 기준 한 행을 갱신한다. 동일 도구 이름이라도 별개 실행·재시도·별도 호출은 병합하지 않는다. blocked/failed/cancelled/unknown은 정상 완료와 구분한다.

ExecutionTranscript의 원문은 모델 호출 N · 응답 원문으로 기본 접힘 처리하는 compact 표시 모드를 제공한다. 전체 실행 페이지의 상세 접근은 유지한다. 문자열 같음을 근거로 감사 기록을 삭제하지 않는다.

### 6.3 ActionRequiredBar

승인·질문·실패·복구 필요·불명확 파일 효과는 일상적인 실행 정보 disclosure와 분리한다. 대기 수와 의미 있는 질문/오류 요약 및 기존 대응 UI를 여는 동작을 제공한다. 미해결 항목은 사용자가 다른 결과를 보고 있어도 발견 가능해야 한다.

기존 ApprovalPanel/InteractionPanel의 명령·receipt 경로를 재사용한다. 동일 승인에 두 독립 제출 컨트롤을 만들지 않는다. 활성 실행의 대응과 오른쪽에서 살펴보는 다른 실행의 대응은 scope를 명시한다. 성공 receipt 이전에 대기가 사라지면 안 된다. 닫기/Escape는 거절·취소·재개가 아니다.

단순히 run.status가 failed/cancelled라는 이유로 모든 진단을 강제 펼치지 않는다. 미해결·대응 필요 정보를 노출하고, 전체 기록은 선택적으로 확인하게 한다.

## 7. 오른쪽 패널·결과·설정·데모 정리

### 7.1 CompactRunWorkspace는 후속 정리

선택 결과가 있는 경우 패널은 compact 헤더 → 필요한 대응 영역 → ResultReader/ArtifactViewer → 접힌 실행 상세 순서로 둔다. 선택 대상·버전·실행 식별자는 남기고 일상 종료 요약은 전체 페이지에서 확인한다.

선택 결과가 없으면 사용 가능한 결과 목록 또는 실제 pending/partial/none 상태를 먼저 보여준다. 존재하지 않는 explicit result ID를 최신 결과로 조용히 대체하지 않는다. URL 직접 진입·뒤로 가기·전체 실행 상세 이동 시 대상 파라미터를 보존한다.

RunStatusCards의 데이터 로딩은 위젯 selector와 공유하고, 상세 내용은 재사용한다. 이름만 바꾼 기존 네 개 details를 상단에 통째로 옮기지 않는다.

### 7.2 결과와 상태

현재 Output 기반 final/partial 결과 판정을 유지한다. 마지막 모델 응답을 자동 최종 답변으로 승격하지 않는다. 결과 본문이 늦게 로딩되면 실행 종료와 로딩 상태를 함께 보여주며 실패 시 같은 대상 재시도를 제공한다.

같은 패널 헤더가 실행 상태를 이미 설명할 때 embedded ResultReader의 실행: 성공 반복을 제거한다. standalone 결과는 필요한 실행 맥락을 유지한다. 검토·제출·파일 반영 상태는 별개의 의미로 남기되 기본 화면에 무조건 상태 목록을 늘어놓지 않는다.

채팅과 사용자가 명시적으로 연 결과 패널이 같은 본문을 보여주는 것은 허용한다. 패널을 열었다고 채팅 본문을 자동 접거나 위치를 바꾸지 않는다.

### 7.3 과거 설정과 다음 설정

EntryCard의 당시 설정은 실행 snapshot 기반 접힌 실행 설정으로 제공한다. 입력창의 선택은 다음 요청을 뜻한다. 상단 위젯에서 실제 실행 모델을 확인할 수 있지만 그곳에서 다음 요청 모델을 편집하지 않는다. 시뮬레이션·시작 버전·파일 작업 범위 같은 중요한 차이는 다음 요청 근처에 남긴다.

### 7.4 데모

새 demo reply는 진단과 입력 전체를 결과에 이어 붙이지 않는다. 이전 버전 본문은 필요한 입력으로 보존하되 결과에 통째로 재귀 인용하지 않는다. 기존 testkit defaultReply의 전달 관찰 시험은 보존하고 데모 reply/appendNotes/script 옵션으로 분리한다.

데모에서 계획 생성·진행·완료를 보여주는 전용 결정적 시나리오를 제공한다. 컨텍스트 수치 fixture를 사용할 때는 시뮬레이션임을 표시하며 실제 모델의 측정값으로 주장하지 않는다. 실제 요청을 수행하지 않은 데모가 파일을 검증·배포했다고 답하지 않게 한다.

SafeMarkdown에 role prompt 등 문자열 삭제 정규식을 넣지 않는다. 과거 산출물·private 원문·snapshot·hash를 조용히 다시 쓰지 않는다.

## 8. 비동기·입력·접근성·성능

- WorkPlan은 run 문맥, scope, executionId, attemptNo, revision, criteriaVersionId, bodyRef/hash의 현재 참조와 일치해야 표시한다. 이전 revision의 늦은 응답·다른 Run 오류가 현재 화면을 덮지 않는다.
- 컨텍스트 snapshot도 modelCallId/attempt와 측정 기준을 고정한다. 같은 모델을 썼다는 이유로 다른 execution 수치를 가져오지 않는다.
- 화면 전환 시 이전 로딩의 성공·실패 모두 stale 결과로 배제한다. 재시도는 선택 대상에 묶는다.
- 기존 ChatView의 session anchor/offset과 40개 초과 가상화를 유지한다. 새 scroll hook을 나란히 설치하지 않는다.
- 타임라인 콘텐츠뿐 아니라 위젯·Todo·입력창의 높이와 실제 viewport 변화를 감지한다. 과거를 읽는 중에는 entryId+offset을 유지하고, 최신 추적 중에는 끝 위치를 유지한다.
- Todo 갱신·팝오버 열기·세션 상태 갱신으로 입력 DOM을 재마운트하지 않는다. 초안·커서·선택·한국어/일본어 IME와 기존 Enter/Shift+Enter 규칙을 보존한다.
- 원형 상태는 색 외에도 아이콘 형태·상태 이름을 가진다. 읽기 전용 Todo는 조작 가능한 체크박스로 위장하지 않는다.
- disclosure와 Popover는 버튼, aria-expanded, 제어 영역 연결, Escape, 포커스 복귀를 제공한다. 접힌 본문은 포커스 경로에서 제외한다.
- 한 개의 조용한 live region에서 완료 수·사용자 대응 필요 같은 의미 있는 변화만 알린다. 토큰·경과 시간 tick마다 읽지 않는다.
- 경고/실패를 색만으로 구별하지 않는다. reduced motion에서는 점·링·접힘 모션을 제거하거나 최소화한다.
- 요청별 측정은 한 번 캐시하고 여러 위젯에서 전체 payload를 반복 순회하지 않는다. 대규모 토큰화로 UI thread를 막지 않는다. 필요한 작업이 커질 경우 기존 worker 구조를 우선 사용한다.
- 위젯 열기/닫기는 네트워크 탐색·조회 외에 도메인 command를 발행하지 않는다. compact/Reins/승인/취소는 기존 정확한 대상·attempt·revision 검사와 공유 예산에 남긴다.

## 9. 변경 대상 지도

경로가 현재 존재하는지와 신규인지 구별한다. 동일 역할의 기존 파일이 이미 생겼으면 이름을 복제하지 말고 인수 기준에 맞게 확장한다.

| 대상 | 구분 | 역할 |
|---|---|---|
| apps/studio/src/pages/SessionPage.tsx | 기존 | presentation 대상과 실제 상단/컴포저 슬롯 연결 |
| apps/studio/src/workbench/ChatView.tsx | 기존 | 위젯/하단 높이와 타임라인 viewport·anchor 처리 |
| apps/studio/src/workbench/ComposerSurface.tsx | 기존 | 기존 Host/ContextStrip 보존, 상단 Dock 연결 |
| apps/studio/src/workbench/useCorralChat.ts | 기존 | 현재 실행 store 공유·과거 조회 분리 |
| packages/react/src/components/WorkPlanPanel.tsx | 기존 | 공통 검증/로딩 재사용, 과거 상세 유지 |
| packages/contracts/src/work-plan.ts | 기존 | 상태·소유자·revision 계약 유지 |
| packages/core/src/auto-team.ts | 기존 | 기존 update_plan 권한·기본 팀 정의 확인 |
| packages/adapter-pi/src/worker-tools.ts 등 실제 prompt 조립 경로 | 기존 | 권한 내 계획 갱신 규약 및 출처 정보 |
| packages/adapter-pi/src/request-record.ts | 기존 | contextEstimate 범위 구분·구성별 측정 연결 |
| packages/adapter-pi/src/worker.ts, sdk-worker.ts | 기존 | 두 runtime의 요청 측정 지점 연결 |
| packages/contracts/src의 요청 기록 schema, 이벤트·projection·replay 경로 | 기존 확장 | additive/versioned context snapshot 참조 |
| SessionWidgetBar.tsx, ContextUsageChip.tsx, ContextInspector.tsx | 신규 제안 | 상단 위젯과 상세 |
| ComposerDock.tsx, ComposerWorkPlan.tsx | 신규 제안 | 실제 입력창 위 작업 계획 |
| RunActivityWidget.tsx, ActionRequiredBar.tsx | 신규 제안 | 단일 활동 표시와 중요한 대응 |
| QuietActivityIndicator.tsx, WorkPlanDisclosure.tsx | 신규 제안 또는 공용화 | 활동 표시와 계획 접힘 |
| useWorkPlanSnapshot.ts, contextUsage.ts, widgetVisibility.ts | 신규 제안 | 조회·검증·표시용 순수 selector |
| apps/studio/src/workbench/RunMessage.tsx | 기존 | 독립 완료 도구 목록 제거·기록 진입점 연결 |
| packages/react/src/components/ExecutionTranscript.tsx | 기존 | compact 원문 기본 접힘, 기록 보존 |
| apps/studio/src/pages/RunPage.tsx | 기존 | CompactRunWorkspace 결과 우선 및 핵심 대응 보존 |
| packages/react/src/components/RunResults.tsx | 기존 | embedded/standalone 실행 맥락 분리 |
| apps/studio/src/demo/script.ts 및 데모 adapter 설정 | 기존 | 진단 출력 분리·실제 도구 경로 fixture |

## 10. 구현 순서: 기능을 먼저 화면에 납품

| 단계 | 작업 | 눈으로 확인할 산출물 | 단계 완료 조건 |
|---|---|---|---|
| M0 | 짧은 CR, 현재 재현 및 실패 fixture | 목표 슬롯과 상태별 기대 화면을 기록한 기준 문서 | 요구 누락을 검출하는 테스트가 먼저 실패. 기존 테스트 삭제/완화 금지 |
| M1 | SessionPage/ChatView/ComposerDock 슬롯과 공유 대상 연결 | 실제 세션 화면의 상단 위젯 슬롯·입력창 위 계획 영역 | 과거 패널 탐색 독립, 입력 DOM 유지, 추가 중복 구독 없음 |
| M2 | WorkPlan 로딩·아이콘·접힘·계획 발행의 end-to-end 연결 | 실제 Coordinator 경로로 0/7 → 1/7 → 2/7 → 종료가 갱신되는 Todo | 새로고침/패널 열기 없이 단계 갱신. 단순 요청은 계획 없음. team 정적 소유자 반례 확인 |
| M3 | 컨텍스트 계측·참조와 게이지/분절 표현 적용 | 실제 요청 기록 기반 링·범례·상세 팝오버 | 전체/부분/미측정 구분, tool schema 포함 여부 명시, 두 runtime 검사 |
| M4 | 상황별 Agent/Changes/Environment 위젯과 단일 활동·대응 연결 | 실행 상태에 따라 필요한 위젯만 보이고 승인 대응이 노출됨 | 기존 성공 도구 목록과 중복 없음, 중요한 대기/오류를 접을 수 없음 |
| M5 | 선택 결과 우선 패널·원문·상태·설정·데모 정리 | 채팅은 요청과 결과 중심, 패널은 선택 산출물 중심 | 기존 결과·제어·시작 기준·검증·파일 탭 회귀 통과 |
| M6 | 반응형·스크롤·IME·접근성·성능·종합 증거 | 실제 브라우저 상태별 캡처와 전환 기록 | 아래 필수 인수 기준 및 검사 수행 상태 기록 |

M1/M2의 실제 기능이 나오기 전에 패널 접기만 구현해 전체 완료를 선언하지 않는다. M2와 M3는 첫 릴리스의 필수 단계다. mock 시각 구현만 끝난 상태와 실제 데이터 연결 완료를 별도로 기록한다. 실제 provider 지원이 제한된 부분은 지원 범위와 미검증 범위를 명시하되 구현 가능한 두 runtime 계측을 선택 작업으로 미루지 않는다.

기능별 UI 확인은 해당 단계에서 바로 수행한다. M6까지 잘못된 위젯 위치를 방치하지 않는다. 다중 provider의 유료 live 검사는 자동 승인되지 않으며 기존 opt-in과 비용 한도를 따른다.

## 11. 필수 인수 테스트

ID는 계획용 임시 식별자이며 저장소 카탈로그 등록 시 충돌을 확인한다. 문자열 스냅샷만이 아니라 표시 위치·소유 대상·실제 이벤트·수동 선택 보존을 검증한다.

| ID | 시나리오 | 통과 기준 |
|---|---|---|
| SURFACE-01 | 보조 패널을 닫은 채 다단계 실행 | 상단 위젯과 입력창 바로 위 Todo가 접근 가능하며 갱신됨 |
| SURFACE-02 | 채팅 열이 좁아짐 | 컨테이너 기준 축약, 가로 overflow 없음, 전체 정보 접근 유지 |
| PLAN-01 | 실제 update_plan 발행 | Coordinator 이벤트·bodyRef를 거쳐 화면에 목록 생성 |
| PLAN-02 | 동일 항목 in_progress→completed와 다음 항목 시작 | 상태 원·제목·완료 수가 새로고침 없이 갱신 |
| PLAN-03 | revision 3 뒤 revision 2 본문 지연 도착 | 이전 계획으로 되돌아가지 않음 |
| PLAN-04 | 새 Run/attempt/세션 전환 중 로딩 | 이전 성공·오류 응답이 새 대상으로 섞이지 않음 |
| PLAN-05 | 모든 항목 완료, Run 진행 중 | 실행 성공으로 오표시하지 않음 |
| PLAN-06 | Run 성공 또는 취소, 항목 일부 미완료 | 실제 항목 상태·완료 수 보존 |
| PLAN-07 | 사용자가 접기 또는 펼치기 후 이벤트·종료 | 수동 선택 유지, auto만 종료 시 축약 |
| PLAN-08 | 검증 필수 항목의 stale/다른 실행 근거 | 기존 Coordinator가 거절하고 UI 우회 완료 없음 |
| PLAN-09 | team planner 종료 후 worker 실행 | 정적 팀 계획을 라이브 진행으로 오인시키지 않으며 execution 계획 접근 유지 |
| PLAN-10 | 여러 에이전트 계획 및 수동 역할 선택 | 팀/하위 이중 합산·last-event 역할 튐 없음 |
| PLAN-11 | 계획 없음/부분 로딩/잘못된 bodyRef/hash/criteria | 숨김·로딩·오류·이전 기준 구분 |
| CTX-01 | messages-only 과거 request record | 전체 점유율 아닌 메시지 추정으로 표시 |
| CTX-02 | 시스템·스킬·메모·내장/MCP tool schema 포함 | 실제 포함 범주만 단일 집계하고 같은 기준의 합계 사용 |
| CTX-03 | provider input usage와 cache usage가 함께 존재 | input/output/cache 무조건 합산·과거 누적 합산 없음 |
| CTX-04 | unsupported payload 또는 미측정 이미지 | 부분 측정 명시, 가짜 전체 비율/free space 없음 |
| CTX-05 | 압축 완료 후 새 측정 전 | 이전 요청 기준 및 갱신 대기 유지 |
| CTX-06 | Ultra 모델별 context window 차이 | execution별 분모 유지, 가상 총용량 없음 |
| CTX-07 | 모델 선택 변경 중 과거 실행 검사 | 과거 기록 분모·사용량 불변 |
| ACTION-01 | 승인/ask_user 대기, 실행 정보 disclosure 닫힘 | 대응 필요 정보와 기존 응답 경로가 계속 접근 가능 |
| ACTION-02 | 질문/승인 응답 중 stale schema/revision 및 취소 경쟁 | 기존 receipt 경계 유지, 임의 재개·대기 소실 없음 |
| TOOL-01 | 같은 toolCallId 이벤트 재전송 | 한 호출의 행만 갱신. 새 retry ID는 별개로 유지 |
| TOOL-02 | unknown/cancelled effect | 완료 아이콘으로 대체하지 않음 |
| RESULT-01 | 결과 선택 URL 직접 진입·뒤로/앞으로 | 해당 run/result 보존, 잘못된 ID를 최신으로 대체하지 않음 |
| RESULT-02 | 현재 Run 활동 중 과거 결과 패널 열기 | 위젯·Todo·초안 대상은 현재 Run과 독립 유지 |
| RESULT-03 | 최종 결과/부분 결과/결과 없음/복수 결과 | 기존 Output·submit 의미 유지, 마지막 원문 임의 승격 없음 |
| RESULT-04 | Run 종료가 결과 본문보다 빠름 | 로딩·재시도 표시, 빈 답변 또는 이중 최종 출력 없음 |
| RESULT-05 | 패널 내 compact/Reins/MessageBranch | 실제 조작 대상·attempt·revision·복귀 URL 보존 |
| DEMO-01 | 이전 결과에서 두 번째 데모 실행 | 결과에 역할 프롬프트·입력 전체 재귀 중첩 없음, 이전 버전 입력은 유지 |
| INPUT-01 | Todo 갱신 중 한국어/일본어 IME | 조합·커서·초안 유지, Enter 오전송 및 Escape 오취소 없음 |
| SCROLL-01 | 최신 추적 중 Todo와 위젯 높이 변경 | 끝 위치와 새 결과 접근 유지 |
| SCROLL-02 | 과거 읽기 중 같은 높이 변경 | entry anchor/offset 보존, 하단으로 끌어내리지 않음 |
| SCROLL-03 | 40개 이하·초과 요청, 포커스 행 | 가상화·행 측정·포커스 보존 |
| A11Y-01 | 키보드·스크린리더·reduced motion | 올바른 상태 이름, 단일 중요 알림, focus 복귀, 접힌 내용 제외 |
| PERF-01 | 실제 활성 실행 구독/조회 수 비교 | 위젯별 추가 SSE·주기 polling 없음, bodyRef당 조회 재사용 |
| REPLAY-01 | 과거 이벤트/snapshot과 새 context 필드 | optional/version 호환, 기존 hash/내용 불변 |

### 11.1 시각 증거

각 캡처/전환 기록에는 빌드 SHA, fixture 또는 live 구분, 컨테이너 크기, 상태, 확인한 인수 ID를 기록한다.

필수 상태는 (1) 단일 다단계 실행의 Todo 펼침, (2) 항목 전환 직전/직후, (3) 컨텍스트 상세와 구성별 범례, (4) 성공 후 요약형, (5) 승인 대기 또는 실패, (6) 다중 에이전트 선택, (7) 좁은 채팅 열이다. M2의 짧은 전환 기록으로 새로고침 없이 목록이 바뀌는 것을 확인한다.

실제 사용자 프롬프트·경로·키 대신 결정적 fixture를 사용한다. 실행하지 않은 브라우저·OS·유료 provider 검사를 통과로 표시하지 않는다. 스크린샷은 보이는 배치의 증거이고 프로토콜 안전성 검증은 자동 시험으로 별도 확보한다.

## 12. 비목표와 변경 경계

이번 플랜은 UI 표시와 필요한 읽기용 컨텍스트 계측, 기존 권한 안에서의 계획 발행 규약을 포함한다. 예산 자동 증가, 키 자동 수집, 연결 권한 확대, 자동 compact 정책 변경, 자동 병합·배포·원본 반영, Todo 클릭 완료, 새 에이전트 실행 엔진은 포함하지 않는다.

공용 컴포넌트의 재사용을 우선하고 패키지 전체 교체·추가 스크롤 엔진·새 Todo DB를 만들지 않는다. 원본 프롬프트/산출물 필터링으로 중복을 숨기지 않는다. 도메인 결과·검토·제출·실제 파일 반영을 한 성공 상태로 합치지 않는다.

## 13. 구현 에이전트 전달용 요약

> 목표는 CompactRunWorkspace의 접힘 정리가 아니다. 채팅 상단 SessionWidgetBar와 입력창 바로 위 ComposerWorkPlan을 실제 SessionPage에 연결한다. 게이지, 분절 막대, 활동 표시, disclosure는 Corral 토큰과 공용 컨트롤을 쓴다. 기존 update_plan/WorkPlan 이벤트로 Todo가 갱신되어야 하며, messages-only contextEstimate를 전체 컨텍스트로 오표시하지 않도록 요청 계측도 연결한다. 패널 정리는 이 기능들의 후속 단계다. 상단 위젯과 Todo가 보조 패널을 닫아도 작동하고 실제 이벤트로 갱신되는 브라우저 증거가 없으면 전체 완료로 보고하지 않는다. 현재 실행·과거 패널 탐색·다음 요청 설정, 승인/Reins/compact의 대상과 receipt 경계는 보존한다. 임의 범위 축소가 필요하면 구현 전에 누락 항목을 명시하고 승인을 받는다.

## 14. 고정 소스와 근거

아래 링크는 Corral 기준선의 파일 단위 참조다. 구현 자체의 검증 완료를 의미하지 않는다.

### Corral

- [RunPage — CompactRunWorkspace 현재 배치](https://github.com/fromiron/corral/blob/e160c6411955193bd92e44f3088a0dce07cc5f0c/apps/studio/src/pages/RunPage.tsx)
- [RunStatusCards — 환경/컨텍스트/연결/변경 상세](https://github.com/fromiron/corral/blob/e160c6411955193bd92e44f3088a0dce07cc5f0c/apps/studio/src/workbench/RunStatusCards.tsx)
- [ChatView — header/composer 슬롯, 위치 보존, 가상화](https://github.com/fromiron/corral/blob/e160c6411955193bd92e44f3088a0dce07cc5f0c/apps/studio/src/workbench/ChatView.tsx)
- [ComposerSurface — Host와 ContextStrip](https://github.com/fromiron/corral/blob/e160c6411955193bd92e44f3088a0dce07cc5f0c/apps/studio/src/workbench/ComposerSurface.tsx)
- [useCorralChat — 호출별 store 생성](https://github.com/fromiron/corral/blob/e160c6411955193bd92e44f3088a0dce07cc5f0c/apps/studio/src/workbench/useCorralChat.ts)
- [WorkPlanPanel — private 참조와 파싱/검증](https://github.com/fromiron/corral/blob/e160c6411955193bd92e44f3088a0dce07cc5f0c/packages/react/src/components/WorkPlanPanel.tsx)
- [WorkPlan schema — 상태/범위/revision/항목 제약](https://github.com/fromiron/corral/blob/e160c6411955193bd92e44f3088a0dce07cc5f0c/packages/contracts/src/work-plan.ts)
- [CR-028 — 소유자, verification evidence, 계획과 Run 완료 분리](https://github.com/fromiron/corral/blob/e160c6411955193bd92e44f3088a0dce07cc5f0c/docs/change-requests/CR-028-user-interactions-and-plans.md)
- [Auto 팀 정의 — update_plan 권한과 planOwnerRoleId](https://github.com/fromiron/corral/blob/e160c6411955193bd92e44f3088a0dce07cc5f0c/packages/core/src/auto-team.ts)
- [request-record — 메시지 기준 추정과 sections 기록](https://github.com/fromiron/corral/blob/e160c6411955193bd92e44f3088a0dce07cc5f0c/packages/adapter-pi/src/request-record.ts)

### 기존 대화에서 제공된 자료

- 사용자가 제공한 두 번의 성공 실행·동일 산출물·원문·도구 목록 중복 재현 기록.
- 사용자가 첨부한 Context 상세 및 입력창 부근 Todo 화면.
- 사용자가 붙여 넣은 다른 에이전트의 CompactRunWorkspace 개선 제안.
- 이전 플랜 Corral-Chat-View-Improvement-Plan.md. v2는 위젯/계획의 납품 의무, 실제 계측, 팀 계획의 정적 소유자 반례를 강화한다.
