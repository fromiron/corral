# Corral — SDD·TDD 세부 구현 플랜 v0.1

> 기준일: 2026-10-14. 제품 범위의 기준은 [Corral-Spec-v0.1.md](Corral-Spec-v0.1.md)다. 이 플랜은 구현 전 계획이며, 명령 예시는 앞으로 저장소에 만들 스크립트를 뜻한다. 실행 가능한 완성 애플리케이션을 제공했다는 의미가 아니다.

## 1. 구현 원칙

**첫 사용자에게 보이는 MVP부터 D&D·협업·Reins가 함께 있어야 한다.** 기술 스파이크가 내부적으로 먼저 존재할 수는 있지만, 실행기만 있는 결과물을 MVP라고 부르거나 D&D를 후속 범위로 이동하지 않는다.

개발을 backend 전부→viewer→editor 순서로 진행하지 않는다. 첫 단계부터 Canvas와 Reins를 mock으로 동작시키고, 각 파트가 계약을 공유한 상태에서 실제 runtime으로 바꾼다. frontend는 동작이 없는 시안이 아니라 매 단계에서 실행·테스트 가능한 세로 절편을 제공한다.

작은 PR의 기본 단위는 **요구사항 ID + 실패하는 검증 + 최소 구현 + 문서/테스트 증거**다. 라이브러리 도입과 기능 구현을 구분하고, 의존성을 설치했다는 이유로 해당 기능을 완료로 판정하지 않는다.

## 2. 채택 기술과 배제 결정

| 계층 | 채택 | 이유 | 지금 추가하지 않을 것 |
|---|---|---|---|
| 앱 | React + TypeScript + Vite | 로컬 도구·정적 데모·Storybook에 같은 UI 사용 | Next.js 서버 기능, 별도 BFF |
| 그래프 UI | React Flow (`@xyflow/react`) | 노드·포트·선택·뷰포트 기반 | 다른 D&D 엔진 중복, 유료 Pro 예제 필수화 |
| 상태 | Zustand + TanStack Query | 편집/live projection과 일반 query cache의 역할 분리 | Redux/XState 동시 채택 |
| UI 기초 | Radix Primitives + Tailwind CSS + CSS tokens | 접근 가능한 primitive에 자체 디자인 적용 | 테마 은유를 위해 전체 UI kit 이중 사용 |
| 폼·본문 | React Hook Form, react-markdown/remark-gfm, diff | 프롬프트 입력, 안전한 Markdown, 버전 비교 | Monaco/전체 문서 편집기 |
| 가상화 | TanStack Virtual | Timeline·실행 트리의 큰 목록 처리 | 매 이벤트 전체 DOM 생성 |
| API | Fastify + typed REST + SSE | 명령/receipt와 이벤트 읽기를 분리 | GraphQL/Socket.IO 필수화 |
| 계약 | Zod 4 + generated JSON Schema | 서버·클라이언트·fixture의 같은 검증 | 런타임에서 임의 코드로 schema 생성 |
| workflow | LangGraph.js 내부 adapter | 제한된 graph 순회·조건 분기 기반 | LangGraph/Pi/DB의 독립 상태 원본 3개 |
| Agent | Pi agent-core + pi-ai | 범용 역할·provider·tool loop 재사용 | coding-agent 기본 셸/프로젝트 확장 로딩 |
| 저장 | SQLite + better-sqlite3 + Drizzle | 로컬 단일 파일, transaction·typed SQL | Postgres/Redis/S3 필수 인프라 |
| 검증 | Vitest + Testing Library + Playwright + MSW + fast-check | 단위/DOM/실브라우저/HTTP/model-based 검증 분리 | real LLM을 매 PR 테스트의 유일한 판정자로 사용 |
| UI 증거 | Storybook, Playwright trace·screenshot | 상태별 UX와 재현 자료 | 특정 유료 CI 서비스에 종속 |
| 품질/배포 | pnpm workspace, Biome, GitHub Actions | 한 TS 모노레포·잠근 의존성 | 첫 버전부터 npm 공개 패키지 여러 개 |
| SDD 보조 | Markdown·schema·ID 매핑, Spec Kit 선택 사용 | 명세를 Git과 CI에서 관리 | 특정 LLM 전용 워크플로 강제 |

