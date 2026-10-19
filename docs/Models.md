# 모델 연결

로컬 서버(`pnpm serve` 또는 `pnpm corral dev`)의 **Models** 화면에서 모델 공급자에 연결한다. 자격 증명은 작업 공간 밖 사용자 설정 디렉터리(`$XDG_CONFIG_HOME/corral` 또는 `~/.config/corral`, Windows `%APPDATA%\corral`)의 `credentials.json`(0600)에만 저장한다. Corral 정의·SQLite·이벤트·export·화면에는 나오지 않는다([ADR-019](Decisions.md)).

## 연결 방법

| 방법 | 쓰는 곳 | 비고 |
|---|---|---|
| ChatGPT로 로그인 | OpenAI | 공급자 페이지에서 직접 로그인. 토큰은 서버가 갱신 |
| Codex CLI 로그인 | `openai-codex` | Corral 로그인이 없고 `~/.codex/auth.json`(또는 `$CODEX_HOME`)이 있으면 읽기 전용으로 사용. 갱신·수정하지 않으므로 만료되면 `codex`를 다시 실행([CR-004](change-requests/CR-004-codex-login-reuse.md)) |
| API 키 입력 | API 키를 받는 공급자(OpenAI, Anthropic 등)와 사용자 정의 엔드포인트 | Models 화면에 입력. 다시 보여 주지 않으며 "키 지우기"로 삭제 |
| 환경 변수 | 같음 | 예: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`. 입력한 키가 있으면 그것이 우선 |

Anthropic 구독(Pro/Max) 로그인은 지원하지 않는다. Anthropic은 API 키로 연결한다([CR-001](change-requests/CR-001-openai-oauth-first.md)).

## 프로필

에이전트는 프로필 이름(`model-a`, `model-b` 등)으로 모델을 고른다. Models 화면의 **모델 편집**에서 고르거나, 작업 공간의 `.corral/config.json`을 직접 고친다. 화면에서 저장하면 두 키(`modelProfiles`, `modelProviders`)만 바뀌고 서버를 다시 시작하지 않아도 다음 Run부터 쓰인다([CR-008](change-requests/CR-008-model-settings-editing.md)).

```json
{
  "schemaVersion": "0.1",
  "modelProfiles": [
    { "id": "model-a", "provider": "anthropic", "model": "claude-sonnet-5-5" },
    { "id": "model-b", "provider": "ollama", "model": "llama3.2" }
  ]
}
```

프로필이 없으면 OpenAI 프로필 두 개를 쓴다. Corral 자체 로그인이 없고 Codex 로그인이 있으면 같은 모델을 `openai-codex`로 쓴다.

## OpenAI 호환 엔드포인트 (Ollama, LM Studio, OpenRouter)

`modelProviders`에 엔드포인트를 선언하고 프로필에서 그 id를 쓴다([CR-005](change-requests/CR-005-api-keys-and-compatible-endpoints.md)).

```json
{
  "schemaVersion": "0.1",
  "modelProviders": [
    {
      "id": "ollama",
      "name": "Ollama",
      "baseUrl": "http://127.0.0.1:11434/v1",
      "access": "none",
      "models": [{ "id": "llama3.2", "contextWindow": 128000, "maxOutput": 4096 }]
    },
    {
      "id": "router",
      "name": "OpenRouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "access": "api_key",
      "models": [{ "id": "deepseek/deepseek-chat" }]
    }
  ],
  "modelProfiles": [
    { "id": "model-a", "provider": "ollama", "model": "llama3.2" },
    { "id": "model-b", "provider": "router", "model": "deepseek/deepseek-chat" }
  ]
}
```

- `baseUrl` 규칙:
  - `https:`만 허용한다. 예외로 `http:`는 `localhost`, `127.0.0.1`, `[::1]`에만 허용한다.
  - 주소에 사용자 정보, query, fragment를 넣을 수 없다.
- `access`:
  - `"none"`: 키가 없는 로컬 서버용이다. 고정 자리표시자 `no-key`만 보내고, 저장된 키는 보내지 않는다.
  - `"api_key"`: Models 화면에서 넣은 키를 쓴다.
- 키는 넣을 때의 주소(origin)에 묶인다. 설정의 `baseUrl` origin이 바뀌면 그 키를 쓰지 않는다. 화면에는 "키를 다시 넣으세요"가 보인다.
- id는 pi-ai 내장 공급자 이름(`openai`, `anthropic` 등)과 겹칠 수 없다.
- 설정 파일에는 키를 넣을 수 없다. 키처럼 보이는 필드가 있으면 서버가 시작을 거부한다.
- 알려진 모델 외에는 모델 한도를 빼면 context 32,000, 출력 4,096 토큰을 쓴다.

## Hive의 DeepSeek V4.1 Flash

Models → 모델 편집에서 엔드포인트와 프로필을 추가한다. 이 연결은 DeepSeek 직접 API가 아닌 Hive 서비스 API 키를 사용한다.

| 필드 | 값 |
|---|---|
| 엔드포인트 ID / 이름 | `hive` / `Hive` |
| API 주소 | `https://api-cdn.thehive.ai/api/v3` |
| 인증 | API 키 |
| 모델 ID | `deepseek-ai/deepseek-v4.1-flash-1017` |
| 새 프로필 ID / 공급자 | `deepseek-hive` / `hive` |

