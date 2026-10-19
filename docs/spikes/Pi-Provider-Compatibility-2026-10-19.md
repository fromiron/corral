# Pi 제공자 호환 기준과 현재 범위

Bell의 “다른 프로바이더도 최대한 Pi에 맞춘다”는 지시를 C-118에 반영한다. 기준은 설치된 `@earendil-works/pi-ai@1.3.0`의 공개 카탈로그/모델 타입/직렬화다. 다른 하네스의 별도 모델 목록이나 effort 표를 복사하지 않는다. 새 의존성은 없다.

## 적용 원칙

- 연결과 모델 정보는 Pi의 `builtinModels`, `getModels`, `getSupportedThinkingLevels`, `thinkingLevelMap`, API별 `compat`, credential/stream 경로를 사용한다.
- Corral은 고정된 역할·모델 선택, 권한, permit, 총예산, 취소/정산을 담당한다. Pi가 사용하는 provider별 thinking 형식이나 토큰 예산을 OpenAI의 `reasoning_effort`로 통일하지 않는다.
- `maximum_supported`는 Pi가 해당 모델에 지원한다고 명시한 단계 중 최고다. 명칭만 보고 `max`를 만들어 보내지 않는다. 실제 serializer와 요청 경계 검증이 준비된 API 계열에서만 Ultra에 사용할 수 있다.
- 지원 추론 identity에는 API/모델/단계/매핑뿐 아니라 전체 `compat`, `thinkingLevelMap`, 모델 `maxTokens`를 포함한다. 같은 모델 ID라도 직렬화 조건이 바뀌면 기존 해석을 그대로 사용하지 않는다.
- 제공자 기본값, 명시 off, 고정 최고 단계를 구분한다. OAuth/API key 및 endpoint별 차이는 실제 Pi 요청으로 확인한다. 한 permit의 추가 요청·다른 주소·변조된 설정·취소 뒤 전송은 허용하지 않는다.

## 카탈로그 확인 결과

2026-10-19 설치 버전의 카탈로그는 **42 provider, 1,614 모델, 10 API 계열**이다. 아래는 로컬 metadata 조회 결과이며 실제 계정의 접근 권한이나 모든 모델의 통합 검증을 뜻하지 않는다. `Corral 추론 노출`은 현재 metadata gate를 통과하는 모델 수이며 개별 모델의 live 시험 수가 아니다.

| Pi API | 전체 모델 | 추론 모델 | Corral 추론 노출 |
|---|---:|---:|---:|
| openai-responses | 132 | 115 | 115 |
| openai-codex-responses | 9 | 9 | 9 |
| openai-completions | 720 | 602 | 24 |
| anthropic-messages | 401 | 353 | 0 |
| google-generative-ai | 32 | 32 | 0 |
| google-vertex | 14 | 14 | 0 |
| azure-openai-responses | 44 | 32 | 0 |
| bedrock-converse-stream | 193 | 151 | 0 |
| mistral-conversations | 40 | 11 | 0 |
| pi-messages | 29 | 29 | 0 |

일반 모델 연결/기본 실행과 Ultra의 검증된 추론 지원은 서로 다르다. 현재 일반 Pi 연결이 가능한 제공자라도 위 gate가 준비되지 않았다면 Ultra 선택이 비활성화된다. 이 제한을 “Pi 전체 제공자 지원 완료”라고 표시하지 않는다.

## 실제 소스에서 확인한 다음 경계

- **Anthropic**: `api/anthropic-messages`의 `streamSimple`은 adaptive 모델의 effort와 구형 모델의 thinking budget을 다르게 처리한다. `api/simple-options.adjustMaxTokensForThinking`은 답변 cap에 thinking budget을 더할 수 있다. Corral permit을 넘지 않는 총 출력 한도와 답변 여유를 검증하기 전에는 임의로 지원 gate를 열지 않는다. mid-conversation effort marker와 SDK가 body의 `betas`를 HTTP header로 옮기는 경로도 고려해야 한다.
- **Google / Vertex**: `api/google-generative-ai`, `api/google-vertex`, `api/google-shared`는 모델별 thinking level/budget을 사용한다. `onPayload`의 `config` 객체와 실제 HTTP JSON은 같지 않으므로 OpenAI의 payload equality 규칙을 그대로 복사하지 않는다. Vertex 인증도 별도 확인한다.
- **Azure / Bedrock / Mistral / Pi Messages 및 다른 completions 변형**: 각 Pi serializer의 auth, output cap, reasoning, retry/cancel, 최종 HTTP/SDK 요청 형태를 묶어서 검증한다. 이 단계는 아직 미완료다.

공통으로 필요한 검증은 대표 정상 요청, cap/effort 변조, 취소 후 전송, 추가 dispatch 차단이다. 일반 CI는 가짜 자격 증명과 로컬/가짜 HTTP를 사용한다. 실제 서비스 호출은 별도 opt-in 한도 안에서만 수행한다.

## 이번 수정 증거

`pi-compat-identity-red.log`에서 모델 출력 상한·compat 변경을 기존 identity가 놓치는 실패를 확인했다. fingerprint를 보완한 뒤 `pi-compat-identity-green.log`에서 기존 provider/worker/모델 registry/Ultra 포함 99개, `pi-compat-identity-isolation.log`에서 실제 Linux worker/로컬 HTTP 17개가 통과했다. adapter 타입 검사와 spec 1,933 checks / 253 tags도 통과했다. 새 provider의 wire 구현을 이 fingerprint 수정만으로 완료 처리하지 않는다.
