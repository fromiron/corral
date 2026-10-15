# 001-canvas P1 계획

순서는 의존 관계를 따른다. 각 단계는 실패하는 테스트로 시작한다.

| 순서 | 태스크 | 내용 | 주요 테스트 |
|---|---|---|---|
| 1 | C-005 | 명령 7종·이벤트 45종·검토 산출물 Zod, JSON Schema 생성과 `contracts:check`, seed·생성물·Zod 3자 parity | wire parity, unknown field 거절 |
| 2 | C-008 | `compileDefinition`: 포트 표, 참조, 중복 ID, 도달 가능성, Loop 경계, 순환, 바인딩 생산자, capability 허용 목록, review 계약 → 진단 또는 IR. P0 `planLinearRun`은 이 결과 위에서 동작 | TC-CAN-004-H/N, 연구팀 예제 통과 |
| 3 | C-009 (모델) | 편집기 draft를 정의 중심으로 재구성(`draftFromDefinition`/`draftToDefinition` 왕복), 노드 복제 ID, JSON import/export | 연구팀 예제 왕복, TC-CAN-005-N(ID 충돌) |
| 4 | C-006 | 캔버스 4종 노드, 포트 핸들, capability link 별도 핸들·선 모양, 연결 중 거절 이유 | TC-CAN-003-H/N |
| 5 | C-007 | Loop 영역(부모 노드), 본문 편입·이탈, 영역 이동 시 멤버 동반 이동(레이아웃만) | TC-CAN-002-H, 경계 위반 표시 |
| 6 | C-010 | Undo/Redo(드래그 1회=1단계), 키보드 연결, 단축키의 IME·입력란 예외 | TC-CAN-005-H, TC-UX-001-N |
| 7 | C-009 (저장) | `CorralRepository` 포트와 브라우저 저장 구현(P2에서 서버로 교체), revision 규칙 | TC-CAN-002-H |
| 8 | C-056 | TanStack Router: `/`, `/corrals/$corralId/edit`, `/runs/$runId`, 없는 경로 처리, error boundary | 직접 진입·새로고침·뒤로가기 E2E |

## 범위 결정

- **실행:** P1 runtime은 여전히 선형 Agent→Output만 실행한다. Loop·Decision이 있는 정의는 검증·저장·내보내기는 되지만 실행 버튼은 "P2/P5에서 실행 지원" 이유로 비활성이다. 이것은 숨긴 제한이 아니라 화면에 나오는 진단이다.
- **저장소:** 서버가 생기기 전까지 정의는 브라우저 `localStorage`에 저장한다. 데이터는 이 브라우저에만 남는다는 점을 작업 공간 화면에 표시한다.
- **`/settings/models`, `/demo`:** 각각 C-058(P3), C-046(P9)에서 만든다.
