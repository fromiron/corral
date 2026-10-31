# 기능 명세: 판정 API

- 상태: accepted
- 비목표: 임의 엔드포인트나 요청 형식을 받는 범용 판정 API, 한 요청에서 여러 판정 API를 잇거나 평균 내기, 모델 로그인(OAuth)이나 모델 공급자 키로 판정 API 호출, 판정 API 비용 계산과 실행 예산 반영, 같은 종류의 연결 여러 개.

## 사용자 관측 동작

설정 → 모델의 **판정 API** 섹션에서 판정 전용 API를 연결한다. 모델 로그인이나 모델 공급자 키와는 별개다.

- 지원 목록과 각 항목의 연결 상태(키 있음 / 없음), 키 입력, 키 삭제를 보여준다.
- OpenAI Decisions는 OpenAI 플랫폼 API 키로만 연결한다. ChatGPT 로그인이나 모델 설정의 OpenAI 키를 대신 쓰지 않는다.
- 섹션은 판정 API로 보내는 범위와 공급자 문서에 적힌 데이터 보존 내용을 보여준다.
  - TypeSafe Jev: API 문서에 보존 정책이 없다.
  - OpenAI Decisions: API 데이터를 학습에 쓰지 않고 남용 모니터링 로그를 최대 30일 보관한다고 문서에 적혀 있다.
  - 문서에 없는 정책은 지어내지 않는다.

자동 추론에서 어느 판정 API를 쓸지는 로컬 AI 패널의 "외부 판정 보완"에서 고른다(사용 안 함 / 키가 있는 판정 API). 언제 부르고 답을 어떻게 적용하는지는 [로컬 AI](local-intelligence.md#외부-판정)가 정한다.

## 계약

### 지원하는 판정 API

종류마다 엔드포인트, 모델, 요청 변환, 응답 검증을 Corral이 정한다. 사용자는 키만 넣는다.

| id | 공급자 | 요청 | 모델 | 질문 |
|---|---|---|---|---|
| `jev` | TypeSafe | `POST https://api.typesafe.ai/v1/systemone` | `jev-latest` | `questions.effort`: `{type:'choice', instructions, criteria}` |
| `openai-decisions` | OpenAI | `POST https://api.openai.com/v1/decisions` | `gpt-6-luna` | `questions[0]`: `{type:'choice', name:'effort', instructions, choices:[{value, description}]}` |

- 질문은 하나다: low / medium / high / xhigh 중 요청에 맞는 추론 수준과 수준별 기준. 판정 대상 텍스트는 Jev의 `state`, OpenAI의 `input`에 문자열로 넣는다.
- 인증은 `Authorization: Bearer <키>`다. 리다이렉트는 따르지 않는다.
- 답은 수준 하나와 응답이 알려준 모델 이름이다. 응답이 64 KiB를 넘거나, 선택지 밖 답이거나, 거절(OpenAI `refusal`)이거나, 형식이 다르면 `invalid_response`다. HTTP 오류는 `provider_error`이고 상태 코드만 남긴다. 응답 본문은 키나 요청을 되풀이할 수 있으므로 기록하지 않는다.
- 재시도와 스트리밍은 없다. 시간 제한과 취소는 호출하는 쪽(자동 추론의 3초 제한, 실행 취소)이 정하고, 판정 API는 그때 요청을 중단한다.

### 키

- 사용자 설정 디렉터리의 자격 증명 저장소에 `decision-api:<id>`로 저장한다. 모델 공급자 자격 증명과 이름이 겹치지 않는다.
- 서버는 시작할 때와 키를 바꿀 때 키가 있는지만 기억한다. 키 값은 호출할 때 저장소에서 읽는다.
- 응답, 이벤트, 로그, 오류 메시지, 모델 요청 기록, 내보내기에 키를 넣지 않는다. 설정 내보내기는 판정 API 키를 포함하지 않고, 가져오기는 판정 API 키를 지우지 않는다.
- 키는 실제 모델을 쓰는 서버(사용자 설정 디렉터리가 있는 서버)에서만 저장한다.

### 기록

호출마다 모델 요청 기록 하나를 남긴다.

- 소유자 `judge`(판정 효과 ID, 실행, execution), 목적 `reasoning_effort`, 공급자는 판정 API id, 모델은 요청한 모델.
- 사용량: 응답이 알려준 입력·출력 토큰. OpenAI의 추론·캐시 읽기·캐시 쓰기 토큰도 남기며, 입력 토큰은 캐시 읽기·쓰기를 포함한다.
- 비용은 알 수 없음으로 둔다. 판정 API 호출은 실행 예산을 쓰지 않는다.
- 상태: 답을 받으면 completed, 응답을 받았지만 쓸 수 없으면 failed, 중단하면 cancelled, 응답 전에 연결이 끊기면 unknown.

### API

주소와 응답 형식은 [API 계약](../api-contract.md)의 로컬 AI 표가 정한다.

## 수용 시나리오

```gherkin
Given 실제 모델을 쓰는 서버다
When 사용자가 판정 API 섹션에서 OpenAI Decisions 키를 저장한다
Then 목록에는 키가 있다는 사실만 보이고 응답 어디에도 키 값이 없다
And 모델 설정의 OpenAI 로그인과 키는 바뀌지 않는다

Given 모델 설정에 OpenAI 키나 ChatGPT 로그인만 있고 판정 API 키는 없다
When 로컬 판정이 보류한 요청을 준비한다
Then OpenAI Decisions를 부르지 않고 요청은 medium으로 나간다

Given 작업공간이 OpenAI Decisions를 외부 판정으로 골랐다
When OpenAI가 질문에 refusal로 답한다
Then 요청은 medium으로 나가고 fallback 이유는 invalid_response이며 기록은 failed다

Given 판정 API가 401과 함께 키나 요청을 담은 본문을 돌려준다
When 오류를 기록한다
Then 기록과 오류 메시지에는 상태 코드만 있고 본문, 키, 요청 텍스트는 없다

Given 사용자가 판정 API 키를 삭제했다
When 다음 요청을 준비한다
Then 그 판정 API는 호출되지 않는다
```

## 보안·성능·접근성

- 키와 응답 본문의 노출 경로는 위 키·기록 절이 막는다. 판정 API로 가는 텍스트는 로컬 판정의 판정용 텍스트와 같고 파일, 키, 실행 ID는 없다.
- 응답 64 KiB 상한, 요청당 한 번 호출, 재시도 없음으로 지연과 비용을 묶는다.
- 키 입력은 레이블이 있는 비밀번호 필드이고 입력 중인 값만 보이게 할 수 있다. 연결 상태는 텍스트로, 저장 실패는 경고로 알린다.
- 외부 API 근거
  - TypeSafe: OpenAPI 0.2.0, https://api.typesafe.ai/openapi.json
  - OpenAI: https://developers.openai.com/api/reference/resources/decisions, https://developers.openai.com/api/docs/guides/decisions, 데이터 보존 https://developers.openai.com/api/docs/guides/your-data
