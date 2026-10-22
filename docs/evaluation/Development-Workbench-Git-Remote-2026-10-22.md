# CR-046 P14 — 관리 사본의 branch와 원격

범위: CRL-WBD-010 / C-154 / TC-WBD-010-H,N,F. P13(C-153) 위에서 같은 receipt·공통 writer 규칙을 쓴다. merge/rebase 충돌 해결, force push, 실제 외부 원격 push는 범위 밖이다. 현재 계약은 [Workbench](../current/workbench.md), 변경 근거는 [CR-046](../change-requests/CR-046-development-workbench.md)의 P14 절을 따른다.

## 구현

- 계약: `GitWriteCommand`에 `branch`, `switch`, `fetch`, `pull`, `push`를 더했다. `GitStatus`에 읽기 전용 `branches`·`remotes`를 더했다. 실패 reason에 `branch_in_use`, `dirty_tree`, `non_fast_forward`, `remote_unavailable`을 더했다.
- runner: branch·switch는 hooks를 끄고 `git switch [-c]`로 한다. pull은 `--ff-only --no-rebase`, push는 `refs/heads/<b>:refs/heads/<b>`로 force 없이 보낸다. 원격 작업(fetch/pull/push)은 신뢰 프로젝트에서만 접수되므로 사용자의 전역 Git 설정·credential helper·SSH agent를 쓰고 prompt는 끈다. hook은 `runHooks`를 켠 push(pre-push)에서만 실행한다.
- 사전조건: 새 branch 이름은 `git check-ref-format --branch`로 확인한다. 전환은 추적 변경이 있으면 `dirty_tree`로 거절하고 활성 writer는 기존 writer 규칙으로 거절한다. push는 사본이 그 branch에 있을 때만 하며, 보내기 전에 `ls-remote`로 원격 ref를 기록한다.
- 판정: branch·switch는 현재 branch, pull은 확인한 HEAD의 후손인지, push는 원격 ref가 현재 HEAD인지(그대로면 미적용, 다른 값이면 불확실)로 한다. fetch는 사용자 파일을 바꾸지 않으므로 나중에 다시 읽을 때 적용됨으로 정리한다.
- UI: Git 창의 "Branch & remote" 접힘 영역에서 새 branch 이름·만들기, 다른 branch 전환 버튼(접근성 이름 "Switch to {branch}"), Fetch/Pull/Push를 제공한다. 같은 사본의 미저장 문서가 있으면 전환을 보내지 않는다. 작업 뒤 Git을 다시 읽어도 접힘 영역의 열림 상태는 유지한다.

## 검증 (Linux, Git 2.43.0, Node 24.22.1)

- `apps/server/test/user-git-remote.test.ts` 4 PASS(먼저 4건 모두 실패하는 것을 확인)
  - detached 사본의 branch 생성·연결과 원본 branch 불변, push와 원격 ref 확인, 다른 곳의 push 뒤 fetch, 다른 branch 전환과 fast-forward pull.
  - 잘못된 이름, 원본에서 checkout 중인 `main`으로의 전환(`branch_in_use`), 갈라진 뒤 pull(`non_fast_forward`, HEAD 불변), 원격이 앞선 branch로의 push(`non_fast_forward`, 원격 불변), 없는 remote(`remote_unavailable`), pre-receive가 거절하는 원격, 추적 변경이 있는 전환(`dirty_tree`).
  - push 뒤 receipt 기록 실패와 재시작에서 같은 요청을 다시 보내도 원격을 다시 읽어 `succeeded`로 판정한다.
  - 활성 terminal writer가 있으면 전환이 거절된다.
- `GitPanel.test.tsx` 9 PASS(새 2건은 먼저 실패 확인): branch 만들기·fetch·push 명령 형식, force/reset/clean 조작이 없음, 미저장 문서가 있으면 전환을 보내지 않음.
- P13 시험 6건도 함께 PASS.
- 실제 앱(server build, Playwright Chromium, 로컬 bare remote): commit 뒤 "Branch & remote"에서 `feature/p14` 생성 → Push. 원격에 `refs/heads/feature/p14`가 생겼다. 콘솔 오류 0.

## 한계

- push는 upstream을 설정하지 않는다. 공유 저장소 설정(원본의 `.git/config`)에 쓰지 않기 위해서다. 그래서 push 뒤에도 "No upstream"으로 보이며 pull은 같은 이름의 원격 branch를 쓴다.
- 인증 실패는 Git 출력으로 구분한다. 실제 credential helper·SSH 원격·외부 호스트는 검증하지 않았다.
- Windows·macOS, 설치판, 스크린리더는 검증하지 않았다.