유지보수 근거·라이선스·확인한 릴리스와 버전 정책은 [Dependencies-and-Sources.md](docs/Dependencies-and-Sources.md)에 있다. exact version 잠금은 P0에서 Node/peer/type 호환성을 시험한 후 결정한다. 문서에 표시한 최신 관측 버전이 곧 통합 검증된 lockfile이라는 뜻은 아니다.

## 3. SDD 작업 흐름

### 3.1 스펙 계층

```text
제품 헌장 / MVP 비협상 항목
    ↓
기능 spec: 사용자 동작, 상태·경계, 오류, 수용 기준
    ↓
계약: JSON schema, event/command, 상태 전이, API
    ↓
테스트 설계: normal / failure / race / security / a11y
    ↓
작업 분해: 담당 모듈, 의존 태스크, 증거
    ↓
RED → GREEN → REFACTOR
    ↓
통합 검증 / 문서 일치 확인 / 사람 리뷰
```

필수 feature 묶음은 `001-canvas`, `002-run-coordinator`, `003-agent-adapter`, `004-collaboration`, `005-review-loop`, `006-reins`, `007-limits-recovery`, `008-live-tools-security`, `009-demo-release`다. 각 feature는 `spec.md`, `plan.md`, `tasks.md`, `acceptance.feature`, `evidence/`를 가진다. 루트 문서를 복붙하지 않고 필요한 요구 ID를 참조한다.

### 3.2 착수 가능 조건(Definition of Ready)

작업은 requirement ID, 정상/거절 경로, 입력·출력 예제, 적용 경계, 변경 소유 모듈, 의존 작업, 검증 명령이 있어야 시작할 수 있다. 동시에 바뀌는 두 계약의 순서가 불명확하면 코드부터 만들지 않고 Change Request를 작성한다.

명세 변경은 `why / affected requirements / compatibility / tests / migration / owner decision`을 기록한다. “MVP라 생략”이라는 설명만으로 필수 요구를 제거할 수 없다. assistant나 구현 에이전트가 임의로 수용 기준을 낮추지 않도록 저장소의 AGENTS 지침에 고정한다.

### 3.3 계약의 기준 파일

미래 저장소에서는 `packages/contracts/src/`의 Zod가 wire schema의 기준이며 JSON Schema/OpenAPI는 생성물로 관리한다. prose는 사용자 의미와 상태 규칙의 기준이다. 둘이 다르면 테스트와 spec review로 수정한다. 이 문서 패키지의 JSON Schema는 **설계 시점의 seed**이며, 구현 시 schema source로 옮긴 뒤 같은 fixture에 대한 parity 테스트를 통과시켜야 한다.

`requirements.json → test-catalog.json → backlog.json`을 CI에서 검사한다. 요구 없는 구현 태스크, 테스트 없는 필수 요구, 정의되지 않은 ID를 실패로 처리한다. 이 패키지는 해당 매핑의 출발 데이터를 포함한다.

## 4. TDD 규칙

RED에서는 의도한 assertion이 실패하는지 확인한다. import 누락·환경 파손으로 실행이 안 되는 것을 기능의 RED 증거로 대체하지 않는다. GREEN은 그 동작을 통과시키는 최소 구현이다. REFACTOR 후 동일 테스트와 인접 계약을 다시 실행한다.

핵심 runtime 로직은 Clock, IdFactory, ModelAdapter, SearchProvider, Storage, EffectDispatcher를 주입 가능하게 작성한다. 테스트에 실제 시간 지연·실모델 확률·외부 웹 문서 상태를 넣지 않는다. 취소/응답 경합은 barrier가 있는 fake adapter로 호출 순서를 직접 제어한다.

