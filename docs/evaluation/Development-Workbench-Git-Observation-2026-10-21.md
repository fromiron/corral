# CR-046 P12 — 읽기 전용 Git 관찰

범위: CRL-WBD-008 / C-152 / TC-WBD-008-H,N,F. 기준은 `8770f50`과 이 문서를 포함한 후속 P12 변경이다. P13의 stage/commit·hook/signer 실행이나 전체 Workbench 완료를 뜻하지 않는다. 현재 계약은 [Workbench](../current/workbench.md), 후속 범위와 중지·재개 메모는 [실행 계획](../plans/workbench-development-implementation-plan-2026-10-21.md)을 따른다.

## 구현

원본과 관리 사본을 명시적으로 선택하는 Git 패널과 읽기 API를 추가했다. 기존 내부 snapshot 비교는 유지한다. `UserGitTarget`의 host/project/binding과 세션/generation을 확인하며, canonical folder와 현재 Git root가 일치해야 한다. 연결된 중첩 저장소의 `.git`이 없어져 상위 저장소를 발견하면 기존 대상 이름으로 반환하지 않고 409를 준다.

porcelain v2의 NUL 레코드와 고정 필드를 파싱해 공백·한글·개행 경로를 보존한다. HEAD/branch/upstream/ahead/behind, detached/unborn/shallow, staged/unstaged/untracked·rename을 구분한다. staged는 HEAD blob→index blob, unstaged는 index blob→현재 디스크, untracked는 없음→현재 디스크다. blob은 원문 bytes를 읽으며 BOM·CRLF를 보존한다. binary/1MiB 초과는 해당 상태로, symlink/gitlink/unmerged 비교는 미지원으로 표시한다.

실제 `ls-files --stage -z`의 SHA-256을 index 기준으로 사용한다. 조회 전후 HEAD/index가 달라지면 409이며 클라이언트는 조용히 재요청하거나 다른 대상으로 바꾸지 않는다. 소스 변경과 새로고침은 이전 선택을 해제하고 늦은 응답을 버린다. 파일 목록은 2,000개로 제한하고 잘림을 표시한다. UTF-8로 손실 없이 표현할 수 없는 Git 경로는 명시적으로 거절한다.

기존 bounded argv runner와 filter 차단 환경을 재사용해 hooks/fsmonitor/pager/clean·smudge·process filters/textconv/외부 diff/lazy fetch를 실행하지 않는다. optional index write도 끈다. 기존 snapshot helper는 변경하지 않았다. 필터 설정이 있으면 원문 비교라는 제한을 표시한다. 새 의존성·DB migration·사용자 operation 원장은 없다. 데모 client는 기존 local-server-required 실패 방식을 유지한다.

## 검증 환경과 결과

Linux, Git 2.56.0, Node 24.19.0, pnpm 10.30.3, Vitest/jsdom, 실제 임시 Git/SQLite/관리 사본과 인앱 브라우저를 사용했다. 모델/Run 실행과 원격 쓰기는 없다. 최종 Studio entry는 `index-Crcu0408.js`, `dist/index.html` SHA-256은 `f3fe7d6bf82977543e8fdca06621411d32665b03351c2f7ee15c92d15eebd0e9`다. Vite의 기존 큰 chunk 경고는 남는다.

