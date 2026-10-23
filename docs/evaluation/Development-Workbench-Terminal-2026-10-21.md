# 개발 Workbench P07–08: 사용자 PTY와 터미널 검증

- 기준: `0a5408e` 이후 이 기록을 포함한 변경. CR-046 / CRL-WBD-004 / C-147·148 / TC-WBD-004-H,N,F.
- 환경: Linux, Node 24.19.0, pnpm 10.30.3, node-pty 1.1.0, xterm 6.0.0, addon-fit 0.11.0. 격리 Git/SQLite/서버와 실제 인앱 Chromium 사용. 외부 모델 호출 없이 시뮬레이션 adapter만 사용했다.
- 이 기록은 P07–08 구현과 명시한 환경 검증이며 전체 Workbench·모든 OS·release gate의 완료가 아니다.

## 구현

사용자 PTY는 Run을 만들지 않고 공통 WorkbenchOperations·writer·host process capacity를 사용한다. 기존 관리 사본 lease와 변경 전 tree pin을 거친 후 clean environment의 셸을 시작한다. host cap은 기존 Run/command와 공유하는 12개이며 재시작 시 uncertain owner도 실제 점유로 복원한다. 새로운 시작만 한도를 적용하고 기존 owner를 버리지 않는다.

입력·resize는 controller generation과 공통 sequence로 직렬화한다. 최신 중복의 payload hash가 같으면 prior ack를 반환하고, gap/다른 내용/오래된 제어권은 거절한다. HTTP 입력 ack 유실은 명시 확인·권한 재획득으로 진행하며 stdin을 자동 재전송하지 않는다. SSE는 현재 status와 순서 있는 output/resize를 구분하고 xterm 적용 callback 후 cursor를 전진시킨다. 화면을 숨겨도 parser·shell은 유지하고 종료 출력까지 적용하면 SSE만 해제한다.

초기 크기부터 ANSI와 resize 순서를 최대 4MiB 보관한다. 상한 초과 후 새 화면/gap 복구는 불가로 표시하며 임의 tail로 화면을 재구성하지 않는다. 기존 연결의 live 출력은 계속 제공한다. 종료 후 이력 보관은 5분이다. 입력 frame16KiB, queued64KiB와 host120frames/256KiB/초 상한은 생산 입력 예산이며 성능 합격 시간으로 취급하지 않았다.

Linux 종료는 boot ID/PID/startTicks/SID와 owner 증거를 확인하고 shell과 별도 job-control process group도 포함한다. 실행 중 descendant 부재를 확인한 뒤에만 writer/capacity를 해제한다. identity 증거가 없으면 uncertain 예약을 유지하고 자동 실행하지 않는다. OSC52 clipboard·OSC8 link를 차단하고 terminal title을 앱 행동으로 사용하지 않는다.

## 실패 재현과 회귀

- 기존 PGID 종료만 사용한 실제 interactive shell 반례에서 두 background job이 남았고 SID 기반 정리 후 둘 다 사라졌다.
- 같은 attachment 명시 takeover가 controller generation을 바꾸지 않던 반례를 수정했다.
- 임의 UUID의 숫자 시작이 공용 Identifier 계약에 맞지 않던 실제 native 통합 실패를 `terminal_` 접두사로 수정했다.
- malformed input이 rate budget을 소비하지 않던 red200→429 회귀를 수정했다. 기존 인증·CSRF·Origin 경계를 약화하지 않았다.
- xterm 적용 callback 전 reconnect cursor, 입력 ack 유실, 종료 status와 마지막 output 순서의 반례를 검사했다.
- 실제 브라우저에서 Shift+Escape에 Panel callback 연결이 빠진 것을 확인했다. 기존 컴포넌트 파일에 DOM focus 단위 회귀를 추가해 red→green으로 수정했다.

- 실제 IAB에서 preview GET 요청이 연속 429로 제한되는 현상을 관찰했다. FilePanel의 PreviewLeases와 ServicePreview가 같은 sibling key를 써서 timer가 누적됐다. jsdom 실제 컴포넌트 10회 렌더 후 기존12 pollers/해제 뒤22요청 반례를, 고유 key 두 개로 poller1/해제 뒤0요청으로 고쳤다. 제한값·폴링 주기는 유지했다. 최종 브라우저 네트워크 표본에서는 preview18회 모두200이었다.

## 검증 결과

| 검사 | 결과와 범위 |
|---|---|
| PTY/기존 소유권 회귀 | 17파일62 PASS/2 platform skip. runtime·native session·관리 사본·HTTP auth/limiter·클라이언트·store·writer/reader/receipt·host capacity 포함 |
| 마지막 UI 변경 | 4파일19 PASS: TerminalPanel DOM focus, FilePanel poller, document store, navigation. 앞 묶음과 중복 사례를 합산하지 않음 |
| 기존 편집기/Reins/locale | 5파일26 PASS: editorDraft/editor-store/reins-panel/reins-controls/locales |
| 전체 TypeScript | `pnpm typecheck` PASS; 최종 작은 UI 수정 후 Studio 별도 typecheck PASS |
| Production build | Studio build PASS. xterm lazy chunk 약331kB(압축83kB); 기존 큰 main/format chunk 경고 유지 |
| 계약·의존성·문서 | contracts:check·deps:check PASS; spec:check 2421 checks, 313/313 tagged scenarios PASS |
| 형식 검사 | 변경 JS/TS/JSON 39파일 Biome exit0·git diff --check PASS. 기존 app/service의 경고12개는 유지 |

