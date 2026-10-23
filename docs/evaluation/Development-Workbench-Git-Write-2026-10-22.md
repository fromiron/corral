# CR-046 P13 — 관리 사본의 stage/unstage와 commit

범위: CRL-WBD-009 / C-153 / TC-WBD-009-H,N,F. 기준 브랜치는 `feat/development-workbench`이며 #70–#95 UI 정리 이후의 구조(단일 Git 창, 설정 모달, 도킹 문서 탭)를 따른다. P14 branch·remote, 전체 Workbench 완료나 설치판 검증을 뜻하지 않는다. 현재 계약은 [Workbench](../current/workbench.md), 계약 변경은 [CR-046](../change-requests/CR-046-development-workbench.md)의 P13 절을 따른다.

## 결정

D5는 2026-10-22 사용자 결정으로 확정했다. hook은 신뢰 프로젝트에서 사람이 "hook 실행"을 켠 commit에서만 실행한다. 서명은 Git 설정이 요구하면 사용자 signer로 하고 실패하면 거절한다. 작성자·서명 설정은 허용 키만 읽는다. Git 쓰기는 문서 저장과 같이 신뢰 프로젝트에서만 접수한다.

## 구현

- 계약: `GitWriteCommand`(stage/unstage/commit), `GitOperation` receipt, `GIT_IDENTITY_KEYS`. 새 ErrorCode는 만들지 않고 실패 `reason`(`locked`, `hook_failed`, `signing_unavailable`, `author_missing`)을 결과에 둔다.
- host: `apps/server/src/files/user-git-write.ts`의 쓰기 runner는 snapshot helper와 분리했다. 소유 process group으로 실행하고 취소·timeout 뒤 group 종료를 확인한다. hook을 끈 commit은 `--no-verify`와 비활성 hooksPath를 쓴다. 전역 설정은 허용 키만 `-c`로 전달한다.
- `WorkspaceService.changeGit`은 문서 저장 경로와 같은 순서(receipt 조회 → 대상·신뢰 → lease → admit → HEAD·index·staged 재확인 → 효과 → readback → finish)를 따른다. commit 판정은 HEAD의 첫 parent가 확인한 HEAD인지로 한다. 응답 유실·receipt 기록 실패·재시작 뒤에는 `resolveGitOperation`이 HEAD·index를 다시 읽어 확인되는 경우에만 정리한다. `WorkbenchOperations.reconcile`은 terminal 전용이던 정리를 일반화했다.
- HTTP·client: `POST/GET …/git/operations`, `POST …/cancel`; `gitChange`, `gitOperation`, `cancelGitOperation`. 원본 폴더 경로는 없다.
- UI: Git 창은 신뢰한 세션 사본에서만 행별 stage/unstage 아이콘 버튼(접근성 이름 "Stage {path}"/"Unstage {path}"), 2개 이상일 때 모두 stage/해제, commit 메시지·hook 실행·commit 버튼을 보인다. 진행 중 operationId는 sessionStorage에 두고 다시 열 때 같은 ID로 조회한다. 레이아웃이 설명하는 "변경을 선택하라" 안내 문구는 제거했다. 팔레트에 "Commit staged changes"를 추가했다.

## 검증 (Linux, Git 2.43.0, Node 24.22.1)

- `apps/server/test/user-git-write.test.ts` 6 PASS: stage→unstage→commit과 같은 ID 재요청, 비선택 변경·원본 보존, `runHooks`에 따른 hook 실행/미실행과 scripted `gpg.program` 서명, 외부 stage·부분 staged 목록·다른 payload·비신뢰 프로젝트·다른 사본 generation·signer 부재 거절, hook 실패·hook 실행 중 취소(자식 프로세스 종료 확인)·index.lock, receipt 기록 실패 후 재시작에서 중복 commit 없는 판정.
- `user-git-routes.test.ts`에 실제 client 경유 stage receipt, 다른 사본·원본 index 불변, 잘못된 body·다른 session·원본 경로 404를 추가했다(전체 5 PASS).
- `files.test.ts`의 TC-HUNK-001에 관리 사본 자체 index 불변 확인을 추가했다(PASS).
- `GitPanel.test.tsx` 7 PASS: stage·commit 명령 형식, 원본·비신뢰 사본에서 쓰기 조작 없음, 미확인 operation을 같은 ID로 재조회하고 재전송하지 않음.
- 실제 앱(server build, Playwright Chromium): 저장소 연결·신뢰 → 사본 생성 → 파일 변경 → Git 창에서 `a.txt` stage → 메시지 입력 → "Commit 1 file". 사본 HEAD의 작성자는 저장소 설정의 `Person`이었고 untracked 파일은 남았다. 390px에서도 행과 버튼이 보였다. 콘솔 오류 0.
- 이 컨테이너의 PID 1은 고아 프로세스 회수에 약 1.6초가 걸렸다. 공용 정리 확인 함수(1초)는 바꾸지 않고 Git runner에서만 확인을 최대 10회 반복한다.
- `pnpm spec:check`, `pnpm contracts:check` PASS. 한국어 메시지 검사의 기존 실패(`Git.comparison.*`)도 번역해 통과한다.

테스트는 구현과 함께 작성했다. 서버 시험은 구현 전 메서드가 없어 실패하는 상태였고, Git 창 시험은 구현 전 실행해 2건 실패를 확인한 뒤 구현했다.

## 한계

- commit 판정은 첫 parent만 본다. 같은 사본에서 Corral 밖의 Git CLI가 동시에 commit하면 구분하지 못한다(공통 writer는 Corral 안의 쓰기만 직렬화한다).
- 취소로 끊긴 commit이 남긴 `index.lock`은 지우지 않는다. 다음 쓰기는 `locked`로 거절되며 사람이 정리한다.
- 실제 GPG/SSH 서명 키, Windows·macOS, 설치판, 스크린리더, 실제 OS IME는 검증하지 않았다.
