# 품질 작업 실행 기록 — 2026-10-21

- 기준: `d02898b680cc8b7c44e3e16ee2287474a22794b7`, `feat/complete-quality-workflow`.
- 현재 사용자 승인 범위: C-118 → 가능한 OS 패키지 검증 → CR-036-C/D → 준비된 외부 연동. C-114는 범위 밖이다.
- 환경: Linux x86_64, Node 24.19.0, pnpm 10.30.3. Windows/macOS 실기는 사용자가 별도 후속 검증으로 지정했다.
- 현재 연결된 OAuth/API live 시험은 사용자 승인됨. GPT 구독 인증을 우선한다. 외부 대상이 없는 SSH/S3를 임의 구성하지 않는다.

## C-118 격리 검사

새 Ultra의 저장소 요청은 effective harness의 검사 선택을 recipe에 고정한다. 종합 시작 전 서비스 정리 후 후보 tree를 고정하고, Coordinator가 검사와 교차 검토를 연결한다. 텍스트/legacy 요청은 기존 경로를 유지한다. 정확한 계약은 [CR-031](../change-requests/CR-031-ultra-quality.md)의 코딩 검사 절이다.

실패 확인: 기존 코드에서 검사 호출 0회인 성공, 격리 요청을 일반 host 명령으로 실행, Git filter의 host 실행, 서비스 정리 후 변경된 tree의 성공을 재현했다. 등록 검사 없음/격리 미지원/오류/stale/격리 증거 누락/모델 pass에 의한 검사 fail 덮기는 회귀에서 차단한다.

Linux 실제 bubblewrap으로 host 파일·환경·Git 관리 경로·외부 network interface 차단을 확인한다. 전용 JSON 상태 채널, PID namespace init 종료, detached 자식과 취소, exec 실패, 필터 없는 snapshot/checkout/status, 별도 격리 fingerprint를 검사한다. 일반 Git 작업의 사용자 filter 계약은 유지한다.

