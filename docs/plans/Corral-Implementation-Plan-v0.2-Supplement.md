# Corral — 구현 플랜 v0.2 보완

> 기준일: 2026-10-14. 이 문서는 [구현 플랜 v0.1](../../Corral-Implementation-Plan-v0.1.md)을 대체하지 않는다. **v0.1 + 이 보완 = 유효 구현 플랜 v0.2**다. 제품 범위의 기준은 여전히 [스펙](../../Corral-Spec-v0.1.md)이며, 이 문서는 스펙 문구를 바꾸지 않는다. 스펙을 바꿔야 하는 항목은 Change Request 후보로만 적는다. 기계 판독 데이터는 [backlog.json](../../contracts/backlog.json)과 [traceability.json](../../tests/traceability.json)에 반영했다. 2026-10-15에 Bell의 결정(§10)과 [CR-001](../change-requests/CR-001-openai-oauth-first.md)을 반영했다.

## 0. 요약

v0.1 플랜을 스펙, [기술 설계](../Technical-Design.md), [API 계약](../API-Contract.md), [테스트 전략](../Test-Strategy.md), [ADR](../Decisions.md), 요구 48개·태스크 50개·테스트 시나리오 112개와 대조했다. 큰 방향은 그대로 두고, 아래 결함만 보완한다.

| 구분 | 개수 | 내용 |
|---|---:|---|
| 순서 모순 수정 | 6 | D1–D6. 의존 순서가 문서 간에 어긋나거나 불필요하게 직렬인 곳 |
| 신규 태스크 | 12 | C-051–C-062. 스펙에 있지만 담당 태스크가 없던 화면·포트·인프라 |
| 기존 태스크 변경 | 14 | 변경 17건: 의존 10건, 완료 조건 5건, 범위 2건 |
| 결정 기록 | 7 | ADR-014–020. 018–020은 Bell 확정, 014–017은 P0 구현·측정으로 채택. 범위 변경은 [CR-001](../change-requests/CR-001-openai-oauth-first.md) |
| 재추정 | — | 기본 250–400h → 301–484h, 버퍼 포함 361–581h |

## 1. 정합성 수정

### D1. 실모델 연결이 로컬 보안 경계보다 먼저 온다

- **근거:** [기술 설계 §7.1](../Technical-Design.md)은 “실모델 연결은 최소 localhost 세션·Origin/Host 검사를 먼저 갖춘 상태에서만 활성화”한다고 정한다. v0.1 백로그에서는 C-020(P3 live smoke)이 C-042(P8 세션·Origin/Host)에 의존하지 않는다.
- **문제:** P3부터 P8 사이에 API 키를 가진 서버가 Origin 검사 없이 떠 있을 수 있다. localhost에 bind해도 임의 웹페이지의 요청은 신뢰할 수 없다(스펙 §10.2).
- **수정:** 최소 경계를 **C-055(P2)**로 분리해 C-015 직후에 두고, C-020이 이를 의존한다. 범위는 127.0.0.1 bind, Host allowlist, Origin 검사, 일회성 bootstrap → HttpOnly·SameSite=Strict 세션, CORS 미허용, CSP다. C-042는 P8의 **전체 감사**(CSRF 토큰, 요청 크기·빈도 제한, DNS rebinding, query/log/export 키 누출)로 축소한다.

### D2. P0 exit gate에 runtime 경로가 없다

- **근거:** v0.1 §5 P0는 “backend 없는 viewer만으로 P0를 닫지 않는다”고 한다. 그런데 P0 태스크(C-001–C-004)에는 runtime/transport 작업이 없고, 서버와 저장소는 P2(C-011, C-015)다. [ADR-012](../Decisions.md)는 “mock RuntimeTransport”를 이름으로만 언급한다.
- **해석:** P0의 backend를 “Studio가 transport 포트로 core에 명령을 보내고 receipt·event를 받는 경로”로 정의한다. HTTP 서버는 계속 P2다.
- **수정:** **C-053 RuntimeTransport 포트 + InProcessTransport**를 P0에 둔다. Studio는 처음부터 이 포트로만 runtime과 통신한다. P2의 HttpSseTransport(C-015)도 같은 계약 테스트를 통과해야 한다. P9의 DemoDriver(C-046)는 InProcessTransport를 Web Worker에서 재사용한다. 이렇게 해야 데모가 “같은 편집기·상태 투영·Reins”(스펙 §1.2)를 실제로 공유한다.

