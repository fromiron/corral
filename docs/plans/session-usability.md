# 세션 사용성 개선: 작업 계획

실제 모델로 세션을 쓰면서 나온 16가지 문제를 고친다. 단계 A는 지금 명세 안에서 고치거나 요청받은 표시를 더하는 일이고, 단계 B는 명세의 경계나 비목표를 바꾸므로 방향이 정해진 뒤에 시작한다.

명세: [Workbench](../specs/workbench.md), [채팅 위젯](../specs/chat-widgets-contract.md), [LLM 런타임](../specs/llm-runtime.md), [모델·추론·리소스](../specs/models-and-resources.md), [추론 판정](../specs/features/effort-routing.md), [로컬 AI](../specs/features/local-intelligence.md), [판정 API](../specs/features/decision-apis.md), [실행과 안전](../specs/execution-and-safety.md), [Desktop 계약](../specs/desktop-contract.md), [API 계약](../specs/api-contract.md), [모델 안내](../guides/models.md).

브랜치는 `develop`에서 분기하고, 단계마다 PR을 따로 낸다. 각 항목은 명세 → 실패하는 테스트 → 구현 순서로 하고, `pnpm lint`, `pnpm typecheck`, 관련 테스트를 돌린다. 계약 타입을 바꾸면 `pnpm contracts:check`도 돌린다.

| 단계 | 내용 | 상태 |
|---|---|---|
| A1 | 대화가 끝을 따라가지 않음 | 시작 전 |
| A2 | 사이드바 가이드 선이 마지막 세션에 닿지 않음 | 시작 전 |
| A3 | 실행 중 수동 압축: `/compact`, 버튼, 일반 대화에서 막힌 버튼 | 시작 전 |
| A4 | 컨텍스트 점유율을 입력창 한 줄 상태에 표시 | 시작 전 |
| A5 | 적용된 추론 수준을 요청 줄에서 바로 확인 | 시작 전 |
| A6 | 판정 모델 설치 안내와 크기, 로컬 모델 제거 | 시작 전 |
| A7 | 모델 요청 이력: 열 때 불러오기, 차트 | 시작 전 |
| A8 | 이미지 프로필: ID 자동 생성, 역할에서 목록으로 선택 | 완료 |
| A9 | 회의 참가자: 역할 라벨, `@호칭`, 선택기에 호칭 전달 | 시작 전 |
| B1 | 연결 폴더에서 에이전트가 직접 읽고 쓴다 | 진행 중 |
| B2 | 어떤 세션이든 삭제 | 진행 중 |
| B3 | 세션 단위 압축 | A3 다음 |
| B4 | 판정 모델 GPU(Vulkan, CUDA), 회의 분석 엔진 장치 선택 | A6 다음 |
| B5 | 판정 API 종류 | 지금 둘로 유지 |

A1–A9는 단계마다 별도 worktree에서 작업하고 단계마다 PR을 낸다. A5에는 "요청별을 요청마다 판정하도록 고친다"가 더해진다(아래 A5).

## 단계 A

### A1. 대화가 끝을 따라가지 않음

[Workbench](../specs/workbench.md)의 대화 추적 문단은 본문이 늘어나는 동안 끝을 유지하라고 한다. 코드는 `apps/studio/src/workbench/ChatView.tsx` 한 곳이 맡는다.

- `readPosition`(235–257행)은 `scrollTop`이 자기가 마지막에 둔 값보다 작으면 사람이 올라간 것으로 보고 추적을 끈다. 가상 목록의 재측정(항목 40개 초과), 브라우저 스크롤 앵커, 행 높이가 재어지기 전의 스크롤 이벤트도 같은 조건을 만든다.
- `onWheel`은 방향과 상관없이 추적을 끈다.
- 전송 직후 스트리밍과 도구 행이 붙는 동안 끝을 유지하는지 보는 테스트가 없다. 어느 이벤트가 추적을 끄는지는 아직 재현하지 못했다.