실제 LLM 테스트는 `live` suite로 분리하고 예산·timeout·opt-in key를 요구한다. 기록에는 provider/model의 실제 ID, 시각, input fixture hash, API 설정을 남긴다. 모델이 한 번 성공했다는 결과를 deterministic 계약의 증거로 사용하지 않는다.

coverage는 보조 신호다. core/contracts는 초기 목표 line 90% / branch 85%, 나머지는 중요한 실패 경로 중심으로 관리한다. 숫자는 계획 목표이며 달성 보고가 아니다. 추후 mutation test는 Reins·budget·cancel reducer부터 제한적으로 적용한다. 거대한 snapshot만으로 테스트를 채우지 않는다.

## 5. 단계·의존성·산출물

아래 시간은 **추측에 기반한 계획용 집중 작업 시간**이다. AI 도구 사용에 따른 생산성 배수를 검증하지 않았으므로 할인하지 않았다. 리뷰·통합 리스크를 포함한 최종 달력 일정은 P0/P1 실제 작업량을 측정한 뒤 보정한다.

| 단계 | 범위 | 시간 추정 | 완료 증거 |
|---|---|---|---|
| P0 | 명세·의존성 잠금과 첫 Canvas 세로 절편 | 18–28h | 동결할 계약, MockAdapter, 실제 드롭 가능한 화면을 동시에 만든다. |
| P1 | D&D 편집기·정의·compiler | 30–46h | 지원 노드와 연결이 실제 실행 계획으로 변환된다. |
| P2 | Coordinator·SQLite·실행 투영 | 26–40h | 영속된 사실만 화면에 표시되고 명령 재전송이 안전하다. |
| P3 | Pi worker와 모델 호출 계약 | 22–36h | 모델 두 프로필과 요청·도구·취소·usage를 연결한다. |
| P4 | 작업·질문·서브에이전트 협업 | 30–48h | 동적 자식과 메시지 왕복이 한 Run에서 연결된다. |
| P5 | 검토 루프·버전·승인 | 20–32h | 이전 회차 입력과 현재 출력이 섞이지 않는다. |
| P6 | Reins 스티어링 전체 | 32–50h | 접수·전달·미래 설정·pause·개별 취소의 계약이 성립한다. |
| P7 | 예산·경합·장애·재열람 | 26–42h | 폭주와 늦은 결과에 상태가 무너지지 않는다. |
| P8 | 실자료·보안·CLI | 22–36h | 안전한 검색/읽기, 로컬 인증, 동일 CLI 경로를 완성한다. |
| P9 | 접근성·성능·공개 데모·릴리스 | 24–42h | 기능뿐 아니라 조작·관측 경험을 검증한다. |

전체 기본 합계는 **250–400시간**이다. 불확실성 여유 20%를 더한 계획 버퍼는 300–480시간이다. 주 10시간이면 약 30–48주, 주 20시간이면 약 15–24주로 환산된다. 업무 병행·API 장애·UI 완성도에 따라 달라지며 납기 보장이 아니다. 기능 수를 절반으로 줄이는 방식이 아니라, 각 단계의 실제 측정으로 먼저 재산정한다.

### P0 — 계약과 첫 화면을 함께 만든다

제품 헌장, Graph/Task/Execution/Directive 상태, package 경계, source/license record를 잠근다. React Flow의 실제 drop/connect와 mock Run 버튼, Reins 입력창을 만들고 story/E2E를 작성한다. 동시에 Pi request/tool hook·cancel·usage와 LangGraph callback 재진입을 최소 스파이크로 확인한다.

**Exit gate:** 첫 화면에서 Agent→Output을 만들고 모의 실행을 볼 수 있다. 지시는 pending으로 표시된다. backend 없는 viewer만으로 P0를 닫지 않는다. Pi 훅이 기대와 다르면 버전·source를 기록하고 adapter ADR을 결정한다.

