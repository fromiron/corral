# Corral — ADR 원장

상태는 모두 **설계 채택안 / 구현 검증 전**이다. 사용자 합의와 새 기술 선택의 근거를 남긴다. 변경은 기존 기록 삭제가 아니라 새 ADR로 대체한다.

## ADR-001: 브랜드 은유는 경계와 조작에만 적용

**결정:** Corral은 root 팀·그래프·공유 한도, Loop는 반복, Studio는 UI, Reins는 제어 패널로 정한다. Task Board·Artifacts·Run은 일반 용어를 유지한다.

**이유:** 팀과 loop를 동일 타입으로 부르거나 모든 명칭을 말/마장 은유로 치환하면 API와 UI가 모호해진다.

**결과·제약:** 중첩 Corral·Hitching Post·Trough를 MVP entity로 추가하지 않는다.

## ADR-002: D&D와 Reins는 MVP 필수

**결정:** P0부터 캔버스→검증→mock 실행의 수직 슬라이스를 만든다. 완성된 backend 뒤에 UI를 붙이는 순서로 미루지 않는다.

**이유:** 사용자 목표가 기능적 도구와 프런트엔드 포트폴리오를 함께 포함한다.

**결과·제약:** 범위 축소는 provider·node 범용성·외부 연동을 대상으로 한다.

## ADR-003: 하나의 Coordinator가 도메인 상태를 확정

**결정:** 명령을 직렬화하고 events+projection+artifact+effect intent를 SQLite txn에서 commit한다.

**이유:** Pi·graph state·UI 상태가 각각 Task 완료를 정하면 취소/patch 경합을 설명할 수 없다.

**결과·제약:** 역할 분리는 유지하되 authoritative writers를 늘리지 않는다.

## ADR-004: LangGraph는 정적 flow runner로 제한

**결정:** v1.1의 LangGraph 채택은 유지하되 도메인 상태·durable checkpointer·interrupt 기반 스티어링은 쓰지 않는다.

**이유:** 그래프 순회 라이브러리와 업무 제어를 혼동하지 않는다. crash resume은 범위 밖이다.

**결과·제약:** P0/P1에서 node activation 멱등성과 외부 gate를 증명하지 못하면 ADR를 갱신하고 제한형 runner 대안을 평가한다. 몰래 이중 scheduler를 만들지 않는다.

## ADR-005: Pi agent-core를 worker로 감싼다

**상태:** ADR-027이 역할별 SDK 실행에 한해 부분 대체(2026-10-18). 기본 pi-core 실행은 유지한다.

**결정:** coding-agent 전체 대신 agent-core+pi-ai, 명시한 도구만 제공한다. worker는 host RPC로 신규 효과를 요청한다.

**이유:** 원하는 역할은 코딩 전용이 아니며, 권한과 사용량을 host가 검증해야 한다.

**결과·제약:** child process는 security sandbox가 아니다. untrusted plugin·shell 없음. worker admission overhead는 측정한다.

## ADR-006: 지시와 설정 변경을 다른 타입으로 관리

**결정:** directive는 특정 execution의 다음 요청, patch는 node의 미래 activation 또는 run limit에 적용한다.

**이유:** 모델/프롬프트를 현재 요청 도중 바꾸는 것은 안전 경계와 모델 컨텍스트를 흐린다.

**결과·제약:** 템플릿 원본 불변, run-only overlay. 도구 권한 확대는 MVP에서 금지.

## ADR-007: 일시정지·취소·재시작·crash resume을 구별

**결정:** pause는 새 effect를 막고 경계 대기, cancel은 termination, restart는 허용된 미완료 task의 새 attempt다. crash는 interrupted 기록 열람만 허용.

**이유:** 모든 조작을 stop/replay 하나로 합치면 외부 효과를 중복 수행할 수 있다.

**결과·제약:** 취소됐다고 모델 공급자 내부 과금 중지까지 주장하지 않는다.

## ADR-008: 공유 예산에는 예약·정산을 사용

**결정:** 모델 dispatch 전 한도 검사와 reservation, 완료 후 settlement. unknown usage는 별도 상태로 유지.

**이유:** 병렬 호출이 동일 잔여량을 보고 모두 시작하면 사후 집계만으로 상한을 지킬 수 없다.

**결과·제약:** 외부 공급자 미보고/불완전 취소의 비용까지 엄격히 보장하지 않고 새 admission을 안전하게 보류한다.

## ADR-009: 질문은 추적되는 응답 작업이다

**결정:** 질문 수신 역할에 새 response task/instance를 만들고 scope 입력만 준다. finished 실행을 다시 살아있게 만들지 않는다.

**이유:** 현재/종료된 receiver의 mailbox 처리와 재개 정책을 통일하는 부담을 줄인다.

**결과·제약:** 새 응답도 spawn·depth·budget·round-trip 상한에 들어간다. 비용 최적화 상주 에이전트는 후속.

