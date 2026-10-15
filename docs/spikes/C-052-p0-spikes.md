# C-052 P0 기술 스파이크 결과

- 실행일: 2026-10-15 · 태스크: C-052 · 요구: CRL-DX-002, CRL-DEV-004
- 환경: Node v24.14.0, pnpm 10.30.3, Linux 7.2.9 x64, AMD Ryzen 5 5600X (12 threads), RAM 31 GiB
- 대상 버전: `@earendil-works/pi-agent-core` 1.2.0, `@earendil-works/pi-ai` 1.2.0, `@langchain/langgraph` 1.5.0 (+ `@langchain/core` 1.2.17), `better-sqlite3` 13.0.3
- 재현: `spikes/p0/src/*.mjs`(Node), `spikes/p0/src/*.browser.test.mjs`(`pnpm --filter @corral/spike-p0 exec vitest run`). 제품 빌드와 CI에는 포함되지 않는다.
- 모든 Pi 검사는 pi-ai의 faux provider로 했다. **실제 provider 호출과 OAuth 로그인은 실행하지 않았다**(§6).

## 1. 판정표

| 항목 | 판정 | 근거 | 결과로 정한 것 |
|---|---|---|---|
| Pi 도구 훅 순서 | **주의 (설계대로 대응)** | `tool_execution_start`가 `beforeToolCall`보다 **먼저** 온다. 차단된 도구도 start 이벤트를 받는다. 차단된 도구의 `execute`는 실행되지 않고, end 이벤트는 `isError=true`, `durationMs` 없음 | §2 규칙 1–2 |
| Pi 요청 준비 | **통과** | `prepareRequest`가 매 provider 요청 직전에 호출되고, 반환한 context가 그 요청에만 처음 보인다(요청1 false, 요청2 true) | §2 규칙 3 |
| Pi steering | **통과 (사용 안 함)** | `agent.steer()`를 요청1 도중 호출하면 요청2에만 보인다. 하지만 Pi 내부 큐가 상태 원본이 되므로 쓰지 않는다 | §2 규칙 3 |
| Pi 자격 증명 | **통과** | `getApiKey(provider)`가 요청마다 호출된다. `CredentialStore`는 앱이 구현하는 인터페이스이고, refresh는 `modify` 안에서 직렬화된다 | §2 규칙 4, ADR-019 |
| Pi abort·usage | **부분 확인** | abort 후 마지막 메시지 `stopReason="aborted"`, `errorMessage` 존재. faux는 usage를 채우지만 실제 provider의 중단 시 usage는 미확인 | 실제 값은 C-020 live smoke로 확인. 그전까지 중단 요청의 usage는 `unknown` |
| Pi 텔레메트리 | **통과** | `@earendil-works/pi-telemetry`는 계약과 no-op/in-memory 구현만 있다. exporter와 네트워크 호출 코드가 없다 | 별도 차단 불필요 |
| OpenAI OAuth 경로 | **코드 확인, 실제 로그인 미실행** | pi-ai의 `openaiChatGPTOAuth`는 공식 Sign in with ChatGPT public-client 흐름(PKCE, 동적 client 등록, `chatgpt.tokens.use.direct` scope, `api.openai.com`)이다. Codex CLI 토큰 재사용이 아니다 | CR-001 그대로 진행. §2 규칙 4 |
| LangGraph 재진입·재시도 | **통과** | checkpointer 없이 정적 그래프 실행, 조건부 edge로 검토 회차 2회, 노드 예외는 기본 재시도 없이 실패, 같은 activationKey 재요청은 Task를 새로 만들지 않음. 도달 불가 노드는 compile 단계에서 거절 | ADR-004 유지 |
| LangGraph 브라우저 | **통과** | `@langchain/langgraph/web`으로 같은 검토 루프를 Chromium(Vitest browser mode)에서 실행 | ADR-016: 데모도 같은 runner 사용 가능 |
| SQLite | **통과** | WAL, `foreign_keys=ON`, `synchronous=FULL`, UNIQUE 위반 시 트랜잭션 전체 rollback(이벤트 0건), FK 위반 거절, 두 번째 writer는 `busy_timeout` 250ms 후 `SQLITE_BUSY`. SQLite 3.53.4 | better-sqlite3 채택 유지 |
| better-sqlite3 설치 | **통과** | 13.0.3은 8개 플랫폼 prebuilt binary를 패키지에 포함한다. pnpm 10이 implicit `node-gyp` 단계를 막아도 로드된다 | install script는 계속 차단, `ignoredBuiltDependencies`로 명시 |
| `node:sqlite` | **보류** | Node 24.14에서 여전히 ExperimentalWarning | 대안으로만 유지 |
| worker 12개 | **통과** | 아래 §3. 프로세스 884 MB, 스레드 359 MB, 준비 p95 313/312 ms, 모두 정상 종료 | ADR-017: child process + lazy spawn |

