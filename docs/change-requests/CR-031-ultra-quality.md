# CR-031: Ultra 검증과 후보 비교

- 상태: **순차 구현 승인** — Bell, 2026-10-19: “플랜대로 M0부터 순서대로 개선 진행해. CR 등록 → 실패 테스트 → 구현 순서로 하고, 기존 기능 회귀도 확인해.”
- 계획: 통합 개선 실행 계획 (Git `373764467a52:docs/plans/Corral-Improvement-Execution-Plan-2026-10-19.md`), M4-1/2.
- 기준: `780591e`(PR #60 수정 포함). 구현/검증 완료 여부는 단계별 증거로 따로 기록한다.
- 추적: M4 착수 시 admission/파일 격리/eval 핵심 반례 등록.
- 후속: [CR-048](CR-048-ultra-candidate-tournament.md)(2026-10-23 작성 승인, 구현 대기)이 새 선택 형식에 한해 C-114의 opt-in 지위와 사람 선택 승격을 기본 후보 경쟁·자동 판정·고도화·자동 반영으로, 절대 예산·80% 중지를 사용량 한도 없음(사용자 취소만 유지)으로 대체한다. version 1 기록과 아래 계약은 그대로다.

## 계약

**2026-10-19 사용자 목표 보완:** Ultra의 목적은 서로 다른 회사의 복수 LLM을 최대 지원 추론으로 협업시키는 것이다. 아래 C-113의 단일 모델/effort 유지 조건은 legacy recipe에만 적용한다. 새 기본 Ultra는 versioned 모델 pool·역할 배정·최대 지원 추론·필수 교차 검토를 사용한다. C-114의 후보 비교는 선택 기능이며 동일 모델 조건을 제거한다. 기존 절대 예산·권한·취소 경계는 유지한다.

1. mode mock/live와 독립된 qualityPreset default/ultra를 시작 snapshot에 선택적으로 추가한다. 지원 built-in 팀만 planner→executor→verifier로 실행하며 수정은 최대 2회다.
2. 후보 비교는 검증 OS 격리·checkpoint·eval 뒤에 도입한다. 후보 기본 3/최대 5, 모델 동시성 최대 3을 분리하고 후보별 worktree/lease/비용을 소유한다.
3. 필수 검증 실패 후보를 먼저 제외하고 후보 하나만 승격한다. 전원 실패는 no_acceptable_candidate다. 자동 병합이나 사용자 팀·권한 변경은 하지 않는다.
4. 절대 예산에 계획/후보/판정/요약/검증/수정을 포함한다. 80%에서 신규 fan-out/revise를 멈추고 종료 비용을 예약한다. default 대비 최종 선택 결과·총비용·성공당 비용을 비교한다.

## 검증과 배포

새 동작과 데이터·권한·취소 경계의 대표 반례만 구현 전에 실패를 확인한다. 기존 통합 시험을 우선 확장하며 문구·내부 함수·모든 조합을 따라가는 시험은 추가하지 않는다. 적용되는 정상·실패·취소·중복·늦은 이벤트 경계는 기존 시험과 합쳐 확인한다. D&D·Reins·과거 snapshot/hash·[CR-042](CR-042-desktop-capabilities.md) ABS-06으로 확장된 host admission·작업 사본별 단일 writer 제한을 유지한다. live/OS/브라우저 증거는 결정적 fixture와 구별한다.


## C-113 Ultra 기본 프리셋

자동 세션의 시작 요청에 optional `qualityPreset: default | ultra`를 추가한다. 기존 미지정 경로와 저장된 정의/hash는 바꾸지 않는다. Ultra는 고정 write_review 팀과 기존 immutable review recipe를 사용해 planner→writer→수정 권한 없는 reviewer를 실행한다. 최초 실행+최대 두 번 수정(3회 검토)이며 반복 실패·예산 상한·취소는 기존 Coordinator가 종료한다. 사용자 정의 팀에는 프리셋을 적용하거나 역할/권한을 변경하지 않는다.

모델과 명시 reasoning, installation policy, 기존 기본 예산은 유지하며 template 선택 모델 호출은 생략한다. route reasoning은 기존 local 기본 medium을 쓰고 출처를 기록한다. 후보 fan-out과 80% 마무리 예약은 다음 C-114에서 같은 총예산 안에 추가한다. 기본/Ultra의 동일 과제 결정적 비교는 기능과 사용량 계측 증거이며 실제 품질 개선 주장이 아니다. UI 선택은 초안·재시도 identity와 Run/entry 기록에 남는다.

C-113의 토글과 `/ultra`, `corral exec auto --ultra`는 `createAutoStarter`에서 고정 정의를 만들어 같은 Coordinator 시작 경로로 전달한다. CLI custom 파일에는 적용하지 않으며 별도 파일 권한을 부여하지 않는다. 선택은 시작 metadata와 세션 요청/초안에 기록해 거절된 요청의 다시 편집도 보존한다.


## C-114 같은 Run 안의 후보 비교

Bell의 후속 요청에 따라 [upstream 비교](../spikes/Ultra-Upstream-Harness-Review-2026-10-19.md)를 먼저 수행했다. Pi 플러그인은 일괄 배제하지 않으며, 기존 Corral의 병렬 실행 경로와 공개 하네스의 용량·취소·권한 상속·사본 보존 패턴을 재사용한다. 별도 CLI 자식이 Corral permit을 우회하는 설치는 후보 실행 경로로 채택하지 않는다.

Ultra에 명시 candidate comparison을 추가한다. 기본 3개/최대 5개와 동시 3개 이하를 분리한다. Coordinator가 고정 candidate recipe와 기존 execution/worker/permit/settlement 경로를 사용한다. 별도 병렬 Run이나 모델이 호출할 새 오케스트레이션 도구는 만들지 않는다. candidate별 동일 baseline·criteria·허용 도구와 명시 모델 배정, 별도 durable worktree와 execution 소유권을 고정한다. file broker는 후보 execution을 세션의 기본 사본으로 fallback하지 않는다.

계획/후보/검토/수정/최종 검증은 같은 Run 예산이다. 마지막 검증을 위한 최소 모델 호출/출력 예약을 기존 총상한 안에서 보호한다. spent+reserved+unknown 사용량으로 80%를 판단해 새 후보/수정을 중지하고, 모델 permit 직전에도 보호된 마무리 예약을 차감한다. 입력/금액을 측정하지 못한 비용은 0으로 간주하거나 금액 상한이라고 표시하지 않는다.

후보 작업은 OS 격리와 등록된 검사 실행을 제공하는 환경에서만 시작한다. 코드 후보의 필수 검사가 없거나 unsupported/cancelled/unknown/failed/stale이면 acceptable이 아니다. 검사도 private host 경로·키·외부 network를 노출하지 않는 별도 격리 경로에서 수행하고 후보의 고정 tree·설정/실행 fingerprint에 묶는다. 단순 모델 verdict를 테스트 통과로 대체하지 않는다.

결과는 후보별 diff/근거/사용량과 함께 비교하고 사람의 정확한 후보 선택 뒤 하나만 승격한다. 전원 실패는 no_acceptable_candidate다. 승격은 worker 종료/미정산·출처/대상 tree/hash를 재검증하고 기존 복구 전 checkpoint 및 원장을 사용한다. 자동 merge, 효과 재생, crash 후 자동 승격은 없다. 후보 취소는 해당 후보만 멈추고 Run 취소는 모든 소유 실행을 정리한다.

## C-118 복수 LLM Ultra

사용자가 고른 기존 profile pool과 planner/executor/synthesizer/verifier 배정을 고정한다. 최소 서로 다른 모델 두 개이며 같은 회사의 두 모델도 지원하되 여러 회사라고 표시하지 않는다. 기본 배정은 주 모델의 계획·작성·종합과 다른 모델의 읽기 전용 검토다. 읽기 전용 specialist는 기존 callable/spawn/await 경로를 사용하고 추가 위임을 하지 않는다. 한 실행에서 파일 작성자는 하나다. 교차 검토는 정적 필수 단계이며 종합본의 정확한 버전을 검토한다.

`maximum_supported`는 오케스트레이션과 별도 정책이다. Pi의 해당 모델/transport에서 검증한 최고 제어를 기존 출력·호출 상한 안에서 적용한다. 일반 effort 설정은 보존하고 새 Ultra 요청의 명시적 수동 effort 충돌은 거절한다. 과거 recipe/hash를 새 기본값으로 해석하지 않는다. mapping 미검증·필수 모델 미연결은 비용 발생 전 거절하며 다른 provider로 조용히 fallback하지 않는다.

전송 범위는 선택한 연결에 이번 요청·첨부·승인한 프로젝트 파일·파생 산출물·지시가 전달될 수 있다는 Run 단위 계약이다. 새로운 provider에는 이전 provider의 원시 대화·추론 서명·로그를 복사하지 않는다. UI/API/CLI는 같은 설정과 재시도 identity를 사용한다.

첫 구현은 OpenAI/DeepSeek의 실제 Pi serializer와 fake HTTP로 검증한다. 최종 wire의 모델·추론 설정·출력 상한을 검사하고, provider 자동 재시도를 끄며 inference HTTP dispatch는 승인된 payload로 한 번만 허용한다. OAuth처럼 wire 출력 cap을 보장하지 않는 transport는 admission 예약과 실제 사용량 상한 보장을 구분한다. Anthropic/Gemini 등은 같은 검증 계약으로 추가한다. 실제 provider 호출은 별도 opt-in이며 이번 구현의 일반 시험은 비용이 없다.

구현 근거는 [Oracle 재검토](../spikes/Ultra-Multi-Provider-Oracle-2026-10-19.md)다. 구현 순서는 provider conformance → versioned 협업/예산/UI → 코딩 검사·provider 확대 → 선택적 C-114다. 필수 검사 미지원은 검증 완료로 우회하지 않는다.

첫 협업 선택 형식은 `ultra: {version: 1, modelProfiles: [2~5개], verifierProfile}`이다. 주 모델은 기존 choice이며 계획·실행·종합을 담당하고, 선택한 다른 모델이 필수 검토를 담당한다. 나머지 선택 모델은 읽기 전용 callable specialist가 된다. 동일 모델 ID의 프로필 별칭은 별개 모델로 세지 않는다. 최고 지원 추론은 사전 검증한 profile metadata로 해석하여 snapshot에 고정한다. 모델 기본값/임의 medium으로 묵시적으로 대체하지 않는다. 전역 동시 요청 3, 한 번에 자식 2, 전체 선택 위임 4, 재귀 위임 없음, 수정 최대 2회다.

기존 review recipe에 optional `preparationNodeId`를 추가하여 실행→종합(candidate)→검토→판정의 엄격한 4단계 Loop를 지원한다. 미지정된 과거 recipe의 3단계 검사/hash는 유지한다. 준비 단계도 같은 Loop의 scheduled agent여야 하며 검토 대상은 종합본으로 고정한다.

이 협업 단계의 모델 검토는 실제 프로젝트 테스트를 대체하지 않는다. 역할 프롬프트는 실행 근거가 있는 검사만 보고하고 미실행을 명시하도록 한다. host 소유 격리 검사와 고정 tree 연동은 다음 단계이며 C-114 후보 승격의 필수 검사 조건을 완화하지 않는다. CLI 새 Ultra는 명시 pool/verifier를 요구하고 수동 effort와의 충돌을 거절한다. 기존 선택 필드 없는 API/저장 기록은 legacy 계약을 유지한다.

OpenAI 기존 OAuth 회귀도 포함한다. Pi 1.3.0은 공식 OpenAI Responses의 ChatGPT 로그인에서 `max_output_tokens`를 생략한다. 이 경로만 고정된 Run 인증 방식과 공식 provider/API/baseURL로 식별해 생략을 허용하고, API 키·다른 endpoint의 cap 누락은 계속 거절한다. 비밀 값은 추가로 저장/전송하지 않으며 worker에는 인증 방식만 전달한다. OAuth의 실제 출력량 hard cap을 보장한다고 표시하지 않는다.

Bell의 후속 지시에 따라 다른 제공자도 Pi의 모델 카탈로그·`getSupportedThinkingLevels`·`thinkingLevelMap`·API별 compat·인증/직렬화를 우선 사용한다. 회사 이름마다 임의의 최고 추론 표를 만들지 않는다. wire에 영향을 주는 compat·thinkingLevelMap·모델 출력 상한의 변경도 고정 metadata identity에서 감지한다. 지원 확대는 회사별 복제보다 Pi의 API/인증 계열별 conformance로 진행한다. 일반 연결 가능과 Ultra 최대 추론 검증 완료는 구분하며 아직 검증하지 않은 API 계열을 지원 완료로 표시하지 않는다.

### Hive DeepSeek 연결

Bell이 지정한 [Hive DeepSeek V4.1 Flash](https://docs.thehive.ai/docs/deepseek-v41-flash)를 기존 사용자 정의 엔드포인트로 추가한다. 공식 CDN/VA1의 `/api/v3` 주소와 정확한 모델 ID에만 공개 모델 기본값·Pi 호환 metadata를 적용한다. 모델 이름만 같거나 다른 gateway 주소이면 추측하지 않는다. 명시한 context/output/reasoning/image 설정은 보존한다.

Hive의 `reasoning_effort=none|low|high|max`, `max_completion_tokens`, SSE Accept를 사용한다. DeepSeek 직접 API의 `thinking`·`max_tokens`를 복사하지 않는다. 다른 endpoint/내장 provider·origin에 묶인 키·기존 config 형식은 유지하며 새 의존성/키 저장 경로는 만들지 않는다. 모델 기본값→실제 Pi 요청→SSE 사용량과 잘못된 cap/effort 거절을 필요한 실패 시험으로 확인한다. Hive의 실제 도구 호출·과금·접근 권한은 키와 한도를 정한 별도 live 시험 전까지 미검증이다.

## C-118 코딩 검사 연결 (2026-10-21)

새 version 1 Ultra에서 작업 사본이 있는 요청은 시작 시 종합 역할의 effective harness에 선택된 등록 검사를 recipe에 고정한다. 검사가 없거나 host가 격리 검사를 제공하지 않으면 모델 호출 전에 거절한다. 저장소 없는 텍스트 요청과 legacy Ultra는 기존 계약을 유지한다. writer 완료 후 서비스 정리를 마치고 종합 시작 전에 후보 tree를 고정한다. 각 종합본 제출에 Coordinator가 이 tree를 expectedTree로 검사에 전달하고, 고정 tree·config revision·실행 fingerprint·소유 execution/attempt/effect와 Linux 격리 증거를 확인한 뒤 별도 모델 검토에 전달한다. 실패는 수정, 오류/취소/불확정/오래된 tree/격리 증거 누락은 완료 차단이다.

검사는 기존 worktree runner의 수명·취소·프로세스 정리를 재사용하며 bubblewrap의 별도 mount/network/PID namespace에서 실행한다. Git snapshot·checkout·status의 외부 filter를 비활성화한다. Git 사본과 읽기 전용 시스템 실행 파일만 노출하고 host home·키·Git 관리 디렉터리·네트워크를 제공하지 않는다. 의존성은 고정 tree에 포함된 것만 사용하며 host 프로젝트 node_modules를 암묵적으로 가져오거나 네트워크로 설치하지 않는다. 지원하지 않는 OS/실행 파일/의존성은 명시적 실패이고 비격리 fallback은 없다. 이 단계는 C-114 후보 병렬 구현 승인이 아니다.

격리 fingerprint는 기존 등록 명령 identity에 bwrap·Node 바이너리 hash와 버전 있는 실제 mount/argv/env 정책을 포함한다. 실행 파일은 사본 내부·시스템 toolchain·현재 Node로 제한한다. bubblewrap의 전용 JSON 상태 채널에서 exec 이후 종료를 확인해야 pass/fail이 가능하며, PID namespace init 소멸을 확인하기 전에는 cleanup을 확정하지 않는다. 최종 tree 확인은 서비스 정리와 pause 경계 뒤에 수행한다. 외부 프로세스의 직접 쓰기를 완전히 잠그는 계약은 아니며, 검토/검사 증거의 정본은 기록된 후보 tree다.

### Provider conformance 확대

Pi 1.3.0의 Anthropic Messages adaptive-thinking 계열을 API key/OAuth의 실제 serializer와 결정적 HTTP로 검증한다. payload의 최대 추론·model·출력 cap, SDK의 beta header 이동, 1회 dispatch·취소·변조 거절을 함께 확인한 계열만 선택 가능하다. 구형 budget-thinking과 Google 계열을 검증 없이 활성화하지 않는다. 특히 설치된 Google Generative AI adapter는 per-request custom fetch를 거절하므로 현재 단일 HTTP permit을 강제할 수 없다. 이 상류 제약을 우회하기 위한 전역 fetch 교체나 SDK fork는 이번 범위에 넣지 않는다.

## P19 / C-114 구현 승인과 연결 (2026-10-23)

사용자가 P19와 알림 대상 이동을 구현하고 기존 동작 보존·핵심 회귀·실제 화면 확인·단위별 커밋을 요청했다. 독립 영역은 병렬로 진행하며 전체 플랫폼/유료 provider 검증은 반복하지 않는다. 이 요청으로 기존 C-114를 진행하며 요구 CRL-ULTRA-002와 TC-ULTRA-002-H/N을 유지하고 취소·늦은 응답·중복/복구 반례 TC-ULTRA-002-F를 추가한다.

기존 UltraSelection에 선택적인 비교 모델 목록을 두고 명시 비교를 켰을 때 기본 3개·최대 5개 후보를 고정한다. 후보 모델은 선택한 기존 pool 안에서 배정하고 같은 모델의 여러 후보도 허용한다. 같은 Run의 기존 execution/permit/budget 경로를 사용하며 UI는 기존 요청 설정과 변경 검토에 연결한다. 선택과 후보 취소는 기존 command ID·expectedRevision·receipt를 사용한다. 후보별 사본·고정 tree·필수 검사와 명시 단일 승격은 위 C-114 계약을 그대로 따른다.
