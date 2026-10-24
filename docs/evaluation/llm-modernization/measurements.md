# 측정·검증 원장

이 문서는 CR-052의 환경별 실행 증거다. 현재 계약은 [runtime](../../current/llm-runtime.md), 변경 원인과 호출 원장은 [보고서](report.md)에 있다. baseline은 `401bdf463efab4784cb25c686867ed18f2c5379c`; 공급자는 ChatGPT 구독 `gpt-6-luna`, Hive `deepseek-ai/deepseek-v4.1-flash-1017`이다. API 키·토큰·사용자 대화 원문을 증거에 포함하지 않았다. live 입력은 합성 fixture다.

## 실제 비교의 조건

두 비교는 역할이 다르다. chooser는 같은 180행 후보 prefix에서 선택 JSON만 반환한다. main Core는 91,000자 참고문에 들어 있는 처음/중간/끝 marker를 artifact로 저장하고 submit_result로 끝낸다. reasoning은 모두 off다. 동일 provider 안에서 AB/BA 순서를 번갈아 적용한다. provider 캐시가 조건 사이에 공유될 수 있고, 네트워크와 머신의 모든 외부 부하는 통제하지 않았다. 일반 업무 성능이나 비용에 그대로 외삽하지 않는다.

main Core의 contextWindow는 의도적으로 32,768, reserve/keep은 각 8,192로 고정했다. native 272k/1m window에서 압축이 필요 없는 동일 입력의 속도를 측정한 것이 아니다. 매 Run 실험 상한은 6회 모델 호출, 누적 출력 8,192, 호출당 출력 2,048, 120초다. 제품의 무제한 기본값에 한도를 다시 넣은 것이 아니라 이 live 실험에 명시한 제한이다. 공급자 인증/할당량 오류면 해당 공급자 조건을 중단한다.

### Chooser — 완료된 120회

| 공급자 | 조건 | 완료/성공 | 지연 p50 / p95 ms | 첫 event p50 ms | 입력 / 출력 토큰 합계 | cache read / 관측 호출 |
|---|---|---|---|---|---|---|
| ChatGPT | 기존 | 30/30 | 2584 / 3812 | 1864 | 119700 / 753 | 38400 / 10 |
| ChatGPT | 변경 | 30/30 | 2414 / 3600 | 1689 | 119700 / 736 | 107520 / 28 |
| Hive | 기존 | 30/30 | 1676 / 3585 | 1312 | 119640 / 869 | 99840 / 26 |
| Hive | 변경 | 30/30 | 1733 / 3715 | 1690 | 119640 / 864 | 103680 / 27 |

원시 집계는 [chooser-summary.json](evidence/chooser-summary.json), 개별 측정은 [chooser-samples.json](evidence/chooser-samples.json)이다. 이 초기 집계의 p95는 정렬 후 floor((n−1)×0.95) 위치를 사용했으며 최종 main 표의 nearest-rank와 구분한다. cache read가 있는 호출 수는 token hit ratio와 다르다. 구독 사용량을 무료 API 요금으로 표시하지 않으며 Hive의 미확인 단가로 USD를 계산하지 않았다. 이 비교는 당시 chooser runtime 기준이며 이후 summary 목적 분리·TaskBrief 투영·anchor 보정은 메인 실행 경로 변경이다.

### Main Core — 최종 소스 고정 비교

최종 고정 소스에서 30 AB/BA쌍씩 두 공급자를 비교했다. 앞선 후보 측정과 분리한다.

