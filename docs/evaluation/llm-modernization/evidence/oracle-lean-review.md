## 판정 요약

**①·②는 실제 기능 결함, ③은 검증 흐름의 자기참조 문제, ④는 줄일 수 있는 중복 비용입니다. ⑤는 “독립적인 정확성 검증”이라는 해석은 과장됐지만, 검증 자체를 불필요하다고 보고 삭제하면 보장이 줄어듭니다.**

| 쟁점 | 판정 | 우선순위 |
|---|---|---|
| ① usage-anchor를 bridge/host 재계측이 무효화 | 확인 | P1 |
| ② 요약 이후 checkpoint 원문 참조 누락 | 확인 | P1 |
| ③ 생성 증거가 candidate hash에 포함 | 확인. 단, 과거 증거의 유효성과 현재 후보 일치는 구분 | P2 |
| ④ checkpoint 반복 직렬화·원문 조회 | 확인. 다만 측정 해석과 증분화 범위를 축소해야 함 | P2 |
| ⑤ 같은 transformer를 재실행하는 검증 | 정확성 증명이라는 해석은 기각. 대응 관계 검증으로는 유지 | 수정 최소화 |
| 원장의 전체 snapshot 이벤트 | 결함으로 확정하지 않음 | 유지 |

최신 첨부를 기준으로 검토했습니다. 전체로 포함된 현재 소스 39개와 tracked diff의 SHA256은 manifest와 일치했습니다. 일부 함수를 분리한 재현과 임시 Git 저장소 검증도 수행했지만, **전체 Coordinator·Pi 통합 테스트나 설치판을 다시 실행한 것은 아닙니다.** 아래 줄 번호는 원본 소스 기준입니다.

---

## ① P1 — 최종 입력·출력 예산 판단을 host 한 곳으로 모아야 합니다

**위치·함수**

`packages/adapter-pi/src/worker.ts:495–520` — `sendRequest()`\
`packages/adapter-pi/src/sdk-worker.ts:494–508` — `oneRequest()`\
`packages/adapter-pi/src/model-bridge.ts:134–142` — `modelBridgeChannel()`\
`apps/server/src/models/request-runtime.ts:235–240` — `ModelRequestRuntime.stream()`

**발생 조건·영향**

worker의 `ContextMeter`가 이전 요청의 실제 usage로 보정한 입력량을 사용하지만, bridge와 runtime은 각각 다시 순수 density 추정으로 남은 출력 공간을 계산합니다. 따라서 **이미 보정된 준비 판단이 뒤의 더 거친 추정에 의해 거절되거나, 출력 상한이 불필요하게 낮아집니다.** worker의 보정 계산과 후속 계층의 재계산은 실제 소스에 모두 있습니다. corral-lean-review corral-lean-review corral-lean-review

분리 재현에서도 첨부와 같은 `density=21009`, `usage_anchor=13004`, `worker cap=4000`을 얻었고, density를 다시 적용하면 전송 전에 실패했습니다.

다만 증거의 범위는 바로잡아야 합니다. 첨부 probe의 **`bridgeError`는 실제 bridge를 실행한 결과가 아니라 bridge가 사용하는 `requestOutputCap()`을 직접 호출한 결과**입니다. runtime 재현도 draft 소유 요청입니다. 연결 코드상 결함은 성립하지만, 수정 회귀는 이 함수들만 다시 확인해서는 부족합니다. corral-lean-review

**최소 수정**

**worker는 압축 판단, bridge는 permit 상한 집행, runtime은 최종 context/output 판단**으로 역할을 나누십시오.

기존 `ModelRegistry.modelBroker()`는 execution별로 만들어지는 수명 범위가 있으므로, 여기에 기존 `ContextMeter` 하나를 두고 runtime의 내부 호출에 전달하면 됩니다. anchor는 **host가 실제로 보낸 정규화 컨텍스트와 host가 관측한 정상 응답 usage**에서만 갱신합니다. worker가 보낸 추정 숫자나 컨텍스트 안의 과거 usage를 신뢰할 필요가 없습니다.

bridge의 `measureContext()` 재계산은 삭제하고, permit·catalog 상한 및 worker가 요청한 더 작은 출력값만 적용합니다. worker의 입력량 기반 출력 제한도 최종 결정으로 사용하지 않고, host에서 보정된 입력량을 기준으로 한 번 결정합니다. worker의 meter는 자동 압축 판단에 남깁니다.

