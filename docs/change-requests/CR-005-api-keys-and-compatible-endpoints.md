# CR-005: 화면에서 넣는 API 키와 OpenAI 호환 엔드포인트

- 변경 ID / 제안자 / 날짜: CR-005 / Claude(초안) / 2026-10-16
- 상태: **승인**(로드맵 11번. Bell의 /goal 지시 "제안한 개선·강화 플랜 끝까지 구현"에 포함된 항목. 2026-10-16)
- 연결 문서: [CR-001](CR-001-openai-oauth-first.md) §2 확장 목표, [CR-004](CR-004-codex-login-reuse.md), [ADR-019](../Decisions.md), 스펙 §10.2

## 기존 문구

- ADR-019: "API 키는 서버 프로세스 환경 변수에서 읽는다."
- 스펙 §10.2: "API 키와 OAuth 토큰은 backend 환경/서버 측 credential store에서만 읽으며 Corral JSON·SQLite·클라이언트 번들·이벤트 payload·export·로그에 저장하지 않는다."
- `.corral/config.json`은 `modelProfiles`(id·provider·model)만 받는다. provider는 pi-ai 내장 provider뿐이다.

## 제안

1. **화면에서 API 키 입력.** 모델 화면에서 API 키 인증을 지원하는 provider에 키를 넣을 수 있다. 서버는 키를 기존 credential store(작업 공간 밖, 0600)에 `api_key` credential로 저장하고 다시 돌려주지 않는다. 응답·이벤트·로그·export·화면에는 "API 키 사용 중"만 보인다. "키 지우기"는 그 credential만 지운다. 환경 변수 키는 저장된 키가 없을 때 쓰인다(pi-ai의 기존 순서).
2. **Anthropic은 API 키로만.** CR-001대로 Anthropic 구독 OAuth는 시작하지 않는다. 서버는 `anthropic`의 OAuth 로그인 요청을 거절하고, 화면에는 키 입력만 보인다.
3. **OpenAI 호환 엔드포인트.** `.corral/config.json`에 `modelProviders`를 추가한다.
   ```json
   { "id": "ollama", "name": "Ollama", "baseUrl": "http://127.0.0.1:11434/v1", "access": "none",
     "models": [{ "id": "llama3.2", "contextWindow": 128000, "maxOutput": 4096 }] }
   ```
   - `access`: `api_key`(화면에서 넣은 키) 또는 `none`(키 없음, 로컬 서버용).
   - id는 pi-ai 내장 provider id와 겹칠 수 없다.
   - `baseUrl`은 `https:`만 허용한다. 예외로 `http:`는 loopback(`localhost`·`127.0.0.1`·`[::1]`)만 허용한다. 사용자 정보(`user:pass@`)와 query·fragment는 거절한다.
   - pi-ai의 `openai-completions` API로 호출한다. 설정 필드 이름에는 credential 검사 규칙(`key|token|secret|password|credential|auth`)에 걸리지 않는 이름을 쓴다(`access`, `maxOutput`).
4. **키는 엔드포인트에 묶는다.** 사용자 정의 provider에 넣은 키는 넣을 때의 `baseUrl` origin과 함께 저장한다. 작업 공간 설정의 origin이 바뀌면 그 키를 쓰지 않고 "엔드포인트가 바뀌었습니다. 키를 다시 넣으세요"로 보인다. 작업 공간 파일(예: 내려받은 저장소의 `.corral/config.json`)이 저장된 키를 다른 호스트로 보내게 만들 수 없다.
5. **worker.** 모델 worker는 시작 frame으로 사용자 정의 provider의 비밀 아닌 정의(이름·baseUrl·모델 한도)를 받아 그 provider를 등록한다. 키는 지금처럼 요청 permit과 함께만 받는다(ADR-019, CR-004 제안 6).
6. **화면.** provider 카드는 인증 방식별로 보인다: OAuth 로그인, API 키 입력/지우기, "키 필요 없음(로컬 엔드포인트)". 사용자 정의 provider는 엔드포인트 host를 함께 보인다(경로·키 없음).

## 이유

CR-001 §2의 확장 목표(Pi가 지원하는 provider와 인증 방식 전체, Anthropic은 API 키)를 화면에서 쓸 수 있게 한다. 환경 변수만으로는 Studio 사용자가 키를 바꾸거나 지우기 어렵다. Ollama 같은 로컬 모델은 비용 없이 live Run을 해 볼 수 있는 경로다.

## 기존 합의와 충돌

ADR-019의 "API 키는 환경 변수에서 읽는다"를 "환경 변수 또는 서버 측 credential store"로 넓힌다. 스펙 §10.2 문구("backend 환경/서버 측 credential store")와는 이미 맞는다. 저장 위치·권한·노출 금지는 바뀌지 않는다.

## 테스트

- TC-SEC-002-H/N: 키 저장 → 상태는 "API 키", 응답·페이지·credential 외 파일에 키 없음. 지우기 후 live Run 거절. 빈 키·너무 긴 키 거절.
- Anthropic OAuth 시작 요청 거절, 키로는 Run 시작.
- `modelProviders` 검사: 내장 id 충돌, 비 loopback `http:`, userinfo·query가 있는 URL, credential 같은 필드 이름 거절.
- 키-엔드포인트 묶음: origin이 바뀐 설정에서는 키를 쓰지 않음(요청이 나가지 않음).
- `access: none` provider: 키 없이 Run, 화면은 "키 필요 없음".
- worker: 시작 frame의 사용자 정의 provider로 호출, 정의에 비밀 없음.
- E2E: 모델 화면에서 키 넣기/지우기, 페이지에 키 없음.