| 공급자 | 조건 | 성공 / marker / strict output | p50 / p95 ms | 입력 / 출력 토큰 | cache read | 요약 / 물리 호출 |
|---|---|---|---|---|---|---|
| ChatGPT | 기존 | 30/30 · 30/30 · 28/30 | 6283 / 8707 | 1086460 / 2110 | 53760 | 0 / 60 |
| ChatGPT | 변경 | 30/30 · 30/30 · 29/30 | 17992 / 21157 | 645833 / 16125 | 0 | 30 / 90 |
| Hive | 기존 | 30/30 · 30/30 · 29/30 | 6057.5 / 9022 | 1107461 / 3679 | 372480 | 0 / 60 |
| Hive | 변경 | 30/30 · 30/30 · 30/30 | 10032 / 15412 | 709929 / 25953 | 58112 | 30 / 95 |

모든 조건 30개 terminal sample이며 성공률 30/30, 세 marker 보존 30/30이다. p50은 중앙값, p95는 nearest-rank ceil(0.95×n)이다. strict output은 marker 외 문구/공백도 완전히 같은지를 검사한 별도 지표다. 인증/할당량 중단은 없었다.

입력 토큰은 ChatGPT 40.6%, Hive 35.9% 감소했지만 p50은 각각 2.86배, 1.66배 증가했다. 요약 출력 증가와 cache read 감소도 함께 기록한다. 이 fixture에서 비용/속도 개선을 주장할 근거는 없다. 요약은 컨텍스트 여유가 필요할 때 쓰는 수단이며, native window에서 불필요하게 강제할 이유가 없다.

[최종 집계와 frozen source hashes](evidence/main-summary.json), [120개 개별 결과](evidence/main-samples.json). 메인 fixture는 첫 토큰 시간을 직접 관측하지 않았으며 첫 model completion을 TTFT로 표시하지 않는다. queue/cancel 지연의 live 분포와 cache write는 이 비교의 미측정 항목이다.

첫 번째 후보에서는 ChatGPT 입력 1,086,449→645,303, Hive 1,107,623→691,780으로 감소했지만 p50은 각각 6,269.5→18,362ms, 9,212→16,969.5ms로 증가했다. Hive는 변경 조건 29/30 성공이었다. 이 결과를 보고 summary/output-contract 충돌을 찾아 고쳤으며, 수정 후 새 고정 소스로 두 조건 모두 다시 30쌍을 실행했다. 첫 후보 수치를 최종 개선율로 재사용하지 않는다.

### 실제 경로·내용 보존

- Core/SDK × 일반/Linux bwrap: ChatGPT 네 조건 성공. Hive 초기 네 조건은 host가 endpoint bound credential을 bare key로 덮어써 전송 전에 실패했다. 수정 후 Hive 네 조건 모두 성공했다. ChatGPT 자료는 [ChatGPT matrix](evidence/chatgpt-matrix.json), 실제 Hive 교차 검증은 [Hive matrix](evidence/hive-matrix.json)에 있다.
- 최종 91,000자 기능 시험: ChatGPT/Hive × Core/SDK 네 조건 모두 성공, marker 3개 보존, 요약 1회, private archive reopen 성공. Hive SDK는 저장한 전체 문자열이 strict fixture와 완전히 같지는 않았지만 필수 marker와 완료 계약은 지켰다. [context-live.json](evidence/context-live.json). 네 조건 각 1회이므로 품질 동등성의 통계적 근거는 아니다.
- 실제 회의: ChatGPT+Hive 두 참가자, 두 round, 네 호출. 최대 실제 병렬 2, 다음 round에서 두 참가자 모두 이전 checkpoint를 사용하고 이전·새 marker를 기억했다. 재열람으로 새 호출 0. [meeting-live.json](evidence/meeting-live.json).
- 음성 sideband·이미지 정산은 loopback/fixture만 실행했다. 승인된 ChatGPT 구독/Hive chat 연결을 Realtime·image API 인증으로 간주하지 않았다.

## 결정적 성능과 원본 대조