### D3. Canvas가 정의 스키마보다 먼저 만들어진다

- **근거:** C-004(P0)는 Agent→Output 정의를 만드는데, Zod 정의 C-005는 P1이다.
- **문제:** P0에 일회용 타입이 생기고, P1에서 정의 형식과 hash 규칙이 바뀌면 P0 fixture가 깨진다.
- **수정:** **C-054 최소 정의 slice**를 P0에 둔다. 범위는 Agent/Output/control edge/roles, JCS 정규화, definitionHash다. C-005는 이를 확장한다. AC-02의 기반인 hash 규칙이 P0에서 고정된다.

### D4. CI와 저장소 스캐폴드가 P9에 있다

- **근거:** v0.1 §8은 PR gate(unit/contract/integration/build/핵심 E2E)를 정의하고, §3.3은 “requirements → test-catalog → backlog를 CI에서 검사”한다고 정한다. 그런데 CI 태스크는 C-049(P9)뿐이고 모노레포 스캐폴드 태스크는 없다.
- **수정:** **C-051(P0)**에서 pnpm workspace, TS strict, Biome, Vitest, Playwright, Storybook 설정과 PR gate CI, `pnpm spec:check`를 만든다. 초기 spec:check는 `tools/validate_pack.py`에 테스트 소스의 TC 태그 검사를 더한 것이다(§5). C-049는 release gate 전용으로 한정한다.

### D5. 불필요한 직렬 의존

- **C-012 → C-011:** 순수 decide/reduce가 SQLite에 의존할 이유가 없다. [기술 설계 §2](../Technical-Design.md)는 Repository 포트로 DB 구현을 runtime 밖으로 격리하라고 한다. C-012는 **[C-005, C-003]**에 의존하고, 명령 dedupe는 in-memory Repository로 TDD한다. SQLite 연결은 C-013이 C-011과 C-012를 함께 의존해 처리한다.
- **C-022 → C-017:** spawn/await 의미는 ScriptedAgent로 검증할 수 있다. Pi에 협업 도구를 노출하는 작업은 이미 C-025의 파일 범위(`packages/adapter-pi/tools/`)에 있다. C-022는 **[C-021, C-003, C-013]**에 의존한다.
- **효과:** P2 안에서 저장소와 reducer를, P3(Pi)와 P4(협업 의미)를 병렬로 진행할 수 있다. v0.1 §7의 병렬 경계(Coordinator/Storage, Pi Adapter/Testkit)와도 맞는다. 1인 개발에서는 총 시간이 줄지 않지만 막혀서 기다리는 시간이 줄어든다.

### D6. 산출물 렌더링 보안이 첫 렌더보다 늦다

- **근거:** 스펙 §10.2는 Markdown을 HTML 실행 없이 렌더링하고 원격 이미지를 기본 차단하라고 한다. 산출물이 처음 화면에 나오는 것은 C-025(P4)와 C-030(P5)인데, 관련 보안 검증은 C-043(P8)에 있다.
- **수정:** C-025의 완료 조건에 **SafeMarkdown**을 추가한다. raw HTML 플러그인을 쓰지 않고, URL scheme을 allowlist로 제한하며, 원격 이미지를 기본 차단한다. C-030과 C-046은 이 컴포넌트만 사용하고, P8에서는 다시 검증만 한다.

## 2. 신규 태스크

시간은 v0.1과 같은 방식의 **추측에 기반한 계획용 집중 작업 시간**이다.

