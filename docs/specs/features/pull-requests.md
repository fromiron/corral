# 기능 명세: 풀 리퀘스트

- 상태: accepted
- 비목표: GitHub가 아닌 호스팅(GitHub Enterprise 포함), 포크에서 여는 PR, 토큰 입력과 저장, PR 병합·닫기·리뷰 댓글 쓰기, 리뷰·댓글로 에이전트 깨우기, 감시를 끄는 스위치, 초안 PR, 리뷰어·라벨 지정

세션의 Paddock 브랜치에서 GitHub 풀 리퀘스트(PR)를 열고, 그 PR의 상태를 변경 탭에서 본다. Corral은 사람이 로그인한 `gh`(GitHub CLI)를 실행할 뿐이며 토큰을 읽거나 저장하지 않는다.

## 사용자 관측 동작

- **자리.** 변경 탭 머리 아래의 PR 줄 하나. 모든 보조 보기(검토·Git·체크포인트·검사)에서 같다. 다음이 모두 맞을 때만 줄을 생각한다.
  - 세션에 Paddock이 있고, 그 사본이 브랜치 위에 있다(detached가 아니다).
  - 프로젝트 원본 저장소의 `origin` 원격이 `github.com`의 저장소다.
  - 그 브랜치가 저장소의 기본 브랜치가 아니다.
  - 첫 읽기가 답하기 전에는 줄이 없다.
- **세션의 PR.** Paddock의 지금 브랜치를 head로 하는 PR이다. 열린 PR이 있으면 그것이고, 없으면 그 브랜치의 가장 최근 PR(합쳐짐·닫힘)이다. 에이전트가 셸로 연 PR도, 사람이 GitHub에서 연 PR도 같은 방법으로 찾는다. 브랜치를 바꾸면 그 브랜치의 PR이 된다.
- **열린 PR이 있을 때.** 줄은 PR 번호, 상태(열림, 초안이면 초안), 검사(통과·실패 수·진행 중), 리뷰 결정(승인·변경 요청·리뷰 필요), 충돌이면 충돌, "GitHub에서 보기"(새 창)를 보인다. 검사나 리뷰 정보가 없으면 그 칸은 없다.
  - 사본의 HEAD가 PR의 head 커밋보다 앞서 있으면(PR의 head가 HEAD의 조상) "올리기"(Push)가 있다. 누르면 Git 보기의 push와 같다.
- **열린 PR이 없을 때.** 기본 브랜치에 없는 커밋이 있으면 그때 할 수 있는 행동 하나를 둔다. 그 브랜치의 지난 PR(합쳐짐·닫힘)이 있으면 행동 옆에 그 번호와 상태를 함께 보인다.
  - 원격에 그 브랜치가 없거나 로컬이 원격보다 앞서 있으면 "올리고 PR 열기"(Push and open PR).
  - 원격 브랜치와 같으면 "PR 열기"(Open PR).
  - 원격 브랜치가 앞서 있거나 갈라졌으면 행동 대신 "Git 보기에서 맞추기"(Sync in Git)가 있고, 누르면 Git 보기가 열린다.
  - 기본 브랜치에 없는 커밋이 없으면, 지난 PR이 있으면 그것만 보이고 없으면 줄이 없다.
  - 기본 브랜치에 없는지는 사본의 `origin/<기본 브랜치>`(없으면 로컬 `<기본 브랜치>`)와 견준다. 둘 다 없으면 커밋이 있다고 보고 행동을 둔다. GitHub가 거절하면 그 까닭을 보인다.
  - 커밋하지 않은 변경은 PR에 들어가지 않으며 행동을 막지 않는다.
