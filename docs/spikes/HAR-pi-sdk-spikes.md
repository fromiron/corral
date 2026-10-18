# H1 스파이크: Pi coding-agent SDK 경계 확인

- 작성: Claude / 2026-10-17. 기준 브랜치는 `feat/harness-h1`(main `f17338f` 뒤)이다.
- 관련 문서: [CR-018](../change-requests/CR-018-pi-standard-harness.md), ADR-027(제안), [구현 플랜 §6 H1](../plans/Personal-Harness-Implementation-Plan.md).
- 대상 버전: `@earendil-works/pi-coding-agent`·`pi-agent-core`·`pi-ai` **1.3.0**(정확 고정). `pi-coding-agent`는 `packages/adapter-pi`의 devDependency이고, 제품 실행 경로에는 아직 없다.
- 실행 환경
  - fake provider: pi-ai `createFauxCore`
  - 모델 호출: 0회
  - 네트워크: S6만 사용(npm registry, opt-in)
  - Node: 24.14.0(vitest)과 24.19.0(desktop 동봉 버전, S8)
- 코드: `packages/adapter-pi/test/spike/`
  - `sdk-session.ts`는 ADR-027이 제안하는 구성 그대로의 세션 harness다.
  - 각 `*.test.ts`가 스파이크 하나다.

## 결론

| 스파이크 | 결과 | Go 조건 |
|---|---|---|
| S1 모든 요청에 permit | **통과** | 필수 |
| S2 최종 인자로 도구 승인 | **통과** | 필수 |
| S3 지시를 요청에 묶기 | **통과** | |
| S4 리소스 격리 | **통과**. 단 원래 설계로는 실패했고, 보강해서 통과했다(아래 F1) | 필수 |
| S5 스킬 전달 | **통과**. `/skill:` 확장은 Corral이 직접 해야 한다(F4) | |
| S6 패키지 설치 | **통과**(opt-in, 네트워크) | |
| S7 확장 명령·대화상자 | **부분 통과**. 실행 중 명령은 Pi가 거절한다(F5) | |
| S8 worker 환경 | **통과**. jiti 캐시 위치를 옮겨야 한다(F6) | |

S1·S2·S4가 통과했으므로 **플랜상 Go 조건을 충족한다.** Go 여부는 Bell이 정한다. 승인되면 다음을 한다.

- ADR-027을 "채택"으로 바꾼다.
- CR-018의 "문서 변경"을 반영한다.

## 실행 방법

```bash
pnpm vitest run --project adapter-pi test/spike
```

S6(npm registry 사용):

```bash
CORRAL_SPIKE_NETWORK=1 pnpm vitest run --project adapter-pi test/spike/packages.test.ts
```

S8을 desktop Node로:

```bash
CORRAL_SPIKE_NODE=~/.local/share/fnm/node-versions/v24.19.0/installation/bin/node pnpm vitest run --project adapter-pi test/spike/worker-env.test.ts
```

## 스파이크별 결과

### S1. 모든 모델 요청에 permit (`permit.test.ts`)

구성은 다음과 같다.

- `ModelRuntime.create({ authPath: 빈 임시 파일, modelsPath: null, allowModelNetwork: false })`
- `registerProvider('corral', { api, baseUrl, apiKey: 자리표시자, models, streamSimple })`
- `streamSimple`이 permit을 받은 뒤 실제 stream을 부른다.

| 경우 | 결과 |
|---|---|
| 일반 prompt | permit 1, dispatch 1 |
| 일시 오류("The service is temporarily unavailable") 뒤 자동 재시도 | 시도마다 permit을 받는다 |
| 수동 압축(`session.compact()`) | 요약 호출 **2번**(대화 요약과 잘린 턴 앞부분 요약). 둘 다 permit을 받는다 |
| 확장 도구의 `ctx.modelRegistry.streamSimple(corral 모델)` | permit을 받는다 |
| 확장이 다른 provider(openai) 모델을 부름 | 자격 증명이 없어 실패한다. `fetch` 호출 0회. `getApiKeyForProvider('openai')`는 `undefined` |
| permit 거절 | 모델에 닿지 않고, 응답 큐가 그대로 남는다 |

추가로 확인한 것:

- 요청 기록은 **provider가 받은 context**로 만든다.
  - `before_provider_request`는 HTTP provider가 payload를 만들 때만 불린다. faux에서는 0회였다.
  - Pi 1.3.0은 system prompt를 `role: 'system'` 메시지와 이름 붙은 `sections`로 보낸다. `context.systemPrompt`에는 없다.
  - 확장이 `before_agent_start`에서 넣은 구획이 provider가 받는 요청에 보인다(TC-HAR-003-H).
- 확장에 주어지는 `ctx.modelRegistry`에는 `getApiKeyForProvider`가 있다.
  - **Pi 런타임에 실제 키를 두면 확장이 읽을 수 있다.**
  - 자리표시자 키만 두는 D2 결정이 필요하다는 것을 확인했다.