## ADR-010: 산출물은 불변 버전과 명시적 제출

**결정:** 본문은 SQLite에 넣고 write/submit/review/approval을 구별한다. 현재 반복 선행 출력과 이전 반복 입력 바인딩을 분리한다.

**이유:** latest 전역 조회는 reviewer가 다른 버전을 보는 버그를 만든다. 파일과 DB의 이중 commit도 피한다.

**결과·제약:** 큰 바이너리 산출물과 외부 blob 저장은 후속.

## ADR-011: 관측과 실제 적용을 구분

**결정:** domain SSE에는 commit된 event만, token frame은 transient. directive lineage는 model context snapshot으로 만든다.

**이유:** 시간상 나중이라는 사실만으로 지시가 원인이라고 할 수 없다. Pi tool start도 허용 전 관측일 수 있다.

**결과·제약:** provenance와 지시 준수 판정은 다른 필드로 관리한다.

## ADR-012: 공개 데모와 실제 실행을 명확히 분리

**결정:** 동일 Studio에 mock RuntimeTransport를 연결해 static demo를 제공한다. live는 로컬 auth 서버에서만 API 키 사용.

**이유:** 방문자가 키 없이 프런트엔드 역량과 동작을 체험할 수 있다. 비밀키 유출/무제한 비용을 피한다.

**결과·제약:** mock 표시 상시 노출. live 품질 검증의 대체로 사용하지 않는다.

## ADR-013: SDD와 TDD에 추적성과 반례를 요구

**결정:** REQ→scenario→contract→test→task의 mapping을 유지한다. 테스트를 실제 실패시킨 증거와 반례를 PR에 남긴다.

**이유:** 에이전트가 구현과 테스트를 동시에 작성하면 잘못된 가정을 양쪽에 복제할 수 있다.

**결과·제약:** 코드 리뷰는 spec 준수와 spec 자체 타당성을 별도로 확인한다.

## ADR-014: contracts·core는 실행 환경에 중립적이다

**상태:** 채택 (2026-10-15, C-051). Biome `noRestrictedImports`와 패키지 tsconfig `types: []`로 강제하고, 위반 import가 lint 오류가 되는 것을 확인했다.

**결정:** `packages/contracts`와 `packages/core`는 `node:*`, Buffer, process, DOM에 의존하지 않는다. Biome `noRestrictedImports`와 패키지별 tsconfig `types` 제한으로 강제한다.

**이유:** 정적 데모가 같은 Coordinator를 브라우저 Web Worker에서 실행한다(ADR-012, ADR-016). 시간·ID·저장소를 주입하는 테스트 더블(CRL-DEV-002)도 단순해진다.

**결과·제약:** hash·UUID·시간은 주입 포트나 환경 중립 API(WebCrypto, 순수 JS)로만 쓴다. Node 전용 기능은 server·storage·adapter 패키지에 둔다.

## ADR-015: 정의 정규화는 RFC 8785(JCS), hash는 SHA-256

**상태:** 채택 (2026-10-15, C-054). 해시는 동기 순수 JS(`@noble/hashes`)로 계산한다. 예제 정의 2개의 hash가 Python 독립 계산과 일치했다.

**결정:** definitionHash는 레이아웃을 뺀 정의를 RFC 8785 JSON Canonicalization Scheme으로 직렬화한 UTF-8 바이트의 SHA-256(hex)이다.

**이유:** 기술 설계 §3의 “키 정렬·UTF-8”을 표준으로 고정하면 다른 언어 도구에서도 같은 hash를 재현할 수 있다.

**결과·제약:** NaN·Infinity·undefined·함수는 정규화 전에 schema에서 거절한다. 숫자 직렬화는 JCS 규칙을 따른다.

## ADR-016: Studio는 RuntimeTransport 포트로만 runtime과 통신한다

**상태:** 채택 (2026-10-15, C-053). InProcessTransport와 공통 transport 계약 테스트를 구현했다. LangGraph `/web`이 브라우저에서 동작함을 확인했다([C-052](spikes/C-052-p0-spikes.md)).

**결정:** Studio는 `RuntimeTransport`(명령→receipt, snapshot, afterSeq 구독)만 사용한다. 구현은 HttpSseTransport(로컬 서버)와 InProcessTransport(P0 mock, 공개 데모의 Web Worker)다. 두 구현은 같은 transport 계약 테스트를 통과해야 한다.

**이유:** P0부터 실제 명령 경로를 가진 세로 절편을 만들고, 공개 데모가 같은 투영·Reins 코드를 쓰게 한다.

**결과·제약:** UI 컴포넌트는 HTTP·SSE를 직접 호출하지 않는다.

## ADR-017: worker 실행 방식은 측정으로 정한다

**상태:** 채택 (2026-10-15, [C-052](spikes/C-052-p0-spikes.md)). child process + lazy spawn. 12개 대기 시 884 MB, 준비 p95 313 ms.