- **PR 열기.** 행동을 누르면 대화상자가 열린다. base(저장소의 기본 브랜치)와 head 브랜치를 보이고, 제목과 본문은 고칠 수 있는 칸이다.
  - 처음에 제목과 본문은 초안으로 채워진다. 초안은 세션의 가장 최근 요청이 쓴 모델이 쓰고, 그런 요청이 없으면 세션의 자동 모드 모델, 그것도 없으면 모델 설정에서 쓸 수 있는 첫 모델이 쓴다. 쓰는 동안 두 칸은 "초안 쓰는 중"이고, 사람이 먼저 고치기 시작하면 초안은 칸을 덮지 않는다. 대화상자를 닫으면 진행 중인 초안 요청을 멈춘다.
  - 모델이 없거나 초안이 실패하면 커밋 목록으로 채운다. 제목은 커밋이 하나면 그 제목, 여럿이면 가장 최근 커밋의 제목이다. 본문은 "## Summary" 아래 커밋 제목마다 한 줄, 그리고 "## Testing" 아래 "Not run"이다.
  - 초안에서 Paddock과 원본 폴더의 절대 경로는 저장소 안의 상대 경로로 바뀐다.
  - 제목이 비어 있으면 보낼 수 없다. "PR 열기"는 대화상자를 연 때의 head 커밋으로 보낸다. 그사이 커밋이 늘었으면 서버가 거절하고, 대화상자는 브랜치가 바뀌었다고 말한다. 다시 열면 새 head로 시작한다.
  - "올리고 PR 열기"는 먼저 Git 보기의 push 명령(강제 없음)을 보내고, 성공하면 PR을 연다. push가 실패하면 PR을 열지 않고 Git 보기와 같은 실패를 보인다. push는 됐고 PR 열기가 실패했으면 줄은 "PR 열기"로 남는다. 대화상자의 push는 한 작업 ID를 쓰고, 다시 누르면 그 ID의 결과를 먼저 읽어 이미 끝난 push를 다시 보내지 않는다. push가 확실히 실패했을 때만 다음 시도가 새 ID를 쓴다. PR 줄의 "올리기"도 같다.
  - PR 열기의 결과를 모르면(응답을 잃었거나 `gh`가 시간 안에 끝나지 않았다) 대화상자는 결과를 확인하는 중이라고 말하고 그 브랜치의 PR을 다시 읽는다. 열린 PR이 있으면 그것이 결과다.
  - 열리면 대화상자가 닫히고 줄은 새 PR을 보인다.
- **서브세션.** 서브세션 변경 탭은 "부모에 합치기"가 머리에 있고 PR 줄은 그 아래다. 서브세션 PR의 base도 저장소의 기본 브랜치이므로, 서브세션이 시작할 때 부모에게서 받은 커밋 가운데 기본 브랜치에 없는 것도 PR에 들어간다.
- **읽는 때.** 사본의 로컬 상태(브랜치, HEAD, 앞섬)는 Git 보기의 커밋·브랜치·전환·pull·push가 끝났을 때, 그 세션의 실행이 시작하거나 끝났을 때, 변경 탭이 화면에 나올 때, Git 보기의 새로 고침에 읽는다. 화면은 GitHub(`gh`)를 변경 탭이 화면에 나올 때, 새로 고침, 그 세션의 실행이 끝났을 때, PR 줄의 행동 뒤에 읽는다. 서버는 세션의 실행이 끝날 때 화면과 상관없이 그 세션의 PR을 읽고, 감시 중인 PR을 2분마다 읽는다(아래 감시).
- **감시.** 서버가 세션 브랜치의 열린 PR을 처음 읽으면 그 PR의 감시가 시작된다.
  - 처음 읽었을 때 이미 있던 검사 실패와 충돌은 기준이다. 아무도 깨우지 않고 PR 줄에만 보인다.
  - 감시 중인 PR은 2분마다 읽는다. 감시 중인 PR이 없으면 주기적으로 읽지 않는다.
  - PR이 합쳐지거나 닫히면, 사본의 브랜치가 바뀌면, 세션이 보관되거나 지워지면 감시가 끝난다. 감시를 끄는 스위치는 없다. 자동 시작을 끄면 깨우기는 카드로 남고, 카드는 지울 수 있으며, 연속 깨우기는 세 번까지다.
