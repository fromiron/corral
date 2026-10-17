# Corral Personal Harness 구현 계획

## Pi 표준 호환 · 에이전트별 제어 · 도구 실행 · 검증과 제한된 개선 루프

- 작성일: 2026-10-17 (Asia/Tokyo)
- 상태: **제안**. 구현·통합 테스트 완료 보고서가 아니다.
- Corral 기준: `main`, `8150c2e9f594d7dcaeeec87215028e2dca1d8ac6`
- 최근 병합: PR #53, Workbench UX review fixes (UX-01–UX-12), 2026-10-17 22:49:04 JST.
- 확인 범위: GitHub의 최신 branch·PR·CI 기록, 관련 계약·worker·admission·workspace 검증 코드, Pi 공식 문서, DSH/DSH Studio 및 oh-my-pi 문서·일부 구현 코드.
- 이번 작업에서 수행하지 않은 것: 저장소 수정, 커밋·PR 생성, 로컬 테스트 실행, 실제 모델 호출, 외부 플러그인 설치·통합 실행.
- 아래 새 타입·경로·작업 ID는 제안이며 현재 API로 사용할 수 없다. 라이브러리 API는 구현 시 고정한 릴리스의 공개 타입으로 다시 확인한다.

## 1. 제품 목표와 핵심 결정

**표준 스킬·pi 패키지를 원형으로 사용하고, 역할별 작업 방식·권한·검증·반복 조건을 사용자가 통제하는 개인 하네스**를 만든다.

엔진을 여러 개 쌓는 계획이 아니다. Pi는 에이전트 실행과 확장 호환의 기준으로 유지한다. Corral Coordinator는 작업 소유권, 실행 허가, 예산, 취소, 개입, 최종 상태를 계속 소유한다.

| 참고 대상 | 채택 | 그대로 도입하지 않는 것 |
|---|---|---|
| Pi | 공식 SDK, 리소스 로딩, Extension API, Pi Packages | API 모방 런타임, 비공개 내부 객체 패치 |
| DSH | 기능별 교체 지점, 범위별 수명 관리, 요청 조립·실행 기록의 일치 | Cordis·DSH 런타임과 YAML 구성 체계를 Corral 내부에 추가 |
| DSH Studio | 실제 실행과 같은 구성 경로의 미리보기, 검증과 피드백 분리, 항목별 제한된 개선 | Pixie의 독립 모델 호출·작업 저장소를 그대로 복사 |
| oh-my-pi | 원본 도구 계약과 공급자 전송 형식 분리, 도구 브리지, 편집 정확도·LSP 접근 | Bun/Rust 기반 포크 전체 교체, `.omp` 설정을 pi 표준으로 간주 |

Oh-my-pi는 pi에 설치하는 확장 하나가 아니라 별도 포크다. 현재 확장 로더도 `.omp` 기반 탐색, 독자 API, 호환 로딩을 갖는다. Pi 확장 호환과 OMP 전용 확장 호환은 별개로 표시한다. [S11–S15]

## 2. 최신 Corral 기준선

| 영역 | 확인한 현재 상태 | 이번 계획의 의미 |
|---|---|---|
| UI | PR #53에서 요청 의도·대상 고정, draft 복원, 승인·역할 설정 UX 보강 | 새 설정 화면이 이를 우회하거나 대상을 자동 변경하지 않게 한다 |
| Pi | `pi-agent-core`와 `pi-ai` 1.2.0, `worker.ts`가 `new Agent()` 사용 | 공식 coding-agent SDK를 통한 확장 런타임 통합 필요 |
| 도구 | `WorkTool`·`WorkerTool` enum, `AgentRole`의 고정 허용 목록 | 단순 문자열 허용 대신 출처와 스키마를 가진 등록 계약 추가 |
| 요청 | `prepare_request`에는 실행·요청 ID가 있고 최종 prompt 본문은 없음 | 확장이 바꾼 최종 요청을 기존 host snapshot이 안다고 가정하지 않는다 |
| Admission | 동기 gate와 commit 이후 observer, 생성 시 등록 | 비동기 LLM 품질 판단을 기존 gate 안에 넣지 않는다 |
| 파일 작업 | 관리 worktree, 읽은 내용 해시 확인, 쓰기 직렬화, 변경 snapshot | 편집 도구·LSP 변경도 기존 broker 경로 재사용 |
| 검증 | 사용자 등록 argv 명령, 수동 실행, snapshot·결과 저장 | 신규 실행기를 만들기보다 Run 소유권과 자동 실행 허가를 추가 |
| 검토·반영 | tree 쌍에 묶인 검토, 원본 반영·되돌리기, 확인 필요 목록 | 품질 보고서와 기존 인간 승인·반영의 의미를 분리 |
| 평가 | `corral eval`은 비용·시간·상태 비교, 품질 채점 없음 | 실제 품질 평가와 대조군을 추가 |

근거: [S01–S09]. 구현 존재와 테스트 통과를 구분한다.

### 2.1 먼저 복구할 CI

기준 커밋의 Actions run `39038123954`, job `117411968553`은 `pnpm spec:check`에서 실패했다. 뒤의 contracts/lint/typecheck/unit/build/E2E 단계는 skipped다. PR 본문의 로컬 통과 보고를 병합 커밋의 CI 통과로 읽지 않는다. [S02]

