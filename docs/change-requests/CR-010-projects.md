# CR-010: 프로젝트로 팀과 Run 나누기

- 변경 ID / 제안자 / 날짜: CR-010 / Bell(제안 `CR-WB-001`), Claude(저장소 적용) / 2026-10-16
- 상태: **승인**(Bell: "프로젝트별로 구분되지 않는 것이 제일 큰 문제 … 개선플랜을 작성 후 개선해", 2026-10-16. 로드맵 22번)
- 연결 문서:
  - [Workbench 개선 플랜](../plans/Workbench-Improvement-Plan.md) §3.2.
  - 제안 [01 §3·§5.1](../proposals/workbench-v0.1/01-Improvement-Spec.md)과 [03 §2–§4](../proposals/workbench-v0.1/03-Technical-Design.md).
  - 스펙 §4.1 라우트, C-009·C-011 저장.

## 기존 문구

- 스펙 §4.1: `/`는 작업 공간의 저장된 Corral과 최근 Run을 보인다.
- 작업 공간 하나(`--workspace`)가 DB 하나이고, 그 안의 팀과 Run은 나뉘지 않는다.

## 제안

1. **Project.**
   - 필드: `projectId`, `name`, `description`, `createdAt`, `updatedAt`, `archivedAt`, `revision`.
   - 폴더 없이 만든다. 작업 폴더 연결은 후속(W3)이며 별도 표다.
   - 같은 이름의 프로젝트도 ID로 구분한다.
2. **저장.** 작업 공간 DB에 migration `0003_projects`를 더한다.
   - `projects` 표와 기본 프로젝트 행(`projectId = default`, 이름 비움)을 만든다.
   - `corrals.project_id`, `runs.project_id`를 더한다. 둘 다 NULL이면 기본 프로젝트로 읽는다.
   - 불변 표와 기존 행의 ID는 바꾸지 않는다. 데이터 폴더를 옮기지 않는다.
3. **소속.**
   - 팀은 프로젝트 하나에 속한다. 새 팀은 요청한 프로젝트(없으면 기본)에 만든다. 복제본은 원본의 프로젝트에 둔다.
   - Run의 프로젝트는 시작하는 같은 transaction에서 팀의 프로젝트로 기록한다. 이후 바뀌지 않는다.
   - 팀을 옮겨도 지난 Run은 원래 프로젝트에 남는다.
4. **API.** 모두 기존 세션·origin 검사를 따른다.
   - `GET /api/v1/projects`: 보관 포함, 팀·Run 수.
   - `POST /api/v1/projects`: `name`, `description`.
   - `PATCH /api/v1/projects/:projectId`: 이름·설명·보관. `expectedRevision`이 다르면 `REVISION_CONFLICT`. 기본 프로젝트는 보관 거절.
   - `PUT /api/v1/corrals/:corralId/project`: 팀 이동. 없는 프로젝트·보관한 프로젝트로는 거절.
   - 기존 응답에 필드를 더한다:
     - `POST /api/v1/corrals`는 `projectId`를 받는다.
     - `CorralSummary`·`CorralRecord`에 `projectId`.
     - `GET /api/v1/runs`의 각 Run에 `projectId`.
5. **화면.**
   - `/projects`(목록·만들기·보관 보기)와 `/projects/$projectId`(그 프로젝트의 팀·Run·템플릿·목표에서 시작)를 둔다.
   - `/`는 마지막으로 연 프로젝트(없으면 기본)로 이동한다.
   - 헤더에는 현재 프로젝트와 전환 메뉴가 있다. Run·편집기 화면은 그 Run·팀의 프로젝트를 보인다.
   - 팀 목록에서 프로젝트 이동, ⌘K 프로젝트 전환을 제공한다.
   - 기존 `/runs/$runId`, `/corrals/$corralId/edit`, `/compare` 링크는 그대로 열린다.
6. **브라우저 데모.** localStorage 저장소가 같은 규칙(기본 프로젝트, 만들기·이름·보관, 팀 이동)을 따른다. 데모 Run은 탭을 닫으면 사라지므로 Run의 프로젝트는 팀에서 읽는다.

## 이유

여러 일을 한 작업 공간에서 하면 팀과 Run이 한 목록에 섞인다. 어떤 결과가 어떤 일의 것인지 알기 어렵다. 제안은 Project → Session 탐색을 기본으로 한다. 이 CR은 그 첫 단계로 Project를 연다. Session은 23번에서 별도 CR로 한다.

## 기존 합의와 충돌

- 스펙 §4.1의 `/`는 이제 프로젝트 화면으로 이동한다. 내용(팀·Run·템플릿)은 같고 프로젝트로 좁혀진다.
- Run snapshot 원칙(시작 후 바뀌지 않음)을 프로젝트 소속에도 적용한다.
- 저장 위치·자격 증명 격리(ADR-019)는 그대로다.

## 테스트

- 저장소:
  - migration 0002 DB(팀·Run 있음)를 열면 기본 프로젝트가 생긴다. 기존 팀·Run이 그 프로젝트로 읽히고 Run 이벤트 행 수·ID가 그대로다.
  - 같은 이름 프로젝트 둘을 ID로 구분한다.
  - 보관은 행을 지우지 않는다.
  - revision 충돌을 거절한다. 기본 프로젝트 보관을 거절한다.
- 소속:
  - 팀의 프로젝트로 Run이 기록된다.
  - 팀을 옮긴 뒤 지난 Run은 원래 프로젝트, 새 Run은 새 프로젝트에 속한다.
  - 없는·보관한 프로젝트로 이동을 거절한다.
- 데모 저장소: 같은 계약 테스트를 key-value 저장소에도 돌린다.
- E2E: 프로젝트 두 개에서 팀·Run이 섞이지 않는다. 헤더 전환·새로고침 후 유지, 기존 Run 링크 열림.

## 일정·영향

새 의존성 없음. contracts(오류 코드는 기존 것 사용), core(저장소 계약), storage-sqlite(migration·표), server(API), client, studio(라우트·헤더·홈)가 바뀐다.
