# Corral 데스크톱 기능 구현·검증 기록

작업일: 2026-10-20–21 (Asia/Tokyo)
브랜치: `feat/desktop-capabilities`
시작 HEAD: `ad0bb6da6f20ca685e58b619e4e311464102a0b9`
승인: [CR-042](../change-requests/CR-042-desktop-capabilities.md)
범위: 구현 계획 (Git `373764467a52:docs/plans/Desktop-Capabilities-Implementation-Plan.md`)의 ABS-01–15 / I00–I17.

후속 UX 변경: 사용자가 요청한 기본 대화·선택적 Corral 개선은 [CR-043 셀프리뷰](Chat-First-UX-Review.md)에 기록한다. 아래 8차 UI 및 EXE 해시는 해당 UX 변경 전의 검증 이력이다. 현재 UI는 `index-DEI0pIX7.js`이며 최신 배포 identity는 [배포 증거](Desktop-Delivery-Verification.md)를 따른다.

Windows 작업 사본에서 기능을 구현하고 인앱 브라우저와 실제 번들 Electron 앱을 검증했다. 패키지의 staging 절대 경로 참조를 수정한 뒤, staging을 사용할 수 없는 상태에서 저장소 밖으로 옮긴 앱의 전체 native 흐름도 통과했다. 서버 전체 회귀 재검사는 통과했다. 검증한 앱으로 portable/NSIS 파일을 생성했고, 최종 portable 자체의 실행·추출 runtime 동일성·정상 종료도 확인했다. 현재 코드는 커밋·공개 배포하지 않았다. 아래 남은 플랫폼·외부 환경 조건 때문에 전체 OS/서비스 완료를 선언하지 않는다. 중간 실패와 수정, 실행한 제품 흐름, 미검증 환경을 구분하며 겹치는 테스트 묶음의 통과 수를 합산하지 않는다.

## 제품 입구와 현재 결과

| 기능 | 구현·확인한 제품 흐름 | 남은 조건 |
|---|---|---|
| ABS-01 명령·service | 세션 요청 → Coordinator 승인 → 실제 관리 사본 → Files 명령·출력·중단. Windows Job 후손 종료, 파일 변경·diff, 중복·재시작 비재실행 검증 | 다른 OS 실행 검증 |
| ABS-02 권한 | 컴포저 Ask/Accept edits/Auto → 불변 Run → 실제 승인·거절. 기존 deny/strict/review-only 유지 | 외부 모델 판단 품질은 별도 |
| ABS-03 Hashline | read_hashline → 명령/편집 승인 → edit_hashline → 파일·diff 확인. 원본 보존, full hash/읽기·attempt·lease 검사 | 없음(Windows 검증 범위) |
| ABS-04 preview | Files와 모델이 같은 lease 사용. 실제 Chrome snapshot/click/assert, HTTP/WS 소유권, 지연 bind/초기503, 취소·폐기 | macOS 앱 TCP 소유권 확인은 미구현·차단. Linux 실행 미검증 |
| ABS-05 모델 | Settings의 네 소스 import → 검토·선택·저장·재열람, 카탈로그와 실제 capability 분리 | 유료 외부 요청 미검증 |
| ABS-06 병행 Run | 같은 세션 writer A+snapshot reader B+다른 사본 writer C, B만 취소, 같은 사본 writer 거절. 선택한 Auto 작업 방식 고정. 활성 writer 중 기존 결과 질문·선택 취소 UI 확인 | 다른 OS·외부 host 실행 검증 |
| ABS-07 Desktop | 번들 Node만 있는 실제 Windows GUI에서 폴더 선택·신뢰·사본·실행, native preview, tray/다중 인스턴스 복귀, 단축키 저장, 종료·재시작·기록·초안 보존 확인. 최종 portable 실행·runtime hash·종료 확인 | portable 첫 180초 검사는 추출 중 timeout, 후속 측정은 화면까지 245.5초. NSIS 설치·macOS 실행·서명·실제 업데이트 채널 미검증 |
| ABS-08 예약 | 사이드바 일정 저장 → 일반 Auto/Coordinator 실행 → 기록 재열람. timezone/DST/overlap/놓침/중복·재시작 | 유료 예약 호출 미실행 |
| ABS-09 프로젝트·자료 | 실제 local Git clone → 연결·명시 신뢰 → 관리 사본. 지침/메모리 버전과 명시 첨부·RunSnapshot readback | 없음(로컬 검증 범위) |
| ABS-10 이미지 | 명시 image profile → provider operation → 원본 PNG·불변 metadata → viewer/검토/export. 참조 픽셀·비용 예약/unknown 정산 | 실제 유료 이미지 품질·청구 미검증 |
| ABS-11 Markdown | import 검토·매핑 → callable graph 저장·재열람 → 일반 위임 → 현재 부모 질문/답변 → 같은 자식 재개·완료. Hashline·부모 작업 방식 상속 | 유료 모델의 판단 품질은 별도 |
| ABS-12 패키지 | manifest/권한 검토 → 설치·명시 신뢰 → MCP 등록 → upgrade/disable/remove/restore. 응답 유실 재시도 중복 없음 | trusted-native는 기존 비격리 경계 |
| ABS-13 금고 | 9개 도메인 기존 owner, 암호화·diff·명시 적용·rollback journal/원자 receipt. 실제 browser 설정 readback | 외부 S3 계정 쓰기 미검증 |
| ABS-14 원격 host | 별도 host partition, SSH 실패·인증경계, receipt/SSE/preview 위임. 실제 편집기 응답 유실→재로드→동일 Run 복구 | 외부 SSH 성공 연결 미검증 |
| ABS-15 음성 | Live Voice 지원 프로필, WebRTC·대상 고정·확정 발화 중복 방지·next/steer·종료 | 실제 마이크·양방향 외부 provider·요금 미검증 |