할 일: 먼저 `ChatView.test.tsx`에 전송 → 새 턴 → 도구 행·스트리밍 증가를 재현하는 실패 테스트를 만든다. 추적은 사람의 입력(위로 가는 휠·키·터치·스크롤바 끌기)으로만 끄고, 메시지를 보내면 다시 켠다. "보내면 추적을 다시 시작한다"는 명세에 없으므로 그 문단에 더한다. 실제 화면에서 긴 도구 실행으로 확인한다.

### A2. 사이드바 가이드 선

가이드는 `packages/react/src/design-kit/components/ui/sidebar-menu.tsx`의 `SidebarMenuSub`가 그리는 `ul`의 왼쪽 테두리 하나다(1310–1314행). 세션 행은 절대 위치이고 `ul` 높이는 `apps/studio/src/workbench/Sidebar.tsx` 760행이 정한다.

- 래퍼(`sidebar-menu-sub-wrapper`)는 늘 `overflow-hidden`이고 잰 높이로 맞춘다. 같은 킷의 그룹 접힘은 애니메이션이 끝나면 `overflow-visible`로 바꾸는데 이 래퍼는 그렇지 않다.
- 사이드바 뷰포트의 `.scroll-fade`가 아래 48px을 가린다.
- 어디서 끊기는지는 화면에서 보지 못했다. 보고에 붙은 그림은 전달되지 않았다.

할 일: 브라우저에서 끊기는 위치를 재고(행 하나, 1px, 페이드), 가이드 길이를 재는 테스트를 `Sidebar.test.tsx`에 더한 뒤 고친다. 킷 파일을 바꾸면 `packages/react/src/design-kit/README.md`의 적응 기록과 지문을 갱신한다.

### A3. 실행 중 수동 압축

실행 중 압축은 이미 있다. Coordinator 명령 `compact_context`(`packages/contracts/src/commands.ts` 167–171행)가 대상 실행·attempt·control revision을 확인한다.

- 버튼은 `apps/studio/src/workbench/RunStatusCards.tsx` 165·275행에서 작업 방식이 있는 라이브 실행에만 나온다. 일반 대화에는 "SDK 실행에서 지원합니다"만 보인다. Core 워커도 같은 압축 요청을 처리한다(`packages/adapter-pi/src/worker.ts` 113–115행). [모델 안내](../guides/models.md)는 Core와 SDK에 같은 엔진을 쓴다고 한다.
- 입력창 `/` 목록에 `compact`가 없다(`apps/studio/src/workbench/session/Composer.tsx` 1335–1402행).
- 현황의 컨텍스트 상세(`apps/studio/src/workbench/widgets/ChatWidgets.tsx`의 `ContextDetail`)에는 압축 조작이 없다. [채팅 위젯](../specs/chat-widgets-contract.md)은 그 하단에 명시적 압축 조작을 둘 수 있다고 한다.

할 일: 버튼의 조건을 Coordinator가 받는 조건(라이브, 살아 있는 실행)과 맞춘다. `/compact`와 현황 컨텍스트 상세의 압축 버튼을 더하고, 둘 다 같은 명령을 보낸다. 살아 있는 실행이 없으면 이유를 말하고 보내지 않는다(B3 전까지). Workbench 명세의 `/` 명령 문단과 채팅 위젯 명세에 적는다. Core 실행의 수동 압축은 테스트로 먼저 확인한다(`packages/core/test/compaction.test.ts`, `packages/adapter-pi/test/pi-adapter.test.ts`).

### A4. 컨텍스트 점유율을 한 줄 상태에

