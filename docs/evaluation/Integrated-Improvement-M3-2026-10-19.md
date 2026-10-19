# M3 진행 증거

## C-107 Linux worker 격리

CR-025/ADR-033 등록 → 실제 namespace/IPC red → host broker 및 worker 연결 → native 경로 거절 red → 구현을 진행했다. model profile의 `workerIsolation: linux-bwrap`은 명시 opt-in이다. 기존 profile/snapshot은 바꾸지 않는다.

bubblewrap는 읽기 전용 애플리케이션 runtime과 선택 콘텐츠만 mount한다. 임시 home과 mount/PID/network/IPC/user namespace를 제공하며 host credential·원본·DB·Git 관리 경로를 전달하지 않는다. 모델 네트워크와 키는 host가 보유하고 Coordinator의 일회성 permit, 모델, 출력 상한, reasoning으로만 호출한다. worker가 지정하는 URL/headers/키/출력 상한은 받지 않고 payload 변경도 거절한다. provider 자동 재시도는 끄고 새 요청은 기존 Coordinator 허가 경로를 사용한다.

지원 범위는 pi-core 및 콘텐츠 전용 strict pi-sdk, 기존 관리 파일 broker다. native 확장·MCP·비격리 host check/LSP recipe는 시작 전에 거절한다. 미지원 OS/격리 시작 실패는 비격리 실행으로 우회하지 않는다. 기존 trusted-native 실행에는 격리가 없다고 계속 표시한다. 이는 worker 경계의 검증이며 모든 provider/브라우저/명령 실행의 OS 지원을 뜻하지 않는다.

| 검증 | 결과 |
|---|---|
| 실제 Linux worker | host sentinel·loopback network·환경 키 차단, 별도 PID namespace, 임시 home 쓰기·전용 IPC, detached 자식 종료와 unrelated server 생존 |
| broker | 키 미전달, 허가된 출력 상한, payload 변조 거절, permit 재사용 거절, 취소와 늦은 응답 |
| 실제 HTTP | core/SDK 격리 2경로에서 이미지·Skill·payload hash·context 추정 및 도구 결과 제출. 로컬 가짜 provider이며 유료 호출 없음 |
| 관련 회귀 | `sandbox-integrated-green.log`: 5개 파일 62개 통과. 취소 추가 후 `model-bridge-cancel.log` 통과 |
| UI | 기존 Models 설정 시험을 확장해 격리 체크 저장·새로고침·재열기 확인 |
| 패키징 | 현재 Linux staging 성공, bundled Node로 패키징된 core/SDK 격리 worker 둘 다 IPC ready 및 종료 확인 |
| 정적 | 전체 타입 통과, 스펙 1,848 검사/237 시나리오 태그, lint 오류 없음 |

Context7 도구가 제공되지 않아 설치된 Pi 1.3.0 타입/구현과 bubblewrap 0.13.1의 로컬 설명을 확인했다. 새 라이브러리 의존성은 없다. 다른 OS, 실제 유료 provider 호출 및 패키징 GUI는 확인하지 않았다. 다음 작업은 C-108 변경 조각의 안전 적용이다.

C-107 전체 회귀: `sandbox-full.log`에서 172개 파일·1,120개 통과, 별도 opt-in 7개 skip. 실제 Linux 격리/HTTP 시험은 위 opt-in 실행으로 따로 확인했다.

## C-108 변경 조각과 대상별 복구

CR-027/030 보완과 추적 등록 후 선택 hunk API 부재를 red로 확인했다. Git의 고정 from/to patch에서 선택한 hash만 적용하고, 원본 반영/사본 되돌리기별 현재 파일 hash와 전체 tree를 확인한다. 임시 index에서 target tree를 만들고 기존 checkpoint restore 원장을 재사용한다. 새 v2 manifest에는 original/working_copy 대상과 hunk 근거를 넣으며 v1의 hash/대상 해석은 유지한다. UI는 patch 선택 → 대상/변경 미리보기 → 명시 승인 적용 순서다.

