# Workbench 식별성과 테두리 일관성 검증

- 범위: [CR-045](../change-requests/CR-045-workbench-identification.md), CRL-UX-007 / C-141 / TC-UX-007-H,N.
- 기준: `183e0ce` 위 작업 트리 변경. 커밋·배포·전체 release 판정은 포함하지 않는다.
- 환경: Linux, Node 24.19.0, pnpm 10.30.3, Studio production build와 Playwright Chromium 및 Codex 인앱 브라우저.
- 공급자: 기존 deterministic fakeOpenAI/ScriptedAgentAdapter와 로컬 endpoint. 외부 유료 모델 호출과 사용자 DB 변경 없음.

## 적용 결과

1. `--input`과 공용 Input/Select/native settings 필드가 같은 경계 토큰을 사용한다. 초기 구현에서는 빈 이름·목적 입력의 비포커스 대비를 라이트/다크에서 3:1 이상으로 검사했다. 이후 사용자의 옅은 기본 테두리 요청에 따라 이 수치 목표를 대체했다. 현재 결과와 검사 범위는 아래 후속 검증을 따른다.
2. 새 무제목 대화의 `autoTitle` 표시를 첫 next/queue 요청과 같은 repository 저장에서 해제하며 첫 줄 60 code point까지 제목으로 확정한다. 명시 이름·기존 데이터는 유지한다. metadata revision을 증가시키고 사이드바·탭도 갱신한다.
3. 모델명 말줄임을 없애고 좁은 화면에서 다음 요청·모델명·추론을 줄바꿈한다. 한영 긴 모델명과 메뉴, 초안 유지, 320/390px, 고대비·모션 감소를 확인했다.
4. `대화 목록 필터` / `Filter conversations`로 제목·목적 필터임을 구분한다. 별도 검색의 본문·보관 항목 opt-in과 검색어 전달은 유지한다.
5. 팀 목록의 중복 선택 안내를 제거하고 JSON 형식 안내를 기존 Tooltip으로 가져오기 버튼에 연결한다. 키보드 포커스·Enter 파일 선택, 취소·잘못된 JSON과 초안 보존을 확인했다. 저장 위치 안내와 템플릿·편집 경로는 유지한다.
6. 공용 선택/입력의 경계를 통일하고 대화 입력 그룹·연결된 대기열/상태 영역·메뉴/팝오버의 장식 외곽선을 제거했다. 입력 초점은 둥근 입력 영역에, 버튼 초점은 해당 버튼에 표시한다. 고대비 모드의 팝업 outline, 탭·분할선·오류 표현은 보존한다.

## 실행한 검사

| 검사 | 결과와 경계 |
|---|---|
| 구현 전 입력 대비 | 라이트/다크 2개 FAIL 확인 후 같은 검사 PASS |
| 구현 전 자동 제목 | 공용 repository 시나리오 6개와 SQLite 기존 데이터/재시작 시나리오 1개 FAIL 확인 후 PASS |
| 제목 UI | 생성 표시 누락과 저장 후 사이드바/탭 갱신 누락을 각각 재현한 뒤 첫 요청→결과→재로드 PASS |
| 모델·검색·안내·테두리 red | 한영 모델명 잘림, 필터 이름, 중복 설명, border 없는 Select와 popup border를 확인한 뒤 PASS |
| 단위·서버·통합 | core repository, SQLite, server REST, session search, locale, settings patch 6개 파일 102개 PASS. 이후 저장 실패/재시도 반례를 추가한 core 파일 19개 PASS(기존 18개 포함; 중복 합산하지 않음) |
| 브라우저 회귀 | chat-entry, chat-first-composer, chat-widgets, contextual-settings, settings-scope, reins-recovery, workbench-identification 28개 PASS |
| 마지막 입력 포커스/긴 모델명 변경 | workbench-identification + chat-widgets 11개 재검증 PASS. 추가 고대비/모션 감소는 한영 모델 시나리오 2개 PASS |
| opt-in workbench-measure | 필터의 새 이름으로 locator를 맞췄다. 실행은 `CORRAL_WORKBENCH_PERF` 미지정으로 1개 SKIP이며 성능 수치를 새로 주장하지 않는다. 필터 동작 자체는 위 일반 회귀에서 PASS |
| `pnpm typecheck` | PASS |
| `pnpm spec:check` | Python jsonschema가 있는 기존 검증 환경을 `CORRAL_PYTHON`으로 지정하여 PASS. 최초 기본 Python의 의존성 누락은 환경 오류로 구분 |
| `pnpm contracts:check` | 생성 JSON Schema 일치 |
| `pnpm deps:check` | PASS, 새 의존성 없음 |
| 변경 파일 Biome / `git diff --check` | 오류 없음. 기존 app optional-chain 및 CSS specificity 경고 2개 유지 |

명령은 `pnpm exec vitest run <위 파일들> --maxWorkers=2`와 `pnpm --filter @corral/studio exec playwright test --project=server <위 시나리오들> --workers=2`를 사용했다. 브라우저 fixture는 임시 workspace/DB를 만들고 정리한다. 테스트 산출물은 이번 실행의 임시 `corral-cr045-*` 로그·trace·스크린샷에 남겼으며 민감한 실제 본문을 캡처하지 않았다.

인앱 브라우저에서는 라이트/다크 입력, 키보드 가져오기 안내, 테스트 요청 후 제목의 사이드바·탭 반영과 재로드, 390px 모델/추론, 320px 둥근 입력 포커스와 가로 넘침 없음(`scrollWidth = 320`)을 직접 확인했다. 캡처의 Test A는 검증용 모델이며 실제 공급자 품질의 증거가 아니다.