| ID | 단계 | 작업 | 의존 | 요구 | 완료 조건 | 추정 |
|---|---|---|---|---|---|---:|
| C-051 | P0 | 모노레포 스캐폴드·PR gate CI·spec:check·LICENSE·`CLAUDE.md`→`AGENTS.md` | C-001 | DEV-003, DX-002 | 빈 패키지 상태에서 install --frozen-lockfile·spec:check·lint·typecheck·test:unit이 CI에서 실제로 돈다. ID 오류를 넣은 PR은 실패한다 | 6–10h |
| C-052 | P0 | 기술 스파이크 go/no-go 판정 | C-002 | DX-002, DEV-004 | 아래 판정표 전 항목에 pass/fail과 근거(버전·commit·측정값)를 남기고 ADR-014–017 상태를 정한다 | v0.1 P0 스파이크 + 4–8h |
| C-053 | P0 | RuntimeTransport 포트·InProcessTransport·transport 계약 테스트 | C-003, C-054 | DEV-005, OBS-002, DEV-002 | 같은 ScriptedAgent 스크립트에 대해 구현과 무관하게 같은 receipt·event 순서 | 4–6h |
| C-054 | P0 | 최소 정의 schema slice·JCS 정규화·definitionHash | C-001 | CAN-002 | seed schema와 parity. 키 순서·좌표가 달라도 같은 hash, 프롬프트가 바뀌면 다른 hash | 2–4h |
| C-055 | P2 | 최소 로컬 보안 경계(bind·Host·Origin·bootstrap 세션·CSP) | C-015 | SEC-002 | 허용 외 Host/Origin은 403, bootstrap token 재사용 거부, CORS 헤더 없음, CSP 적용 상태에서 Studio E2E 통과 | 4–6h |
| C-056 | P1 | Studio 셸·라우팅·Workspace 화면 | C-004, C-009 | OBS-001, CAN-001 | 스펙 §4.1의 경로가 직접 진입·새로고침·뒤로가기에서 동작. 1280px 미만에서 핵심 버튼이 가려지지 않음. error boundary. UI 문자열은 메시지 카탈로그로 분리(영어 단일 locale로 시작) | 6–10h |
| C-057 | P2 | Run 생성 멱등·RunSnapshot 고정·활성 Run 1개 | C-008, C-011, C-012 | CAN-002, RUN-001 | 같은 commandId는 같은 runId. 두 번째 활성 Run은 409. 시작 후 정의를 수정해도 snapshot hash 불변 | 5–8h |
| C-058 | P3 | ModelRegistry·`/settings/models`·OAuth 로그인 | C-020, C-056 | SEC-002, OBS-004 | 로그인 상태·만료만 표시하고 응답·번들·로그·이벤트에 토큰 원문 없음. 로그인·로그아웃·만료 흐름. 구독 사용은 금액 null과 plan usage로 표시 | 6–10h |
| C-059 | P2 | E2E 하네스 | C-003, C-015 | DEV-002, DEV-004 | 테스트별 독립 DB, 외부 host fetch 시 실패, 실패 trace 보존, 같은 seed에서 같은 이벤트 순서 | 5–8h |
| C-060 | P2 | Timeline 가상 목록·필터 | C-015 | OBS-001, UX-002 | 10,000개 이벤트 fixture에서 DOM 행 수가 화면 크기에 비례. actor/kind/execution 필터. 새 이벤트가 와도 선택·스크롤 위치 유지 | 5–8h |
| C-061 | P7 | BudgetInspector·usage 표시 | C-037, C-060 | OBS-004, RUN-006 | 확인값·예약값·미확인값·추정 금액을 문구로 구분. unknown을 0으로 표시하지 않음 | 3–5h |
| C-062 | P2 | Workspace 디스크 레이아웃·설정·설치 정책 hard cap | C-005 | RUN-006, SEC-002 | 알 수 없는 설정 키와 hard cap 초과 값 거절. 키를 설정 파일에서 읽지 않음. 스펙 §9 기본값 fixture와 일치 | 3–5h |

### 2.1 C-052 판정표

ADR-004와 ADR-005는 “P0/P1에서 증명하지 못하면 ADR 갱신”을 요구하지만 판정 기준이 없었다. 기준값은 출발 제안이며, 확정값은 ADR에 기록한다.