원본의 사용자 변경·다른 세션·변조 patch·symlink를 거절하고, 다른 파일과 user Git index를 유지하는 통합 시험이 통과했다. 기존 전체 파일 반영/되돌리기도 원본 lease와 복구 전 checkpoint를 사용한다. 활성 실행과 경쟁하는 API는 Coordinator에서 거절하고 UI가 오류를 표시한다. 변경 조각 적용 후 원본 checkpoint 복구, 작업 사본 복구를 실제 브라우저에서 확인했다. 복구 기록은 대상과 from/to를 표시한다.

- `hunks-regression.log`: 파일/REST/번역 기존 포함 81개 통과.
- `hunks-browser-green.log`: 기존 파일/검토/검사 E2E를 확장한 1개 전체 흐름 통과. 처음에는 복구 기록이 여러 개라 테스트의 단일 locator가 모호했으며, 대상 표시와 locator를 맞춘 뒤 통과했다.
- `hunks-full.log`: 172개 파일 1,121개 통과, opt-in 7개 skip.
- 전체 타입 통과, 스펙 1,858 검사/239 시나리오 태그, lint 오류 없음.

바이너리/대형 파일·mode/type 변경·200개 초과 hunk는 부분 적용을 열지 않는다. 외부 도구가 같은 파일을 동시에 쓰는 것을 Corral의 내부 lease가 잠그지는 못하므로 Git의 dirty-file 보호와 적용 직전 hash/tree 검사를 함께 사용한다. 부분/불확실 결과는 자동 반복하지 않는다.

## C-109 보호 컨텍스트와 SDK 압축

Coordinator가 소유 실행의 criteria·계획·질문/답변·Reins·읽은 산출물/입력·리소스를 private 보호 컨텍스트로 제공한다. 두 runtime은 요청 직전에 다시 읽고, 슬롯/허가 대기 중 바뀌면 새 컨텍스트로 준비한다. 공개 기록에는 hash/bytes만 남는다. SDK의 자동 압축 뒤에도 고정 안전 구획, 최신 상태, 원본 요청과 이미지·필수 콘텐츠를 다시 제공한다.

수동 `compact_context`는 execution/attempt/control revision 및 한 요청만 대기하도록 검사한다. 현재 도구/질문을 끊지 않고 유휴 경계에서 Pi의 공개 compact API를 호출한다. 성공한 압축 목적 모델 호출을 확인해야 완료로 기록하며 비용은 기존 예산에 들어간다. 실패 시 이전 JSON 대화가 유지되는지 검사하고 이어간다. 취소 또는 완료 미확인 종료는 성공으로 표시하지 않는다. 외부 압축 hook과 pi-core 수동 압축은 명시 미지원이다.

- 필요한 red: 보호 상태 누락 3건, 명령 미지원, 수동 경계 미구현을 확인한 뒤 구현했다.
- `compaction-focused.log`: 자동·수동 성공/실패/취소, 명령 중복/잘못된 attempt/실제 모델 근거, 기존 SDK/질문/계획/번역 포함 49개 통과.
- `compaction-wire.log`: core/SDK 실제 HTTP, Linux 격리, 질문과 명령 회귀 36개 통과.
- `compaction-browser-green.log`: 기존 SDK startup 질문 시험을 세션 화면으로 확장. 질문 대기 중 압축을 요청해도 질문을 끊지 않고, 답변 뒤 너무 작은 대화의 압축 실패를 표시하면서 원래 작업을 완료한다. 이 과정에서 실제 도구 결과의 undefined 필드를 JSON 전송 형식으로 정규화하지 않아 hash 계산이 실패하는 문제를 발견해 수정했다.
- `compaction-full.log`: 173개 파일 1,125개 통과, opt-in 7개 skip. 스펙 1,866 검사/241 시나리오 태그, lint 오류 없음. 최종 타입 검사의 잘못된 상태 기본값을 queued로 수정했다.

압축 요약은 새 권한·승인·파일 읽기 증거가 아니다. 실제 유료 모델 요약의 품질은 이번 결정적 provider 검증에 포함되지 않는다.

## C-110 실행 체크포인트와 새 Run 이어하기

