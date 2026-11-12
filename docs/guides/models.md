# 모델 연결

로컬 서버의 **Models** 화면 **연결** 탭에서 모델 공급자에 연결한다. 빌드된 화면은 `pnpm serve` 또는 `pnpm corral dev`로 열고, 화면을 고치면서 쓰려면 `pnpm dev --live`로 연다. `pnpm dev --live`는 Studio를 빌드하지 않으며, 터미널에 나온 `http://localhost:5173/#bootstrap=…`로 연다. **연결 추가**는 Pi가 지원하는 모든 공급자를 보여 준다. 연결된 공급자의 모델은 프로필을 만들지 않아도 모델 선택기에 나온다([명세](../specs/features/model-connections.md)). 자격 증명은 작업 공간 밖 사용자 설정 디렉터리(`$XDG_CONFIG_HOME/corral` 또는 `~/.config/corral`, Windows `%APPDATA%\corral`)의 `credentials.json`(0600)에만 저장한다. Corral 정의·SQLite·이벤트·export·화면에는 나오지 않는다.

## 연결 방법

| 방법 | 쓰는 곳 | 비고 |
|---|---|---|
| 구독 로그인 | OpenAI(ChatGPT), Anthropic(Claude), GitHub Copilot 등 Pi가 구독 로그인을 지원하는 공급자 | 공급자 페이지에서 직접 로그인. 토큰은 서버가 갱신. 그 구독이 부를 수 있는 모델만 나온다 |
| Codex CLI 로그인 | `openai-codex` | Corral 로그인이 없고 `~/.codex/auth.json`(또는 `$CODEX_HOME`)이 있으면 읽기 전용으로 사용. 갱신·수정하지 않으므로 만료되면 `codex`를 다시 실행 |
| API 키 입력 | API 키를 받는 공급자(OpenAI, Anthropic 등)와 사용자 정의 엔드포인트 | Models 화면에 입력. 다시 보여 주지 않으며 "키 지우기"로 삭제 |
| 환경 변수 | 같음 | 예: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`. 입력한 키가 있으면 그것이 우선 |

구독 로그인과 API 키 중 무엇을 쓸지는 사용자가 정한다. 구독을 다른 앱에서 쓰는 것을 허용하는지는 공급자의 약관을 따른다.

## 프로필

프로필은 모델에 붙인 이름이다(`model-a`, `model-b` 등). 기본 팀은 이 이름으로 모델을 가리키고, 프로필마다 컨텍스트와 압축 값을 따로 정할 수 있다. 연결된 공급자의 다른 모델은 프로필 없이 바로 고를 수 있으므로, 이름이나 모델별 설정이 필요할 때만 프로필을 만든다. 프로필 수에는 한도가 없다. Models 화면의 **모델 편집**에서 고르거나, 작업 공간의 `.corral/config.json`을 직접 고친다. 화면에서 저장하면 두 키(`modelProfiles`, `modelProviders`)만 바뀌고 서버를 다시 시작하지 않아도 다음 Run부터 쓰인다.

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

`modelProviders`에 엔드포인트를 선언한다. 주소와 인증만 적으면 서버가 그 주소의 `/models`에서 모델 목록을 가져오고, 한도와 능력은 응답과 models.dev 카탈로그에서 채운다. `models`에 적은 항목은 가져온 목록에 더해지고 같은 ID면 적은 값이 이긴다. 가져온 목록은 설정 파일에 쓰지 않는다. 이름이나 모델별 설정이 필요하면 프로필에서 그 id를 쓴다.

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
- 설정, `/models` 응답, models.dev 어디에도 한도가 없는 모델은 context 32,000, 출력 4,096 토큰을 쓴다.
- 추론을 지원하는 모델은 `low`, `medium`, `high`를 OpenAI식 `reasoning_effort`로 보낸다. 그 형식을 받지 않는 서버에서는 그 모델에 `"reasoning": false`를 적는다.

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

## 추론 판정: 설치와 되돌리기

추론 선택이 **자동**인 요청의 수준을 요청마다 판정 엔진 하나가 고르게 하는 설정이다. 동작 계약과 지원 환경은 [추론 판정 명세](../specs/features/effort-routing.md)가 정한다. 기본은 Off이며 Off에서는 판정·다운로드·외부 전송이 없다.

Local 판정 모델을 켜는 순서:

1. 설정 → 모델 → **추론 판정**에서 **직접 선택**과 **Local 판정 모델**을 고른다.
2. **설치**를 누른다. 내려받을 크기(약 1.1 GB)가 표시되고, 받는 중에는 **설치 취소**로 멈출 수 있다. 저장만으로는 내려받지 않는다.
3. **저장**한다. 설치된 엔진은 백그라운드에서 준비되어 상태가 **준비됨**이 된다.
4. 역할·노드나 입력창의 추론을 **자동**으로 둔다. 고정 수준과 공급자 기본값은 판정하지 않는다.

대화의 각 모델 요청을 펼친 **요청 상세**에 판정 한 줄(예: `Local · CPU · 추천 low → 적용 low · 420ms`)이 보이고, 누르면 분포·장치·시간을 연다. 실행 정보의 사용량 탭은 판정한 요청과 이유별 대체 횟수를 센다.

되돌리기는 **끄기**를 고르고 저장하면 된다. Corral이 시작한 판정 프로세스가 끝나고, 자동 요청은 공급자 기본값으로 나간다. 설치 파일은 남으므로 다시 켤 때 내려받지 않는다. 디스크에서 지우려면 Corral을 끈 뒤 데이터 폴더(Linux `$XDG_DATA_HOME/corral` 또는 `~/.local/share/corral`)의 `local-ai/d1/` 폴더를 지운다. 회의 분석 번들은 같은 `local-ai/` 아래 다른 폴더라 함께 지우지 않는다.

| 화면 | 할 일 |
|---|---|
| 오류로 멈춤 | 판정 프로세스가 예기치 않게 끝났다. 자동으로 다시 띄우지 않으므로 **다시 준비**를 누른다 |
| 실행 기록의 `시간 초과 → 공급자 기본값` | 그 요청은 기다리지 않고 나갔다. 자주 보이면 고급의 최대 대기 시간을 늘린다 |
| 다른 판정 중, 준비 안 됨 | 판정은 한 번에 하나이고, 준비 중이거나 내려간 뒤 첫 요청은 기다리지 않는다. 다음 요청부터 판정한다 |
| 이 컴퓨터에서 사용할 수 없음 | Corral 서버가 Local 지원 환경이 아니다. **판정 API**를 고를 수 있다 |

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

편집 중 추론 판정 설정 등 다른 설정을 저장하면 기존 초안 저장은 충돌로 거절된다. 입력은 남지만, 취소 후 다시 열어 최신 설정에서 편집해야 한다. 저장 실패가 이미 실행 중인 Run 정책을 바꾸지는 않는다.