| 항목 | 확인할 것 | 실패 시 |
|---|---|---|
| Pi 도구 훅 | `beforeToolCall`과 `tool_execution_start`의 실제 순서. block한 도구가 실행되지 않는지 | `tool.started`는 host 승인 후에만 기록한다. 그래도 안 되면 pi-ai 경계로 내리는 ADR(기술 설계 §7.5) |
| Pi 요청 준비 | 요청마다 host가 확정한 context(지시 포함)를 주입할 지점 | 요청 조립을 adapter 쪽으로 옮긴다 |
| Pi abort·usage | AbortSignal 전파, 중단 시 usage 필드, provider별 usage 형식 | unknown usage 경로를 기본으로 둔다 |
| LangGraph 재진입 | 같은 node 재진입 시 activationKey로 중복 Task 없음. retry 비활성. checkpointer 없이 실행 | ADR-004의 대안인 제한 IR 인터프리터 |
| LangGraph 브라우저 | 브라우저용 진입점(`@langchain/langgraph/web`)으로 Web Worker 안에서 실행 가능한지 | 데모 runner를 별도로 결정한다(ADR-016). 서버 runner와 같은 IR에서 같은 activation 순서를 내는지 테스트 필수 |
| OpenAI OAuth | pi-ai의 OpenAI OAuth 두 경로(`OpenAI (Sign in with ChatGPT)`, `OpenAI Codex (legacy)`)의 로그인 흐름, 토큰 저장 위치를 host가 정할 수 있는지, refresh를 host가 수행할 수 있는지, worker에 access token만 넘길 수 있는지 | Sign in with ChatGPT 경로를 우선한다. 둘 다 안 되면 CR-001 재검토(API 키 경로로 시작) |
| SQLite | Node 24에서 better-sqlite3 prebuild 동작, pnpm 10의 빌드 스크립트 기본 차단에 대한 허용 설정(`onlyBuiltDependencies`), WAL·busy_timeout·정상 종료 | `node:sqlite` 평가 |
| worker | 대기 worker 12개의 RSS 합계(제안 기준 1.5 GiB 이하)와 spawn p95(제안 기준 1초 이하), kill 후 정리 | worker_threads 또는 필요 시 spawn(lazy spawn) |

### 2.2 C-053 포트 초안

실제 코드가 아니라 계약의 모양이다. 명령은 commandId로 멱등이고, 이벤트는 runSeq 순서를 따른다([API 계약 §2·§5](../API-Contract.md)).

```ts
interface RuntimeTransport {
  sendCommand(command: Command): Promise<Receipt>;
  getReceipt(runId: RunId, commandId: CommandId): Promise<Receipt>;
  getSnapshot(runId: RunId): Promise<{ projection: RunProjection; seq: number }>;
  subscribe(runId: RunId, afterSeq: number, handlers: {
    onEvent(event: RunEvent): void;
    onFrame?(frame: StreamFrame): void;
    onGap(expectedSeq: number): void;
  }): () => void;
}
```

### 2.3 C-062 레이아웃 제안

산출물과 등록 문서 본문은 기술 설계 §11에 따라 SQLite에 저장하므로 별도 본문 디렉터리를 두지 않는다. API 키는 서버 프로세스 환경 변수에서만 읽는다(ADR-019).

```text
<workspace>/
  .corral/
    corral.db        # SQLite, WAL
    config.json      # 설치 정책 hard cap, 모델 프로필 이름(키 없음)
```

## 3. 기존 태스크 변경

