# CR-049 회의실 — 구현과 검증

> 이 문서는 최초 C-174–176의 개발 역할·라운드 기반 계약에 대한 실행 증거다. 이후 2026-10-23 Bell은 기본 역할 없는 그룹 채팅, 일반 후속 대화, 필요할 때만 개발 역할 지정, 요청 시 비서의 회의록·플랜을 명시했다. [CR-049 현재 계약](../change-requests/CR-049-meeting-room.md)이 충돌 부분을 대체한다. 아래 commit·해시·시험 결과는 보존하며 새 대화 경험을 이미 검증했다는 근거로 사용하지 않는다.

- 범위: C-174–176 / CRL-MEET-001–003 / TC-MEET-001–003-H,N,F.
- 기준: `97d0db2fa2f16d5172a3291c35a012ab5ecb492b` 위 `feat/meeting-room`의 미커밋 작업 트리. 중단 시점의 C-174 초안과 기존 미커밋 변경을 보존하고 이어서 구현했다.
- 환경: Linux x64, Node 24.19.0, pnpm 10.30.3, SQLite, Chromium. 초기 검증은 결정적 모델 fixture로 수행했고, 아래 후속 검증에서는 사용자가 요청한 기존 연결 모델을 실제 호출했다.

## 구현

- 회의 세션 저장과 기존 work 세션 호환, 역할/모델 설정, 전원·멘션·비서·반론 라운드, 독립 실행과 참가자 순서 표시, 하나의 대기 메시지 편집, 실패·중지·늦은 응답·재열기.
- 사람이 선택한 파일·산출물 본문만 해시/크기를 검증해 불변 입력으로 전달. 읽기/쓰기/명령 도구를 참가자에게 제공하지 않는다. 회의의 Corral 토큰·호출·시간 한도는 없으며 미확인 사용량을 구분한다.
- 비서의 구조화 회의록과 실제 성공 답변 참조 검증, 후보 편집·부분 행동 선택, 불변 결정 채택·대체·철회. 잘못된 회의록은 오류로 표시하고 자동 재호출하지 않는다.
- 채택된 현재 결정만 같은 프로젝트 일반 세션으로 초안/실행 인계. 선택한 Corral 정의·revision 또는 자동/Ultra 구성, 채택한 완료 기준을 고정하고 대상 기본값은 수정하지 않는다.
- SQLite 인계 receipt·대상 항목의 원자적 저장, 같은 명령 중복 방지, 응답 유실·서버 재시작·철회·취소 경합 복구, 양방향 링크와 명시적 결과 재논의.
- 새 라이브러리 없이 기존 Coordinator·repository·텍스트 첨부·UI 컴포넌트·실행 시작 경로를 재사용했다.

## 실패 재현

중단 시점의 회의 테스트 14개는 통과했지만 아래 반례는 새 테스트에서 실제 실패한 뒤 수정했다.

- 대기 메시지 편집 누락, 수신자·모드·근거를 바꾼 중복 명령, 공백 이름 멘션과 `/반론`.
- snapshot 장애를 종료로 오인한 중복 라운드, 답 Run 저장 실패 뒤 살아 있는 실행, 승인되지 않은 1,000라운드 상한.
- 회의 세션의 일반 실행 API 우회와 인계 내부 시작 ID의 일반 API 선점(실제 HTTP에서 201로 추가 Run 생성).
- 미구현 회의록/인계 모듈, 실패 참가자 합의 인용, 변경·철회·저장 실패·중복 경합.
- 미확인 시작을 결정 철회 후 재전송하면 실행되는 문제, 취소 요청 실패를 cancelled로 확정하는 문제.
- 요약 버튼이 미전송 초안을 지우는 문제, 오래된 폴링 응답의 화면 역행, 인계 응답 유실 뒤 새 초안 보호.
- 실제 E2E에서 숫자로 시작하는 UUID가 Identifier 검증에 실패하는 문제. 기존 `newCommandId()`를 사용하도록 수정하고 숫자 UUID 회귀를 추가했다.

## 검증 결과

각 묶음은 별도 범위이며 중복 합산하지 않는다.

