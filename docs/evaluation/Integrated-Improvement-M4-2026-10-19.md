# M4 진행 증거

## C-113 명시 Ultra 기본 프리셋

M0~M3 누적 변경은 `09fe207`에 커밋했다. CR-031, C-113, CRL-ULTRA-001, TC-ULTRA-001-H/N을 등록하고 프리셋 미기록·검토 누락과 CLI flag 미지원의 실제 실패를 확인한 뒤 구현했다.

- 기존 자동 팀·review recipe를 재사용한다. `qualityPreset`은 mode와 독립이며 기본 경로/정의는 그대로다. Ultra만 고정 planner→writer→read-only reviewer, 최초 실행+최대 두 번 수정이다. criteria hash·반복 실패·취소·예산/시도 상한을 기존 Coordinator가 처리한다.
- 기존 모델·명시 reasoning·기본 예산·정책을 올리지 않는다. router 호출은 필요 없어 생략하며 route reasoning은 기존 local 기본을 기록한다. custom 팀/role override를 바꿔 Ultra라고 주장하면 시작 전에 거절한다.
- 선택은 AutoRoute 시작 snapshot/event, 세션 요청, 재시도 identity, 초안/설정 복귀·다시 편집에 보존한다. Composer 토글과 `/ultra`, `corral exec auto --ultra`는 동일 starter/Coordinator 경로다. headless auto는 파일 도구 없는 콘텐츠 범위이며 사용자 팀 파일은 변환하지 않는다.

| 검사 | 결과 |
|---|---|
| 필요한 red | `ultra-red.log` 2개, `ultra-cli-red.log` 1개 실패 확인 |
| 핵심 및 기존 회귀 | `ultra-focused.log` 36개, CLI/서버 자동 시작까지 `ultra-cli-green.log` 52개 통과 |
| 동일 과제 비교 | 같은 요청/기준/모델 low/DEFAULT_LIMITS에서 default 1회, Ultra 최대 두 번 수정 뒤 7회 모델 호출. mock/live mode 모두 주입된 결정적 adapter로 검증했으며 실제 모델 품질 비교가 아님 |
| 실패 경계 | 세 번째 수정 전 attempt_limit 실패, 사용자 승인으로 상한 자동 연장 없음. 변조된 built-in/role override와 다른 preset의 command 재사용 거절 |
| 실제 화면 | `ultra-browser2.log` 기존 auto 13개+새 프리셋 1개 통과. `/ultra` 추가 후 `ultra-slash-browser.log`에서 설정 왕복→실행→재열람 재확인 |
| 전체 회귀 | `ultra-full.log`: 177개 파일·1,133개 통과, opt-in 7개 제외 |
| 정적/빌드 | `ultra-types3.log` 전체 타입 통과. `ultra-spec.log` 1,899 checks / 249 tags. schema 재생성, lint 오류 없음, production Studio build 통과 |

새 의존성은 없다. 일반/실계정 모델의 실제 품질·금액·지연 개선은 측정하지 않았다. 후보 비교/80% 예약은 다음 C-114이며 이 단일 후보 단계의 완료로 포함하지 않는다. 최신 packaged GUI와 hosted CI/배포도 미실행이다.

## C-114 준비: upstream 비교와 예산 경계

사용자가 지정한 Oracle 인앱 세션에서 구조 설명을 검토받고 ADR-034에 반영했다. 이 검토는 미푸시 소스의 직접 리뷰가 아니다. 이어 Bell의 요청으로 [공개 하네스 비교](../spikes/Ultra-Upstream-Harness-Review-2026-10-19.md)를 수행했다. Pi 1.3.0 예제, OMP, pi-subagents, 공개 Codex, DeepSeek Harness 소스의 버전을 고정해 읽었고 Claude Code는 공식 문서의 동작을 확인했다. 플러그인 일괄 배제는 하지 않는다.

`candidateAllowance`는 기존 Run 예산의 spent/reserved/unknown을 이용하는 작은 admission 계산이다. 새 비용 원장은 없다. 마지막 두 번의 capped 호출을 보호하고, 신규 후보/수정의 80% 기준에는 보호분과 신규 요청 상한도 포함한다. `candidates-hold-red.log`에서 예약분 누락으로 실패한 뒤 `candidates-hold-green.log`에서 통과했다.

- `ultra-upstream-regression.log`: 후보 예산, 기존 Ultra, 공유 예산, 병렬 협업, Coordinator, Reins·취소 경계 8개 파일 / 59개 통과.
- `ultra-upstream-types.log`: core 타입 검사 통과.
- `ultra-upstream-spec.log`: 1,914 checks / 251 tagged scenarios 통과. 처음에는 Python 환경을 빠뜨려 validator가 실행되지 않았고, 기존 `CORRAL_PYTHON` 환경으로 다시 실행했다.
- 변경한 TS 파일 Biome 및 `git diff --check` 통과.

**구현 경계:** helper는 아직 Coordinator permit 경로에 연결하지 않았다. 다중 후보 실행/파일 scope/검사/선택/승격과 draining latch는 후속 구현 대상이며 C-114는 `planned`다. 위 결과는 후보 비교 전체의 통과 증거가 아니다. 외부 플러그인을 설치하거나 실제 모델 호출을 하지 않았다.
