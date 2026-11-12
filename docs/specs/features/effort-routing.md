# 기능 명세: 추론 판정

- 상태: accepted
- 비목표: 메인 모델·공급자 자동 변경, 엔진 사이의 자동 전환(Local↔판정 API)이나 병렬 호출·평균, 판정 결과의 보정·임계값·리뷰 상향 같은 덧붙인 규칙, 무추론(`none`)을 자동 후보로 쓰기, 확률을 성공률로 표시, 별도 관제 화면, Linux x64 Vulkan과 CUDA 12.8 이외의 GPU 런타임, GPU 구성을 검증됨으로 표시, Python·Docker 설치, 판정 횟수 상한.

## 사용자 관측 동작

설정 → 모델의 **추론 판정** 섹션에서 고른다.

- **Effort Mode**: Off(기본) / Manual. Off는 판정하지 않고 공급자 기본값을 쓴다. Manual은 판정 엔진 하나를 사용자가 직접 고르고, 추론 수준은 요청마다 그 엔진이 고른다.
- Manual의 엔진
  - **Local 판정 모델**: 모델 `d1-2B Q4_K_M`, 실제 실행 호스트(Corral 서버가 도는 컴퓨터), 장치(이 컴퓨터의 manifest에 있는 CPU·Vulkan·CUDA), 설치 상태, 고른 장치를 설치할 때 내려받을 크기, 진행률·취소, 실행 상태, 다시 준비(이미 설치된 그 장치의 모델을 띄우며 내려받지 않음), 설치된 모델의 제거, 고급 설정(최대 대기 시간, CPU 스레드 수). Vulkan과 CUDA는 고를 수 있고, 각 선택지에 이 컴퓨터에서 확인되지 않음이라고 보인다. Corral은 GPU 구성을 검증됨으로 바꾸지 않는다.
  - **판정 API**: 키가 있는 [판정 API](decision-apis.md) 하나, 보내는 범위와 데이터 보존 고지, 외부 전송 동의, 고급 설정(최대 대기 시간).
- Manual의 fallback: 공급자 기본값(기본) 또는 지원되는 고정 수준 하나.
- 원격 Corral 서버에 접속한 브라우저에서도 Local은 서버 컴퓨터를 뜻한다. 브라우저 기기의 CPU·GPU를 쓴다고 표시하지 않는다.
- Local 엔진을 제공하는 환경은 아래와 같다. 미리보기는 고를 수 있는 선택지라는 뜻이며 다른 판정기보다 낫다거나 비용을 줄인다는 뜻이 아니다. 판정 API는 환경과 무관하게 고를 수 있다.

| Corral 서버 환경 | Local 엔진 |
|---|---|
| Linux x64 · CPU | 미리보기로 제공 |
| Linux x64 · Vulkan | 고를 수 있음. 이 컴퓨터에서 확인되지 않음. Vulkan 로더 `libvulkan.so.1`이 필요 |
| Linux x64 · CUDA 12.8 | 고를 수 있음. 이 컴퓨터에서 확인되지 않음. CUDA 12.8을 지원하는 NVIDIA 드라이버(Linux x86_64 570.26 이상)와 `libcuda.so.1`, `libcudart.so.12`, `libcublas.so.12`가 필요 |
| 그 밖의 OS·아키텍처 | 이 환경에서 사용할 수 없음으로 표시 |

Effort Mode는 역할·노드의 추론 선택이 **자동**인 요청에만 쓰인다. 고정 수준이나 공급자 기본값을 고른 요청은 판정하지 않는다. 컴포저와 팀 편집기의 추론 선택지는 [모델·추론](../models-and-resources.md)의 ModelPicker 계약을 따른다.

실행 기록은 판정한 요청마다 한 줄을 보인다.

```text
Local · CPU · 추천 low → 적용 low · 420ms
Local · VULKAN0 · 추천 low → 적용 low · 420ms
Local · CPU · 시간 초과 → 공급자 기본값
판정 API · OpenAI Decisions · 입력 근거 부족 · 호출하지 않음 → 공급자 기본값
Off · 판정 안 함
```

요청 줄의 장치는 그 판정이 실제로 쓴 장치다. CPU는 `CPU`이고, Vulkan·CUDA는 그 llama-server가 `--list-devices`로 인쇄한 이름을 대문자로 보인다(`Vulkan0`은 `VULKAN0`).

상세에는 선택지 분포(성공률이 아님), 장치, 시간, fallback 이유, 늦게 도착한 결과, 요청 확인을 보인다. 요청 확인은 공급자에 실제로 실은 추론 값이며 싣지 않았으면 생략이다. 그 기록이 없으면 요청이 아직 열려 있는 동안은 "아직 확인 안 됨", 요청이 끝났거나 그 실행·Run이 끝난 뒤에는 "확인 안 됨"이다. 판정하지 않은 요청의 추론 기록도 요청 확인을 같은 규칙으로 보인다. 실행 기록은 그 실행의 fallback을 이유별로 센다. 설정 섹션은 설치됨·준비됨을 구분하고, 실행 기록은 실제 적용을 따로 보인다. 시간 초과나 Busy로 추천이 적용되지 않는 상태를 정상 적용으로 표시하지 않는다.

## 계약

### 설정

- 작업공간 설정 `decisions.effort_routing`에 저장한다. 타입의 정본은 `packages/contracts/src/effort-routing.ts`다. 쓰기는 작업공간 설정의 revision 보호 쓰기를 쓰고 revision이 다르면 저장하지 않는다. 설정이 없으면 Off다.
- 필드: `mode`(`off` / `manual`). Manual은 `engine`과 `fallback`을 가진다.
  - Local 엔진: 장치(`cpu`·`vulkan`·`cuda` 중 이 컴퓨터의 manifest에 있는 것, 그리고 스레드 수), 최대 대기 시간. manifest에 없는 장치는 저장되지 않는다.
  - 판정 API 엔진: 판정 API id, 최대 대기 시간, 동의 revision.
  - fallback: `provider-default` 또는 low / medium / high / xhigh 중 하나의 고정 수준.
  - 진단용 `application`: `active`(기본) / `shadow`. 일반 UI에는 없다.
