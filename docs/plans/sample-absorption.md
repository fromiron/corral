# 샘플 흡수: 작업 계획

이 문서는 계획이다. 동작의 정본은 [명세](../specs/README.md)다. 근거가 된 조사는 `output/sample-analysis-2026-11-25/report.md`(추적하지 않는 파일)에 있다. 처음에는 그 보고서 §3의 네 항목(M1a, M1b, M2, M3)만 다뤘고, 2026-11-25에 보고서 §4·§5의 나머지 후보와 서브세션을 더했다(§7). 단계를 마칠 때마다 진행 표를 고치고, 모두 끝나면 이 파일을 지운다.

## 0. 진행 표

| 단계 | 내용 | 상태 | 시작 조건 |
|---|---|---|---|
| S0 | 측정과 확인(제품 코드 변경 없음) | 끝(11-25). 결과는 §3 끝 | 없음 |
| S1 | M1a: 한도가 풀리면 다시 보내기 | 끝(11-25). Astra·Sol 확인은 아직(§4) | 풀림 |
| S2 | M1b: 남은 한도 보기 | 뺌(11-25) | T1에서 지원되는 출처가 없었다(§7 T1 결과) |
| S3 | 무진전을 경고로 바꾸기(Q1)와 M3: 같은 도구 반복에 알리기 | 끝(11-25). Astra·Sol 확인은 아직(§5) | 풀림 |
| S4 | M2: 말만 하고 끝난 턴 | 뺌(11-25) | S0c에서 0/18. 실제 코딩 기록이 쌓이면 다시 잰다 |
| T1 | 끝낸 단계의 확인 닫기: S2 헤더 확인, 실제 모델 코딩 세션 한 번 | 끝(11-25). 결과는 §7 T1 | 없음 |
| T2 | 생각 반복 감지, Outrider 검토 입력의 캐시 분할 | 끝(11-25). 생각 반복 감지만 들였다(§7 T2 결과) | 없음 |
| T3 | 서브세션, Paddock 브랜치 | 진행 중(11-25). 명세 끝, T3a부터 | 없음 |
| T4 | PR 흐름 | 대기 | T3 |
| T5 | 화면 다듬기 | 대기 | T3(세션 목록을 한 번에 고친다) |
| T6 | 나머지 기능 | 대기 | 항목마다 다름 |
| T7 | 이벤트 로그 정리 | 대기 | 실행 기록 재열람 약속을 따로 정함 |

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

## 7. 로드맵(2026-11-25에 더함)

사용자가 보고서의 나머지 후보 전부와 서브세션 도입을 원했다(2026-11-25). 순서와 아래 결정은 사용자가 정했다. 단계마다 명세를 먼저 쓰고, 반례 테스트를 실패로 확인한 뒤 구현한다. 리뷰는 Astra가 돌아올 때까지 어드바이저가 맡고, Astra가 복구되면 쌓인 커밋을 Astra·Sol이 한 번에 본다.

**T1 확인 닫기**
- **S2 헤더 확인.** ChatGPT와 Anthropic 구독으로 짧은 요청을 한 번씩 보낸다(사용자 허락, 11-25).
  - 순서: 먼저 `/model-auth`에서 Anthropic 구독 로그인이 있는지 본다. 자격 증명 파일은 읽지 않는다. 요청은 Corral 자신의 요청 경로로 보내고, 모델 브리지가 받는 응답 헤더에 임시 캡처를 단다.
  - 기록: 출력하기 전에 한도 관련 이름(`ratelimit`, `limit`, `reset`, `usage`, `x-codex`)만 남긴다. 걸러지지 않은 헤더에는 조직·요청 ID가 있다. 헤더 이름과 값의 모양(퍼센트, 초, 시각)만 적고, 토큰과 값 그 자체는 남기지 않는다.
  - 끝: 캡처를 지운다.
  - 결과로 S2의 범위를 정한다. 출처가 있으면 S2를 T2 앞에 끼운다.
