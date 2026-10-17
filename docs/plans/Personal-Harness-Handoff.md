# 개인 하네스 작업 인계 (H1 완료 시점)

- 작성: Claude / 2026-10-17. 앞 세션의 사용량이 다 되어 다른 작업자에게 넘긴다.
- 브랜치: `feat/harness-h1`(push 완료). **PR은 아직 열지 않았다.**
- 기준: main `f17338f`(PR #54 병합). 브랜치 커밋은 3개다.
  1. `0c95704` docs: CR-018, ADR-027(제안)
  2. `aeba7a7` deps: Pi 패키지 1.3.0 정확 고정, `pi-coding-agent` 1.3.0을 adapter-pi devDependency로 추가
  3. `609e9ce` spike: S1–S8 스파이크 테스트와 보고서, CRL-HAR·C-076·TC-HAR 등록

## 먼저 읽을 것 (이 순서)

1. [AGENTS.md](../../AGENTS.md): 저장소 규칙. CR 먼저, red test 먼저, 주입, 유료 호출 금지, 라이브러리 기록, 비밀·경로 비노출, 한국어 문서.
2. [구현 플랜](Personal-Harness-Implementation-Plan.md): 전체 계획. §5 설계 결정 D1–D10, §6 단계 H0–H8.
3. [스파이크 보고서](../spikes/HAR-pi-sdk-spikes.md): H1 결과와 발견 F1–F9. **H2 설계는 이 발견을 반영해야 한다.**
4. [CR-018](../change-requests/CR-018-pi-standard-harness.md), `docs/Decisions.md`의 ADR-027.
5. Bell의 원안: [personal-harness-2026-10-17](../proposals/personal-harness-2026-10-17.md).

## 지금 상태

| 단계 | 상태 |
|---|---|
| H0 기준선 | 완료. PR #54 병합. main의 PR gate가 `spec:check`에서 막히던 문제(CR-016 TC-REF 미등록)를 고쳤다. **병합 후 main CI 결과는 확인하지 않았다** |
| H1 계약·스파이크 | 완료(브랜치). S1·S2·S4가 통과해 플랜의 Go 조건을 충족한다. **Go 결정은 Bell이 한다** |
| H2 이후 | 시작하지 않음 |

로컬 gate 결과(`609e9ce` 직전, 같은 내용):

- `spec:check`: pack PASS 1165 checks, 태그 145/155
- `contracts:check`, `lint`, `typecheck`, `build`: 통과
- unit: 730 passed, 4 skipped
- E2E: 이번 브랜치에서는 돌리지 않았다(UI 변경 없음)
- S6(npm 네트워크)는 opt-in으로 따로 통과
- S8은 Node 24.19.0(desktop 동봉)에서도 통과

## 다음에 할 일

### 1. H1 PR 열기

`feat/harness-h1` → `main`. 본문에 넣을 것:

- 범위: CR-018·ADR-027 제안, Pi 1.3.0 고정, 스파이크 S1–S8, 카탈로그 등록.
- 제품 실행 경로 변경은 없다. coding-agent는 devDependency다.
- 결과표: 보고서의 "결론" 표.
- 발견 F1–F9.
- 확인하지 못한 것: 보고서 마지막 절.
- **Bell에게 Go / No-go 결정을 요청**한다.

진행 규칙(Bell, 저장된 메모리):

- 중간 커밋은 하되 PR은 묶음이 끝날 때 하나만 낸다.
- E2E는 큰 분기에서만 돌린다.
- Bell이 "CI 기다리지 말고 머지"라고 하면 그렇게 한다.
- PR을 연 뒤에는 앱의 ccd_pr 도구로 묶고, CI를 직접 polling하지 않는다.

### 2. Go 승인 뒤 (같은 브랜치 또는 새 브랜치)

1. ADR-027 상태를 "채택"으로 바꾸고, ADR-005에 "ADR-027이 부분 대체"를 표시한다. ADR-024 결과·제약에 "Pi 확장 hook은 worker 안에서만"을 덧붙인다.
2. CR-018의 "문서 변경" 표를 반영한다.
   - `Corral-Spec-v0.1.md` 111행 범위
   - `docs/Technical-Design.md` 233행
   - `docs/Dependencies-and-Sources.md` 27행과 새 출처 항목, `docs/dependency-lock.json`
   - 버전·라이선스 값은 플랜 §8 표에 있다(2026-10-17 `npm view` 확인값).
3. **H2 런타임 기반**(플랜 §6 H2)으로 간다. 스파이크 harness `packages/adapter-pi/test/spike/sdk-session.ts`가 제품 구성의 원형이다. 반드시 반영할 것:
   - F1: `systemPromptOverride`·`appendSystemPromptOverride`를 Corral 값으로 고정한다. SDK 경로는 project trust를 적용하지 않는다.
   - F2: Corral 확장이 `before_agent_start`에서 `sections.cwd`를 바꿔 절대경로를 숨긴다.
   - F6: worker env에 `JITI_FS_CACHE`를 Corral 전용 폴더로 지정한다(기본은 공유 `/tmp/jiti`).
   - F7: 도구 실행 인자는 `tool_call` 승인값으로 기록한다. `tool_execution_start.args`는 hook 이전 값이다.
   - F8: 요청 기록은 Corral provider가 받은 context(`role: 'system'` 메시지의 `sections` 포함)로 만든다.
   - F9: Pi 런타임에는 자리표시자 키만 둔다. 확장이 `ctx.modelRegistry.getApiKeyForProvider`로 키를 읽을 수 있다.
   - provider 등록에는 `api`·`baseUrl`(쓰이지 않는 자리표시자)·`apiKey`(자리표시자)가 필요하다. 없으면 등록이 거절된다.
   - 압축은 요약 호출을 1–2번 한다. 둘 다 permit 대상이다.
   - 스파이크 테스트는 Pi 업그레이드 회귀 테스트로 남긴다(ADR-027 결과·제약).
4. H3(리소스·역할·화면)에서는 다음을 반영한다.
   - F3: `read`가 없으면 스킬이 나열되지 않는다. R1 `read` 도구가 필요하다.
   - F4: 가상 경로에서는 `/skill:`을 Corral이 직접 펼친다.
   - F5: 확장 명령은 실행 시작 옵션으로만 지원한다(실행 중에는 Pi가 거절).

## 검증 방법

```bash
pnpm install
```

`spec:check`의 pack validator에는 Python `jsonschema`가 필요하다. 시스템 pip가 막혀 있으면 uv venv를 쓴다:

```bash
uv venv /tmp/corral-venv && uv pip install --python /tmp/corral-venv/bin/python -r tools/requirements.txt
```

```bash
CORRAL_PYTHON=/tmp/corral-venv/bin/python pnpm spec:check
```

```bash
pnpm contracts:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

```bash
pnpm vitest run --project adapter-pi test/spike
```

```bash
CORRAL_SPIKE_NETWORK=1 pnpm vitest run --project adapter-pi test/spike/packages.test.ts
```

```bash
CORRAL_SPIKE_NODE=~/.local/share/fnm/node-versions/v24.19.0/installation/bin/node pnpm vitest run --project adapter-pi test/spike/worker-env.test.ts
```

## 알아 둘 함정

- **vitest는 타입을 검사하지 않는다.** 테스트가 통과해도 `pnpm typecheck`가 실패할 수 있다(이번에 실제로 있었다).
- `pnpm biome check --write <경로>`로 형식 오류를 먼저 고친다.
- 카탈로그 관련
  - `tests/test-catalog.json` 항목은 `status: "planned"`여야 한다(검사기 규칙).
  - 요구·태스크를 추가하면 `tests/traceability.json`도 같이 고친다.
  - `tests/pack-validation-report.json`은 `python -I tools/validate_pack.py`(인자 없이)로 다시 만든다.
- `tools/spec-check/tc-tags.ts`는 `[TC-XXX-000-H|N]` 태그만 검사한다. `-F`·`-D`와 2자리 ID는 검사하지 않는다(플랜 H0 4번, 선택 과제로 남김).
- 이 머신의 셸
  - `ls`가 eza 별칭이다. `command ls`를 쓴다.
  - 기본 Node는 24.14다. desktop prepare·smoke에는 fnm의 24.19.0이 필요하다.
- `apps/desktop/staging/`은 생성물이다. spec-check가 그 안의 테스트 태그도 읽는다.
- `spikes/p0`는 옛 P0 스파이크라서 Pi 1.2.0을 그대로 쓴다. 바꾸지 않았다.

## 지켜야 할 제약 (앞 세션들에서 이어짐)

- `~/.codex/auth.json` 내용을 출력·갱신·쓰기·삭제하지 않는다.
- 토큰·키·자격 증명 경로를 로그·API 응답·이벤트·export에 남기지 않는다.
- 실제 모델 호출은 한도가 있는 opt-in일 때만 한다(`pnpm corral dev`에 GPT OAuth가 로그인돼 있다).
- 일반 CI에 유료 호출·네트워크를 넣지 않는다. S6처럼 env로 opt-in한다.
- 실패 테스트를 지우거나 완화해서 통과시키지 않는다. 검증하지 못한 것은 못 했다고 쓴다.
- `pi-core` 역할의 이벤트·hash·골든은 바뀌면 안 된다.
- 필수 확장 실패 시 `pi-core`로 fallback하지 않는다.

## 열려 있는 것

- main CI(PR #54 병합 커밋)의 실제 결과: 확인하지 않았다.
- 앞 세션에서 제안만 한 별도 과제: "Fix editor showing 'Unsaved changes' after a run". 시작하지 않았다.
- Bell의 5인 사용성 평가(`docs/evaluation/Workbench-Usability-Results.md`): Bell이 채우면 문제를 플랜 항목으로 옮긴다.

## 2026-10-18 추가 체크포인트: H2 및 H3 설정 연결

- H2의 SDK worker, permit/요청 기록, 최종 도구 인자 승인, 기본 worker 호환 경로를 구현했다.
- H3의 불변 프로필, 리소스 검토·복사 설치·hash 신뢰, 개인/프로젝트 상속, 스킬 broker 읽기, 실행별 리소스 복사본을 구현했다. 원본 Ponytail 5.3.2의 역할 A/B 격리는 임시 설치와 fake provider로 확인했다.
- 서버 API와 `/settings/harness`, 역할 Inspector의 작업 방식 바인딩, 적용 미리보기, 실행 기록의 스냅샷/요청 해시를 연결했다. 기본값 교체 시 이전 기본값을 재상속하던 오류도 수정했다.
- 자동 임계치 압축을 실제 SDK worker에서 유도했고, 압축 permit 및 압축 후 필수 스킬 유지가 통과했다. 네이티브 확장이 최종 context에서 필수 구획을 제거하는 경우와 proxy provider 응답 식별자 회귀도 검증했다.
- 검증: adapter/Core/server 관련 40 tests, 새 설정 E2E 1개(설치→신뢰→필수 스킬 저장→미리보기→새로고침), 전체 workspace typecheck 통과. 인앱 브라우저에서도 한국어 설정으로 같은 동작을 직접 확인했다. 이 기록은 당시 체크포인트이며 최종 gate 결과가 아니다.
- **아직 H3 완료 아님:** 확장 UI 왕복·명령 레지스트리·Pi 홈 선택 import, SDK 실제 실행을 포함한 최종 UI 검증을 계속한다. H4–H8 전체 구현과 마지막 Computer Use 검증도 사용자 요청 범위에 남아 있다.

### H3 확장 UI 체크포인트

- `select/confirm/input/notify/setStatus`를 SDK → v2 IPC → Coordinator → 기존 확인 필요 패널에 연결했다. 요청 ID·execution·attempt·control revision·timeout을 검사하며 취소/종료/중복/늦은 응답을 막는다. custom/터미널/위젯 UI는 비지원 알림을 남긴다.
- 요청·답변·알림 본문은 private record로 저장하고 이벤트에는 참조·해시를 남긴다. 해당 참조만 본문 읽기 API에 허용한다. 실행 기록의 확장 UI 이력도 표시한다.
- 필수 확장의 `session_start` 오류를 SDK가 삼키는 반례를 추가했고, 모델 호출 전 명시 실패로 처리했다.
- 체크포인트 검증: 관련 5개 프로젝트 595 passed / opt-in 3 skipped, 스펙 1250 checks 통과. 새 브라우저 E2E 2개 통과(설정 저장/재접속 및 확장 확인→SDK 실행 완료). 원본 Ponytail 역할 격리 opt-in 테스트도 다시 통과했다. 실제 유료 모델 호출은 없다.
- 다음: Pi 홈의 명시적 복사 import·확장 명령 메타데이터와 시작 명령 연결, H3 남은 경계 검증, H4–H8. 전체 완료로 표시하지 않는다.

### H3 추가 연결 및 H4 파일 도구 체크포인트

- Pi 홈의 스킬·확장 폴더만 명시적으로 복사 import한다. 인증·설정·세션은 제외하며, Pi 설정에만 등록된 패키지는 별도 버전 고정 설치가 필요하다. 실제 Pi 패키지 탐색기로 복사본을 검사하는 테스트가 통과했다.
- 확장 명령의 출처·호출 이름·패키지 별칭·시작 조건을 기록한다. `/fixture:pause`처럼 앱 명령과 구분되는 별칭을 시작 옵션에서 해석한다. 앱 레지스트리는 해당 execution에 고정한 시작 전용 항목으로 표시하며 실행 중 다른 대상으로 옮겨 호출하지 않는다.
- H4: 읽기 근거를 Run→execution→path로 분리했다. 다른 실행의 읽기를 빌리는 경우와 A 읽기→B 쓰기→A 오래된 쓰기를 거절한다.
- Pi 공식 `createEditTool`을 메모리 operations를 가진 임시 worker에서 실행해 edit 변환·오류·diff를 재사용한다. 실제 쓰기는 기존 broker의 lease·읽기 hash·작업 기록·원자적 파일 교체를 거친다. SDK의 `edit/write`는 기존 파일 권한과 하네스 allowlist가 모두 허용해야 보인다.
- H4 체크포인트: 관련 57 tests 및 adapter/server/studio typecheck 통과. 원본 Pi 대비 BOM/CRLF/다중 블록/모호한 일치/겹침/무변경 오류 비교, 계산 중 취소·외부 변경 시 무반영을 확인했다.
- 남은 전체 범위: H3의 실행 단위 override 연결/마지막 UX 경계 재검토, H4 LSP 읽기·편집 비교 평가, H5 검증 runner, H6 recipe/개선/eval, H7 항목 반복, H8 MCP/codemode/LSP 변경 제안, 마지막 통합·desktop·Computer Use 검증. 아직 최종 완료가 아니다.

### H5 연결 및 Pro 재검토 체크포인트 (2026-10-18)

- 사용자 지적에 따라 Oracle을 **Pro**로 다시 실행했다. 인앱 브라우저에서 Pro 선택과 완료를 확인했다. 대화: https://chatgpt.com/c/6ad3ba1c-c5a0-83e8-9c52-951cf97682de . 임시 증거 `/tmp/corral-harness-oracle/pro-review.txt`, `pro-review.png`. Medium 답변을 최종 검토로 취급하지 않는다.
- 검토로 제기된 edit 원본 삭제/재조회 우회, broker BOM 손실, 최종 쓰기 취소, 쓰기 후 기록 실패를 재현하고 보강했다. 제한 바이트 읽기를 공유하고 기존 원본 hash를 적용까지 유지한다. 실제 변경 후 기록만 실패한 작업은 uncertain이다.
- 후속 execution의 모델 재해석을 제거했다. Run 및 명시적 모델 patch의 snapshot을 사용한다. worker 정상/예외 종료의 도구 drain, 늦은 effect 중복 정산, pause 중 native 완료 처리를 보강했다. Core 전체 248 tests 통과 시점을 확인했다.
- 프로젝트 실행 설정/검사·LSP 선택은 불변 revision과 hash다(migration 0008). 기존 검사 설정도 같은 저장소를 사용한다. 실행 해시 신뢰는 별도이며 명령·실행 파일·관련 스크립트·잠금 파일이 달라지면 재승인이 필요하다.
- 수동/자동 검사는 공통 VerificationRunner를 사용한다. 고정 Git 복사본, execution/attempt/effect 소유권, 취소와 POSIX process group 정리, 시계 주입, 제한·마스킹 출력, 7일 출력 보존, 상태/판정 분리를 구현했다. 후보 복사본을 변경한 검사도 pass 근거로 인정하지 않는다.
- `run_check`는 선택 ID만 받는다. Inbox 승인에 실행·효과·파일 상태·해시·기한이 고정되며, 취소/만료/끝난 실행의 승인은 닫힌다. 승인 하나만 해결해 다른 승인을 건너뛰지 않는다. 명령 정보 미확인 시 UI는 승인 버튼을 막는다.
- 설정에서 검사 선택/실행 신뢰, SDK 호출→승인→검사→보고서까지 새 브라우저 E2E 통과(로컬 fake provider). 관련 4개 프로젝트 516 passed / opt-in 2 skipped 확인. 새 서버/API 테스트와 typecheck도 통과했다. 실제 유료 모델 호출 없음.
- H4 LSP 읽기는 이제 구현을 시작한다. H3 Run override/남은 UX 경계, H4 Hashline 비교, H6–H8, 전체 회귀·배포 staging·마지막 Computer Use 검증은 여전히 남았다. Windows 자손 프로세스 종료 확인은 아직 지원/검증 완료가 아니다.

### H4 LSP 읽기 연결 (2026-10-18)

- `lsp_query`를 SDK 도구 목록, Coordinator 역할 읽기 권한·선택 서버 제한, 실행 소유 승인/취소 경로에 연결했다. 실행 설정과 질의를 승인 본문에 고정하고 UI에서 검사와 구별한다.
- 프로젝트 설정에서 stdio 언어 서버 등록·수정·제거, 역할별 선택·상속, 정확한 실행 해시의 신뢰·철회를 제공한다. 검사와 LSP의 같은 ID는 신뢰를 공유하지 않는다. 프로젝트 전환 중 이전 설정을 새 프로젝트로 저장하지 않도록 상태를 구분한다.
- broker는 UTF-16 위치·파일 hash·서버 version·범위 밖 URI·결과 크기·완료 시 tree를 검사한다. LSP가 참조한 파일은 agent의 읽기 근거를 대신하지 않는다.
- 검증: server LSP/파일/검증/API 45 tests, contracts/core/adapter/react 520 passed / 2 opt-in skipped, 관련 6개 패키지 typecheck, Studio production build. 실제 로컬 LSP fixture를 사용하는 브라우저 E2E 2개(검사·언어 서버 등록→선택→승인→완료→실행 신뢰) 통과. 전체 회귀는 프로세스 시작 부하를 제한해 `--maxWorkers=4`로 실행했다.
- 남은 작업: H3 Run override·정적 미리보기/UX 경계, H4 편집 비교 평가, H6–H8, 최종 통합·desktop·Computer Use. 이 브라우저 E2E는 최종 Computer Use 검증을 대신하지 않는다.