- 최대 대기 시간은 100–10,000ms 정수다. 기본값은 Local CPU 5,000ms, 판정 API 3,000ms다. 운영 정책 값이며 특정 CPU에서 추천이 제시간에 온다는 보장이 아니다.
- CPU 스레드 기본값은 `max(1, min(4, os.availableParallelism()))`다. 요청마다 스레드 수를 탐색하지 않는다.
- 판정 API 엔진 저장에는 그 판정 API의 키와 현재 고지에 대한 동의가 필요하다. 동의 revision은 판정 API id와 고지 버전으로 정해진다. 저장된 동의 revision이 현재 고지와 다르면 그 엔진은 외부로 보내지 않고 `consent-required`로 fallback한다.
- 설정은 요청을 준비할 때 읽고 그 준비의 settings revision으로 묶는다. 이미 보낸 요청은 바꾸지 않는다. 준비 중에 설정이 바뀌면 그 준비는 stale이고 새 설정으로 다시 준비한다. Off 전환이나 동의 철회 뒤에는 아직 시작하지 않은 판정을 하지 않고 진행 중 판정의 결과를 버린다.
- Local 엔진을 고르고 저장해도 다운로드는 시작하지 않는다. 설치는 설치 버튼으로만 시작한다. Off와 판정 API에서는 Local 다운로드·시작·준비를 하지 않는다.

### 요청마다의 판정 순서

1. 기존 권한·한도·실행 소유권 거절은 그대로 거절이다. 판정으로 우회하지 않는다.
2. 취소·일시정지·stale이면 메인 요청을 보내지 않는다.
3. 고정 수준은 모델 지원을 기존 규칙으로 확인해 그 수준을 쓴다. 판정 0회.
4. 공급자 기본값은 provider default를 쓴다. 판정 0회.
5. 자동 + 압축 요청은 판정하지 않고 기존 내부 정책(medium)을 쓴다. 출처는 `internal-policy`다.
6. 자동 + Off는 provider default다. 판정·다운로드·Local 시작·외부 전송·Shadow 모두 0회.
7. 자동 + Manual은 고른 엔진 하나로 판정한다. 고르지 않은 엔진은 부르지 않는다.

자동 선택은 모델에 검증된 provider default 바인딩이 있어야 고를 수 있다. 없으면 기존 추론 선택 검증 오류로 거절한다. 판정기 자신의 호출, 회의 임베딩, 진단 helper, 시뮬레이션 실행에는 판정을 적용하지 않는다.

### 후보 수준

- 후보는 low → medium → high → xhigh 중 요청 모델이 지원하는 수준을 이 순서로 모은 것이다. `none`·`off`·`minimal`·`max`는 자동 후보가 아니며 고정 수준으로만 쓴다.
- 후보가 없으면 provider default를 쓰고 이유는 `no-supported-level`이다. 후보가 하나면 엔진을 부르지 않고 그 수준을 쓰며 출처는 `single-level`이다.
- fallback의 고정 수준이 요청 모델에서 지원되지 않으면 그 요청은 provider default를 쓰고 그 사실을 기록한다. 가장 가까운 수준으로 바꾸지 않는다.

### 요청별 판정과 재시도

- 판정 단위는 요청 준비 하나다. 첫 턴뿐 아니라 도구 결과 뒤의 다음 응답도 각자의 문맥으로 새로 판정한다. 준비마다 resolution은 하나이고 정상 대상 요청의 엔진 호출은 최대 한 번이다.
- 같은 준비의 **명시적인 전송 재시도**만 확정된 결과를 다시 쓴다. worker가 재시도와 원래 모델 호출을 알리고, 문맥 hash·모델·capability·settings revision·엔진 identity·질문 버전·serializer 버전·후보 순서가 모두 같아야 한다. 하나라도 다르거나 논리 요청 ID만 같으면 새로 판정한다. 시간 초과 fallback도 확정 결과라 재시도에서 그대로 쓴다.
- 다시 쓴 요청도 새 모델 호출 ID·permit·예약·정산을 따로 가진다. dispatch 직전에는 취소·stale를 다시 확인한다. 재사용 기록은 실행이 끝나면 지운다. 취소된 준비는 자동으로 재개하지 않는다.
- 판정기는 자체 재시도를 하지 않는다. 판정 횟수 상한은 없다. 판정 결과는 그 요청에만 적용하며 세션·모델 설정·다른 에이전트의 추론 설정을 바꾸지 않는다.

### 판정 입력