인증을 API 키로 고르면 바로 아래에 키 입력란이 나온다. 기본적으로 가려지며 눈 아이콘으로 입력 중인 값만 표시하거나 숨긴다. **모델 저장**은 설정을 먼저 저장하고 키를 별도 credential 저장소에 보관한다. 키만 저장에 실패하면 입력을 유지하므로 다시 저장해 재시도한다. 빈 키는 기존 키를 유지하며, 저장된 키는 다시 불러오지 않는다. 엔드포인트 저장 후 Hive 카드에서도 키를 넣을 수 있다.

`hive`는 프로필이 참조하는 연결 ID이고 `Hive`는 선택적인 표시 이름이다. 표시 이름은 비워도 된다. 기존 OpenAI 프로필은 유지하고 새 프로필을 추가한다. 키는 채팅이나 `.corral/config.json`에 적지 않는다. VA1 계정은 `https://api-va1.thehive.ai/api/v3`를 사용하고, origin 변경 시 해당 주소에서 사용할 키를 다시 입력한다.

아래는 기존 설정의 각 배열에 추가할 항목이다. 기존 배열 전체를 덮어쓰지 않는다.

```json
{
  "modelProviders": [{
    "id": "hive",
    "name": "Hive",
    "baseUrl": "https://api-cdn.thehive.ai/api/v3",
    "access": "api_key",
    "models": [{ "id": "deepseek-ai/deepseek-v4.1-flash-1017" }]
  }],
  "modelProfiles": [{
    "id": "deepseek-hive",
    "provider": "hive",
    "model": "deepseek-ai/deepseek-v4.1-flash-1017"
  }]
}
```

공식 두 주소와 정확한 모델 ID에는 context 1,000,000, 이미지 입력, `off/low/high/max` 추론을 등록한다. 출력 기본 상한은 기존 4,096을 유지하며 명시한 모델 한도·기능 설정이 우선한다. Pi 1.3.0의 `thinkingLevelMap`과 OpenAI completions compatibility를 사용해 `off`는 `none`, `max`는 `max`로 보낸다. provider default는 effort를 생략한다. 모델 ID가 같더라도 다른 gateway에 이 설정을 적용하지 않는다.

근거: [Hive 모델 API](https://docs.thehive.ai/docs/deepseek-v41-flash), [연결·인증·도구 호출 문서](https://docs.thehive.ai/docs/chat-completions-openai-compatible-llms). Hive 요청은 `max_completion_tokens`와 SSE를 사용한다. 2026-10-19 별도 opt-in 시험에서 실제 Hive 모델의 `high` 요청 2회와 산출물 작성·제출, usage 응답을 확인했다. 모델 품질 개선·최대 추론의 실제 청구량·복수 제공자 전체 live Ultra 검증과는 구분한다. 비용 정보가 없는 사용자 정의 엔드포인트를 무료라고 해석하지 않는다.

## 복수 모델 Ultra

자동 세션에서 **Ultra** 또는 `/ultra`를 선택하면 참여 모델과 필수 검토 모델을 고를 수 있다. 최소 서로 다른 모델 2개, 최대 5개다. 주 모델이 계획·실행·종합하고, 선택한 다른 모델이 종합본을 검토한다. 필요한 경우 읽기 전용 보조 에이전트를 병렬로 사용한다. 같은 회사의 다른 모델도 가능하며, 같은 모델의 프로필 별칭 두 개는 서로 다른 모델로 세지 않는다.

Ultra는 각 모델에서 검증된 최고 추론 단계를 사용한다. 일반 모드에 저장한 추론 강도는 바꾸지 않는다. 미연결 모델이나 최고 추론 매핑이 확인되지 않은 모델은 시작 전에 거절한다. 선택한 연결에는 이번 요청·첨부·허용한 프로젝트 자료·파생 결과가 전달될 수 있다.

기존 총예산 안에서 동시 모델 요청 최대 3개, 활성 보조 에이전트 2개, 전체 위임 4개, 수정 최대 2회다. 남은 필수 단계의 최소 호출/출력을 보호하며 예산 80% 경계에서는 새 선택 위임과 수정을 멈춘다. 이는 마무리 성공 보장이나 실제 금액 상한이 아니다. 모델 검토 통과는 프로젝트 테스트 실행·통과를 뜻하지 않는다.

CLI 예시(연결된 프로필 ID를 사용):

```sh
pnpm corral exec auto --ultra --model-profile model-b \
  --ultra-models model-b,deepseek-hive --ultra-verifier deepseek-hive \
  --input brief.txt
```

새 Ultra CLI의 `--effort`는 허용하지 않는다. HTTP 자동 실행 요청에는 기존 `qualityPreset: "ultra"`와 함께 `ultra: {"version": 1, "modelProfiles": ["model-b", "deepseek-hive"], "verifierProfile": "deepseek-hive"}`를 전달하고 `choice.reasoning`을 생략한다. 선택과 해석된 추론 단계는 Run snapshot에 남으며 실행 도중 모델 교체는 새 Run이 필요하다. 과거 `ultra` 선택 필드가 없는 단일 모델 기록은 기존 방식으로 해석한다.
