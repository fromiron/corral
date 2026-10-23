# P22 공유 개발 owner — 구현·Linux 검증

- 날짜: 2026-10-23. 기준 `00d19ff` 위 이 문서를 포함한 변경 묶음. 승인: CR-046 P22 B안. 추적: CRL-WBD-017 / C-161 / TC-WBD-017-H,N,F.
- 환경: Linux, Node 24.19.0, pnpm 10.30.3, 실제 Git·SQLite·Node HTTP·Vite 8.3.4, Studio production build와 Chromium 인앱 브라우저. 모델 호출은 하지 않았다.
- 현재 계약은 CR-046 P22·`docs/current/workbench.md`·API 계약이다. 이 기록은 실행 증거이며 전체 제품/설치판 release gate가 아니다.

## 구현

기존 공통 예약에 `development` 사람 operation을 연결했다. 하나의 writer 아래 문서 변경·명시 task·Git stage/unstage/commit/fetch/push만 비-writer access로 접수한다. agent writer·PTY·branch 생성/전환·pull은 거절한다. 별도 DB 열·원장·의존성은 추가하지 않았다.

모드는 현재 running/uncertain operation에서 읽는다. host 재시작은 uncertain이고 자동 재개하지 않는다. 정확한 target·generation·operation ID로 끝내며 다른 사람 owner가 active/uncertain이면 종료를 거절한다. 이미 끝난 owner의 늦은 종료는 새 owner를 끝내지 않는다. 기본 서버는 비활성이고 로컬 Desktop sidecar·`corral dev`만 명시 opt-in한다. 이는 서버의 물리적 위치를 탐지하는 기능이 아니다.

동일 컴포넌트를 사본 머리·작업 창·Composer의 writer 거절 위치에서 사용한다. 저장 거절 뒤 공유가 가능해지면 문서 재읽기가 초안을 보존한 채 writer 오류를 해제한다. 종료 차단 메시지는 한국어/영어 메시지 체계를 쓴다.

## 자동 검증

| 검사 | 결과 | 근거 |
|---|---|---|
| 계약·추적 등록 | PASS | spec 2654 checks, tagged 352/352, `/tmp/corral-p22-registration.log` |
| 서버 red | 3 FAIL 확인 | 새 모드 API 부재. 잘못된 fixture 타입을 먼저 고친 뒤 의미 있는 실패 확인, `/tmp/corral-p22-red.log` |
| UI red | FAIL 확인 | 새 컨트롤 부재, `/tmp/corral-p22-ui-red.log` |
| 저장 거절 해제 red | FAIL 확인 | fresh writable read 뒤 writerBusy/error가 남고 초안은 유지, `/tmp/corral-p22-writer-red.log` |
| 종료 차단 번역 red | 1 FAIL 확인 | 서버 원문 대신 안내 문구를 기대한 assertion 실패, `/tmp/corral-p22-localization-red.log` |
| 소유권·task·Git·문서·UI 회귀 | 11 files / 46 tests PASS | shared-development/routes, workbench-operations, workspace-access, reader-reservation, user-tasks, git-write/remote, DevelopmentMode, document store, WriterHeld. `/tmp/corral-p22-regression.log` |
| 최종 UI·문서·CLI·패키징 회귀 | 5 files / 48 tests PASS | DevelopmentMode, document store, documents, CLI, Desktop packaging. `/tmp/corral-p22-final-regression.log` |
| 고정 snapshot·문서 HTTP·사본 삭제 회귀 | 3 files / 9 tests PASS | shared-development, documents-api, copy-lifecycle-routes. `/tmp/corral-p22-snapshot-regression.log` |
| 종료된 진입 ID 재요청·최종 API | 2 files / 5 tests PASS | `/tmp/corral-p22-final-api.log` |
| 전체 타입 검사 | PASS | `/tmp/corral-p22-final-typecheck.log` |
| Studio production build | PASS | `/tmp/corral-p22-final-build.log`; 기존 500 kB chunk 경고 유지 |
| 최종 문서·계약 검사 | PASS | spec 2641 checks·tagged 352/352, JSON Schema 최신. `/tmp/corral-p22-final-spec.log`, `/tmp/corral-p22-contracts.log` |
| 변경 파일 Biome·공백 검사 | 오류 없음 | 기존 service/app의 13 warnings, `/tmp/corral-p22-biome.log`; `git diff --check` |