- worker가 요청 문맥을 확정한 뒤 그 문맥에서 한 번 발췌해 비공개 IPC로 보낸다. 손실된 요약을 원본으로 쓰지 않는다. 모든 이력을 매번 다시 훑지 않고 최신 메시지·도구 묶음과 명시 참조만 읽는다.
- source: 현재 요청(마지막 user 메시지. 요청 앞의 Corral 배정 메타데이터와 끝의 Corral 현재 상태 메시지는 제외), 배정의 brief·질문, 적용 지시, 상위 질문, 이전 assistant의 일반 텍스트, 마지막 assistant 메시지의 **모든** 도구 호출과 각 결과·상태, 명시 입력 산출물. 각 source는 역할·순서·도구 호출 ID·상태를 유지한다.
- 숨은 reasoning, 이미지, 키, 미래 응답, 평가 정답은 넣지 않는다.
- 도구 상태는 해당 assistant 메시지 뒤에서 호출 ID가 같은 마지막 결과가 `isError`면 `failed`, 다른 결과가 있으면 `completed`, 없으면 `pending`이다. 결과 본문으로 상태를 추측하지 않고, 성공을 "원인 확정"이나 "해결 완료"로 바꾸지 않는다.
- 상위 질문은 판정 전에 확정한다. worker는 문맥에 이미 있는 질문을 알리고, Coordinator는 빠진 질문을 판정 입력에 넣은 뒤 permit에 같은 목록을 돌려준다. worker는 그 목록만 문맥에 붙인다. 그래서 판정한 요청·지시·질문·관찰의 버전은 실제 메인 요청과 같다. 판정 중 질문·지시가 바뀌면 기존 stale 규칙으로 다시 준비한다. 인증 헤더·request ID 같은 비의미 메타데이터 변환은 stale이 아니다.
- **필수 근거**: 현재 요청·지시·제약·상위 질문은 원문 전체다. 그 밖에는 기존 노드 계약, 명시 첨부, 질문의 산출물 참조, 이미 구조화된 비교 입력이 표시한 source만 필수이며 원문 전체 또는 producer가 정한 정확한 구간으로 보존한다. 새 모델이나 키워드 규칙으로 필수 목록을 만들지 않는다. 비교 관계의 대상은 모두 함께 보존한다. 그 요청이 읽을 수 없는 필수 근거(권한·수명)가 있으면 판정하지 않고 `required-source-missing`으로 fallback한다.
- source 개수와 길이 상한은 계약 타입이 정한다. 상한 때문에 잘린 source는 잘림으로 표시되며, 필수 source가 잘리면 입력 근거 부족이다.

### Frame과 예산

선택과 보존 규칙은 엔진마다 같고 계수 방법과 예산만 다르다. 두 엔진의 payload가 바이트 단위로 같을 필요는 없다.

| frame | state | 전체 입력 | 계수 |
|---|---|---|---|
| Local `d1-exact` | 400토큰 이하 | 렌더링한 System One 입력 512토큰 이하 | d1 tokenizer로 state와 전체를 각각 실제 계수 |
| 판정 API `api-bounded` | UTF-8 2,048바이트 이하 | 요청 JSON 8,192바이트 이하 | UTF-8 바이트. 공급자 tokenizer가 없으면 입력 토큰 수는 null |

- 400/512는 압축 한도이지 무손실이나 의미 충분성의 보장이 아니다. 판정 API의 바이트 한도를 토큰 보장으로 표시하지 않는다. 판정 API frame은 Local 모델·daemon·원격 토큰 계수 호출 없이 만든다.
- 배치 순서
  1. 현재 요청·지시·제약·상위 질문: 원문 전체. 이것만으로 넘으면 판정하지 않는다.
  2. 필수 근거: 원문 전체 또는 지정 구간.
  3. 비교 관계의 모든 필수 대상. 한쪽만 남기지 않는다.
  4. 이전 assistant의 계획·진단과 최신 관찰이 둘 다 있으면 각각 state 예산의 16%(Local 64토큰, 판정 API 327바이트)까지 실제 원문 조각을 먼저 예약한다. 경계 때문에 덜 채워져도 padding하지 않는다.
  5. 남은 예산: 추가 목표, 다른 최근 관찰, 이전 일반 응답 순.
- 선택 자료는 줄·grapheme 경계에서 앞 60%와 뒤 40%를 남기고 생략 표시와 원래 구간을 남긴다. 필드 제목·출처·생략 표시도 예산에 들어간다. diff의 `+/-`, JSON 값, 코드 식별자는 바꾸지 않는다.
- 한도를 넘으면 선택 자료만 정해진 순서로 줄인다. 필수 근거를 선택 자료로 바꾸지 않는다.
- 한 frame의 계수 호출은 최대 32회이고 같은 문자열의 계수는 준비 안에서 다시 쓴다. 32회 안에 확정하지 못하면 `packing-budget-exhausted`다.
- frame은 포함·생략·잘린 source ID를 coverage로 기록한다. coverage는 포함 사실이며 의미 품질 등급이 아니다.
- 입력 근거 부족(`insufficient-context`)의 세부 이유: `missing-request`, `required-source-missing`, `required-content-over-budget`, `comparison-operand-missing`, `unsupported-modality`, `packing-budget-exhausted`. 이때 엔진을 부르지 않고 fallback하며 메인 요청의 문맥은 바꾸지 않는다.

### 질문과 응답 검증

질문은 하나이고 고정이다. 미지원 수준은 기준에서 빼고 순서는 유지하며 질문 hash를 기록한다.

```json
{
  "state": "<frame state>",
  "questions": {
    "effort": {
      "type": "choice",
      "instructions": "Select the reasoning effort for the next model call. Consider the work still required using the provided current state.",
      "criteria": {
        "low": "Apply a known procedure or a specified edit.",
        "medium": "Perform bounded diagnosis or compare a few local alternatives.",
        "high": "Resolve interdependent constraints or multi-step diagnosis.",
        "xhigh": "Design and verify a strategy under deep or conflicting constraints."
      }
    }
  }
}
```

| 항목 | 규칙 |
|---|---|
| choice | 요청한 후보 중 하나 |
| Local 확률 | 모든 후보 key가 있고 각 값이 유한한 0–1. 합이 1±0.001이면 정규화하고, 그 밖은 invalid |
| argmax | Local의 choice와 확률 최댓값이 같아야 한다. 최댓값 동률은 invalid |
| 판정 API 확률 | 응답에 없으면 `not-provided`로 기록한다. one-hot을 만들어 넣지 않는다 |
| 보정 | 없다(identity). 확률은 선택지 분포이며 메인 모델 성공 확률이 아니다 |
| Local 토큰 | native usage의 입력 토큰이 렌더링 계수와 다르면 적용하지 않고 `token-count-mismatch` |