**결정:** child_process, worker_threads, lazy spawn 중 하나를 C-052의 측정(대기 worker 12개 RSS 합계, spawn p95, kill 후 정리)으로 고른다.

**이유:** ADR-005는 admission overhead를 측정한다고만 정했고, 12개 resident worker의 메모리 비용이 확인되지 않았다.

**결과·제약:** 어떤 방식이든 IPC schema와 epoch fence 계약(기술 설계 §7.4·§7.5)은 같다.

## ADR-018: 라우터는 TanStack Router

**상태:** 확정 (Bell, 2026-10-15)

**결정:** Studio의 라우팅은 TanStack Router를 사용한다.

**이유:** `/runs/:runId?execution=`처럼 search param이 화면 상태의 일부이며, 이를 타입으로 다룰 수 있다. TanStack Query·Virtual과 같은 계열이다.

**결과·제약:** 정확한 버전과 라이선스는 C-002 의존성 기록에 남긴다.

## ADR-019: 모델 자격 증명은 서버 측에만 둔다

**상태:** 확정 (Bell, 2026-10-15, [CR-001](change-requests/CR-001-openai-oauth-first.md)). 구현(C-058): `FileCredentialStore`(사용자 설정 디렉터리 `credentials.json`, 0600, workspace 안이면 시작 거부), 설치 ID `device-id`, 요청마다 host가 access token을 permit에 실어 worker로 보냄. 실제 로그인은 미시험([P3 증거](../specs/001-canvas/evidence/P3.md)).

**결정:** MVP는 pi-ai의 OpenAI 구독 OAuth로 시작한다. 토큰은 workspace 밖 사용자 설정 디렉터리의 credential store(파일 권한 0600)에 두고, 갱신은 host가 한다. API 키는 서버 프로세스 환경 변수에서 읽는다. Anthropic 구독(Pro/Max) OAuth는 지원하지 않는다.

**이유:** 스펙 §10.2의 자격 증명 격리를 OAuth까지 넓힌다. Anthropic은 제3자 앱이 구독 자격 증명으로 요청하거나 토큰을 보관·중개하는 것을 허용하지 않는다(2026-10-15 확인).

**결과·제약:** 자격 증명은 Corral JSON·SQLite·이벤트·export·클라이언트·로그에 없다. 로그인은 provider 자체 흐름에서 사용자가 완료한다. OS keychain은 후속이다.

**갱신(2026-10-16):**
- [CR-004](change-requests/CR-004-codex-login-reuse.md): Corral 자체 로그인이 없으면 Codex CLI 로그인(`~/.codex/auth.json`)을 읽기 전용으로 쓴다. 갱신·쓰기·삭제하지 않는다.
- [CR-005](change-requests/CR-005-api-keys-and-compatible-endpoints.md): API 키는 환경 변수 **또는** 모델 화면에서 입력해 같은 credential store에 둔다. 사용자 정의 엔드포인트 키는 입력할 때의 origin에 묶인다. Anthropic 구독 OAuth 요청은 서버가 거절한다.

## ADR-020: 서버·runtime·CLI 언어는 TypeScript

**상태:** 확정 (Bell, 2026-10-15)

**결정:** 서버, runtime, worker, CLI를 TypeScript(Node 24)로 작성한다. Rust는 MVP에 넣지 않는다.

**이유:** Pi agent-core·pi-ai·LangGraph.js가 TypeScript다. Zod 계약 한 곳에서 서버·클라이언트·데모 타입을 만들고, 같은 Coordinator를 브라우저 데모에서 실행할 수 있다. 성능 목표는 I/O 위주라 Node로 충분하다.

**결과·제약:** 데스크톱 셸이나 도구 샌드박스처럼 MVP 밖의 기능이 필요해질 때 다른 언어를 다시 검토한다.

## ADR-021: SQLite는 ORM 없이 better-sqlite3와 번호 붙은 SQL migration으로 쓴다

**상태:** 채택 (2026-10-15, C-011). 기술 설계 §2의 `storage-sqlite/ # Drizzle schema` 표기를 대체한다.

**결정:** `@corral/storage-sqlite`는 better-sqlite3(13.0.3)의 prepared statement와 동기 transaction을 직접 쓴다. schema는 `MIGRATIONS` 배열의 SQL이고 적용 번호는 `PRAGMA user_version`에 남는다. 이 build보다 새 번호의 파일은 열지 않는다. 이벤트·산출물 본문 테이블은 trigger로 UPDATE·DELETE를 거절한다.

**이유:** Coordinator의 commit은 동기 RunStore transaction 하나다(ADR-003). 테이블이 8개뿐이고 질의는 키 조회와 seq 범위 읽기뿐이라 ORM의 타입 질의 이점이 작다. Drizzle을 넣으면 의존성과 migration 생성 도구(drizzle-kit)가 함께 늘어난다. 메모리 store와 SQLite store가 같은 `RunStore` 계약 테스트를 통과하므로 저장 방식은 포트 뒤에 숨는다.