에이전트 실행 효과·Task·예산·완료는 Coordinator가 소유한다. 설정·import·금고는 기존 설정 서비스의 원자 저장 경로를 사용한다. 각 기능은 Corral의 실행·승인·저장 계약에 따라 구현했다.

## 직접 조작한 인앱 브라우저

폴더 연결·신뢰, 팀·작업 방식 선택, 관리 사본 생성 후 요청→명령 승인→Hashline 승인→성공·두 파일 diff를 확인했다. 명령·Hashline 실행 직후 원본 README는 `original note`, 관리 사본 README는 `updated by Hashline`, command.txt는 `created by run_command`임을 파일 읽기로 확인했다.

그 뒤 별도 검토 승인 `decision_945beb74`(2026-10-20 23:10:26 JST)와 원본 적용 `integration_a5224404`(23:10:30 JST)가 저장돼 있다. 적용 직전 체크포인트에는 원본 README와 command.txt가 없는 상태가 보존돼 있고, 현재 원본 두 파일의 hash는 적용 이력의 after_hash와 일치한다. 따라서 현재 원본은 명시 검토 적용 결과이며 명령 실행 중 원본이 직접 바뀐 것이 아니다. 이력에는 조작 주체가 없어 누가 적용했는지는 판정하지 않는다. 이 조사에서 데이터를 되돌리거나 수정하지 않았다.

최종 취소 확인은 새 Run `run_1fc50633be5942b3bbd1befab04caca4`에서 수행했다. `node long-job.mjs`를 승인하고 Files의 실제 출력에서 부모·자식·손자 실행을 본 뒤 Run 전체 취소를 확인했다. 화면에 도구/Run 취소와 `프로세스 종료 확인됨`이 표시됐고, 기록된 PID 43956/35868/18940이 모두 사라진 것을 OS 조회로 확인했다. 이전 실패 이벤트나 세션 기록은 삭제·수정하지 않았다.

- 명령·Hashline 결과 (로컬 검증 자료: `test-results/desktop-absorption/iab-command-hashline.png`)
- 명령 승인 표시 (로컬 검증 자료: `test-results/desktop-absorption/iab-command-approval.png`)
- 실제 명령 취소·종료 확인 (로컬 검증 자료: `test-results/desktop-absorption/iab-native-cancel-confirmed.png`)
- 최종 8차 화면의 실제 변경 전후 비교 (로컬 검증 자료: `test-results/desktop-absorption/iab-final-eighth.png`)

모델 응답만 localhost의 결정적 provider가 공급했다. 실제 Pi SDK, 생산 prompt·도구 구성, Coordinator 승인·취소, 파일 broker, Git·Windows Job·Chrome은 제품 경로다. 이 증거는 실제 모델의 판단 품질이나 외부 provider 성공을 증명하지 않는다.

## 실행한 검사와 자산

Windows x64 / Node24.19.0 / pnpm10.30.3. 후속 변경은 해당 패키지와 제품 흐름을 재검사한다.