다운로드한 job 로그에는 다음 미등록 테스트 시나리오가 있다.

```text
TC-REF-010-H
TC-REF-020-H, TC-REF-021-H, TC-REF-022-H, TC-REF-023-H, TC-REF-024-H
TC-REF-001-H, TC-REF-002-H
```

`tools/spec-check/spec-check.ts`는 테스트의 TC 태그가 `tests/test-catalog.json`에 존재해야 한다고 명시한다. 기존 CR-016의 요구·테스트와 카탈로그·추적 매트릭스를 정합화하고 전체 검사를 다시 실행한다. 태그 삭제나 검사 완화로 통과시키지 않는다. 현재 관측된 중단 원인이 이것이며, 후속 검사를 실행하면 다른 실패가 나올 가능성은 남아 있다. [S08, S10]

## 3. 표준을 채택하는 경계

### 3.1 리소스 원본과 Corral 정책을 분리

- Agent Skills: `SKILL.md`와 상대경로 자료를 원본으로 유지한다. Corral 전용 frontmatter를 요구하지 않는다.
- Pi Packages: `package.json`의 `pi` 리소스 선언과 공식 소스·필터·탐색 규칙을 재사용한다.
- Pi Extensions: 고정한 공식 SDK의 이벤트 순서와 반환 의미를 보존한다.
- `AGENTS.md`: 기본 로더가 제공하는 탐색 범위를 따른다. 디렉터리별 지침의 추가 적용 기능을 만든다면 pi 기본 동작과 별도 정책임을 명시한다.
- MCP: 외부 도구 연결 프로토콜로 채택하되 pi 확장이나 보안 정책의 대체물로 취급하지 않는다.
- LSP: 코드 의미 기반 조회·변경 연결에 사용한다. OMP의 Hashline은 선택적 편집 방식이지 글로벌 표준이 아니다.

스킬 파일 형식의 호환, 도구 계약의 호환, 확장 실행의 호환, UI 호환은 각각 판정한다. 스킬을 읽었다고 스크립트 실행까지 지원한 것으로 표시하지 않는다. [S16–S18]

### 3.2 새로운 설정 저장소를 불필요하게 늘리지 않음

기존 `.corral.json`의 역할 바인딩과 서버/DB 설정 경로를 확장한다. 별도 `agents.json`, `policies.json`을 또 하나의 authoritative 저장소로 동시에 추가하지 않는다.

Pi 표준 파일은 Pi 리소스의 원본이다. Corral 저장소에는 리소스 참조, 역할 적용, 신뢰 승인, 정책, 버전 스냅샷을 보관한다. export/import 파일은 스키마가 있는 배포용 표현으로 다루고, live DB와 양방향 자동 동기화하지 않는다.

기존 `~/.pi/agent` 연결은 사용자가 선택할 수 있게 하되 자동 수정하지 않는다. 분리된 `agentDir`을 사용하더라도 기본 리소스 탐색과 도구 경로 해석이 무엇을 참조하는지 명확히 한다. 라이브러리의 설정 병합 규칙을 Corral 정책 상속 규칙으로 덮어쓰지 않는다.

### 3.3 설치·활성화·신뢰를 분리

`발견 → 설치 검토 → 설치 → 신뢰 승인 → 역할 바인딩 → 실행 활성화`를 구분한다. 프로젝트를 열거나 패키지 목록을 조회하는 것만으로 확장 import·설치 스크립트를 실행하지 않는다.

실행 시 실제 패키지 버전/commit, 리소스 해시, runtime 버전, 정책 revision을 고정한다. 로컬 리소스가 바뀌면 다음 실행에 새 revision을 만들며, 실행 중 몰래 hot reload하지 않는다. 잠금 정보는 입력·설정 재현을 위한 것이며 LLM 출력의 동일성을 보장하지 않는다.

## 4. 런타임과 정책 구조

```text
Workbench / CLI
  └─ 기존 역할 설정·버전 바인딩
      └─ 적용 설정 해석 + 실행 스냅샷
          └─ Corral Coordinator
              ├─ 모델 요청 허가·예산·취소·Reins
              ├─ 도구 등록·승인·실행
              ├─ 검증 작업·보고서·완료 조건
              └─ Pi SDK worker
                  ├─ 공식 스킬·패키지·확장 런타임
                  └─ 모델 대화·컨텍스트·확장 상태
```

### 4.1 SDK 통합은 공개 API 검증부터

`@earendil-works/pi-coding-agent`의 `createAgentSession`과 `ResourceLoader`를 우선 검증한다. 버전 변경과 기능 변경을 분리하고, 채택 버전은 정확히 고정한다. 현재 Corral의 1.2.0을 `latest`로 일괄 치환하지 않는다. [S03, S16]

최소 fixture는 원본 Ponytail, 무해한 커스텀 도구, 명령·확인창을 등록하는 확장이다. 다음을 모두 검증해야 기본 런타임으로 전환한다.