| ID | 변경 | 이유 |
|---|---|---|
| C-004 | 의존 += C-051, C-053, C-054. 완료 += Storybook axe를 PR gate에서 실행 | D2, D3, D4. 접근성 검사를 P9에서 P0로 앞당김 |
| C-005 | 의존 += C-054 | D3 |
| C-006 | 완료 += 노드·연결 story의 axe 검사 | 접근성 검사를 앞당김 |
| C-011 | 의존 += C-062 | DB 파일 위치가 workspace 레이아웃에 따라 정해짐 |
| C-012 | 의존 = [C-005, C-003]. 완료 += fast-check model-based reducer 테스트 seed 보관 | D5. property test를 P7에서 P2로 앞당김 |
| C-013 | 의존 += C-011 | D5. 저장소 연결 지점 |
| C-014 | 의존 += C-057 | GraphRunner는 고정된 RunSnapshot 위에서 실행 |
| C-016 | 완료 += stream delta 수신 중 캔버스 노드 재렌더 0, run history 목록 | 성능 실패 조건(스펙 §10.3)을 P2에서 확인. Workspace 화면의 실행 이력 |
| C-020 | 의존 += C-055 | D1 |
| C-022 | 의존 = [C-021, C-003, C-013] | D5 |
| C-025 | 완료 += SafeMarkdown | D6 |
| C-042 | 범위를 전체 감사로 축소, 의존 += C-055 | D1 |
| C-046 | 의존 += C-053 | D2 |
| C-049 | 범위를 release gate·SBOM·라이선스로 한정 | D4. PR gate는 C-051 |

## 4. 아키텍처 결정 후보

ADR-018·019·020은 Bell이 2026-10-15에 확정했다. 014–017은 P0 구현과 [C-052 측정](../spikes/C-052-p0-spikes.md)으로 같은 날 채택했다. 모두 [ADR 원장](../Decisions.md)에 기록했다.

| ADR | 결정안 | 이유 | 확정 |
|---|---|---|---|
| ADR-014 | `contracts`·`core`는 `node:*`, Buffer, process, DOM에 의존하지 않는다. Biome `noRestrictedImports`와 tsconfig `types` 제한으로 강제한다 | 정적 데모가 같은 Coordinator를 브라우저에서 실행한다(ADR-012). 테스트 더블 주입(DEV-002)도 쉬워진다. 현재 기술 설계 §2는 “DOM·React 비의존”만 명시한다 | C-051 |
| ADR-015 | 정규화는 RFC 8785(JCS), hash는 SHA-256(hex). 동기 순수 JS 구현과 WebCrypto 중 C-054에서 선택한다 | 기술 설계 §3의 “키 정렬·UTF-8”을 표준으로 고정한다. Python 등 다른 도구에서도 같은 hash를 재현할 수 있다 | C-054 |
| ADR-016 | RuntimeTransport 포트를 HttpSse와 InProcess로 구현하고, 공개 데모는 Web Worker 안의 InProcess를 쓴다 | D2. 데모와 실제 Studio가 같은 투영·Reins 코드를 쓴다 | C-053 |
| ADR-017 | worker 실행 방식(child_process / worker_threads / lazy spawn) | 12개 resident worker의 메모리·spawn 비용이 측정되지 않았다(ADR-005 “admission overhead는 측정한다”) | C-052 |
| ADR-018 | **확정.** 라우터는 TanStack Router | `?execution=`, `?artifact=` 같은 search param을 타입으로 다루고, TanStack Query와 같은 계열로 맞춘다. v0.1 채택표에 라우터가 없었다 | C-002에서 버전 잠금 |
| ADR-019 | **확정.** MVP는 pi-ai의 OpenAI 구독 OAuth로 시작한다. 토큰은 workspace 밖 credential store(0600)에 두고 host가 갱신한다. API 키는 서버 환경 변수에서 읽는다. Anthropic 구독 OAuth는 지원하지 않는다 | [CR-001](../change-requests/CR-001-openai-oauth-first.md). Anthropic은 제3자 앱의 구독 자격 증명 사용·토큰 중개를 허용하지 않는다(2026-10-15 확인) | C-052, C-058 |
| ADR-020 | **확정.** 서버·runtime·CLI 언어는 TypeScript(Node 24)로 통일한다. Rust는 MVP에 넣지 않는다 | Pi agent-core·pi-ai·LangGraph.js가 TS다. Rust 서버를 두면 Pi worker용 Node가 여전히 필요해 두 런타임과 언어 간 IPC가 생긴다. Zod 계약 한 곳에서 서버·클라이언트·데모 타입을 만드는 구조(v0.1 §3.3)가 깨지고, 브라우저 데모의 같은 Coordinator 실행(ADR-014·016)에 WASM이 필요해진다. 성능 목표(제어 접수 p95 200ms 등)는 I/O 위주라 Node로 충분하다. worker 메모리 문제는 C-052에서 Node 안의 대안부터 측정한다 | 확정 |

