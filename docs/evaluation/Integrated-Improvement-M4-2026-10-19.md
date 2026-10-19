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

## C-118 준비: 복수 제공자 추론·요청 경계

사용자가 복수 회사 LLM의 최대 추론 협업을 명확히 하여 CR-031·ADR-035·C-118을 등록했다. [Oracle 재검토](../spikes/Ultra-Multi-Provider-Oracle-2026-10-19.md)는 실제 미푸시 소스와 전체 Ultra diff를 첨부해 완료했다. C-113은 과거 단일 모델 프리셋으로 보존하고 C-118을 우선한다.

- 설치된 Pi 1.3.0의 OpenAI 설정 메시지와 DeepSeek 추론 형식·출력 한도를 실제 serializer로 검증한다. 잘못된 effort·모델·출력 한도 필드는 전송 전에 거절한다.
- core/SDK/격리 host bridge 모두 한 permit에서 승인된 모델·주소·본문의 HTTP 요청을 한 번만 허용한다. Pi 재시도를 끄고 SSE fetch 경계에서 재전송·redirect·취소 후 전송을 차단한다.
- 필요한 red: `ultra-providers-red.log`, `ultra-dispatch-red.log`, `ultra-provider-field-red.log`. 정상 OpenAI 설정 메시지의 오거절, 승인 없는 전송, 다른 cap 필드 수용을 각각 재현했다.
- 전체 회귀 `ultra-provider-full.log`: 179개 파일·1,136개 통과, opt-in 9개 제외. Linux bubblewrap 실제 core/SDK worker → host permit → 로컬 HTTP → 도구 결과 왕복과 기존 process 회귀는 `ultra-provider-http.log` 16개 통과했다.
- 전체 타입, spec 1,926 checks / 253 tags, lint 오류 없음, desktop runtime 준비 통과. 새 의존성 없음.

**구현 경계:** 이는 C-118의 provider 기반 작업이다. 새 복수 모델 pool·역할 배정·필수 교차 검토·동적 마무리 예산·UI는 아직 미구현이며 C-118은 `planned`다. 실제 유료 API 호출, 최신 packaged GUI, hosted CI/배포는 실행하지 않았다. Codex Responses처럼 출력 cap을 받지 않는 transport를 실제 청구량 hard cap으로 보장하지 않는다.

### Hive DeepSeek 연결 보완

`dd52a62`의 provider 기반 작업 다음에 Bell이 지정한 Hive를 추가했다. Pi 1.3.0의 공개 `Model.thinkingLevelMap`/compat 타입과 OMP `9d5d4ac5`의 `models-config-schema-bundle.ts`에서 제공자별 effort·cap 호환 패턴을 확인했다. 기존 endpoint 등록·Models 설정·origin-bound credential을 사용하며 플러그인/라이브러리는 추가하지 않는다. Context7 도구가 없어 설치된 정확한 버전의 선언/직렬화 구현과 Hive 공식 문서를 확인했다.