- **실제 코딩 세션.** GLM이나 DeepSeek로 한 번 돌리고, 지켜본다.
  - 준비: HEAD에서 서버를 새로 띄운다. 이미 떠 있는 개발 서버는 세 커밋보다 오래됐을 수 있다.
  - 합격 기준:
    - 같은 명령을 같은 인자로 3번 연속 시키면 출처 `corral`의 지시가 접수되고 다음 요청에 실린다.
    - 네이티브 도구 호출도 `tool.requested`로 기록된다.
    - 진전 없는 응답 6번에 경고만 남고 승인 카드가 없다.
  - 사용 한도는 일부러 일으킬 수 없으므로, S1의 다시 보내기 경로는 이번에도 확인하지 못한 것으로 둔다.
- **T1 결과(11-25)**
  - **S2 헤더.**
    - Anthropic 구독 로그인이 없어 ChatGPT만 보냈다(사용자가 허락할 때 정한 대로). 요청은 성공했다.
    - 정상 응답(200)의 한도 관련 헤더는 `x-codex-safety-buffering-enabled`, `x-codex-safety-buffering-faster-model`, `x-codex-turn-state`뿐이었다. 남은 한도나 리셋 시각은 없었다. 모양 기록은 `output/sample-analysis-2026-11-25/s0/t1-chatgpt-headers.jsonl`에 있다.
    - 설치된 Pi 1.6.0에는 스트림으로 오는 한도 이벤트(`rate_limits` 등)를 다루는 코드가 없다.
    - ade는 이 값을 Codex CLI 앱 서버의 `account/rateLimits/read`로 따로 읽는다. Corral에는 지원되는 출처가 없으므로 S2를 뺀다. 다시 하려면 Codex CLI 연동을 따로 정해야 한다.
  - **실제 코딩 세션(DeepSeek, HEAD에서 새로 띄운 서버, 신뢰한 git 폴더, 권한 `auto`).**
    - 네이티브 `run_command`가 같은 인자 해시로 세 번 `tool.requested`에 기록됐다.
    - 세 번째 직후 출처 `corral`의 지시가 접수됐고, 다음 요청에 첨부·전달됐다(`directive.attached`, `directive.dispatched`).
    - 모델은 네 번째 호출 없이 결과를 제출했고, Run은 성공했다.
    - 무진전 경고(진전 없는 응답 6번)는 이 세션에서 일어나지 않아 실제로는 보지 못했다. 단위 테스트로만 확인했다.
  - 임시 헤더 캡처는 지웠고(`request-runtime.ts`는 HEAD와 같음), 임시 작업공간도 지웠다.

**T2 비용·성공률(작은 포팅)**
- 샘플 코드는 그대로 옮겨도 된다(아래 라이선스, 11-25). 옮긴 파일은 고지에 적는다.
- **생각 반복 감지:** pi 샘플 `packages/ai/src/utils/thinking-loop.ts`.
  - 다시 생성하는 것은 지금의 "추론 조각만 나오고 끊긴 응답" 재시도 규칙과 그 두 번 한도([LLM 런타임](../specs/llm-runtime.md) 15행) 안에 넣는다.
  - 올리는 수치: 생각 반복으로 출력 예산을 다 쓰고 끝난 요청의 비율. DeepSeek로 잰다.
- **Outrider 검토 입력:** 원본 메시지별로 나눠 캐시가 늘어나게 하고, 지난 검토의 읽기 결과를 줄인다. pi 샘플 `advisor/delta-split.ts`, `tool-result-eviction.ts`.
  - 먼저 `packages/core/src/advisor/delta.ts`가 이미 메시지별로 나누는지 읽는다.
  - 올리는 수치: Outrider 요청의 cache_read 비율.
