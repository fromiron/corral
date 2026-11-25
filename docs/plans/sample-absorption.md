# 샘플 흡수: 작업 계획

이 문서는 계획이다. 동작의 정본은 [명세](../specs/README.md)다. 근거가 된 조사는 `output/sample-analysis-2026-11-25/report.md`(추적하지 않는 파일)에 있고, 이 계획은 그 보고서 §3의 네 항목(M1a, M1b, M2, M3)만 다룬다. 단계를 마칠 때마다 진행 표를 고치고, 모두 끝나면 이 파일을 지운다.

## 0. 진행 표

| 단계 | 내용 | 상태 | 시작 조건 |
|---|---|---|---|
| S0 | 측정과 확인(제품 코드 변경 없음) | 끝(11-25). 결과는 §3 끝 | 없음 |
| S1 | M1a: 한도가 풀리면 다시 보내기 | 끝(11-25). Astra·Sol 확인은 아직(§4) | 풀림 |
| S2 | M1b: 남은 한도 보기 | 대기 | 실제 응답 헤더 확인(ChatGPT·Anthropic 각 1회, 유료 공급자라 허락 필요) |
| S3 | 무진전을 경고로 바꾸기(Q1)와 M3: 같은 도구 반복에 알리기 | 끝(11-25). Astra·Sol 확인은 아직(§5) | 풀림 |
| S4 | M2: 말만 하고 끝난 턴 | 뺌(11-25) | S0c에서 0/18. 실제 코딩 기록이 쌓이면 다시 잰다 |

조건이 풀리지 않은 단계는 이 계획에서 뺀다.

## 1. 정한 것과 남은 것

