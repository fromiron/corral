---
kind: reference
status: current
baseline: 373764467a52a7c6978de1272ac8253c73a27077
---

# Workbench와 대화 흐름

[CR-043](../change-requests/CR-043-chat-first-optional-corral.md)이 기본 대화·선택적 Corral의 기준이다. 기존 편집기·D&D·Reins는 선택 가능한 작업 경로로 유지한다.

## 기본 입구

새 대화는 입력부터 시작한다. 모델 미연결 시 요청을 보존하고 연결로 안내한다. 새 프로젝트는 대화 목록부터 열되, 명시한 Corral 라이브러리 링크·저장한 탭·편집기 접근은 유지한다.

기본 입력창에는 요청, 첨부·참조, 모델, 권한, 음성, 보내기를 둔다. 선택적 Corral·작업 스타일·품질·역할별 설정·프로젝트 자료·요청 템플릿은 요청 옵션에서 다룬다. 비기본 선택은 옵션을 닫아도 요약한다.

옵션을 숨겨도 값·초안·권한을 초기화하지 않는다. 모델과 명시한 추론 선택을 알아볼 수 있게 표시한다. 고급 옵션의 숨김은 실행 중 Run의 설정 변경이 아니다.

## 범위와 연속성

기본 세션은 `corralId: null`과 기존 auto 시작 → Coordinator → Run 경로를 사용한다. 명시한 Corral이 삭제되면 조용히 auto로 대체하지 않는다. 작성 중 내용과 복구 선택을 보존한다.

세션 요청·Run·역할 execution을 구분한다. 큐에는 원래 요청 설정을 보존하며, 늦은 응답이 현재 세션·선택 Run·초안을 덮어쓰지 않도록 한다. 응답 유실 복구는 원래 command ID와 receipt 경로를 따른다.

설정 저장 revision, 미저장 그래프·초안, 복귀 경로, 과거 결과 선택과 Reins 대상을 보존한다. 실행 중 중지·대상 선택·오류·승인은 해당 맥락에서 계속 접근할 수 있어야 한다.

## 검증

키보드로 옵션을 열고 닫으며 Escape 뒤 트리거로 초점이 돌아가야 한다. 390px에서도 입력·전송·복구와 선택 요약이 잘리지 않아야 한다. 실제 화면과 관련 회귀를 함께 확인한다.

현재 근거는 [Chat-first 검토](../evaluation/Chat-First-UX-Review.md), [Desktop 진행 기록](../evaluation/Desktop-Capabilities-Implementation-Progress.md), 해당 UI·서버 시험이다. 로컬 테스트 모델 응답을 외부 모델 품질 증거로 취급하지 않는다.

새 UI 변경은 [AGENTS.md](../../AGENTS.md)의 디자인 스킬·공용 토큰·컴포넌트 규칙을 따른다. 다른 제품의 UI 참고는 Corral의 권한 기본값이나 실행 의미를 대체하지 않는다.

## 문맥형 설정 UI 변경

[CR-044](../change-requests/CR-044-contextual-settings-ui.md)는 작업 유지형 설정 모달과 Composer 표현 개선의 승인 계약이다. 구현·검증 진행은 [활성 계획](../plans/contextual-settings-ui.md)과 C-140에서 확인한다. 승인 자체를 구현 완료로 취급하지 않는다.