### P1 — 사용자가 정의를 만드는 경험

네 노드, Loop grouping, capability link, inspector, validation panel, 저장·불러오기, Undo/Redo를 만든다. compiler 오류에 nodeId/edgeId를 넣고 클릭으로 이동한다. layout 이동과 실행 의미 변경을 다르게 저장한다.

**Exit gate:** 템플릿뿐 아니라 빈 캔버스에서 만든 유효한 정의가 IR로 변환된다. 잘못된 연결은 실행 전에 거절되고 위치가 표시된다. 키보드 대안을 같은 기능 경로로 제공한다.

### P2 — 단일 상태 확정과 실시간 투영

SQLite migration, command dedupe, decide/reduce, transactional events, effects, REST/SSE를 붙인다. LangGraph callback은 mock Agent를 Coordinator 경로로 실행한다. Canvas overlay, Run tree, 대기 이유 링크를 연결한다.

**Exit gate:** 응답 유실 후 command 재전송이 중복 Task를 만들지 않는다. snapshot+stream 간 race가 없다. read model을 이벤트로 재생성해 동일 결과를 얻는다.

### P3 — 실제 Agent를 작은 계약으로 연결

Pi worker를 얇은 IPC adapter로 연결한다. 비밀 키 전달 범위, request snapshot, tool permission, abort를 구현한다. provider 프로필은 두 개로 제한하고 자동 모델 라우팅은 넣지 않는다. 텍스트 스트림은 state event와 분리한다.

**Exit gate:** 두 provider의 실제 호출·usage·cancel smoke 결과가 기록된다. blocked tool이 실행 이벤트로 표시되지 않는다. live smoke는 통합 test와 분리되어 있다.

### P4 — 협업의 핵심을 연결

작업판, 자식 생성/합류, ask/reply, 불변 산출물, submit을 만든다. “기다리는 부모도 슬롯을 점유하는” 오류를 test-first로 막는다. responder는 새 Task이므로 권한·상한·인과·취소가 모두 동일 경로를 사용한다.

**Exit gate:** 조사자 두 자식 실행과 Writer 질문 왕복을 한 Run에서 관측할 수 있다. side chat가 아니라 task/message/artifact가 연결되어야 한다.

### P5 — 검토와 기준의 정합성

현재 회차/이전 회차 바인딩, review schema, 수정 Task, cap gate, 최종 승인을 연결한다. ArtifactDiff에 원천 버전과 기준 버전을 표시한다.

**Exit gate:** reviewer가 새 draft를 읽고, old review를 새 draft 승인으로 재사용하지 않는다. 승인 중 기준 변경은 stale이다. mock 실패→통과 시나리오와 실제 LLM 평가 결과를 구별한다.

### P6 — Reins를 제품 수준으로 완성

live directive, pause/drain/resume, partial/global cancel, 조건부 restart, future node config patch를 구현한다. 각 동작은 대상·경계·receipt·거절 이유를 가진다. 사용자 지시와 결과의 연결은 시각이 아니라 실제 snapshot에서 만든다.

**Exit gate:** 실행 중 입력한 지시가 다음 request에 들어간 사실을 UI로 확인한다. cancel 후 부모/질문자가 대기에 남지 않는다. 완료한 노드를 임의 재실행하지 않는다. 미래 patch가 template나 active config를 덮지 않는다.

### P7 — 경합과 복구를 제품 계약으로 만든다

budget reservation, unknown usage, 상한 수정, wait/no-progress, cancel vs reply 경합, crash interrupted, export/reopen, SSE backpressure를 검증한다. fake clock과 randomized command trace의 seed를 보관한다.

**Exit gate:** 순서를 뒤섞어도 상태 불변식이 유지된다. storage 실패 때 새 외부 효과가 실행되지 않는다. backend 재시작 후 외부 호출이 재발행되지 않는다.

