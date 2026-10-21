# 동시 Run·Auto 작업 방식 검증

2026-10-20, Windows x64 / Node 24.19.0. `feat/desktop-capabilities`의 변경 중인 작업 트리이며 시작 HEAD는 `ad0bb6da6f20ca685e58b619e4e311464102a0b9`이다. 이 기록은 커밋·배포 완료를 뜻하지 않는다.

## 구현 계약

- canonical managed worktree별 writer는 하나다. 같은 사본의 reader는 writer가 시작할 때 고정한 Git tree를 읽고, 다른 사본의 writer는 병행한다.
- 소유권은 SQLite `run_access`에 보존한다. 시작 실패는 예약을 되돌리지만, 프로세스 종료가 확인되지 않은 예약은 해제하지 않는다. 파일 복원도 같은 canonical target과 충돌하며 다른 사본의 실행은 막지 않는다.
- Coordinator의 호스트 모델 슬롯과 네이티브 프로세스 그룹 상한은 별도 제약이다. 실행을 기다리는 요청의 취소가 다른 Run을 취소하거나 슬롯을 잃게 하지 않는다. 네이티브 범위의 세부 근거는 [관련 기록](Desktop-Native-Verification.md)에 있다.
- Run 소유 service는 pause, cancel, 성공 종료 전에 종료 확인을 기다린다. 확인 실패를 정상 취소·성공으로 표시하지 않는다.
- Studio의 SSE/store와 조작 대상은 Run별로 유지된다. 같은 세션의 여러 Run은 각각 상태·질문 진입점을 제공하고, 선택한 Run의 위젯과 컴포저 제어가 같은 대상을 가리킨다.
- Auto에서 사용자가 명시적으로 선택한 작업 방식의 ID와 revision을 요청·큐·AutoRoute에 고정한다. 작업 방식이 없는 기존 요청은 자동으로 신뢰를 받지 않는다. `review_only`는 선택한 작업 방식이 명령을 허용하더라도 역할의 쓰기·명령 권한을 제거한다.

## 대표 사용자 흐름

[desktop-capabilities.spec.ts](../../apps/studio/e2e/server/desktop-capabilities.spec.ts)의 최종 E2E 4개가 `index-xCi07lLw.js`에서 모두 통과했다. 이 중 동시 Run 검사는 다음 흐름을 실행한다.

1. 프로젝트 연결·신뢰, Settings 작업 방식 저장, 세션과 managed copy 생성을 실제 UI로 진행한다.
2. 컴포저에서 Auto와 작업 방식 r1을 명시적으로 고른다. A가 `run_command`를 요청하고 사용자가 승인한다. 승인 전 파일 부재, 승인 후 사본 파일 내용, 저장된 `exitCode: 0`·`cleanupConfirmed: true`, 원본 파일 부재를 확인한다.
3. A가 질문으로 대기하는 동안 같은 세션에서 review-only B를 시작한다. 별도의 세션·사본에서 C를 시작하고 A/B/C가 각각 대기하는 것을 읽는다.
4. A/B 카드의 질문 진입점과 선택 Run의 URL을 확인한다. B만 UI로 취소한 뒤 B가 cancelled, A/C가 awaiting_user인 것을 Coordinator에서 확인한다.

Pi SDK worker, HTTP 요청, Coordinator 권한 승인, 파일 broker, Windows Job 명령과 저장소는 제품 경로다. 원격 모델 응답만 로컬 HTTP endpoint가 결정적으로 제공한다. 따라서 이 검사는 orchestration·명령 효과·제어 격리를 검증하며 외부 모델의 판단 품질을 인증하지 않는다. 고정 tree의 실제 파일 내용 읽기는 [concurrent-files.test.ts](../../apps/server/test/concurrent-files.test.ts)에서 별도로 검증한다.

2026-10-21 최종 검토에서는 writer가 실행 중일 때 기존 결과의 **질문** 진입점이 사라지는 UI 누락을 발견했다. 설명 Run은 원래 `write_artifact`와 `submit_result`만 사용하는 reader이며, 서버의 병행 admission도 이미 허용했다. 컴포저가 기존 결과가 있을 때 활성 Run 중에도 질문을 제공하고, 다음 작업용 review/release 설정이 설명 요청을 막지 않도록 수정했다.

[auto-regressions.spec.ts](../../apps/studio/e2e/server/auto-regressions.spec.ts)의 추가 UI 검사는 네 번째 번들에서 질문 옵션 부재로 먼저 실패했다. 다섯 번째 `index-CYp9pZlk.js`에서는 기존 질문/첨부 호환성과 새 병행 질문 검사 **2/2 통과**, 20.0초였다. 실제 UI로 연결·신뢰·사본 생성·이전 결과 완료 후 writer A를 진행시키고, review-only 선택을 유지한 상태에서 질문 B를 시작했다. 요청의 `startFrom`, B의 읽기 전용 역할, 선택한 B만 취소, A의 running 유지, 이전 결과의 succeeded 유지와 원본 내용 보존을 확인했다. 콘솔 오류는 없었다.

