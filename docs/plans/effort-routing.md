# Effort Router(d1) 도입 플랜

작업 중인 플랜이다. 명세가 아니며 완료되면 삭제한다. 동작 계약은 0단계에서 쓰는 [effort-routing 명세](../specs/features/effort-routing.md)가 소유한다.

## 목표

추론 판정기를 stock **LiquidAI d1-2B Q4_K_M + 관리형 llama.cpp `llama-server`** 와 기존 판정 API 중 사용자가 직접 고른 엔진 하나로 바꾸고, 판정을 **각 메인 모델 호출 직전**(도구 결과 뒤 다음 응답 포함)에 한 번 확정한다. 판정 입력·취소·적용·재시도 계약을 제품 경로에서 바로잡는다. 근거 문서는 사용자가 제공한 `Corral_Effort_Router_Final_Spec_and_Plan.ko.md`(v1.0, 2026-11-09)이다.

브랜치 `feat/effort-router-d1`은 `develop`(97541371)에서 분기했다.

## 확정 결정 (2026-11-09)

1. 판정 대상은 역할·노드의 `auto` 선택뿐이다. Effort Mode(Off / Manual)는 `auto`가 무엇을 할지 정한다: Off는 provider default, Manual은 선택한 엔진 하나. `provider_default`와 고정 수준은 판정하지 않는다.
2. v4 판정기는 제품에서 제거한다. legacy-v4 모드·안내 배너·설정 복원·마이그레이션은 없다. 옛 설정 필드와 기록 형식은 삭제한다.
3. `docs/specs/features/effort-input-packing.md`는 삭제한다.
4. Gate D(배포 v4 대비 90건 비교)는 생략한다. 비교 자료와 v4 입력 기록을 로컬·Git 기록·GitHub에서 찾지 못했다. d1은 선택형 미리보기이며 v4 대비 우월·절감을 주장하지 않는다.
5. 근거 문서의 PR1–PR4 대신 이 브랜치에 단계별로 커밋한다. 근거 문서 3.1의 "설명 항상 표시"는 레이아웃으로 의도를 보이는 원칙과 디자인킷으로 대체한다. 기존 관측(observe) 모드는 근거 문서 10.3의 Shadow로 바꾼다.
6. 신규 기본값은 Off, fallback 기본값은 provider default, Local 초기 장치는 CPU다.

## 고정값

| 항목 | 값 |
|---|---|
| 모델 | `LiquidAI/d1-2B-GGUF` revision `4a181094d1b6addfaa3a0956f78e7ab2aa406a0c`, `d1-2B-Q4_K_M.gguf`, 1,099,629,888 B, sha256 `adca5789ad30ae6027e8e936749bb9f19673097492ab26fa1c5b69643ca50b4b`, LFM Open License v1.0 |
| 런타임(linux-x64) | llama.cpp `b12189`(commit `80d2c0c2c56e4a1bbf74be98f64b99927bf230bc`) 공식 `llama-b12189-bin-ubuntu-x64.tar.gz`, 23,058,620 B, sha256 `c446a7ba4df3c3b1cc880a734fbff586d6d34b9cebc09e151754813b94ded8c9`, MIT |
| Local 입력 | state ≤ 400토큰, 전체 ≤ 512토큰(d1 tokenizer로 실측) |
| API 입력 | state ≤ 2,048 B, 요청 JSON ≤ 8,192 B(UTF-8) |
| 대기 | caller deadline CPU 5초 / GPU 1초 / API 3초, 고급 100–10,000ms; watchdog 120초, 종료 grace 2초, startup 30초, idle unload 5분 |

압축 안에서 쓰는 파일 22개(`llama-server`, soname 이름으로 설치하는 shared library, CPU backend 변형 14개, LICENSE)의 크기·sha256은 `LINUX_X64_CPU.runtime.files`가 소유한다.

## 진행표

