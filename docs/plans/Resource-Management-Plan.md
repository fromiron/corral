# 리소스 관리 구현 계획

Oracle Pro(5/5)가 실제 Corral·비교 소스 34개와 현재 설정 화면을 검토한 권고안이다. 기준 main `098dbbc`, 결정 계약은 [CR-022](../change-requests/CR-022-resource-management.md)이다. Oracle 원문은 로컬 검증 자료의 `oracle-plan.txt`에 보존한다.

## 순서와 수용 기준

- [x] 계약·관리 메타데이터·안전한 본문 읽기·사본 편집·보관/복구·중복 방지·원자적 기본값 반영
- [x] 스킬 목록/검색/상세, 작성·파일/폴더/고정 패키지 가져오기, 사용처·작업 방식 선택
- [x] Hook 알림/확인 생성 폼과 원문 편집, 실행 없는 발견, 내용별 신뢰
- [x] 작업 방식 목록·편집·복제·보관, 고정 revision·기본값 적용과 역할 관리 링크
- [x] MCP 목록/편집·비활성·삭제/복구, 정확한 인증 대상, 무모델 연결 시험·도구 선택
- [x] 핵심 회귀와 기존 E2E 두 흐름 보강, production 패키지 UI·실제 Sol/Luna·재시작 검증
- [ ] 로컬 gate/act·커밋·PR exact-head CI·머지·main 동기화

## 확인한 API와 결정

설치된 Pi 1.3 `McpClient.connect/listTools/close`, `StdioTransport`, `StreamableHttpTransport`를 확인했다. 기존 adapter transport·인증·process lease를 재사용한다. Context7은 이 세션에 노출되지 않아 정확한 설치 소스와 타입을 사용한다. 새 의존성은 추가하지 않는다. Native CU가 제공되지 않으면 패키지 서버/Studio의 인앱브라우저 검증과 Electron 실행 smoke를 분리해 보고한다.

## 참고 소스