runtime의 `prepared.measurement`도 실제 사용한 `usage-anchor-v2` 또는 `dsh-density-v2`를 기록해야 합니다. 별도 정책 관리자나 IPC용 “추정값 인증” 구조는 필요 없습니다. **기존 prefix·model·tools 동일성 검사, 최종 payload 검사, 슬롯·취소·late usage 처리는 유지**합니다.

**기존 회귀 하나·종료 기준**

`packages/adapter-pi/test/model-bridge-modernization.test.ts`의 **“host applies the model maximum…”** 테스트에 실제 `ModelRequestRuntime`을 연결하십시오.

첫 응답에서 host가 usage anchor를 얻고, 다음 요청이 `21009 → 13004` 보정으로 실제 provider stub에 도달하며 출력 상한이 `4000`인지 확인하면 됩니다. 기존 ContextMeter의 prefix/model/tools 변경 시 anchor 무효화 테스트는 그대로 사용합니다. **보정된 값이 최종 전송·원장에 일치하고 permit/model 상한을 넘지 않으면 종료**합니다.

---

## ② P1 — 원문 참조 목록을 현재 보이는 메시지에서 만들면 안 됩니다

**위치·함수**

`packages/core/src/coordinator.ts:8259–8278` — `hostFor().checkpointContext()`\
`packages/core/src/coordinator.ts:9062–9070` — `toolResultSource()`\
`packages/adapter-pi/src/ported/dsh/context.ts:200–260` — `summarizeRegion()`

**발생 조건·영향**

현재 source 수집은 복구 시 물려받은 sources와 입력 sources를 유지하지만, **현재 execution에서 생긴 도구 결과는 지금 투영에 남아 있는 `toolResult`에서만 찾습니다.** 요약이 이 메시지를 제거하면, 요약문에 `toolCallId`가 남아 있어도 다음 checkpoint의 sources에서는 빠집니다. corral-lean-review

같은 Run에서는 `run.projection.toolCalls`로 읽을 수 있어 문제가 가려집니다. 새 Run으로 복구·분기하면 조회 경로가 현재 Run의 tool 기록 또는 `resumeContext.sources`뿐이어서 원문 접근이 끊깁니다. **원본 저장소의 삭제가 아니라, 복구본이 원문을 찾을 참조 관계를 잃는 문제**입니다. corral-lean-review

**최소 수정**

sources의 기준을 다음 합집합으로 바꾸십시오.

> 검증된 inherited sources + 현재 입력 sources + 현재 execution이 소유한 finished tool records의 resultRef

현재 메시지를 훑는 `for`문을 **기존 `run.projection.toolCalls`의 소유·완료 기록 조회**로 바꾸고, 동일한 `toolResultSource()` 조건을 재사용하면 됩니다.

지난 checkpoint의 sources만 무조건 병합하는 방식보다 이쪽이 완결적입니다. 첫 checkpoint 전에 요약된 결과도 누락되지 않기 때문입니다. 요약문에서 ID를 정규식으로 추출하거나, 모델에게 참조 목록을 다시 작성하게 할 필요도 없습니다.

다른 execution의 결과를 포함하거나 이전 Run의 tool authorization을 복원하지 마십시오. 보존하는 것은 **읽을 원문과 참조 관계**이지 과거 실행 권한이 아닙니다.

**기존 회귀 하나·종료 기준**

`apps/server/test/runtime-checkpoints.test.ts`의 기존 복구 테스트를 확장하십시오. 현재 테스트는 **pruning 후에도 `toolResult`가 남아 있는 상태**를 저장하므로 이번 누락을 통과시킵니다. corral-lean-review

checkpoint 직전에 해당 toolResult를 **ID만 남은 요약 메시지로 교체**하고, 재시작·복구 후 기존 `read_artifact` 호출이 가운데 식별자를 읽는지 확인하십시오. 같은 테스트의 무관한 `toolCallId` 거절도 유지합니다.

**요약 이후 복구에서도 원문을 읽고, 다른 소유자의 ID는 읽지 못하면 종료**합니다. 별도 이력 계층은 필요 없습니다.

---

## ③ P2 — candidate에서 제외할 것은 생성 결과이지 검증 코드가 아닙니다

**위치·함수**