| 단계 | 내용 | 상태 | 커밋 |
|---|---|---|---|
| 0 | 명세와 이 플랜 | 완료 | `0c55103e` |
| 1 | v4·외부 판정·관측 모드 제거 | 완료 | `736e579d` |
| 2 | 공통 계약·snapshot·resolver(fake backend) | 완료 | `78fd89d0` |
| 3 | 판정 API backend | 완료 | `1c8d78eb` |
| 4 | d1 로컬 런타임 | 완료 | |
| 5 | 설정 UI·실행 기록 | 대기 | |
| 6 | 실제 앱 인수·배포 자료 | 대기 | |

각 단계는 끝날 때 앱이 동작하는 상태를 유지하고, 이 표를 그 단계의 커밋에서 갱신한다.

## 단계

### 0. 명세와 플랜

- 새 기능 명세 `docs/specs/features/effort-routing.md`(템플릿 형식, 한국어). 소유하는 계약: Effort Mode·엔진·fallback·대기 설정, 판정 우선순위(권한/예산 거부 → 취소·stale → fixed/provider_default → auto+Off → auto+Manual), 호출별 resolution과 명시적 재시도 재사용 범위, snapshot·frame 규칙과 예산, 패킹 계수 ≤ 32회, 고정 질문과 응답 검증, d1 artifact·실행 인자·수명주기·설치, 대기·취소·물리 슬롯 표, Shadow, 기록 필드, 대표 수용 시나리오.
- 갱신: `local-intelligence.md`(자동 추론·외부 판정·v4·effort 평가 절 제거, 엔진은 회의 분석 전용), `decision-apis.md`(Manual 엔진으로 직접 선택, 보류 보완 규칙 제거, 입력은 api-bounded frame), `models-and-resources.md`, `api-contract.md`, `glossary.md`, `docs/specs/README.md`.
- 삭제: `effort-input-packing.md`와 그 링크.

### 1. v4·외부 판정·관측 모드 제거

`auto`를 임시로 Off와 같게(provider default, 판정 0회) 만든다.

- `packages/local-intelligence`: `src/effort/*`, `weights/`, 번들 manifest의 effort 모델, `helper/src/main.rs`의 effort 모델 로드, `factory.ts`의 effort 항목. 회의 분석은 유지. 릴리스 id `corral-local-ai-2`는 그대로 두어 설치된 번들을 다시 받지 않는다. 이미 받은 effort 모델 파일은 설치 폴더에 남는다.
- `packages/core`: `reasoning.ts`의 `automaticReasoning`·`ExternalConsult`·`reasoningPolicyOf`, 판정 횟수 상한, `decisions/`(observe·heuristic), `coordinator.ts` 연결부.
- `packages/contracts`: `ReasoningApplySettings`, `AutomaticReasoningPolicy`, `ReasoningInput`, 관측용 `DecisionProvider`·`EffortQuestion`·`RunDecisionSettings`, `decision.*` 이벤트, `ReasoningResolution`의 옛 정책 버전·`escalated`·`abstained`.
- 설정·서버: `decisions.reasoning_effort`, `/api/v1/models/reasoning`, `/api/v1/local-ai/external-judge`. `apps/server/src/decision-apis.ts`의 키 저장과 두 어댑터는 3단계용으로 유지.
- UI: 자동 추론 스위치, `LocalAiPanel`의 외부 판정 섹션, `EffortJudgments`와 `RunPage` 사용처, `demo.worker.ts`.
- 도구: v4 학습·평가용 `tools/local-intelligence/effort/`, 학습용 Python 의존성 기록, `verify-live.ts`와 `gold/`의 effort 부분.
- 테스트: v4 전용 테스트 삭제. 반례: `auto` 요청이 판정·다운로드 0회로 provider default로 나간다.

### 2. 공통 계약·snapshot·resolver