점유율은 지금 현황 팝오버 안의 카드에만 있고, 이 배치는 [채팅 위젯](../specs/chat-widgets-contract.md)이 정한 것이다. 명세를 바꾼다: 입력창 한 줄 상태에 "약 N%" 알약을 더하고, 누르면 기존 컨텍스트 상세를 연다. 전체 요청을 잰 값이 있을 때만 퍼센트를 보이고, 누적 사용량을 점유율로 쓰지 않는다는 기존 규칙은 그대로다. 값은 `widgets/selectors.ts`의 `presentContext`를 그대로 쓴다.

### A5. 적용된 추론 수준 확인

오늘 실행 기록으로 확인한 것:

- 추론을 고르지 않은 요청에는 추론 설정이 실리지 않았다(공급자 기본값).
- 높음으로 고정한 요청은 Hive DeepSeek과 gpt-6.1-terra 모두 실제 요청에 `high`가 실렸다.
- 모델에게 주는 정보는 공급자와 모델 ID뿐이다(`packages/adapter-pi/src/worker-tools.ts` 193–194행). 모델에게 물어서는 추론 수준을 확인할 수 없다.
- 일반 대화에서 "요청별"을 고르면 리드는 고정 medium이 된다(`packages/core/src/auto-team.ts` 121–125행). 이 동작은 명세에 없다.

할 일: 대화의 모델 요청 줄에 적용 수준과 요청 확인 값을 펼치지 않아도 보이게 한다(`apps/studio/src/workbench/TurnProcess.tsx`, `packages/react/src/components/ReasoningSummary.tsx`). 추론을 고르지 않은 요청은 "공급자 기본값"으로 읽히게 한다.

결정: 일반 대화에서 "요청별"을 고르면 리드의 요청마다 판정한다. 고정 medium은 없앤다. 명세에 먼저 적는다.

### A6. 판정 모델 설치 안내, 로컬 모델 제거

- **지금 준비**는 이미 설치된 모델을 띄울 뿐 내려받지 않는다. 내려받는 버튼은 **설치**다(`apps/studio/src/pages/EffortRoutingSettings.tsx` 363–396행).
- 크기는 "설치 안 됨" 상태 줄에만 나온다(매니페스트 합 약 1,123 MB). 설치 실패 뒤에는 크기 없이 **설치**가 바로 내려받는다. [추론 판정](../specs/features/effort-routing.md)은 설치 전에 전체 크기를 보이라고 한다.
- [모델 안내](../guides/models.md)는 약 1.1 GB라고 적는다.
- 두 번들(판정 모델, 회의 분석) 모두 제거 경로가 없다. 안내는 폴더를 손으로 지우라고 한다.

할 일: 설치 버튼 옆에 내려받는 크기를 늘 보이고(실패 뒤 포함), 준비 버튼에는 내려받지 않는다는 설명을 붙인다. 안내의 크기를 화면과 맞춘다. 번들마다 **제거**를 더한다: 판정 중·설치 중이면 거절하고, Corral이 띄운 프로세스를 끝낸 뒤 그 번들의 폴더만 지운다. 두 번들의 제거는 서로 묶지 않는다. 명세와 API 계약에 먼저 적는다.

### A7. 모델 요청 이력

`apps/studio/src/pages/ModelUsagePanel.tsx`는 버튼을 눌러야 최근 50건을 읽는다. [LLM 런타임](../specs/llm-runtime.md)이 막는 것은 원장 전체를 설정에 올리는 것이고, 첫 페이지를 여는 것은 막지 않는다.

할 일: 탭을 열면 첫 페이지를 읽는다. 읽은 페이지를 모델별 입력·출력·캐시 토큰과 시간순 요청으로 그린 차트를 위에 두고, 표는 상세로 남긴다. 차트는 SVG로 직접 그리고 의존성을 더하지 않는다. 미확인·구독·보고된 0의 구분은 차트에서도 유지한다. 명세에 이 화면의 표시를 적는다.

### A8. 이미지 프로필