### P8 — 실자료와 안전한 사용 경계

로컬 세션·Origin/Host 검증, 등록 자료 import, 안전한 HTTPS 읽기, optional live search, CLI를 연결한다. CLI는 REST 명령과 같은 Coordinator를 사용한다. 키 없는 테스트와 API 키가 필요한 기능을 명확히 나눈다.

**Exit gate:** malicious URL/redirect/HTML/import를 차단한다. inspect는 키 없이 작동하며 run은 승인 대기를 자동 우회하지 않는다.

### P9 — 공개 가능한 MVP

다중 상태 story, 키보드·IME·a11y, event flood 성능, 정적 mock demo, CI·라이선스·SBOM·readme를 마무리한다. 데모에서 D&D/Reins 변경이 실제 mock 결과를 바꿔야 하며 단순 영상 재생이면 안 된다.

**Exit gate:** 모든 AC와 FR의 증거가 연결된다. live smoke와 local demo를 구별하고 known limitation을 공개한다. 후속 Local/Jev를 구현된 기능처럼 설명하지 않는다.

## 6. 작업 백로그

모든 항목은 planned 상태다. 완료 여부는 아래 done 조건과 테스트 증거로 갱신한다. 기계 판독 데이터는 [backlog.json](contracts/backlog.json)에 있다.

