# 구현 상태와 남은 일

대조 기준: `373764467a52a7c6978de1272ac8253c73a27077` (2026-10-21). 현재 코드·승인 CR·기존 실행 기록을 대조한 탐색용 요약이며, 이번 문서 정리에서 제품 전체를 다시 실행한 결과가 아니다.

**태스크 상태의 원장은 [backlog](../contracts/backlog.json)다.** `implemented`는 구현 범위의 상태이며 모든 OS·공급자·출시 게이트 통과를 뜻하지 않는다. 테스트 카탈로그의 `planned`는 시나리오 선언 형식이므로 미구현 수나 실패 수로 집계하지 않는다.

## 구현이 있는 범위

| 범위 | 승인·현재 계약 | 구현·기존 증거 | 남은 경계 |
|---|---|---|---|
| D&D·협업·Loop·Reins·저장·CLI | [제품 상세](current/product-contract.md), [Reins](../specs/reins/spec.md) | C-001–075 및 [P0–P9 기록](../specs/001-canvas/evidence/) | 과거 게이트를 현재 후보의 출시 증거로 재사용하지 않음 |
| 프로젝트·세션·파일 검토·대화 중심 Workbench | CR-010–017·023–024·043, [Workbench](current/workbench.md) | [Desktop Workbench](evaluation/Desktop-Workbench.md), [기본 대화](evaluation/Chat-First-UX-Review.md) | 후속 기능별 환경 검증은 아래 표 |
| 개인 하네스 H2–H8 | CR-018–020, [하네스 상세](current/harness-contract.md) | C-077–083, [구현·로컬 검증](evaluation/Personal-Harness-Validation-2026-10-18.md) | native 확장은 OS sandbox가 아님. 당시 OS·provider 검증 범위 보존 |
| 수동·자동 추론 | CR-021, [모델 안내](Models.md) | C-084, [실제 요청·패키지 증거](evaluation/Reasoning-Controls-2026-10-18.md) | 정확도·비용 절감이나 모든 transport 검증을 주장하지 않음 |
| 스킬·Hook·MCP 관리 | CR-022 | C-085, [관리·실행 증거](evaluation/Resource-Management-2026-10-18.md) | 패키지 API·브라우저·native smoke 범위가 다름 |
| Skill 평가·채택·업데이트·롤백 | CR-036-C/D | C-138/139, [현재 실행 기록](evaluation/Quality-Completion-2026-10-21.md) | 텍스트 fixture 비교. 품질 자동 승인이나 모든 공급자의 품질 향상 증거가 아님 |
| 통합 개선 M0–M3 | CR-025–036, C-088–112 | [M0](evaluation/Integrated-Improvement-M0-2026-10-19.md), [M1](evaluation/Integrated-Improvement-M1-2026-10-19.md), [M2](evaluation/Integrated-Improvement-M2-2026-10-19.md), [M3](evaluation/Integrated-Improvement-M3-2026-10-19.md) | 격리 등 OS 제한과 실제 모델 품질 미측정은 각 기록 참조 |
| 문맥형 설정·Composer 정돈 | CR-044, [Workbench](current/workbench.md) | C-140, [이번 구현·검증](evaluation/Contextual-Settings-UI-2026-10-21.md) | Linux 브라우저·staged Electron 검증. Windows/macOS·실제 IME·스크린리더는 별도 |
| 개발 Workbench 소유권·편집·도킹 | CR-046, [계획](plans/workbench-development-implementation-plan-2026-10-21.md) | [C-142·143 기반/비교](evaluation/Development-Workbench-Foundation-2026-10-21.md), [C-144 문서 API](evaluation/Development-Workbench-Documents-2026-10-21.md), [C-145·146 편집/복구](evaluation/Development-Workbench-Editor-2026-10-21.md), [C-147·148 PTY](evaluation/Development-Workbench-Terminal-2026-10-21.md), [C-149 패널·경로](evaluation/Development-Workbench-Panels-2026-10-21.md), [C-150 도킹/복구](evaluation/Development-Workbench-Docking-2026-10-21.md), [C-151 컨텍스트/밀도](evaluation/Development-Workbench-Context-2026-10-21.md), [C-152 Git 관찰](evaluation/Development-Workbench-Git-Observation-2026-10-21.md), [C-153 Git 쓰기](evaluation/Development-Workbench-Git-Write-2026-10-22.md), [C-154 branch·원격](evaluation/Development-Workbench-Git-Remote-2026-10-22.md), [C-155 task·Problems](evaluation/Development-Workbench-Tasks-2026-10-22.md), [C-156 Alpha 인수](evaluation/Development-Workbench-Alpha-2026-10-22.md), [C-157 변경 검토·근거](evaluation/Development-Workbench-Review-Evidence-2026-10-23.md), [C-158 팀 그래프 도킹](evaluation/Development-Workbench-Team-Dock-2026-10-23.md), [C-159 execution 근거·Reins 대상](evaluation/Development-Workbench-Execution-Evidence-2026-10-23.md), [C-160 사본 보관·삭제](evaluation/Development-Workbench-Copy-Lifecycle-2026-10-23.md), [C-161 공유 개발](evaluation/Development-Workbench-Shared-Development-2026-10-23.md), [C-162 언어 지원](evaluation/Development-Workbench-Language-2026-10-23.md), [C-163 파일 내용 검색](evaluation/Development-Workbench-Content-Search-2026-10-23.md) 구현. 검증 범위는 각 실행 기록 참조 | P00–P18·P21-A·P22·P23·P24-A 구현. 다음 P20·P24-B·P25는 별도 잔여 범위이며 P23 상시 세션의 수정 제안은 확장 필요. 외부 원격·서명 commit·실제 OS IME·스크린리더·설치판 GUI·지원 OS qualification은 별도 |
| 입력·대화·모델 식별과 테두리 일관성 | CR-045, [Workbench](current/workbench.md) | C-141, [구현·검증](evaluation/Workbench-Identification-2026-10-21.md) | Linux 브라우저·격리 DB 검증. 기존 서버 재시작·패키지·외부 공급자·스크린리더는 별도 |
| 컴포저·컨텍스트·채팅 위젯 | CR-037–041, C-119–121 | [M4 기록](evaluation/Integrated-Improvement-M4-2026-10-19.md), [위젯 계약·증거](change-requests/CR-041-chat-widgets.md) | native IME·외부 provider 미검증 범위 유지 |
| Desktop 확장 | CR-042, C-122–136, [상세 계약](current/desktop-contract.md) | [기능별 구현·검증](evaluation/Desktop-Capabilities-Implementation-Progress.md) | 부분 구현과 환경 대기를 아래에서 분리 |

