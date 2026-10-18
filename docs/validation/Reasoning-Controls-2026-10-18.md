# 역할별 추론 설정 검증 — 2026-10-18

기준 main `6ada359`, CR-021 / C-084. 새 의존성 없이 설치된 Pi 1.3.0과 기존 Mixdog v6 ONNX 자산을 사용했다. Oracle Pro의 계획 및 구현 검토를 반영했다.

## 구현 검토에서 보완한 경계

- legacy worker의 늦은 지시는 실제 준비된 context에 포함됐는지 확인한 뒤 전달 처리한다.
- SDK 준비 중 받은 지시는 context 재준비와 Pi steering queue에 중복으로 들어가 추가 요청을 만들지 않는다.
- ONNX의 반복 close 호출은 같은 실제 worker 종료를 기다린다. timeout만으로 추론 점유를 해제하지 않는다.
- 실행 모드 저장을 순서대로 처리해 늦은 live 저장이 최신 mock 선택을 덮지 않는다.
- 실행 시작 뒤 정의 조회가 실패해도 SSE·취소 제어를 유지하며 정의 조회만 다시 시도한다.
- Pi의 실제 serializer에서 off → none과 provider_default의 필드 생략을 검사한다. 비추론 모델에는 수동 단계를 노출하지 않는다.
- Mixdog 입력은 Unicode 코드 포인트로 제한하며 private IPC 크기도 그 최대값을 수용한다.
- observe와 apply는 Run의 판정 한도를 공유한다. 다른 노드의 미래 설정 변경으로 현재 요청을 불필요하게 폐기하지 않는다.

앞의 다섯 경계는 수정 전 실패를 재현하고 수정 후 회귀를 통과했다. capability, 실제 serializer, Unicode, 공통 한도도 결정적 테스트로 확인했다. 일반 테스트에서는 외부 LLM을 호출하지 않는다.

## 실제 계정과 빌드 검증

Linux x64 Electron 패키지에 포함된 Node·서버·Studio·두 Pi worker를 사용했다. Computer Use는 이 패키지의 로컬 서버와 UI에 인앱브라우저로 접속했다. 별도의 native Electron smoke는 앱 실행·재시작·복구를 검사한다. native 창을 직접 조작한 실계정 검증으로 표현하지 않는다.

기존 Codex OAuth 계정을 사용했다. 응답을 대체하지 않는 observer가 최종 provider payload의 모델/추론 필드만 기록했고, SQLite의 요청별 기록과 대조했다. 전체 배치에 48회 준비 호출 한도를 적용했다.

| 흐름 | Run | 실제 모델 요청 | 확인 |
| --- | --- | ---: | --- |
| Luna low | `run_1939eb24766746f299d704aa28db05fd` | 3 | 세 요청 모두 low, 정상 결과 |
| Luna high | `run_853f07fe37244df69ab0ae1f35d672e6` | 3 | 세 요청 모두 high, 저장·reload 유지 |
| Sol low | `run_72d83f90bcdd428c83020905150af3d4` | 3 | 세 요청 모두 low, 정상 결과 |
| Sol high | `run_02b90c62045e47aea4a6e385d2787829` | 3 | 세 요청 모두 high, 정상 결과 |
| Sol auto, SDK | `run_27bfd3318eb0437ba273c9d76bb04b25` | 3 | ONNX v6 turn/step 판정 → 실제 low, fallback 없음 |
| Luna auto, legacy | `run_1948b068d85440d9bc8dda06547b07d1` | 3 | ONNX v6 turn/step 판정 → 실제 low, fallback 없음 |
| 첫 파일 작업 | `run_2a2ab63b4d714d8a92a96b2db0d8fc70` | 10 | 파일 수정·모델 설정 확인. 테스트 하네스에서 검사 선택 누락, 검사 완료로 계산하지 않음 |
| 파일 수정 → 승인 → 검사 | `run_3914d4f6814242a9bd52396832dff816` | 11 | Sol/high 구현 → Luna/auto 검증, check_1 실제 실행, 5개 검사·exit 0 |