| 실험 | 결과 | 해석 범위 |
|---|---|---|
| 64KiB text, 64byte 입력 delta, 1 block | 8 IPC frame / 263597 bytes | 1MiB 인수 기준 통과 |
| 같은 출력, 64 blocks | 194 frame / 288890 bytes | block 전환에서도 누적 본문 재전송 없음 |
| 128KiB, 1 / 64 blocks | 526169 / 551034 bytes | 출력 2배에서 전송량 약 2배 |
| 100 growing checkpoint | 기존 canonical bodies 32580282 → 새 bodies 1564951 bytes, 104 unique chunks | 본문 저장량, SQLite 압축/실제 디스크 I/O 지연 아님 |
| 같은 checkpoint CPU | 145 → 316ms | 저장량 감소 대신 encoding/hash CPU 증가 |
| 원본 differential | PI 15 fixture / 30 assertion, DSH retry delay 6 cases | 동일 알고리즘 부분만 원본 직접 실행; 전체 upstream suite 아님 |
| Bedrock maxRetries=0 loopback | payload hook 1 / 실제 HTTP 1 | 기존 SDK 내부 3회 전송과 달리 physical attempt 정렬 |

[performance.json](evidence/performance.json), [differential.json](evidence/differential.json). 모델 동시성 1/3/6과 105회 장기 실행은 결정적 fixture로 검증했다. 동시성별 실제 공급자 지연 분포, 모든 모델의 cache-write TTL, 취소 시간의 live p95는 측정하지 않았다. 추정 토큰을 정확한 tokenizer 값으로 표시하지 않는다.

## 회귀와 gate 상태

초기 구현 후보의 마지막 전체 suite: 399파일, 2179 passed / 9 failed / 23 skipped. 9개 실패는 기준선에서도 재현된 기존 UI 검증 문제다. 실패 테스트를 삭제하거나 기대값을 낮추지 않았다. 실제 Hive 요약 충돌 수정과 source fork 회귀까지 반영한 당시의 마지막 전체 실행이다. 집중 검사 4파일 96개도 통과했다. 테스트 개수를 합산하여 별도의 전체 PASS로 표시하지 않는다.

| 기존 실패 | 수 | 근거/영향 |
|---|---|---|
| Studio design guard | 2 | 기존 type scale·semantic color token 검사 |
| RunPage.layout | 3 | 테스트 환경 ResizeObserver 부재 |
| GitPanel | 1 | 테스트 환경 matchMedia 부재 |
| TerminalPanel | 1 | 분리된 span의 receipt 문구 matcher |
| markdownAgentImport | 1 | full graph fixture의 기대값 |
| Timeline Story | 1 | Base UI trigger에 native selectOptions 적용; 기준선 Story 별도 재현 |

브라우저 선택 suite 22개 중 17개가 첫 실행에서 통과했다. 회의 중지의 Run 수 fixture는 병렬 답변 계약에 맞춰 고쳐 통과했고, 새 draft→사용량 원장→동일 ID 재조회도 통과했다. 남은 모델 설정 4개는 같은 기존 graph drag helper에서 실패했다. 동일한 실패를 기준선의 대표 1개에서 직접 재현했고 helper는 변경하지 않았다. 4개를 각각 기준선에서 재실행했다는 주장은 하지 않는다.

설치판 smoke는 예전 radio/중첩-menu Escape 절차에서 실패했다. 현재 kit의 Appearance combobox와 명시 닫기 버튼으로 절차를 갱신한 뒤 실제 Linux unpacked 앱에서 SQLite 이력·초안/테마/route·단일 instance·quit 확인·renderer/sidecar 복구·시작 재시도·workspace 재열기가 통과했다. 입력/복구 assertion을 제거하지 않았다. 전체 출시 gate가 통과했다는 뜻은 아니다.