`tools/release/candidate.ts:7–30` — `candidateFiles()`, `candidateHash()`\
`tools/release/policy.ts:177–199` — `verifyEvidence()`\
`apps/desktop/scripts/prepare.ts:190–203, 233` — corresponding source·candidate 기록

**발생 조건·영향**

현재 candidate는 Git이 열거한 tracked·untracked 파일 전체를 해시합니다. 여기에 `sourceCandidate`를 담은 생성 보고서가 포함되면, 보고서를 쓰는 행위가 그 보고서가 가리키던 candidate를 바꿉니다. `verifyEvidence()`는 현재 candidate와 정확히 같은 값을 요구하므로 검증 결과를 저장하면서 스스로 stale하게 만드는 흐름입니다. corral-lean-review

임시 Git 저장소에서 생성 보고서를 세 번 갱신한 재현에서도 매번 기록된 값과 이후 candidate가 달랐습니다.

하지만 **과거 실행 증거에 당시 candidate가 적혀 있는 것 자체는 결함이 아닙니다.** 첨부에 기록된 AppImage 동작 성공을 무효라고 볼 근거도 없습니다. 문제는 과거 증거를 현재 후보의 정확한 증거로 재사용하려 하거나, 생성 결과까지 입력 identity에 포함하여 일치를 유지할 수 없게 만든 부분입니다.

**최소 수정**

`candidateFiles()`에서 **명확한 생성 결과 경로만 제외**하고, hash와 corresponding-source 복사가 같은 목록을 사용하도록 하십시오. `.gitignore`만 바꾸면 이미 tracked인 증거는 계속 포함되므로 충분하지 않습니다.

`docs/evaluation` 전체를 제외하면 안 됩니다. `probes/verify-package.mjs`, 테스트·빌드 스크립트, lockfile, patch, 포팅 소스와 LICENSE/NOTICE는 계속 입력으로 취급해야 합니다.

기존 `corresponding-source/manifest.json`을 사용해 빌드 입력 candidate를 한 번 확정하고 관련 메타데이터에 재사용하십시오. 끝에서 입력 변경 여부를 확인하는 검사는 남겨도 됩니다. **보고서 갱신은 candidate를 바꾸지 않고, 소스·검증 코드·의존성 변경은 바꾸는 경계**가 핵심입니다.

과거 증거를 새 candidate로 소급 재라벨하지 마십시오.

**기존 회귀 하나·종료 기준**

`tools/release/release.test.ts:144–171`의 **“candidate proof changes … but ignores generated output”** 테스트를 보강하십시오. 현재는 `.gitignore`로 제외한 `output/`만 확인하므로 tracked 증거 문제를 잡지 못합니다.

실제 생성 증거 경로의 파일을 먼저 `git add`한 뒤 내용을 변경해도 candidate가 유지되는지 확인하고, 기존 소스 추가·수정·삭제 검증과 probe/patch 변경 시 candidate가 바뀌는 검증을 같은 테스트에 넣으면 됩니다.

**증거를 다시 써도 candidate가 유지되고 실제 입력 변경에는 바뀌면 종료**합니다. 이를 입증하려고 live A/B를 반복할 필요는 없습니다.

---

## ④ P2 — 중복 비용은 줄이되, 완전 증분화까지 작은 수정이라고 보지는 않습니다

**위치·함수**

`packages/core/src/context-checkpoint.ts:8–28, 41–70` — encode/decode\
`packages/core/src/coordinator.ts:8262–8289, 8370–8372` — source 수집·저장\
`packages/core/src/coordinator.ts:897–926, 1126–1134` — checkpoint 로드·복구

### 확인되는 비용과 과장된 해석

encoder는 매번 모든 메시지와 sources를 직렬화·해시하고, commit은 모든 chunk에 `getArtifactText()`를 호출하여 존재 여부를 확인합니다. 저장 중복은 줄였지만 CPU와 기존 본문 조회까지 증분화한 것은 아닙니다. corral-lean-review corral-lean-review

다만 **`5050 bodyReads`는 SQLite 조회 횟수가 아닙니다.** probe가 세는 것은 메시지 `content` getter 접근입니다. 분리 재현에서도 100개 누적 메시지에 `1+…+100=5050`번 접근했지만, 이 부분에서는 DB를 호출하지 않았습니다. DB 재조회 문제는 별도의 commit 코드로 확인됩니다. corral-lean-review