1. 공식 세션의 정상·오류·취소·후속 요청이 Coordinator의 완료 계약을 지킨다.
2. 지원되는 모델 요청 경로에서 자동 압축·재시도·후속 메시지까지 permit과 사용량 기록이 연결된다.
3. 확장 도구 호출이 최종 인자 기준으로 승인된다.
4. 역할 간 확장 상태와 명령 등록이 누출되지 않는다.
5. 필요한 UI 상호작용과 비대화형 실행의 실패 의미가 정해진다.

공개 API만으로 필수 경계를 만들 수 없다면 이를 차단 사유로 기록하고, 상위 프로젝트에 공개 확장 지점을 제안하거나 지원 범위를 제한한다. 비공개 객체 패치로 문제를 감추지 않는다. 무확장 기존 경로는 검증 기간의 명시적 선택지로 유지할 수 있지만, 필수 확장 로드 실패 때 조용히 그 경로로 fallback하지 않는다.

### 4.2 네 종류의 개입을 구분

| 종류 | 실행 위치와 권한 | 오류 의미 |
|---|---|---|
| Pi 확장 hook | 공식 pi 실행 경계, 원본 이벤트 규약 유지 | 필수 확장 실패는 실행 보류/실패, 선택 확장도 진단 기록 |
| Corral admission policy | Coordinator의 동기·결정적 검사 | 예외 시 거절, 필수 기본 gate 제거 불가 |
| 검증 작업 | 별도 비동기 effect/task 후 보고서 제출 | 평가 오류를 산출물 실패/통과로 바꾸지 않음 |
| Observer | commit 이후 관찰, 요청 차단·변경 불가 | 실행을 바꾸지 않고 관찰 오류 기록 |

현재 `AdmissionConfig.gates`는 지정 stage의 기본 gate를 교체하는 내부 API다. 이를 외부 플러그인 설정 UI에 그대로 노출하면 안 된다. 사용자 설정은 필수 기본 정책 위의 제한된 overlay로 해석한다. [S05]

LLM이 안전하다고 판단해도 금지된 도구를 허용하지 않는다. 품질 검증은 실행 권한 부여 기능이 아니다.

### 4.3 네이티브 확장의 신뢰 한계

네이티브 JS/TS 확장은 직접 filesystem·network·process API를 사용할 수 있다. Pi 도구 hook으로 모든 직접 효과를 통제할 수 있다고 보장하지 않는다. [S17]

초기에는 다음 상태를 명시한다.

- **관리된 실행 경로:** Corral이 등록·승인·실행하는 도구·모델 호출을 통제한다.
- **신뢰한 네이티브 확장 실행:** 원본 확장 호환을 제공하지만 확장 코드 전체의 효과를 강제 중개하는 보장은 없다.
- **OS 격리 실행:** 별도 검증·지원이 완료되기 전에는 제공한다고 표시하지 않는다.

확장의 직접 호출은 추적·예산 통제를 우회할 수 있으므로, 엄격한 정책을 요구하는 역할에 제한 없는 네이티브 확장을 함께 붙일 때 충돌을 표시하거나 실행을 거절한다. “모든 외부 효과는 Coordinator를 통과한다”는 기존 보장 범위를 바꾸는 부분은 CR에 명시한다.

확장이 참조하는 로컬 비밀·프로젝트 코드의 보호는 신뢰 정책과 OS 격리의 문제다. 워커 분리나 UI의 읽기 전용 토글을 샌드박스로 홍보하지 않는다.

## 5. 역할별 스킬·확장·정책

### 5.1 기존 AgentRole을 확장

새 런타임 정체성을 만드는 대신 기존 `AgentRole`에 버전 고정된 작업 방식 참조를 추가한다. 재사용 프리셋이 필요하면 역할 설정의 템플릿으로 제공한다. 저장한 템플릿을 바꿔도 과거 Run이나 진행 중 실행은 바뀌지 않는다.

개념 모델(신규 제안):

| 계약 | 역할 |
|---|---|
| `HarnessProfileRevision` | 역할에 바인딩할 스킬·확장·정책·검증 설정의 불변 버전 |
| `ResourceRef` | 원본 소스, 진입점, 버전/commit, 내용 해시 |
| `EffectiveHarnessSnapshot` | 실행 시 해석된 설정·출처·신뢰·도구 집합 |
| `ToolDescriptor` | 도구 출처·정식 스키마·실행 위치·부작용·권한 계약 |
| `VerificationReport` | 특정 산출물/tree와 기준에 대한 검사 결과 |
| `ReviewRecipeRevision` | 고정된 기준·평가자·수정 정책·한도 |

이 이름은 설계를 설명하기 위한 것이며 구현 시 기존 계약에 통합할 수 있다.

### 5.2 스킬의 강제 수준

`자동 선택`, `명시적 호출`, `필수 적용`을 구분한다. 필수 적용은 모델이 스스로 파일을 읽기를 기다리지 않고 지정 본문을 요청에 포함한다. 본문 누락·용량 초과·리소스 실패는 차단하며, 압축·모델 변경 후에도 필요한 지침이 유지되는지 검사한다.

보장하는 것은 **지침 전달**이지 **의미적 완전 준수**가 아니다. “필수 지침 포함됨”과 “결과 검증 통과”를 분리해 표시한다.