| 초기 구현 후보 gate | 결과 |
|---|---|
| pnpm typecheck | 전체 workspace·tools·live test 타입 검사 통과; 이후 Desktop smoke 수정의 Desktop typecheck도 통과 |
| contracts:check / deps:check | generated schema 일치, exact versions/Node/peer/dependency review 통과 |
| spec:check | 통과; PASS (5850 checks); 415/419 scenario tags (카탈로그 선언과 실행 결과는 별도) |
| 전체 Vitest | 2179 passed / 9 baseline failures / 23 skipped, 399파일. 전체 PASS 아님 |
| 최종 production browser | 병렬 회의 중지·새로고침 복구 2/2, 초안/usage/receipt·profile context 2/2 |
| Studio build | 통과. 기존 large chunk/ineffective dynamic import 경고 유지 |
| Linux prepare / license | 874 package versions SPDX·고지, 374 loaded module containment, SQLite/ONNX/PTY·Core/SDK handshake 통과 |
| 실제 AppImage | isolated app-data, host Node/pnpm 없는 실행·재열기·복구 smoke 통과 |
| 배포 source/worker/Pi parity | 291 compiled files, 1951 dependency files, 29088 packaged files 대조. 누락은 upstream test의 .gitkeep 2개뿐 |

배포 identity와 SHA-256: [distribution.json](evidence/distribution.json), [파일별 hash 원장](evidence/package-hashes.json.gz), [검증 집계](evidence/validation.json). 패키징 이후 갱신하는 최종 보고서/측정 문서는 runtime 코드 hash의 범위에서 제외한다. 제품 소스·worker·Pi 의존성은 동일하다. AppImage 재압축 중의 실행 시도는 최종 smoke 증거에서 제외했다. 초기 AppImage 단일-instance 보조 프로세스 검사는 추출 로그가 execFile stdout buffer를 넘었으므로, 로그를 버리는 spawn으로 바꾸고 종료 코드/시간 제한/기존 창 보존 assertion을 유지하여 재검증했다.


## 재현 명령과 이관 증거

```sh
pnpm typecheck
pnpm exec vitest run --maxWorkers=4
pnpm contracts:generate
pnpm contracts:check
pnpm deps:check
pnpm spec:check
node docs/evaluation/llm-modernization/probes/ast-map.mjs /tmp/corral-ast
node docs/evaluation/llm-modernization/probes/performance.mjs /tmp/corral-performance.json
node docs/evaluation/llm-modernization/probes/differential.mjs PI_PINNED_CHECKOUT DSH_PINNED_CHECKOUT /tmp/corral-differential.json
pnpm --filter @corral/studio build
pnpm --filter @corral/desktop prepare:runtime
pnpm --filter @corral/desktop package
node docs/evaluation/llm-modernization/probes/verify-package.mjs apps/desktop/release/linux-unpacked/resources/runtime /tmp/corral-package-hashes.json
node apps/desktop/scripts/smoke.ts apps/desktop/release/linux-unpacked/corral
```

지원 Node 24.19.0과 Node LICENSE가 있는 runtime으로 prepare를 실행했다. spec/inventory는 tools/requirements.txt의 jsonschema가 필요하며 CORRAL_PYTHON으로 독립 venv를 지정했다. CI에 live 모델 호출을 넣지 않았다.

Migration 시험은 기존 정의의 새 unlimited revision·backup receipt·재실행 idempotency, 옛 snapshot/hash 보존을 확인했다. checkpoint v1/v2와 저장 실패, source revision 불일치·foreign tool source 조회 거절, 재시작 후 새 Run에서 축약 원문의 중간 범위 조회를 검사했다. SDK manual/automatic/overflow 요약, 두 번째 요약의 이전 checkpoint 보존, 잘린/더 큰/낡은 요약 거절도 포함한다.

배포물에는 PI LGPL 별도 패키지, 완전한 대응 소스, build/lock/patch 파일, GNU GPL/LGPL·DSH MIT 전문, 수정 내역, SPDX SBOM을 포함한다. source manifest와 runtime/worker/dependency hash는 최종 산출물 검증 결과에 연결한다. Windows/macOS 설치·서명·업데이트, 실제 Realtime/image provider, SDK 일반 과제 30표본 품질 검증은 미실행 범위다.