**결과·제약:** 읽기 모델은 run마다 JSON 투영 한 행(`runs.projection_json`)이며 이벤트 재생으로 다시 만들 수 있다. 실행·작업 단위 정규화 테이블(기술 설계 §11의 executions·tasks 등)은 질의가 필요해지는 단계(P7 inspect)에서 migration으로 추가한다. effect intent는 `effect_intents` 테이블에 같은 transaction으로 기록한다.

## ADR-022: 로컬 세션은 URL fragment의 일회성 token으로 연다

**상태:** 채택 (2026-10-15, C-055)

**결정:** 서버는 시작할 때 무작위 bootstrap token을 만들고 `http://127.0.0.1:<port>/#bootstrap=<token>`을 터미널에 출력한다. Studio는 fragment의 token을 `POST /api/v1/session`으로 한 번 교환해 `HttpOnly; SameSite=Strict` 세션 cookie를 받고, 주소창에서 token을 지운다. 같은 token의 두 번째 교환은 401이다. 모든 API는 Host 허용 목록과 Origin 검사를 먼저 통과해야 하고, 상태 변경 요청은 Studio origin의 Origin header가 반드시 있어야 한다. CORS header는 보내지 않는다. 서버가 내보내는 Studio 페이지에는 `<meta name="corral-runtime" content="server">`를 넣어, 그 표시가 있을 때만 Studio가 서버 runtime을 쓴다. 표시가 없으면 브라우저 안의 데모 runtime을 쓴다(ADR-016).

**이유:** fragment는 서버 로그·Referer로 전달되지 않는다. 다른 사이트의 페이지도 loopback port에 요청을 보낼 수 있으므로, 세션 없이 읽기를 허용하거나 Origin 없는 쓰기를 허용하면 안 된다. 표시 없는 health probe는 데모 hosting에서 404 console 오류를 만든다.

**결과·제약:** 서버를 재시작하면 세션이 끝나고 새 링크가 필요하다. 브라우저를 다시 열어도 cookie가 사라진다(session cookie). CSRF token, 요청 빈도 제한, DNS rebinding 전체 감사는 C-042(P8)다. CSP에 `unsafe-eval`이 없으므로 Studio는 Zod를 jitless 모드로 실행한다.


## ADR-023: 큰 영속 이벤트는 한 건씩 배압을 지키며 재생한다

**상태:** 채택 (2026-10-15, C-041 결함 수정, [CR-002](change-requests/CR-002-oversized-domain-replay.md))

**결정:** 1 MiB보다 큰 committed domain frame은 구독을 해제한 연결에서 prefix를 먼저 flush하고 64 KiB 이하의 바이트 조각을 순차 전송한 뒤 연결을 종료한다. 현재 이벤트 한 건 외 후속 이벤트를 큐에 쌓지 않는다. 클라이언트는 완전한 frame만 schema 검사·적용하고 그 runSeq를 재접속 cursor로 쓴다.

**이유:** 2 MiB 이하인 정상 취소 요청과 before+after를 함께 가진 미래 설정 patch가 기존 1 MiB 전송 상한을 넘을 수 있다. 입력을 제한해도 이미 저장한 이벤트의 재생 불능은 해결되지 않는다.

**결과·제약:** 일반 outgoing 큐 1 MiB와 10초 flush deadline을 유지한다. 전송·파싱 중 현재 domain record 한 건의 메모리는 필요하다. 주석·헤더·비영속 frame에는 고정 상한을 유지한다. 이벤트·저장 schema, receipt 의미와 cursor 규칙은 바꾸지 않는다.

## ADR-024: Admission은 정적 등록 gate와 commit 뒤 observer로 나눈다

**상태:** 채택 (2026-10-15, [CR-003](change-requests/CR-003-admission-hooks-effort-observe.md), C-067)

**결정:** Coordinator의 모델 요청(`model.admit`)·도구 승인(`tool.authorize`)·도구 실행(`tool.execute`) 검사는 `{id, version, stage, check}` gate의 순서 있는 목록으로 수행한다. gate는 읽기 전용 view만 받고 I/O·시계·난수를 쓰지 않는 동기 함수이며, 첫 거절에서 멈춘다. 예외는 `POLICY_ERROR` 거절(fail closed)이다. commit 뒤에 실행되는 observer는 비동기로 돌고 요청을 막거나 바꾸지 못하며, 결과는 Coordinator가 run·execution·attempt·modelCallId fence를 확인한 sink로만 남긴다. gate와 observer는 `new Coordinator({ admission })`에서 한 번 등록한다. 안전 경계 대기·슬롯·승인 요청 생성·ID·commit은 Coordinator가 계속 소유한다.

