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

에이전트는 프로필 이름(`model-a`, `model-b` 등)으로 모델을 고른다. 작업 공간의 `.corral/config.json`에서 정한다.

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
- 모델 한도를 빼면 기본값을 쓴다: context 32,000, 출력 4,096 토큰.