### S2. 최종 인자로 도구 승인 (`tools.test.ts`)

- 다른 확장이 `session_start`에서 등록한 `tool_call` 핸들러가 인자를 바꾸면, 마지막에 로드된 Corral 핸들러가 **바뀐 인자**로 승인한다. 도구는 그 인자로 실행된다.
- `ctx.executeTool`로 한 중첩 호출도 `parentToolCallId`를 달고 같은 승인을 거친다.
- 거절과 Corral 핸들러 예외(host 연결 실패를 흉내 냄)는 모두 실행을 막는다(fail closed).
  - 중첩 호출의 거절은 부르는 도구에 오류 결과로 돌아간다. 그 도구가 무엇을 보고할지는 확장의 선택이지만, 거절된 호출은 실행되지 않는다.
- `noTools: 'builtin'`이면 확장 도구만 선언되고 Pi 내장 도구는 없다.
- **주의**: `tool_execution_start` 이벤트의 `args`는 **hook 이전 값**이다. 실행 기록의 인자는 Corral 승인에서 가져와야 한다.

### S3. 지시를 steer로 (`directives.test.ts`)

- Corral 확장이 도구 실행 중에 `pi.sendMessage({ customType: 'corral.directive', … }, { deliverAs: 'steer' })`로 지시를 보낸다.
- 그 도구 묶음 다음 요청부터 지시가 들어가고, 이후 요청에도 남는다.
- 지시 본문의 `[directive dir_N]` 표지로 provider가 요청마다 포함된 directiveId를 알 수 있다.
- 제품에서는 host가 같은 지시를 한 번만 보낸다. 중복 전송 방지는 H2의 host 쪽 일이다.

### S4. 리소스 격리 (`resources.test.ts`)

함정 HOME과 함정 작업 폴더를 만들었다.