| ID | 단계 | 작업 | 의존 | 완료 조건 |
|---|---|---|---|---|
| C-001 | P0 | 제품 헌장·상태/개입 계약·ADR 동결 | - | 접수/전달/종료의 뜻을 정의하고 테스트 이름까지 매핑 |
| C-002 | P0 | 의존성 lock·OSS 근거·호환성 스파이크 | C-001 | 정확한 버전과 Node24, React, Pi, Vitest peer 검사 기록 |
| C-003 | P0 | MockClock·IdFactory·ScriptedAgent 만들기 | C-001 | 네트워크 없이 동일 입력/seed에 동일 확정 이벤트 |
| C-004 | P0 | React Flow 첫 Canvas+Reins story | C-002, C-003 | Agent/Output을 실제 드롭·연결하고 mock run 진행 및 지시 접수 표시 |
| C-005 | P1 | Zod 정의·명령·이벤트 schema 및 codegen | C-001 | JSON Schema와 TS type의 fixture parity, unknown field 거절 |
| C-006 | P1 | 4종 노드·포트·capability 링크 | C-004, C-005 | control과 delegate/question을 구별하고 연결 허용을 드러냄 |
| C-007 | P1 | Loop 영역·본문 membership 편집 | C-006 | 그룹 이동과 loopId 편집을 구별하고 경계 위반 표시 |
| C-008 | P1 | 정적 검증기·IR compiler | C-005, C-007 | 유효 정의는 IR, 잘못된 cycle/port/ref는 위치 포함 오류 |
| C-009 | P1 | 저장/복제/import/export·정의/layout 분리 | C-005, C-006 | 좌표 변경은 실행 hash 불변, ID 복제 충돌 없음 |
| C-010 | P1 | Undo/Redo·키보드 연결·폼·IME | C-006, C-009 | 한 번 드래그를 한 undo로 처리, IME Enter 오동작 없음 |
| C-011 | P2 | SQLite migrations·Repository·트랜잭션 | C-005 | event/projection/artifact 원자 commit과 rollback 테스트 |
| C-012 | P2 | Coordinator decide/reduce·명령 dedupe | C-011 | 동일 command 재전송과 충돌/취소 fence의 순서가 결정적 |
| C-013 | P2 | EffectDispatcher·epoch·activation key | C-012 | commit 전 effect 없음, duplicate activation 중복 Task 없음 |
| C-014 | P2 | LangGraph GraphRunner 제한 IR 실행 | C-008, C-013 | GraphRunner 결과가 Coordinator 경로를 거쳐야 완료됨 |
| C-015 | P2 | REST receipt·snapshot·SSE watermark | C-012 | replay/live 전환 gap 없이 중복 제거, 202를 완료로 오인 안 함 |
| C-016 | P2 | 실행 트리·노드 집계·WaitingReason | C-015 | 같은 node의 두 execution과 대기 링크를 별도 표시 |
| C-017 | P3 | Pi worker 생명주기와 IPC schema | C-002, C-013 | unexpected exit/invalid IPC/worker binding 검증 |
| C-018 | P3 | request permit·context snapshot·stream bridge | C-017, C-012 | request 전에 확정된 snapshot을 실제 provider 호출에 사용 |
| C-019 | P3 | 도구 훅 mapping·실행 allowlist | C-017 | Pi start 이후 block돼도 실제 tool.started 없음 |
| C-020 | P3 | 모델 2프로필·usage normalization·live smoke | C-018, C-019 | 지원 기능·모델ID·usage·abort를 각 provider로 검사 |
| C-021 | P4 | Task 담당·시도 소유권·취소 결과 | C-012 | 한 Task에 활성 시도 2개 불가, 자동 재할당 없음 |
| C-022 | P4 | spawn/await·부모 자식 registry | C-021, C-017 | 두 child 병렬, parent wait는 모델 permit 미점유 |
| C-023 | P4 | 질문·응답 Task·reply resolver | C-021, C-022 | 끝난 역할 새 responder, 답변/timeout/cancel 단회 종결 |
| C-024 | P4 | 산출물 버전·제출·read 추적 | C-011, C-021 | 동시 helper 출력 이름 충돌 없음, 미제출 버전의 control 전달 없음 |
| C-025 | P4 | 협업 도구와 Task Board/메시지 UI | C-022, C-023, C-024 | 질문에서 responder와 근거 버전으로 이동 가능 |
| C-026 | P5 | 입력 바인딩·회차 pinning | C-024, C-014 | reviewer가 이전 draft가 아닌 이번 제출 draft를 읽음 |
| C-027 | P5 | review schema·기준 버전·stale 판정 | C-026 | 잘못된 target/criteria/JSON은 pass로 승격 안 됨 |
| C-028 | P5 | Loop cap·다음 회차·수정 작업 | C-027 | cap에서 approval, 승인만으로 한도 우회 불가 |
| C-029 | P5 | Approval snapshot과 최종 Output | C-027, C-028 | 동일 승인 2회 실행 없음, stale 대상 거절 |
| C-030 | P5 | Artifact diff·lineage 기반 상세 화면 | C-024, C-027 | draft@1→review@1→draft@2 경로를 확인 |
| C-031 | P6 | Steer enqueue·delivery receipt | C-018, C-025 | 실행 중 접수되고 다음 request에 정확한 directive IDs 포함 |
| C-032 | P6 | Pause/drain/resume 경계 | C-022, C-031 | 대기 child 때문에 pause 교착 없음, paused 후 신규 effects 없음 |
| C-033 | P6 | 전체·개별 cancel과 후손 정리 | C-021, C-022, C-023 | 후손/도구/질문 resolver 종료 후 취소 완료 |
| C-034 | P6 | 명시적 재시작과 이전 epoch 차단 | C-033 | 부모가 대기하는 Task만 새 시도, 이전 결과는 감사만 |
| C-035 | P6 | 미래 config patch·범위 미리보기 | C-031 | active config 불변, future node activation에만 반영 |
| C-036 | P6 | 지시/기준 변경과 산출물 연결 | C-027, C-030, C-031 | 접수 시각만으로 이전 요청 결과를 지시에 연결하지 않음 |
| C-037 | P7 | 예산 예약·정산·설정 변경 | C-020, C-035 | 동시 요청 초과 admission 방지, unknown usage의 거짓 환급 없음 |
| C-038 | P7 | wait graph·총량·deadline·no progress | C-023, C-028 | 대기 cycle과 새 responder pingpong 모두 유한 상한 |
| C-039 | P7 | 경합 property test·late results | C-031, C-032, C-033, C-034, C-037 | seed 재현 가능한 명령 interleaving에 불변식 유지 |
| C-040 | P7 | crash interrupted·기록 export/reopen | C-011, C-033 | 재시작 후 pending effect 실행 없음, read-only 기록 복원 |
| C-041 | P7 | backpressure·재접속·마지막 텍스트 복구 | C-015, C-016 | slow client 메모리 제한, 누락 domain event 재조회 |
| C-042 | P8 | local session·Origin/Host/CSRF·키 격리 | C-015, C-017 | 임의 origin/host와 query secret 누출 검사 |
| C-043 | P8 | 문서 import·안전 URL reader | C-019, C-024, C-042 | IPv4/IPv6/redirect/DNS pinning/size/MIME/HTML 실행 차단 |
| C-044 | P8 | SearchProvider mock+Brave live | C-043 | 키 없는 corpus search와 명시적 외부 검색 선택 구분 |
| C-045 | P8 | CLI 동일 command/query 경로 | C-015, C-040 | validate/dev/run/inspect/export, 승인 대기와 SIGINT 계약 |
| C-046 | P9 | public DemoDriver와 fixture pack | C-004, C-031, C-029 | 비밀키/로컬 서버 없이 D&D와 Reins가 모의 결과를 바꿈 |
| C-047 | P9 | Storybook 상태·Playwright 키보드/IME | C-010, C-016, C-025, C-031 | 포인터 없이 핵심 흐름 완주, 단순 axe 검사 외 수동 검증 |
| C-048 | P9 | 부하·가상화·profiling 예산 | C-041, C-047 | 고정 fixture/장비/build에서 수치와 flamegraph 기록 |
| C-049 | P9 | 통합 release gate·CI·SBOM | C-039, C-040, C-042, C-046, C-047, C-048 | 모든 요구 테스트 연결, 실제 LLM smoke는 별도 결과 |
| C-050 | P9 | 포트폴리오 사례 문서·known limitations | C-049 | 성능/기능 주장을 증거와 연결, 미구현 v0.2 기능 혼동 없음 |