**이유:** 검사가 `coordinator.ts` 곳곳에 흩어져 있어 새 정책(추론 강도 판정, 이후 도구 권한)을 넣을 자리가 없고 단위 시험도 어렵다. 동기 gate는 기술 설계 §5.1의 "검사와 commit 사이에 비동기 작업 없음"을 지킨다.

**결과·제약:** 기본 gate 집합은 리팩터 전 golden 이벤트 열과 바이트 단위로 같아야 하며 `tool.allowed.policyVersion`도 `role-allowlist@1`을 유지한다. 닫힌 질문에 대한 reply 검사는 지금처럼 안전 경계 대기 앞에 둔다. Corral admission gate의 사용자 정의 hook, 런타임 로딩, 공개 플러그인 API는 만들지 않는다(기술 설계 §15). ADR-027의 Pi 확장 hook은 worker 안에서만 실행하며 이 gate를 교체하지 못한다. Cordis식 동적 효과 스코프는 채택하지 않는다.

## ADR-025: DecisionProvider는 관찰 전용 reasoning_effort로 시작하고 Run 시작 시 고정한다

**상태:** 채택 (2026-10-15, [CR-003](change-requests/CR-003-admission-hooks-effort-observe.md), C-068~C-071)

**결정:** 스펙 §13의 v0.2 `DecisionProvider` 첫 질문 종류는 `reasoning_effort` v1이다. 후보는 추상 4단계 `low | medium | high | xhigh`, 응답은 answer·확률(선택)·evidenceLevel·provider@version이다. provider는 지원하는 질문 종류·버전, privacy(`local | external`), timeout을 선언하며 Coordinator는 선언하지 않은 질문을 보내지 않는다. 모드는 `off | observe`이고 workspace 설정으로 provider를 1~2개 고르며 Run 시작 시 `run.started`에 고정한다. 판정은 `model.request_prepared` commit 뒤 observer로 실행하고 결과만 기록한다. 처음 제공하는 provider는 `scripted@1`과 규칙 기반 `local-heuristic@1`이다. 이벤트에는 입력 본문 대신 `inputHash`와 본문 외 특징 값만 남긴다.

**이유:** 구현 플랜 v0.1 §11은 적용 전에 질문·후보·응답·registry·timeout·privacy를 먼저 명세하고 두 adapter의 결과를 비교 기록하라고 정했다. 관찰 데이터 없이 적용하면 Reins의 "무엇이 왜 바뀌었는가"를 설명할 수 없다.

**결과·제약:** 판정은 `RequestPermit`·예산 예약·worker 요청을 바꾸지 않는다. `apply` 모드, 자동 라우팅, Hybrid, 비용 절감 주장, ONNX 모델과 Jev adapter는 각각 후속 CR이다(CR-003 D1·D2). 외부 provider는 live Run의 opt-in에서만 쓰고 전송 전에 `effect.admitted(kind: decision)`를 남긴다. 기존 `DecisionPolicy` 포트(Decision 노드 판정)는 이번에 바꾸지 않는다.

## ADR-026: T3 화면을 Corral 실행 모델에 연결하고 Electron은 호스트만 맡는다

**상태:** 채택 (Bell, 2026-10-17, [CR-014](change-requests/CR-014-desktop-workbench.md)).

**결정:** T3의 Sidebar·ChatView 화면 트리와 필요한 UI 동작을 MIT 고지를 보존해 포팅한다. Corral repository·projection·transcript와 명령 경로에 연결하고 T3의 provider/orchestration 서버를 흉내 내지 않는다. 데이터의 권위는 Coordinator와 기존 SQLite다. UI 선호는 별도 버전 설정으로 둔다. PI의 패널 동작은 참고만 한다.

Electron은 창·OS 대화상자·서버 수명을 소유한다. 서버와 Pi worker는 동봉 Node 24.19로 실행해 Electron ABI와 SQLite/ONNX 런타임을 분리한다. renderer는 기존 loopback 세션/CSRF 경계로 API를 쓰며 Node 권한을 받지 않는다. 기존 workspace는 명시적으로 선택하며 자동 이관하지 않는다. 웹 Studio도 같은 UI를 사용한다.

**결과·제약:** Linux x64 AppImage가 첫 대상이다. 원본의 원격 환경·터미널·Git 쓰기·플러그인 플랫폼은 이식하지 않는다. native module·worker·자원 경로는 개발 실행과 설치 패키지에서 각각 검증한다.

## ADR-027: Pi coding-agent SDK를 역할별 실행 방식으로 추가한다

**상태:** 채택 (2026-10-18, [CR-018](change-requests/CR-018-pi-standard-harness.md)). H1 S1·S2·S4 통과와 Bell의 H2–H8 구현 계속 요청에 따른다. ADR-005를 역할별 SDK 실행에 한해 부분 대체한다.

**결정:**