외부 확장은 확장 단위로 활성화하고 해당 확장이 제공하는 명령·설정을 사용한다. 이벤트 handler 하나만 임의로 끄거나 순서를 재배열하는 범용 기능은 초기 범위에 넣지 않는다.

### 5.3 정책 상속과 실행 중 변경

개인 기본값 → 프로젝트 → 역할 → 실행을 해석하되, 스타일·선호 설정과 보안 제한의 합성 규칙은 다르게 둔다. 하위 역할·자식 작업이 프로젝트 필수 정책을 스스로 완화하지 못한다.

사용자는 Reins의 안전 경계에서 정책 변경을 요청할 수 있다. 요청에는 대상 execution/attempt, 기준 controlRevision, 적용 시점, 사유가 필요하다. 실행 중 패키지 코드·확장 집합 교체는 첫 버전에서 제외하고 다음 Run부터 적용한다.

Corral의 세션은 여러 Run의 업무 연속성이다. Pi 세션과 1:1로 동일시하거나 완료된 execution을 재개해 새 Run처럼 사용하지 않는다. Pi 상태의 재사용은 역할·기준 버전·대상 작업에 따라 명시적으로 선택한다.

## 6. Oh-my-pi에서 흡수할 도구 설계

### 6.1 모든 지원 호출을 같은 실행 경로로

```text
도구 발견·등록
 → 역할별 노출 집합 해석
 → 최종 호출 인자 확정
 → 원본 스키마 검증
 → 정책·한도 검사
 → 승인(필요 시)
 → 실행 직전 재검사
 → 실행·관측
 → 결과·변경 버전 저장
 → 모델에 필요한 결과 전달
```

일반 tool call, pi 확장 등록 도구, MCP, 추후 코드 안의 중첩 도구 호출은 이 계약을 따른다. 전체 JS 실행 하나만 승인하고 내부 쓰기·모델 요청을 놓치지 않는다. OMP는 코드 브리지에서도 공통 도구 검증기를 사용하고, 직접 호출과 의미가 다른 일부 도구는 브리지 호출을 명시적으로 거절한다. 이 접근을 참고한다. [S15]

내부 식별자에는 source/package, public tool name, schema hash, registry revision, executionId를 연결한다. 모델에 노출하는 원본 이름을 임의로 바꿔 기존 확장을 깨뜨리지 않는다. 동일 이름 충돌은 명시적 선택 또는 충돌 오류로 다룬다. 알 수 없는 도구의 기본 부작용 등급은 보수적으로 둔다.

### 6.2 정식 스키마와 공급자 전송 형식 분리

원본 도구 계약은 로컬 검증의 기준으로 유지한다. 공급자가 받는 스키마 변환은 가능한 한 `pi-ai`에 맡기고 OMP 사례는 누락 반례를 찾는 데 사용한다. 별도의 범용 변환기를 성급히 추가하지 않는다.

JSON Schema 키워드를 공급자 호환 때문에 제거해도 로컬 실행 검증은 제거하지 않는다. 전달하기 어려운 제약은 경고하거나 해당 조합을 비지원으로 분류한다. 임의의 오류 입력을 조용히 고쳐 다른 작업으로 실행하지 않는다. 변환 전후 schema hash와 변환기 버전을 비교 가능하게 남긴다. [S13]

### 6.3 편집 개선: 표준 도구 우선, Hashline은 평가 후보

기존 Corral broker의 해시 충돌 검사·쓰기 직렬화·작업 기록을 유지한다. Pi의 `read/edit/write` 계약을 제공할 때 이름만 바꾸지 말고 입력·출력·상대경로·오류·부분 수정 의미를 맞춘다.

OMP의 Hashline은 동일 fixture에서 pi 기본 edit 및 현재 전체 파일 쓰기와 비교한다. 기존 내용의 해시 확인과 겹치는 이점을 과장하지 않고, 편집 형식으로 인한 재시도·출력 사용량·잘못된 위치 수정 여부를 평가한다. 짧은 편집 anchor는 전체 파일 snapshot 확인이나 권한 검사의 대체물이 아니다.

현재 파일 broker의 read 기록은 Run 단위다. 여러 에이전트가 같은 파일을 다룰 때 누구의 읽기가 쓰기의 근거인지 실행 단위로 연결해야 하는지 먼저 반례를 정의한다. 자동 병렬 쓰기는 켜지 않는다. [S06]

### 6.4 조회·결과 크기·병렬 실행

파일 조회는 범위·필터·truncation 상태와 원본 참조를 함께 반환한다. 긴 결과를 요약하더라도 원본 근거는 저장하고 필요할 때 범위로 다시 읽게 한다.

읽기 전용·독립 작업만 제한적으로 병렬 실행한다. 외부 API 호출은 읽기처럼 보여도 비용·side effect가 있을 수 있으므로 metadata만 믿고 무제한 병렬화하지 않는다. 같은 worktree의 변경은 직렬화한다. 장시간 작업은 job/task handle, 기다리기, 취소, 수집 여부를 가진다.

JS/Python에서 도구를 호출하는 programmatic tool calling은 후속 단계다. 기존 역할 권한과 중첩 호출의 취소·사용량이 모두 연결된 뒤 켠다. 코드 실행을 보안 샌드박스라고 자동 표시하지 않는다.

