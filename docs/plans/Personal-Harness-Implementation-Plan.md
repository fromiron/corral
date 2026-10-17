# Corral 개인 하네스 구현 플랜 (구현 가능성 확인판)

- 작성: Claude / 2026-10-17. 기준 커밋은 `main` `8150c2e`(PR #53 병합)이다.
- 원안: Bell의 [Corral Personal Harness 구현 계획](../proposals/personal-harness-2026-10-17.md)(2026-10-17).
- 상태: **제안**이다. 착수하려면 Bell이 [§3](#3-먼저-바꿔야-하는-기존-결정)의 CR-018과 ADR-027을 승인해야 한다.
- 진행 규칙은 [AGENTS.md](../../AGENTS.md)를 그대로 따른다.
  - CR이 먼저, red test가 먼저.
  - 외부 호출·시간·ID는 주입한다.
  - 일반 CI에 유료 호출을 넣지 않는다.
  - 라이브러리마다 버전·라이선스·근거를 기록한다.

### 확인 방법

이번에 직접 한 일:

- `pnpm spec:check`를 로컬에서 실행했다.
- `gh run list`로 main CI 기록을 확인했다.
- `npm view`로 Pi 4개 패키지의 버전·날짜·라이선스·의존성을 확인했다.
- 다음 tarball을 scratchpad에 풀어 **선언(`.d.ts`)·문서·JS 소스를 읽었다**.
  - `@earendil-works/pi-coding-agent` 1.2.0과 1.3.0
  - `pi-agent-core` 1.3.0
  - `@dietrichgebert/ponytail` 5.3.2(원본 Ponytail)
- `gh api`로 DSH architecture, DSH Studio README와 Pixie Loop 문서, OMP의 인용 파일 3개를 읽었다.

하지 않은 일:

- SDK 코드 실행, 모델 호출, 패키지 설치, 확장 로드.
- 따라서 아래의 "가능"은 **공개 API와 소스를 읽어 내린 판단**이다. 통합 성공은 아니다.
- 실제 동작은 [§6 H1 스파이크](#6-단계별-구현)가 판정한다.

---

## 0. 결론

**구현할 수 있다.** 원안의 방향(Pi 표준 원형 사용, Coordinator가 소유권 유지)은 Pi 1.3.0 공개 API로 성립한다.

- 원안이 가장 걱정한 지점은 SDK가 permit·도구 승인·요청 기록의 통제 지점을 주는가였다. 주는 것으로 확인했다([§2](#2-pi-sdk에서-찾은-통제-지점)).
  - 모든 모델 요청이 `modelRuntime.streamSimple` 한 곳으로 모인다. 세션 요청, 자동 재시도, 자동 압축, 캐시 warming, 확장의 중첩 호출이 모두 여기를 지난다.
  - Corral이 이 경로에 **자체 provider**를 등록하면 공개 API만으로 모든 요청에 permit을 걸 수 있다.
- 다만 원안 그대로는 시작할 수 없는 이유가 여섯 가지 있다.

| # | 원안에 없거나 다르게 봐야 하는 점 | 영향 |
|---|---|---|
| 1 | 현재 스펙과 결정이 이 기능을 **명시적으로 제외**한다. Spec §범위(111행)는 "A2A/MCP 확장 로딩, 셸/코딩"을 뺀다. ADR-005는 "coding-agent 대신 agent-core, untrusted plugin 없음"이다. ADR-024는 "사용자 정의 hook·런타임 로딩·공개 플러그인 API 없음"이다. Technical-Design 233행과 Dependencies-and-Sources 27행도 같다 | CR-018과 ADR-027이 **H0 다음 첫 일**이다. 구현보다 먼저다 |
| 2 | SDK에는 기존 worker가 쓰는 `streamFn`·`prepareRequest` 주입 옵션이 없다. `AgentSession`이 `agent.prepareRequest`·`beforeToolCall`을 자기 것으로 설치한다 | 기존 permit·지시 주입 방식을 옮길 수 없다. provider 경유 permit과 steer 기반 지시로 다시 설계한다([§5](#5-핵심-설계-결정) D2·D4) |
| 3 | Pi 스킬은 모델이 **`read` 도구로 절대경로의 `SKILL.md`를 읽는** 방식이다. Corral에는 `read`가 없고 `read_file`은 worktree 안만 읽는다 | 그대로 붙이면 스킬이 **조용히 안 읽힌다**. 스킬 번들을 읽는 `read`가 R1에 필요하다. 스킬 스크립트는 bash가 없어 R1 비지원이다 |
| 4 | 원본 Ponytail 확장은 `~/.config/ponytail/config.json`·`~/.claude`를 직접 읽는다. `/ponytail default`는 파일을 쓴다 | 원안 §4.3의 "신뢰한 네이티브 확장" 경우의 실제 예다. 설정 home 격리와 신뢰 표시가 R1에 필요하다 |
| 5 | Pi 1.2.0부터 **codemode(중첩 도구 호출)·MCP·tool_search가 공식 내장**이다(SDK는 기본 미로드). 중첩 호출도 `tool_call` hook을 지난다 | OMP 도구 브리지의 아이디어는 공식 Pi로 대체된다. H8이 작아진다 |
| 6 | DSH 본체는 0.2.x RC·alpha이고 DSH Studio는 그 RC만 지원하는 개인 프로젝트다(별 1개) | 아이디어만 흡수한다. 의존성과 수치는 가져오지 않는다(원안과 같은 결론, 근거 보강) |

권장 릴리스 구성은 원안과 같다(R1 = H0–H3, R2 = H4–H6, R3 = H7–H8).

- H1 스파이크 8개 중 **S1(permit), S2(도구 승인 순서), S4(리소스 격리)** 가운데 하나라도 실패하면 SDK 전환을 멈춘다.
- 이때 기존 agent-core worker를 유지하고, 상위 Pi에 공개 확장 지점을 제안한다(원안 §4.1과 같다).

---

## 1. 원안 주장 확인표

| 원안 주장 | 확인 결과 | 근거 |
|---|---|---|
| main CI가 `spec:check`에서 실패, TC-REF 9개 미등록 | **맞다.** PR #52 병합(`39035868645`)부터 실패한다. 로컬 실행도 같은 9개다. 로컬에서는 `jsonschema` 미설치로 pack 검사도 실패한다(CI 환경 문제는 아님) | `pnpm spec:check`, `gh run list` |
| 추가로 확인한 것 | `tools/spec-check/tc-tags.ts`의 정규식은 `-\d{3}-[HN]`만 본다. 그래서 `TC-REF-003-F`·`-006-D` 등 5개와 `TC-UX-04-H` 등 2자리 10개는 **검사되지 않는다** | `tc-tags.ts` 11행 |
| Pi `pi-agent-core`·`pi-ai` 1.2.0, `worker.ts`가 `new Agent()` | 맞다. 1.2.0은 2026-10-12, 1.3.0은 2026-10-15 공개다. 4개 패키지 모두 MIT, Node ≥22.19.0이다 | `packages/adapter-pi/package.json`, `npm view` |
| 추가로 확인한 것 | coding-agent 1.2.0은 내부 의존을 `^1.2.0`로 선언했다. 1.3.0이 정확한 버전 고정으로 고쳤다. 1.3.0은 "잘못된 JSON 인자를 앞부분만 파싱해 실행하던" 버그도 고쳤다(#10897) | 1.3.0 CHANGELOG |
| `WorkTool` enum과 `AgentRole` 고정 허용 목록 | 맞다(`allowedWorkTools: z.array(WorkTool).max(8)`) | `definition.ts` 25–67행 |
| `prepare_request`에 최종 prompt 본문 없음 | 맞다. 프레임은 `{type, executionId, requestId}`뿐이다 | `protocol.ts` |
| `AdmissionConfig.gates`는 기본 gate를 **교체** | 맞다(`{ ...DEFAULT_GATES, ...config.gates }`) | `admission/index.ts` 532행 |
| 파일 broker의 read 기록이 Run 단위 | 맞다(`readsOf(runId)`) | `files/service.ts` |
| 검증 명령은 `spawn(shell:false)`, 시작 tree 기록 | 맞다. 추가로 다음 다섯 가지를 확인했다. ① 취소 API가 없다. ② `child.kill`이 **직계 프로세스만** 종료한다(npm 아래 자식은 남는다). ③ duration에 `Date.now()`를 직접 쓴다(시계 주입 규칙 위반). ④ Run·execution 소유권이 없다. ⑤ 출력 tail만 남는다 | `files/service.ts` 893–965행 |
| worker 분리 | 실행마다 `fork`한 child process다. env는 `NODE_ENV`·`PATH`만 넘긴다(`HOME` 없음). 실행 단위 프로세스라서 **역할 간 확장 전역 상태 누출은 구조적으로 막힌다** | `channel.ts` 56–66행 |
| OMP는 별도 포크, `.omp` 독자 로더 | 맞다. 인용한 3개 파일이 지정 commit에 있다. MIT다 | `gh api` |
| DSH의 교체 지점·요청 기록 일치 | 맞다. Cordis 플러그인, `request/header`·`request/context`를 log한 뒤 freeze한다. MIT, 활발히 개발 중이다. 단 Studio가 지원하는 DSH는 RC·alpha뿐이다 | DSH `docs/architecture.md`, Studio README |

---

## 2. Pi SDK에서 찾은 통제 지점

모두 `@earendil-works/pi-coding-agent` 1.3.0의 **export된 API**다. "스파이크"는 소스로 경로를 확인했지만 실행 검증이 필요하다는 뜻이다.

| Corral이 지켜야 할 것 | Pi 1.3.0 공개 지점 | 판정 |
|---|---|---|
| **모든 모델 요청에 permit**. 세션·재시도·압축·캐시 warming·확장 중첩 호출을 모두 포함한다 | 다음 세 가지를 조합한다.<br>① `ModelRuntime.create({ authPath: <빈 임시 경로>, modelsPath: null, allowModelNetwork: false })`로 **실제 자격 증명이 없는** 런타임을 만든다.<br>② `registerProvider('corral', { streamSimple, models })`로 Corral provider를 등록한다. `streamSimple`이 host에 permit을 요청한 뒤, permit의 키로 실제 pi-ai stream을 호출한다.<br>③ 세션 모델을 `corral/<role-model>`로 둔다. | 가능. **S1**. `sdk.js` 253–273행에서 세션 요청이 `modelRuntime.streamSimple`을 쓰는 것을 확인했다. `cache-warmer.js` 239행도 같은 경로다. 확장은 `ctx.modelRegistry`로 같은 런타임을 쓴다 |
| 캐시 warming이 몰래 요청하지 않음 | `SettingsManager.inMemory({ cacheWarming: 'off', … })`(global 설정) | 가능. S1에 포함한다 |
| 재시도·압축 상한 | in-memory 설정의 `retry.*`·compaction. 매 시도가 permit을 받으므로 예산에 포함된다 | 가능. S1 |
| 최종 요청 기록 | 마지막에 로드된 Corral 확장의 `before_provider_request` 핸들러가 provider payload를 받는다. 본문 대신 hash·크기·구획을 기록한다. `before_agent_start`의 `systemPromptOptions.sections`로 어느 확장이 어떤 구획을 넣었는지도 남긴다 | 가능. **S1** |
| Reins 지시를 특정 요청에 고정(C-052 규칙 3) | 기존 방식(`prepareRequest`가 context 반환)은 `AgentSession`이 덮어써서 쓸 수 없다. 후보는 다음과 같다.<br>① host가 지시를 밀어 넣는다.<br>② Corral 확장이 `pi.sendMessage(custom, { deliverAs: 'steer' })`로 보낸다.<br>③ 지시 본문에 `directiveId` 표지를 둔다.<br>④ provider의 permit 요청이 그 요청 context에 든 directiveId 목록을 host에 보고한다. | 스파이크 **S3**. 실패하면 R1은 SDK 실행에서 지시를 "다음 Run"으로만 제공한다. 이것은 UI에 표시한다 |
| 도구 승인을 **최종 인자**로 | `tool_call` 이벤트다. 핸들러는 확장 로드 순서대로 돌고 `event.input`을 바꿀 수 있다. `extensionsOverride`로 Corral 확장을 **맨 뒤**에 둔다. 핸들러 예외는 차단이다(fail closed). 중첩 호출(`ctx.executeTool`, codemode)도 `parentToolCallId`를 달고 같은 hook을 지난다(`agent-session.js` 327–410행) | 가능. **S2** |
| 도구 집합 통제 | `createAgentSession({ noTools: 'builtin', tools: [...], customTools })`. 도구별 `exposure`·`annotations`(MCP 의미)·`reachesTools` | 가능 |
| 리소스 로딩 통제 | `DefaultResourceLoader`의 다음 옵션을 쓴다.<br>• `noExtensions` + `additionalExtensionPaths`(역할에 바인딩된 것만), `extensionsOverride`(순서)<br>• `noSkills` + `additionalSkillPaths`, `skillsOverride`<br>• `noContextFiles`, `agentsFilesOverride`<br>• `systemPromptOverride`·`appendSystemPrompt`<br>• `agentDir`·`cwd` 명시 | 가능. **S4**. 주의: `AGENTS.md`·`CLAUDE.md`는 project trust와 무관하게 로드되므로 `noContextFiles`가 필요하다 |
| 세션 저장 | `SessionManager.inMemory()`. Corral이 기록의 권위다 | 가능 |
| 취소·완료 | `session.abort()`, `agent_settled`(더는 자동 진행하지 않음), `session.dispose()` | 가능 |
| 확장 UI | `session.bindExtensions(...)`의 UI 컨텍스트. `select/confirm/input/notify/setStatus`만 연결한다. `custom()`·`onTerminalInput`·위젯은 비지원으로 표시한다(RPC 모드와 같은 범위) | 스파이크 **S7** |
| 확장 명령 | `pi.registerCommand`. `session.prompt('/name args')`는 명령을 처리한다. 실행 중 입력은 steer/followUp 선택이 필요하다 | 스파이크 **S7**. Corral의 다음 Run·지시와 의미가 다르므로 라우팅 계약이 필요하다 |
| 패키지 설치 | `DefaultPackageManager({ cwd, agentDir, settingsManager })`의 `install/resolve/update/remove` | 가능. 다만 npm lifecycle script를 끄는 옵션을 찾지 못했다(`npmCommand` 설정만 있다). **S6** |
| project trust | `project_trust` 이벤트(사용자·CLI 확장만 처리) | Corral이 `.pi/`를 아예 로드하지 않으므로(`noExtensions` 등) 쓰지 않는다. 프로젝트 리소스는 Corral 신뢰 절차로만 들인다 |

**공개 API로 막을 수 없는 것**(원안 §4.3을 확인한 결과):

- 네이티브 확장은 Pi 프로세스 권한으로 fs·network·process를 직접 쓴다. Pi 공식 security 문서도 "샌드박스 없음"이라고 명시한다.
- 확장이 `pi.registerProvider`로 **자기 키를 가진 provider**를 등록하면 Corral permit을 우회할 수 있다.
  - 대응: 로드 후 `modelRuntime.getRegisteredProviderIds()`에 `corral` 외의 provider가 있으면 **엄격 역할은 실행을 거절**한다. 일반 역할은 경고를 기록한다.
- 확장의 `appendEntry`·`sendMessage` 같은 내부 상태 변경은 Corral 사실이 아니다. 관찰 기록으로만 남긴다(C-052 규칙 1 유지).

---

## 3. 먼저 바꿔야 하는 기존 결정

| 문서 | 현재 문구 | 바꿀 내용 |
|---|---|---|
| `Corral-Spec-v0.1.md` 111행 | 범위 제외: "A2A/MCP 확장 로딩, 셸/코딩/파일 동시 수정" | "역할에 바인딩한 Pi 표준 스킬·확장(R1), 등록 검증 명령의 자동 실행(R2)"을 범위에 넣는다. MCP·코드 실행·동시 수정은 계속 제외한다(R3에서 별도 CR) |
| `docs/Decisions.md` ADR-005 | coding-agent 대신 agent-core, untrusted plugin·shell 없음 | **ADR-027이 부분 대체**한다. 대체 내용은 아래와 같다.<br>• coding-agent SDK를 worker 안에서 쓴다. 실행 방식은 역할별로 Run 시작 시 고정한다.<br>• 내장 shell·파일 도구는 끈다.<br>• 확장은 "신뢰한 네이티브 코드"로만 허용한다. |
| ADR-024 결과·제약 | 사용자 정의 hook·런타임 로딩·공개 플러그인 API를 만들지 않음 | Corral admission gate는 그대로 닫혀 있다. Pi 확장 hook은 **worker 안**에서 돌고, gate를 교체하지 못한다(원안 §4.2의 네 종류 구분) |
| `docs/Technical-Design.md` 233행 | coding-agent의 셸·파일 도구·확장 자동 로더 미사용 | 자동 로더는 계속 쓰지 않는다. 명시 경로·핀 고정 로더만 쓴다. 셸·파일 내장 도구도 계속 쓰지 않는다 |
| `docs/Dependencies-and-Sources.md` 27행 | coding-agent 제외 | coding-agent 1.3.0과 전이 의존(pi-mcp, pi-codemode, pi-tui, quickjs-wasi, photon-node, jiti 등)을 기록한다([§8](#8-의존성-기록)) |
| 보장 문구 | "모든 외부 효과는 Coordinator를 통과" | **관리 경로**(Corral 도구·모델 요청)와 **신뢰한 네이티브 확장**으로 나눈다. 후자는 "통제 보장 없음"을 화면과 문서에 표시한다 |

이 표가 CR-018 "Pi 표준 스킬·확장의 역할별 실행"의 본문이 된다. ADR 번호는 다음 순번인 ADR-027이다.

---

## 4. 목표 구조

```text
Workbench / CLI
 └ 역할 설정(definition 버전) ─ HarnessBinding(스킬·확장·정책 revision 참조)
     └ Run 시작: EffectiveHarnessSnapshot 고정(리소스 hash, Pi 버전, 정책 revision)
         └ Coordinator (permit · 도구 승인/실행 · 예산 · 취소 · Reins · 최종 상태)
             └ Pi worker 프로세스 (실행 1개 = 프로세스 1개, 지금과 같음)
                 ├ runtime = "pi-core"  (기존 worker.ts, 바뀌지 않음)
                 └ runtime = "pi-sdk"   (신규 sdk-worker.ts)
                     ├ ModelRuntime: 자격 증명 없음 + provider "corral" (permit → 실제 stream)
                     ├ ResourceLoader: 핀 고정 경로만, context file·자동 탐색 끔
                     ├ 사용자 확장들 (로드 순서대로)
                     └ Corral 확장 (맨 뒤): tool_call 승인, before_provider_request 기록,
                                          steer 지시, UI 브리지, 상태 보고
```

- 역할마다 `runtime`을 고른다.
  - 기본값은 지금 동작인 `pi-core`다.
  - 스킬이나 확장을 바인딩한 역할만 `pi-sdk`를 쓴다.
- 필수 확장의 로드가 실패하면 그 실행은 **실패**한다. `pi-core`로 조용히 내려가지 않는다(원안 §4.1).

---

## 5. 핵심 설계 결정

| ID | 결정 | 이유 |
|---|---|---|
| D1 | SDK는 기존 worker 프로세스 안에서만 쓴다. 서버 프로세스에 로드하지 않는다 | 확장 코드가 서버의 DB·세션 토큰 메모리에 닿지 않게 한다. 실행 단위 프로세스라서 역할 간 상태 누출이 막힌다 |
| D2 | 모델 요청은 Corral provider 하나로만 한다. Pi 런타임에는 실제 자격 증명을 넣지 않는다. 키는 permit마다 host가 준다(지금과 같음) | 압축·재시도·확장 중첩 호출까지 한 곳에서 permit과 예산을 건다 |
| D3 | Corral 확장은 항상 마지막으로 로드한다. 핸들러 예외는 차단으로 처리한다 | 최종 인자 승인과 최종 payload 기록 |
| D4 | Reins 지시는 Pi steer 메시지로 보낸다. directiveId 표지로 요청과 묶는다(S3) | `prepareRequest` 경로가 SDK에서 막혔다 |
| D5 | Pi 내장 도구(`read/bash/edit/write/grep/find/ls`)는 끈다. 대신 Corral broker 도구를 등록한다. R1에는 읽기 전용 `read`(worktree 상대경로와 스킬 번들 경로)를 넣는다. 쓰기 도구의 Pi 호환은 R2(H4)에서 한다 | 스킬 로드에 `read`가 필요하다. 파일 보호(hash 확인·직렬화·snapshot)는 broker에 남긴다 |
| D6 | 리소스 저장소는 Corral 데이터 디렉터리 아래 content-addressed 경로(`resources/sha256-…/`)다. Pi `agentDir`도 Corral 전용이다. `~/.pi/agent`는 사용자가 고를 때만 **복사 import**한다. 자동으로 수정하거나 링크하지 않는다 | 원안 §3.2와 같다. 실행 중에 바뀌지 않는 입력 |
| D7 | 설치 → 신뢰 → 역할 바인딩 → 실행을 분리한다. 신뢰는 resource hash 단위다. 내용이 바뀌면 신뢰가 풀린다 | 원안 §3.3 |
| D8 | 확장 실행 시 `HOME`·`XDG_CONFIG_HOME`·`CLAUDE_CONFIG_DIR`를 실행 전용 임시 디렉터리로 돌린다 | Ponytail처럼 홈 설정을 읽고 쓰는 확장이 사용자 실제 설정을 건드리지 않게 한다. **보안 경계는 아니다.** 화면에도 그렇게 쓴다 |
| D9 | 정책 강도: `strict` 역할에는 provider를 등록하는 확장, `annotations` 없는 확장 도구, 네이티브 확장을 붙일 수 없다. 저장할 때와 Run 시작 때 거절한다 | LLM 판단이나 UI 토글로 권한을 넓히지 않는다 |
| D10 | 실행 중 패키지·확장 교체는 하지 않는다. `/reload`는 비지원이다. 다음 Run부터 적용한다 | 원안 §5.3 |

---

## 6. 단계별 구현

크기는 상대값이다(S ≈ 1–2일, M ≈ 3–5일, L ≈ 1–2주. 리뷰 포함, 한 사람 기준 추정). 실제 기간은 H1 결과로 다시 잡는다.

### H0. 기준선 복구 (S, 선행 없음)

1. CR-016 시나리오를 카탈로그에 등록한다.
   - `contracts/requirements.json`: `CRL-REF-001`(구조화 참조 전달)과 `CRL-REF-002`(경로 검색·입력 메뉴).
   - `contracts/backlog.json`: CR-016 구현 태스크 `C-075`.
   - `tests/test-catalog.json`: TC-REF 9개(001·002·010·020–024 H). `status: planned`(검사기 규칙).
   - `tests/traceability.json`: 요구 → 테스트·태스크 연결.
2. 문서의 시나리오 ID와 카탈로그를 맞춘다. 태그를 지우거나 검사를 완화하지 않는다.
3. 전체 gate를 실행한다: `spec:check → contracts:check → lint → typecheck → test → build → E2E`.
   - PR #52·#53은 CI에서 `spec:check` 뒤 단계를 한 번도 돌지 않았다. **다른 실패가 나올 수 있다.**
   - 나오면 같은 PR에서 고친다.
4. (선택, 강화) `tc-tags.ts`가 `-F`·`-D` 접미사와 2자리 UX ID도 검사하게 넓힌다.
   - 걸리는 15개(TC-REF 5, TC-UX 10)를 등록한다. 2자리 UX ID는 3자리로 바꾼다.
   - 검사를 넓히는 변경이라 완화가 아니다.

완료 조건: main에서 PR gate가 끝까지 통과한다.

### H1. 계약과 스파이크 (M, H0 뒤, Go / No-go)

**문서**

- `docs/change-requests/CR-018-pi-standard-harness.md`
  - [§3](#3-먼저-바꿔야-하는-기존-결정)의 변경과 신뢰 모드(관리 경로·신뢰한 네이티브·OS 격리 미제공).
  - 비지원 목록과 반례.
- `docs/Decisions.md` ADR-027. ADR-005는 "부분 대체됨"으로 표시한다.
- `docs/spikes/HAR-pi-sdk-spikes.md`: 아래 스파이크 결과(실행 명령, 버전, 통과·실패 근거).
- 요구 `CRL-HAR-*`, 테스트 `TC-HAR-*`를 카탈로그·추적표에 `planned`로 먼저 등록한다([§7](#7-요구와-테스트-id)).

**의존성:** `@earendil-works/pi-*` 4개를 **1.3.0 정확 고정**으로 함께 올린다. 기능 변경 없는 별도 커밋으로 하고, 기존 테스트 전부 통과를 확인한다.

**스파이크**

모두 fake provider와 로컬 fixture로 한다. 모델 호출과 네트워크는 쓰지 않는다. 코드는 `packages/adapter-pi/spike/`에 두고 테스트로 남긴다.

| ID | 질문 | 통과 조건 | 실패 시 |
|---|---|---|---|
| S1 | Corral provider 하나로 모든 요청에 permit이 걸리는가 | 다음 다섯 경우 모두 **"dispatch 수 = permit 수"이고 permit 없는 dispatch가 0**이다.<br>① 일반 prompt<br>② 일시 오류 후 자동 재시도<br>③ 작은 contextWindow로 유도한 자동 압축<br>④ 확장의 `ctx.modelRegistry.streamSimple`(corral 모델)<br>⑤ 확장의 다른 provider 호출(자격 증명 없음 → 실패해야 함)<br>`cacheWarming: 'off'`에서 유휴 요청이 0이다. `before_provider_request` payload hash가 provider가 받은 값과 같다 | **No-go.** SDK 전환을 멈추고 상위 Pi에 요청 hook을 제안한다 |
| S2 | 최종 인자 승인과 중첩 호출 | 다음을 모두 만족한다.<br>• 확장 A가 `session_start`에서 등록한 `tool_call` 핸들러가 `input`을 바꾸면, Corral(맨 뒤)이 바뀐 값으로 승인한다.<br>• Corral 핸들러가 throw하면 도구가 실행되지 않는다.<br>• `ctx.executeTool` 중첩 호출도 승인을 거친다.<br>• 승인 뒤 인자가 바뀌지 않는다(execute 직전 hash 비교) | **No-go** |
| S3 | 지시를 특정 요청에 묶을 수 있는가 | steer 메시지가 다음 요청 하나에 들어가고 이후 요청에도 남는다. provider가 보고한 directiveId 집합이 host 기록과 같다. 도구 호출 중 도착한 지시는 그 도구 묶음 뒤에 들어간다 | R1에서 SDK 역할의 지시를 "다음 Run"으로 제한하고 UI에 표시한다 |
| S4 | 리소스 격리 | `HOME`을 함정 파일(`~/.pi/agent/extensions/x.ts`, `~/.agents/skills`, `AGENTS.md`)이 든 임시 디렉터리로 두고 실행한다. 바인딩한 리소스만 로드되고 함정은 하나도 로드되지 않는다. `.pi/settings.json`이 있는 cwd에서도 같다 | **No-go** |
| S5 | 스킬 전달 | 다음을 확인한다.<br>① 원본 Ponytail 스킬이 수정 없이 목록에 뜨고, Corral `read`로 `SKILL.md`와 상대경로 파일을 읽는다.<br>② "필수 적용" 스킬 본문이 system prompt 구획에 들어가고, 강제 압축 뒤에도 남는다.<br>③ 기록·export에 로컬 절대경로가 남지 않는다. 가상 경로를 쓰거나 기록에서 redaction한다. 둘 중 무엇을 쓸지 여기서 정한다 | 스킬 기능을 "필수 적용"만으로 축소한다 |
| S6 | 패키지 설치 | `DefaultPackageManager`로 npm·git·로컬 소스를 Corral `agentDir`에 핀 설치한다. lifecycle script를 끌 수 있는지(`npmCommand`에 `--ignore-scripts`) 본다. 설치 결과의 내용 hash가 재현된다 | 설치는 Corral이 직접 한다(`npm pack` 후 tarball 검증·압축 해제). 의존성 있는 패키지는 R1 비지원으로 표시한다 |
| S7 | 확장 명령·UI | Ponytail `/ponytail ultra`를 다음 두 시점에 실행해 본다: 실행 시작 전(초기 입력), 실행 중(steer). 각각 `before_agent_start` 구획 변화가 기록되는지 본다. `confirm/select/input/notify`가 host 요청 ID와 timeout을 달고 왕복하고, 취소 시 닫힌다 | 확장 명령은 R1에서 **실행 시작 옵션**(역할 바인딩의 초기 명령)으로만 지원한다 |
| S8 | 배포 | 다음 두 환경에서 확장 로드와 S1이 통과한다.<br>• Electron desktop의 동봉 Node 24.19 worker(`apps/desktop/staging`)<br>• `HOME` 없는 env<br>jiti 캐시 위치를 확인한다. 설치 크기 증가를 기록한다 | desktop은 R1에서 `pi-sdk` 역할을 끄고, 웹 Studio만 지원한다 |

**판정:** S1·S2·S4가 모두 통과해야 H2로 간다. 나머지 실패는 위 "실패 시" 범위 축소를 CR-018에 반영하고 진행한다.

### H2. 런타임 기반 (L, H1 Go)

**계약** (`packages/contracts`)

- `AgentRole`에 선택 필드 `harness?: HarnessBindingRef`(`{ profileId, revision }`)를 추가한다.
  - 필드가 없으면 지금과 같다. 기존 definition·hash가 바뀌지 않는다(골든 테스트로 확인).
- `ToolDescriptor { source: 'corral' | 'extension:<pkg>@<ver>', name, schemaHash, annotations, exposure, sideEffect: 'none' | 'workspace' | 'external' | 'unknown' }`.
  - `annotations`가 없으면 MCP 기본값(파괴적·open world)으로 보고 `unknown`으로 둔다.
- `EffectiveHarnessSnapshot`: 리소스 hash 목록, Pi 버전, 정책 revision, 도구 descriptor 목록, 로드 진단.
  - `run.started` 또는 execution 시작 이벤트에 **hash와 참조만** 넣는다.
- 이벤트: `harness.loaded`, `harness.load_failed`, `model.request_recorded`(payload hash·크기·구획 출처), `extension.ui_requested/answered/expired`.
  - 기존 이벤트 이름과 의미는 바꾸지 않는다.

**worker 프로토콜 v2** (`packages/adapter-pi/src/protocol.ts`)

- `PROTOCOL_VERSION = 2`. host는 v1·v2를 둘 다 받고, 실행 시작 때 runtime으로 고른다.
- 추가 프레임
  - worker → host: `harness_report`(로드 결과·도구 descriptor), `request_record`, `ui_request`
  - host → worker: `directive`(S3), `ui_answer`
- `prepare_request`에 `purpose: 'turn' | 'compaction' | 'retry' | 'extension'`과 `directiveIds`를 추가한다.

**worker** (`packages/adapter-pi/src/sdk-worker.ts`, 신규)

- `createAgentSession`에 다음을 넣는다.
  - in-memory 설정·세션
  - 자격 증명 없는 ModelRuntime + `corral` provider(D2)
  - 고정 ResourceLoader(D6)
  - `noTools: 'builtin'`
  - Corral 도구들(기존 `TOOL_TEXT`·`parametersOf`를 공유 모듈로 뺀다)
  - Corral 확장(D3)
- 완료 판정: `agent_settled` 뒤 마지막 assistant `stopReason`으로 정한다. 기존 worker와 같은 함수로 한다.
- 취소: `cancel` 프레임 → `session.abort()` → `settled(cancelled)`.

**Coordinator** (`packages/core`)

- `tool.authorize` gate가 descriptor를 본다.
  - 역할 허용 목록 + 바인딩 확장 도구 + `sideEffect` 정책.
  - `policyVersion`은 `role-allowlist@2`다. 기존 역할은 `@1` 그대로다. 골든 이벤트를 바이트 단위로 유지한다.
- 확장 도구 실행은 worker 안에서 일어난다.
  - host는 `authorize`만 하고 `tool.started/completed`는 worker 보고로 기록한다.
  - 기록에는 "관리되지 않은 실행" 표시를 붙인다.
- `purpose`별 permit은 모두 부모 Run 예산에 넣는다.

**테스트**: `TC-HAR-001`…`006` H/N. permit 누락 없음, 최종 인자, 중첩, 예외 차단, 필수 확장 실패 → 실행 실패(fallback 없음), 늦은 프레임 무시. 모두 fake provider로 한다.

**완료 조건**

- `pi-core` 역할의 기존 단위·통합·E2E가 전부 그대로 통과한다.
- `pi-sdk` 역할이 fixture 확장 하나로 시작·도구·취소·완료를 끝낸다.

### H3. 리소스·역할·화면 (L, H2) → R1

**서버** (`apps/server/src/harness/`, 신규 모듈)

- 리소스 저장소: 다음 상태를 갖는다.

  ```text
  발견 → 설치 검토(manifest·파일 목록·hash 표시, 코드는 실행하지 않음)
       → 설치(S6 방식) → 신뢰(hash 단위) → 사용
  ```

- `HarnessProfileRevision`은 SQLite에 저장하고 불변이다.
  - 내용: 스킬 목록(자동 / 명시 / 필수), 확장 목록(필수 / 선택), 정책 강도(D9), 초기 명령(S7 결과에 따름).
  - `packages/storage-sqlite`에 migration을 추가한다.
- 상속은 개인 기본값 → 프로젝트 → 역할 → 실행 순서다.
  - 보안 항목(정책 강도, 허용 도구)은 **더 엄격한 쪽만** 상속한다.
  - 하위가 상위의 필수 정책을 풀 수 없다(원안 §5.3).
- 미리보기 API: Run과 **같은 해석 함수**로 다음을 만든다. 확장 코드는 실행하지 않는다.
  - 정적 결과: 스킬 목록, system prompt 정적 구획, 도구 descriptor.
  - 확장이 런타임에 바꾸는 부분은 "실행 시 결정"으로 표시한다(DSH Studio의 미리보기 아이디어).

**스킬**

- 읽기 전용 `read` 도구: worktree 상대경로 + 바인딩 스킬 번들 경로. broker 경유이며 hash를 기록한다.
- 필수 적용은 `before_agent_start` 구획으로 본문을 넣는다. 본문이 없거나 크기를 넘으면 시작을 거절한다.
- 스킬 스크립트는 "R1 비지원(실행 도구 없음)"으로 표시한다.

**화면** (`apps/studio`, `packages/react`)

- Inspector: 역할의 "작업 방식" 구획.
  - 스킬·확장 선택, 출처·버전·신뢰 상태, 상속 출처, 정책 강도.
  - "신뢰한 네이티브 코드" 경고.
- 프로젝트 설정: 패키지 설치·업데이트·신뢰, `~/.pi/agent` 복사 import(선택).
- Run 상세: 다음을 보여 준다.
  - 실제 적용 snapshot
  - 요청별 기록(구획 출처, payload hash)
  - 확장 도구 호출(관리되지 않은 실행 표시)
  - 확장 UI 요청 이력
- 명령 레지스트리: 확장 명령을 `source: 'extension'`, 대상 역할, 실행 조건과 함께 넣는다.
  - 앱 명령과 이름이 겹치면 `/<pkg>:<name>`으로 구분한다.
  - 대상 execution이 끝났으면 막는다(UX-01 원칙). 다른 대상으로 바꾸지 않는다.
- 확장 UI 요청은 확인 필요 목록(Inbox)에 다음을 달고 뜬다: 요청 ID, execution, timeout. 취소되거나 시간이 지나면 닫힌다.

**완료 조건 (R1)**

- 원본 Ponytail 패키지를 설치·신뢰하고 **역할 A에만** 바인딩한다.
- Run 기록에서 A의 요청에만 ponytail 구획이 있고, B에는 없다.
- 모든 요청에 permit이 있고, `HOME` 밖 설정 파일에 쓰기가 없다(D8 확인).
- 이 흐름의 E2E 1개와 desktop smoke를 통과한다.

### H4. 코딩 도구 (M–L, H2·H3) — R2

- Pi `read/edit/write` 계약을 broker 위에 맞춘다.
  - 입력·출력·상대경로·오류·부분 수정 의미를 Pi 1.3.0 `createEditTool` 동작과 비교하는 계약 테스트로 맞춘다.
  - 이름만 바꾸지 않는다.
- read 근거를 Run 단위에서 **execution 단위**로 바꾼다.
  - 먼저 반례: 에이전트 A가 읽은 뒤 B가 쓰고, A가 쓰면 거절돼야 한다.
- 범위 조회: `offset/limit`, truncation 표시, 원본 참조 반환.
- LSP 읽기(diagnostics, definition, references)
  - 서버 프로세스 수명은 Coordinator 효과로 관리한다.
  - 라이브러리 선정과 기록은 이 단계 CR에서 한다.
- Hashline: `corral eval` 비교 항목으로만 넣는다(pi edit, 현재 전체 쓰기와 비교). 기본 도구로 넣지 않는다.

### H5. 자동 검증 (M, H2) — R2

- `VerificationRunner` 포트를 뽑아낸다. 수동 실행과 자동 실행이 같은 구현을 쓴다.
- 다음을 보강한다.
  - Run·execution·attempt 소유권과 effect ID.
  - 취소: process group으로 띄워(`detached`) `kill(-pid)`한다. 늦은 결과 fence를 둔다.
  - 시계 주입(`Date.now()` 제거).
  - 검증 전용 복사본: 시작 tree의 별도 worktree에서 실행한다.
  - fingerprint: 명령 정의 revision, `package.json` scripts hash, lockfile hash, Node 버전.
  - 출력 크기 상한·redaction·보존 기간.
- 모델 도구 `run_check({ commandId })`: 등록된 ID만 받는다. argv·env는 모델이 바꿀 수 없다.
  - fingerprint가 사전 허가와 다르면 Inbox 승인을 거친다.
- `VerificationReport`: 대상 tree 또는 artifactVersionId, 실행 상태(`queued/running/completed/error/cancelled`), 판정(`pass/fail/inconclusive/not_evaluated`)을 **별도 필드**로 둔다.
  - stale(대상 tree ≠ 현재)이면 완료 근거가 될 수 없다.

### H6. 검토와 제한된 개선 (L, H3·H5) — R2

- 기존 `Agent → Review → Decision → Loop`를 쓴다. 새 workflow 엔진은 만들지 않는다.
- `ReviewRecipeRevision`: 기준·평가 역할·결정적 검사 목록·최대 시도(첫 시도 포함)·수정 횟수·시간·토큰 상한.
  - 기준 파일은 hash로 고정한다. 모델이 바꾸면 무효다.
- 멈춤 조건: 같은 출력 반복, 같은 검사 실패에서 진전 없음, 예산 소진. 이유는 Inbox에 남긴다.
- `corral eval` 품질 비교. 대조군은 다음 다섯이다.
  - 기본
  - 필수 스킬
  - 결정적 검사
  - 검토·수정
  - 선택한 H4 도구
- 측정 항목: 정답률, 잘못된 통과, 불필요한 반려, 재시도, 사용량, 사람 개입. 개선은 측정 뒤에만 주장한다.

### H7–H8. R3 (각각 별도 CR)

- **H7 항목별 반복**(Pixie 아이디어): 항목 컨텍스트 분리, 부모 예산·취소, 중첩 Loop 금지·위임 깊이를 넘지 않는 fan-out 의미.
  - 같은 worktree 동시 수정은 제외한다.
- **H8 MCP·codemode**: Pi 내장 확장(`createMcpExtension`, `createCodemodeExtension`)을 `extensionFactories`로 켠다.
  - 중첩 호출은 H2의 `tool_call` 승인을 그대로 지난다.
  - codemode worker 상한(전 세션 2개)을 Corral 동시성 상한과 맞춘다.
  - MCP 서버 프로세스와 OAuth는 신뢰 대상으로 다룬다.
- **H8 LSP 쓰기**: rename·code action의 workspace edit를 broker 제안으로 바꾼다. 부분 실패 의미를 정한다.

---

## 7. 요구와 테스트 ID

카탈로그 규칙을 따른다. 3자리 번호에 `-H`(정상)·`-N`(반례)이다. 실패·중복은 반례 쪽으로 쓴다.

| 요구 | 내용 | 테스트 | 단계 |
|---|---|---|---|
| CRL-REF-001/002 | CR-016 참조·검색(기존 구현의 사후 등록) | TC-REF-001/002/010/020–024-H | H0 |
| CRL-HAR-001 | SDK 실행의 모든 모델 요청은 permit을 받고 부모 예산에 들어간다 | TC-HAR-001-H/N(재시도·압축·확장 중첩 포함, permit 없는 dispatch는 실패) | H2 |
| CRL-HAR-002 | 도구는 최종 인자로 승인한다. 중첩·확장 도구도 같다 | TC-HAR-002-H/N(승인 뒤 인자 변경, 핸들러 예외, unknown 도구) | H2 |
| CRL-HAR-003 | 실제 요청 기록이 미리보기와 같은 해석에서 나오고 본문 대신 hash를 남긴다 | TC-HAR-003-H/N(미리보기와 다른 구획은 출처 표시, 경로·키 노출 없음) | H2–H3 |
| CRL-HAR-004 | 리소스 설치·신뢰·바인딩·실행을 분리하고 핀 고정한다 | TC-HAR-004-H/N(내용 변경 → 신뢰 해제, 미신뢰 리소스 실행 거절, 함정 HOME 미로드) | H3 |
| CRL-HAR-005 | 역할별 스킬·확장 적용과 필수 스킬 전달 | TC-HAR-005-H/N(역할 B 누출 없음, 압축 뒤 필수 본문 유지, 필수 본문 누락 → 시작 거절) | H3 |
| CRL-HAR-006 | 필수 확장 실패 시 fallback 없이 실패 | TC-HAR-006-H/N | H2 |
| CRL-HAR-007 | 확장 UI·명령은 대상·요청 ID·timeout을 가지고, 대상이 끝나면 막힌다 | TC-HAR-007-H/N | H3 |
| CRL-HAR-008 | 엄격 역할에 provider 등록·네이티브 확장 결합을 거절 | TC-HAR-008-H/N | H3 |
| CRL-HAR-010–014 | 편집 계약, execution 단위 read 근거, 자동 검증 소유권·취소·stale, 보고서 상태/판정 분리, 제한된 개선 루프 | TC-HAR-010–014-H/N | H4–H6 |

각 단계는 테스트를 먼저 커밋하고 실패를 확인한 뒤 구현한다.

---

## 8. 의존성 기록

H1에서 `docs/Dependencies-and-Sources.md`·`docs/dependency-lock.json`에 넣는다. 아래는 2026-10-17 `npm view` 확인값이다.

| 패키지 | 버전 | 라이선스 | 비고 |
|---|---|---|---|
| @earendil-works/pi-coding-agent | 1.3.0 (2026-10-15) | MIT | Node ≥22.19.0. 1.2.0은 내부 의존을 caret으로 선언해서 쓰지 않는다 |
| @earendil-works/pi-agent-core, pi-ai | 1.3.0 | MIT | 4개를 같은 버전으로 고정한다 |
| @earendil-works/pi-tui | 1.3.0 | MIT | 2.4 MB. 터미널 UI. Corral은 렌더링하지 않는다 |
| @earendil-works/pi-mcp, pi-codemode | 1.3.0 | MIT | R1에서는 로드하지 않는다(SDK 기본값) |
| @earendil-works/pi-telemetry | 1.3.0 | MIT | pi-ai 의존. 외부 전송이 없는지 S1에서 네트워크 차단으로 확인한다 |
| jiti | 2.7.0 | MIT | TS 확장 로더 |
| quickjs-wasi | 3.6.2 | MIT | codemode용 |
| @silvia-odwyer/photon-node | 0.3.4 | Apache-2.0 | 이미지 처리. NOTICE 확인 |
| grok-mermaid | 0.2.3 | Apache-2.0 | NOTICE 확인 |

- 나머지 전이 의존(openai, @anthropic-ai/sdk, @google/genai, AWS SDK 등)은 pi-ai 1.2.0에도 이미 있다. 버전만 바뀐다.
- 설치 크기 증가와 desktop 패키지 영향은 S8에서 측정한다.

---

## 9. 위험과 미확인

| 위험 | 대응 |
|---|---|
| Pi가 1–2주 간격으로 바뀐다(1.2.0 → 1.3.0이 3일, breaking 포함) | 정확 고정. 업그레이드는 별도 PR로 하고 S1·S2·S4 회귀 테스트를 상시 실행한다 |
| `extensionsOverride`로 순서를 바꾸는 것이 문서화된 보장인지 불확실 | S2에서 확인한다. 아니면 상위에 "host 확장 마지막" 옵션을 제안한다 |
| 네이티브 확장의 직접 효과 | 통제를 약속하지 않는다. 신뢰 표시, D8 홈 격리, D9 엄격 역할 거절. OS 격리는 별도 CR |
| 확장이 응답·도구 결과를 바꿔 기록과 다름 | `message_end`·`tool_result` 변경은 worker 보고에 "확장이 변경" 표시를 남긴다. Corral 사실은 host 승인·실행 기록이다 |
| 스킬 절대경로가 provider에 전송됨 | S5에서 가상 경로나 기록 redaction을 고른다. 경로는 provider 요청에는 들어갈 수 있다. 로그·export에는 남기지 않는다(AGENTS 7) |
| 로컬에 `jsonschema`가 없어 `spec:check`가 불완전 | `pip install -r tools/requirements.txt`를 개발 안내에 명시한다(H0) |
| DSH·DSH Studio·OMP의 품질 수치 | 인용하지 않는다. Corral eval로만 판단한다 |

**미확인:**

- 모든 판정은 소스와 문서를 읽은 것이다. 실행은 H1 스파이크가 처음이다.
- `before_provider_request`가 재시도마다 다시 불리는지 확인하지 않았다(S1).
- 확장 명령을 실행 중에 부를 때의 의미를 확인하지 않았다(S7).
- npm lifecycle script를 끌 수 있는지 확인하지 않았다(S6).

---

## 10. 진행 방식

- 단계마다 브랜치 하나를 쓴다. 커밋은 중간중간 하고, PR은 묶음이 끝날 때 하나만 낸다.
  - H0은 main CI가 빨간 상태라 **단독 PR**로 먼저 낸다.
  - H1은 문서·스파이크 PR이다. Bell이 Go / No-go를 승인한다.
  - H2–H3은 R1 PR 하나다.
- E2E는 H3 완료(R1)와 H6 완료(R2)에서만 전체로 돌린다. 중간에는 바뀐 흐름만 돌린다.
- SDK가 들어가는 PR은 desktop smoke를 포함한다.
- live 모델 검증은 R1 끝에 한 번, 사용자 opt-in과 비용 상한을 두고 한다(`pnpm corral dev`의 OAuth).
