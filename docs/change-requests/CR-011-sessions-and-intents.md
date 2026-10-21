# CR-011: 세션과 입력 의도(후속 Run·실행 중 지시·대기·결과 질문)

- 변경 ID / 제안자 / 날짜: CR-011 / Bell(제안 `CR-WB-001`), Claude(저장소 적용) / 2026-10-16
- 상태: **승인**(Bell /goal: "개선플랜의 완성까지 … 바로 머지해버려도 됨", 2026-10-16. 로드맵 23·24번)
- 연결 문서:
  - Workbench 개선 플랜 (Git `373764467a52:docs/plans/Workbench-Improvement-Plan.md`) W2.
  - 제안 01 §5.2–§5.5 (Git `373764467a52:docs/proposals/workbench-v0.1/01-Improvement-Spec.md`)과 02 §6 (Git `373764467a52:docs/proposals/workbench-v0.1/02-UX-Spec.md`).
  - [CR-007](CR-007-new-run-from-version.md)(이전 결과에서 새 Run), [CR-010](CR-010-projects.md)(프로젝트).

## 제안

1. **WorkSession.** 프로젝트 안에서 한 목적을 잇는 단위다.
   - 필드: `sessionId`, `projectId`, `corralId`(기본 팀), `title`, `objective`, `pinned`, `archivedAt`, `revision`.
   - 기록(`entries`): 사용자가 보낸 요청마다 의도·본문·대상·시각·결과 Run을 남긴다. 저장 뒤에는 바꾸지 않는다(상태만 갱신).
   - 대기열(`queue`): 실행 중에 보낸 "다음 작업".
2. **Run 연결.** Run 시작 요청에 `sessionId`를 더한다.
   - 저장소는 Run 행에 세션을 함께 기록한다(같은 transaction). Run snapshot과 이력 export 형식은 바꾸지 않는다.
   - Run 목록에 `sessionId`가 붙는다. 세션 없는 지난 Run은 프로젝트 화면의 "세션 없는 Run"에 남는다(WB-MIG-001: ID 불변, 새 매핑만 추가).
3. **입력 의도(24번).** 세션 화면의 입력창은 의도를 고르고 보낸다.
   - **이 세션에서 계속**(`next`): 활성 Run이 없으면 세션의 팀으로 새 Run을 시작한다. brief는 입력한 글이다. 직전 Run의 최종 결과가 있으면 그 버전에서 시작한다(CR-007). 끝난 Run은 바꾸지 않는다.
   - **다음 작업으로 대기**(`queue`): 활성 Run이 있으면 대기열에 넣는다. 자동 시작하지 않는다. 활성 Run이 끝나면 "지금 시작"으로 사람이 시작한다. 서버를 다시 시작해도 대기 항목은 남고 저절로 시작하지 않는다.
   - **실행 중 지시**(`steer`): 활성 Run의 실행 하나를 대상으로 고른다. 대상이 이미 끝났으면 기존 Reins 규칙대로 전달되지 않음을 표시하고 다른 대상으로 바꾸지 않는다.
   - **결과 질문**(`explain`): 결과에 대한 질문은 별도 Run이다. 에이전트 하나, 도구 없음, 세션 팀 첫 역할의 모델 프로필. 결과 본문이 brief에 복사된다. 비용·기록은 다른 Run과 같다.
4. **명령 ID.** 입력창은 보낼 때마다 command ID를 하나 만든다. 응답을 잃고 다시 보내도 같은 ID로 Run은 하나다(기존 Coordinator 중복 규칙).
5. **API.**
   - `GET/POST /api/v1/sessions`(프로젝트별 목록·만들기).
   - `GET/PATCH /api/v1/sessions/:id`(제목·목적·고정·보관·대기열, revision 검사).
   - `POST /api/v1/sessions/:id/entries`(기록 추가).
   - `POST /api/v1/runs`·explain 시작은 `sessionId`를 받는다. 서버는 세션이 있고 팀의 프로젝트와 같은지 검사한다.
6. **화면.**
   - 프로젝트 화면: 세션 목록(고정 먼저, 검색, 보관 보기)과 새 세션(제목·목적·팀).
   - `/sessions/$sessionId`: Run 카드(요청·상태·최종 결과 미리보기·결과 화면 링크), 대기열, 입력창.
   - 입력창: 한국어 IME 조합 중 Enter는 보내지 않는다. Ctrl/⌘+Enter로 보낸다. 대상이 바뀌어도 초안은 남는다(세션별 저장).

## 하지 않는 것

자동 대기열 실행, 세션 분기, 병렬 Run(전역 활성 Run 하나 유지), 실행 중 팀 구조 변경.

## 테스트

- 저장소 계약: 세션 만들기·고정·보관·revision, 기록 추가, 대기열.
- Run 연결: SQLite·메모리 저장소가 `sessionId`를 기록하고 목록에 보인다. 다른 프로젝트 세션으로 시작하면 거절한다.
- E2E(데모): 세션 만들기 → 첫 요청 → 끝난 뒤 후속 요청 → 두 번째 Run이 첫 결과에서 시작한다. 실행 중 대기 → 끝난 뒤 "지금 시작". IME Enter는 보내지 않는다.