Oracle: 인앱 ChatGPT의 현재 Pro 모델로 설계와 기준 commit을 검토했다. [검토 대화](https://chatgpt.com/c/6ad838f6-18e0-83ee-b4a0-f5768dff9464). 후보 tree 연결, Git filter, launch identity, namespace cleanup, bootstrap 실패 분류를 보강했다. Oracle의 정적 검토를 실행 테스트로 집계하지 않는다. Bubblewrap 동작은 [공식 구현](https://github.com/containers/bubblewrap/blob/main/bubblewrap.c)과 설치된 CLI 설명에 대조했다.

검증: core Ultra/recipe + server runner/file broker 5개 파일 88개 테스트 통과(22.64초). core/server TypeScript, `spec:check` 2,090개 검사 및 TC 293/293, `contracts:check` 통과. C-118 전체 완료·다른 OS 지원·모델 품질 향상은 이 검사 연결만으로 주장하지 않는다.

## Provider conformance

Anthropic adaptive thinking의 기본 effort와 message-level effort를 API key/OAuth serializer + 결정적 429 HTTP로 확인했다. SDK가 본문의 beta 설정을 헤더로 옮기는 변환까지 permit에 묶으며 추가 dispatch/변조를 거절한다. provider default 및 광고한 모든 수동 추론 수준도 실제 serializer로 확인했다. 4개 파일 19개 테스트(실제 Linux Pi worker 2종 포함)가 통과했다. 이는 Anthropic 구독 로그인 지원이나 실제 공급자 품질 검증이 아니다.

Gemini는 설치된 Pi 1.3.0에서 custom fetch를 거절하는 것을 네트워크 0회로 재현했다. Ultra permit 경계를 지킬 수 없어 미지원 상태를 유지한다. 구형 Anthropic budget-thinking도 이 conformance 범위 밖이다.

## GPT OAuth와 Linux 패키지 검증

- `8349579` 소스의 GPT OAuth Ultra 텍스트 fixture: 요청 10회, 61.56초, 성공, 미확정 사용량 0. 두 실제 GPT 모델이 종합·교차 검토를 완료했다. 코드 저장소 검사나 품질 비교 시험은 아니다. 실행 후보 SHA-256: `76472edaad91e170e4fc139b55c0c458865767ef813bc15f5350716479f2af2d`.
- Studio build → Desktop prepare → AppImage package 완료. runtime 격리 검사에서 모듈 570개, SQLite/ONNX, 두 Pi worker handshake, 물리 파일 26,582개·링크 0개를 확인했다.
- Linux unpacked `smoke.ts`: DW-07 통과. host Node/pnpm 없는 PATH에서 SQLite history·draft/theme/route·단일 instance·quit·renderer/sidecar recovery·startup retry·workspace reopening을 확인했다. 첫 실행은 과거 `Start session`/template 선택 경로에서 실패했고, 공용 `teamFromTemplate`/`startSession` 절차로 수정 후 통과했다.
- 실제 AppImage를 `native-smoke.ts`로 실행: TC-ABS-007-H/004-H 통과. native 창·요청·interactive preview JS/CSS·cookie 분리·외부 이동 차단·lease 종료·단축키·원격 호스트 **등록 폼**·history/draft·tray·second-instance·restart. 합성 오디오 장치 동의와 카메라 거절도 확인했다. 외부 SSH 연결·실제 음성 기기 시험으로 집계하지 않는다.
- 산출물: `apps/desktop/release/Corral-0.1.0-x86_64.AppImage`, 343,177,388 bytes, SHA-256 `5f94e25114d5125a820f92f2194f146816281425136ac41454211794cc46c174`. 게시/배포하지 않았다. Windows portable/NSIS·macOS·서명·실제 업데이트 피드 검증은 별도다.

## C-138/139 — Skill 평가·업데이트·롤백

기존 CLI evaluator를 core 공용 경로로 옮겨 Skill 관리 화면에서도 같은 Coordinator·고정 정답·전달 지표를 사용한다. 기본값과 분리된 불변 평가 프로필, 동일한 모델 snapshot, fixture/정의/리소스 hash와 실제 Run ID를 남긴다. 후보와 baseline(또는 Skill 없음)을 비교하며 mock 품질과 미측정 전달은 live 품질 증거로 취급하지 않는다.

사람의 검토 확인 뒤 선택한 개인/프로젝트 기본값에 Skill 하나만 바꾼 새 revision을 원자 적용한다. 변경 파일을 source/license/reference/script/manifest·권한으로 분류하고 변경 전후 본문·hash·크기를 열어 비교한다. 바이너리/64 KiB 초과 파일은 hash·크기 비교만 제공한다. 자동 upstream fetch는 하지 않는다. 롤백은 채택 당시 binding이 여전히 현재일 때만 허용하고 이전 신뢰를 다시 확인한다.

셀프리뷰에서 평가 초기화 오류 뒤 `running` 잔류와 증거 callback 실패 뒤 Run 잔류를 red test로 재현한 뒤 수정했다. 취소·늦은 결과·재시작 interrupted·terminal 증거 불변·중복 operation·사용자 수정·신뢰 철회·이전 snapshot 보존을 검증했다. 내부 평가 프로필은 생성 시 보관 상태로 두어 사용자의 활성 프로필 선택 목록에 섞이지 않는다.

서버/CLI/저장소/클라이언트 회귀 13개 파일 110개 통과. Linux Chromium production build E2E 3개 통과: 기존 Skill 설치/편집/기본값, SDK 확장 입력, 평가→본문 비교→검토→채택 응답 유실→같은 ID 재시도→새로고침→롤백. 평가 패널의 axe 검사 위반 0개. 전체 workspace TypeScript 검사 통과. 실제 모델 Skill 품질은 이 mock E2E와 별개다.

추가 파일 비교 경계까지 Skill service 9개 테스트 통과. `spec:check` 2,241개 검사·TC 297/297, `contracts:check`, `deps:check` 통과. 새 의존성은 추가하지 않았다. 구현 커밋은 `f7e233c`다.

## 최종 실제 연결·패키지 검증

이번 실행에서 기존 GPT OAuth·Hive API 연결 사용을 승인받았다. 사용자 비용 상한은 없으나 fixture 자체의 호출·시간 제한은 유지했다. 기본 자격 증명 저장소와 현재 workspace 설정을 값 노출 없이 확인했으며 SSH 등록 0개·S3 연결 0개·이미지 생성 프로필 없음이었다. OpenAI 인증은 OAuth이고 현재 Corral 음성/이미지 생성 경로가 요구하는 OpenAI API 키는 없었다. Hive의 등록 모델은 텍스트 모델이다. 임의 SSH/S3 대상이나 이미지/음성 endpoint를 만들지 않았다.

| 실행 | 후보·결과 | 경계 |
|---|---|---|
| GPT Ultra | `0a29ecb`, 후보 SHA-256 `fdcf80d90f336b1ed5b5172561d16aacbcd124ef5a4872bc2587d66476441f0c`: 요청 9회, 종합·교차 검토 성공, 같은 후보 확인 | 텍스트 fixture이며 전체 코딩 품질 비교가 아님 |
| Hive | 같은 후보, DeepSeek `deepseek-ai/deepseek-v4.1-flash-1017`, high wire·요청 2회·출력 249토큰·미확정 0, 설정 identity와 무작위 marker 일치 | provider 내부 모델 구현을 독립 증명하지 않음 |
| GPT 기본 실행·취소 | `da363d2`, 후보 SHA-256 `e0e12baae67535103658aac167a1106ba089d60e29792e8980edbadca20d888e`: 두 모델 각 2회 성공, 1회 요청의 text chunk 3개 뒤 Coordinator 취소, payload 기록 1개 | 취소 응답의 미확정 256토큰은 비용 확정으로 바꾸지 않고 유지 |
| GPT Skill 평가·채택·롤백 | 같은 후보: 4개 case·요청 9회·모두 성공·정답 일치·미확정 0. 한국어 positive에서 후보 Skill 전달, 일본어 negative에서 불필요 전달 없음. 실제 SDK worker/API 채택·롤백 통과 | Skill 없는 baseline의 positive 전달 실패는 예상된 결과. 이 작은 표본으로 일반 품질 향상이나 절차 준수를 주장하지 않음 |

첫 live 묶음에서 GPT 기본 실행·Ultra·Hive는 성공했으나 기존 취소 테스트의 수동 host가 필수 provider payload 기록 기능을 제공하지 않아 요청 전 거절됐고, 신규 Skill 테스트는 bootstrap Origin 헤더 누락으로 403을 받았다. 보안 경계는 유지하고 취소 테스트를 실제 Coordinator 경로로 바꾸고 Origin을 보충했다. 후속 live 실행은 2개 파일 4개 테스트 통과, opt-in 안내용 비활성 테스트 1개 skip(52.76초). 실패를 제품 성공으로 재분류하지 않고 재실행 결과로 구별한다.

최신 제품 소스(`f7e233c`, `0a29ecb`에서 패키징)의 Studio/runtime을 다시 빌드했다. 모듈 570개·SQLite/ONNX·두 worker handshake, 물리 파일 26,587개·링크 0개 확인. Linux unpacked DW-07 복구 smoke와 AppImage TC-ABS-007-H/004-H native smoke 모두 재통과했다. `0a29ecb`·`da363d2`의 변경은 live 테스트 코드이며 제품 런타임은 같다. 최신 AppImage는 343,197,853 bytes, SHA-256 `074f22793d53ac522bd16a8cdc688f3822d70b09587fa8037ea7d71814e06492`다. 파일은 `apps/desktop/release/Corral-0.1.0-x86_64.AppImage`이며 공개 배포하지 않았다.

로컬 결과 파일: `tests/live/test-results/{ultra,skill-quality}.json`, `tests/live/.last-run.json`, `test-results/live/hive-endpoint.json`. 실행 후보와 완료 시 후보 일치를 확인했으며 이후 증거 문서 수정은 제품 코드 변경이 아니다. 브라우저 trace의 평가/채택/롤백 화면을 직접 확인했다.

## 남은 경계

1. Gemini 단일 dispatch 지원은 상류 adapter 제약으로 남는다. Anthropic 실제 계정 호출·미지원 API 계열·Windows/macOS 실기는 별도 검증 대상이다.
2. 외부 SSH·S3·실제 마이크/음성·이미지 생성은 사용할 대상·지원 인증/장치가 준비되면 검증한다. 코드 부재나 검증 성공으로 표시하지 않는다.
3. C-114 후보 비교, 서명·업데이트 채널·전체 출시 게이트와 push/PR/merge는 이번 구현·커밋 범위에 포함하지 않았다.
