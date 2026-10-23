# P29 Linux 설치판·복구 — 코어 인수

- 기준: `a3711bc`와 복구 경합 수정 `1553d37`, 이 문서를 포함한 추적 묶음. CR-046 P29, CRL-WBD-026/C-170/TC-WBD-026-H,N,F.
- Linux x64, bundled Node 24.19.0, Electron 44.4.5, production Studio. 격리된 app data/workspace만 사용했으며 외부 계정·유료 호출은 없다.
- 범위는 사용자가 요청한 핵심 검증이다. 지원 OS 전체·성능 행렬·출시 판정과 구분한다.

## 발견한 오류와 수정

사용자가 검증 중 **“The recovery screen is unavailable. Reinstall Corral”** 창을 제보했고 OK 뒤 앱이 열렸다. 재현 결과, 이전 sidecar 종료가 복구 페이지 로드를 시작하고 다음 정상 시작이 그 로드를 취소했다. 이전 load의 늦은 catch가 현재 세대와 화면 상태를 확인하지 않아 잘못된 재설치 안내를 띄웠다.

같은 시작 시도의 중복 실패 처리를 막고, 비동기 load 실패 시 현재 generation·failed 상태·같은 살아 있는 창·종료 여부를 다시 확인했다. `ERR_ABORTED`나 모든 로드 오류를 무조건 무시하지 않았다. 기존 packaged smoke는 native 오류를 수집하고 재시도→작업 공간 재열기에서 오류가 없음을 검사한다.

실제 unpacked 재현 RED(`/tmp/corral-p29-recovery-red.log`) 후 GREEN(`/tmp/corral-p29-recovery-green.log`): 오래된 STARTUP load의 취소는 발생해도 잘못된 오류창은 0이며 정상 Studio로 진입한다. 현재 복구 페이지 로드를 실제 실패시키면 오류창 1개가 유지된다. 정상 복구 화면은 `/tmp/corral-p29-recovery-success.png`에 보존했다.

## 필요한 검사와 실제 산출물

| 범위 | 결과 | 기록 |
|---|---|---|
| Dock dirty 닫기·모델 identity, PTY 재연결/ACK 유실, 공통 12개 process 상한 | 3파일 20 PASS, Windows 전용 1 SKIP | `/tmp/corral-p29-core-recovery.log` |
| Desktop 기존 packaging·미저장 종료 핵심 회귀 | 2파일 9 PASS | `/tmp/corral-p29-core-regression.log` |
| Studio build·runtime 준비·Linux unpacked 패키징 | PASS | `/tmp/corral-p29-studio-build.log`, `corral-p29-prepare-runtime.log`, `corral-p29-package.log` |
| 실제 번들 Node의 SQLite·ONNX·PTY 입력/101×37 resize/종료·Pi worker 2종 | PASS | `/tmp/corral-p29-packaged-runtime.log` |
| 실제 unpacked 앱의 workspace·history·draft/theme/route·quit 결정·sidecar/renderer 복구·시작 재시도 | PASS | `/tmp/corral-p29-packaged-smoke-fixed.log` |
| 실제 unpacked renderer의 Monaco loader/worker 초기화·모델 동기화·Diff RPC | PASS, 기존 CSP 위반 0 | `/tmp/corral-p29-editor-worker.log` |

마지막 Monaco 탐침은 현재 제품 loader와 worker로 `41→42` 한 줄 Diff를 계산했다. 실제 worker의 초기화·ping·모델 동기화·Diff 응답을 확인했으며 제품 CSP를 바꾸지 않았다. 전체 lifecycle을 다시 실행하지 않았다. Desktop/server 타입·변경 파일 Biome도 통과했다. 준비 단계가 확인한 물리 파일은 27,322개이고 symlink/junction은 0개였다. 시험 시간과 준비 파일 수를 성능 예산 충족의 증거로 사용하지 않는다.

검증한 산출물은 `apps/desktop/release/linux-unpacked/corral`이다. `app.asar` SHA-256 `9d68113cbe01fe2b713f69445fb8072f93c96835555d194c1a7fd24b614b31f9`, Studio index `fa8e3cf894d2f12a880913b29721e28c564fb414e2d407282844cea7f028cc4b`, Monaco worker `221daf275ee5802e4627528ff65b44d54c8bada9f7786ee6e752bd99f91fa1f1`. 실행 PATH에서 host Node/pnpm을 제거했다. 개인 앱 설치를 교체하거나 서명·공개 배포하지 않았다.

## 화면·키보드

실제 unpacked 앱에서 200% 배율의 설정 모달과 단축키 경계·작업 화면 복귀를 확인했다. `apps/desktop/release/desktop-smoke.png`, `settings-200-percent.png`는 임시 화면 증거다.

인앱 production Studio에서는 [P28 편집 여정](Development-Workbench-Daily-Driver-2026-10-23.md)의 미저장 초안·Undo/Redo·설정 Escape 닫기·트리거 포커스 복귀를 확인했다. 390×844 CSS px에서 document scrollWidth도 390으로 가로 넘침이 없었으며, 검사 내용·실행/출력 조작과 **대화로 돌아가기**, 컴포저에 접근했다. 패널 선택을 키보드 Enter로 열고 Escape로 닫았다. 원본 크기 캡처는 `/tmp/corral-p29-narrow-chat.png`다. 이 표본 확인을 전체 WCAG 적합성으로 확대하지 않는다.

검증용 앱·프로세스·worker·언어 서버·workspace·브라우저 탭을 정리했다. 원본 데이터는 보존됐다.

## 남은 환경 조건

현재 Linux 코어 인수는 완료했지만 P29 전체 플랫폼 qualification은 완료하지 않았다. Windows/macOS·다른 arch·AppImage/NSIS/DMG 설치·서명/실제 업데이트/rollback·실제 IME/스크린리더·대규모 부하와 p95/idle CPU·외부 host/provider는 각각의 환경에서 확인해야 한다. 기존 12개 process 상한을 높이지 않았고 새 성능 예산도 임의로 만들지 않았다. 남은 조건은 [활성 계획](../plans/workbench-development-implementation-plan-2026-10-21.md)과 [Desktop 계획](../plans/desktop-completion.md)에 유지한다.