위 묶음은 중복 시험을 포함하므로 수를 합산하지 않는다. 실제 HTTP 테스트는 인증·CSRF를 거쳐 로컬 opt-in, foreign target, 원본 모양 요청 거절과 정확한 owner 종료를 확인한다. 서비스 테스트는 실제 task를 켠 채 save→HTTP 내용 변경, stage/commit, snapshot 검사, 실행 중 종료 차단과 정리 후 strict 복귀를 확인한다. 읽기 전용 Run 두 개는 저장 전후 각자의 snapshot을 유지한다. 재시작 후 불확실한 하위 효과를 성공으로 임의 확정하지 않는다.

## 실제 화면

격리된 임시 Git 프로젝트를 production Studio에서 열어 다음을 수행했다. 개인 작업 공간과 실제 사용자 서버는 수정하지 않았다.

1. 작업 창에서 공유 모드를 켜고 `dev`를 눌러 실제 Vite 서버를 시작했다.
2. 실행 중 모드 종료를 누르면 거절되고 개발 owner와 task가 유지됐다.
3. Monaco에서 `main.js`의 `P22 before save`를 `P22 saved while Vite is running`으로 저장했다. Vite 프로세스는 계속 실행 중이고 원본 Git 폴더의 파일은 바뀌지 않았다.
4. 별도로 연 Vite 페이지의 제목이 페이지 이동/새로고침 없이 바뀌었다(HMR). 같은 시점 Corral의 소유권 인증 preview proxy로 `/main.js`를 읽어 HTTP 200과 저장된 내용을 확인했다.
5. `P22 unsaved draft` 초안을 남긴 상태에서 외부 fixture writer가 `P22 external change`로 디스크를 바꿨다. 저장은 CAS 충돌로 거절되고 비교 화면에 두 내용이 각각 남았다. 디스크 버전을 명시 선택한 뒤 task 중지·정리, 개발 모드 종료로 단독 쓰기로 돌아갔다.
6. CSS viewport 390×844에서 공유 모드 진입·종료와 안내 접근을 확인했다. 브라우저 배율 때문에 실제 `innerWidth`를 확인하고 검증 뒤 override를 해제했다.
7. 종료 차단 번역을 반영한 최종 build를 새 fixture 서버에서 다시 열어 모드 진입·실제 Vite 실행·한국어 차단 안내·task 중지·strict 복귀를 확인했다.

검증 후 임시 서버·개발 task·브라우저 탭·viewport override를 정리했다.

화면 증거: `/tmp/corral-p22-live-preview.png`, `/tmp/corral-p22-conflict.png`, `/tmp/corral-p22-390px.png`, `/tmp/corral-p22-final.png`. 임시 원시 자산이므로 장기 보관 파일로 간주하지 않는다.

## 남은 검증과 되돌리기

- 인앱 브라우저 도구가 preview 인증 헤더 설정을 지원하지 않아 Desktop의 대화형 preview 프레임 자체는 검증하지 않았다. 직접 Vite HMR과 인증 proxy HTTP 응답을 구분한다.
- P21-B 원격 host, Windows/macOS, 설치판 전체, 실제 IME·스크린리더, terminal transport 재연결과 P16 R0 통합 여정은 별도다. 기존 PR #69/#85 게시물은 수정하지 않았다.
- 외부 프로세스의 임의 쓰기는 격리되지 않으며 hash 확인·atomic rename을 OS 전체 CAS로 주장하지 않는다. P17의 external/mixed·stale 근거 표시를 유지한다.
- 되돌릴 때는 공유 task를 정리하고 개발 모드를 명시 종료한 뒤 이 변경을 revert한다. 불확실 예약을 삭제하거나 사용자 파일/index를 reset하지 않는다. 열린 owner를 남긴 채 구버전으로 내리면 종료 UI가 없으므로 먼저 정리가 필요하다.


검증 코드/빌드 SHA-256:

- `apps/server/src/files/workbench-operations.ts`: `f2152398e08d1b1906e51af25f2c252ad1d1d77fe53dca560a4e09fe271f3ef7`
- `apps/studio/src/workbench/DevelopmentMode.tsx`: `69c11f6f563580e820928b98ca9f3915688726937ff96a576801f0235f977e14`
- `apps/studio/dist/index.html`: `700806c34f632d8540a8212ac37e5de98115033557fd53e8ab2d3fc0afc69cd9`
