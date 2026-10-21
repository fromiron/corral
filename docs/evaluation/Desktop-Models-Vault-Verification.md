# Corral 모델 설정·설정 금고 구현 검증

CR-042 / ABS-05(I07), ABS-13(I16). 2026-10-20 로컬 Windows 작업 사본 기준.
이 문서는 기능별 증거이며 전체 흡수 계획 또는 외부 서비스의 완료 선언이 아니다.

## 모델 설정

설정 → 모델에서 Claude Code, Codex, OpenCode, Pi 설정 파일을 명시적으로 읽고 후보를 선택한 뒤 저장한다.
설정 파일을 실행하지 않는다. 환경 변수·명령 참조와 OAuth 토큰을 평가하거나 복사하지 않는다.
API 키는 서버의 제한된 수명 미리보기 안에만 보관하고 사용자가 해당 공급자·주소의 키 복사를 선택했을 때만 credential owner에 넘긴다.
모델 구성의 revision 검사·원자 파일 교체·registry 갱신·파일 재조회는 기존 소유 경로를 사용한다.

models.dev 정보는 별도 참고 카탈로그다. 크기·시간 제한, 검증된 캐시, hash/fetchedAt와 오래됨/갱신 실패 상태를 제공한다.
가격·한도 정보가 요청 API, reasoning 또는 이미지 capability를 부여하지 않는다.
지원되지 않는 모델/사용자 정의 transport는 미리보기에 이유를 표시한다.
사용자 정의 endpoint의 reasoning/image 값은 가져오기 과정에서 허용하지 않고 기존 모델 편집기에서 검토하게 한다.
추론 선택은 기존 역할/다음 요청 경로를 유지한다.

검증:

- parser 세 소스 형식(JSON)·Codex 모델 필드 TOML, 네 소스 분기, 중복·대용량·잘못된 설정·명령 참조·OAuth 제외.
- 실제 인증된 HTTP API: 파일 선택 → preview → 항목 선택 → commit → config 파일과 모델 registry readback.
- API 키 response 비노출, origin binding, stale revision·preview 재사용 거절.
- 캐시 갱신 실패·재시작·오래됨과 metadata/capability 분리.
- Studio E2E 2개 통과: 정상 가져오기 후 재로드, 미지원 후보 선택 차단 및 token 비노출.

## 설정 금고

설정 → 설정 금고(`/settings/vault`)에서 암호화 파일 내보내기·미리보기·항목별 적용·복구와 S3 동기화에 접근한다.
도메인은 application/providers/mcp/skills/subagents/instructions/plugins/automation/memory다.
필수 로컬 대상이 없는 도메인은 숨기거나 버리지 않고 선택 불가와 이유를 표시한다.
대화·원본 프로젝트 파일·Run·산출물·플러그인 바이너리는 금고 문서가 아니다.

application은 실제 브라우저의 theme/locale/sendKey/notify/사용자 단축키를 소유 API로 읽고 적용한다.
예약·프로젝트 자료·callable graph·MCP·라이브러리 상태는 각 서비스 어댑터를 사용한다.
예약은 비활성, MCP는 연결/인증이 활성화되지 않은 정의로 가져온다. 패키지/스킬은 설치된 리소스에 명시적으로 대응시키며 실행·설치·신뢰를 자동 부여하지 않는다.
원본 team의 harness 권한은 이동하지 않는다.

Node crypto의 AES-256-GCM과 고정 scrypt를 사용한다. 암호를 저장하지 않고 S3 연결 정보와 로컬 적용 journal도 암호화한다.
API 키는 기본 제외이며 선택한 API 키만 별도 secrets 값에 포함한다. OAuth는 portable export에서 제외한다.
공급자 로컬 롤백 snapshot은 서버의 암호화 journal에만 존재한다.

소유 서비스의 영속 operation receipt를 적용과 롤백 모두 조회한다.
모델 설정은 모델 파일과 자격 파일을 하나의 트랜잭션으로 가장하지 않는다.
설정 파일에는 동일 원자 교체에 포함되는 내부 operation checkpoint를 쓰고, credential owner는 자격 변경과 receipt를 한 파일 교체로 기록한다.
체크포인트의 자격 관련 fingerprint는 workspace 밖의 임의 키로 HMAC하여 공개 설정 파일에서 비밀값을 추측하는 단서가 되지 않게 한다.
새 프로세스는 각 단계의 receipt와 실제 revision을 확인하고 복구한다. 관련 없는 외부 수정은 덮어쓰지 않는다.
브라우저 설정은 저장소 readback을 서버에 확인하기 전까지 `pending_client_apply`로 남는다.