### 6.5 LSP 도입은 조회부터

첫 대상은 diagnostics, definition, references 등 읽기 중심 기능이다. LSP 서버 자체 실행도 신뢰와 수명 관리 대상이다.

Rename·code action·workspace edit는 후속으로 연결한다. 반환된 파일 변경을 Corral broker에 제안하고 snapshot·권한·충돌을 검사한다. 여러 파일 수정은 전체 성공이나 자동 충돌 해결을 보장하지 않는다. IDE처럼 보이는 결과를 만들기 위해 LSP 서버가 원본 파일을 직접 쓰게 하지 않는다.

## 7. 검증을 자동 완료 조건으로 만드는 방법

### 7.1 기존 수동 검증 코드 재사용과 경계 보강

현재 `WorkspaceService`는 시작 tree를 찍은 뒤 `spawn(..., shell:false)`로 명령을 실행한다. 이 함수를 에이전트에 그대로 노출하지 않는다. [S06]

공통 실행 포트를 추출하고 수동 실행과 자동 실행을 모두 같은 서비스에 연결한다. 자동 실행은 등록된 `commandId`만 받으며 argv 문자열·환경·실행 파일을 모델이 마음대로 바꾸지 못하게 한다.

사전 허가에는 명령 정의의 revision과 실제 실행 코드의 기준을 연결한다. 예를 들어 `pnpm test`라는 argv가 같아도 `package.json`의 script가 바뀌면 기존 승인과 다른 코드가 실행될 수 있다. 자동 실행 승인·기준 버전 정책에 이 경우를 포함한다. `shell:false`는 프로젝트 스크립트를 안전한 코드로 만드는 기능이 아니다.

필수 보강 항목은 다음과 같다.

- Run/execution/attempt 소유권, effect ID, 제한 시간, 취소·늦은 결과 fence.
- 프로세스 종료를 한 번만 확정하고 하위 프로세스 종료 정책을 운영체제별로 검증.
- 검증 대상과 실제 실행 입력의 일치. 전후 tree가 같다는 사실만으로 실행 중 일시적 변경이 없었다고 보장하지 않음.
- 초기에는 검증 전용 복사본 또는 변경을 통제한 실행 환경 사용. 소스 snapshot, lockfile, 명령 정의, runtime·환경 fingerprint를 기록.
- 테스트가 생성하는 임시 파일·캐시·빌드 결과의 취급을 정하고 최신 소스 판정과 구분.
- 출력 크기·redaction·보존 기간. stderr와 종료 상태를 숨기지 않음.

### 7.2 결과 보고서와 판정

보고서는 정확한 artifactVersionId 또는 workspace tree를 대상으로 하고, criteria revision과 검사기·모델 버전을 포함한다.

실행 상태(`queued/running/completed/error/cancelled`)와 품질 판정(`pass/fail/inconclusive/not_evaluated`)을 별도 필드로 표현한다. 평가 오류를 단순 fail로 덮지 않는다. 단일 녹색 “성공” 배지로 실행·검토·사용자 승인·원본 반영을 합치지 않는다.

결정적 검사 → 필요한 경우 의미적 평가 → 보고서 확정 → 동기 gate의 유효성 검사 순서를 따른다. 외부 평가 결과가 오는 동안 Coordinator의 원자적 commit 구간을 열어 두지 않는다.

필수 검증 오류는 완료 보류다. 참고용 평가는 경고만 남길 수 있다. 두 정책을 명시적으로 설정한다.

### 7.3 판정 모델과 수정 피드백

판정·설명·수정을 구분한다. 기준·질문·통과 조건은 실행 전에 고정한다. 자연어에서 기준을 생성할 경우 사용자 검토나 예제 보정을 거친 버전을 사용한다.

Pass/fail 예제 확인은 소규모 타당성 검사이지 정확도가 보장된 calibration은 아니다. 기준을 조정한 예제와 최종 평가용 holdout을 분리한다. 모델이 말하는 confidence를 실측 확률처럼 취급하지 않는다.

기존 `reasoning_effort` DecisionProvider는 관찰 기능으로 유지한다. 해당 모델이 다른 질문 종류를 지원한다고 선언하지 않은 상태에서 품질 판정을 맡기지 않는다. 첫 의미적 평가는 기존 review 역할을 재사용하는 편이 단순하다.

평가·기준 생성·피드백·압축·재시도를 위한 지원 모델 호출 모두 부모 Run 예산에 포함한다. 기존 effort observer의 별도 예산 계약을 품질 검증에 그대로 확대하지 않는다.

## 8. 제한된 개선 루프

### 8.1 협업 Loop부터

첫 자동 개선은 기존 `Agent → Review → Decision → Loop`를 재사용한다. 새로운 workflow 엔진·범용 임의 코드 evaluator를 넣지 않는다. 검증된 특정 산출물/tree의 결과로 다음 작업을 만든다.

정책에는 최대 생성 시도(첫 시도 포함)와 수정 횟수의 용어 차이를 명시한다. 시간·호출·토큰·위임의 부모 상한과 더 작은 작업별 상한을 함께 둔다. 동일 출력 반복, 같은 검사 실패의 무진전, 예산 소진 시 멈추고 확인 필요 목록에 이유를 남긴다.