## 남은 구현·검증

새 작업을 고를 때 읽는 목록이다. 이미 구현된 부분을 처음부터 다시 만들지 않는다. 순서·완료 조건은 [활성 계획](plans/README.md)을 따른다.

| 추적 | 구현 상태 | 남은 일 | 근거 |
|---|---|---|---|
| C-114 | 계획, 예산 helper만 준비 | 격리 후보별 실행·검사·비교·취소·정확한 하나의 승격 | [Ultra 잔여 계획](plans/ultra-and-quality.md), CR-031 |
| C-118 | 지원 범위 구현·검증, 미지원 계열 잔여 | Linux 격리·Anthropic adaptive conformance·GPT live 완료. Gemini transport 제약, 다른 계정/OS 검증 별도 | [현재 실행 기록](evaluation/Quality-Completion-2026-10-21.md) |
| C-125 / ABS-04 | 부분 구현 | Linux AppImage preview 검증 완료. macOS 로컬 앱 TCP 소유권 구현·실기 별도 | [Desktop 잔여 계획](plans/desktop-completion.md) |
| C-128 / ABS-07 | 구현 있음, 플랫폼 검증 진행 | NSIS 실제 설치, macOS·지원 arch, 서명·업데이트 채널 등 | [배포 기록](evaluation/Desktop-Delivery-Verification.md) |
| C-135 / ABS-14 | 구현 있음, 외부 통합 검증 대기 | 허용된 SSH host의 실제 연결·실행·끊김·복구 | [Desktop 잔여 계획](plans/desktop-completion.md) |
| C-136 / ABS-15 | 구현 있음, 장치·provider 검증 대기 | 실제 마이크·양방향 음성·끼어들기·종료·대상 고정 | [음성 기록](evaluation/Desktop-Voice-Verification.md) |
| CR-033-B / M4-5 | 기존 기능과 중첩, 잔여 대조 필요 | density·알림 deep link·editor 열기·온보딩 등 중 CR-042 충족 범위를 먼저 제외. opt-in 조사 분리 | [Desktop 잔여 계획](plans/desktop-completion.md) |

유료 이미지·외부 모델·S3와 실제 사용성/품질 평가는 해당 기록의 미검증 경계다. 코드가 없다는 뜻으로 새 구현 목록에 자동 추가하지 않는다. 실행하려면 이번 작업의 외부 호출·비용 승인 범위를 확인한다.

## 장기 후보와 과거 기록

미승인 장기 후보는 [제안 지도](proposals/README.md)에 두고 완료·대체된 계획은 Git 이력으로만 관리한다. 초기 `v0.2/v0.3`, `P0–P9`, `H1 다음 작업`은 현재 일정이나 실행 지시가 아니다.

상태 정정의 항목별 근거와 실행한 검사는 [문서 대조 기록](evaluation/Documentation-Reconciliation-2026-10-21.md)에 남긴다. 기능 변경 시 backlog·해당 계약·관련 증거를 함께 갱신하고 이 표의 요약도 맞춘다.