## 5. 테스트·추적 보강

**TC 태그 규칙.** 테스트 제목에 시나리오 ID를 넣는다. 예: `it('[TC-RNS-001-N] 진행 중 요청에 늦게 들어온 지시를 전달로 표시하지 않는다', …)`. Playwright와 Storybook 테스트도 같은 규칙을 따른다.

**spec:check 단계.**

1. `tools/validate_pack.py`의 ID·참조·비순환·링크 검사.
2. 테스트 소스에서 TC 태그를 수집한다. [test-catalog.json](../../tests/test-catalog.json)에 없는 ID와 중복 ID는 실패다.
3. test-catalog의 `passed`는 CI junit 결과로만 바꾼다. 손으로 바꾸면 실패다.
4. backlog의 `done`은 연결된 필수 TC가 모두 `passed`일 때만 허용한다.

**추가 시나리오 후보.** 이번 보완에서는 test-catalog를 바꾸지 않는다. C-001에서 테스트 이름을 매핑할 때 등록 여부를 정한다.

| 후보 | 요구 | 태스크 | 검증 |
|---|---|---|---|
| transport parity | DEV-005, OBS-002 | C-053 | InProcess와 HttpSse가 같은 스크립트에서 같은 receipt·event 순서 |
| runner parity | CAN-001, RUN-003 | C-052, C-046 | 데모 runner와 서버 runner가 같은 IR에서 같은 activation 순서 |
| hash 교차 검증 | CAN-002 | C-054 | `examples/research-team.corral.json`의 TS hash와 Python JCS hash 일치 |
| render budget | UX-002 | C-016 | stream delta 수신 중 캔버스 노드 재렌더 0 |
| bootstrap 재사용 | SEC-002 | C-055 | 사용한 bootstrap token으로 세션을 다시 만들 수 없음 |

**앞당긴 검증.** axe(C-004, C-006: P0/P1), fast-check(C-012: P2), render-count(C-016: P2), SafeMarkdown(C-025: P4). P9의 C-047·C-048과 P7의 C-039는 이를 확장한다.

## 6. 수용 기준별 처음 검증 단계

“처음 완전 검증”은 그 AC의 장면 전체를 자동 테스트로 확인할 수 있는 가장 이른 단계다. 이번 보완에서 traceability의 CRL-CAN-001에 C-014와 C-057을 연결했다. 스펙 §4.2의 “실제 순서가 달라져야 한다”를 확인하려면 실행 경로가 필요하기 때문이다.