모델이 테스트·기준을 수정해 통과 조건을 낮추지 못하도록 기준 파일·레시피 revision을 보호한다. 사용자 승인이 필요한 기준 변경은 재승인·재검증한다.

### 8.2 항목별 반복은 별도 릴리스

Pixie식 기능은 UI 문구·문서 문단·독립 JSON 결과부터 시작한다. 각 항목의 컨텍스트를 분리하고 같은 항목의 재시도만 필요한 이력을 유지한다. 메인 에이전트에는 개수·실패 항목·결과 참조를 반환하고 전체 시도는 실행 상세에 보관한다. [S12]

기존 Task/Execution·예산·취소·projection을 재사용한다. 중첩 Loop 금지, 최대 위임 깊이·spawn 상한을 우회하지 않도록 별도 CR에서 fan-out 의미를 정한다. 대규모 item 수가 필요하면 기존 상한 변경을 명시적으로 평가한다.

같은 worktree를 여러 항목이 동시에 수정하는 배치는 초기 범위에서 제외한다. 코드 수정의 병렬화는 독립 작업 공간과 병합·충돌 검토 계약이 마련된 뒤 도입한다.

## 9. Workbench 통합

기존 구조를 유지하면서 세 곳에 기능을 연결한다.

| 위치 | 추가 내용 |
|---|---|
| 역할 설정/Inspector | 스킬·확장·도구·권한·검증·반복, 상속 출처, 적용 미리보기 |
| 프로젝트 설정 | 패키지 설치·업데이트·신뢰, 등록 검증 명령, 프로젝트 기본 정책 |
| Run·검토 상세 | 실제 적용 스냅샷, 도구 호출 트리, 검증 대상 버전, 판정·수정 이력, 중단·승인 이유 |

DSH Studio처럼 preview와 실행이 같은 설정 해석 경로를 사용하게 한다. 정적 preview는 확장 코드를 실행하지 않는다. 동적으로만 알 수 있는 항목은 미확정으로 표시하고, 별도 신뢰된 시험 실행이 필요한 경우 이를 구분한다. 실제 요청 화면은 확정된 요청에서 나온 기록을 보여준다. [S11]

CR-016의 `commandRegistry.ts`를 확장해 `/`, 명령 팔레트, 단축키가 같은 metadata를 읽게 한다. 앱 명령과 확장 명령 충돌을 구분하고 출처·대상 역할·실행 조건을 표시한다.

Pi의 extension command, `steer`, `followUp`과 Corral의 다음 Run·Reins·대기열은 같은 의미가 아니다. 명령은 명시적 host 라우팅 계약으로 연결한다. 입력 중 대상이 끝났을 때 다른 에이전트나 다음 Run으로 조용히 변경하지 않는다. UI 확인창은 request ID·execution·timeout을 가지고 취소 시 함께 닫힌다.

초기에는 알림·확인·선택·입력·상태 표시를 연결한다. 임의 TUI 컴포넌트, 키보드 장악, 임의 HTML 실행은 지원한다고 표시하지 않는다.

## 10. 단계별 작업과 완료 조건

아래 H 번호는 이 계획의 임시 작업 묶음이다. 공식 CR/태스크/테스트 ID는 실제 착수 때 발급하고 카탈로그에 등록한다. 현 저장소의 CR-017까지와 번호 충돌 여부를 확인한다.

| 단계 | 선행 | 변경 범위 | 완료 조건 |
|---|---|---|---|
| H0 기준선 | 없음 | TC-REF 추적 정합화, CI, 기존 회귀 fixture | 병합 기준에서 전체 gate 실행 결과 확보 |
| H1 계약·통합 실험 | H0 | SDK spike, 신뢰 모드, 최종 요청·도구 승인 계약 | 필수 공개 API 경계 검증, 비지원 기능 명시 |
| H2 도구·요청 기반 | H1 | registry, canonical validation, protocol version, 요청 snapshot | 일반/확장 호출의 허가·취소·중복·늦은 결과 반례 통과 |
| H3 리소스·역할·UI | H2 | 공식 packages/skills/extensions, version lock, 역할 바인딩, UI bridge | 원본 Ponytail을 지정 역할에만 적용하고 실제 적용 기록 확인 |
| H4 코딩 도구 개선 | H2/H3 | 표준 edit 연결, 범위 조회, 선택적 Hashline 평가, 읽기 LSP | 기존 파일 보호 유지, 편집 품질 비교 근거 확보 |
| H5 자동 검증 | H2 | 기존 verification 서비스 공통화, 등록 명령만 실행, snapshot 유효성 | 허용 명령의 대상 버전·취소·결과가 일관되고 stale 결과는 완료 근거가 아님 |
| H6 검토·개선 | H3/H5 | 결정적 검사, review 역할, recipe revision, 기존 Loop 연계, 품질 eval | 제한 내 수정·중단·인간 판단을 일관되게 수행 |
| H7 항목별 배치 | H6 | item 컨텍스트·산출물 분리, 제한 병렬성, 요약 | 부모 예산·취소·관측에서 숨은 작업이 없음 |
| H8 후속 확장 | H2 이후 필요별 | MCP, programmatic calls, 변경 LSP, 선택적 advisor | 기능별 권한·취소·출처·호환성 테스트 후 개별 활성화 |