이 추가 질문 검사는 기존 `fakeOpenAI`의 메모리 worker와 지연된 결정적 모델 응답을 사용한다. 컴포저→HTTP→Coordinator→저장소 경로와 요청·취소 대상을 검증하며 네이티브 worker 전달을 추가로 증명하지 않는다. 진행 중인 모델 응답을 취소한 경우 외부 효과가 unknown으로 남을 수 있으므로 해당 주의 알림은 숨기지 않았다. 선택한 Run의 상태에는 번역된 `Cancelled`가 표시되는 것을 확인했다.

## 기존 회귀 수정과 종료 경쟁

`TC-DEV-001-H`의 “호스트에 활성 Run 하나” 기대값은 승인된 ABS-06 계약과 충돌하는 **TEST DRIFT**였다. 테스트는 각 `commandId`의 정확히 한 번 생성·동일 receipt 재전달·내용 변경 충돌을 계속 확인하면서, 서로 독립인 Run의 병행을 허용하도록 수정했다.

같은 파일에 추가한 HTTP 반례는 동일 사본의 두 번째 writer를 거절하고, 같은 사본 reader와 다른 사본 writer를 받아들인다. 세 실행이 동시에 running인 것과 이후 모두 성공한 것을 확인한다.

이 반례의 첫 실행은 기능 assertion 뒤 Windows 임시 폴더 삭제에서 EPERM으로 실패했다. Run 종료 이벤트 이후 비동기 종료 checkpoint가 Git 작업을 계속하던 실제 수명 경쟁이었다. `WorkspaceService.dispose()`가 이미 소유한 snapshot·Run 준비·파일 lease 작업을 기다리도록 고쳤다. Git 자식 작업에는 기존 60초 timeout이 있으며, 종료되지 않은 작업을 정리된 것으로 선언하는 별도 timeout은 추가하지 않았다.

수정 후 `pnpm exec vitest run apps/server/test/server.test.ts`는 **36/36 통과**, 24.34초였다. 실제 Windows Job 생성·검사·취소를 포함하는 `WBTST-016`만 30초 테스트 예산을 부여했으며 결과·취소·영속 readback assertion은 유지했다.

업데이트 직전 백업에도 같은 수명 경계를 적용했다. Run이 terminal이어도 종료 checkpoint가 남아 있으면 `closeIfIdle`이 사용하는 파일 서비스 유휴 판정이 업데이트를 거절한다. 준비 작업과 worktree lease의 완료된 Promise는 현재 tail과 같을 때만 제거하여, 끝난 작업이 영구적으로 업데이트를 막거나 이전 작업이 뒤의 대기 작업을 숨기지 않게 했다. 실제 Git 읽기 두 개가 대기 중인데 busy가 false이던 반례를 먼저 확인했고, 수정 후 `concurrent-files`, `desktop-restart`, `server` 세 파일의 **40/40 검사 통과**, 28.73초를 확인했다.

## Windows 패키지에서의 시작 지연 조사

여섯 번째 패키지의 실제 Electron 화면에서 사본을 만든 뒤 mock 요청이 30초 동안 시작 응답을 돌려주지 않는 실패를 추가로 조사했다. 공개 projection은 `running`, `lastSeq: 3`, execution 없음이었지만 저장된 시작 tree와 `before_run` checkpoint는 이후 ready까지 진행했다. 이를 파일 lease 교착이라고 단정하지 않았다.

동일 bundled Node·서버와 제한된 PATH에서 일반 자식 프로세스의 API·Studio 흐름은 통과했다. Desktop과 같은 `detached: true`, 무시된 표준 입출력, 작업 공간 cwd로 바꾸자 Git 작업 자체가 크게 지연됐고, 공개 API 흐름은 40초 진단 한도를 넘었다. Desktop 담당자가 패키지 Git helper에 소스의 `windowsHide: true` 한 항목만 반영한 뒤 동일 API 흐름은 201→succeeded, 동일 Studio 화면 흐름은 8.54초에 완료됐다.

패키징 담당자의 별도 실제 Electron 검사도 네이티브 폴더 선택→연결·신뢰→수동 사본 생성→일반 요청→Succeeded(요청 후 2,403ms)→Quit 0을 통과했다. 이 조사에서 동시성·lease 코드는 변경하지 않았다. 전체 네이티브 회귀와 최종 패키지 신원은 Desktop 담당 검증 기록을 따른다.

## 검증 한계

위 결과는 로컬 Windows 작업 트리와 명시된 Studio 번들 기준이다. macOS/Linux 실기기 동시성, 실제 외부 모델 선택 품질, SSH 대상에서의 병행 실행은 이 기록의 검증 범위가 아니다. 실제 원격 전송 및 패키징은 각각 담당 검증 기록을 따른다.