- 역할마다 실행 방식 `pi-core`(기존 agent-core worker) 또는 `pi-sdk`(`@earendil-works/pi-coding-agent` SDK)를 고르고, Run 시작 시 고정한다.
- `pi-sdk`는 기존과 같은 실행 단위 worker 프로세스 안에서만 돈다.
- 모델 요청은 자격 증명 없는 `ModelRuntime`에 등록한 Corral provider 하나로만 보낸다. 이 provider는 요청마다 host permit을 받는다.
- 리소스는 핀 고정한 경로만 로드한다(`noExtensions`·`noSkills`·`noContextFiles` + 명시 경로).
- system prompt는 `systemPromptOverride`·`appendSystemPromptOverride`로 Corral 값에 고정한다. SDK 경로는 project trust를 적용하지 않아서, 이것이 없으면 프로젝트 `.pi/SYSTEM.md`가 들어간다(스파이크 F1).
- 설정은 in-memory로 둔다(`cacheWarming: off`). 세션도 in-memory다.
- Pi 내장 도구는 끈다.
- Corral 확장을 마지막에 로드한다. 이 확장이 `tool_call`에서 최종 인자를 host에 승인받는다.
- 필수 확장이 실패하면 실행이 실패한다. `pi-core`로 fallback하지 않는다.

**이유:** Agent Skills·Pi 패키지를 원형 그대로 쓰려면 공식 리소스 로더와 확장 런타임이 필요하다. 1.3.0 SDK에는 `streamFn`·`prepareRequest` 주입 옵션이 없다. 그래서 모든 요청이 지나는 `modelRuntime.streamSimple`에 등록한 provider가 공개 API 안의 유일한 통제 지점이다.

**결과·제약:**

- 확장 코드는 worker 권한으로 직접 fs·network·process를 쓸 수 있다. 이것을 "신뢰한 네이티브 코드"로 표시하고 통제를 약속하지 않는다.
- OS 격리는 제공하지 않는다.
- `pi-core` 역할의 이벤트·hash·골든은 바뀌지 않는다.
- Pi 업그레이드는 별도 변경으로 하고, S1·S2·S4 회귀 테스트(`packages/adapter-pi/test/spike/`)를 통과해야 한다.
- 스파이크 결과는 [HAR-pi-sdk-spikes](spikes/HAR-pi-sdk-spikes.md)에 있다.

## ADR-028: 추론 정책은 역할 소유, 적용값은 요청 permit 소유

**상태:** 채택 (2026-10-18, CR-021). ADR-025의 off/observe는 유지하며 별도 apply 경로를 추가한다.

**결정:** 역할·Run override·미래 실행 patch에서 정책을 고정한다. 자동 판정은 슬롯·예산 전 비동기 준비이며 동기 gate가 아니다. owner/attempt/context/지시를 재검사한 뒤 commit과 permit에 같은 해석을 기록한다. 두 Pi runtime은 permit을 최종 권위로 사용한다. 구 자료의 hash/동작을 보존하고 수동 미지원 값은 거절한다.

**결과:** turn/tool-step 학습 입력과 bounded 로컬 worker를 재사용한다. 늦은 판정으로 전송된 요청을 바꾸지 않는다. 선택·판정·실제 wire·fallback을 구분한다. 비용·품질 우열은 별도 평가다.

## ADR-029: 리소스 관리와 실행 참조를 분리한다

**상태:** 채택 (2026-10-18, CR-022).

목록·표시명·보관·편집 후속 버전은 관리 메타데이터다. 실행은 기존 content hash·profile/config revision·fingerprint만 사용한다. 편집은 사본, 제거는 복구 가능한 보관, 선택 변경은 명시적인 새 revision이다. 관리형 Hook은 일반 Pi extension을 생성하며 MCP probe는 공개 client로 모델 없이 연결과 도구 목록만 관측한다. 기존 합성·신뢰·프로세스 소유 경계는 유지한다.

## ADR-030: 이동·현재 위치·설정 대상·실행 제어의 UI 책임을 나눈다

**상태:** 채택 (2026-10-18, [CR-023](change-requests/CR-023-ui-structure.md)).

프로젝트/세션 이동은 사이드바, 현재 위치는 route/객체 기반 상단 경로, 설정 대상은 해당 설정 화면, 실행 제어는 정확한 Run/execution이 맡는다. 설정은 같은 사이드바 영역을 교체하고 실행/Inbox 구독은 프레임 수명에 둔다. 세션의 간단한 실행 패널과 기존 넓은 상세는 같은 저장 상태와 명령 경로를 사용한다. 사용자에게 저장된 Corral 정의는 `팀`, Run은 `실행`으로 표시하되 API와 기존 URL은 유지한다. 리소스 관리와 작업 방식 연결은 별도 행동이며 기존 불변 버전·합성·신뢰를 바꾸지 않는다. 이를 위해 새로운 DB나 실행/내비게이션 프레임워크를 도입하지 않는다.