형식·identity·capability만 검사한다. 요청 길이, 파일 수, 리뷰·재시도 여부, 이전 수준을 보고 올리거나 내리지 않는다.

### 적용할 수 없는 결과

fallback 이유: `unavailable`, `not-ready`, `busy`, `timeout`, `invalid-response`, `insufficient-context`, `tokenizer-error`, `token-count-mismatch`, `unsupported-model`, `transport-error`, `daemon-crash`, `consent-required`, `resource-conflict`. 모두 실행 시작이 아니라 그 요청의 준비에서 확정한 fallback으로 간다. 다른 엔진을 부르지 않는다.

취소·stale·권한 거절은 fallback이 아니다. 메인 요청을 보내지 않고 기존 실행 제어로 돌아간다.

### 판정 API 엔진

고른 판정 API 하나만 한 번 부른다. 엔드포인트·요청 변환·키·기록은 [판정 API](decision-apis.md)가 정한다. 재시도, 다른 판정 API로의 전환, Local과의 병렬 호출은 없다. 시간 초과나 취소에서 원격 연결은 닫지만 원격 계산·과금이 멈췄다고 기록하지 않는다. 기존 판정 효과 승인·정산을 쓰고 비용은 알 수 없음으로 둔다. 공급자 실호출 검증이 없는 판정 API는 설정 가능·미검증으로 표시한다.

### Local 엔진: 고정 artifact

| 항목 | 값 |
|---|---|
| 모델 | `LiquidAI/d1-2B-GGUF` revision `4a181094d1b6addfaa3a0956f78e7ab2aa406a0c`, `d1-2B-Q4_K_M.gguf`, 1,099,629,888 B, sha256 `adca5789ad30ae6027e8e936749bb9f19673097492ab26fa1c5b69643ca50b4b` |
| 런타임 linux-x64 CPU | llama.cpp `b12189`(commit `80d2c0c2c56e4a1bbf74be98f64b99927bf230bc`) `llama-b12189-bin-ubuntu-x64.tar.gz`, 23,058,620 B, sha256 `c446a7ba4df3c3b1cc880a734fbff586d6d34b9cebc09e151754813b94ded8c9` |
| endpoint | loopback `POST /v1/systemone`, 계수 `POST /tokenize` |

- manifest의 정본은 `packages/local-intelligence/src/d1/manifest.ts`다. archive hash 외에 실행 파일과 함께 쓰는 shared library의 hash, 렌더링 template hash, 라이선스 식별자를 담는다. CPU 런타임과, 그 대상에 있는 장치별 런타임(Linux x64는 Vulkan, CUDA 12.8)을 담는다. 값이 하나라도 빠진 manifest는 schema 검증에서 거절한다. 런타임 build가 다르면 별도 manifest다.
- 모델 alias 문자열이 같다는 것만으로 identity를 인정하지 않는다. 응답은 시작 때 확인한 manifest와 child instance에 묶는다.
- 파일 크기를 필요한 RAM으로 표시하지 않는다. RSS·PSS는 읽을 수 있을 때만 기록하고 아니면 null이다.

### Local 엔진: 설치

```text
미설치 → 설치 버튼 → .part 수신 → 크기·sha256 확인 → 압축 해제와 파일 hash 확인
      → 실행 파일 버전 확인 → 완료 표시 → 설치됨
```

- 모델과 런타임은 앱과 따로 내려받는다. 설치 위치는 앱 데이터 영역의 `corral/local-ai/d1/<manifest id>/`이며 회의 분석 번들과 분리한다. 프로젝트 폴더에는 설치하지 않는다.
- 설치 버튼 옆에는 지금 고른 장치를 설치할 때 내려받는다는 말과 그 크기를 항상 보인다. 그 장치가 설치되지 않았을 때와 그 장치의 설치가 실패한 뒤가 같다. 크기는 아직 없거나 다른 모델이면 모델 크기에 그 장치 런타임 archive 크기를 더한 것이고, 모델이 이미 이 manifest와 같으면 그 런타임 archive만이다. CPU 런타임과 다른 GPU 런타임을 함께 받지 않는다. 바이트를 1,000,000으로 나눠 정수로 반올림한 MB가 1,000 미만이면 그 MB를, 1,000 이상이면 그 MB를 1,000으로 나눈 값을 소수 한 자리로 반올림한 GB를 쓴다. 모델과 CPU 런타임의 합 1,122,688,508바이트는 약 1.1 GB다. Vulkan archive 35,871,731바이트는 약 36 MB이고, 모델이 없으면 약 1.1 GB다. CUDA 12.8 archive 188,173,082바이트는 약 188 MB이고, 모델이 없으면 약 1.3 GB다. 설치 중 받은 크기와 그 설치의 전체 크기는 MB로 보인다. 한 서버에서 설치는 하나만 진행한다.
- 모델 파일은 manifest 디렉터리에 둔다. CPU 런타임 파일도 그 디렉터리에 둔다. Vulkan·CUDA 런타임 파일은 그 아래 `vulkan/`·`cuda/`에 둔다. 장치마다 llama-server와 같은 soname이 있어 한 디렉터리에 섞지 않는다. 완료 표시는 manifest id와 설치된 장치 목록이다. 장치 목록이 없는 이전 완료 표시는 CPU가 설치된 것이다.
- **지금 준비**와 **다시 준비**는 이미 설치된 모델을 띄울 뿐이며, 그 옆에 아무것도 내려받지 않는다고 적는다. 준비는 다운로드를 시작하지 않는다.
- 다운로드는 manifest의 HTTPS URL만 쓴다. 실행 중에 최신 버전을 조회해 모델이나 런타임을 바꾸지 않는다.
- 압축 해제는 manifest가 고정한 파일만 꺼낸다. 절대 경로, 상위 경로 traversal, 링크 항목은 거절한다. 다운로드 메타데이터의 명령을 실행하지 않는다.
- 크기·hash 불일치, 디스크 부족, 압축 해제 실패, 권한 오류는 활성화 전에 이유를 보인다. 이유에 로컬 경로를 넣지 않는다.
- 취소하거나 서버가 종료되면 파일 수신을 멈추고 부분 파일을 지운다. 이미 설치된 버전은 그대로 둔다. 완료 표시는 마지막에 쓴다.
- 새 버전은 새 디렉터리에 설치하고 실행 중인 instance가 없을 때 바꾼다. 실행 중인 파일을 덮어쓰지 않는다. 업데이트가 실패해도 이전 확인된 버전과 설정을 지우지 않는다.
- d1 삭제와 회의 분석 번들 삭제는 서로 묶지 않는다.