- HOME: `~/.pi/agent/extensions`, `~/.pi/agent/skills`, `~/.pi/agent/AGENTS.md`, `~/.agents/skills`
- 작업 폴더: `.pi/settings.json`, `.pi/extensions`, `.pi/skills`, `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, `.agents/skills`, `AGENTS.md`, `CLAUDE.md`

결과:

- **F1(발견)**: `noExtensions`·`noSkills`·`noContextFiles`·`noPromptTemplates`·`noThemes`를 모두 켜도 프로젝트 `.pi/SYSTEM.md`·`.pi/APPEND_SYSTEM.md`가 요청에 들어갔다.
  - SDK 경로에서는 project trust 판정이 일어나지 않았다.
  - `systemPromptOverride`와 `appendSystemPromptOverride`를 Corral 값으로 고정하자 막혔다. 이 두 옵션을 ADR-027 구성에 추가한다.
- 보강한 뒤에는 바인딩한 확장·스킬만 로드됐다. Corral 확장이 마지막이고, 함정 코드는 실행되지 않았다. `agentsFiles`는 비어 있고, 요청에 함정 문구가 없다.

### S5. 스킬 (`skills.test.ts`)

- **F3**: Pi는 `read`나 `bash`가 선언돼 있을 때만 스킬을 나열한다. 스킬만 바인딩하면 **조용히 나열되지 않는다**(테스트로 고정).
- `skillsOverride`로 `filePath`를 `skills/<name>/SKILL.md` 가상 경로로 바꾸고 Corral `read`가 이 경로를 바인딩 폴더에서 읽게 했다.
  - 결과: 목록의 `<location>`이 가상 경로였고, 모델이 `SKILL.md`와 `references/`를 읽었다. 요청에 로컬 절대경로가 없었다.
- **F2**: Pi는 `cwd` 구획에 작업 폴더 절대경로를 늘 넣는다. Corral 확장이 `before_agent_start`에서 `sections.cwd`를 바꿔 지웠다. H2 구성에 포함한다.
- 필수 스킬은 `before_agent_start`의 구획으로 넣었다. 압축 전후의 모든 턴 요청에 있었다(요약 호출에는 없다. 요약은 Pi 자체 prompt를 쓴다).
- **F4**: 가상 경로에서는 Pi의 `/skill:name` 확장이 파일을 못 읽어 원문 그대로 지나간다. 명시적 호출은 Corral이 직접 펼친다(H3).

### S6. 패키지 설치 (`packages.test.ts`, opt-in)

- 설정: `DefaultPackageManager({ cwd, agentDir: Corral 전용, settingsManager: inMemory({ npmCommand: ['npm', '--ignore-scripts'] }) })`.
- `postinstall`이 표지 파일을 쓰는 로컬 패키지는 설치됐다. 표지는 생기지 않았다.
  - 대조: 같은 tarball을 기본 `npm install`로 설치하면 표지가 생긴다. 수동으로 확인했다.
- 원본 Ponytail(`npm:@dietrichgebert/ponytail@5.3.2`)을 두 agent 폴더에 설치했다. 파일 트리 hash가 같았다(재현됨).
- 설치한 Ponytail을 바인딩한 세션에서 `/ponytail ultra` 뒤의 요청에 ponytail 구획이 들어갔다.
- `XDG_CONFIG_HOME`·`CLAUDE_CONFIG_DIR`를 실행 전용 폴더로 돌렸다. 실제 `~/.config/ponytail`의 존재 여부는 실행 전과 같았다(D8).
  - 단 `os.homedir()`는 그대로다. 이 격리는 **보안 경계가 아니다.**

### S7. 확장 명령과 대화상자 (`commands-ui.test.ts`)

- 실행 전 `session.prompt('/mode ultra')`는 모델 호출 없이 처리된다. 이후 요청에 구획이 반영됐다.
- **F5**: 실행 중 `session.steer('/mode off')`는 Pi가 거절한다: "Extension command … cannot be queued".
  - 그래서 R1의 확장 명령은 **실행 시작 옵션**(역할 바인딩의 초기 명령, 또는 Run 시작 전 입력)으로만 지원한다. 플랜 S7의 실패 시 범위대로다.
- `bindExtensions({ uiContext })`로 넘긴 host UI에 `confirm`이 제목과 `timeout`(30000)과 함께 도착했다. host 답(false)이 도구로 돌아갔다.
  - `signal`로 취소하는 경로는 H3에서 시험한다.

### S8. worker 환경 (`worker-env.test.ts`)

- `channel.ts`와 같은 환경(`NODE_ENV`·`PATH`만, `HOME` 없음)의 child process에서 세션을 만들었다.
  - TS 확장(jiti 로드)이 오류 없이 로드됐다. 구획이 요청에 들어갔고, permit은 1이었다.
  - Node 24.14.0과 desktop 동봉 24.19.0 모두 통과했다.
- **F6**: jiti는 컴파일 캐시를 `/tmp/jiti`(공유 tmp, 먼저 만든 사용자가 소유)에 쓴다. 다중 사용자 시스템에서 남이 만든 캐시를 읽을 수 있다. worker env에 `JITI_FS_CACHE`를 Corral 전용 폴더로 지정한다(H2).
- 설치 크기(압축 해제 기준)
  - `pi-coding-agent` 26 MB
  - jiti 1.8 MB, quickjs-wasi 1.6 MB, photon 2.2 MB, highlight.js 2.3 MB, grok-mermaid 0.6 MB
  - pi-tui·pi-mcp·pi-codemode 포함
- desktop AppImage에 실제로 넣어 보는 smoke는 SDK가 제품 의존성이 되는 H2에서 한다.

## 플랜·ADR에 반영할 발견

| ID | 발견 | 반영 |
|---|---|---|
| F1 | SDK 경로는 project trust를 적용하지 않는다. `.pi/SYSTEM.md`·`APPEND_SYSTEM.md`가 로드된다 | ADR-027 구성에 `systemPromptOverride`·`appendSystemPromptOverride`를 추가한다. S4 회귀 테스트를 유지한다 |
| F2 | `cwd` 구획에 절대경로가 들어간다 | Corral 확장이 `sections.cwd`를 바꾼다(H2) |
| F3 | `read`·`bash`가 없으면 스킬이 나열되지 않는다 | R1 `read` 도구(플랜 D5) 확인 |
| F4 | 가상 경로에서 `/skill:` 확장이 안 된다 | 명시적 호출은 Corral이 펼친다(H3) |
| F5 | 실행 중 확장 명령은 Pi가 거절한다 | 확장 명령은 실행 시작 옵션으로만 지원한다(H3, CR-018에 명시) |
| F6 | jiti 캐시가 공유 `/tmp/jiti`에 있다 | `JITI_FS_CACHE`를 Corral 전용 폴더로 지정한다(H2) |
| F7 | `tool_execution_start.args`는 hook 이전 값이다 | 실행 인자 기록은 승인값으로 한다(H2) |
| F8 | `before_provider_request`는 HTTP provider에서만 불린다 | 요청 기록은 Corral provider가 받은 context로 한다(H2) |
| F9 | 확장의 `ctx.modelRegistry.getApiKeyForProvider`로 키를 읽을 수 있다 | Pi 런타임에는 자리표시자 키만 둔다(D2 유지) |

## 확인하지 못한 것

- 실제 HTTP provider에서의 `before_provider_request` payload와 재시도 시 재호출. 모델 호출이 없었다. fake HTTP 서버로 H2에서 확인한다.
- 캐시 warming이 꺼진 상태에서 유휴 요청이 0인지. faux 모델에는 prompt cache가 없어 warming 대상이 아니다.
- 자동 압축(임계값 도달)에 의한 압축. 수동 `compact()`만 확인했다. 같은 요약 함수를 쓴다는 것은 소스에서만 확인했다.
- 대화상자 `signal` 취소, `select`·`input`.
- Electron AppImage 안에서의 로드. 동봉 Node 바이너리로만 확인했다.
- Windows·macOS. Linux x64만 확인했다.