검증:

- 암호화 왕복, 매번 다른 salt/nonce, 잘못된 암호·변조·버전/KDF 변경 거절.
- 실제 loopback HTTP를 통한 Smithy SigV4, If-Match/If-None-Match, 412 충돌, PUT 이후 GET readback.
- 실제 Corral HTTP API를 통한 provider 설정 export → 변경 → preview → 복원 → config/registry readback.
- 모델 파일 쓰기 뒤 credential commit 전/후 실패를 각각 주입하고 소유 객체를 다시 만들어 partial/complete receipt와 롤백·재요청 결과를 확인.
- journal이 forward/rollback 응답을 기록하기 전에 유실되는 경우 모두 소유 receipt로 복구하며 같은 롤백을 재실행하지 않음.
- 최신 모델/import/vault API·소유자·journal 집중 테스트 17개를 분리 실행해 통과했다. borrowed Codex 로그인은 내보내기·로컬 롤백 자격 상태에서 제외하고 원래 read-only 재사용을 유지하는 반례도 포함한다. 암호화 2개, S3 1개 별도 통과.
- Studio E2E 2개 통과: 암호화 파일 다운로드 → 일반 설정에서 실제 theme 변경 → 파일 선택 → preview → 적용 → persisted browser acknowledgement → 재로드 확인. 잘못된 암호는 변경 전에 거절.
- 최종 UI E2E 대상: `index-xCi07lLw.js`, `index-P0zuN5FL.css`.
- 영어/한국어 키·ICU·한국어 번역 검사 3개 통과.

## 범위와 남은 환경 검증

S3 계정을 제공받지 않았으며 외부 cloud write나 유료 모델 요청을 수행하지 않았다.
S3 서명·조건부 쓰기는 실제 로컬 HTTP에서 검증했지만 사용자의 S3 권한, 버킷 정책 및 호환 서비스별 동작은 해당 계정에서 별도 확인해야 한다.
CLI/설정 파일별 미지원 transport와 문법은 명시적으로 거절하며 성공처럼 표시하지 않는다.
인앱 브라우저의 최종 화면 확인과 전체 저장소/네이티브 앱 검증은 통합 검증 기록에서 별도 추적한다.

구현은 데모 동작·문서 참고를 Corral 소유 경로로 재구성했으며 데모 소스 코드를 복사하지 않았다.
암호화·서명 의존 근거는 Git `4881b6377963:docs/Dependencies-and-Sources.md`의 CR-042 항목에 기록했다.

## Windows 자격 저장 권한 통합 검증

Windows에서 `chmod(0600)`과 `stat.mode`는 DACL을 제한하거나 검증하지 못한다. 실제 임시 디렉터리에 현재 사용자 외 주체의 읽기·쓰기 허용이 상속되는 것을 확인하여, Corral 소유 자격 저장 경로에 운영체제 ACL 보호와 readback을 추가했다. 새 비밀 파일을 만들기 전에 부모를 보호하고, 기존 자체 자격 파일도 읽기 전에 보호한다. 빌린 Codex 파일은 수정하지 않는다.

- 실제 Windows ACL을 읽어 현재 사용자·SYSTEM·Administrators 외 허용 항목이 없는지 확인했다. Everyone 읽기 허용 ACL을 넣은 파일은 비공개로 보고되지 않는다.
- `codex-login`, `models`, `mcp-credentials`, `vault-provider-recovery`, `vault-api`, `model-import-flow`: 최종 55/55 통과. OAuth/API key 비노출·빌린 파일 불변·자격 복구 검증을 유지했다.
- 첫 회차의 PowerShell 다중 경로 처리 실패와 다음 회차의 5초 제한 초과, 수정 후 PASS를 모두 `test-results/desktop-absorption/runtime-tests.log`에 기록했다. 여러 실제 ACL 호출이 필요한 네 Windows 테스트 파일만 20초를 허용한다.
- 서버 TypeScript 및 영어/한국어 검증 3/3 통과. 별도 읽기 전용 소스 검토에서 추가 결함을 찾지 못했다.
- POSIX 0700/0600 검증은 유지되지만 이번 Windows 회차에서 POSIX 런타임은 실행하지 않았다.