- [PI Desktop](https://github.com/vastsa/pi-desktop/tree/e219a3e4c0e4cc73ddacde78005987a85d5977d6): skills/MCP 목록·검색·상세·CRUD·범위·연결 관측. LGPL 코드 직접 복제 없음.
- [T3 Code](https://github.com/pingdotgg/t3code/tree/6a6ebb278dc70dd859439a3c28960a7d23a1e645): 설정 범위와 스킬 검색. 독립적인 hook/MCP CRUD 패널은 확인되지 않았다.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317): 설치·선택·runtime 상태 구분. Cordis/HMR 이식 없음.

## 검증 원칙

기존 불변 내용·신뢰·합성 테스트를 유지한다. 경로/크기/중복·CAS/늦은 응답/인증 대상/프로세스 정리를 서비스·adapter에서 검사하고 E2E는 주요 두 관리 흐름에 집중한다. 실계정 호출 한도는 사용자 요청으로 폐지됐지만 제품 Run 예산은 유지한다.

## Oracle 구현 재검토 반영

동일 인앱 대화에서 Pro(5/5)로 구현 diff를 다시 검토했다. 취소/실패한 probe의 재실행과 cleanup 상태 유실, MCP 설정 저장 응답 재시도가 새 probe를 취소하는 문제, 사본 교체 시 skill mode/required 유실, 삭제된 MCP를 프로젝트 기본값에 재연결하는 경쟁, 같은 내용 검토의 취소 소유권 공유, 저장 성공 후 목록 조회 실패 시 중복 저장, 과거 인증의 관리 경로를 지적했다. 각각 경계 테스트로 재현하거나 기존 보완과의 일치를 확인한 뒤 수정했다.

- probe는 성공·실패·취소의 operation 결과를 보존한다. 설정 변경은 receipt/CAS 검증 후 probe 정리와 최종 CAS를 거친다.
- 내용 hash와 검토 operation ID를 분리한다. 사본 교체는 기존 적용 정책을 보존한다.
- 프로젝트 기본값 발행은 현재 도구 설정과 합성 검사를 같은 transaction에서 수행한다.
- UI는 성공한 저장 응답을 먼저 적용한다. 목록 재조회 실패는 별도 재시도로 처리하며 저장을 반복하지 않는다.
- 과거 OAuth/Bearer 연결의 config revision·fingerprint를 표시하고 정확한 인증만 폐기한다. legacy shared credential reference도 binding을 확인한다.
- 교체·보관·MCP 제거 확인은 공통 Dialog를 사용한다. 취소 후 기존 선택과 포커스를 유지한다.

## 검증 증거

초기 완성 후보는 무료 테스트 1,001개 통과·5개 opt-in skip, 로컬 act PR gate와 E2E 83개 통과·1개 opt-in skip을 확인했다. 전체 E2E 수는 84개로 유지했다. Electron 패키지는 호스트 Node/pnpm 없는 실행, 재시작, SQLite 이력, 초안·테마·경로 복원, renderer/sidecar 복구 smoke를 통과했다.

패키지에 포함된 Node/server/Studio를 별도 작업 공간에서 실행하고 인앱브라우저로 작성·등록·신뢰·선택을 조작했다. 첫 실계정 Run `run_2dbac286383d44cdb1c774917d637093`는 두 역할이 각각 SKILL.md 읽기 → 로컬 MCP read_evidence → 결과 작성·제출을 완료했다. wire 메타데이터는 GPT-6.1 Sol/low 4회, GPT-6 Luna/medium 4회를 확인했다. 생성한 session_start Hook과 가져온 tool_result Hook은 두 역할에서 모두 실행됐다. Native Electron 전체 조작과 인앱브라우저의 패키지 UI 조작은 서로 다른 증거다.

최종 공통 확인 창은 기존 리소스 E2E에 취소·포커스 복귀·재확인·보관/복구 검증을 추가해 확인했다. 최종 로컬 act도 테스트 1,001개 및 E2E 83개를 통과했다(각각 5개·1개 opt-in skip). 새로운 E2E 시나리오는 추가하지 않았다.

추가 실계정 Run `run_1eba881f0a084f08a50777390ead7e94`는 최종 패키지 API로 검증했다. 편집한 SKILL.md의 알 수 없는 메타데이터를 보존했고, 두 역할이 읽은 내용과 제출 결과에 `SKILL_COPY_V2`를 확인했다. 생성한 확인 Hook의 요청·응답은 각각 2건이었다. 해제한 알림/결과 Hook의 알림은 0건이었다. 첫 확인 Hook 대기 중 MCP를 비활성화해도 기존 Run은 고정 설정으로 성공했고, 다음 실행 미리보기에는 `mcp_server_disabled`가 나타났다. 현재 역할에서 사용 중인 MCP 삭제는 거절됐으며, 사용을 해제한 뒤 삭제·복구하면 비활성 상태로 돌아왔다. 리소스 보관·복구와 첫 Run snapshot 불변도 확인했다. 실제 모델 호출은 두 Run 합계 16회이며, 모든 요청이 Sol/low 또는 Luna/medium으로 전송됐다.

최종 AppImage SHA-256: `a4aad61527784d4caf6f1c52e0337203a33cd7d87b290a6c036650635217f2dc`. 해당 패키지의 Electron smoke도 다시 통과했다. 원시 증거는 `live-first-evidence.json`, `live-second-evidence.json`, `api-lifecycle-result.json`, `act.log`, `desktop-smoke-final.log`에 기록했다.

검증 경계: 처음 등록·신뢰·연결 시험·역할 선택·실계정 Run은 인앱브라우저에서 직접 조작했다. 사본 저장 이후 브라우저 기본 확인 창 때문에 인앱 입력 도구가 응답하지 않아 후반 생명주기는 패키지 API로 수행했다. 이를 직접 UI 조작으로 주장하지 않는다. 최종 관리 확인 창과 보관/복구 UI는 production Studio E2E로 확인했다. Electron 네이티브 전체 수동 조작은 제공되지 않아 수행하지 못했다. 인증 정보와 실제 사용자 본문은 증거에 포함하지 않는다.