검사 완료 Run은 새 작업 복사본에서 시작했다. 소스 폴더와 `check.mjs` hash는 그대로이고 작업 복사본의 `tags.mjs`만 변경됐다. 저장된 역할 둘은 Luna/low를 유지하고, Run snapshot과 실제 payload에는 이번 실행의 Sol/high·Luna/auto가 기록됐다. 실행 후 composer의 일회성 설정도 초기화됐다.

재시작 뒤 이력·live 선택은 유지되고 자동 재실행은 없었다(호출 수 39회 그대로). 이후 Luna provider_default Run `run_490133324df44df9aa7ee6caf7b261fd`가 세 요청 모두 실제 추론 필드를 생략하고 성공했다. 최종 실호출은 **42/48회, Run 9개**다. 첫 검사 선택 누락 Run은 검사 완료 증거에서 제외한다.

최종 결과 화면의 고정 “파일 변경·검증 명령 없음” 문구도 실제 검사 이력과 모순됨을 확인했다. WBTST-010을 실패 재현 후 수정하여 이 근거 없는 배지를 제거했다. 실행·검토·제출 상태는 그대로 표시한다.

Linux x64 AppImage와 native DW-07 smoke가 통과했다. smoke는 격리 app-data, SQLite 이력, draft/theme/route, 단일 인스턴스, 종료 결정, renderer/sidecar 복구, 시작 실패 재시도, 재열기 및 호스트 Node/pnpm 부재를 확인했다.

결과 배지 수정 시점 Linux AppImage SHA-256 (아래 접힌 패널 최적화 전): `a2f0c1acaf34964f698e8888fd245dd30e69e58e91a1d8e861fde7c53cd5a1f8`. 마지막 변경은 결과 배지 제거이며, 새 패키지에서 저장된 검사 완료 Run을 다시 열어 수정된 표시를 확인했다.

CI의 Playwright는 컨테이너 CPU 배정과 별개로 호스트 CPU 수를 읽어 6개 브라우저 worker를 띄웠고, Firefox의 짧은 지시 입력 구간과 키보드·승인 대기에서 시간 실패를 재현했다. CI worker를 2개로 명시했다. 재시도, 단정, timeout은 변경하지 않았다.

## 초기 구현의 로컬 게이트

`act pull_request -j gate -W .github/workflows/pr.yml` 완료(exit 0). Ubuntu 24.04 image, Node 24.19.0, pnpm 10.30.3, Python 3.12, CPU affinity 0–3을 사용했다. 스펙 1,307 checks, 생성 스키마, lint, typecheck, unit 988 passed / 5 opt-in skipped, build, E2E 178 passed / 1 skipped가 통과했다. 실패한 선행 실행을 성공으로 집계하지 않았다. 초기 구현의 모든 정규 E2E를 2 workers, retry 0으로 다시 실행했다.

## PR CI에서 발견한 추가 UI 부담

첫 PR CI는 unit/build 통과 후 Firefox Loop 승인 E2E 하나가 15초 안에 승인을 표시하지 못했다(177 passed / 1 failed / 1 skipped). 1 CPU·2 worker로 재현했을 때 두 번 모두 실패했다. trace에는 접힌 설정 선택 상자까지 반복 렌더링되는 기록이 있었고, `RunRoleOverrides`가 숨겨진 Base UI 선택 상자를 계속 마운트하고 있었다.

선택 상자는 패널을 열 때만 마운트하도록 바꿨다. 값은 상위 상태에 유지한다. 숨겨진 selector가 마운트되는 단위 테스트를 red → green으로 확인했고, 같은 1 CPU·2 worker 조건의 Loop E2E 두 번 모두 통과했다(20.7/20.8초는 전체 테스트 시간이며 승인 대기 15초 단정은 그대로). 패널 닫기·다시 열기·일회성 high 적용·저장된 low 유지도 검증한다. 재시도나 timeout 완화로 통과 처리하지 않았다.

## 증거 범위

자동 판정의 배선과 실제 적용을 확인했으며 분류 정확도, 모델 내부 추론량, 비용 절감률은 측정하지 않았다. 수동·자동 설정의 provider wire 검증 범위는 Pi 1.3의 OpenAI Responses / Codex Responses다. 다른 transport에는 검증되지 않은 수동 선택을 허용하지 않는다. macOS·Windows 패키지는 이번 검증 대상이 아니다.
