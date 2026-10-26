# 모델 연결

로컬 서버(`pnpm serve` 또는 `pnpm corral dev`)의 **Models** 화면에서 모델 공급자에 연결한다. 자격 증명은 작업 공간 밖 사용자 설정 디렉터리(`$XDG_CONFIG_HOME/corral` 또는 `~/.config/corral`, Windows `%APPDATA%\corral`)의 `credentials.json`(0600)에만 저장한다. Corral 정의·SQLite·이벤트·export·화면에는 나오지 않는다.

## 연결 방법

| 방법 | 쓰는 곳 | 비고 |
|---|---|---|
| ChatGPT로 로그인 | OpenAI | 공급자 페이지에서 직접 로그인. 토큰은 서버가 갱신 |
| Codex CLI 로그인 | `openai-codex` | Corral 로그인이 없고 `~/.codex/auth.json`(또는 `$CODEX_HOME`)이 있으면 읽기 전용으로 사용. 갱신·수정하지 않으므로 만료되면 `codex`를 다시 실행 |
| API 키 입력 | API 키를 받는 공급자(OpenAI, Anthropic 등)와 사용자 정의 엔드포인트 | Models 화면에 입력. 다시 보여 주지 않으며 "키 지우기"로 삭제 |
| 환경 변수 | 같음 | 예: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`. 입력한 키가 있으면 그것이 우선 |

Anthropic 구독(Pro/Max) 로그인은 지원하지 않는다. Anthropic은 API 키로 연결한다.

## 프로필

에이전트는 프로필 이름(`model-a`, `model-b` 등)으로 모델을 고른다. Models 화면의 **모델 편집**에서 고르거나, 작업 공간의 `.corral/config.json`을 직접 고친다. 화면에서 저장하면 두 키(`modelProfiles`, `modelProviders`)만 바뀌고 서버를 다시 시작하지 않아도 다음 Run부터 쓰인다.

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

`modelProviders`에 엔드포인트를 선언하고 프로필에서 그 id를 쓴다.

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

근거: [Hive 모델 API](https://docs.thehive.ai/docs/deepseek-v41-flash), [연결·인증·도구 호출 문서](https://docs.thehive.ai/docs/chat-completions-openai-compatible-llms). Hive 요청은 `max_completion_tokens`와 SSE를 사용한다. 2026-10-19 별도 opt-in 시험에서 실제 Hive 모델의 `high` 요청 2회와 산출물 작성·제출, usage 응답을 확인했다. 모델 품질 개선·최대 추론의 실제 청구량과는 구분한다. 비용 정보가 없는 사용자 정의 엔드포인트를 무료라고 해석하지 않는다.

## Ultra (제거됨)

복수 모델 Ultra와 후보 비교·경쟁은 제거됐다. 입력창·`/ultra`·HTTP·CLI(`--ultra`, `--ultra-models`, `--ultra-verifier`)·회의 인계 어디에서도 시작할 수 없다. 이전 Ultra Run은 더 이상 열리지 않는다. 세션에는 Ultra가 제거되어 열 수 없다는 안내가 표시되고, 끝나지 않은 Run은 다른 Run처럼 재시작 때 중단된다. Ultra로 저장된 회의 인계는 시작할 수 없다. 모델 프로필의 최고 추론 단계 메타데이터와 요청별 추론 적용은 Ultra와 별개로 유지한다.

## 사용량 한도 없음

일반 실행과 회의 모두 기본 사용량 예산이 없다. 사용자가 명시한 예산만 적용하며, 호출당 출력은 모델 한도와 남은 컨텍스트 공간을 따른다. 진행 없음은 관측한 증거 변화에 따른 경고이며, 기본 무제한 실행을 횟수만으로 종료하지 않는다. 끝나지 않는 실행은 **직접 취소할 때까지** 계속되고 비용이 발생한다. 공급자 쪽 사용량 제한·과금은 그대로다. 사용량 화면은 한도 대신 확인된 출력·호출 수·진행 중·사용량 미확인 호출을 보여 주며 미확인 사용량을 0으로 계산하지 않는다. 모델 요청 동시성 기본값은 6, resident execution 기본값은 12이며 사용량 예산과 별도로 설정한다.

## 프로필 컨텍스트와 압축

모델 편집에서 프로필별 **컨텍스트 창**, **요약 여유 토큰**, **최근 기록 토큰**을 지정할 수 있다. 빈 칸은 상속, `0`은 명시값이다. 컨텍스트는 1~10,000,000, 압축값은 0 이상의 안전한 정수만 받는다.

```json
{
  "id": "deepseek-hive",
  "provider": "hive",
  "model": "deepseek-ai/deepseek-v4.1-flash-1017",
  "contextWindow": 120000,
  "compaction": { "reserveTokens": 16384, "keepRecentTokens": 20000 }
}
```

컨텍스트는 프로필 명시값 → 해당 연결 모델의 명시값 → 같은 provider/model 카탈로그 → 연결 기본값 순서다. 압축 기본값은 PI-Desktop에서 이식한 모델 window·출력 한도 비례 정책이다. 새 명시 정책은 `reserve < context`, `keep < context - reserve`를 만족해야 한다. 관계가 잘못된 새 설정은 거절하며 과거 snapshot은 당시 정책으로 읽는다. 모든 입력을 지우면 기본 경로로 돌아간다.

화면은 입력값과 별도로 유효값·출처·추정 압축 임계점·설정 버전을 표시한다. 공통 자동 압축 조건은 계측 입력이 `floor((context - reserve) × 0.9)`보다 **클 때**다. 실제 provider overflow는 별도로 한 번 압축 복구를 시도한다. `reserve=0`은 압축 끄기가 아니며 `keep=0`도 모든 원문 제거를 보장하지 않는다. reserve는 일반 응답 길이 설정이 아니다. 요약 요청의 최종 출력 한도는 기존 Corral permit을 따른다.

Core와 SDK에 같은 압축 엔진을 적용한다. SDK 공개 요청 준비 hook과 session compaction entry를 사용하며 SDK 내부 자동 압축·retry와 중복 실행하지 않는다. 이 설정은 공급자의 실제 컨텍스트 한도를 늘리지 않는다.

값은 자동 선택 최초 호출 전부터 Run에 고정된다. 실행 중 설정을 바꿔도 후속 역할·하위 에이전트·지원 재개는 원래 값을 사용한다. 다음 Run과 실제 시작되는 대기 요청부터 새 값을 쓴다. 과거 정책이 기록되지 않은 Run은 현재 설정으로 추정하지 않는다.

편집 중 자동 추론 스위치 등 다른 설정을 저장하면 기존 초안 저장은 충돌로 거절된다. 입력은 남지만, 취소 후 다시 열어 최신 설정에서 편집해야 한다. 저장 실패가 이미 실행 중인 Run 정책을 바꾸지는 않는다.