- 계약 `packages/contracts/src/effort-routing.ts`(설정 schema는 `off | manual`), `ports.ts`에 `RoutingBackend`. 기록용 resolution을 selected / fallback / off / fixed / cancelled / stale 형태로 교체.
- `packages/adapter-pi/src/call-snapshot.ts`가 `reasoning-input.ts`를 대체: 확정된 요청 문맥에서 한 번 발췌하고 마지막 assistant의 도구 호출을 모두 담는다. 숨은 reasoning·이미지·키는 넣지 않는다.
- 프로토콜과 `adapter.ts`: `logicalRequestId`, `retryIndex`, 재시도의 원 호출을 host까지 전달.
- parentQuestions 선확정: Coordinator가 빠진 질문을 snapshot에 넣고 permit에 같은 목록을 돌려주며, worker(`sdk-worker.ts`, `worker.ts`)는 그 목록만 붙인다.
- `packages/core/src/effort-routing/`: `resolver.ts`(Local/API 공통 순서, 단일 deadline), `frame.ts`(결정적 패커, 계수 함수 주입), `arbiter.ts`(응답 형식·identity·capability 검증만), `question.ts`(고정 질문, 후보 교집합).
- Coordinator: preparation이 resolution을 소유하고 같은 preparation의 명시적 전송 재시도만 재사용한다. 설정은 preparation 시점에 읽는다.
- 워크스페이스 config `decisions.effort_routing`. Shadow는 UI 없는 진단 플래그.
- 근거 문서 14장 C01–C07, C14–C20, P02–P05, P07–P08을 fake backend로 먼저 실패시키고 구현한다.

### 3. 판정 API backend

- jev·openai-decisions를 `RoutingBackend`로. d1 설치 없이 동작, 전송 전 동의 revision 확인, 재시도·다른 API 전환·Local 병렬 없음. 원격 연결 종료를 원격 계산 중단으로 기록하지 않는다. 비용은 unknown.
- 테스트 C17, C18, P09. 실호출은 승인 전 미실행이며 상태는 미검증으로 표시한다.

### 4. d1 로컬 런타임

- `packages/local-intelligence/src/d1/`: `manifest.ts`, `install.ts`(기존 설치 방식 재사용, 최소 tar.gz 리더, 경로·링크 공격 거절), `runtime.ts`(인자 배열 실행, per-instance 인증, loopback, 소유 프로세스만 종료, 자동 재시작 없음), `client.ts`(`/tokenize`, `/v1/systemone`), `render.ts`(System One 렌더링 이식, 실측 토큰 검사), `lease.ts`(daemon·lease 하나, 대기열 0, Busy는 tokenize 전), `backend.ts`.
- 개발용 경로 override는 두지 않았다. 실물 확인은 설치 경로 그대로 한다.
- 서버의 d1 상태·설치·취소·준비 라우트. GPU는 구조만 두고 검증 전 사용 불가.
- 가짜 `llama-server`로 C08–C13·설치 실패·P01·P06. 실제 모델은 opt-in live 테스트만.
- 출처·라이선스는 `THIRD-PARTY-NOTICES/local-ai.md`에 기록한다. `docs/dependency-lock.json`은 npm 직접 의존성만 담는다.

### 5. 설정 UI·실행 기록

- 모델 설정의 추론 판정 섹션: Effort Mode, 엔진, Local 설치·장치·실행 호스트·고급 설정, API 연결·전송 범위 동의, fallback. `LocalAiPanel`은 회의 번들 전용.
- 실행 기록 한 줄(`Local · CPU · 추천 low → 적용 low · 420ms`)과 상세(선택지 분포, 장치, 시간, fallback 사유).
- 디자인킷과 내장 design skills를 적용하고 실제 화면을 확인한다. 문구는 en·ko 카탈로그.

### 6. 실제 앱 인수·배포 자료

- 근거 문서 14.4 시나리오를 실제 앱에서 끝까지 확인한다. 메인 모델은 `gpt-6.1-terra`/`gpt-6-luna`만 쓴다.
- 실패 UX와 회의 분석·수동 추론·정산·취소 회귀를 확인한다.
- 지원표(Linux x64 CPU = product-preview), 설치·되돌리기 안내, NOTICE. 완료 후 이 플랜을 삭제한다.

## 검증