- 설정의 드롭다운은 이미지 모델이 아니라 자격 증명을 가진 모델 프로필이다. 이미지 API에 보내는 모델 이름은 손으로 적는다.
- 프롬프트는 역할의 텍스트 모델이 쓰고, 이미지 요청에는 추론 필드가 없다(`apps/server/src/images-generation/service.ts` 221–228행). 추론 수준이 영향을 주는 곳은 그 역할의 텍스트 모델 설정이다.
- 이미지 모델 목록을 주는 출처가 없다.

완료. 화면 동작은 [모델·추론·리소스](../specs/models-and-resources.md#이미지-프로필)가 정한다.

### A9. 회의 참가자

참가자는 이미 이름, 호칭(최대 8개), 역할 설명(`prompt`), 모델을 가진다(`packages/contracts/src/meeting.ts` 11–18행).

- `@호칭`은 풀리지 않고 메시지가 거절된다. `@`는 표시 이름과 ID만 본다(`packages/core/src/meeting.ts` 63–86행).
- 응답자를 고르는 로컬 선택기는 이름과 역할 설명만 받고 호칭은 받지 않는다(621–623행).
- 참가자 줄에는 이름과 모델만 보인다. 짧은 역할 라벨은 계약에 없다.

할 일: 참가자에 짧은 역할 라벨(선택)을 더해 참가자 줄에 보인다. `@호칭`을 표시 이름과 같게 푼다. 선택기에 호칭과 역할 라벨을 넘긴다. 역할 설명은 지금처럼 누구를 부를지 고르는 설명으로 쓴다. 만든 뒤 참가자를 고치는 것은 이번 범위가 아니다.

## 단계 B: 결정이 필요한 것

### B1. 폴더 연결과 파일 도구

에이전트의 파일 도구는 세션 작업 사본이 있을 때만 붙는다(`apps/server/src/app.ts` 1678–1717행, `packages/core/src/auto-team.ts` 576–597행). 사본은 신뢰한 Git 폴더에서만 만들 수 있고, 사람이 세션마다 만든다. 이 작업공간에는 사본이 만들어진 적이 없고, 연결된 폴더는 Git이 아니며 신뢰도 꺼져 있다. 그래서 리드는 파일을 읽을 방법이 없었다. 폴더 연결, 신뢰, 사본 만들기는 세 화면에 나뉘어 있고 화면 문구는 "파일을 바꿀 수 없다"고만 말한다.

결정: (다) 연결한 폴더에서 에이전트가 직접 읽고 쓴다. 일반적인 에이전트 IDE처럼 폴더를 연결하고 신뢰하면 그 세션의 에이전트가 그 폴더에서 일한다.

이 계획이 정한 세부(사용자가 바꿀 수 있다):

- 신뢰는 그대로 명시적 동의다. Git이 아니어도 된다.
- 세션 작업 사본은 격리가 필요할 때 고르는 방식으로 남는다. 사본이 있는 세션은 지금처럼 사본에서 일한다.
- 직접 모드의 쓰기도 권한 모드(묻기·자동)와 도구 정책을 거치고, 되돌리기를 위한 파일 체크포인트를 남긴다. 체크포인트가 연결 폴더를 다룰 수 없으면 그 부분은 구현 전에 다시 정한다.
- 리드에게 어느 폴더에서 어떤 방식으로 일하는지, 도구가 없으면 그 이유와 사람이 할 일을 알려 준다. 입력창 표시도 같은 내용을 말한다.

[실행과 안전](../specs/execution-and-safety.md)과 [Workbench](../specs/workbench.md)의 연결·신뢰·사본·검토·적용 경계를 먼저 고친다.

### B2. 세션 삭제

세션·회의·프로젝트를 지우는 경로가 없다. 지우려면 Run과 이벤트, 산출물, 체크포인트, 첨부 이미지, 분기, 회의 인계, 검색 색인, 작업 사본 폴더, 브라우저의 초안을 함께 다뤄야 한다. 예약은 세션 ID를 JSON 안에 가진다.

결정: 보관 여부와 상관없이 어떤 세션이든(회의 포함) 지울 수 있다. 지우기 전에 잃을 것을 보여 주고 확인받는다. 끝나지 않은 Run은 Coordinator로 멈춘 뒤에야 지운다. 작업 사본은 기존 사본 삭제의 확인을 거친다.

### B3. 유휴 세션 압축과 OpenAI 서버 압축

압축은 살아 있는 실행 하나의 문맥을 줄인다. 실행이 끝나면 다음 요청은 이전 턴의 요청과 최종 답만 다시 붙이고(`packages/core/src/coordinator.ts` 2300–2376행), 도구 기록은 싣지 않는다. 그래서 실행이 없을 때 `/compact`가 줄일 대상은 지금 없다.

설치된 Pi(`@earendil-works/pi-ai` 1.5.0)의 OpenAI 요청에는 서버 압축을 켜는 항목이 없다. 쓰려면 Pi를 올리거나 Pi를 거치지 않고 요청을 바꿔야 한다.

결정: 세션 단위 압축을 만든다. 실행이 없을 때 `/compact`는 다음 요청에 이어 붙을 이전 턴을 요약 하나로 바꾼다. 원래 기록은 지우지 않는다. OpenAI 서버 압축은 Pi가 지원할 때까지 하지 않는다. A3가 끝난 뒤 시작한다.

### B4. 로컬 모델 GPU

판정 모델은 CPU 전용 런타임만 내려받고 GPU를 끄는 인자로 띄운다(`packages/local-intelligence/src/d1/runtime.ts` 105–110행). [추론 판정](../specs/features/effort-routing.md)은 검증되지 않은 GPU 조합을 비목표로 둔다. 이 컴퓨터는 RTX 3070(8 GB)이고 Vulkan이 잡힌다.

회의 분석 엔진은 GPU와 자동을 알지만 화면에 장치 선택이 없고 서버는 늘 CPU로 띄운다. [로컬 AI](../specs/features/local-intelligence.md)는 장치 선택과 실제 장치 표시를 요구한다. 명세와 코드가 다르다.

결정: 판정 모델에 Vulkan과 CUDA 런타임을 더한다. 각 런타임의 출처·라이선스·크기·해시를 매니페스트에 고정하고, 이 컴퓨터에서 사람이 직접 돌려 확인하기 전에는 검증됨으로 표시하지 않는다. 회의 분석 엔진의 장치 선택도 명세대로 화면에 낸다. A6가 끝난 뒤 시작한다.

### B5. 판정 API 종류

등록할 수 있는 판정 API는 TypeSafe Jev와 OpenAI Decisions 둘로 고정이다(`packages/contracts/src/reasoning.ts` 39행). [판정 API](../specs/features/decision-apis.md)는 범용 판정 API와 모델 공급자 키로 판정하는 것을 비목표로 둔다.

결정: 지금 둘로 유지한다.

## 다음

A1–A9, B1, B2는 각자 worktree에서 진행 중이다. A3가 끝나면 B3, A6가 끝나면 B4, A5가 끝나면 "요청별" 판정을 잇는다. 각 결과는 리뷰한 뒤 단계마다 PR로 낸다. A1과 A2는 PR 전에 실제 화면에서 확인한다.

## 남은 문제

- 자동 압축은 `context.compaction_changed`를 남기지 않아, 현황은 수동 압축에만 반응한다.
- 사이드바와 세션 메뉴의 보관은 세션을 다시 읽지 않고 가진 revision으로 요청한다. Workbench 명세는 다시 읽은 revision을 요구한다.
- 사본을 만든 뒤 신뢰를 끄면 읽기 도구는 남고 명령만 거절된다.
- 실제 모델과 실제 GPU가 필요한 확인(긴 실행의 압축, Hive의 추론 값, GPU 판정)은 사람이 직접 시작해 지켜봐야 한다.