## 7. 개발 분담과 통합 규칙

1인 개발이더라도 역할을 분리한다. Bell은 제품·용어·UX·수용 기준의 최종 결정자다. 구현 에이전트는 합의된 spec와 허용 파일 범위 안에서 구현한다. 별도 테스트/리뷰 역할은 happy path뿐 아니라 경합·거절·오용을 검사한다.

동시에 작업하기 좋은 경계는 Canvas/UI, Coordinator/Storage, Pi Adapter/Testkit이다. `contracts`와 공통 상태 전이는 동시 수정하지 않고 하나의 spec change가 먼저 merge되어야 한다. feature branch마다 contractVersion과 base revision을 기록한다.

PR에는 requirement IDs, 실패 테스트 설명, 실행한 명령과 결과, 화면 변경 시 story/trace, 위험·롤백을 적는다. 실제 실행하지 않은 테스트를 통과로 적지 않는다. 비용이 발생하는 live smoke는 별도 opt-in이며 API key를 로그·PR에 올리지 않는다.

## 8. CI 파이프라인

아래 스크립트 이름은 구현 목표다. 최초 저장소에서 실제 명령으로 정의하고 CI에서 검증해야 한다.

```bash
pnpm install --frozen-lockfile
pnpm spec:check            # 요구·태스크·테스트 ID와 명세 링크
pnpm contracts:check       # codegen diff + fixtures + schema parity
pnpm lint                 # Biome
pnpm typecheck            # strict + 패키지 경계
pnpm test:unit
pnpm test:contract
pnpm test:integration
pnpm build
pnpm test:e2e
pnpm test:a11y
pnpm test:performance      # nightly/release의 고정 부하
pnpm test:live             # 수동/예산 제한, 일반 PR에서 자동 호출 금지
```