- 중단 시점 기준 회의 core·HTTP·UI: 14 PASS.
- 관련 repository·SQLite·기존 자동 실행 취소/기준선·새 회의·선택 근거 UI: 15파일 108 PASS.
- Coordinator·사용량·기존 Ultra 회귀: 7파일 74 PASS.
- 최종 회의·인계·저장·기존 실행·작업 사본 없는 화면 회귀 묶음: **35파일 268 PASS**. 로그 `/tmp/corral-meeting-final-tests.log`.
- 최신 production Studio build + 실제 서버 Chromium: **4 PASS**(25.6초). 회의 생성·모델 선택·멘션·비서·재열기·대기 편집·중지, 이견·편집 채택·철회, 기존 미전송 입력 보존·초안/시작 인계·양방향 링크·결과 재논의. 브라우저 console/page 오류·외부 브라우저 요청 0. 중지 시험은 시간 지연을 늘리지 않고 기존 `Gate`를 사용했다. 로그 `/tmp/corral-meeting-e2e-final.log`.
- 최종 화면: 1280px와 390px에서 참가자 순서·컴포저·회의록 접근을 확인했다. 성공한 비서 JSON은 안내와 회의록 버튼으로 표시한다. 이미지 `apps/studio/test-results/server-meeting-room--TC-ME-87835-eopening-without-more-calls-server/meeting-room-{desktop,narrow,minutes}.png`(로컬 생성물).
- 전체 `pnpm typecheck` PASS, 마지막 UI 수정 후 Studio typecheck도 PASS. production build PASS. 기존 큰 chunk·비효율 dynamic import 경고는 남아 있다.
- 변경 파일 Biome 검사 PASS(오류 0, non-null assertion 등을 포함한 경고 135), `git diff --check` PASS.
- 구조 검사: `contracts:check`, `deps:check` PASS. `spec:check`는 validator가 없는 환경에서 먼저 실패했고, `/tmp/corral-meeting-validator`에 저장소 `tools/requirements.txt`만 설치한 후 PASS. 시스템 Python·프로젝트 의존성은 변경하지 않았다.
- 전체 번역 검사: 키/ICU 인자 검사는 PASS. 기존 `DebuggerSettings.attachHint`의 영어 `inspector` 검사 1건 FAIL. HEAD와 이번 작업에서 같은 문자열이고 회의실 변경과 무관하므로 수정하지 않았다.

PR 준비 후속: 같은 디버거 화면의 `Inspector 포트`·`Inspector를 켠 소유 작업` 표기에 맞춰 위 안내의 `inspector`를 `Inspector`로 통일했다. 테스트를 변경하지 않고 `locales.test.ts` **3 PASS**를 확인했다. 로그 `/tmp/corral-meeting-locale-gate.log`. 이는 아래 실제 모델 시험 이후의 문구 수정이다.

실제 서버 E2E는 `pnpm --filter @corral/studio build` 후 `pnpm --filter @corral/studio exec playwright test --project=server e2e/server/meeting-room.spec.ts --workers=1`로 재현한다. 회의 기능 집중 시험은 `pnpm exec vitest run meeting Meeting NewMeeting --maxWorkers=2`로 실행한다. 최종 268개 묶음은 여기에 `DevelopmentMode`·`DeploymentTasks`, core repository, storage-sqlite 전체, auto-cancel/auto-baseline, Coordinator·limits·budget-coordinator·ultra-tournament를 포함했다.

## 실제 연결 모델 후속 검증

Bell의 실제 모델 시험 요청에 따라 기존 로그인·모델 설정을 재사용했다. 별도 임시 workspace와 Git 저장소에서 실제 HTTP API·Coordinator·Pi worker를 사용했으며 mock 실행은 즉시 실패하도록 했다. 아래 시험의 실행기는 `tests/live/meeting-room.live.test.ts`다. 일반 CI에서는 skip하며 명시적 opt-in, 시도당 최대 36회 논리 요청·10분 제한이 있다. 공급자 내부 재시도나 출력 토큰 상한까지 보장하는 비용 한도는 아니다.

| 역할 | 연결 모델 | 인증 |
|---|---|---|
| Architect | OpenAI `gpt-6-luna` (`model-a`) | 기존 OAuth |
| Builder | Hive `deepseek-ai/deepseek-v4.1-flash-1017` (`deepseek-hive`) | 기존 API key |
| 비서·인계 작업자 | OpenAI `gpt-6.1-sol` (`model-b`) | 기존 OAuth |

### 실제 실패와 수정

- 첫 실제 회의에서 Hive 모델이 도구 없이 정상 텍스트로 답했으나 `the agent finished without submit_result`로 실패했다. worker의 정상 종료 표시와 Coordinator의 현재 호출 검증을 연결해 회의에 한해 기존 산출물 작성·제출 경로로 확정한다. 재호출을 추가하지 않으며 빈 답·잘림·오류·취소·늦은 응답·미완료 도구 작업·일반 작업은 성공으로 바꾸지 않는다. 회귀를 먼저 실패시킨 뒤 수정했고 관련 **5파일 68 PASS**, 전체 typecheck PASS를 확인했다. 로그 `/tmp/corral-meeting-real-final-regressions.log`, `/tmp/corral-meeting-real-final-typecheck.log`.
- 다음 두 시도는 작업자의 읽기·계획 단계에서 기존 `no_progress` 확인 요청을 만났고 시험 실행기가 이를 거절해 중단했다. 제품 한도는 유지했다. 시험 실행기가 현재 revision·승인 대상에 맞는 확인을 최대 두 번 처리하도록 보완했으며 두 번째는 약속한 파일 변경·변경되지 않은 테스트·Node 테스트 성공을 직접 확인해야 한다. 다른 종류의 승인이나 반복 정체는 실패한다.
- 성공 기록을 실제 production UI로 재열었을 때 결과 화면이 저장되지 않은 자동 Corral을 조회해 404를 만들었다. 기존 저장 Corral 존재 판정으로 layout 조회를 제한했다. 수정 전 inline·삭제된 Corral 회귀 2개 FAIL, 수정 후 관련 **4 PASS**와 Studio typecheck PASS. `auto_`로 시작해도 실제 저장된 Corral의 layout은 유지한다. 재빌드·서버 재시작 후 같은 실제 결과·회의 기록의 콘솔 오류 0, 잘못된 Corral 조회 0을 확인했다.