단계마다 `pnpm lint`, `pnpm typecheck`, 영향 패키지 테스트, 계약 변경 시 `pnpm contracts:check`, 의존성 기록 변경 시 `pnpm deps:check`. 1단계는 헬퍼를 다시 빌드한다. 구현과 검증 환경을 나눠 보고하고 mock 통과를 실제 wire 검증으로 쓰지 않는다.

## 따로 승인받을 것

- d1 GGUF(1.1 GB)와 llama.cpp 배포물(23 MB) 다운로드.
- 판정 API 실호출, 메인 모델 실호출.
- `develop` 반영(push·PR·머지).

## 다음 단계

5단계: 설정 UI·실행 기록. 시작할 때 4단계 커밋 hash를 진행표에 채운다.

1. `@corral/client`에 `/effort-routing` 라우트 다섯 개의 client.
2. 모델 설정의 추론 판정 섹션(위 5단계 항목)과 `LocalAiPanel` 축소.
3. 실행 기록 한 줄과 상세(`packages/react`), `RunPage` 연결.
4. UI 단위 테스트, 실제 화면 확인, 마일스톤 E2E 1개.

4단계 실물 확인(Linux x64, 이 개발 환경): 고정 URL에서 내려받은 두 artifact가 크기·sha256과 같고, 설치기가 22개 파일을 검증해 설치했다. `--version`은 build 12189·commit `80d2c0c2c`, `--help`에 `--no-ui`·`--offline`·`--cache-ram`·`--no-op-offload`·`--device`·`--no-warmup`·`LLAMA_API_KEY`가 있다. opt-in live 테스트(`d1.live.test.ts`)에서 준비 확인(무인증 `/tokenize` 401, `/v1/models` 크기·파라미터)이 통과했고, smoke·한/일 Unicode·control token 세 state에서 native 입력 토큰이 계수와 같았으며(smoke 171), 호출자가 기다림을 멈춘 판정은 native 완료까지 Busy를 유지했다.

앞 단계에서 정한 구현 사항(뒤 단계가 기대는 것):

- 엔진 경계는 `RoutingBackend.admit()` → lease(`countState`·`countInput`·`start`·`release`) → flight(`result`, `settled`)다. 정본은 `packages/contracts/src/ports.ts`. `RouterRequest.signal`은 호출자가 기다림을 멈출 때 켜진다. 판정 API는 연결을 닫고 Local 추론은 물리 종료까지 간다. `owner`는 API 호출에만 Coordinator가 채운다.
- 서버는 `apps/server/src/routing-engines.ts`에서 저장된 엔진 하나만 묻는다. Local은 `D1Engine`(`packages/local-intelligence/src/d1/`)이고, 실제 모델이 있는 서버가 `defaultD1Engine()`으로 만든다. `createServer`의 `routingBackend`·`localRouting`은 테스트용 대체다.
- 판정 API 호출은 Coordinator(`recordedEngine`)가 execution의 `decision` 효과로 승인·정산한다. Local 추론은 효과를 남기지 않는다.
- 라우트 다섯 개(GET/PUT `/effort-routing`, POST/DELETE `/local/install`, POST `/local/start`)는 4단계에서 만들었다. 응답은 모두 GET과 같은 형태다. 5단계는 client·화면·실행 기록이다.
- 동의 revision은 `decisionApiConsent(id)`(`<id>:notice-1`)이고 GET의 `apis[].noticeRevision`으로 보인다. 판정 API 실호출은 아직 하지 않았다(`verified: false`).
- d1 테스트는 실제 child process인 가짜 `llama-server`(`packages/local-intelligence/test/fake-llama-server.ts`)로 돈다.
- 설정은 요청 준비마다 `.corral/config.json`을 읽는다(`currentEffortRouting`). 읽지 못하면 Off다. 시뮬레이션 실행(mock)은 판정하지 않는다.

## 열린 문제

- 메인 체크아웃의 미추적 v3 작업 파일(헬퍼 `effort.rs`, `packed-effort.test.ts`, `tools/local-intelligence/effort/` 아래 새 파일 등)은 1단계에서 지우는 v4 도구에 의존해 이 브랜치와 충돌한다.
- Linux x64 외 배포 대상 OS는 정하지 않았다.