CR-030 등록 뒤 SQLite 재시작/private export 테스트가 `checkpointContext` 부재와 private body 참조 누락으로 실패한 것을 확인했다. 모델 호출 전 public Pi 1.3.0 transcript, Coordinator 보호 상태, model/criteria/harness hash, source attempt/sequence와 파일 checkpoint를 원자 기록한다. 복구는 단일 agent→output의 core/콘텐츠 전용 strict SDK만 지원하며 원본 terminal Run과 본문을 보존하고 새 실행/권한/남은 예산을 만든다. 원본 Run당 이어가기는 한 번이고 같은 command 재전송은 같은 결과다.

- 사용량/효과 미확정, worker 종료 미확인, 이전 checkpoint 뒤 새 지시/계획/효과, 변경된 tree/resource/model/criteria, 미해결 질문, 지원하지 않는 runtime 상태는 거절한다. 실제 파일 복구나 도구 호출 재생은 하지 않는다.
- 모든 실제 worker의 lease를 사용해 종료를 확인한다. private archive에 본문이 포함되고 public archive/events에는 본문을 넣지 않는다. 4 MiB/항목·64 MiB/Run 제한은 capacity 기록으로 남긴다.
- 화면→API→새 Run 흐름의 실패를 통해 `SqliteRunStore.getRun`의 session ID 누락을 확인·수정했다. Run 선택 변경 시 세션 목록도 갱신한다. 파일이 있는 다중 turn 회귀에서 기존 `UNIQUE(run_id,kind)`가 runtime checkpoint를 막는 실패를 확인하고 0017 migration으로 시작/종료 경계만 고유하게 유지한다. 기존 manifest와 ref는 보존한다.
- `runtime-fixed-regressions.log`: SQLite restart/무결성/중복/남은 예산/세션, 파일 tree·불확실 상태, 기존 auto baseline, 실제 SDK harness comparison, schema 회귀 55개 통과. `runtime-wire.log`: 실제 HTTP core/SDK 요청에 이전 transcript 전달, 과거 write 미재생, fresh output 11개 통과. `runtime-browser3.log`: 페이지 재열람→새 Run 복구→성공→원본 보존 1개 통과.
- 단계 전체 회귀는 다음 M3 변경까지 합쳐 다시 실행한다. 첫 전체 실행의 5개 실패는 schema 미생성과 위 세션/복수 checkpoint 원인으로 분류했고 관련 재실행은 통과했다. 유료 모델과 packaged GUI는 검사하지 않았다.

## C-111 세션 검색·작업 탭·메시지 분기

CR-032 등록 후 없는 검색/branch API에 대한 실패와 요청 시작 분기 schema 실패를 확인했다. SQLite FTS5 trigram v1을 재사용하는 private index는 기본 metadata 검색과 명시 본문 검색을 구분한다. NFKC·한국어/일본어/경로/식별자, 짧은 부분 문자열, 보관/삭제·rebuild를 확인했다. 본문은 인증 POST에만 응답하고 provider credential/OS 파일은 색인하지 않는다.

세션 탭은 기존 URL·초안·스크롤 저장소를 사용한다. 브라우저 Cmd/Ctrl+숫자는 가로채지 않고 Electron에서만 탭 선택에 쓴다. 검색은 안정적인 message ID와 가상 목록 scroll API로 해당 요청을 연다. 1,000개 메시지 fixture에서 검색→탭 전환→같은 메시지 위치 복귀를 확인했다.

결과 분기는 source sequence 이전의 소유 checkpoint와 그 지점까지의 질문/답/계획/응답/산출물만 복사한다. 이후 메시지·출력은 제외한다. 파일은 source current tree 대신 검증된 checkpoint ref에서 별도 세션 작업 사본을 만들며 그 tree를 새 baseline으로 고정한다. 원본을 보존하고 지점 사이 파일 효과가 있으면 context-only 선택이 필요하다. 요청 메시지는 원래 Run 시작의 정의·팀·기준/이미지와 before_run 파일 checkpoint에서 새 Run을 만든다. 모델/하네스 고정 hash와 현재 정책을 다시 검증하고 새 예산/모델/파일 범위를 시작 전에 표시한다. 오래되거나 명시 context-only 분기는 파일/runtime 복구와 구분한다. command 재전송, 새 session/Run lineage, 원본·형제 이동을 연결했다.