### 성공한 전체 경로

- 2026-10-23 11:47:18–11:48:45 UTC, 약 **87초**, **6개 Run 성공**, 논리 모델 요청 **19회**(작업/회의 18 + 실제 자동 구성 선택 1). 앞선 세 시도는 각각 3·14·19회였으며 이번 후속 검증 전체는 55회다.
- 실제 두 참가자 회의 → 실제 비서의 구조화 회의록 → 반환된 결정 후보를 변경 없이 명시적으로 채택 → 준비된 기존 일반 세션으로 인계 → 실제 작업자가 관리 사본 파일 수정 → 동일 인계 명령 재전송 시 추가 실행 없음 → 확정 결과를 두 참가자가 재논의하는 전 경로를 통과했다.
- 오류가 있는 `sum.js`와 고정 Node 테스트를 사용했다. 수정 전 테스트 실패, 실제 작업자가 `a - b`를 `a + b`로 바꾼 뒤 테스트 성공. 변경 파일은 `sum.js`뿐이고 테스트·package.json·원본 저장소는 그대로다. **Node 테스트 실행 주체는 호스트 시험 실행기**이며 모델이 실행했다고 주장하지 않는다.
- 마지막 성공 시도에서 기존 진행 정체 확인을 **1회 승인**했다. 따라서 확인 없이 완전 무인으로 끝난 시험은 아니다. 회의 중 파일 쓰기는 없었고 각 Run의 사용량은 공급자 보고값으로 수집됐다.
- 실제 모델 시험 중 시작·종료 작업 트리 해시 일치: `559e3c8de3f3b63b9258b1c41892d13fecd3b5a96680d8549d883fbefaf23367`. 그 후의 변경은 결과 화면 조회 수정·회귀와 이 검증 문서 반영이다. 이 해시를 최종 전체 작업 트리와 같다고 취급하지 않는다. UI는 같은 저장 기록으로 재검증했으며 이 과정에서 Run 6개·worker 모델 요청 18개가 그대로여서 추가 추론은 없었다.
- 로컬 생성 증거: `test-results/live/meeting-room.json`(실제 모델·Run·사용량·결과·해시), `meeting-room-readback.json`(재열기), `meeting-real-records.png`, `meeting-real-result.png`. 실제 호출 로그 `/tmp/corral-meeting-real-live.log`. 최종 production build 로그 `/tmp/corral-meeting-real-ui-build.log`.

재현은 연결된 프로필을 확인한 뒤 `CORRAL_MEETING_LIVE=1 CORRAL_MEETING_PROFILES=model-a,deepseek-hive pnpm test:live meeting-room.live.test.ts`로 실행한다. 이 명령은 실제 공급자를 호출한다. 비용·사용량은 현재 연결 계정에 발생한다.

## 검증 경계

- 실제 연결 모델 3개의 위 경로를 검증했으며 다른 모델·설정의 일반적 성공이나 공급자 청구 금액을 검증한 것은 아니다. Windows/macOS·설치판·스크린리더와 전체 release gate는 검사하지 않았다.
- 실제 파일 실행은 이미 관리 사본을 준비한 기존 일반 세션에서 확인했다. 새 대상 세션의 관리 사본 자동 준비나 인계 작업자의 명령/검사 하네스 실행까지 확인한 것은 아니다. 자동 인계에는 하네스 선택이 없으므로 이번 시험은 파일 도구와 별도 호스트 테스트를 사용했다.
- 회의록은 구조와 발언 참조를 검증하지만 의미의 정확성과 결정 채택은 사람의 검토가 필요하다.
- 인계의 미전송 입력 보호는 요청한 브라우저의 로컬 초안과 서버의 진행 중/대기 작업을 확인한다. 다른 브라우저의 로컬 초안 부재는 보장하지 않는다.
- 실행 Corral 추천·복제/신규 생성(P4/P5)은 CR에 보존한 후속 범위이며 이번 C-174–176에는 포함하지 않았다.