### Local 엔진: 제거

설치된 manifest 디렉터리만 지운다. 주소는 [API 계약](../api-contract.md)의 추론 판정 표가 정한다.

- **제거**는 장치 중 하나라도 설치가 끝난 뒤에만 보인다. 확인은 지워질 크기를 말하며, 크기는 설치된 모델과 설치된 장치 런타임 archive의 합을 설치 크기와 같은 형식으로 보인다. 확인 전에는 지우지 않는다. 지우면 그 manifest 디렉터리 전체(설치된 모든 장치)다.
- 설치가 진행 중이거나 판정 슬롯이 잡혀 있으면(패킹·추론·draining) 거절한다. 파일, 진행 중인 설치, Corral이 시작한 프로세스는 그대로다. 응답은 409 `RESOURCE_CAPACITY`이고 문구는 `an install is in progress` 또는 `a judgment is running`이다. 문구에 로컬 경로를 넣지 않는다.
- 거절되지 않으면 Corral이 시작한 그 엔진의 자식만 끝내고 종료를 확인한 뒤, 그 manifest 디렉터리만 지운다. 다른 manifest 디렉터리, 회의 분석 번들, 이름으로 찾은 다른 `llama-server`는 건드리지 않는다.
- 끝나면 설치 상태는 `absent`(설치 안 됨)다. 저장된 설정이 Manual + Local이어도 설정을 바꾸지 않는다. 화면은 설치됨이나 준비됨으로 남지 않고 설치 안 됨으로 읽힌다. 그 엔진으로 판정할 요청은 설치되지 않은 엔진의 기존 규칙대로 `unavailable`로 fallback한다.
- 이미 없으면 다시 제거해도 `absent`다. 다른 파일은 지우지 않는다.
- 파일을 다 쓴 뒤 그 설치를 받아들이기 전(준비를 시작하기 전)에 제거되면, 그 설치의 완료는 늦은 사건이다. 늦은 완료는 프로세스를 띄우지 않고 설치로 확정하지 않는다. 그 사이에 다시 생긴 그 manifest 디렉터리는 지우고 상태는 `absent`로 남는다.
- 디렉터리를 지우지 못하면 `absent`로 보고하지 않는다. 프로세스는 이미 멈췄을 수 있고, 폴더가 남아 있으면 설치됨이다. 다른 번들은 그대로다.

### Local 엔진: 실행과 수명주기

설치 상태와 실행 상태를 따로 둔다.

```text
설치: absent | downloading | verifying | installed | install-error
실행: stopped | starting | ready | packing | inferring | draining | error
```

- 서버 호스트마다 daemon 하나, 동시 판정 하나, 대기열 0이다. Busy는 tokenizer 호출 전에 판단하며 Busy면 tokenizer·System One을 부르지 않고 fallback한다. 다른 에이전트의 메인 요청은 그대로 진행한다.
- 실행은 셸 문자열이 아닌 인자 배열로 한다. CPU profile: `--model <절대 경로> --host 127.0.0.1 --port <호스트가 고른 빈 포트> --ctx-size 1024 --batch-size 1024 --ubatch-size 1024 --parallel 1 --threads <n> --threads-batch <n> --n-gpu-layers 0 --device none --no-op-offload --no-warmup --offline --cache-ram 0`, Web UI 끄기. 1024는 런타임 용량이며 입력 상한은 그대로 512토큰이다.
- Vulkan·CUDA profile은 같은 인자에 GPU 오프로드만 바꾼다. 이 빌드의 `llama-server --help`에서 `--n-gpu-layers`는 정확한 수, `auto`, `all`이고, `--device`의 `none`은 오프로드하지 않으며, `--fit off`는 장치 메모리에 맞추려 인자를 바꾸지 않고, `--op-offload`는 호스트 텐서 연산을 장치에 올린다. GPU profile은 `--n-gpu-layers all --device <그 빌드의 --list-devices가 인쇄한 이름> --fit off --op-offload`를 쓰고 `--n-gpu-layers 0`, `--device none`, `--no-op-offload`는 쓰지 않는다. Vulkan은 이름이 `Vulkan`으로 시작하는 장치, CUDA는 `CUDA`로 시작하는 장치만 쓴다. 그 이름이 없으면 프로세스를 띄우지 않고 실행 상태를 오류로 둔다. 오류는 그 런타임이 장치를 찾지 못했다고 말한다.
- GPU로 띄우다가 실패하면 실행 상태는 오류이고, 그 오류를 상태에 보인다. 요청은 오류 상태의 기존 규칙대로 `unavailable`로 fallback한다. CPU 런타임으로 몰래 바꾸지 않는다. 요청 기록의 실제 장치는 준비된 instance가 `--list-devices`에서 고른 이름이고, 준비되지 않았으면 null이다.
- instance마다 무작위 인증 키를 쓰고 명령줄 인자에 넣지 않는다. 인증을 지원하지 않는 build는 무인증으로 띄우지 않고 오류로 둔다. 키는 renderer로 보내지 않는다. 최소 환경 변수로 실행한다.
- Manual + Local이 저장돼 있고 설치가 끝났으면 비동기로 준비한다. 첫 요청에서 다운로드나 cold load를 기다리지 않는다. 준비되지 않았거나(멈춤·시작 중·다른 스레드 수) 준비 중이면 `not-ready`로 fallback하고, 멈춰 있거나 스레드 수가 다르면 그 요청이 준비를 시작한다. 설치되지 않았거나 설치 중이거나 `error`이면 `unavailable`이다. 시작은 30초 안에 ready가 돼야 하며 아니면 오류다. ready는 health 응답, 키 없는 요청의 거절, 고정 모델의 크기·파라미터 수와 decisions 출력을 확인한 뒤다.
- 활성 판정·패킹·draining 없이 5분이 지나면 내린다(`stopped`). 그 뒤 첫 요청은 `not-ready`로 fallback하고 준비를 다시 시작한다.
- 예상하지 않은 종료나 watchdog 종료 뒤에는 `error`이며 자동으로 다시 시작하지 않는다. 설정의 다시 준비나 Local 재활성화로 시작한다. 정상 요청마다 새 프로세스를 띄우지 않는다.
- Off 전환, 앱 종료, 장치 변경에서는 새 판정을 막고 Corral이 시작한 프로세스만 끝낸다. 진행 중인 시작(이전 instance의 종료를 기다리는 재시작 포함)은 그 뒤 새 프로세스를 띄우지 않으며, 중지는 소유한 child가 실제로 끝날 때까지 기다린다. 이름으로 다른 `llama-server`를 찾아 끝내지 않는다. 장치를 바꾸면 이전 instance의 실제 종료 뒤에 새 instance를 시작한다. 엔진·장치를 몰래 바꾸지 않는다.