- 계약/client 집중 회귀 4 files / 20 PASS. URLSearchParams의 한글·공백·개행과 unborn HEAD, 오류 코드·무재시도를 확인했다. `/tmp/corral-p12-contract-client-regression.log`.
- 최종 Git helper/HTTP/UI/기존 Review attachments·패널/도킹 회귀 6 files / 35 PASS. helper 7개, 실제 HTTP 4개를 포함한다. `/tmp/corral-p12-final-focused.log`.
- 기존 files/documents-api/workspace-access/workspace-ownership는 최초 관련 묶음에서 PASS였다. 그 묶음은 7 files / 83 tests 중 새 UI 시험 1개가 실패했다. 원인은 jsdom에서 Base UI option의 단순 click이 선택을 활성화하지 않는 방식이었으며, 기존 테스트 패턴인 focus+Enter로 수정해 최종 묶음에서 통과했다. 최초 혼합 결과를 전체 PASS로 보고하지 않는다. `/tmp/corral-p12-regression.log`.
- `pnpm typecheck` 전체 PASS. 최초 발견된 데모 client 누락도 수정했다. Studio 최종 production build PASS. `/tmp/corral-p12-typecheck-final.log`, `/tmp/corral-p12-build-final.log`.
- 최종 `spec:check` 2498 checks, scenario tags 325/325, `contracts:check`, scoped Biome와 `git diff --check` PASS. Biome는 exit 0이며 변경 전 app/service 영역의 optional-chain·non-null assertion 경고 12개가 남는다. `/tmp/corral-p12-final-spec.log`, `/tmp/corral-p12-final-contracts.log`, `/tmp/corral-p12-final-biome.log`.
- 등록→의미 있는 red→구현을 따랐다. 초기 HTTP 404, 계약/client 미구현, 패널 등록 누락, status 조회 도중 외부 git add로 index 기준 혼합, 중첩 저장소에서 상위 Git 발견을 실패로 확인한 뒤 고쳤다. status race는 sleep 없이 Git 완료 경계에 외부 변경을 주입했다.
- 실제 sentinel 검사에서 filter/fsmonitor/textconv/external diff/hook 실행 표식이 없고 사용자 index bytes·mtime 및 내부 snapshot refs가 그대로였다. 별도의 사본 index·HEAD stale 및 diff 도중 외부 stage 거절을 확인했다. 기존 hunk가 사용자 index를 보존하는 시험은 `files.test.ts`의 TC-HUNK-001-H/N에 포함된다.
- fixture `/tmp/corral-p12-preview.ts --check`는 원본·사본 A/B·unborn, staged/unstaged 원문·rename·binary·특수 경로, 로컬 upstream과 detached, index/HEAD/refs 불변을 실제 REST로 확인하고 자원을 정리했다. 새 E2E나 빡빡한 시간 기준은 추가하지 않았다.

## 실제 인앱 관찰

1. 사본 A의 `p12-copy-a`, origin/main 앞섬 1/뒤처짐 0을 확인했다. `hello.ts`의 staged는 HEAD baseline→copy A index, unstaged는 copy A index→copy A worktree였다. 기존 diff renderer의 unified/raw와 binary 안내를 실제로 사용했다.
2. 프로젝트 원본으로 전환하자 main과 별도 index가 표시되고 이전 diff 선택은 사라졌다. 상태를 읽은 뒤 fixture의 외부 Git으로 stage하고 기존 항목을 선택하면 stale 안내가 표시됐다. 수동 새로고침 후 재선택한 원문에는 새 stage 내용이 나왔다. 이 외부 변경은 격리 fixture에만 수행했다.
3. 한글·공백·개행 이름의 untracked 파일을 선택해 정확한 원본 내용을 확인했다. 사본 B로 이동하면 source가 세션 사본으로 초기화되고 detached HEAD와 copy B의 index/작업 파일이 표시됐다.
4. unborn 세션은 사본 없음 안내를 보여주고 자동 생성하지 않았다. 명시적으로 원본을 선택하면 fresh 브랜치·커밋 없음·staged/unstaged가 보였고 HEAD가 없는 추가 파일 diff가 표시됐다.
5. 390×844에서 Git 패널을 최대화하고 source/새로고침/목록/diff를 확인했다. document scrollWidth=390이며 diff 본문은 자체 가로 스크롤을 사용했다. 인앱 warn/error 로그는 0이었다.

최종 빌드 후 별도 서버를 다시 시작하고 실제 로드된 `index-Crcu0408.js`와 사본 A의 index→작업 파일 diff를 재확인했다. 모든 임시 탭·서버·저장소와 viewport override를 정리했다.

화면 증거: `/tmp/corral-p12-git-desktop.png`, `/tmp/corral-p12-git-stale.png`, `/tmp/corral-p12-git-390.png`. 임시 자산은 배포 산출물이 아니다.

읽기 결과는 OS 전체의 원자적 snapshot이 아니다. 사본·HEAD/index 전후 기준과 기존 bounded file read로 확인되는 범위만 보장한다. unmerged/symlink/gitlink의 내용을 편집·해결하지 않으며 submodule 내부 dirty는 조사하지 않는다. 전체 release gate·Windows/macOS·설치판 GUI·스크린리더·실제 OS IME는 이번 범위에서 실행하지 않았다. P13부터의 사용자 Git 쓰기 정책과 개발 여정은 다음 재개 시 다룬다.