## 2. Pi adapter 구현 규칙 (C-017–C-020에 반영)

1. **`tool.started`는 Pi 이벤트로 만들지 않는다.** Corral이 등록하는 각 도구의 `execute`를 감싸, 실제로 실행이 시작될 때만 host에 알린다. `beforeToolCall`에서 host 승인을 받아 `tool.allowed`/`tool.blocked`를 기록한다. Pi의 `tool_execution_start`는 관측 로그로만 쓴다(기술 설계 §7.3의 경고가 실제로 확인됨).
2. **도구 실행 모드는 `toolExecution: "sequential"`로 명시한다.** Pi 기본값은 `parallel`이다. 기술 설계 §7.3은 인스턴스 안 순차 실행을 MVP 계약으로 정했다.
3. **지시 전달은 `prepareRequest`에서 한다.** 이 훅에서 host의 `prepareModelRequest`를 호출해 permit과 ContextSnapshot을 확정하고, 그 snapshot에 붙은 지시만 context에 넣는다. `agent.steer()`는 쓰지 않는다. 반환한 context는 이후 요청에도 유지되므로, 지시는 한 번 전달되면 대화 기록에 남는다.
4. **자격 증명은 host가 소유한다.** `getApiKey`는 매 요청 host에 access token을 묻는다. OpenAI OAuth는 Corral 서버가 `CredentialStore`(workspace 밖, 0600 파일)를 구현해 로그인·갱신을 주도한다. refresh token은 worker로 보내지 않는다.
5. **OpenAI OAuth 운영 메모:**
   - 로그인 콜백은 `127.0.0.1:1455`를 쓴다. Codex CLI 로그인과 포트가 겹치면 실패한다. UI는 이 오류를 그대로 보여준다.
   - 설치별 device UUID가 필요하다. 서버 설정 디렉터리에 한 번 만들어 둔다.
   - `agentName` 옵션으로 사용자가 보는 이름을 `Corral`로 지정한다(기본값은 `Pi`).

## 3. worker 측정

방법: 대기 worker 12개를 동시에 만들고, 각 worker가 `pi-agent-core`와 `pi-ai`를 import한 뒤 준비를 알린 시점까지 측정했다. RSS는 `/proc/<pid>/statm`. 한 번 측정이며 반복 측정·통계는 하지 않았다.

| 방식 | 전체 RSS | worker당 | 준비 p95 | 종료 |
|---|---:|---:|---:|---|
| child process | 884 MB | 74 MB | 313 ms | 12/12 정상 |
| worker thread | 359 MB (부모 증가분) | 30 MB | 312 ms | 12/12 정상 |

**결정(ADR-017):** child process를 쓰고, 필요할 때만 띄운다(lazy spawn). 두 방식 모두 제안 기준(1.5 GiB, 1 s) 안이며, 프로세스는 강제 종료(기술 설계 §7.5)와 장애 격리가 더 단순하다. 메모리가 문제 되면 worker thread로 바꿀 수 있도록 IPC schema는 전송 수단과 독립으로 둔다.

## 4. 의존성 메모

- pi-ai 1.2.0은 OpenAI·Anthropic·Google·Bedrock SDK를 직접 의존성으로 가진다. Studio 번들에는 들어가지 않도록 `adapter-pi`는 서버 쪽 패키지로만 둔다.
- `@google/genai`, `esbuild`, `protobufjs`의 install script도 차단 상태다. 스파이크 실행에는 영향이 없었다.
- `node-domexception@1.0.0` deprecated 경고가 하위 의존성에서 나온다. 기능 영향은 확인하지 못했다.

## 5. ADR 상태 변경

- ADR-004(LangGraph 정적 runner): 유지.
- ADR-016(RuntimeTransport): LangGraph `/web` 확인으로 데모 runner 제약 해소.
- ADR-017(worker 방식): child process + lazy spawn으로 채택.

## 6. 실행하지 않은 것

- OpenAI OAuth 실제 로그인과 실제 모델 요청. Bell의 ChatGPT 계정 로그인이 필요하다. C-020에서 수동 opt-in live smoke로 확인한다.
- 실제 provider의 중단 시 usage, rate limit, 오류 형식.
- Windows/WSL, macOS에서의 better-sqlite3 동작.
- worker 측정의 반복·부하 조건.