H4와 H5는 H2 이후 일부 병렬 개발할 수 있지만 같은 broker·protocol 변경은 순서 있게 병합한다. MCP는 표준 포트를 H2에서 고려하되 첫 릴리스의 외부 서버 연결을 선행 조건으로 만들지 않는다.

### 릴리스 절단선

**R1 — 표준 호환 개인 하네스:** H0–H3. 지정 역할의 원본 pi 확장·필수 스킬, 신뢰·권한, 적용 미리보기와 실제 요청 확인까지 한 흐름으로 완성한다.

**R2 — 검증 가능한 구현·수정:** H4–H6. 기존 worktree에서 변경하고, 사전 허가된 검사와 버전 고정 review에 따라 제한적으로 수정한다. 인간 승인·원본 반영은 기존 별도 절차로 유지한다.

**R3 — 반복 작업과 고급 도구 조합:** H7 및 선택한 H8. 대규모 배치·프로그램 호출·병렬 코드 변경은 별도 지원 계약을 갖는다.

## 11. 주요 파일 변경 지도

| 기존 위치 | 변경 방향 |
|---|---|
| `packages/contracts/src/definition.ts` | 역할의 리소스/정책 바인딩, 기존 정의와 버전 호환 |
| `packages/contracts/src/ports.ts`, `events.ts`, `review.ts` | 도구 등록·검증 작업·불변 보고서의 공통 계약 |
| `packages/adapter-pi/src/worker.ts`, `protocol.ts`, `adapter.ts` | 공식 SDK 통합, protocol version 갱신, 최종 요청과 도구 실행 연결 |
| `packages/core/src/admission/index.ts` | 필수 기본 gate 보존, 동적 registry 기반 정책, 보고서 유효성 검사 |
| `packages/core/src/coordinator.ts` | 검증·중첩 호출의 소유권·예산·취소·완료 판정 |
| `packages/core/src/compiler/` | 기존 Loop 의미 유지, 후속 배치 lowering의 명시적 제한 |
| `apps/server/src/files/service.ts`, `review.ts` | 기존 검증 실행 포트 분리, snapshot 기반 검증·반영 연결 |
| `packages/storage-sqlite/` | 설정 revision·확장 상태 참조·검증 보고서 저장과 migration |
| `apps/studio/src/commandRegistry.ts`, `workbench/`, `packages/react/` | 역할 설정, command routing, 적용·검증·호출 상세 |
| `packages/cli/`, `docs/Evaluation.md` | 같은 실행 계약을 쓰는 headless 지원, 품질 평가 |
| `tests/test-catalog.json`, `tests/traceability.json` | 모든 신규 요구·테스트 ID의 정합성 |

별도 신규 패키지는 runtime 의존 방향과 두 번째 실제 사용처가 확인될 때만 분리한다. core/contracts에 React·Pi 구현체·DB 직접 의존을 넣지 않는다.

## 12. 테스트·릴리스 게이트

| 영역 | 최소 반례 |
|---|---|
| 리소스 | 중복 이름, 상대경로, worktree 밖 스킬 자료, 누락·변조, 비활성·미신뢰 패키지 |
| 확장 | 로드 오류, 명령 충돌, 미지원 UI, 필수 확장 실패, 역할 간 전역 상태 누출 |
| 도구 | unknown tool, 등록 후 schema 변경, hook 인자 변경, stale permit, 중복 실행, 중첩 호출 우회 |
| 요청 | preview와 실요청의 차이, 필수 본문 제거, 압축·모델 교체 후 누락, 컨텍스트 초과 |
| 권한 | 확장이 기본 gate를 제거하려는 경우, 하위 에이전트 정책 완화, 신뢰 모드와 엄격 정책 충돌 |
| 파일 | 읽은 버전 이후 변경, 두 에이전트의 읽기 근거 혼선, symlink·경로 탈출, 다중 파일 부분 실패 |
| 검증 | 시작 뒤 파일 변경, 검증 중 입력 변경, 프로세스 생성 실패·중복 종료·자식 잔존, 명령 정의 변경 |
| 루프 | 동일 결과 반복, 기준 몰래 변경, 평가 오류의 pass 오인, 부모 취소 후 후속 호출, 숨은 중첩 상한 우회 |
| UI | IME, 입력 대상 고정, draft 복원, 명령 실패 후 텍스트 유지, 승인창 취소·시간 초과 |
| 기록 | 이전 schema Run 읽기, 과거 artifact 불변, secret·원문 비의도 노출, 결과와 실행 상태 분리 |

일반 CI는 fake provider와 고정 로컬 fixture로 수행한다. 실제 모델/플러그인 테스트는 명시적 opt-in과 비용 상한을 둔다. 테스트 생성과 실행 통과를 구분하며, 기존 snapshot/golden의 변경은 명시적 계약 변경 근거가 있어야 한다.

CI 실패를 복구한 후 `spec:check → contracts:check → lint → typecheck → test → build → E2E`를 수행한다. SDK·확장 패키지 변경에는 Desktop smoke를 포함하고 플랫폼별 검증 범위를 기록한다. 통합 테스트가 없으면 호환성 상태는 미검증이다.