- **깨우기.** 감시 중인 PR에서 새로 실패한 검사(지금 head 커밋에서 처음 실패로 본 검사)나 새 충돌이 보이면 에이전트를 깨운다. head가 바뀌면 실패와 충돌 기록을 새로 시작하고, 충돌은 풀릴 때까지 한 번만 깨운다.
  - 깨우기는 대기열에 Corral의 알림 요청을 하나 넣는다. 시작 선택(모델·팀·권한)은 세션에서 시작 선택이 남은 가장 최근 요청의 것이다. 세션의 자동 시작 설정을 따르고, 실행 중이면 그 실행이 끝난 뒤 시작한다. 그런 요청이 없으면 깨우지 않고 확인 필요 항목을 만든다.
  - 알림 글은 에이전트에게 쓰는 영어이고 "Note from Corral, not from the person"로 시작한다. PR 번호와 주소, 실패한 검사의 이름과 주소(열 개까지), 충돌이면 그 사실만 싣는다. 검사의 로그나 댓글 글은 싣지 않는다.
  - 대화에서 그 요청은 메타 줄에 "PR 감시가 보냄"(Sent by the PR watch)을 단다.
  - 한 PR에 아직 시작하지 않은 깨우기는 하나뿐이다. 그것이 대기하는 동안 head가 바뀌거나 PR이 열려 있지 않게 되면 서버가 그 카드를 지운다.
  - 사람의 요청 없이 연속 세 번 깨웠으면 더 깨우지 않고 확인 필요 항목을 만든다. 사람이 그 세션에 요청을 보내면 다시 센다.
  - 감시 상태는 깨우기 요청이 저장된 뒤에만 나아간다. 검사를 읽지 못했거나 목록이 비어 있으면 앞의 상태를 그대로 둔다.