- `continuity-focused.log`: private 검색, 분기 지점 뒤 정보 배제/private archive, 별도 파일 사본/기준/중복 검증 통과.
- `continuity-browser2.log`: 긴 대화 검색/탭과 실제 화면→복구→결과 분기→원 요청 분기 2개 통과. deterministic provider 사용.
- `continuity-full.log`: **1,129 passed, 7 skipped / 176 passed files, 4 skipped files**. C-110에서 발견한 SQLite/session·복수 checkpoint 회귀도 포함해 모두 통과.
- `continuity-types4.log`: 전체 workspace + tools/live TypeScript 통과. `continuity-spec.log`: 1,882 pack checks / 245 scenario tags 통과. lint 오류 수정 후 경고는 기존 범위에 남아 있다.
- packaged GUI 및 Electron 숫자 단축키의 실제 키 입력은 이 단계에서 검사하지 않았다. browser MCP는 승인된 로컬 fixture의 trusted-native 범위이며 OS 격리나 외부 계정 지원으로 확대 주장하지 않는다.


## C-112 웹 추출·불변 출처와 M3 마무리

CR-035와 C-112/TC-WEB-001-H/N 등록 뒤 HTML을 거절하는 기존 경로를 red로 확인했다. 등록 HTTPS source에만 HTML 수집을 열고 기존 DNS/IP 고정, redirect, MIME·UTF-8, 1 MiB, timeout/취소 검사를 유지한다. parse5 Worker가 article/main/body에서 비실행 텍스트를 추출하며 숨김·폼·스크립트·탐색 영역은 제외한다. 자료의 지시 문구는 신뢰하지 않는 본문으로 남으며 권한이나 시스템 지침으로 적용하지 않는다.

0020 migration의 불변 web_source_evidence에 원문과 출처 metadata를 보존한다. source/최종 URL, 수집 시각, 원문/추출본 hash, extractor 버전, 페이지 선언 발행/수정 시각과 Last-Modified를 기록한다. 같은 URL의 다음 수집은 새 document ID이며 이전 ID의 재열람 결과는 동일하다. 원문과 추출본 모두 기존 workspace 32 MiB 용량 상한에 포함한다. 인증 source API는 no-store/nosniff JSON만 제공한다.

- `web-extraction-red.log` → `web-regression.log`: 필요한 실패 확인 뒤 입력·HTTPS·인증 API·legacy migration 기존 포함 49개 통과. 한 테스트에 Unicode, 주입 문구/스크립트 비실행, 원문 불변성, 취소 후 재사용, 파서 노드 상한을 묶었다.
- `web-browser.log`: 기존 실제 Chromium MCP 로컬 fixture 2개 통과. 관찰·assertion·외부 origin/redirect 거절·취소·소유 프로세스 정리이며 외부 로그인/게시나 OS browser 격리는 아니다.
- `web-types.log`: 전체 workspace와 tools/live 타입 통과. `m3-spec.log`: 1,890 checks / 247 scenario tags. 생성 schema·의존성 호환성 통과, `web-audit.log` production advisory 0건.
- `m3-build.log`, `m3-stage.log`: production Studio 빌드와 Linux runtime staging 통과. `m3-packaged-web.log`: 동봉 Node에서 컴파일된 실제 추출 Worker 정상 실행 확인.
- `m3-full.log`: 전체 회귀 1,130개 통과, opt-in 7개 제외. 176개 파일 통과/4개 opt-in 파일 제외. 최신 소스의 기존 auto·Reins·D&D·migration·worker·budget 회귀 포함.

M3의 완료는 위 기능·지원 경계에 한정한다. 복구는 단일 agent 및 콘텐츠 전용 strict SDK부터 지원하며, 실제 유료 모델 품질·외부 로그인 브라우저·다른 OS·packaged GUI 전체 조작은 확인하지 않았다. M4와 최종 release gate는 남아 있다.

M3 전체 lint에서 고정 upstream design JSON의 포맷 차이를 발견했다. 원문 47개를 재작성하지 않고 해당 vendor 디렉터리만 Biome 대상에서 제외했다. 내장팩 hash/참조/신뢰 테스트는 유지하며 관리 코드의 lint는 재실행했다.
