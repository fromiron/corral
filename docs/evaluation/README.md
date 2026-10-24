# 검증 기록 지도

이 디렉터리는 특정 commit·빌드·환경에서의 결과를 보존한다. 현재 제품 계약은 [문서 지도](../README.md), 구현과 남은 일은 [상태표](../status.md), 반복 가능한 절차는 [Test Strategy](../Test-Strategy.md)·[Release](../Release.md)·[Evaluation](../Evaluation.md)에서 확인한다.

| 범위 | 증거 |
|---|---|
| LLM 인프라 현대화 | [CR-052 구현·호출 원장·포팅·실제 비교·Linux 배포 검증](llm-modernization/report.md) |
| 세션 현황 위젯 | [CR-053 대화 옆에 떠 있는 현황 위젯·좁은 화면 팝오버 검증](Session-Overview-Widgets-2026-10-24.md) |
| 세션 작업 화면 단순화 | [CR-051 도킹 영역 메뉴·창 배치·대화 정리·남은 킷 전환 검증](Session-Workspace-Simplification-2026-10-24.md) |
| 디자인 킷 도입·토큰 정형화 | [CR-050 복사 출처·의존성·화면 및 회귀 검증 범위](Design-Kit-Adoption-2026-10-23.md) |
| 회의실·결정·일반 세션 인계 | [CR-049 그룹 채팅·선택 역할·요청 시 플랜](Meeting-Chat-2026-10-23.md), [이전 회의록·채택·인계·복구](Meeting-Room-2026-10-23.md) |
| 검토·실행·후보 비교 배치 | [CR-047 중앙 폭·수치 정렬·반영 버튼·카드 위계](Review-Comparison-Layout-2026-10-23.md) |
| Desktop 기능·플랫폼 한계 | [전체 진행](Desktop-Capabilities-Implementation-Progress.md), [배포](Desktop-Delivery-Verification.md), [preview](Desktop-Preview-Verification.md), [동시 실행](Desktop-Concurrency-Verification.md), 나머지 Desktop 기능별 보고서 |
| 알림 대상 이동 | [C-171 정확한 Run·승인, 늦은 클릭·재시작·SPA 보존](Desktop-Notification-Targets-2026-10-23.md) |
| Ultra 후보 비교 | [P19 같은 Run·후보 사본·검사·취소·명시 단일 반영](Development-Workbench-Candidates-2026-10-23.md) |
| Ultra 후보 경쟁(version 2) | [CR-048 익명 판정·고도화·자동 반영·사용량 한도 없음](Ultra-Tournament-2026-10-23.md) |
| 문맥형 설정·Composer | [CR-044 구현·Linux 검증](Contextual-Settings-UI-2026-10-21.md) |
| Workbench 식별·테두리 일관성 | [CR-045 구현·Linux 검증](Workbench-Identification-2026-10-21.md) |
| Workbench 코어 잔여 검증 | [preview·PTY 재접속·파일/Git/설정 왕복](Development-Workbench-Core-2026-10-23.md) |
| 프로젝트 언어 지원 | [P23 dirty 진단·completion·정의/참조 이동](Development-Workbench-Language-2026-10-23.md) |
| 파일 내용 검색 | [P24-A 결과 이동·dirty/stale 보존](Development-Workbench-Content-Search-2026-10-23.md) |
| 다중 파일 교체와 refactor | [P24-B 불변 제안·파일별 적용·복구 경계](Development-Workbench-File-Edits-2026-10-23.md) |
| 일상 개발 인수 | [P28 JS/TS 코어 연결·실제 편집 여정](Development-Workbench-Daily-Driver-2026-10-23.md) |
| Linux 설치판·복구 인수 | [P29 실제 unpacked·복구 경합·native/worker·키보드/390px](Development-Workbench-Qualification-2026-10-23.md) |
| Node·Chromium 디버깅 | [P26 소유 DAP·원본 중단점·step·변수·명시 평가](Development-Workbench-Debugging-2026-10-23.md) |
| 배포 작업과 결과 확인 | [P27 source 고정·명시 실행·별도 readback](Development-Workbench-Deployment-2026-10-23.md) |
| 고급 Git와 충돌 해결 | [P25 실제 index hunk·충돌 편집·merge/rebase·receipt 복구](Development-Workbench-Advanced-Git-2026-10-23.md) |
| 미리보기 요소 피드백 | [P20 실제 Desktop 선택·검토·첨부·같은 화면 갱신](Development-Workbench-Preview-Feedback-2026-10-23.md) |
| 공유 개발·live edit | [CR-046 P22 구현·Linux 실제 Vite 검증](Development-Workbench-Shared-Development-2026-10-23.md) |
| 실제 Git 상태·읽기 정책 | [CR-046 P12 구현·Linux 인앱 검증](Development-Workbench-Git-Observation-2026-10-21.md) |
| 캡처한 컨텍스트·대화 표시 밀도 | [CR-046 P11 구현·Linux 인앱 검증](Development-Workbench-Context-2026-10-21.md) |
| 도킹 배치·문서 수명·키보드·복구 | [CR-046 P10 구현·Linux 인앱 검증](Development-Workbench-Docking-2026-10-21.md) |
| 패널 대상·경로·Run view 수명 | [CR-046 P09 구현·인앱 검증](Development-Workbench-Panels-2026-10-21.md) |
| 사용자 PTY·터미널 | [CR-046 P07–08 구현·Linux 인앱/native runtime 검증](Development-Workbench-Terminal-2026-10-21.md) |
| 파일 편집·초안 복구 | [CR-046 P05–06 구현·Linux 인앱 검증](Development-Workbench-Editor-2026-10-21.md) |
| 관리 사본 문서 변경 | [CR-046 P04 API·파일/HTTP 검증](Development-Workbench-Documents-2026-10-21.md) |
| 개발 Workbench 기반 | [CR-046 공통 예약·migration과 엔진 qualification](Development-Workbench-Foundation-2026-10-21.md) |
| 기본 대화·Workbench | [기본 대화](Chat-First-UX-Review.md), [초기 Desktop](Desktop-Workbench.md), [UX 대조](UX-Spec-Conformance.md) |
| 하네스·추론·리소스 | [H2–H8](Personal-Harness-Validation-2026-10-18.md), [추론](Reasoning-Controls-2026-10-18.md), [리소스](Resource-Management-2026-10-18.md) |
| 통합 개선 | [M0](Integrated-Improvement-M0-2026-10-19.md), [M1](Integrated-Improvement-M1-2026-10-19.md), [M2](Integrated-Improvement-M2-2026-10-19.md), [M3](Integrated-Improvement-M3-2026-10-19.md), [M4](Integrated-Improvement-M4-2026-10-19.md) |
| 문서 상태 대조 | [2026-10-21 정리](Documentation-Reconciliation-2026-10-21.md) |
| 성능·초기 실행 | [성능 절차와 측정](../Performance.md), [원시 성능 자산](../performance/), [P0–P9](../../specs/001-canvas/evidence/) |

## 기록 원칙

명령, commit/빌드 identity, OS·runtime, mock/live, 성공·실패·skip, 미실행 조건과 원시 자산 위치를 보존한다. 보고서의 과거 성공과 이번 후보에서 재실행한 성공을 구분한다. 일부분 재검증으로 이전 전체 실패를 전체 PASS로 바꾸거나 중복 시험 수를 합산하지 않는다.

fixture·schema·TC 태그·모델 검토는 실제 외부 모델·마이크·SSH·업데이트 성공을 대신하지 않는다. Windows 결과를 다른 OS로 일반화하지 않는다. 과거 보고서의 “현재”, “다음 작업”, 당시 브랜치는 그 보고서 기준선에만 적용한다.

기존 `docs/plans/*Verification.md`와 추론 검증은 이곳으로 옮겼다. raw 성능 JSON과 `tests/pack-validation-report.json`은 원래 hash·결과를 유지한다. 초기 manifest·패키지 사본은 Git 이력으로만 관리한다. `pnpm spec:check`의 새 결과는 임시 경로에 생성되며 저장된 역사 JSON이 현재 통과 증거가 아니다.