## 설정 컨트롤 후속 검증

- 승인 근거: CR-045 7·8항과 실제 화면 피드백. 첨부 1·2는 기본/포커스 테두리의 예시이며 새 색상 체계를 도입하는 요청이 아니다.
- 기본 경계는 기존 `--line`을 재사용하고 모서리는 공용 `--control-radius`로 통일했다. 포커스는 브랜드 accent 경계와 얕은 ring으로 구분하고 고대비 모드에는 시스템 outline을 유지한다. 비포커스 경계 3:1 이상을 현재 결과로 주장하지 않는다. 이름·목적 입력의 3:1 검사는 포커스 상태에 적용한다.
- 설정의 Select·텍스트 입력·일반 버튼은 최소 36px, 터치 포인터에서는 44px를 공유한다. Input 외곽 wrapper에도 높이를 적용해 인앱 브라우저의 소수점 배율에서 35.33px로 줄어드는 차이를 보정했다. textarea 줄 수·크기 조절, 별도 아이콘/초소형 버튼의 용도는 보존한다.
- 모델 가져오기/메타데이터 검색은 기존 공용 Input을 사용한다. 설정 컨테이너 안의 Input/textarea/outline Select는 기존 어두운 surface 배경을 쓰며 입력의 장식 그림자를 없앴다. 좁은 화면의 설정 파일 입력은 줄을 나눠 입력 공간을 확보한다.
- API 키의 두 사용처(공급자 로그인, 모델 편집기)는 같은 ApiKeyInput을 사용한다. 표시 버튼 사이 간격 4→8px, 높이 32→36px, 저장 버튼의 20px 위쪽 어긋남을 재현하고 수정했다. 실제 인앱 DOM에서 입력/표시/저장 높이 36px, 간격 8px, 입력 배경 `rgb(21,22,21)`를 측정했다.
- 수정 전: 금고 버튼 28px/Select 36px, 모델 입력 34px/버튼 28px, 서로 다른 radius와 배경으로 red를 확인했다. 브라우저 테스트의 모달 초기 진입, 좁은 화면 내비게이션, 포커스 타이밍 문제는 제품 실패와 구분해 수정했다.
- 검증: 설정/대화/작업 방식 등 8개 E2E 파일 27개 PASS 후 추가 피드백을 반영한 설정/모델/가져오기/수명 4개 파일 26개 PASS. 중복을 제외하면 42개 시나리오다. 마지막 독립 설정 Select 배경 정렬 후 settings-controls 4개를 다시 PASS 확인했다(`/tmp/corral-controls-last/`). API 키 표시·숨김·저장·삭제·부분 실패 재시도·동시 편집, 금고 복원/잘못된 암호, 미저장/실패/늦은 응답, 한영/테마/390px/터치/고대비 회귀를 포함한다. 키 테스트는 가짜 자격 증명을 사용하며 실제 외부 호출은 없다.
- 단위: settings patch/locale 2개 파일 5개 PASS. 전체 typecheck 후 마지막 Studio 변경의 typecheck도 PASS. production build, spec:check(2286 checks, 301/301 tags), contracts:check, 변경 파일 Biome(오류 없음, 기존 theme specificity 경고 1개), diff 공백 검사 PASS. 의존성/API/DB 변경은 이 후속 수정에 없다.
- 실제 화면: 일반·금고·모델·작업 방식의 다크 화면을 인앱 브라우저로 확인하고, Playwright production 화면에서 라이트/다크·포커스·390px 터치를 캡처했다. `/tmp/corral-controls-feedback-green/`의 screenshots/실행 로그와 `/tmp/corral-controls-screens/05-api-key-final.png`가 해당 검증 자료다. 임시 fixture는 synthetic 모델/프로젝트만 사용했다.
- 사용자 서버 4317은 재시작하지 않고 기존 content-hash assets를 보존했다. 검증용 33717 화면은 새 빌드로 다시 연결했으며 사용자 데이터와 별개다. 운영/packaged 검증 또는 전체 접근성 적합성 판정은 아니다.

## 보존과 롤백

- 사용자 실행 서버는 중지·재시작하거나 DB를 업그레이드하지 않았다. 빌드가 지운 기존 서버의 content-hash JS/CSS 4개는 기준 commit의 격리 빌드로 동일 해시를 재현해 추가 복원했다. 새 빌드 index는 유지하며 기존 서버가 참조하는 JS/CSS가 HTTP 200과 올바른 MIME type으로 응답함을 확인했다. 새 기능을 기존 서버에서 사용하려면 정상 재시작이 필요하다.
- SQLite migration 0028은 boolean 열만 추가하고 기존 행을 false로 둔다. 임시 DB에서 schema 27의 이름 유지, migration, 재시작, 자동 제목 확정을 확인했다. 구버전 바이너리로 돌아갈 때는 [Desktop 백업 절차](../../apps/desktop/README.md)를 따라 업그레이드 전 DB/config 사본을 복원한다. 열을 수동 삭제하지 않는다.
- 코드 롤백은 이번 CR의 diff만 되돌리고 뒤이은 사용자 변경을 보존한다. 기존 대화를 일괄 재명명하지 않는다.

## 미검증

Windows/macOS, packaged Electron/AppImage, 실제 IME·스크린리더, 전체 WCAG 적합성·전체 release gate, 외부 모델/실시간 음성은 이번 검증 범위 밖이다. 모든 화면의 테두리 제거를 주장하지 않으며 선택·오류·데이터 구분에 필요한 경계는 유지한다.