실제 main A/B 재현은 [live-main.mjs](probes/live-main.mjs)를 사용한다. `CORRAL_LIVE_LLM=1`이 없으면 네트워크 작업 전에 거절한다. 인자는 baseline checkout, `{root,sourceHashes}` 형식의 동결 후보 manifest, 로컬 비공개 모델 config, 결과 JSON 순이다. final main-summary의 sourceHashes를 사용하고 root는 대응하는 고정 소스 경로로 지정한다. source hash가 다르면 실행 전에 실패한다. 일반 CI는 이 스크립트를 호출하지 않는다.

Oracle에는 새 세션으로 소스 bundle을 두 번 다시 전달했다(34개·40개 선택 파일 및 diff, 두 번째는 Coordinator 전체 포함). 과설계·중복 guard·불필요한 테스트도 검토하도록 요청했다. 의견만으로 변경을 승인하지 않았고 취소/late usage, HTTP 429, 복구 source, SDK 최초 압축 등은 독립 반례로 검증했다. 소스 bundle 자체를 보고서에 중복 저장하지 않았다.

## Oracle 후속 검증

이하 결과는 저녁의 단순화 수정 후보에 한정한다. 위의 실제 A/B는 이전 후보에서 측정한 결과다. 이번에는 유료 A/B를 반복하지 않고 관련 mock/loopback·복구 회귀를 먼저 확인했다.

- Red: bridge/runtime를 연결한 다음 요청이 raw density 재검사에서 거절됨; 요약 후 재시작 원문 조회 실패; 생성 증거가 source candidate를 바꿈; 기존 checkpoint 본문 재조회.
- Green: 요청/bridge/SDK/Core·원문 복구/fork 집중 검사 112개, release 검사 10개. 새 회귀는 기존 fixture를 확장했고, 밀리초 기반 성능 suite를 만들지 않았다.
- 재사용한 원문/본문 조회 수, 같은 실행 anchor 사용 및 다른 실행 격리, 생성 결과와 실제 입력의 hash 경계를 확인했다.
- 타입·계약·의존성·문서 검사와 Studio production build 통과.

후속 후보는 `48c3cc0cb323a2286d805811dc2bfe4d359e2d094cee01e75a8352a7b746b2a6`으로 고정했다. 이후 전체 suite, 설치판 빌드, 실제 AppImage smoke, 소스→출력→설치판 대응 검사를 각각 한 번 실행했다.

| 후속 검증 | 결과 |
|---|---|
| 전체 Vitest | 399파일, 2180 passed / 기존 UI 실패 9개 / 23 skipped. 전체 PASS 아님 |
| 소스 문서 검사 | 2931 checks 통과, 415/419 scenario tags. 설치판 내부의 소스 복사본은 검사 대상에서 분리 |
| Linux runtime 준비 | 874 package versions 고지·SPDX, 374 loaded module containment, SQLite/ONNX/PTY·Core/SDK worker 기동 통과 |
| 실제 AppImage | 격리 app-data, host Node/pnpm 없이 실행, single instance·종료·기록/초안/테마/경로·renderer/sidecar 복구·시작 실패 재시도·workspace 재열기 통과 |
| 설치판 대응 | source 1366개, compiled JS 291개, Pi dependency 1951개, packaged files 29070개 일치. 제외 파일은 upstream test의 `.gitkeep` 2개 |
| 증거 기록 후 identity | 동결 candidate = 빌드 manifest = AppImage runtime metadata = 증거 기록 후 candidate |

[후속 검증 집계](evidence/oracle-followup-validation.json), [후속 설치판 identity](evidence/oracle-followup-distribution.json), [파일별 hash 원장](evidence/oracle-followup-package-hashes.json.gz)을 남겼다. 이전 A/B와 설치판 증거는 원래 candidate에 대한 기록으로 보존한다. 이번 후보의 유료 A/B·Windows/macOS·실제 음성/이미지 공급자 검증은 수행하지 않았다.