## ADR-031: 자동 선택도 취소·예산·중복 명령 경계에 포함한다

**상태:** 채택 (2026-10-18, [CR-024](change-requests/CR-024-session-auto-team.md), PR #59의 12개 수정과 회귀 검증 요청).

**결정:** 선택 요청의 알려진 사용량 또는 보수적인 미확정 예약을 기존 Coordinator 예산 이벤트로 기록한다. 한도 patch는 이미 소비한 선택 비용을 지우지 않는다. 원래 자동 시작 요청의 hash를 명령과 함께 보존해 처리 중·완료·재시작 후에도 같은 ID의 다른 내용을 거절한다. 선택 중 취소와 화면 이탈은 HTTP 요청까지 전달하고, 파일 기준 트리는 선택이 끝난 뒤 실제 실행 직전에 캡처한다.

**출력 제한:** 지원되는 전송에는 256토큰 상한을 요청한다. ChatGPT 구독 OAuth는 공급자가 이 필드를 거절하므로 모든 경로에서 관측 가능한 text·thinking 스트림의 UTF-8 256바이트와 30초 처리 상한을 별도로 검사한다. 초과한 선택은 취소·대체하고 알려진 사용량을 보존한다. 숨겨진 내부 추론의 생성 토큰까지 클라이언트에서 제한했다고 주장하지 않는다. tokenizer나 새 공급자 의존성은 추가하지 않는다.

**검증:** 정상·출력 초과·비협조적인 공급자의 시간 초과·중단 후 사용량·재전송 충돌·한도 patch·파일 기준·기록 roundtrip을 결정적으로 검사한다. 실제 모델 검토 팀의 종료와 private 기록 조회는 별도 opt-in과 요청 상한으로 검증한다.

ADR-031 보완(2026-10-18): 불명확한 시작은 최초 요청 전체를 재전송한다. 시작 전 명시 취소는 기존 명령 저장소에 세션 범위로 영구 기록하고, 파일 도구 허용과 기준 트리는 같은 실행 직전 상태에서 결정한다. 시간 제한 메모리 fence로 취소를 확정하지 않는다.

## ADR-032: 개선 평가와 실행 기능을 기존 경로에 단계적으로 연결한다

**상태:** 채택 (2026-10-19, [통합 실행 계획](plans/Corral-Improvement-Execution-Plan-2026-10-19.md), CR-025~036 순차 구현 요청).

기존 Coordinator/Pi/SQLite·명령/receipt·리소스·파일 broker를 유지한다. 공통 대기는 projection, TaskBrief는 기존 입력/기준의 투영으로 시작한다. 첫 배포는 대화·질문/계획·읽기 전용 diff·기본팩 선택이며 복구/hunk는 checkpoint 뒤에 연결한다. D&D와 Reins는 기존 회귀로 계속 검증한다.

`corral eval`의 `personal_harness` 비교군을 유지하고 `skill_quality`를 별도 종류로 추가한다. baseline과 필요한 비교군만 선택하며 반복 횟수와 총 case 상한을 검증한다. 각 반복은 독립 작업 사본을 사용하고 calibration/holdout 및 mock/live 근거를 구별한다. 평가 이름만으로 해당 Skill이 실제 전달됐거나 품질이 향상됐다고 판단하지 않는다.

사용자 요청에 따라 새로운 사용자 동작·데이터/권한 경계의 핵심 실패를 먼저 확인하고 기존 시험을 우선 확장한다. 단순 문구/구조 변경이나 구현 내부를 따라가는 테스트는 추가하지 않는다. OS PoC와 콘텐츠 검사도 제품 지원/실모델 품질과 구별한다.

## ADR-033: 격리 worker의 모델 네트워크는 host permit으로만 연다

CR-025 C-107. network namespace를 host와 공유하는 proxy는 격리로 표시하지 않는다. Linux bubblewrap 안에는 애플리케이션 runtime과 바인딩된 콘텐츠만 읽기 전용으로 보인다. 자격 증명은 host에 남으며 host Pi provider가 고정 모델·출력 상한·reasoning permit으로 스트림을 연다. 기존 request/payload 기록은 같은 IPC를 통해 확인한 다음 HTTP 전송한다. provider URL이나 임의 headers, payload 수정은 worker 권한이 아니다. profile opt-in이므로 기존 snapshot을 재해석하지 않으며, 미지원 native 기능은 실패하고 fallback하지 않는다.


## ADR-034: 후보 비교는 Coordinator의 고정 recipe, 실행·파일·검증 소유권은 명시한다

**Upstream 근거:** Bell의 후속 요청으로 [Pi/OMP/pi-subagents/Codex/Claude Code/DeepSeek 비교](spikes/Ultra-Upstream-Harness-Review-2026-10-19.md)를 추가했다. 기존 Corral 병렬 execution을 재사용하며, 자식 준비 전 용량 예약·정확한 실행 회차의 취소·시작한 효과의 정리 대기·사본 실패 시 보존 원칙을 적용한다. Pi 플러그인은 금지하지 않지만 외부 runner가 Corral의 예산/권한 경계를 대체할 수 있다고 가정하지 않는다.

**상태:** 채택 (2026-10-19, CR-031 C-114). 사용자 지정 [Oracle 세션](https://chatgpt.com/g/g-p-6ad1f206e5ec8191904cfee1105213e3-corral/c/6ad4cfb8-3fe0-83ec-9099-aa745252231f)의 Pro/최대 파워에서 구조 설명을 바탕으로 교차 검토했다. 이 의견은 미푸시 코드를 직접 검사한 증거가 아니다.

일반 GraphRunner와 모델용 협업 도구는 변경하지 않는다. 후보 비교의 고정 recipe가 실행 구조이며 기존 definition은 역할·도구의 원본이라는 사실을 별도로 기록한다. Coordinator의 prepareExecution→commit→launch와 기존 settlement/취소/예산/lease를 사용한다. execution→candidate→workspace는 durable binding이며 worker 인자로 사본을 선택하지 않는다. scope가 빠진 Run 단독 파일 조회는 후보 실행에서 fallback하지 않는다.

planner는 한 번, 후보들은 동일 기준/계획을 사용한다. 후보 작성 후 host 전용의 격리된 등록 검사 효과와 유효한 동일 대상 review pass가 모두 있어야 선택할 수 있다. 검증 미지원/불확정은 사람의 선택으로 우회하지 못한다. 모든 후보 종료 후 하나를 명시 선택하고 최종 검사→관리 사본 승격을 수행한다. 원본 반영/commit/push는 포함하지 않는다.

예산은 기존 Run 원장을 사용한다. planner 전에 마무리 2회 capped 요청을 총상한 안에서 보호하며, 80% 기준에는 사용/예약/unknown과 마무리 hold 및 신규 요청 상한을 포함한다. draining 진입은 되돌리지 않는다. 후보 준비/대기열 재개와 실제 permit 발급 직전 모두 검사한다. final 단계는 후보 신규 실행을 닫고 hold를 실제 요청 예약으로 전환한다. 비용 표시는 금액 hard cap이라는 보장이 아니다.

worker의 check/LSP 금지는 유지한다. 등록 검사 runner를 host 소유 후보 scope와 OS 격리로 실행하며 검증용 고정 tree 사본과 임시 쓰기 공간을 사용한다. 검증 경로 없는 환경에서는 planner 비용을 쓰기 전에 비교 실행을 거절한다. crash/unknown/late 결과는 자동 재실행/승격하지 않고 기존 복구 원장을 보존한다.

## ADR-035: Ultra의 기본은 모델 pool을 고정한 협업이며 최대 추론은 별도 해석한다

Bell의 2026-10-19 목표 명확화와 [Oracle 재검토](spikes/Ultra-Multi-Provider-Oracle-2026-10-19.md)에 따른다. C113의 단일 모델 snapshot은 보존한다. 새 versioned Ultra는 기존 profile과 그래프/위임으로 복수 LLM을 배정하고 다른 모델의 검토를 필수로 둔다. 모델별 최대 지원 추론을 실제 Pi wire에서 확인하며 generic ultra enum을 provider에 보내지 않는다. 승인된 pool과 전송 범위 밖 fallback, 출력 한도의 조용한 증가, 검증 생략 성공은 허용하지 않는다. C114의 후보 복제/승격은 선택적 별도 전략이다. 새 하네스 의존성은 추가하지 않는다.

첫 협업 버전은 기존 review recipe의 optional 준비 단계를 사용한다. writer→synthesizer→다른 모델 reviewer 순서를 정적으로 고정하고 최종 output은 검토한 종합본만 참조한다. 최대 2개 선택 보조 에이전트는 기존 spawn/await/settlement 경로를 사용하며 파일 도구나 재위임 권한이 없다. 필수 단계의 최소 capped 호출 여유와 80% draining 상태는 기존 Run 예산에서 계산한다. 별도 예산 원장이나 실행 scheduler는 추가하지 않는다. 코딩 검사의 격리 실행과 다른 provider 확대는 별도 후속 단계이며, 현재 모델 verdict로 프로젝트 테스트 통과를 주장하지 않는다.

다른 provider도 [Pi 호환 기준](spikes/Pi-Provider-Compatibility-2026-10-19.md)에 따라 Pi의 공개 모델 metadata와 실제 serializer를 우선한다. 회사별 하드코딩으로 effort 체계를 통일하지 않으며 API/인증 계열별로 conformance를 확인한다. fingerprint는 Pi compat와 모델 출력 한도 변화까지 감지한다. 아직 검증되지 않은 계열을 단순 metadata 노출만으로 Ultra 지원 완료라고 표시하지 않는다.