PR gate는 unit/contract/integration/build와 핵심 E2E다. release gate에는 a11y·performance·라이선스·SBOM·live smoke 결과를 더한다. real LLM 결과가 flaky라고 deterministic 취소/버전 테스트를 retry로 숨기지 않는다.

외부 PR은 production key를 받지 않는다. GitHub Actions permission은 필요한 read/write만 부여하고, 공개 action은 검토한 commit SHA로 고정한다. dependency update는 그룹 PR로 만들고 contract suite를 통과해야 반영한다. provenance/보안 스캔 미확인 결과는 release note에 남긴다.

## 9. 리스크와 중단 기준

| 리스크 | 조기 신호 | 대응 | release 차단 여부 |
|---|---|---|---|
| Pi hook 의미/버전 불일치 | blocked tool에도 started, 지시 전달 시점 불명확 | pinned source contract 재검증, adapter 수정 | 차단 |
| 상태 중복 소유 | DB와 UI/Pi의 completed가 어긋남 | Coordinator 밖 mutation 금지·reducer 테스트 | 차단 |
| 부모 대기 슬롯 고갈 | 자식은 queued, 부모 전부 waiting | 모델 permit과 worker residency 분리 | 차단 |
| late callback 부활 | cancelled task가 completed로 변함 | epoch fence·idempotency·race property test | 차단 |
| 비용 과소 집계 | unknown/cached usage가 0 또는 중복 | raw+normalized, unknown budget 보수 처리 | hard cap 주장 시 차단 |
| 그래프 UI와 실행 불일치 | 연결 바꿔도 같은 순서 | compiler-E2E fixture 연결 | 차단 |
| 스티어링의 거짓 적용 | 이전 request 결과에 새 지시 인과 | ContextSnapshot 기반 연결 | 차단 |
| 로컬 키 노출/SSRF | export/client/로그에 key, 사설 주소 fetch | security suite·endpoint 정책 | 차단 |
| 유료 기능 종속 | Pro 예제/외부 서비스 없이 demo 불가 | 공개 API 기반 구현·mock 대체 | 차단 |
| UI 범위 팽창 | IDE/문서 편집/멀티플레이 추가 | Change Request로 후속 마일스톤 이동 | scope review |

## 10. 출시 판정과 포트폴리오 산출물

출시 보고서는 기능 체크 표시만이 아니라 AC별 테스트/trace/스크린샷/fixture hash를 연결한다. 공개 사례 문서에는 문제 정의, 상태 소유권 결정, D&D와 실행의 경계, 스티어링 적용 예, 접근성·성능 측정 환경, 실패했던 설계와 수정 이유를 기록한다.

README에서 실행 가능한 기능과 계획된 기능을 다른 표로 구분한다. `Local-first`는 모델 추론도 전부 로컬이라는 뜻이 아니며, 지원 provider와 외부 전송 범위를 명시한다. 이미 수행한 외부 작업을 되돌릴 수 있다는 오해를 만드는 replay 표현을 피한다.

## 11. MVP 다음 구현: v0.2 Decision switching

MVP 완료 후 첫 후속 기능으로 **Local/Jev 수동 switching**을 진행한다. DecisionQuestion, 후보 집합, response schema, capability registry, timeout, privacy policy를 먼저 명세한다. 해당 로컬 모델이 지원하지 않는 질문을 형식만 맞춰 전달하지 않는다.

1차 수용 기준은 같은 질문·후보에 두 adapter를 연결하고, 결과·지연·오류·근거 수준을 비교 가능한 형태로 기록하는 것이다. 자동 라우팅의 비용 절감이나 Hybrid threshold 품질은 별도 평가 단계다. LiteLLM 도입은 이 기능의 필수 조건이 아니다.
