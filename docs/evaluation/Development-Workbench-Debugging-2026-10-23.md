# P26 DAP 디버깅 — 구현·핵심 검증

- 기준: `83c7897` 위 이 문서를 포함한 P26·P27 구현 묶음. CR-046 P26, CRL-WBD-023/C-167/TC-WBD-023-H,N,F.
- Linux x64, Node 24.19.0, 격리된 실제 Git/SQLite/작업 사본과 production Studio. 개인 DB·원본 프로젝트·외부 계정·유료 모델을 쓰지 않았다.
- 기존 도킹·문서 모델·공통 writer/process capacity·operation receipt·preview 소유권을 재사용한다. 디버거 pane을 닫는 것은 실행 종료가 아니다.

## 어댑터와 기존 의존성 재사용

Microsoft의 standalone [js-debug v1.140.0](https://github.com/microsoft/vscode-js-debug/releases/tag/v1.140.0)을 임시 검증 디렉터리에 받아 Node와 Chromium을 확인했다. MIT, VS Code extension host 없이 동작하는 DAP server이며 제품에서 자동 설치하거나 번들하지 않는다. 압축 자산 SHA-256은 `27dab92937ec1ab35821ae955aac867544fe06a1b6307229049f2d789af10968`이다. entry 파일만이 아니라 전체 배포 디렉터리가 필요하다.

기존 설치된 안정판 `playwright-core@1.64.1`을 server 직접 의존성으로 명시해 Chromium의 격리 문맥·HTTP/WS routing을 재사용했다. Apache-2.0, 내장 TypeScript 타입, Node >=20, 설치된 크기 약 14 MB이며 브라우저 다운로드와 Studio bundle 증가는 없다. 새 preview gateway·credential 저장소는 추가하지 않았다. 고지·lockfile·의존성 목록을 함께 갱신했다.

독립 adapter qualification에서 Node·Chromium 156.0.8078.47의 소스 매핑 중단점·변수·평가·step, root/child DAP 연결 종료를 확인했다. browser는 adapter에 실행을 맡기지 않고 broker가 소유한 프로세스에 attach한다. Playwright와 DAP가 같은 소유 browser에 연결돼 authenticated preview HTTP/WS를 유지하고 외부 HTTP/WS·redirect를 차단하는 것도 확인했다. 이 실험은 제품 화면 검증과 구분한다. 원시 기록은 `/tmp/corral-p26-debug-tools/qualification.json`, `qualification-routing.json`이다.

## 핵심 회귀

| 범위 | 결과 | 로그 |
|---|---|---|
| broker·기존 DB migration | 5 PASS | `/tmp/corral-p26-broker-migration-final.log` |
| 기존 P22 공유 개발·LSP | 12 PASS | `/tmp/corral-p26-broker-core-regression.log` |
| DAP framing·reverse child·종료 | 3 PASS | `/tmp/corral-p26-dap-green.log` |
| 소유 프로세스·inspector bridge | 4 PASS | `/tmp/corral-p26-debug-processes-green.log` |
| preview 인증·HTTP/WS 범위·폐기 | 2 PASS | `/tmp/corral-p26-debug-browser-green.log` |
| UI 컨트롤·설정·패널·기존 설정 보존 | 4파일 12 PASS | `/tmp/corral-p26-controls-regression.log` |
| debug store·Monaco·기존 문서 | 4파일 17 PASS | `/tmp/corral-p26-debug-regression.log` |
| 공통 HTTP 인증·대상·임의 주소 거절 | 1 PASS | `/tmp/corral-p26-p27-http-green.log` |

추가 통합 확인에서 MCP 추가/삭제·금고 가져오기/롤백의 새 설정 보존 3개가 통과했다(`/tmp/corral-p26-p27-mcp-preservation-green.log`, red 기록 같은 접두어). 평가 프레임 선택 전 제출 거절과 선택 후 frame ID 전송도 기존 2개 UI 시험으로 확인했다(`/tmp/corral-p26-evaluate-frame-green.log`).

로그 이름과 시험 수는 중복 실행을 합산하지 않는다. 동시 시작 admission, 응답 유실·늦은 이벤트, 진행 중 평가의 명시 종료, 분할 출력의 환경 비밀값, 빈 outFiles의 기본 매핑 유실, dirty 초안·stale 소스 및 설정 저장 때 새 필드 유실을 실패 반례로 확인하고 수정했다. root/child cleanup은 동시에 요청하며 종료 확인 전 process reservation을 해제하지 않는다.

## 실제 앱 화면

인앱 브라우저 1280×720에서 Node 구성을 검토·신뢰한 뒤 실행했다. 원래 `src/main.ts`로 스택을 열고 한 줄 실행한 뒤 Monaco F9로 3행 중단점을 설정했다. 계속 실행하자 TypeScript 3행에서 멈췄고 Closure 변수 `count: 41`, 명시 평가 `count + 1`의 결과 `42`를 확인했다. **실행 종료** 뒤 상태가 종료됨으로 바뀌었다. `/tmp/corral-p26-node-debug.png`에 소스·중단점·변수·평가를 함께 저장했다.

브라우저 fixture는 기존 API로 공유 개발·dev task·managed preview를 준비했다. 실제 앱에서 Browser 구성을 검토·실행하고 **일시 정지**로 `src/browser.ts:3:16`에 도착했다. Monaco F9로 3행 중단점을 설정하고 계속 실행한 뒤 확인된 중단점에 다시 멈췄다. Script 변수 `total: 56`, 명시 평가 `total + 2`의 결과 `58`, 한 줄 실행 후 `src/browser.ts:4:8`을 확인했다. `/tmp/corral-p26-browser-debug.png`에 원본 코드·중단점·변수·평가를 함께 저장했다.

브라우저 **실행 종료** 뒤 디버거는 종료됐고 기존 dev task는 계속 실행 중이었다. dev task를 별도로 중지하고 공유 개발을 끝내자 단독 쓰기 모드로 돌아왔다. 소유 debugger 프로세스는 남지 않았고 원본·작업 사본 Git은 clean이었다. 검증 서버·임시 사본·만든 브라우저 탭·인증 cookie를 정리했다.

실제 통합 중 Chromium 실행 파일이 기존 256 MiB 한도를 넘는 문제, 최초 Pause에서 스레드가 없는 문제, 보호된 preview의 HTTP map URL과 로컬 map 허용 목록 불일치를 발견했다. Chromium 실행 파일만 512 MiB streaming hash로 검사하고 기존 일반 도구 상한은 유지했다. Pause는 현재 owned thread를 읽고 revision을 다시 확인한다. 소스맵은 현재 lease origin과 시작할 때 캡처한 정확한 로컬 `.map` URL만 연결해 로컬 fallback을 허용한다. 임의 원격 map 전체 허용은 하지 않았다. preview의 실제 분리 host `127.0.0.2`를 inspector IPC와 혼동하던 가정도 제거했다. 각 실패 반례 기록은 `/tmp/corral-p26-chromium-size-red.log`, `/tmp/corral-p26-pause-red.log`, `/tmp/corral-p26-browser-map-red.log`, `/tmp/corral-p26-preview-origin-red.log`이고 최종 broker·launch 묶음은 6 PASS(`/tmp/corral-p26-broker-integrated-final.log`)다. 브라우저의 최초 페이지 로드 전에 중단점을 거는 동작은 현재 보장하지 않는다.

## 공통 통합 검사

contracts/client/server/Studio 타입 검사(`/tmp/corral-p26-p27-final-types.log`), production Studio build(`/tmp/corral-p26-p27-build-final.log`), generated 계약(`/tmp/corral-p26-p27-contracts.log`), 의존성 검사(`/tmp/corral-p26-p27-deps.log`)가 통과했다. 변경 코드 57개 파일의 Biome은 오류 없이 통과했으며 non-null assertion 등 경고 19개와 정보 1개를 남겼다(`/tmp/corral-p26-p27-biome.log`). 기존 bundle 크기·ReviewPage static/dynamic import 경고는 그대로다.

HTTP 통합을 최종 연결에서 다시 실행해 1 PASS를 확인했다(`/tmp/corral-p26-p27-http-final.log`). 이 결과와 문서 검사를 전체 release gate로 보고하지 않는다.

## 보존 경계와 검증 한계

디버깅은 효과가 있는 사람 작업이다. strict writer 또는 명시 공유 개발의 허용된 debug operation을 사용한다. 관리 사본·세대·adapter/config 지문·정지 세대·저장된 소스 hash를 확인하며 dirty 초안을 덮거나 자동 저장하지 않는다. 평가와 변수 확장은 명시 조작에서만 요청하며 자동 hover/watch 평가를 추가하지 않았다.

소유 launch는 종료하고, 기존 task attach는 연결만 해제해 task를 보존한다. 임의 PID·외부 debug 주소·reverse terminal 실행은 허용하지 않는다. host 재시작/정리 불확실 상태를 자동 실행하거나 성공으로 바꾸지 않는다. 브라우저는 개인 프로필/앱 cookie를 공유하지 않고 현재 managed preview에만 접근한다.

source map 검사는 안전한 사본 파일과 해시를 사용한다. 파일 500개·전체 8 MiB·개별 1 MiB 상한과 node_modules 제외를 적용하며 Git-ignore된 생성 map은 읽을 수 있다. 네트워크에서만 제공되는 비공개 map과 확인 불가 소스는 현재 파일 위치로 확정하지 않는다.

Linux 외 OS·원격 host·설치판·전체 접근성/부하/release gate는 반복하지 않았다. 어댑터 설치는 사용자가 등록하는 실행 환경의 전제이며 모든 언어/어댑터 호환을 뜻하지 않는다.
