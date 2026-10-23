# 관리 사본 문서 API 구현·검증 — 2026-10-21

- 기준: `f7bdf1f` 뒤 CR-046 P04 후보. 구현 tree는 이 기록을 포함한 commit으로 식별한다.
- 추적: CRL-WBD-002 / C-144 / TC-WBD-002-H,N,F. P03의 reader 보완은 TC-WBD-001-H,N,F도 재검증했다.
- 환경: Linux x64, Node 24.19.0, pnpm 10.30.3. 임시 Git 사본·SQLite·실제 HTTP client·ScriptedAgentAdapter를 사용했다. 사용자 폴더/DB·기존 서버·유료 provider는 사용하지 않았다.

## 구현 범위

`WorkspaceService`·Zod·client·HTTP에 관리 session 사본용 document read/change/receipt 경로를 연결했다. 기존 원본/사본 browse와 Run 파일 API는 유지한다. read는 같은 bytes로 전체 SHA-256·BOM 포함 UTF-8 text·EOL·bytes를 계산하고 host의 안정된 workspace ID·project/binding/session/generation을 반환한다. 신뢰·owner 상태와 binary/1MiB 초과를 구분한다.

사용자 save/create는 target·baseHash·제출 editVersion을 확인한다. 같은 폴더 temp write/flush 후 checked rename 또는 exclusive link로 적용하고 실제 bytes를 다시 읽은 뒤 receipt를 완료한다. 기존 파일 permission은 보존하고 새 파일 생성은 umask를 따른다. 서버가 BOM·줄바꿈·마지막 개행을 정규화하지 않는다.

rename은 목적지를 덮지 않으며 부분 실패 때 두 경로와 불확실한 writer를 보존한다. delete는 명시 confirmed와 source hash를 요구하고, 체크포인트에 실제 원래 bytes가 들어 있는지 확인한 뒤 수행한다. ignored 파일처럼 현재 checkpoint 계약에 없는 파일은 삭제하지 않는다. 초기 변경 범위는 UTF-8 일반 파일 ≤1MiB다.

접수 transaction에는 상대 path/baseHash와 제출 hash/editVersion 또는 rename 목적지/delete checkpoint ID를 pending intent로 저장한다. 완료·실패·불확실 결과에도 유지하며 원문 text는 원장에 넣지 않는다. effect 후 receipt 저장 실패·host recover 뒤에도 client의 원래 요청 없이 대상/precondition을 확인할 수 있다. uncertain을 자동 성공이나 재실행으로 바꾸지 않는다.

HTTP mutation route만 JSON escaping을 고려해 bodyLimit 7MiB를 사용하며 실제 UTF-8 bytes 상한은 그대로 1MiB다. typed refusal code를 보존하고 원시 filesystem/Git 오류의 절대 경로를 응답에 노출하지 않는다. demo는 local backend 필요 오류를 명시한다.

## 실제 발견과 TDD

1. 신규 API 부재: host 테스트와 actualclient HTTP 4개가 먼저 실패했다.
2. HTTP 실행에서 발견한 canonicalJson(undefined) 요청 구성 오류를 수정했다.
3. 사용자 write의 lease가 끝난 뒤 reader가 준비되면 writer가 이미 released여서 저장 후 tree를 읽는 반례 4개를 재현했다. reader acquire가 이미 고정된 writer tree를 복사하고 writer pin이 대기 reader의 빈 tree만 채운다. prepareRun은 같은 tree로 start snapshot/checkpoint를 기록한다. 다음 writer가 기존 reader tree를 덮지 않는다.
4. 새 파일에 chmod를 강제해 umask를 무시하지 않도록 기존 파일만 mode를 복원했다. NUL text가 성공 후 편집 불가 binary가 되는 입력도 쓰기 전에 거절한다.
5. effect 뒤 receipt UPDATE 실패 후 recover 시 result가 null이라 파일/precondition을 알 수 없는 red를 확인했다. 별도 migration 없이 pending intent를 접수와 원자 저장하고 모든 결과에 보존해 수정했다.

## 실행 결과

아래 명령은 Node 24.19.0 PATH와 `--maxWorkers=2`를 사용했다. test timing 자체를 pass/fail 기준으로 삼지 않았다. 새 실제 Git/HTTP 테스트에는 기존 files suite와 같은 30초 runaway limit을 사용해 기본 5초 마감으로 인한 CI 실패를 피한다.

| 검사 | 실제 결과 |
|---|---|
| documents, documents-api, reader-reservation, workspace-access, workbench-operations, concurrent-files, files, command-broker, workspace-ownership, workbench-migration, sqlite, coordinator-store, client 13개 파일 | 152 tests PASS |
| partial rename 실패 추가 후 documents 재실행 | 9 tests PASS, 원래 suite 대비 새 case 1개 |
| durable intent 수정 후 documents + documents-api + workbench-operations + reader-reservation | 18 tests PASS |
| 전체 `pnpm typecheck` | 15 workspace packages 및 tools/live PASS; 최종 공개 타입 변경 뒤 server/client/studio 재검사도 PASS |
| `pnpm spec:check`, `pnpm contracts:check` | 요구/태스크/TC·Markdown 링크와 generated schema 정합성 PASS |

서로 다른 검증 case는 총 153개다. 중복 재실행을 더해 시험 수를 부풀리지 않았다. 최종 작은 수정 이후 영향받는 검사만 다시 실행한다. 읽기 전용 두 번째 리뷰에서 추가 데이터 손실·권한 결함은 발견하지 못했다. 기존 Biome 경고를 전체 정리하지 않았고 새 경고는 남기지 않았다.

## 남은 범위

코드 편집 화면·shared buffer·dirty 복구는 P05–06, 명시 uncertain 복구 UI는 후속 수명 관리 범위다. 이번 API 통과가 완성된 IDE나 설치판 검증을 뜻하지 않는다. Windows/macOS 파일 동작과 외부 writer의 hash-check→replace 경합은 검증하지 않았다. Corral 예약을 OS 수준 CAS로 표현하지 않는다.

새 E2E·브라우저 UI 변경·운영 서버 재시작·push/PR/merge는 수행하지 않았다. rollback은 원래 파일/사본을 reset하지 않고 이 기능 노출을 중지하는 방식이며, P03 DB schema를 되돌릴 경우 해당 upgrade 전 backup과 호환 binary를 함께 사용한다.