| 검사 | 해당 회차 결과 |
|---|---|
| 최종 8차 전체 Vitest | 250파일 중 242 PASS / 1 FAIL / 7 skip. 1,518 PASS / 1 FAIL / 24 skip. 실패는 workspace 소유 프로세스의 5초 IPC 시작 대기이며 강제 종료·복구 단계 이전 |
| 위 실패의 수정 후 서버 전체 재검사 | 55파일 PASS / 1 skip, 397 PASS / 3 skip, 190.54초. 제품 소스 변경 없이 cold-child 시작 제한을 Desktop과 같은 30초로 맞추고 단계 진단 추가. 원래 실패 회차를 전체 PASS로 바꾸지 않음 |
| 앞선 contracts/core/client/react/studio/runner-langgraph/storage-sqlite | 129파일, 798/798 PASS. 부모 질문 변경 이전 회차이며 최종 전체 검사와 중복 |
| native 명령/LSP/검사/clone/preview/browser/SDK·MCP 상한 | 소스 동결 후 13파일, 64 PASS / 플랫폼 skip3 |
| Windows 자격·모델·금고 owner | 6파일, 55/55 PASS. 실제 .NET ACL readback 포함 |
| 파일 broker 전체 + Auto baseline | 2파일, 47/47 PASS |
| 동시 파일·업데이트 idle + Desktop restart + server API | 40/40 PASS |
| 취소 effect와 기존 tool lifecycle | 47/47 PASS. 실패·timeout·unknown 보존 |
| 명령/Hashline/두 취소/390px·키보드/Auto 병행 UI | 4차 Studio에서 4/4 PASS |
| 파일·모델 동일 lease·service preview UI | 4차에서 3/3 PASS, 실제 Chrome·service 효과 |
| preview backend | 실제 Chrome 포함 7/7 PASS |
| 모델/금고/Markdown/이미지 설정 UI | 각각 2/2, 2/2, 3/3, 1/1 PASS. 각 증거 문서의 자산 기준 |
| 원격 Editor 응답 유실 복구 UI | 5차에서 1/1 PASS. import→Run→응답 유실→완료→reload→Run에서 원래 ID/Run1개/POST1회 확인 |
| 활성 writer 중 기존 결과 질문 UI | 5차에서 기존 질문 호환성과 함께 2/2 PASS. 질문 B만 취소해도 A와 이전 결과·원본 보존 |
| 부모 질문의 runtime/worker/기존 호환 | core 56, adapter 105, 계약·compiler·importer·vault·design 33, Simulated 수정 회귀 25 PASS. 순차 items의 남은 spawn 예약을 restart도 지키는 반례 포함. 묶음 간 중복 있음 |
| 최종 Markdown import UI | 7차 3/3 PASS. 실제 저장된 정의를 Simulated와 실제 Pi SDK로 실행하고 질문/답변 후 같은 부모·자식 완료 확인 |
| SDK worker/MCP 종료 회귀 | 5파일 76/76 PASS. 실제 native MCP 두 번 시작하는 테스트만 외부 제한을 20초로 조정. 내부 MCP deadline·결과·lease 해제 검사 유지 |
| Windows Desktop | 패키징 재배치 수정 후 10파일 36/36 PASS. 설치된 OpenSSH의 점유/닫힌 loopback 포트 거절 포함. staging 없는 독립 폴더의 실제 GUI/Job helper/런타임 검증 PASS. 앞선 staging 참조 산출물과 구분 |
| pnpm typecheck | 최종 8차 전체 workspace와 tools/live PASS. 이후 소유권 테스트 변경의 server typecheck와 재배치 패키징 변경의 desktop typecheck도 PASS |
| pnpm lint | 패키징 수정 후 889파일, 오류 0, warning481/info9. 자동 위험 수정 없음 |
| contracts:check / deps:check | PASS. 부모 질문 계약 추가 후 재생성·재검사 |
| spec:check | 최종 문서·backlog·배포 기록 갱신 후 2,302 검사 PASS, 290/291 시나리오 태그. 태그 존재는 실행 PASS가 아님 |