또한 첨부의 fixture 시간 증가를 전체 작업 지연 증가로 일반화해서는 안 됩니다. **저장량 감소는 유효한 개선이고, 직렬화 중복은 별도로 개선할 대상**입니다.

### 최소 수정

**첫째, 이미 commit한 참조만 재사용하십시오.** `hostFor()`의 execution 수명 안에서 마지막으로 성공한 checkpoint의 chunk/source 참조를 재사용하고, 새 source만 원문 조회·chunk화합니다. 이미 저장한 chunk의 존재 확인을 위해 큰 본문을 다시 가져오지 않도록 합니다. 참조 목록은 **commit 성공 후에만** 갱신합니다.

이는 일반 캐시가 아니라 현재 checkpoint의 저장 참조 재사용입니다. sources의 원문을 모두 별도 메모리 캐시에 보관하거나 새 저장 형식을 도입할 필요는 없습니다. 복구·private export에서는 기존 hash/bytes·누락 본문 검증을 유지합니다.

**둘째, 같은 경계 안의 직렬화만 중복 제거하십시오.** `encoded.text`가 이미 canonical 문자열이므로 manifest용 hash는 그 바이트에서 계산하면 됩니다. `hashOf(encoded.stored)`로 다시 직렬화할 필요가 없습니다. 문자열을 다시 JSON 문자열로 감싸는 `hashOf(encoded.text)`와는 구분해야 합니다. corral-lean-review

decode에서 이미 확인한 context hash를 `loadRuntimeCheckpoint():922`에서 다시 계산하는 것도 정리할 수 있습니다. 단, 현재 decoder의 v1 경로에는 같은 검사가 없으므로 **v1/v2 공통 검사를 decoder로 모은 뒤** 호출자의 중복만 제거해야 합니다. manifest identity·criteria·protected state 검사는 다른 대상을 확인하므로 남깁니다. corral-lean-review corral-lean-review

**셋째, 하나를 복구할 때 모든 checkpoint를 다시 읽지 마십시오.** `resumeRuntime()`은 선택한 checkpoint를 로드한 뒤 `runtimeCheckpoints()`로 전체 목록을 로드하여 그중 하나를 다시 찾습니다. 선택한 항목의 readiness 계산을 기존 로드 결과에 적용하도록 분리하면 됩니다. 전체 목록 API의 동작과 `await` 이후 파일·소유권 재검증은 유지합니다. corral-lean-review

반대로, **메시지 개수나 객체 동일성만 보고 이전 메시지 검증을 건너뛰는 최적화는 기각**합니다. 현재 IPC는 매번 전체 메시지 snapshot을 받습니다. 이 계약을 유지하면서 안전한 `O(새 메시지)` 직렬화를 보장한다고 말할 수는 없습니다. 이번에는 기존 원문 재조회와 동일 경계 중복을 제거하는 선에서 끝내는 것이 맞습니다.

**기존 회귀 하나·종료 기준**

②에서 확장한 `runtime-checkpoints.test.ts`의 동일 fixture에 store spy를 붙이십시오. 다음 checkpoint에서 **기존 source 본문과 기존 chunk 본문을 존재 확인용으로 다시 조회하지 않는지**, 선택한 checkpoint 복구가 무관한 checkpoint 본문까지 읽지 않는지 확인하면 됩니다.

기존 `context-checkpoint.test.ts`의 v1 읽기·본문 변경·본문 누락 실패 검증은 그대로 실행합니다. **읽기 호출 수와 저장 참조 재사용으로 판정하고, 밀리초 임계값을 가진 새 성능 suite는 만들지 않습니다.**

---

## ⑤ 검증 삭제는 기각 — 증명하는 내용을 좁히고 실행 빈도를 줄이십시오

**위치·함수**

`docs/evaluation/llm-modernization/probes/verify-package.mjs:37–56` — transformer 추출·재컴파일 비교\
`apps/desktop/scripts/check-runtime.mjs:108–134` — 실제 Core/SDK worker 기동

**판정·영향**

같은 transformer를 다시 사용하므로, transformer의 잘못된 변환을 양쪽에서 동일하게 재현하면 비교는 통과합니다. 따라서 **transformer 논리의 독립적인 정확성 검증은 아닙니다.**

그러나 다음 사실은 확인합니다.

> 현재 소스와 빌드 규칙을 적용한 결과가 배포된 JS와 같은가?