- **T2 결과(11-25)**
  - **생각 반복 감지.**
    - pi 샘플의 감지기와 그 테스트를 그대로 옮겼다(`packages/adapter-pi/src/ported/thinking-loop.ts`, `test/thinking-loop.test.ts`). 바꾼 것은 문법 두 가지(생성자 매개변수 속성, strict 인덱스)와 모델 계열 판단뿐이다. 고지는 `THIRD-PARTY-NOTICES/llm-runtime-ports.md`에 적었다.
    - `managedRetryStream`이 시도마다 자기 중단 신호를 만들어 `open`에 넘기고, 세 worker 호출부가 그 신호를 요청에 쓴다. 추론만 붙잡아 둔 동안 반복을 감지하면 그 시도를 끊고 같은 두 번 한도 안에서 다시 보낸다. 마지막 시도는 감시하지 않는다.
    - 재시도 테스트 세 개 가운데 끊기와 마지막 시도 테스트는 먼저 실패를 확인했다. Claude·본문 이후는 지키지 않는다는 테스트는 구현 전에도 통과하는 반례다.
    - Outrider 검토는 감시하지 않는다(`watchLoops: false`). 검토 요청은 한도가 있어, 끊은 뒤 다시 보낼 허가를 못 받으면 끝났을 검토가 실패한다.
    - 끊은 이유는 기록되지 않는다. 관찰 프레임에 그 칸이 없어 프로토콜과 스키마를 바꿔야 한다. 끊긴 시도의 사용량은 0이 아니라 모름으로 남는다.
    - 포팅 파일은 `ported/dsh`처럼 주석 수 lint에서 뺐다(`tools/lint/comments.ts`).
    - 실제 DeepSeek에서 반복이 일어나는 것은 보지 못했다. 효과(출력 예산을 다 쓰고 끝난 요청의 비율)는 아직 재지 않았다.
  - **Outrider 캐시 분할: 들이지 않았다.**
    - 코드를 읽고 정했고 cache_read는 재지 않았다. Corral의 Outrider는 검토마다 같은 대화에 사용자 메시지를 하나씩 덧붙인다(`worker.ts`의 `reviews`). 앞의 검토들이 이미 바뀌지 않는 앞부분이라 캐시가 늘어난다. pi의 분할은 그렇지 않은 구조의 문제를 푼 것이다.
    - 지난 검토의 읽기 결과를 줄이는 것은 캐시된 앞부분을 다시 쓰게 만든다. Outrider 요청의 cache_read를 재서 이득이 보일 때만 다시 본다.