Studio 1차 `index-DwXevtmi.js`, 2차 `index-DqcgMHff.js`, 3차 `index-xCi07lLw.js`, 4차 `index-bFSG6hZg.js`, 5차 `index-CYp9pZlk.js`, 6차 `index-D3xJtg_P.js`, 7차 `index-DwseoaDF.js`, 최종 8차 `index-B97zDyHh.js`. 3–8차 CSS는 `index-P0zuN5FL.css`. 5차에는 원격 편집기 복구·병행 결과 질문·취소 상태 번역, 6–7차에는 실제/모의 실행의 부모 질문이 들어 있다. 명령/Hashline/취소/Auto 4개 UI 회귀는 6차에서도 모두 통과했다. 7차는 부모 질문 opt-in이 있는 Simulated 경로만 추가 수정했고 해당 UI 3개를 다시 통과했다. 8차는 core의 items 예약·restart 상한, 서버 HTTP413와 Windows Git 실행 수정까지 포함한 최종 번들이다.

서버는 app.asar 밖의 extraResources/runtime에 있으므로 app.asar hash만으로 전체 배포의 동일성을 주장하지 않는다. 기존 pnpm junction 672개가 staging 절대 경로를 참조하는 문제를 수정했다. offline physical-hoisted 배치의 runtime을 저장소 밖의 공백 있는 경로에 복사하고 staging을 옮겨 사용할 수 없게 한 뒤 검증했다. 570개 모듈·SQLite/ONNX·두 Pi worker가 복사한 runtime 내부에서 로드됐고, 실제 Windows Job의 정상 종료·부모/손자 취소, 전체 Electron UI 흐름이 통과했다. 폴더 선택→신뢰→사본→실행, native preview·단축키·원격 폼·tray·다중 인스턴스 복귀·종료/재시작·기록/초안 보존, preview를 연 채 마지막 Quit까지 포함한다. 검증 후 staging은 복원했다.

배포 runtime 26,618개 실제 파일의 집계 SHA-256은 `f9205c0da186f1627d037675112b007075f8e467f2757fa1b4a47323fdb8891b`이며 실행 전후 같다. 준비 디렉터리와의 차이는 builder가 제외한 타사 Fastify 테스트 fixture의 0바이트 `.gitkeep` 두 개뿐이다. 실행 파일이나 소스의 차이가 아니며 정확한 경로를 배포 증거에 기록한다. 검증한 unpacked tree를 `--prepackaged`로 portable/NSIS에 넣어 다시 조립하지 않는다. 최종 실행 파일 hash와 app.asar hash는 [배포 증거](Desktop-Delivery-Verification.md) 및 delivery manifest를 따른다. 앞선 실패 로그는 `test-results/desktop-absorption/`와 native smoke 로그에 보존한다.

바로 사용할 수 있는 검증된 로컬 입구는 `apps/desktop/release/win-unpacked/corral.exe`다. 새 portable은 231,593,331 bytes, NSIS는 231,836,744 bytes이며 둘 다 서명하지 않은 로컬 빌드다. portable의 첫 측정은 180초 동안 자체 압축을 해제하다 Electron 시작 전에 제한 시간에 도달했고 FAIL로 보존했다. 서버/UI 시작 제한은 바꾸지 않은 후속 측정에서 Electron은 215.951초, Studio는 245.5초에 도달했다. 중단된 이전 추출 정리가 포함되므로 깨끗한 최초 실행 시간 벤치마크가 아니다.

최종 portable에서 실제 추출된 runtime 26,618개 파일의 hash가 검증한 tree와 정확히 같고, native Quit 뒤 launcher exit0·앱 PID 종료·listener 닫힘을 확인했다. 전체 429.966초에는 모든 파일 hash 검사와 종료가 포함된다. 해당 측정이 빠른 시작을 보장하는 것은 아니므로 현재 로컬 사용에는 이미 압축 해제한 앱을 제공한다. NSIS 설치는 실행하지 않았다. 최종 파일의 SHA-256을 manifest와 별도 다시 읽어 대조했다.

| 최종 산출물 | SHA-256 |
|---|---|
| `Corral-0.1.0-x64-portable.exe` | `6562b183876124da10787fddac4665ab74b8248f4568accbd6b52f5ea7e8a174` |
| `Corral-0.1.0-x64-setup.exe` | `9bcd0097b8ebe5d3514dd4e5ecf7ecf67b6bcabd03267380faa49e70579385f5` |

전체 runtime 파일별 hash와 검증 이력은 `apps/desktop/release/runtime-files.json`, `apps/desktop/release/delivery-manifest.json`에 있다.

## 발견한 실패와 수정