### 품질 평가

대조군: 현재 기본 에이전트 / 필수 스킬 / 결정적 검사 / 제한된 검토·수정 / 선택적 Hashline·LSP.

같은 과제·모델·예산으로 최종 정답률, 잘못된 통과·불필요한 반려, 편집 실패·재시도, 사용량·지연, 사람 개입을 비교한다. 실제 비용·품질 개선은 측정 후에만 주장한다. OMP·DSH의 자체 벤치마크 수치를 Corral의 예상 개선율로 사용하지 않는다.

## 13. 바로 시작할 PR 단위

1. `fix/spec-traceability`: 확인된 TC-REF 카탈로그·추적 정합성 수정과 전체 기준선 검증.
2. `docs/personal-harness-contracts`: 신뢰 모드, Pi API 지원 매트릭스, 신규 계약·반례·ADR·테스트 카탈로그. 원본 Ponytail과 무해한 도구 fixture를 이용한 SDK spike를 별도 검증 커밋으로 포함.
3. `feat/pi-runtime-foundation`: 검증한 공개 SDK 경계, 도구 등록·승인·취소, 최종 요청 snapshot의 수직 구현. 숨은 fallback 없이 활성화 조건 명시.

이후 역할 설정·표준 리소스 설치·확장 명령·적용 내역 UI로 R1을 마무리한다. 첫 구현 과제는 새 플러그인 관리 화면이나 무제한 루프가 아니다.

## 14. 이번 범위에서 제외

DSH·OMP 런타임 전체 추가, 모든 하네스 hook 자동 변환, arbitrary TUI 완전 호환, 임의 코드의 안전한 실행 보장, 무제한 반복, 신뢰 토글만으로 OS 샌드박스 보장, 자동 배포·commit·push, crash resume, 외부 효과의 exactly-once 보장, 에이전트의 정책·검증 기준 자율 완화는 제외한다.

OMP의 스트림 중간 규칙 개입과 상시 advisor는 후속 실험으로 둔다. 먼저 안전 경계의 개입과 검증된 요청 이력을 완성한다. 재시도가 이전 파일·외부 효과를 되돌린다고 가정하지 않는다.

## 참고 자료

Corral 파일은 다음 commit으로 고정해 확인했다.

`https://github.com/fromiron/corral/tree/8150c2e9f594d7dcaeeec87215028e2dca1d8ac6`

- S01: PR #53 — `https://github.com/fromiron/corral/pull/53`
- S02: 기준선 CI와 job 로그 — `https://github.com/fromiron/corral/actions/runs/39038123954/job/117411968553`
- S03: `packages/adapter-pi/package.json`, `src/worker.ts`, `src/protocol.ts`
- S04: `packages/contracts/src/definition.ts`
- S05: `packages/core/src/admission/index.ts`, `docs/change-requests/CR-003-admission-hooks-effort-observe.md`
- S06: `apps/server/src/files/service.ts`, `docs/change-requests/CR-012-workspaces-and-file-changes.md`
- S07: `docs/change-requests/CR-013-review-integration-inbox.md`
- S08: `docs/change-requests/CR-016-composer-commands-and-references.md`
- S09: `docs/Evaluation.md`, `docs/plans/Workbench-Improvement-Plan.md`
- S10: `tools/spec-check/spec-check.ts`, `AGENTS.md`
- S11: DSH Studio README, 확인 시 blob `6e37c04ab5c03a37d30fc23b2837abd173351281` — `https://github.com/matamt-dbg/dsh-studio/blob/main/README.md`
- S12: Pixie Loop guide, 확인 시 blob `58e6a4d76cadd4a46478a9824a2c1c7bffc20b5e` — `https://github.com/matamt-dbg/dsh-studio/blob/main/docs/appendix/pixie-loop.md`
- S13: OMP 스키마 정규화 — `https://github.com/can1357/oh-my-pi/blob/647f9fa5dfae227d48a9588251f1a8439811e0e2/docs/ai-schema-normalize.md`
- S14: OMP README와 확장 — `https://github.com/can1357/oh-my-pi/blob/647f9fa5dfae227d48a9588251f1a8439811e0e2/docs/extension-loading.md`, 같은 commit의 `README.md`, `docs/extensions.md`
- S15: OMP 중첩 도구 브리지 — `https://github.com/can1357/oh-my-pi/blob/647f9fa5dfae227d48a9588251f1a8439811e0e2/packages/coding-agent/src/eval/js/tool-bridge.ts`
- S16: Pi SDK — `https://pi.dev/docs/latest/sdk`
- S17: Pi Extensions — `https://pi.dev/docs/latest/extensions`
- S18: Agent Skills specification — `https://agentskills.io/specification`
- S19: DSH architecture, 확인 시 blob `03d88148c7992f1c856efc44df0a930470f90f70` — `https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md`

움직이는 upstream 문서는 구현 착수 때 사용할 정확한 릴리스/commit으로 다시 고정한다. 출처 검토와 API 통합 성공은 다른 검증이다. 소스 코드를 직접 재사용할 경우 파일별 라이선스·NOTICE·의존성·Node/Bun/native ABI를 별도로 확인한다.