**T3 서브세션** (명세 [서브세션](../specs/features/sub-sessions.md), [Paddock의 브랜치](../specs/workbench.md#paddock의-브랜치))
- 정한 것(11-25): 사람이 연다, 보통 세션 + 부모 연결, 부모 사본의 지금 상태에서 갈라 낸다, 사람이 버튼으로 합친다, 목록에서 부모 밑에 들여쓴다.
- 더 정한 것(11-25, 사용자): Paddock은 만들 때 자기 브랜치를 갖는다(이름은 Paddock 그대로), 사본·세션을 지워도 브랜치는 남는다, 서브세션은 여러 단계, 가족은 가장 급한 묶음으로 함께 간다.
- 확인한 것: 대화에서 갈라 만든 세션은 `branchRuntimeFiles`로 원본 사본의 기준 커밋에서 detached 사본을 만들고 체크포인트를 복원한다. 서브세션은 이 길을 부모 HEAD와 브랜치로 바꿔 쓴다. 무시된 파일은 `snapshotTree`(`git add -A`)가 넣지 않는다.
- 단계
  - T3a Paddock 브랜치: `createWorktree`가 `-b`로 만든다. 이름 규칙과 겹침. 지우기가 브랜치를 남긴다.
  - T3b 서버: `parent_session_id`, 열기 명령, 합치기 준비 읽기, 삭제의 부모 연결 지우기.
  - T3c Studio: 더 보기 메뉴, 목록·사이드바의 가족, 경로, "부모에 합치기"와 부모 merge의 브랜치 미리 고르기.

**T4 PR 흐름**
- 출처는 ade 샘플이다. 상황에 따라 바뀌는 commit·push·PR 버튼과 PR 본문 생성(D5), 에이전트가 셸로 만든 PR 자동 연결(`PullRequestSyncReactor.ts`), PR 감시와 에이전트 깨우기(`pullRequestWatch.ts`, D8).
- 서브세션 브랜치에서 PR을 열 수 있게 한다. 기능 미리보기의 `pr-review`는 실제 기능으로 바꾸거나 지운다.

**T5 화면 다듬기**
- 세션 목록: 신경 쓸 필요 없는 행 흐리게 하기, 보관의 되돌리기 알림, 돌아온 시각 순 정렬(ade F2–F6)
- 명령 팔레트의 최근·자주 연 순위(ade `paletteSearch.ts`)
- 긴 답의 첫 줄 착지와 "새 글" 알약(agentes `anchor.ts`, `reading.ts`, `unseen.ts`)
- "보이는 것만 전체 승인", 사라진 질문의 답을 초안으로 보존
- 알림의 처음 관측 제외를 예약 실행 밖으로 넓히기, 배지
- 무진전 경고의 한국어 표시

**T6 나머지 기능**
- 곁가지 질문(`/btw`) 화면(서버의 explain 경로가 있다)
- 다른 코딩 도구의 세션 가져오기(ade C13, pi 10.5)
- Corral 기능을 MCP 서버로 열기(ade A16·H6, agentes 10.3). 권한 범위를 먼저 정한다.
- 에이전트가 스스로 나중에 다시 깨어나기(agentes `follow_up`, ade PR 감시)
- 도구 호출마다 의도 문장(pi 1.2), 큰 파일은 선언만 먼저(pi 3.2), 셸 출력 줄이기(pi 4.2, 정의 파일의 출처 확인 필요)
- 모델 계열별 기본 편집 방식(pi 2.6)
- Hashline 편집 거절 때 문제 줄을 함께 보여 주기(pi 2.4). 작은 포팅이 아니다. 읽은 근거의 정의(ABS-03)가 바뀌므로 명세 결정이 먼저다.

**T7 이벤트 로그 정리**
- ade A6 방식(보관 기간, 정리 경계 표시, 재접속 replay 상한)을 참고한다. Corral은 실행 기록 재열람이 제품 약속이라, 무엇을 지워도 되는지부터 정한다.

**라이선스(정함, 11-25)**
- 사용자가 세 샘플 모두 직접 기여한 코드라며 그대로 옮겨도 된다고 했다. 옮긴 파일은 `THIRD-PARTY-NOTICES/`에 "기여자 본인의 코드"로 적고, 사용자가 저장소 이름과 커밋을 알려 주면 그것을 더한다.
- 그 전에 확인한 표기: Corral은 MIT이고, 포팅한 코드를 `THIRD-PARTY-NOTICES/llm-runtime-ports.md`에 저장소와 커밋으로 적는다.
  - ade: 패키징 메타데이터가 MIT다.
  - pi: 라이선스 표기가 없다.
  - agentes-chat: AGPL 신호가 있다(데스크톱 크레이트, `check-licenses.ts`의 NOTICE 언급).

## 8. 아직 확인하지 못한 것

- 리셋 시각을 준다고 확인한 공급자는 ChatGPT 하나다.
- 로컬 DB에는 실제 코딩 작업 기록이 거의 없다. S0의 빈도는 대표성이 없다.
- 실패한 worker 요청은 `ModelAttempt` 행으로 남지 않는다(S0a에서 8/8). 그 이유는 S1에서 코드로 확인한다.
- ChatGPT 한도 오류가 실제로 `QUOTA`로 분류되는지는 실제 응답으로 본 적이 없다.

## 9. 진행 방식

- 메인 세션이 직접 구현한다. Coordinator와 데이터 경로를 바꾸는 단계는 Astra 리뷰와 Sol 확인을 거친다. Astra가 안 될 때는 어드바이저가 리뷰한다(사용자 결정, 11-25).
- E2E는 바뀐 명세에 해당하는 것만 돌리고, 전체 E2E는 마지막에 한 번 돌린다.
- 끝난 단계는 로컬 `develop`에 합친다. push와 PR은 요청이 있을 때만 한다.