- **TEST DRIFT:** 기존 단일 활성 Run API 테스트가 병행 실행 승인과 충돌했다. 독립 writer/reader와 같은 사본 경합을 실제 HTTP로 검증하도록 고쳤다.
- **AUTHORITY INVERSION:** 자식 질문을 최종 결과로 반환하는 안내는 계획의 부모 ask/reply를 대체하지 못했다. 수동 팀의 의미를 보존하는 opt-in 부모 질문 경로를 구현하고 실제 Pi core/SDK·병렬/items·질문 responder인 부모·모의 실행을 검증했다. 질문/답변은 새 Task를 만들거나 부모를 끝내지 않는다.
- 정상 취소를 failed effect로 기록하던 승인 대기/실행 후 두 경로를 분리했다. confirmed cancellation만 cancelled로 정산하고 실제 실패·timeout·불확실성은 보존했다.
- service 포트가 뜨기 전 preview 실패, 준비 전 lease 노출을 실제 지연 bind/503으로 재현·수정했다. 소유권을 매번 확인하는 제한된 readiness 대기를 사용한다.
- terminal Run의 비동기 checkpoint보다 updater 백업이 먼저 실행될 수 있어, pending snapshot/Run 준비/파일 lease를 idle gate에 포함했다.
- Windows chmod만으로 자격 파일이 보호됐다고 판단하지 않고 실제 ACL을 적용·읽어 검증한다. 빌린 Codex 파일은 변경하지 않는다.
- SDK의 즉시 process.exit가 Windows HTTP/IPC 종료에서 libuv 충돌을 일으켜, 마지막 frame·IPC close를 정상 배출하고 종료를 확인하도록 고쳤다.
- 번들 Windows 서버에서 Git child의 `windowsHide` 누락으로 폴더·관리 사본·실행이 정체됐다. 동일 조건에서 기존 경로는 40초를 넘겼고 해당 옵션만 수정한 경로는 약 10초에 끝났다. 실제 Electron의 폴더 선택→신뢰→사본→전송은 2.4초에 성공하고 정상 종료했다.
- Windows HTTP에서 초과 요청 본문을 읽기 전에 연결을 닫으면 413 대신 TCP reset이 발생했다. 허용 body 크기는 유지하고, 거절 본문만 기존 요청 deadline과 추가 2×body-limit 이내에서 버린 뒤 413을 전송한다. 한도·시간·abort 경계는 연결을 종료한다. 실제 HTTP 반례와 전체 8차 서버 API 테스트에서 확인했다.
- native preview의 빈 부모 창에 unsaved-edit JavaScript를 요청하면 종료가 멈췄다. 빈 chrome은 건너뛰고 로드된 창 응답은 제한 시간 후 미저장으로 처리한다. preview를 연 채 마지막 Quit까지 실제 번들에서 확인했다.
- electron-builder extraResources에 복사된 pnpm junction 672개가 staging 절대 경로를 유지했다. 개발 Node/pnpm을 PATH에서 빼는 것만으로 이 의존성을 발견할 수 없었다. offline hoisted 배치와 준비·패키징 단계의 전체 tree 링크 거절을 추가했다. staging 없는 재배치 실제 실행과 runtime hash readback으로 수정 결과를 확인했다.
- 전체 회귀의 workspace 소유권 복구 테스트는 강제 종료 이전 5초 IPC 준비 대기에서 실패했다. 수정 전후 단독 실행은 각각 4개 모두 통과했다. 자식의 전체 서버 모듈 로드·서버 시작·Run 준비를 포함하므로 native Desktop과 같은 30초를 사용하고 단계 진단을 추가했다. 원래 실패가 어느 준비 단계였는지는 이전 로그로 판별하지 못했다. conflict→SIGKILL→새 owner의 interrupted 상태·모델 비재실행 검사는 유지했으며 수정 후 서버 전체 397개가 통과했다.
- 오래된 schema fixture, Windows 경로, Git EOL, 실제 native startup에 맞지 않는 테스트 제한을 교정했다. 52회 Git checkpoint가9.91초 걸리는 테스트의5초 제한처럼 측정한 근거를 기록했고 실제 기대 결과는 유지했다.

첫 broad runtime 실행은 native helper 수정 중 실패했다. 실패 로그를 보존하고, 이후 동결된 소스의 native·자격·파일·API·CLI 재실행을 별도 결과로 기록한다. 중간 실패 자체를 전체 PASS로 바꾸지 않는다. 전체 lint의 기존 CRLF 문제는 LF 정규화 결과가 Git index blob SHA와 정확히 같은 파일만 바꿔 진단했으며 index·제품 의미를 바꾸지 않았다.