| AC | 요구 | 핵심 태스크 | 처음 완전 검증 | 비고 |
|---|---|---|---|---|
| AC-01 | CAN-001, CAN-004 | C-004, C-006–C-008, C-014, C-057 | P2 | P0는 Agent→Output mock, P1은 IR 변환까지 |
| AC-02 | CAN-002, CAN-005 | C-054, C-005, C-009, C-010 | P1 | hash 규칙은 P0에서 고정 |
| AC-03 | RUN-002, RUN-004 | C-013, C-016, C-022 | P4 | |
| AC-04 | COL-002, COL-003 | C-023, C-025 | P4 | |
| AC-05 | ART-002, ART-003 | C-026, C-027, C-030 | P5 | 지시와의 연결 표시는 C-036(P6) |
| AC-06 | OBS-001, OBS-004 | C-016, C-060, C-030, C-061 | P7 | 대기 이유 P2, 원천·생성 경로 P5, usage P7 |
| AC-07 | RUN-006 | C-028, C-037, C-038 | P7 | Loop 상한은 P5 |
| AC-08 | RNS-001, RNS-002, RNS-010 | C-018, C-031, C-036 | P6 | |
| AC-09 | RNS-006, RNS-009 | C-035 | P6 | |
| AC-10 | RNS-007 | C-037, C-061 | P7 | |
| AC-11 | RNS-003 | C-032 | P6 | |
| AC-12 | RNS-004, SEC-004 | C-013, C-033 | P6 | 무작위 경합은 C-039(P7) |
| AC-13 | COL-004, RNS-004 | C-023, C-033 | P6 | |
| AC-14 | RNS-005 | C-034 | P6 | |
| AC-15 | DEV-001, RNS-008 | C-012, C-015, C-029, C-035, C-039 | P7 | 명령 중복 P2, 승인 중복 P5, revision 충돌 P6, 늦은 결과 P7. C-035와 C-039는 traceability상 이 AC의 요구에 연결되어 있지 않으므로 C-001에서 검토 |
| AC-16 | OBS-002, RUN-007 | C-015, C-040, C-041 | P7 | SSE 재접속은 P2 |
| AC-17 | SEC-001–003 | C-019, C-025, C-055, C-042, C-043 | P8 | 도구 권한 P3, 렌더링 스크립트 차단 P4 |
| AC-18 | DEV-004, OBS-004 | C-017–C-020, C-055 | P3 | |
| AC-19 | DEV-005, UX-001, UX-002 | C-046–C-048 | P9 | |
| AC-20 | DEV-003, DX-002 | C-051, C-049 | P9 | spec:check는 P0부터 |

## 7. 내부 마일스톤

v0.1 §1에 따라 중간 결과를 MVP라고 부르지 않는다. 각 마일스톤은 내부 점검과 재추정 시점이다. 공개 데모는 P9다.

| 마일스톤 | 단계 끝 | 보여줄 장면 | 검증 AC |
|---|---|---|---|
| M0 walking skeleton | P0 | 빈 캔버스에 Agent→Output을 드롭·연결하고 InProcess mock run을 본다. 지시는 pending | AC-01 일부 |
| M1 영속 실행 | P2 | 저장한 정의를 서버에서 실행하고, 연결을 바꾸면 실행 순서가 바뀐다. 새로고침·재접속 후 같은 투영 | AC-01, AC-02 |
| M2 실제 협업 | P4 | 실모델 두 프로필로 조사자 자식 2개와 Writer 질문 왕복 | AC-03, AC-04, AC-18 |
| M3 Reins | P6 | 진행 중 지시, pause, 개별 취소, 미래 patch, 조건부 재시작 | AC-05, AC-08, AC-09, AC-11–AC-14 |
| MVP | P9 | 전 AC | AC-01–AC-20 |

## 8. 재추정

v0.1과 마찬가지로 추측에 기반한 계획값이다. D1·D4로 C-042·C-049에서 옮겨 온 작업량은 보수적으로 상쇄하지 않았다.

| 단계 | v0.1 | 추가 | v0.2 | 추가 사유 |
|---|---:|---:|---:|---|
| P0 | 18–28h | +16–28h | 34–56h | C-051, C-052 판정 기준, C-053, C-054 |
| P1 | 30–46h | +6–10h | 36–56h | C-056 |
| P2 | 26–40h | +22–35h | 48–75h | C-055, C-057, C-059, C-060, C-062 |
| P3 | 22–36h | +6–10h | 28–46h | C-058(CR-001의 OAuth 로그인 흐름 포함) |
| P4 | 30–48h | 0 | 30–48h | |
| P5 | 20–32h | 0 | 20–32h | |
| P6 | 32–50h | 0 | 32–50h | |
| P7 | 26–42h | +3–5h | 29–47h | C-061 |
| P8 | 22–36h | 0 | 22–36h | |
| P9 | 24–42h | 0 | 24–42h | |
| **합계** | **250–400h** | **+53–88h** | **303–488h** | |

불확실성 여유 20%를 더하면 **364–586h**다. 주 10시간이면 약 36–59주, 주 20시간이면 약 18–29주다. M0와 M1에서 실측으로 다시 보정한다.

