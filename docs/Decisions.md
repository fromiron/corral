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

**결과·제약:** 기본 gate 집합은 리팩터 전 golden 이벤트 열과 바이트 단위로 같아야 하며 `tool.allowed.policyVersion`도 `role-allowlist@1`을 유지한다. 닫힌 질문에 대한 reply 검사는 지금처럼 안전 경계 대기 앞에 둔다. 사용자 정의 hook, 런타임 로딩, 공개 플러그인 API는 만들지 않는다(기술 설계 §15). Cordis식 동적 효과 스코프는 채택하지 않는다.

## ADR-025: DecisionProvider는 관찰 전용 reasoning_effort로 시작하고 Run 시작 시 고정한다

**상태:** 채택 (2026-10-15, [CR-003](change-requests/CR-003-admission-hooks-effort-observe.md), C-068~C-071)

**결정:** 스펙 §13의 v0.2 `DecisionProvider` 첫 질문 종류는 `reasoning_effort` v1이다. 후보는 추상 4단계 `low | medium | high | xhigh`, 응답은 answer·확률(선택)·evidenceLevel·provider@version이다. provider는 지원하는 질문 종류·버전, privacy(`local | external`), timeout을 선언하며 Coordinator는 선언하지 않은 질문을 보내지 않는다. 모드는 `off | observe`이고 workspace 설정으로 provider를 1~2개 고르며 Run 시작 시 `run.started`에 고정한다. 판정은 `model.request_prepared` commit 뒤 observer로 실행하고 결과만 기록한다. 처음 제공하는 provider는 `scripted@1`과 규칙 기반 `local-heuristic@1`이다. 이벤트에는 입력 본문 대신 `inputHash`와 본문 외 특징 값만 남긴다.

**이유:** 구현 플랜 v0.1 §11은 적용 전에 질문·후보·응답·registry·timeout·privacy를 먼저 명세하고 두 adapter의 결과를 비교 기록하라고 정했다. 관찰 데이터 없이 적용하면 Reins의 "무엇이 왜 바뀌었는가"를 설명할 수 없다.

**결과·제약:** 판정은 `RequestPermit`·예산 예약·worker 요청을 바꾸지 않는다. `apply` 모드, 자동 라우팅, Hybrid, 비용 절감 주장, ONNX 모델과 Jev adapter는 각각 후속 CR이다(CR-003 D1·D2). 외부 provider는 live Run의 opt-in에서만 쓰고 전송 전에 `effect.admitted(kind: decision)`를 남긴다. 기존 `DecisionPolicy` 포트(Decision 노드 판정)는 이번에 바꾸지 않는다.