## 일정·영향

새 의존성 없음. 설정 스키마(`modelProviders`), 서버 모델 registry·API, worker 시작 frame, 모델 화면이 바뀐다. 실제 확인은 유료 호출 없이 로컬 Ollama가 있으면 1회, 없으면 하지 않았다고 기록한다.

## 진행 결과 (2026-10-16)

- 구현:
  - 설정 스키마 `modelProviders`(`packages/core/src/config.ts`).
  - pi-ai provider 생성과 worker 시작 frame의 엔드포인트 정의, keyless 엔드포인트의 키 차단(`packages/adapter-pi/src/endpoint.ts`, `worker.ts`, `worker-main.ts`).
  - 서버 등록·origin 묶음(`apps/server/src/models/endpoints.ts`), registry의 `setApiKey`·`methods`·`endpoint`·`endpointChanged`, `source: environment`, `PUT /api/v1/model-auth/:providerId/api-key`.
  - 모델 화면의 키 입력/지우기, 엔드포인트 표시, en/ko 메시지.
- 결정:
  - keyless 엔드포인트에는 고정 자리표시자 키 `no-key`를 보낸다. pi-ai의 OpenAI 클라이언트가 빈 키를 거절하기 때문이며, Ollama 문서도 OpenAI 클라이언트에 아무 키나 넣으라고 안내한다.
  - 지원하지 않는 로그인 방식은 `COMMAND_NOT_SUPPORTED`(501)로 답한다.
- 테스트:
  - core config 2.
  - adapter-pi: endpoint 2, 실제 worker 프로세스 2(keyless·keyed). 로컬 가짜 OpenAI 호환 서버(`@corral/testkit/endpoint`)를 상대로 pi-ai의 실제 `openai-completions` 클라이언트를 쓴다.
  - 서버 5.
  - Studio E2E 2(키 입력·지우기, keyless 엔드포인트 live Run).
  - 결과: 전체 단위 테스트 561 통과.
- 실제 확인: **하지 않았다.** 이 컴퓨터에 Ollama·LM Studio가 없다(127.0.0.1:11434, :1234 응답 없음). 유료 API 키 호출은 하지 않았다.
- 남은 점: 프로필·엔드포인트는 아직 `.corral/config.json`으로만 편집한다(화면 편집은 후속).

## 2026-10-19 엔드포인트 키 입력과 표시

Bell이 연결 ID/표시 이름을 구분할 수 없고 API 키를 선택해도 입력란을 찾을 수 없다고 보고했다. 두 필드에 보이는 라벨과 ID/선택 표시 이름의 용도를 붙인다. API 키 선택 시 편집 영역 안에 키 입력란을 표시한다. 기존 공급자 카드와 새 입력란 모두 기본 password이며 눈 아이콘으로 입력 중인 값만 표시/숨기기 한다. 저장된 키를 다시 조회하는 기능은 아니다.

기존 비밀 아닌 config 저장과 credential 저장 API를 순서대로 재사용한다. 키는 별도 메모리 상태에만 두고 config·브라우저 저장소에 넣지 않는다. 성공한 키는 즉시 비우며 endpoint ID/주소/인증 방식 변경 또는 삭제 때 입력 키를 지운다. config 성공 후 키 저장 실패는 부분 성공으로 정확히 안내하고 현재 config를 새 기준으로 삼아 남은 키를 재시도할 수 있게 한다.

프로필이 아직 없는 등록 엔드포인트도 인증 카드/키 저장 대상으로 포함한다. 키 저장 요청의 optional `revision`이 현재 파일과 다르면 credential을 쓰기 전에 거절한다. 편집기는 config 저장 응답의 revision을 전달하여 저장 사이 다른 주소로 변경된 연결에 키를 붙이지 않는다. 기존 origin-bound credential과 API 호환성을 유지한다.

TC-SEC-002-H/N의 기존 인증 시험을 확장하여 프로필 없는 엔드포인트·stale revision 거절, inline 키 가림/표시·별도 저장·부분 실패 재시도·비밀 없는 config를 확인한다. 실제 키 입력/유료 호출은 사용자가 수행하며 fixture는 가짜 키만 사용한다.

### 검증 결과

- `endpoint-key-server-red.log`: 프로필 없는 등록 endpoint가 인증 목록에 없는 실패를 확인했다. `endpoint-key-browser-red.log`: inline 키 필드와 기존 키 필드의 표시 버튼이 없는 실패를 확인했다.
- `endpoint-key-server-green.log`: 기존 인증·origin 묶음·설정 충돌·Hive 포함 23개 통과. `endpoint-key-browser-green2.log`: 가림/표시, 주소 변경 시 입력 키 삭제, 부분 실패 후 재시도, 설정에 키 없음과 기존 모델 흐름을 포함한 11개 통과. 첫 회귀에서 표시 버튼도 매칭한 넓은 label locator를 입력란의 정확한 이름으로 좁혔다.
- 전체 타입, production build, spec 1,929 checks / 253 tags, 변경 파일 Biome·diff 검사 통과. 기존 Input/Button/Lucide를 재사용했으며 새 의존성은 없다.
- 활성 Run 0을 확인하고 개발 서버를 재시작했다. 실제 인앱 화면에서 ID/표시 이름 라벨과 password/눈 아이콘을 확인하고, 공개 Hive 설정 및 `deepseek-hive` 프로필을 미저장 초안으로 준비했다. 실제 키는 입력하거나 저장하지 않았다. Hive 유료 추론 호출·실서비스 도구 호출은 미검증이다.