패키징 후 문서 검사는 `staging/corresponding-source`까지 순회해 의도적으로 제외한 생성 보고서의 링크에서 실패했다. 검사기나 원본 문서 검증을 약화하지 않고, 대응 검사까지 마친 `staging`·`linux-unpacked`를 작업 트리 밖 임시 디렉터리에 보존한 후 원본 소스를 검사했다. 최종 2931회는 복사본의 중복 검사를 제외한 수치다. 실제 AppImage는 `apps/desktop/release/`에 유지했다.

후속 결과 파일만 작성한 뒤에는 같은 후보의 검사·빌드·live 호출을 다시 시작하지 않는다.

## Chooser 정산 보완 검증

별도 [당시 후보 집계](evidence/chooser-accounting-validation.json)에 기록한다. 기존 live A/B·설치판·전체 suite 결과의 후보 ID를 바꾸지 않았다.

- 수정 전 4개 반례가 실패했다: 두 물리 요청의 허용량 대신 256 한 건 예약, usage 없는 완료 응답을 0으로 처리, timeout 후 잘못된 미확인 예약, 전송 전 admission timeout의 가짜 예약. 기존 Core의 미확인 사용량 회귀도 정해진 256 대신 fixture의 실제 attempt 허용량으로 검증하도록 연결했다.
- 수정 후 관련 8파일 86개 통과. 선택 JSON·thinking 분리, 최소 chooser 추론, 요청 취소·재전송, 파일 기준 확정, 예산 patch·event replay, 늦은 usage와 완료 응답 보존을 포함한다. Core·Server 타입 및 generated schema 검사 통과.
- 재시도 두 번의 실제 허용량 각각 128,000토큰이 예약에 일치하고, 보고된 출력 7 + 700을 각각 정산하고 합산한다. 이 수치는 해당 mock 모델 metadata이며 제품의 고정 상한이 아니다.
- 응답 위험: host 슬롯 1개를 점유한 상태에서 30초가 지나면 chooser 전송 0회·`timeout`·`single` fallback을 재현했다. 관련 정산은 0건이 맞지만 자동 팀 선택은 생략된다. 기존 timeout 정책은 이번에 변경하지 않았다.
- 전체 suite·배포물·유료 A/B·실제 답변 품질 검증은 이번 수정 범위에서 미실행이다.

## Chooser 슬롯 대기·응답 timeout 분리 검증

앞 절에서 재현한 슬롯 대기 중 fallback을 수정했다. [이번 후보 집계](evidence/chooser-timeout-validation.json)는 앞 절의 정산 후보와 별개다.

- Red: 슬롯을 60초 기다린 뒤의 정상 선택, 같은 대기 중 명시적 취소, 25초 응답·40초 Retry-After·25초 응답의 재시도 등 3개 반례가 기존 timer 위치에서 실패했다.
- Green: 관련 7파일 75개 통과. 슬롯 해제 뒤 29,999ms의 응답도 모델의 팀 선택을 보존한다. 대기 중 취소는 provider 호출·Run·미확인 예약을 만들지 않으며, Retry-After와 슬롯 재획득은 다음 요청의 30초를 소모하지 않는다.
- 기존 실제 전송 후 30초 무응답 fallback, 공급자 abort 무시, 늦은 usage, 중복 start/cancel, 선택 JSON 검증·최소 추론·정산 회귀가 함께 통과했다. 시간은 fake timer로 제어했으며 실제 공급자 지연 수치가 아니다.
- Server 타입 검사와 generated schema 검사 통과. 문서 검사 결과·후보 hash는 위 집계에 기록한다. 같은 범위에서 추가 응답 퇴화는 발견하지 않았다.
- 전체 suite·배포물·유료 A/B·실제 답변 품질 검증은 재실행하지 않았다. 기존 전체 suite의 실패 9개와 과거 설치판 후보는 그대로 기록한다.