- `hive-red.log`: 모델 ID만 등록하면 추론 단계가 비어 있는 실패를 확인했다.
- 공식 CDN/VA1 주소·정확한 모델 ID에 한해 공개 context/image/effort 기본값과 Pi 호환 설정을 적용한다. 명시 설정·알 수 없는 gateway·다른 모델의 기존 기본값을 보존한다.
- 필요한 합성 시험 한 개에서 config → server registry → 실제 Pi serializer → 가짜 fetch/SSE 사용량을 확인했다. `none/low/high/max`와 provider default, cap/effort 변조 거절, 다른 origin 및 명시 한도를 함께 검증한다.
- `hive-regression.log`: 기존 모델 인증/설정·core config·adapter endpoint/reasoning/process 포함 7개 파일, 46개 통과·OS opt-in 2개 제외. 전체 타입 검사, spec 1,928 checks / 253 tags, 변경 파일 Biome·diff 검사 통과.
- [연결 안내](../Models.md#hive의-deepseek-v41-flash)에 추가할 주소·모델·프로필과 키 입력 위치를 기록했다. 사용자 설정·credential은 변경하지 않았다. Hive 유료 호출·실제 모델 도구 호출·최신 패키지 GUI는 미검증이다.

## C-118 협업·예산·UI 단계와 실제 Hive 확인

사용자가 저장한 Hive 키로 실제 연결 확인을 요청했다. 별도 opt-in live 시험은 최대 3회/요청당 출력 4,096 한도 중 2회만 사용했다. `run_165a318f5d28440f9d80311d5d9813f4`에서 공식 CDN의 `deepseek-ai/deepseek-v4.1-flash-1017`, 요청/실제 wire `high`, write_artifact→submit_result와 usage를 확인했다. 입력 2,940/출력 219, 미확정 예약 0이다. 이 시험은 사용자 세션과 분리한 메모리 Run이며 사용자 본문을 보내지 않았다. 증거의 source hash는 `b92a5e846e4640c0a81f5bc34e9705cc5c8bdafd93a08075457df670e31c9cd5`로, 이후 Ultra 변경 전체의 live 증거로 간주하지 않는다. 모델 신원 프롬프트와 live 시험은 `0801f2b`에 커밋했다.

협업 단계는 `ultra-team-red.log`, `ultra-team-runtime-red.log`, `ultra-team-budget-red.log`에서 별도 모델 검토·종합·마무리 예산 부재의 실패를 확인한 뒤 구현했다.

- `ultra.version: 1`의 2~5개 모델 pool, 주 모델 planner/writer/synthesizer와 다른 모델 reviewer를 고정한다. 서로 다른 회사도 사용하며 같은 모델 ID의 별칭은 거절한다. helper는 읽기 전용 산출물 도구만 갖고 재위임하지 않는다. 기존 Coordinator의 spawn/await/permit/settlement를 재사용한다.
- 최대 지원 추론을 모델별 metadata로 고정하고 미연결·미검증·명시 수동 effort 충돌은 호출 전에 거절한다. 선택 위임은 활성 2/전체 4, 전역 모델 요청 3, 수정 2회다. 미래 필수 단계의 최소 2회 capped 호출을 같은 예산에서 보호하고 80% draining을 유지한다. 취소/unknown 정산은 기존 원장을 사용한다.
- UI/초안/세션 기록/재시도 identity/API/CLI에 선택을 연결했다. 브라우저 설정 왕복과 다시 열기에서도 선택을 보존하며 일반 모드의 추론 강도는 바꾸지 않는다. 실제 개발 화면에서 OpenAI Sol 주 모델 + Hive DeepSeek 검토자 선택과 일반 설정 복원을 확인했다. 실제 Ultra 요청을 추가로 보내지는 않았다.
- OpenAI OAuth의 Pi 1.3.0 출력 cap 생략을 API 키 경로와 혼동하는 회귀를 `ultra-oauth-cap-red.log`에서 실제 serializer로 재현했다. 고정 auth/provider/API/baseURL이 공식 OAuth인 경우만 허용하며 API 키·다른 endpoint의 cap 누락은 계속 거절한다. core/SDK worker에 비밀이 아닌 인증 방식만 전달한다. 실제 OpenAI 계정 재호출은 하지 않았다.

| 검증 | 결과 |
|---|---|
| 전체 회귀 | `ultra-final-full.log`: 181개 파일·1,146개 통과, opt-in 9개 제외 |
| 브라우저 | `ultra-multi-browser.log`: 자동 세션 기존 경계와 새 Ultra, 14개 통과 |
| 실제 Linux worker/로컬 HTTP | `ultra-final-isolation.log`: core/SDK 격리 worker와 HTTP/프로세스 회귀 17개 통과; 실제 서비스 호출 아님 |
| 타입·계약·추적 | `ultra-final-types.log` 전체 타입 통과, `ultra-final-spec.log` 1,929 checks / 253 tags, schema 재생성 |
| 빌드 | `ultra-final-build.log` Studio production 빌드 통과; 기존 큰 chunk 경고 유지 |

**남은 범위:** C-118의 격리 프로젝트 검사/고정 tree 연동과 provider conformance 확대는 계속 진행한다. 현재 모델 검토는 실제 코드 검사 통과를 뜻하지 않는다. 실제 복수 제공자 Ultra 전체 호출·품질/비용 비교·최신 packaged GUI·hosted CI/배포는 미검증이다. C-114 후보 비교/승격도 아직 완료하지 않았다. 새 의존성은 없다.

## C-119 / C-120: 컴포저 조작과 프로필 컨텍스트

Bell의 첨부 제안과 “프로필 컨텍스트 설정과 런타임 구현까지 모두 포함” 승인을 CR-037/038과 ADR-036으로 기록했다. C-118의 아직 남은 범위를 완료로 바꾸지 않는다.

- 첨부·템플릿을 `@` 옆 명령 메뉴로 옮기고 입력 요소를 메뉴 밖에 유지했다. 모델·추론 라디오 그룹을 분리했으며 저장 완료 전 추가 변경/전송을 막는다. 지원하지 않는 요청값은 보존해 표시하고 새 요청만 차단한다. 질문 등 다른 의도에서는 첨부를 payload에서 제외하고 초안에 남긴다. 첨부가 있는 초안의 제출 revision 비교에서 JSON 키 순서 때문에 지우지 못하던 오류도 수정했다.
- 모델 편집에 선택적인 C/R/K 입력과 유효값·출처·임계점·경고를 추가했다. 빈 칸/0을 구별하고 숫자·관계·credential 필터·원본 revision을 검증한다. endpoint 편집 행 원본 metadata를 보존해 ID 변경 시 한도가 사라지지 않는다.
- 자동 chooser 전 모델별 정책을 준비해 Run에 고정하고 AgentStartInput→버전 IPC→core/SDK에 전달한다. SDK 원본/proxy 모델 복사와 SettingsManager를 사용한다. 기존 SDK retry/cache 설정, permit 최종 요약 cap, 자동·수동 압축/취소 경로를 유지한다. core는 C만 적용하며 압축 미지원이 표시된다. 지원 재개는 기존 정책과 과거 부재를 유지하며 모델 바인딩 변경은 계속 거절한다.

| 검증 | 결과 |
|---|---|
| 필요한 실패 | `composer-controls-red.log`, `profile-context-config-red.log`, `profile-context-server-red.log`, `profile-context-freeze-red.log`, `profile-context-worker-red.log`, `profile-context-ui-red.log` |
| 핵심/회귀 | `context-final-focused.log` 85개 통과: 숫자·출처·동시 저장·chooser 이전 고정·후속 역할·재개·SDK/Pi core·R=0 cap·기존 Reins |
| 브라우저 | `context-browser.log` 29개 통과: 모델/키/자동 세션 회귀, 메뉴·저장 잠금·비지원 선택·모바일 키보드, 프로필 preview/저장/재열람·0·동시 설정 충돌·endpoint metadata |
| 실제 Linux worker / 로컬 HTTP | `context-isolation.log` 63개 통과: 격리 IPC·네트워크/자격 증명 경계·프로세스·SDK 압축 회귀. 외부 유료 호출 없음 |
| 정적 검사 | 전체 타입, spec 1,952 checks / 257 tags, 생성 schema, lint 오류 없음. 후속 변경 영향 타입 재검사 |
| 전체 suite 1차 | 1,153개 통과·2개 실패·9개 opt-in 제외. 기존 Reins 명시 모델 교체와 한국어 기술 용어 실패는 수정하고 관련 85개를 재검사했다. 최종 전체 suite는 PR `act` gate로 검증 |
| 개발 화면 | 최신 production Studio + 재시작 서버에서 실제 Hive 유효 C=1,000,000 / R=16,384 / K=20,000, 출처·임계점·SDK 범위 표시 확인. 사용자 설정은 저장하지 않음 |

새 의존성은 없다. 이 변경의 유료 모델 호출·모델 품질 비교·패키지 설치 GUI 검증은 하지 않았다. 압축 알고리즘은 Pi 그대로이며 공급자의 실제 한도를 늘리지 않는다.

PR gate 1차(`f676e74`): clean clone의 `act`에서 spec/계약/lint/타입·1,155 tests·build 통과, E2E는 106 통과·1 opt-in 제외·1 실패였다. trace에서 첫 요청의 저장 응답 전 **disabled** 파일 input에 테스트가 직접 `setInputFiles`를 호출한 것을 확인했다. 실제 UI가 첨부를 다시 허용할 때까지 기다리고 첨부 완료도 확인하도록 해당 시험의 전제조건을 보완했다. 이어서 메뉴가 렌더/닫힘을 완료하기 전에 전송을 누르던 타이밍도 가시 상태로 기다리도록 보완했다. 첨부 보존 단언은 유지했으며 `context-question-readiness-final.log`에서 동일 시험 5회 연속 통과했다.
