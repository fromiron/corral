# 제품 리디자인 플랜

작업 중인 플랜이다. 명세가 아니며 완료되면 삭제한다. 동작 계약은 1단계에서 고치는 [workbench](../specs/workbench.md), [chat-widgets-contract](../specs/chat-widgets-contract.md), [execution-monitor](../specs/features/execution-monitor.md)와 새 기능 명세(inbox, library, feature-preview, file-search)가 소유한다.

## 목표

정보구조·탐색·페이지 구성·상태 표현·작업 흐름을 다시 짠다. 요청 → 진행 확인 → 필요한 개입 → 변경 검토 → 검증 → 후속 작업이 끊기지 않게 한다. 개선 전후를 같은 조건으로 촬영해 비교 페이지로 남긴다. #214 확장 후보 중 이번에 들일 수 있는 것은 구현까지 한다.

브랜치 `feat/product-redesign`은 `develop`(cf82e695)에서 분기했다.

## 확정 결정 (2026-11-09)

1. **전역 셸**: 킷 `components/screens/shell.tsx` 구성을 따른다. 머리는 workspace header와 검색 필드(⌘K)이고, 주 메뉴는 새 대화 · 확인 필요 · 라이브러리 · 자동화다. 그 아래 프로젝트 ▸ 세션·회의가 오고, 하단에 상태 카드 · 기능 미리보기 · 설정이 있다.
   - 상단 바의 ProjectSwitcher를 없애고 모든 화면을 PathBar로 시작한다.
   - Sidebar 계약(폭 bridge, 가상화, 모바일 dialog)은 유지한다.
2. **확인 필요**: `/inbox`에 둔다.
   - 묶음: 응답 필요 / 검토 / 대기·중단.
   - 상세: 기존 응답 영역(`ApprovalPanel`·`InteractionPanel`)을 선택 항목 하나에만 호스팅한다.
   - `DecisionInbox`·`PermissionRequest`·`AskUserQuestions`는 쓰지 않는다.
   - 프로젝트 처리 항목 수의 정의는 유지한다. 전역 배지는 응답 대기 실행과 확인 필요 터미널을 센다.
3. **라이브러리**: 팀은 `/library/teams`로 옮긴다. Skill·Hook·MCP·패키지는 `/library/resources`에 목록·상태·실패 원인만 두고, 편집 폼과 미저장 보호는 설정 모달에 남긴다. `/settings/*` 주소는 바뀌지 않는다.
4. **실행 기록**: 그래프 보기에 관계도/목록 전환과 결과 보기를 더한다. 사용량은 실행 정보에만 있다. 검사는 세션 범위라 변경 탭의 보조 보기로 둔다. 세션이 있는 `/runs/:id`는 그 세션의 실행 기록 탭으로 replace한다.
5. **대화**: 질문은 지금처럼 정확한 Run의 응답 영역에서 답하고, 알림에 질문 제목을 보인다. 입력창 위는 한 줄 상태와 `QueuedStack`이다. 상단 실행 조작은 `AgentStatusPill`이고, steps·승인·진행률은 쓰지 않는다.
6. **#214**:
   - FFF는 경로 검색과 빠른 열기에만 쓴다. 내용 검색은 기존 엔진을 쓴다("모두 바꾸기"의 완전성 때문).
   - Plannotator·pi-context-view·rpiv-ask-user-question은 흐름만 구현한다.
   - 확장 상태 가시성은 라이브러리에 구현한다.
   - agent-browser·pi-lens는 보류한다.
7. **기능 미리보기(더미)**: `/preview/$feature`와 fixture 하나로 한다. 실제 화면에는 링크만 두고, 실제 호출이 없음을 경계 테스트로 고정한다.
8. **E2E**: 기본 스모크는 깨는 단계에서 같이 고친다. 확장 E2E는 마지막에 한 번 정리한다.

## 진행표

| 단계 | 내용 | 상태 | 커밋 |
|---|---|---|---|
| 0 | 브랜치, 이 플랜, 변경 전 캡처(43장, 비교 페이지 첫판) | 완료 | `bbd053e3` |
| 1 | 스펙 | 완료 | `bbd053e3`, `f1f446ad`, `a1c9d7e0` |
| 2.0 | 구조 분리(동작 변경 없음), 라우트 골격, 킷 조각 | 완료 | `e475d4eb`, `e39c41c7` |
| 2 | 셸·사이드바 ‖ 세션 상단·대화·컴포저 ‖ 설정 내부 | 완료 | `1ce787b6`, `e8db850d`, `0b61790f`, 수정 `a14154b2` |
| 3 | 파일 ‖ 회의 ‖ 라이브러리 → 변경·검사 ‖ 실행 기록 ‖ FFF 엔진 | 병합, 리뷰 수정 대기. FFF 보류 | `aed9cf1b`, `d9b071f3`·`818aae40`·`8cdc60b6`, `52843142`, `591508c3`, `e5b2ec33` |
| 4 | 확인 필요 ‖ 기능 미리보기 ‖ 컨텍스트·질문 흐름·자동화·진단 | 4c 병합, 4a·4d 구현 중. 컨텍스트 구성은 기존 컨텍스트 검사(#208)로 충족 | `6e6983b4` |
| 5 | 직접 조작 검증, E2E 정리, 최종 캡처, PR 문서 | 대기 | |

각 단계는 끝날 때 앱이 동작하는 상태를 유지하고, 이 표를 그 단계의 커밋에서 갱신한다.

## 캡처

- 보관: `output/redesign-20261109/{before,after}/`(Git 밖). 변경 전 기준은 `/home/bell/Toys/corral-before` worktree(cf82e695)다.
- 스크립트: `output/redesign-20261109/capture/`. 저장소 E2E 하네스(`apps/studio/e2e/server/harness.ts`)를 각 worktree에서 상대 경로로 가져온다.
- 비교 페이지: `output/redesign-20261109/compare.html`을 비공개 Artifact로 게시한다.

## 다음 단계

3단계 리뷰 확정 건을 고친다. 4a·4d를 병합하고 4단계 리뷰를 돌린다. 그다음 5단계.

## 남은 문제

- 확장 E2E: 2단계에서 셸 행·라벨이 바뀌어 약 40개가 깨진다(목록은 2b·2c·2d 보고). 5단계에서 공용 도우미로 한 번에 고친다.
- FFF 경로 엔진(4b)은 보류했다. 외부 npm 패키지(`@ff-labs/fff-node`) 설치가 자동 권한 판정에서 거부되어, 계획대로 엔진 교체만 미루고 내장 경로 검색을 유지한다. 들이려면 사용자 승인이 필요하다.
- AgentSteering 스토리의 axe 대비 검사가 부하 때 가끔 실패한다(단독 실행은 통과, 2단계 전에도 같음).
