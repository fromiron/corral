# 준비 명령 구현 계획

동작과 계약은 [준비 명령](../specs/features/paddock-setup.md)이 정한다. 이 계획은 단계와 진행만 적고, 일이 끝나면 지운다.

작업은 `feat/paddock-setup-command` 브랜치에서 한다. 단계마다 실패하는 테스트를 먼저 쓰고 실패를 본 뒤 구현한다. 단계를 끝내는 커밋에서 이 표를 고친다.

| 단계 | 내용 | 상태 |
|---|---|---|
| S1 | 저장: 폴더 연결의 `setupCommand` · `setupRevision`, PATCH와 GET workspace | 끝 |
| S2 | 준비 작업: 자동 시작, 환경, 시간 한도, 출력, 중지, 다시 준비, 신뢰 해제, 사본 지우기, 늦은 결과, 재시작, worktree의 `setup` | 끝 |
| S3 | 기다리는 요청: 쓰는 실행 자리, 새 요청의 대기 요청 전환과 표시, 대기열의 시작, 거절되는 시작 | 시작 전 |
| S4 | Studio: 환경 탭의 준비 명령 칸, Paddock 머리와 환경 탭의 상태, 출력 보기, en · ko 문구 | 시작 전 |
| S5 | 검사: lint, typecheck, contracts, 관련 서버 · Studio 테스트, 건드린 E2E, 화면 걷기 | 시작 전 |

## 코드의 자리

- 저장: `packages/storage-sqlite/src/database.ts`의 새 migration, `apps/server/src/files/service.ts`의 `configure`와 `BindingView`.
- 준비 작업: 새 파일 `apps/server/src/files/paddock-setup.ts`. 원장은 `workbench-operations.ts`, 프로세스는 `processes/runtime.ts`의 `CommandRuntime`(사람 task와 같은 런타임), 재시작 뒤 확인은 `deployment-tasks.ts`의 `capturePtySession` · `cleanupPtySession`.
- 쓰는 실행 자리: `workspace-access.ts`의 `acquire`.
- 대기열: `apps/server/src/session-queue.ts`, `packages/core/src/repository/index.ts`의 `queuedEntriesInStartOrder`.
- 시작 전환: `apps/server/src/app.ts`의 `POST /runs`와 `POST /runs/auto`.