## 남은 환경 조건과 상세 증거

macOS local-app TCP 소유권 확인은 미구현이며 요청을 차단한다. Linux 실행, macOS 설치, 코드 서명·실제 업데이트, 외부 SSH/S3, 실제 음성 장치/provider, 유료 이미지·모델은 미검증이다. native extension은 기존 trusted-native 비격리 경계이며 소유 프로세스 그룹12개 상한은 임의 후손 PID 개수 상한이 아니다.

자동 승인 검토가 진단 폴더 17개 삭제를 정책상 차단했다. 구체적 사유는 제공되지 않았고 재시도나 우회 없이 폴더를 보존했다. 정확한 로컬 경로는 Git에서 제외된 `test-results/desktop-retained-temporary-paths.json`에 기록했다. 배포 앱과 검증용 sidecar는 종료됐고 의도적으로 제공하는 인앱 QA 서버는 유지한다.

[프로세스](Desktop-Native-Verification.md) · [병행 실행](Desktop-Concurrency-Verification.md) · [preview](Desktop-Preview-Verification.md) · [모델·금고](Desktop-Models-Vault-Verification.md) · [프로젝트](Desktop-Projects-Verification.md) · [위임](Desktop-Agent-Import-Verification.md) · [음성](Desktop-Voice-Verification.md) · [Desktop](../../apps/desktop/README.md).

요구 CRL-ABS-001–015, 태스크 C-122–136, 시나리오 TC-ABS-001-H/N–015-H/N를 등록했다. backlog의 완료 가능한 로컬 구현에는 implemented와 이 증거 문서를 연결했다. C-125(macOS 앱 소유권), C-128(OS별 배포), C-135(실제 원격 host), C-136(실제 음성)은 남은 계약·환경 조건 때문에 in_progress로 유지한다. 테스트 카탈로그의 planned/evidence:null은 기존 문서팩의 시나리오 선언 형식이다. 실행 PASS/FAIL은 이 문서·기능별 증거·실행 로그로 구분한다.

## PR #65 리뷰와 E2E 정리 — 2026-10-21

기준 `df79b95`. 사용자가 리뷰 수정과 CI 오류 개선, 불필요하거나 과도한 E2E 삭제를 요청했다.

- Auto/Explain은 새 UI 명령 ID가 들어와도 동일한 미확정 요청의 기존 ID로 receipt를 조회한다. Auto 복구 도중 취소도 기존 ID를 사용한다. 컴포저 자체의 영속 ID 복원은 이미 있었으므로 단순 새로고침이 항상 중복 실행을 만든다는 뜻은 아니다.
- 음성 hangup의 503/timeout을 `close()` 성공으로 삼키지 않는다. 기존 host cleanup 경로가 실패와 소유권을 유지하며, provider 재시도에 필요한 lease도 남는다.
- instructions/memory 금고 적용 직전에 프로젝트 존재·활성 상태를 재검증한다. 이미 확정한 operation 재조회와 payload 불일치 거절, 이전 문서 버전은 보존한다.
- 위 반례 8개와 복구 중 취소 반례 1개를 각각 수정 전 실패로 확인했다. 수정 후 관련 5개 파일 27개 테스트가 통과했다. 외부 provider 호출은 하지 않았다.