- **확인 필요.** 감시 중인 PR의 리뷰 결정이 바뀌었거나 새 리뷰·댓글이 있으면, 또는 자동 깨우기가 멈췄거나 깨울 시작 선택이 없으면 [확인 필요](inbox.md)의 `pull_request` 항목이 생긴다. 항목은 종류만 말하고 댓글 글은 싣지 않으며, 주 버튼은 그 세션의 변경 탭을 연다. 리뷰·댓글 항목은 화면이 그 PR을 GitHub에서 읽으면 사라진다. 리뷰와 댓글은 에이전트를 깨우지 않는다.
- **gh가 없거나 쓸 수 없을 때.** 열 것이 있을 때(기본 브랜치에 없는 커밋이 있을 때)만 줄이 그 이유와 다음 단계를 한 번 말하고, 행동은 없다.
  - `gh`가 없다: "GitHub CLI(gh)를 설치하면 여기서 PR을 엽니다"(Install the GitHub CLI (gh) to open pull requests here).
  - 로그인하지 않았다: "터미널에서 gh auth login을 실행하세요"(Run gh auth login in a terminal).
  - 읽지 못했다(네트워크 등): "PR을 읽지 못했습니다"(Couldn't read the pull request)와 "다시 시도".

## 계약

- **gh 실행.** 서버가 `gh`를 자식 프로세스로 실행한다.
  - 작업 폴더는 Corral 데이터 폴더 안의 `pull-requests`(서버가 켜질 때 만든다)이고, 저장소는 늘 `--repo <owner>/<name>`으로 준다. 저장소의 Git 설정이나 hook을 `gh`가 읽지 않게 하기 위해서다.
  - 환경에 `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `NO_COLOR=1`, `GH_PAGER=cat`을 더한다. 사람의 `gh` 설정(로그인)은 그대로 쓴다.
  - 한 번에 30초까지 기다리고, 넘으면 프로세스를 끝내고 결과를 모름으로 둔다.
  - 토큰을 읽거나 묻지 않는다. `gh`의 출력은 로그에 남기지 않는다. 실패는 실행 파일이 없음(`gh_missing`), 종료 코드 4(`gh_signed_out`), 그 밖(`unavailable`)으로만 나눈다.
- **저장소.** 원본 폴더에 설정된 `remote.origin.url`(`insteadOf` 재작성 전의 값)이 `https://github.com/<owner>/<name>(.git)`, `git@github.com:<owner>/<name>(.git)`, `ssh://git@github.com/<owner>/<name>(.git)`일 때만 GitHub 저장소다.
- **기본 브랜치.** 원본 폴더의 `git symbolic-ref refs/remotes/origin/HEAD`가 있으면 그것이고, 없으면 `gh repo view <owner>/<name> --json defaultBranchRef`로 읽는다. 서버가 켜져 있는 동안 연결마다 기억한다.
- **PR 읽기.** `GET /api/v1/sessions/:sessionId/pull-request`, 질의 `remote=1`이면 GitHub도 읽는다.
  - 로컬: 사본의 브랜치, HEAD, `refs/remotes/origin/<branch>`(없으면 원격 브랜치 없음)에 대한 앞섬·뒤처짐, 기본 브랜치에 없는 커밋 수.
  - GitHub: `gh pr list --repo <r> --head <branch> --state all --limit 20 --json number,url,state,isDraft,title,headRefOid,baseRefName,updatedAt,statusCheckRollup,reviewDecision,mergeable`. 열린 것이 있으면 그것을, 없으면 `updatedAt`이 가장 늦은 것을 고른다. 결과는 세션과 브랜치마다 서버 메모리에 남고, `remote=1`이 없는 읽기는 그 남은 결과를 함께 돌려준다.
  - 응답은 `PullRequestView`(`packages/contracts`)다: 줄이 없는 경우(`hidden`과 그 이유), PR 없음(행동과 지난 PR), PR 있음(PR과 push 필요 여부), `gh_missing`, `gh_signed_out`, `read_failed`.
- **초안.** `POST /api/v1/sessions/:sessionId/pull-request/draft`, 본문 `{ operationId }`. 돌려주는 것은 `{ title, body, head, base, source }`이고 `source`는 `model` 또는 `commits`다.
  - 모델 입력은 base·head 브랜치, 커밋 목록(12,000자까지), diff 통계(12,000자까지), diff(40,000자까지)다. 넘는 부분은 잘리고 `[truncated]`가 붙는다. 시스템 지침은 `apps/server/src/pull-requests/prompt.ts`에 있다. 대화 기록은 넣지 않는다.
  - 모델 답은 `{ "title", "body" }` JSON이다. 제목은 첫 줄만 쓰고, 비거나 읽을 수 없으면 커밋 목록 초안으로 간다.
  - 모델 요청은 팀 도우미와 같은 작업 기록(`model_operations`)을 쓴다. 같은 `operationId`는 한 번만 보내고, 요청이 끊기면(대화상자를 닫으면) 멈춘다.
- **열기.** `POST /api/v1/sessions/:sessionId/pull-request`, 본문 `{ operationId, title, body, head }`.
  - 사본의 브랜치와 HEAD가 `head`(브랜치와 커밋)와 다르면 `REVISION_CONFLICT`로 거절한다.
  - 같은 브랜치에 열린 PR이 이미 있으면 새로 열지 않고 그 PR을 돌려준다. 응답을 잃은 재전송도 이 조회가 먼저라서 PR이 둘 생기지 않는다.
  - PR은 `gh pr create --repo <r> --head <branch> --base <base> --title <title> --body-file <임시 파일>`로 연다. 임시 파일은 Corral 데이터 폴더 안에 0600으로 만들고 끝나면 지운다.
  - 결과는 같은 `operationId`의 재요청에 처음 결과로 돌아간다. 30초를 넘겨 결과를 모르면 `REQUEST_OUTCOME_UNKNOWN`이고, 화면은 브랜치로 다시 읽어 확인한다.
  - push는 이 명령에 들어 있지 않다. 화면이 Git 보기의 push 명령을 먼저 보낸다.
- **서브세션.** 서브세션의 base도 저장소 기본 브랜치다. 부모의 브랜치를 base로 쓰지 않는다.
- **감시 기록.** `pull_request_watches`에 세션마다 한 줄: 브랜치, PR 번호·주소·base, 감시가 본 head, 그 head에서 실패로 본 검사 이름, 충돌 여부, 연속 깨우기 수, 리뷰 결정, 감시가 본 리뷰·댓글 수와 화면이 본 수, 아직 시작하지 않은 깨우기의 entryId, 확인 필요 사유, 시작·끝 시각. 서버가 다시 켜지면 끝나지 않은 감시를 잇는다. 세션을 지우면 그 줄도 지운다.
- **감시 읽기.** PR 읽기와 같은 `gh pr list`에 `comments,reviews` 필드를 더한다. 검사의 이름은 `name`(CheckRun) 또는 `context`(StatusContext), 주소는 `detailsUrl` 또는 `targetUrl`이다. 2분 주기와 시각은 주입한 타이머와 시계를 쓴다.
- **깨우기 요청.** 대기 요청 `SessionEntry`에 `pullRequest: { number, headSha }`가 붙는다. 사람의 요청이 저장되면 그 세션의 연속 깨우기 수를 0으로 되돌린다.
- **확인 필요 항목.** 종류는 `pull_request`이고 [확인 필요](inbox.md)의 검토 묶음에 든다. 요약은 PR 번호와 사유(`review`, `remarks`, `wakes_stopped`, `no_start`) 하나다.

## 수용 시나리오

```gherkin
Scenario: 커밋을 올리고 PR을 연다
  Given 세션의 Paddock 브랜치에 기본 브랜치에 없는 커밋 두 개가 있고 원격에 그 브랜치가 없다
  Then PR 줄에 "올리고 PR 열기"가 있다
  When 사람이 누르고 초안을 고친 뒤 "PR 열기"를 누른다
  Then 브랜치가 push되고 그 제목과 본문으로 PR이 열린다
  And 줄은 새 PR 번호와 "열림"을 보인다

Scenario: 합쳐진 PR 뒤의 새 커밋
  Given 브랜치의 PR #7이 합쳐졌고 그 뒤 브랜치에 새 커밋이 하나 있다
  Then PR 줄은 지난 PR #7과 "합쳐짐"을 보이고 "올리고 PR 열기"가 있다

Scenario: gh가 없고 열 것도 없다
  Given gh가 설치돼 있지 않고 기본 브랜치에 없는 커밋이 없다
  Then PR 줄은 없다

Scenario: 에이전트가 셸로 연 PR을 찾는다
  Given 에이전트가 run_command로 gh pr create를 실행해 그 브랜치의 PR을 열었다
  When 그 실행이 끝난다
  Then PR 줄은 그 PR을 보인다

Scenario: 응답을 잃은 열기
  Given PR 열기의 응답을 잃었다
  When 같은 요청을 다시 보낸다
  Then 새 PR을 만들지 않고 이미 열린 PR을 돌려준다

Scenario: 그사이 커밋이 늘었다
  Given 대화상자를 연 뒤 에이전트가 커밋을 하나 더 했다
  When 사람이 "PR 열기"를 누른다
  Then 서버는 REVISION_CONFLICT로 거절하고 PR을 열지 않는다

Scenario: 모델 없이 초안
  Given 쓸 수 있는 모델이 없다
  When 대화상자를 연다
  Then 제목은 가장 최근 커밋의 제목이고 본문은 커밋 목록과 "Not run"이다

Scenario: 처음 본 실패는 깨우지 않는다
  Given 감시가 시작될 때 PR의 검사 하나가 이미 실패해 있다
  Then 대기열에 아무것도 생기지 않고 PR 줄이 실패를 보인다

Scenario: 새로 실패한 검사가 깨운다
  Given 감시 중인 PR의 다른 검사가 새로 실패했다
  When 2분 주기 읽기가 그것을 본다
  Then 대기열에 PR 감시의 알림 요청이 하나 생기고 세션의 자동 시작대로 시작한다
  And 같은 실패로 다시 깨우지 않는다

Scenario: 연속 세 번 뒤 멈춘다
  Given 사람의 요청 없이 같은 PR로 세 번 깨웠다
  When 네 번째 새 실패가 보인다
  Then 깨우지 않고 확인 필요에 pull_request 항목이 생긴다

Scenario: 대기 중인 깨우기가 낡았다
  Given 깨우기 요청이 아직 시작하지 않았는데 에이전트가 새 커밋을 올렸다
  Then 서버가 그 깨우기 카드를 지운다

Scenario: gh를 쓸 수 없다
  Given gh가 설치돼 있지 않다
  Then PR 줄은 gh 설치를 말하고 행동이 없다
  And 서버는 토큰을 찾거나 묻지 않는다

Scenario: GitHub가 아니다
  Given 원격이 GitHub가 아니거나 원격이 없다
  Then PR 줄은 없다
```

## 보안·성능·접근성

- `gh`는 사람의 로그인으로 GitHub에 쓴다. 이 화면의 PR 열기는 사람이 대화상자에서 누를 때만 일어나고, 에이전트를 통하지 않는다.
- PR 본문은 공개된다. 초안은 Paddock과 원본 폴더의 절대 경로를 상대 경로로 바꾸고, 사람이 보내기 전에 본다.
- GitHub 호출은 사람이 연 화면이 읽을 때, 실행이 끝날 때, 감시 중인 PR을 2분마다 읽을 때 일어난다. 감시 중인 PR이 없으면 주기 조회가 없다.
- 깨우기는 사람 없이 유료 실행을 시작한다. 그래서 처음 본 실패는 깨우지 않고, 연속 깨우기는 세 번까지이며, 외부 사람이 쓴 리뷰·댓글의 글은 에이전트에게 넘기지 않는다.
- 행동 버튼은 접근 이름이 그 행동이고, 상태는 글로 말한다(색만으로 말하지 않는다).
