# CR-018: 역할별 Pi 표준 스킬·확장 실행

- 요청: Bell, 2026-10-17. 원안은 [Corral Personal Harness 구현 계획](../proposals/personal-harness-2026-10-17.md)이다.
- 구현 플랜: [Personal-Harness-Implementation-Plan](../plans/Personal-Harness-Implementation-Plan.md).
- 기준: `f17338f`(PR #54 병합).
- 관련: ADR-005(agent-core worker), ADR-024(admission gate), C-052(worker 규칙), CR-012(파일 broker), CR-016(명령 레지스트리).
- 결정: [ADR-027](../Decisions.md#adr-027-pi-coding-agent-sdk를-역할별-실행-방식으로-추가한다).
- 상태: **구현·로컬 검증 완료** (2026-10-18). Bell의 H2–H8 구현 요청을 반영했다. 제품 동작과 검증 경계는 [최종 보고서](../evaluation/Personal-Harness-Validation-2026-10-18.md)를 따른다. 스파이크 코드는 테스트에만 있다.

## 바뀌는 것

| 영역 | 지금 | 바뀐 뒤 (R1 = 플랜 H0–H3) |
|---|---|---|
| 역할 실행 방식 | 모든 역할이 `pi-agent-core` worker(`worker.ts`) | 역할마다 `runtime: 'pi-core' \| 'pi-sdk'`. 값은 Run 시작 시 고정한다. 기본값은 `pi-core`다. 스킬·확장을 바인딩한 역할만 `pi-sdk`(`@earendil-works/pi-coding-agent` SDK)를 쓴다 |
| 스킬 | 없음 | Agent Skills 형식(`SKILL.md`)을 원본 그대로 쓴다. 적용 수준은 자동 선택·명시적 호출·필수 적용 세 가지다. 필수 적용은 system prompt 구획에 본문을 넣는다. 스킬 스크립트는 실행하지 않는다 |
| 확장 | 없음 | Pi 패키지·확장을 **신뢰한 네이티브 코드**로 역할에 바인딩한다. 실행 위치는 worker 프로세스 안이다 |
| 리소스 | 없음 | 설치 → 신뢰(내용 hash 단위) → 역할 바인딩 → 실행을 분리한다. 실행에는 핀 고정 snapshot을 쓴다. 자동 탐색(`~/.pi/agent`, `.pi/`, `.agents/skills`, `AGENTS.md`)은 하지 않는다 |
| 모델 요청 | worker가 요청마다 host permit을 받는다 | 같다. SDK 실행은 Corral provider 하나로만 요청한다. 세션·재시도·압축·확장 중첩 호출이 모두 permit을 받는다. Pi 런타임에 실제 자격 증명을 넣지 않는다 |
| 도구 | 역할 허용 목록의 Corral 도구 | Pi 내장 도구(`read/bash/edit/write/grep/find/ls`)는 끈다. 확장 도구는 **최종 인자**로 host 승인을 받는다. 실행은 worker 안이며 "관리되지 않은 실행"으로 기록한다 |
| 지시(Reins) | 요청 준비 시 context에 넣는다 | SDK 실행에서는 Pi steer 메시지로 보내고, 요청 단위로 묶는다(S3 결과에 따름) |

확장 명령은 **실행 시작 옵션**으로만 지원한다(역할 바인딩의 초기 명령, 또는 Run 시작 전 입력). Pi가 실행 중 확장 명령을 거절하기 때문이다(스파이크 F5).

R2(검증·개선)와 R3(MCP·codemode·항목 반복)는 이 CR 범위가 아니다. 각각 별도 CR로 한다.

## 보장 범위

"모든 외부 효과는 Coordinator를 통과한다"는 보장을 두 경로로 나눈다.

| 경로 | 무엇 | 보장 |
|---|---|---|
| 관리 경로 | Corral 도구, 모든 모델 요청, 확장 도구의 **호출 승인** | 승인·예산·취소·기록을 지금과 같이 보장한다 |
| 신뢰한 네이티브 확장 | 확장 코드가 직접 하는 fs·network·process 접근, 확장 도구의 **실행 내용** | 통제하지 않는다. 화면과 문서에 "신뢰한 코드"로 표시한다. `HOME`·`XDG_CONFIG_HOME`을 실행 전용 디렉터리로 돌리지만, 이것은 **보안 경계가 아니다** |
| OS 격리 | 컨테이너·샌드박스 | 제공하지 않는다. 제공한다고 표시하지 않는다 |

추가 규칙은 다음과 같다.

- 엄격 역할에는 provider를 등록하는 확장과 annotations 없는 확장 도구를 붙일 수 없다. 저장할 때와 Run 시작 때 모두 거절한다.
- LLM 판단이나 UI 토글로 권한을 넓히지 않는다.

## 문서 변경

| 문서 | 바꿀 내용 |
|---|---|
| `Corral-Spec-v0.1.md` §범위(111행) | "역할에 바인딩한 Pi 표준 스킬·확장(R1)"을 범위에 넣는다. MCP 확장 로딩, 셸/코딩, 파일 동시 수정은 계속 제외한다 |
| `docs/Technical-Design.md` 233행 | coding-agent SDK를 `pi-sdk` 실행 방식으로 쓴다. 자동 리소스 로더와 내장 셸·파일 도구는 쓰지 않는다 |
| `docs/Decisions.md` ADR-005 | "ADR-027이 부분 대체"로 표시한다 |
| `docs/Decisions.md` ADR-024 | Corral gate는 닫혀 있다. Pi 확장 hook은 worker 안에서만 돈다. 이 사실을 결과·제약에 덧붙인다 |
| `docs/Dependencies-and-Sources.md` | coding-agent와 전이 의존의 버전·라이선스를 기록한다(H1에서 devDependency로 먼저 기록) |

## 반례 (플랜 §7의 TC-HAR)

| 영역 | 반드시 거절·실패해야 하는 것 |
|---|---|
| 모델 요청 | permit 없는 dispatch, 캐시 warming 요청, 확장이 다른 provider로 보내는 요청 |
| 도구 | 승인 뒤 인자 변경, `tool_call` 핸들러 예외, 승인 안 된 중첩 호출, unknown 도구 |
| 리소스 | 바인딩하지 않은 `~/.pi/agent`·`.pi/`·`.agents/skills`·`AGENTS.md` 로드, 내용이 바뀐 미신뢰 리소스 |
| 실행 | 필수 확장 로드 실패 시 `pi-core`로 조용히 내려가는 것 |
| 기록 | 로그·export에 로컬 절대경로·키가 남는 것 |

## 테스트

| ID | 내용 | 위치 |
|---|---|---|
| TC-HAR-001-H/N | 모든 모델 요청(일반·재시도·압축·확장 중첩)이 permit을 받는다. permit 없는 dispatch는 없다 | `packages/adapter-pi/test/spike/permit.test.ts`(S1) |
| TC-HAR-002-H/N | 최종 인자로 승인, 핸들러 예외는 차단, 중첩 호출도 승인 | `packages/adapter-pi/test/spike/tools.test.ts`(S2) |
| TC-HAR-004-H/N | 바인딩한 리소스만 로드, 함정 HOME과 cwd의 리소스는 로드하지 않음 | `packages/adapter-pi/test/spike/resources.test.ts`(S4) |
| TC-HAR-003·005·007 | 요청 기록·지시, 스킬, 명령·대화상자 | `test/spike/{permit,directives,skills,commands-ui}.test.ts` |
| 나머지 TC-HAR | H2–H3에서 추가한다 | 플랜 §7 |

## 검증하지 못한 것

[스파이크 보고서](../spikes/HAR-pi-sdk-spikes.md)의 "확인하지 못한 것"을 본다. 이후 단계마다 덧붙인다.

## H3 확장 UI 계약 (2026-10-18)

- 지원 입력은 `select`, `confirm`, `input`이고, `notify`와 `setStatus`는 알림·상태 기록이다. 터미널 입력, custom UI, 위젯은 비지원 사실을 표시한다.
- Coordinator가 요청 ID를 발급하고 Run·execution·attempt에 고정한다. 동시에 execution당 1개, Run당 누적 100개까지 허용한다. 기본 기한은 120초, 최대 300초이며 주입한 시계·타이머로 판단한다.
- 답변은 `answer_extension_ui` 명령으로 보낸다. 현재 control revision, 요청 대상, 시도, 미종결 상태, 기한, 답변의 종류/선택지를 모두 검증한다. 같은 command ID 재전송은 기존 영수증을 반환한다.
- 대기 중인 execution은 `waiting_approval`, Run은 `awaiting_user`로 표시한다. 다른 승인·차단이 남아 있거나 사용자가 일시 정지한 경우 마지막 답변도 Run을 임의로 재개하지 않는다.
- 취소·실행 종료·기한 만료는 요청을 닫고 SDK에 취소/빈 결과를 돌려준다. 실행이 끝난 요청을 새 execution으로 옮기지 않는다. 서버 재시작 후 이전 입력은 응답 불가다.
- `extension.ui_requested/answered/expired/notified`에는 대상·종류·기한·본문 참조와 해시만 기록한다. 제목·선택지·입력·알림 본문은 기존 private record 저장소에 보관한다. 공개 archive에는 기존 허용 목록의 메타데이터만 내보낸다.
- IPC의 UI 대기는 수신 큐를 점유하지 않아야 한다. 확장의 AbortSignal 취소와 Run 취소가 응답 대기 중에도 처리되어야 한다.

### 실행 한 번의 추가 작업 방식

- 시작 요청의 선택 `harnessOverrides`는 역할 ID → 불변 profile revision 참조다. 기본 작업 방식이 있는 역할만 지정할 수 있다. 없는 역할·기본 런타임 역할 지정은 시작을 거절한다.
- 개인→프로젝트→역할 뒤 마지막 run 계층으로 합성한다. 기존 필수 리소스·엄격 정책·허용 도구 제한을 풀지 못하며, 저장된 팀이나 다음 실행의 기본값은 수정하지 않는다. 시작 요청의 재전송 식별과 Run snapshot에 포함한다.
- 설정의 미리보기와 시작 시 해석은 같은 run 계층을 사용한다. 프로젝트·역할·선택이 바뀐 뒤 도착한 이전 미리보기는 표시하지 않는다. 입력창과 편집기 실행 화면은 실행 성공 후 이 선택을 비운다.

## 모의 실행과 하네스

모의 실행은 실제 모델·스킬 본문·확장 로딩의 검증이 아니다. 서버의 모의 adapter가 명시적인 `harness.simulated` 사실을 기록하고 기존 Corral 도구/그래프만 시뮬레이션한다. 고정 snapshot과 역할/하네스 도구 허용 목록은 유지하지만 실제 SDK descriptor/schema hash나 전달 증거를 꾸며내지 않는다. 실제 live 실행에서는 이 경로를 허용하지 않으며 필수 확장 실패를 모의 실행으로 우회하지 않는다. 화면에서 실제 하네스를 실행하지 않았다는 범위를 표시한다.

### 정적 도구 미리보기

미리보기는 Corral broker의 정적 descriptor를 보여주며 확장 코드를 로드하지 않는다. Pi read/edit/write는 고정 SDK의 공개 factory가 반환하는 파라미터 schema를 저장하고, 호환성 테스트가 실제 factory와 대조한다. 검사/LSP schema는 런타임과 같은 생성 함수를 사용한다. 위임 대상이 필요한 ask/spawn과 확장·MCP·codemode의 동적 등록은 실행 시 확정한다. 정적 정의는 허용 목록 기준이며 실제 역할 권한·작업 사본·선택 대상이 실행 가능성을 추가 제한한다. 실제 실행의 descriptor는 여전히 harness.loaded/tools_updated 기록을 기준으로 한다.