[기존 CI](https://github.com/fromiron/corral/actions/runs/39517439782)의 E2E 실패 6개를 로컬에서도 모두 재현했다. 146 PASS / 6 FAIL / 3 skip이었던 기존 결과는 그대로 실패 기록으로 남긴다.

E2E 정리 기준은 사용자 결과·브라우저 연결의 검증 여부다. 재시도나 시간 제한을 늘리지 않았다.

- `chat-model-label.spec.ts` 전체 2개와 `chat-surface`의 좌표·폭·DOM 동일성 시나리오 1개를 삭제했다. 모델 선택·저장·키보드 복귀는 composer/locale 테스트, 대화 위치 복원은 conversation-length, 좁은 화면 조작은 남은 chat-surface/desktop-workbench가 담당한다. 글자별 clipping과 정확한 픽셀 배치는 정규 CI 보장 범위에서 제외한다.
- `demo`의 내부 `role prompt:` 문자열을 최종 결과에 기대하던 1개를 삭제했다. 이 출력은 의도적으로 제거된 진단 정보이며, 미래 prompt의 적용 범위는 `packages/core/test/reins.test.ts`, 진단 정보 비노출은 `apps/studio/src/demo/templates.test.ts`가 검증한다. 데모의 지시·승인·취소 흐름은 유지한다.
- 대화/분기 테스트에 섞인 정확한 여백·blur·좌표·반복 스크린샷 검사와 부수 탐색 단계를 제거했다. 확장 질문 테스트의 수동 압축 실패 주입은 기존 SDK/React 테스트로 검증하며 E2E는 질문 응답→완료에 집중한다.
- 파일 연결은 현재 tabpanel을 사용하고, 복구/분기 상세는 실제 Executions 펼치기를 거친다. 과거 결과 선택 시 현재 Run의 계획을 섞어 표시하라는 이전 기대는 없앴으며, 선택 결과·초안·다른 활성 Run의 독립성은 계속 검사한다.

테스트 시나리오 태그는 정리 전후 모두 292/293이다. 핵심 D&D·Reins·승인·취소·복구·파일 반영/되돌리기 E2E와 별도 성능 측정은 유지한다.

최종 로컬 검증:

- 전체 E2E: 148 PASS / 기존 3 skip, 4.4분. 정리 전 155개에서 151개로 줄었다. Chromium·Firefox·실제 로컬 서버 프로젝트를 모두 실행했다.
- 전체 Vitest: CI와 같은 Node 24.19.0에서 1,546 PASS / 기존 23 skip, 250개 파일 통과. 앞선 Node 24.14.0·E2E 병행 회차는 1,545 PASS / 1 FAIL / 23 skip이었다. `preview-readiness`가 403 뒤 준비 대기에서 실패했으며 단독 실행과 최종 전체 재실행은 통과했다. 원인은 확정하지 않았고 해당 테스트나 제품의 소유권 검사를 완화하지 않았다.
- `pnpm typecheck`, `pnpm build`, `pnpm contracts:check`, `pnpm spec:check`, `git diff --check` 통과. lint 오류 0, 기존 경고 475개·정보 9개. 문서 validator 의존성은 임시 uv 환경에서 제공했다.
- 이 검증은 외부 음성·유료 모델·SSH/S3·Windows 패키지 실행을 포함하지 않는다. GitHub의 새 커밋 CI 결과는 별도 확인한다.

### GitHub에서 재현된 미리보기 연결 경합

`94dbd4c`의 [PR gate](https://github.com/fromiron/corral/actions/runs/39523657077)는 문서·계약·lint·타입 검사를 통과했지만 `preview-readiness`에서 1 FAIL / 1,545 PASS / 23 skip으로 끝났다. 준비 완료 직후의 HTTP 요청이 `Owned preview unavailable`로 거절됐다.

Linux 서버의 event loop를 파일 신호까지 의도적으로 막아 TCP connect가 서버 accept보다 먼저 끝나는 상황을 만들었다. 같은 연결은 accept 이전에는 소유 프로세스 FD로 확인되지 않아 기존 구현에서 즉시 거절됐고, 신호를 준 뒤에는 소유권을 확인할 수 있었다. 이 결정론적 반례가 수정 전 실패하는 것을 확인했다. 확인에 사용하는 커널 필드는 [Linux TCP 문서](https://docs.kernel.org/networking/proc_net_tcp.html)의 연결 주소·상태·inode다.

`ownedConnection`은 기존 5초 연결 제한 안에서 **같은 소켓**의 소유권 확인을 기다린다. 새 소켓이나 포트 신뢰로 대체하지 않으며, 확인 전에는 HTTP/WebSocket 데이터를 보내지 않는다. 끝내 확인되지 않으면 소켓을 닫는다. 실제 지연 accept, 미확정 연결의 시간 제한·전송 0바이트, 기존 foreign/stale endpoint·HTTP/HMR 폐기 검증을 유지한다. 테스트 재시도나 E2E 시간 제한 증가는 없다.

이 수정 후 Node 24.19.0 전체 Vitest는 **1,548 PASS / 기존 23 skip**이다. 서버 타입 검사·변경 파일 lint·문서 검사도 통과했다. 미리보기 E2E는 파일 preview 1개 통과 / 기존 opt-in 2개 제외이며, 전체 E2E의 148 PASS는 앞선 `94dbd4c` 결과다. 최종 커밋 전체 E2E는 GitHub PR gate에서 별도 확인한다.