### 대기·취소·물리 슬롯

- 공통 판정 경로가 패킹 **전에** 시작 시각과 deadline을 한 번 정한다. 패킹·계수·IPC·엔진·응답 검증이 같은 deadline을 쓴다. 프로세스 사이에는 남은 시간만 넘긴다. 긴 동기 작업으로 event loop를 막지 않는다.
- 호출자의 결과(논리 resolution)와 실제 계산의 끝(물리 종료)을 따로 관찰한다. resolution은 selected / fallback / cancelled / stale 중 하나로 한 번 확정하면 바뀌지 않는다.
- 물리 종료의 근거는 같은 native 응답 본문의 정상 완료 또는 소유 child의 종료뿐이다. 200 header만 받은 상태, 클라이언트 socket close, 시간 초과 Promise, 대응되지 않는 `/slots` idle은 근거가 아니다. `/slots`는 진단에만 쓴다.
- 패킹 신호는 deadline과 사용자 취소에 연결해 header 뒤 본문이 멈춘 tokenizer 요청까지 끊는다. 추론 관찰은 호출자 취소로 사라지지 않는다.
- physical watchdog은 추론 시작부터 120초다. 만료되면 terminate, 2초 뒤에도 남아 있으면 kill하고 실제 종료를 확인한다. 일반 UI에 노출하지 않는다.

| 사건 | 메인 요청 | tokenizer·native 작업 | 슬롯 |
|---|---|---|---|
| Busy | fallback, 바로 진행 | 새 호출 0 | 기존 소유자 유지 |
| 패킹 중 시간 초과 | fallback | tokenizer 취소, 늦은 System One 0 | 패킹 정리 뒤 반환 |
| 패킹 중 사용자 취소 | 보내지 않음 | tokenizer 취소, 늦은 System One 0 | 패킹 정리 뒤 반환 |
| 추론 중 시간 초과 | fallback | 같은 응답의 완료를 계속 관찰 | 완료·종료 전 유지 |
| 추론 중 취소 | 보내지 않음 | 관찰은 따로 남음 | 완료·종료 전 유지 |
| 입력 변경 | stale, 이전 요청 0 | 늦은 결과 폐기 | 시작한 계산은 완료·종료까지 유지 |
| HTTP 오류로 native 상태 불명 | fallback 또는 취소 상태 유지 | 소유 instance를 격리하고 종료 | 실제 종료 전 유지 |
| daemon crash | fallback | child 종료 관찰 | 종료 뒤 반환 |
| watchdog 만료 | 이미 확정된 결과 유지 | terminate → 2초 → kill | 실제 종료 뒤 반환 |
| 늦게 온 유효한 응답 | 기록만 추가, 다시 적용 0 | 정상 정리 | 종료 근거에 따라 반환 |

정상 추론의 호출자 시간 초과만으로는 child를 끝내지 않는다. 다른 OS의 종료는 같은 의미의 프로세스 트리 종료와 종료 관찰을 쓴다.

### Shadow

- `application: shadow`는 개발·진단용이며 Off에서는 켜지지 않는다. 같은 설정에서 Active와 함께 쓰지 않는다.
- 기준 수준(고정 수준, provider default, 자동 요청은 fallback 대상)을 정하고 취소·stale를 확인한 뒤 원래 요청을 그대로 보낸다. 그 뒤 별도 관찰로, 자원이 비어 있을 때만 판정해 기록한다. 메인 payload는 바뀌지 않으며 reasoning 필드를 강제로 넣지 않는다.
- 관찰도 설정 경계를 따른다. 준비 뒤 설정이 바뀌었으면(Off, 다른 엔진, 동의 철회) 원래 요청을 보낸 뒤에도 관찰을 시작하지 않고, 진행 중 관찰이 설정이 바뀐 뒤 답하면 기록하지 않는다.
- Shadow의 결과·fallback·대기 중 Promise를 Active resolution에 쓰지 않는다. 자원이 없어 건너뛴 관찰은 성공으로 세지 않는다. scope가 끝나면 관찰을 정리한다.
- Shadow가 low를 추천하고 실제 기준 수준 high로 성공했다는 기록으로 low도 성공했을 것이라고 보지 않는다. 그 행의 반사실 품질은 알 수 없음이다.

