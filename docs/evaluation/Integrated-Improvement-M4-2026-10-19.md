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