| # | 질문 | 결정 |
|---|---|---|
| Q1 | 무진전(진전 없는 응답 6번)을 사람의 승인으로 둘지, 경고로 바꿀지 | **경고로 바꾼다**(2026-11-25). 11-13에 횟수로 묻는 승인을 없앤 것과 같은 이유다. [제품 계약 §9](../specs/product-contract.md#9-사용량과-자원-정책)는 그대로 두고, [LLM 런타임](../specs/llm-runtime.md)·[기술 설계](../specs/technical-design.md)·[용어집](../specs/glossary.md)·[표시 상태](../specs/features/presence.md)·[채팅 위젯 계약](../specs/chat-widgets-contract.md)과 코드를 고친다(S3) |
| Q2 | 한도 뒤 다시 보내기의 기본값 | **켬**(2026-11-25). 대화에 시각과 취소가 늘 보이고, 자동 다시 보내기는 요청당 한 번이다 |
| Q3 | M2 판정을 누가 하는지 | 남음. 대화에 쓴 모델에 한 번 더 묻기 / 따로 고른 작은 모델 / 판정 API 가운데 S0c를 본 뒤 정한다. 로컬 AI 엔진은 임베딩 전용이라 후보가 아니다([로컬 AI](../specs/features/local-intelligence.md)) |
| Q4 | S0c에서 실제 응답 본문을 누가 읽는지 | **이 세션이 직접**(2026-11-25). 응답 끝부분(마지막 400자)만 읽고 새 공급자로 보내지 않는다 |
| Q5 | 무진전이 경고가 된 뒤, 알림을 받고도 같은 호출을 계속하는 실행을 어떻게 할지 | **두 번째 알림 뒤 끝낸다**(2026-11-25). 같은 호출 6번째에 "상태를 말하고 끝내라" 알림을 보내고, 9번째는 거절한 뒤 그 실행 단위를 실패로 끝낸다. 무진전과 달리 같은 호출은 정확히 셀 수 있어서, 횟수로 끝내는 예외를 이 경우에만 둔다 |

## 2. 지금 코드에서 확인한 것

- **실패 기록:** 모델 요청 기록 `ModelAttempt`에 `failure.code`, `status`, `retryAfterMs`가 남는다(`packages/contracts/src/model-requests.ts:80-104`). 분류는 `packages/adapter-pi/src/ported/dsh/retry.ts:59-98`이 한다.
  - `QUOTA`는 오류 글의 정규식(`insufficient_quota|quota.exceed|usage.limit|…`)으로 가른다.
  - 그 밖의 429는 `RATE_LIMIT`이다.
  - `QUOTA`는 자동 재시도하지 않는다(`retry.ts:106`).
- **실패가 오가는 길:**
  - 모델 브리지는 분류한 실패 객체를 보낸다(`packages/adapter-pi/src/model-bridge.ts:186`, `:208`).
  - 실행 단위가 끝날 때 worker는 오류를 문자열로만 넘긴다(`packages/adapter-pi/src/adapter.ts:744-763`). 이 문자열은 "the model request failed: HTTP 429 (QUOTA)" 같은 형태다.
  - `retryAfterMs`는 `RATE_LIMIT`일 때 공급자 쿨다운에만 쓰인다(`apps/server/src/models/request-runtime.ts:180-185`).
- **리셋 시각의 출처:**
  - ChatGPT 구독은 한도 오류 본문 `error.resets_at`(epoch 초)에 리셋 시각을 싣는다.
  - Corral은 Pi를 `maxRetries: 0`으로 부른다(`packages/adapter-pi/src/model-bridge.ts:144`). 그래서 Pi의 Codex 경로는 재시도 없이 바로 오류 본문을 해석한다(`@earendil-works/pi-ai/dist/api/openai-codex-responses.js:296-314`).
  - 그 오류 글은 "You have hit your ChatGPT usage limit (… plan). Try again in ~N min."이다(`:1265-1285`). 해석에 실패할 때만 `err.message`를 쓴다.
  - 따라서 이 글은 Corral 분류기의 `usage.limit`에 걸려 `QUOTA`가 될 것이다(추론, 실제 응답으로는 확인 못 함). 리셋 시각은 분 단위로만 남고, 정확한 `resets_at`은 버려진다.
  - 헤더 `retry-after`·`retry-after-ms`는 Pi와 Corral 분류기가 둘 다 읽는다.
  - Anthropic 구독과 Copilot은 모른다.
- **실패한 Run 뒤의 요청:** 다음 요청은 앞 Run의 요청과 끝 상태("실패")만 받는다([LLM 런타임](../specs/llm-runtime.md) "Continuation and accounting"). 실패한 Run이 한 도구 호출은 다음 요청의 대화에 실리지 않는다. 파일 변경은 Paddock에 남는다. 사람의 "다시 보내기"는 원문과 첨부를 새 요청으로 보낸다([Workbench](../specs/workbench.md) 246행).
- **대기 요청:** 서버가 Run이 끝날 때 맨 앞 대기 요청을 시작한다(`apps/server/src/session-queue.ts:93`).
- **예약 실행:** 발화 claim과 놓침 처리가 `apps/server/src/schedules/service.ts:199-265`, `store.ts`에 있다.
- **무진전 카운트** (`packages/core/src/limits.ts:95-170`)
  - 모델 응답마다 1씩 늘고, 새 도구 증거·산출물·제출·검토·승인 해결이 있으면 0으로 돌아간다.
  - `progressHash`는 도구 이름, 인자, 결과의 증거 필드(`path`, `sha256`, `text`, `exitCode` 등), 출력을 함께 해시한다(`packages/core/src/coordinator.ts:12062-12090`). 오류로 끝난 도구는 0으로 돌리지 않는다.
  - 그래서 같은 도구를 같은 인자로 다시 불러도 결과가 새로우면 0이 된다. 결과가 매번 다르게 나오는 반복(불안정한 테스트를 계속 다시 돌리는 경우 등)은 지금 게이트에 걸리지 않는다.
  - 결과가 같으면 6번째 응답에서 승인 게이트가 걸린다.

## 3. S0 측정과 확인

제품 코드는 바꾸지 않는다. 스크립트는 `output/sample-analysis-2026-11-25/scripts/`(추적하지 않음)에 두고 `python3 -I`나 읽기 전용 DB 연결로 돌린다. 로컬 DB는 서버가 쓰는 중이면 백업 사본을 읽는다. 결과에는 개수와 ID만 남기고 메시지 본문은 남기지 않는다. 모의 실행은 모두 뺀다.

- **S0a. 한도 실패의 빈도와 리셋 시각.**
  - `ModelAttempt` 중 `status=429`이거나 `code`가 `QUOTA`·`RATE_LIMIT`인 것을 공급자·인증 방식(구독·키)별로 센다.
  - 각 행에 `retryAfterMs`가 있는지, 값이 몇 분 단위인지 센다.
  - 그 요청이 속한 Run 중 사람이 같은 세션에서 다시 보낸 비율을 센다. M1의 목표 수치다.
- **S0b. 공급자별 출처.**
  - 설치된 Pi 1.6.0에서 ChatGPT·Anthropic·Copilot 구독 경로를 읽는다. 한도 오류가 리셋 시각을 어디에 싣는지(본문 필드, 헤더), 정상 응답이 남은 한도를 싣는지 표로 만든다.
  - 헤더로 오는 공급자는 Pi 패치가 필요 없다. 본문으로만 오는 공급자는 패치가 필요하다.
  - S1은 이 표에서 리셋 시각을 주는 공급자만 다룬다. 지금 확인된 것은 ChatGPT 하나다.
  - ChatGPT는 Pi 패치 없이 오류 글의 "~N min"만으로 갈지, 패치로 `resets_at`을 그대로 받을지 여기서 정한다. 분 단위로 반올림한 값은 몇십 초 일찍 보낼 수 있어서 제안은 패치다.
- **S0c. 말만 하고 끝난 턴의 빈도.**
  - 성공으로 끝난 대화 Run의 최종 응답 끝부분 200개를 표본으로 뽑는다.
  - 이 세션이 "할 일을 약속하고 끝났는가"를 직접 판정하고, 판정 근거를 개수로 남긴다.
  - 비율이 5% 미만이면 S4를 뺀다. 문턱은 결과를 보고 함께 정한다.
- **S0d. 같은 도구 반복의 빈도.**
  - 실행 단위마다 같은 도구·같은 인자가 연달아 3번 이상 나온 경우를 센다.
  - 그 반복이 무진전 카운트를 0으로 돌렸는지(결과가 달랐는지), 무진전 승인까지 갔는지, 그 승인에서 사람이 무엇을 골랐는지 센다.

### S0 결과 (2026-11-25)

수치와 근거는 `output/sample-analysis-2026-11-25/s0/results.md`에 있다. 로컬 DB 4개(개발 작업공간)에서 실제 모델로 돈 Run은 약 50개였다. 도구는 Corral 자체 도구뿐이었고 `run_command`나 편집은 없었다. 그래서 아래 결과를 코딩 작업에 그대로 적용할 수는 없다.

- **S0a:** 한도 실패는 0건이라 빈도는 모른다. 실패한 Run 8개는 모두 분류되지 않은 "the model worker reported a request failure"였고, 요청 기록(`model_attempts`)에 한 줄도 없었다. 실패한 worker 요청은 요청 기록에 남지 않는 것으로 보인다. 따라서 S1은 실패 분류(`code`, `resetAt`)를 실행 단위 실패까지 싣는 일부터 한다. §8의 가정은 실패한 요청에 대해서는 틀렸다.
- **S0b:**
  - ChatGPT는 한도 오류 글에 분 단위 리셋 시각을 남긴다. Pi 패치로 `resets_at`을 받는 것을 S1에 넣는다.
  - ChatGPT와 Anthropic 모두 정상 응답의 헤더를 Pi가 거르지 않고 Corral 모델 브리지에 넘긴다. 남은 한도 헤더가 실제로 있는지는 실제 응답 한 번씩을 봐야 안다(S2의 시작 조건).
- **S0c:** 약속만 하고 끝난 응답은 0/18이다. 표본이 작아 상한은 대략 17%에 그친다. 문턱을 넘는다는 근거가 없어 S4는 뺀다.
- **S0d:** 같은 호출 3번 이상은 실행 단위 232개 가운데 4번(약 1.7%)이었다. 모두 `write_artifact`·`read_artifact`였고 결과가 같았다. 결과가 매번 다른 반복은 기록에 없다. 반복 알림의 문턱 3은 제안 값 그대로 둔다.

## 4. S1 M1a: 한도가 풀리면 다시 보내기

동작과 계약의 정본은 [한도 뒤 다시 보내기](../specs/features/usage-limit-resend.md)다. 여기에는 만든 것의 위치와 처음 계획에서 달라진 점만 적는다.

**만든 것**

- **리셋 시각:** `packages/adapter-pi/src/ported/dsh/retry.ts`가 `QUOTA`일 때 `retry-after-ms`·`retry-after` 헤더와 ChatGPT 글의 "~N min" 가운데 늦은 쪽을 `resetAt`으로 남긴다. SDK worker의 실패에도 오류 글을 싣는다(`sdk-worker.ts`).
- **기록:** `AgentSettlement.usageLimit` → `execution.settled.usageLimit` → projection의 실행 단위로 이어지고, 모델 요청 기록 `failure.resetAt`에도 남는다.
- **판단:** `packages/core/src/usage-limit-resend.ts`. 규칙은 샘플 저장소의 `limitRecoveryCommand`에서 가져왔다.
- **대기열:** `apps/server/src/session-queue.ts`가 Run이 끝날 때 사본을 대기열 맨 앞에 두고, 시각에 시작한다. 화면이 실행 뒤에 요청을 기록해도 사본을 만들고, 다른 Run이 끝나면 지운다. 서버를 시작할 때 시계를 다시 건다.
- **화면:** 대기 카드에 "HH:MM에 다시 보냄"(오늘이 아니면 날짜도), 다시 보낸 요청의 메타 줄에 "한도가 풀려 다시 보냄".
- **테스트:**
  - `packages/adapter-pi/test/request-retry.test.ts`
  - `packages/core/test/usage-limit-resend.test.ts`
  - `apps/server/test/session-queue-unit.test.ts`
  - `apps/server/test/usage-limit-resend.test.ts`(실제 서버·저장소)
  - `apps/studio/src/workbench/session/ComposerQueue.test.tsx`

**처음 계획과 달라진 점**

1. **Pi 패치 없음.** ChatGPT의 "~N min" 글에서 읽고 1분을 더한다. 분 단위로 정확하다.
2. **실패 줄이 아니라 대기 카드.** 다시 보낼 요청을 대기 요청 하나로 두어, 지금 시작·편집·제거를 그대로 쓴다.
3. **대기열 전체가 기다린다.** 같은 연결의 대기 요청만 기다리게 하는 대신 순서를 지킨다. 뒤의 요청이 실패한 요청의 결과를 전제로 썼을 수 있기 때문이다. "지금 시작"은 언제든 된다.
4. **서버가 꺼졌던 경우.** 시각이 24시간 안에 지났으면 다시 켜진 뒤 바로 보낸다. 샘플의 규칙을 따랐다. 처음 계획은 "놓침으로 표시하고 소급하지 않음"이었다.

**확인하지 못한 것**

- 실제 ChatGPT 한도 응답은 본 적이 없다. 그 글이 `QUOTA`로 분류되는 것은 Pi 소스를 읽고 내린 추론이다.
- 브라우저 화면은 확인하지 못했다. 모델 없는 서버의 모의 에이전트는 사용 한도 실패를 낼 수 없다. 카드는 jsdom 테스트로만 봤다.
- 서버 통합 테스트와 카드 테스트는 구현한 뒤에 썼다. 분류·판단·대기열 테스트는 먼저 실패를 확인했다.
- 실패 JSON이 300자를 넘으면(아주 긴 요청 ID) worker의 `safe()`가 잘라 리셋 시각을 잃는다. 고치지 않았다.
- 리뷰: Astra가 `model_not_found`로 돌지 않아 어드바이저가 리뷰했다. Astra와 Sol의 확인은 아직이다.

**정한 것(11-25)**

- 달라진 점 4는 이대로 둔다: 24시간 안이면 다시 켜진 뒤 보낸다.
- S1 변경만 커밋한다. 같은 파일에 있던 소유자의 미커밋 변경은 작업 트리에 남긴다.

## 5. S3 무진전을 경고로 바꾸기와 M3

동작의 정본은 [LLM 런타임](../specs/llm-runtime.md)의 "Conversation agent and final replies"와 [Reins의 지시 출처](../specs/features/reins.md)다.

**만든 것**

- **무진전:** 기본 `model.request` 게이트에서 `no_progress`를 뺐다(`packages/core/src/admission/index.ts`).
  - 진전 없는 응답 6번에는 이미 있던 경고 알림만 남는다. 문구에서 "멈췄다"는 말을 뺐다.
  - `limit.reached`와 승인은 생기지 않는다. 옛 기록을 읽기 위해 이벤트의 `no_progress` 열거값은 남긴다.
- **반복 알림:** `Coordinator.noteRepeatedCall`이 실행 단위마다 같은 도구·같은 인자의 연속 호출을 센다. 3번째에 출처 `corral`의 지시를 하나 접수하고, 다음 요청에 싣는다.
  - `await_tasks`는 세지도 끊지도 않는다.
  - Outrider와 런타임이 대신 부른 호출은 세지 않는다.
  - 같은 호출에는 한 번만 보낸다.
- **worker:** 두 worker 모두 "Note from Corral, not from the person (…)" 머리말 아래에 줄마다 인용해 싣는다.
- **화면과 검색:** 출처 `corral`은 사람의 지시로 보이지 않는다. 실행 기록에는 "Corral이 같은 도구 반복을 알림"으로, 이벤트 문구에는 전용 문장(en·ko)으로 보인다. 세션 검색에는 넣지 않고, 추론 판정 입력에서는 "Corral note"로 표시한다.
- **테스트**
  - 새로 쓴 것: `packages/core/test/no-progress-warning.test.ts`, `packages/adapter-pi/test/corral-directive.test.ts`, `packages/react/test/advisor-display.test.tsx`(Corral 알림 두 개)
  - 옛 승인 게이트를 쓰던 15개 테스트에만 같은 게이트를 설정으로 주입했다(`packages/core/test/no-progress-gate.ts`). 대부분 승인을 닫는 규칙, Reins 경계, 동시 대기를 검사한다. 기본 동작을 말하던 두 개("seventh request", "still bring the pause")는 주입한 게이트에 대한 테스트라고 이름을 고쳤다. 같은 파일의 나머지 106개는 기본 동작으로 돈다.
  - `no-usage-budget.test.ts`: 첫 테스트는 새 동작(105회 끝까지 성공, 경고 한 번)으로 고쳤고, 승인 뒤 계속을 검사하던 테스트는 지웠다.
  - e2e `file-preview.spec.ts`에서 무진전 멈춤을 건너가던 분기를 지웠다.
  - 골든 스트림 `no-progress-approval`: 경고 문구의 해시 한 줄만 바뀌어 다시 기록했다.

**남은 것**

- Q5(11-25): 같은 호출 6번째에 두 번째 알림을 보내고, 9번째는 `LIMIT_REACHED`로 거절한 뒤 그 실행 단위를 "the same tool call was repeated 9 times in a row"로 실패 처리한다(`Coordinator.afterRepeatedCall`). Run은 보통 실패 경로를 탄다.
- 표시 테스트는 구현한 뒤에 썼다. 무진전·반복 알림·worker 감싸기 테스트는 먼저 실패를 확인했다.
- 실제 모델로는 돌려 보지 않았다. 브라우저 화면도 확인하지 않았다.
- 무진전 경고 알림은 실행 화면의 응답 영역에 영어 문구로만 보인다.
- 반복 알림의 면제는 `await_tasks` 하나다. 도구 목록을 살펴보니 상태를 묻는 다른 도구는 없었다. 네이티브 도구 호출도 같은 승인 경로를 거쳐 함께 센다.

## 6. S2 M1b, S4 M2(조건부)

- **S2:** S0b가 출처를 찾은 공급자만 다룬다.
  - 모델 칩이나 활동 바의 컨텍스트 상세 옆에 "남은 한도 N% · HH:MM 리셋"을 보인다.
  - 값의 출처와 받은 시각을 함께 보관한다. 10분이 지나면 "오래된 값"으로 표시하고, 모르는 값은 0으로 보이지 않는다.
- **S4:** 대화 리드의 실행이 텍스트로 끝나면 결과를 제출하기 전에 판정을 한 번 묻는다.
  - 판정이 맞으면 "약속한 일을 지금 하라"는 지시로 한 번 더 진행한다(Run당 1회).
  - 판정이 실패하거나 시간을 넘기면 지금처럼 그대로 제출한다.
  - 판정 요청과 사용량은 기존 요청 기록에 남긴다.
  - Q3에 따라 판정 모델의 준비와 실패 처리를 명세에 먼저 쓴다.

## 7. 이 계획 밖

보고서의 나머지 후보는 하나를 고르면 그때 따로 계획을 쓴다. PR 흐름, 생각 반복 감지, 세션 목록 다듬기, 팔레트 순위, Outrider 캐시 분할, 이벤트 로그 정리 등이 여기에 든다.

## 8. 아직 확인하지 못한 것

- 리셋 시각을 준다고 확인한 공급자는 ChatGPT 하나다.
- 로컬 DB에는 실제 코딩 작업 기록이 거의 없다. S0의 빈도는 대표성이 없다.
- 실패한 worker 요청은 `ModelAttempt` 행으로 남지 않는다(S0a에서 8/8). 그 이유는 S1에서 코드로 확인한다.
- ChatGPT 한도 오류가 실제로 `QUOTA`로 분류되는지는 실제 응답으로 본 적이 없다.

## 9. 진행 방식

- 메인 세션이 직접 구현한다. Coordinator를 바꾸는 S1·S3만 Astra 리뷰와 Sol 확인을 거친다.
- E2E는 바뀐 명세에 해당하는 것만 돌리고, 전체 E2E는 마지막에 한 번 돌린다.
- 끝난 단계는 로컬 `develop`에 합친다. push와 PR은 요청이 있을 때만 한다.