## 9. 범위 축소 시 Change Request 후보 순서

**발동 조건:** P0 또는 P1의 실측이 v0.2 추정 상한을 30% 넘게 초과한 경우. 먼저 남은 단계를 실측 기준으로 재추정하고, 그래도 일정이 맞지 않을 때 아래 순서로 [변경 요청](../../templates/change-request.md)을 작성한다. 스펙 §3.1의 핵심(D&D, 협업, Loop, subagents, Reins)은 목록에 넣지 않는다([ADR-002](../Decisions.md)).

| 순서 | 후보 | 영향 요구 | 유지할 것 |
|---:|---|---|---|
| 1 | Brave live search 제외, mock corpus만 제공 | DX-003, SEC-003 일부 | SearchProvider 포트 |
| 2 | CLI를 validate/inspect/export로 축소하고 `run --watch`는 후속 | DX-001 | CLI와 Studio의 같은 Coordinator 경로 |
| 3 | Firefox E2E를 smoke로 축소 | UX-001 증거 범위 | Chromium 전체 E2E |
| 4 | HTTPS URL reader 제외, 등록 문서만 허용 | SEC-003, AC-17 일부 | import 크기 제한, HTML 실행 차단 |

## 10. 결정 항목

소유자는 모두 Bell이다.

**확정 (2026-10-15)**

| 항목 | 결정 | 반영 |
|---|---|---|
| 모델 연결 | OpenAI 구독 OAuth로 시작하고 같은 provider의 모델 프로필 2개를 둔다. 이후 Pi가 지원하는 provider·인증 방식 전체로 확장하며, Anthropic 구독 OAuth만 정책상 제외한다([CR-001](../change-requests/CR-001-openai-oauth-first.md)) | C-020, C-052, C-058 |
| 서버·runtime 언어 | TypeScript(ADR-020) | 전 패키지 |
| 라우터 | TanStack Router(ADR-018) | C-002, C-056 |
| UI 언어 | 영어로 시작한다. 다른 언어를 나중에 추가할 수 있도록 P1부터 문자열을 메시지 카탈로그로 분리하고, 날짜·숫자는 `Intl`로 표시한다. i18n 라이브러리는 C-002에서 의존성 기록과 함께 고른다. 한국어·일본어 IME 입력 요구(UX-001)는 그대로다 | C-002, C-056 |
| 라이선스 | MIT | C-051에서 `LICENSE` 생성 |

**미정**

| 항목 | 선택지 | 기한 | 연결 태스크 |
|---|---|---|---|
| workspace 총량 제한 | 스펙 §9에 “별도”로만 있음 | P2 | C-062 |
| Run 삭제·보존 정책 | 스펙에 없음. 정하지 않으면 known limitation | P7 | C-040, C-050 |
| 데모 호스팅과 CSP | 정적 호스팅 서비스 선택, 응답 헤더 | P9 | C-046 |

## 11. 기계 판독 데이터 변경 내역

- [backlog.json](../../contracts/backlog.json): 태스크 50개 → 62개. §2의 신규 태스크와 §3의 의존·완료 조건·범위 변경을 반영했다. 기존 ID는 번호를 바꾸지 않았고, 모든 상태는 `planned`다. 어떤 태스크도 더 늦은 단계의 태스크에 의존하지 않는다.
- [traceability.json](../../tests/traceability.json): 신규 태스크를 각 요구 행에 연결했다. CRL-CAN-001에는 C-014와 C-057을 추가로 연결했다.
- [test-catalog.json](../../tests/test-catalog.json)은 바꾸지 않았다. 새 요구가 없기 때문이다.
- 루트 README, `RELEASE-INDEX.json`, [문서 팩 검증 결과](../Pack-Validation.md), `tests/pack-validation-report.json`은 v0.1 스냅샷이라 갱신하지 않았다. `python tools/validate_pack.py`를 다시 실행하면 보고서가 v0.2 데이터 기준으로 갱신된다.