### 요청 적용

- 확정 수준은 그 요청의 options·model 사본에만 반영하고 기존 wire 검증과 request fence를 거친다. 모델명, 출력 상한, 목적지, 권한은 판정이 바꿀 수 없다. provider default는 reasoning 필드를 싣지 않는다.
- 판정 설명이나 시각을 메인 프롬프트에 넣지 않는다. 판정 때문에 정적 prefix와 prompt-cache key를 바꾸지 않는다.
- 관리형 main-step 호출만 대상이다. 확장이 직접 보낸 네트워크 요청까지 제어한다고 주장하지 않는다.

### 기록

- 적용한 판정은 `model.request_prepared.reasoning`에 남긴다: route ID, 요청한 추론 선택, 출처(`router` / `single-level` / `fallback` / `off` / `fixed` / `provider-default` / `internal-policy` / `reused`), 추천 수준, 실제 적용한 공급자 값, 엔진(`local` / `api` / `none`), fallback 이유와 입력 근거 부족의 세부 이유, 확률과 그 의미, 엔진 identity, 질문·serializer 버전, frame hash와 coverage 수, 후보, 시간(패킹, 계수, 엔진 왕복, 호출자 대기, deadline), 장치(요청, 실제, 호스트, 스레드), 판정 입력 토큰·과금 단위. 필드의 정본은 contracts 타입이다.
- `reasoning.settled`는 물리 종료를 남긴다: route ID, 종료 근거(`native-response-complete` / `owned-child-exit` / `remote-transport-closed`), 실제 점유 시간, 늦은 결과 여부와 늦게 온 추천(기록 전용).
- `reasoning.observed`는 Shadow 관찰을 남긴다: route ID, 모델 호출 ID, 기준 수준, 추천 또는 건너뛴 이유, 확률, 시간.
- 이벤트는 append-only이며 늦은 결과가 이미 적용한 값을 덮지 않는다. 판정 입력 원문, 키, 로컬 경로는 기록하지 않는다. 측정하지 못한 값은 null이고 왕복 시간에서 상수를 빼 추론 시간을 만들지 않는다. 출력 토큰에 포함된 추론 토큰을 총토큰에 두 번 더하지 않는다.
- 요청 수, tokenizer HTTP 시도, System One HTTP 시도, native 작업 시작 확인, 응답 완료, 실제 적용, 이유별 fallback, 취소·stale, Shadow 관찰·건너뜀은 서로 다른 수로 센다. `fetch()` 직전에 센 수를 native 작업 수라고 부르지 않는다. 서버 로그로 확인하지 못한 native 작업 시작은 null이다.

### API

주소와 응답 형식은 [API 계약](../api-contract.md)의 추론 판정 표가 정한다.

## 수용 시나리오

