# Workbench 코어 잔여 검증

2026-10-23 사용자 요청에 따라 P23/P24-A 전 검증을 코어 동작으로 제한했다. 기준 `965ee26`, Linux·Node 24.19.0·production Studio·Chromium 인앱. 전체 설치판/부하/지원 OS 게이트를 반복하지 않았다.

- 기존 `preview.test.ts`, `preview-policy.test.ts`, `terminal-routes.test.ts`, `terminals/store.test.ts`: **4 files, 21 PASS, 1 SKIP**. `maxWorkers=2`. 실제 HTTP/HMR 소켓 소유권·무인증/타 세션 거절·lease 폐기, SSE viewer 분리 시 셸 유지, reconnect cursor와 ACK 유실 후 입력 자동 replay 금지를 확인했다. 로그 `/tmp/corral-core-verification-20261024.log`(파일명 날짜는 실행 날짜와 다르며 위 기준을 따른다). SKIP은 별도 browser executable이 필요한 preview broker 시험이다.
- 격리된 실제 앱에서 Bash를 시작해 `corral_core_value=kept`를 설정했다. 페이지 reload로 viewer를 분리·재접속하고 입력 권한을 다시 받은 뒤 `CORE_RECONNECTED:kept` 출력을 확인했다. 새 셸을 만들거나 입력을 자동 재전송한 결과가 아니다. 명시 종료 뒤 종료 코드 0을 확인했다.
- 같은 사본의 `main.js`에 `CORE_DIRTY_DRAFT` 초안을 남긴 뒤 Git→설정→닫기로 돌아왔다. 탭·미저장 상태·초안 내용이 남고 Git 대상은 동일 사본이었다. 저장 후 clean으로 바뀌고 변경 파일 한 개가 표시됐다. 원본 폴더·개인 작업 공간은 건드리지 않았다.
- 화면 원시 증거 `/tmp/corral-core-terminal-reconnect.png`, `/tmp/corral-core-roundtrip.png`. 임시 자산이며 장기 보관 증거로 간주하지 않는다.

P22의 실제 Vite 저장→HMR 및 인증 proxy HTTP 확인은 [해당 기록](Development-Workbench-Shared-Development-2026-10-23.md)에 있다. 이번에는 같은 전체 흐름을 중복 실행하지 않았다. Desktop 전용 프레임의 실제 조작과 설치판 전체·원격/다른 OS·부하·IME/스크린리더는 P29/P21-B 환경 검증으로 남긴다. PR #69/#85 외부 게시물은 수정하지 않았다.