이 검사는 잘못된 버전의 JS, 누락된 컴파일, 오래된 staging 결과를 잡을 수 있습니다. 반면 source hash 검사와 staging→package hash 검사만으로는 **“소스도 일치하고 패키징 복사도 정확하지만, 그 JS가 그 소스에서 만들어지지 않은 상태”**를 배제하지 못합니다. 현재 probe는 이 서로 다른 관계를 따로 검사하고 있습니다. corral-lean-review

**최소 수정**

이번에는 재컴파일 블록을 삭제하지 않는 편이 더 작고 안전합니다. 주석과 보고서의 의미를 **소스→출력 대응 검사**로 명확히 하고, 같은 frozen candidate·toolchain에 대해 한 번만 수행하십시오.

검증을 없애기 위해 새 output-manifest 체계를 추가하면 이번 정리의 목적과 반대가 됩니다. 기존 manifest를 확장하더라도 “어떤 출력 파일을 포장했는가”와 “그 출력이 해당 소스에 대응하는가”를 혼동해서는 안 됩니다.

**기존 검증 하나·종료 기준**

기존 package parity 실행과 `check-runtime.mjs`의 실제 worker handshake를 한 번 사용하십시오. 전자는 대응 관계, 후자는 적어도 실제 worker entry가 로드되는지를 확인하는 것으로 역할이 다릅니다. corral-lean-review

**동일 후보·toolchain의 parity와 실제 기동이 통과하면 종료**합니다. 보고서 문구나 집계값을 다시 썼다는 이유로 재컴파일·기동을 반복하지 않습니다. 새 transformer 테스트 suite도 필요 없습니다.

---

## 원장 snapshot과 유지해야 할 가드

`packages/storage-sqlite/src/model-attempt-store.ts:31–61`의 전체 snapshot 이벤트는 **현재 자료만으로 삭제할 근거가 없습니다.** 동일 snapshot은 이미 저장하지 않으며, 변경된 상태만 current row와 이력에 함께 기록합니다. 첨부의 10개 요청·30개 이벤트는 요청당 준비·payload·종료 단계 기록과 부합하고, delta마다 전체 원장을 쓰는 폭증을 입증하지 않습니다. corral-lean-review corral-lean-review

운영 reader가 보이지 않는다는 이유만으로 감사 자료를 삭제하거나 delta-event 체계로 재작성하지 마십시오. 이 항목은 **변경 없음, 새 회귀 없음**이 최소안입니다.

마찬가지로 `await` 전후의 attempt/revision·현재 소유권 검사, 취소된 transport의 슬롯 유지, late usage의 원래 정산 연결, 복구 시 hash/본문 검증은 이번에 제거할 중복이 아닙니다. 줄일 대상은 **동일한 데이터를 같은 경계 안에서 다시 계산하는 부분**이지, 다른 신뢰 경계나 비동기 경계에서 다시 확인하는 부분이 아닙니다.

## 적용 순서와 검증 종료점

**수정 순서는 `③ candidate 경계 → ① 최종 예산 판단 → ② source 보존과 ④ checkpoint 정리 → ⑤ 검증 의미·실행 빈도 정리`가 적절합니다.** candidate 경계를 먼저 고정하면 이후 증거 저장 때문에 검증을 다시 시작하는 순환을 피할 수 있습니다.

수정 중에는 위에서 지정한 기존 회귀만 확장해 red→green을 확인하고, 기존 취소·late usage·소유권·무제한·회의 병렬화 검증은 변경하지 않습니다. 변경한 타입·계약 검사를 마친 뒤, 이번에는 요청 runtime과 복구 경로가 함께 바뀌므로 **최종 통합 상태에서 전체 suite 한 번**은 타당합니다. 이어 frozen 후보의 package parity·기동을 한 번 확인하면 이번 개선 검증을 끝낼 수 있습니다.

①은 CR-052 §4의 **최종 요청 경계 책임**, ②·④는 §8의 **불변 본문 재사용과 복구**, ③·⑤는 §10 및 검증 절의 **입력·배포물·증거 관계**를 명확히 하는 변경입니다. 승인된 무제한 정책·병렬 독립 회의·권한·라이선스 범위를 바꾸는 새 기능은 필요하지 않습니다. corral-lean-review

**이후 생성 보고서만 변경했다면 코드·설치판·live A/B를 다시 검증하지 않습니다. 실제 소스·의존성·빌드 입력이 바뀐 경우만 새 후보로 취급하십시오.**