최종 후보에서 `prepare:runtime` → `package --dir` → packaged bundled Node의 `check-runtime.mjs`가 모두 exit0이었다. Linux x64 / bundled Node24.19.0 ABI137 / Electron44.4.5에서 576개 모듈, SQLite/ONNX/PTY와 Pi worker2개를 로드하고 실제 셸 입력·101×37 resize·정상 종료를 확인했다. 준비된 runtime은 물리 파일27,027개·symlink0개다. `npmRebuild:false`를 유지했다.

패키징 전후 source525개가 불변이고 Studio assets506개가 packaged runtime과 byte-for-byte 같았다. 후보 source SHA-256 `cda8f4822f41171e321c15206a70088692238d5cdab12e1c1247dc9e4fda431c`, Studio tree `143bce41727798f63fa3016bb9330c305205a7b55c0faf44d9c77926c711ab96`, `app.asar` `c30a3baf1342ffed2fea3421c2a88134f1235b2395ad02d149f433fe776ade34`. 산출물은 `apps/desktop/release/linux-unpacked`, manifest는 `/tmp/corral-p07-final-candidate.json`, 로그는 `/tmp/corral-p07-final-{prepare,package,runtime}.log`다. 중간 패키지 결과를 최종 후보 증거로 재사용하지 않았다.

새 E2E는 추가하지 않았다. 실제 화면의 반례를 먼저 관찰하고 필요한 단위 회귀만 추가했다. 단위 경합은 mock clock/Gate로 검증하며 실제 OS smoke의 timeout은 runaway 방지용이다.

## 실제 화면과 파일

- production 앱에서 hello.ts를 실제 키 입력으로 편집·저장하고 Bash PTY에서 `cat`으로 동일 한글/유니코드 줄을 읽었다. 관리 사본 bytes와 원본 불변을 별도 확인했고 기존 Diff의 `+1` 줄을 확인했다. 모델 로그인/유료 호출 없이 진행했다.
- 다른 사본에서 시뮬레이션 Run A를 시작하고 UI로 취소 확정한 뒤 PTY B에 새 명령을 입력하여 `RUN_CANCEL_PTY_ALIVE` 출력 확인. 시뮬레이션 adapter의 취소 검증이며 실제 외부 provider 중단을 주장하지 않는다.
- 둘째 renderer는 읽기 전용으로 연결했다. 명시 입력 권한 가져오기 후 새 화면만 controller가 되고 기존 화면은 즉시 읽기 전용으로 바뀌었다. renderer 재생성 후 기존 output prefix와 resize를 다시 읽고 명시 takeover로 입력했다.
- ANSI 색·한글·emoji, alt-screen에서 pane 변경/복귀 후 내용 유지, 기본 화면 복원 확인. 390×844에서 PTY 크기 `12 43`을 실제 `stty size`로 읽었다. document width/scrollWidth는 모두390이었다.
- Shift+Escape가 실제 터미널 입력에서 새로고침 버튼으로 이동함을 넓은/390px 화면에서 확인했다. 종료 버튼은 좁은 화면에도 접근 가능하며 명시 종료 후 readback은 exited/exitCode0이었다.
- 다크/라이트 전환과 설정 왕복에서 출력 유지. 종료 후 문서 read-only 제한이 해제됐다. 최종 browser warn/error는0이었다.

화면 증거: `/tmp/corral-p07-terminal-flow.png`, `/tmp/corral-p07-run-cancel.png`, `/tmp/corral-p07-diff.png`, `/tmp/corral-p07-terminal-390.png`. 두 fixture 서버와 소유 탭을 정리하고 viewport override를 해제했다. 첫 fixture의 HTML은 server start 시 고정되므로 UI 수정의 최종 확인은 최신 build로 만든 둘째 fixture에서 수행했다.

## 남은 환경 검증과 한계

Windows/macOS native PTY, 실제 한국어/일본어 OS IME, 스크린리더 사용성, packaged GUI에서의 전체 여정은 수행하지 않았다. 자동 한글 문자열 입력은 OS IME 조합 검증이 아니다. PTY가 명시적으로 `setsid`/daemon으로 OS session을 이탈하면 완전한 descendant containment를 보장하지 않는다. spawn 직후 identity를 durable receipt에 저장하기 전에 host가 중단되면 예약은 uncertain으로 남는다. 이를 없애기 위한 daemon/journal은 이번 범위에 추가하지 않았다.

입력·출력은 터미널의 일반 사용자 권한이며 OS 보안 sandbox를 새로 제공하지 않는다. 패키지 runtime smoke와 실제 인앱 화면은 서로 다른 증거다. P09 이후 도킹·Git·개발 여정과 계획의 환경 qualification은 계속 남아 있다.