```gherkin
Given 추론 판정이 Off이고 Local이 설치되지 않았다
When 자동 추론 역할이 요청을 준비한다
Then 요청은 reasoning 필드 없이 나가고 출처는 off다
And tokenizer·판정 API·다운로드·Local 시작은 0회다

Given Manual + Local이고 역할의 추론 선택이 고정 high다
When 요청을 준비한다
Then high가 적용되고 엔진은 호출되지 않는다

Given Manual + Local이고 첫 턴의 판정이 끝났다
When 같은 실행이 도구 결과 뒤 다음 응답을 준비한다
Then 새 snapshot으로 새 판정을 한다

Given 판정이 low로 확정된 요청의 전송이 실패했다
When worker가 같은 준비의 전송을 원래 모델 호출을 밝혀 재시도한다
Then 엔진을 다시 부르지 않고 low를 쓴다
And 새 모델 호출 ID와 정산을 따로 가진다

Given 같은 논리 요청 ID지만 문맥이 바뀐 새 준비다
When 요청을 준비한다
Then 이전 판정을 쓰지 않고 새로 판정한다

Given 판정이 확정된 뒤 dispatch 전에 실행이 취소됐다
When 확정 결과를 다시 쓰는 재시도가 dispatch에 도달한다
Then 메인 요청은 나가지 않는다

Given tokenizer가 header를 보낸 뒤 본문을 멈췄다
When deadline이 지난다
Then tokenizer 요청을 끊고 fallback하며 System One은 호출되지 않는다

Given 추론 중 deadline이 지났다
When 늦게 유효한 추천이 도착한다
Then 메인 요청은 fallback으로 한 번만 나가고 늦은 추천은 기록에만 남는다
And 슬롯은 native 응답이 끝난 뒤 풀린다

Given 다른 에이전트가 Local 판정 슬롯을 쓰고 있다
When 두 번째 에이전트가 자동 추론 요청을 준비한다
Then busy로 fallback하고 tokenizer·System One 호출은 0회다
And 두 번째 에이전트의 메인 요청은 바로 진행한다

Given 계약 파일과 diff가 비교 관계의 필수 대상이다
When 둘을 함께 넣으면 예산을 넘는다
Then 한쪽만 넣지 않고 insufficient-context로 fallback하며 엔진을 부르지 않는다

Given 상위 질문이 아직 문맥에 없다
When 요청을 준비한다
Then 판정 입력과 실제 메인 요청에 같은 질문이 들어간다

Given state는 400토큰 이하지만 렌더링한 전체 입력이 512토큰을 넘는다
When frame을 만든다
Then 선택 자료를 줄이거나 fallback하고 512토큰을 넘는 입력을 보내지 않는다

Given Manual + 판정 API이고 Local 모델과 런타임이 설치되지 않았다
When 자동 추론 요청을 준비한다
Then Local 없이 api-bounded frame으로 판정 API를 한 번 부른다

Given Manual + 판정 API이고 deadline이 짧다
When 판정 API가 deadline 안에 답하지 않는다
Then Local과 같은 순서로 fallback하고 Shadow·deadline 규칙을 건너뛰지 않는다

Given Manual + Local이다
When Local이 시간 초과로 fallback한다
Then 판정 API는 호출되지 않는다

Given application이 shadow이고 역할의 추론 선택이 고정 high이며 fallback은 medium이다
When 요청을 준비한다
Then high로 바로 나가고 판정은 관찰로만 기록된다

Given application이 shadow이고 역할의 추론 선택이 공급자 기본값이다
When 요청을 보낸다
Then reasoning 필드는 추가되지 않는다

Given Local 응답의 choice가 확률 최댓값과 다르거나 후보 밖이다
When 응답을 검증한다
Then invalid-response로 fallback하고 모델·권한은 바뀌지 않는다

Given payload hook이 모델명이나 출력 상한을 바꾼다
When 요청을 보낸다
Then 기존 wire 검증과 request fence가 막는다

Given Local 설치가 진행 중이다
When 사용자가 설치를 취소한다
Then 부분 파일이 지워지고 이전에 설치된 버전과 설정은 그대로다

Given 내려받은 런타임 archive의 sha256이 manifest와 다르다
When 설치를 확인한다
Then 활성화하지 않고 이유를 보이며 이유에 로컬 경로가 없다

Given Local instance가 실행 중이다
When 사용자가 Off로 바꾸거나 앱이 종료된다
Then Corral이 시작한 프로세스만 끝나고 종료가 확인된다

Given Local이 설치되지 않았거나 설치가 실패했다
When CPU 설치 버튼을 본다
Then 버튼 옆에 약 1.1 GB를 내려받는다고 보인다

Given 모델은 이 manifest와 같고 Vulkan 런타임은 없다
When Vulkan을 고르고 설치한다
Then Vulkan archive만 받고 CPU·CUDA archive는 받지 않으며 버튼에는 약 36 MB가 보인다

Given Vulkan을 골랐고 그 llama-server의 장치 목록에 Vulkan 장치가 없다
When 준비를 시작한다
Then 실행 상태는 오류이고 프로세스를 띄우지 않는다
And 요청은 unavailable로 fallback하며 CPU 런타임으로 바꾸지 않는다

Given 설치된 Local이 준비 안 됨이거나 오류로 멈췄다
When 지금 준비 또는 다시 준비를 본다
Then 이미 설치된 모델을 시작하며 아무것도 내려받지 않는다고 보인다

Given Manual + Local이고 판정 모델이 설치되어 있다
When 사용자가 제거를 확인한다
Then 그 manifest 디렉터리만 지워지고 설치 상태는 설치 안 됨이다
And 저장된 설정은 Manual + Local 그대로다
And 다음 자동 요청은 unavailable로 fallback한다
And 회의 분석 번들과 Corral이 시작하지 않은 프로세스는 그대로다

Given 설치가 진행 중이거나 판정 슬롯이 잡혀 있다
When 사용자가 제거를 요청한다
Then 거절하고 파일과 그 프로세스는 그대로다

Given 설치 파일을 쓴 뒤 그 설치를 받아들이기 전에 제거했다
When 그 설치의 완료가 늦게 도착해 디렉터리를 다시 만든다
Then 프로세스를 띄우지 않고 다시 생긴 manifest 디렉터리를 지우며 상태는 설치 안 됨이다

Given 판정 모델이 이미 없다
When 제거를 다시 요청한다
Then 상태는 설치 안 됨이고 다른 번들은 그대로다
```

## 보안·성능·접근성

- Local은 loopback, instance별 인증, 소유 프로세스 identity를 쓴다. native 요청 크기는 호스트가 제한하고, 모델에는 파일 쓰기·도구 실행·권한 확대 권한이 없다. 판정 결과는 추론 수준 외의 보안·권한 결정을 바꾸지 못한다.
- control-token escape와 데이터 필드 구분을 적용하지만 prompt injection을 해결한다고 주장하지 않는다.
- 설치는 HTTPS·크기·hash 확인을 생략하지 않는다. 실행 중 임의 URL에서 binary를 바꾸지 않는다.
- 외부 전송은 명시 동의와 고른 판정 API에만 허용한다. native·외부 요청에 계정 키, Authorization, 비밀 환경 변수를 넣지 않는다. 기존 redaction을 적용하고 필수 근거가 가려져 부족하면 fallback한다.
- 기록은 코드 원문을 중복 저장하지 않고 기존 context snapshot 참조와 hash를 쓴다. debug export는 사용자가 고를 때만 만들며 키·토큰·서명된 다운로드 URL을 지운다.
- 성능 참고치: 독립 환경의 공유 CPU에서 512토큰 warm 판정의 중앙값이 약 1.4–4.2초였다. CPU·스레드·부하가 달라 일반 데스크톱 속도로 쓸 수 없는 참고치이며 합격 기준이 아니다. 실제 상한은 설정한 최대 대기 시간이다. 대기 시간을 늘리는 것은 속도 개선이 아니라 대기 정책 변경이다.
- 설정 섹션은 디자인킷 구성요소를 쓰고, 설치 진행과 실행 상태는 status 영역에서 읽을 수 있게 한다. 대기 시간·스레드 입력은 레이블과 범위 오류를 가진다.
- 라이선스: 모델은 LFM Open License v1.0([LICENSE](https://huggingface.co/LiquidAI/d1-2B-GGUF/blob/4a181094d1b6addfaa3a0956f78e7ab2aa406a0c/LICENSE)), 런타임은 llama.cpp MIT([b12189](https://github.com/ggml-org/llama.cpp/releases/tag/b12189)). 설치·배포물에 실제 LICENSE와 NOTICE를 연결한다.
