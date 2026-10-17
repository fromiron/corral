# 개인 하네스 H2–H8 로컬 검증

대상은 [구현 플랜](../plans/Personal-Harness-Implementation-Plan.md)의 R1·R2·R3다. H1 뒤 제품 경로를 연결했으며 Coordinator의 소유권·예산·승인·취소가 실행 완료를 결정한다. 이 문서는 이전 체크포인트와 최종 검증을 구별한다.

## 구현 범위

| 단계 | 사용자 기능 | 주요 검증 |
|---|---|---|
| H2 | 역할별 격리된 Pi SDK, 요청별 permit·본문 없는 해시 기록, 지시 전달·취소 | 재시도·압축·필수 hook 오류·늦은 응답·프로세스 종료 |
| H3 | 리소스 검토·설치·hash 신뢰, 불변 작업 방식, 개인/프로젝트/역할/실행 상속, 정적 미리보기·Run 기록·확장 입력 | 원본 Ponytail A/B 격리, 필수 스킬, 실행 override, stale 미리보기 |
| H4 | Pi read/edit/write 계약과 Corral 파일 broker, LSP 읽기 | execution별 읽기 근거, BOM/CRLF/유니코드, 원본 변경·삭제·취소, 실제 Hashline 비교 |
| H5 | 등록 검사, 고정 tree의 별도 복사본, 실행 fingerprint 승인·취소·보고서 | 실제 자식 프로세스·stale 결과·출력 제한·native 실행 신뢰 |
| H6 | Loop 검토 규칙, 기준 파일 보호, 수정·시간·모델·토큰 한도, 중단 이유, 다섯 비교군 평가 | 자동 검사 실패 우선, 기준 고정 경합, 반복/예산 중단, 로컬 SDK 10개 실행 |
| H7 | 기존 위임 도구의 순차 항목 처리, 항목별 입력·Task 표시 | 입력 누출·중첩/동시 실행 거절, 부모 취소·예산 |
| H8 | Pi codemode, MCP stdio/HTTP·OAuth, LSP 불변 변경 제안과 명시 적용 | 실제 Worker 상한·종료/복구, PKCE/refresh/logout, stale/부분 적용/중복/재시작/닫기 경합 |

MCP는 등록 서버 선택과 정확한 허용 도구 이름을 함께 사용한다. codemode는 Pi 공개 callback을 전달하는 버전 고정 최소 patch를 사용하며 별도 실행 엔진을 만들지 않았다. LSP code action의 임의 명령 실행, 파일 생성/삭제/rename resource operation은 지원하지 않는다. 기존 UTF-8 파일의 선언적 text edit만 제안한다.

## 로컬 자동 검증

- `pnpm test --maxWorkers=4`: **960 passed / 5 opt-in skipped** (`8652600`).
- 원본 Ponytail 패키지 역할 격리: `CORRAL_HARNESS_NETWORK=1 ... harness-package.test.ts` **1 passed**. 모델 호출은 로컬 고정 응답이다.
- 브라우저 전체 175개를 Chromium·Firefox·실제 서버에서 실행했다. 초기 검사 문구 실패는 `Completed` 실행 상태와 `Pass` 판정을 각각 확인하도록 고쳐 관련 3개 흐름이 통과했다. 이후 개발 서버 재로딩 간섭은 production 빌드에서 검증했고, 서로 다른 Playwright 실행의 같은 출력 폴더 충돌로 생긴 3개 종료 오류도 별도 출력 폴더로 실행해 모두 통과했다. 테스트 assertion이나 retry 설정을 완화하지 않았다.
- production 사용자 흐름은 **169 passed + 종료 기록 충돌 3개 재검증 passed / 1 skipped**. 개발 모듈 직접 import 테스트와 지시 초안 경계는 별도 **4 passed**. 기존 release gate와 같이 개발 모듈 테스트 2개는 production 대상에서 제외한다. 최종 backend 변경 뒤 하네스 설정·필수 스킬·확장 입력·검사·LSP·MCP OAuth·override·recipe E2E **8 passed**.
- `typecheck`, `lint`, `contracts:check`, `deps:check`, 전체 `build` 통과. lint의 기존 경고와 큰 번들 경고는 오류가 아니다.
- `spec:check`: pack 검증 **1,272 checks**, 시나리오 태그 **169/175**. 모든 시나리오의 실행 증거를 뜻하지 않는다.
- production dependency audit: 알려진 취약점 **0건**.
- desktop runtime staging: 동봉 Node 24.19.0, SQLite, ONNX, Pi SDK worker·JSON 자산 로드 통과.
- Electron smoke: 격리된 앱 데이터, host Node/pnpm 없는 실행, 단일 인스턴스, 대화/초안/테마/경로 복원, 진행 중 종료 선택, renderer·sidecar 장애 복구 통과.
- 로컬 Linux x64 AppImage: `Corral-0.1.0-x86_64.AppImage`, 구현 소스 `8652600`, SHA-256 `8a9c6496938e5263d6c2db9e8ba8879eb5a8fbcc7abc894e8fe002d96d5541d7`. AppImage의 extract-and-run 모드가 대량 경로를 stdout으로 출력해 smoke launcher의 수집 한도를 넘었으므로, archive를 먼저 압축 해제하고 포함된 실행 파일에 같은 smoke를 수행했다. FUSE 마운트 모드 검증을 뜻하지 않는다.

평가의 자세한 조건과 한계는 [다섯 비교군 결과](Personal-Harness-Local-Fixture-Results.md)와 [편집 도구 결과](Harness-Coding-Tools-Results.md)를 따른다.

## 직접 Computer Use

인앱브라우저에서 새 desktop staging의 실제 서버·SQLite·Pi SDK를 사용했다. 사용자 작업 폴더나 계정 대신 별도 임시 Git fixture와 고정 응답 provider를 썼다.

1. 작업 방식 선택 → 정적 도구 3개의 출처·스키마 해시 확인.
2. 역할 모델을 A로 바꾸고 B로 되돌려 저장. 실행 한 번의 작업 방식을 선택해 상속·허용 도구 교집합을 미리 확인.
3. 실제 SDK 경로로 실행 → 성공 → override 선택 초기화 → Run 요청·스냅샷 기록 확인.
4. 별도 세션에서 LSP 이름 변경 요청 → 정확한 질의 1회 승인 → 제안 생성 → 불변 diff 검토 → 파일 1개 명시 적용. 관리 사본은 `renamed`, 원본과 다른 세션 사본은 `value`로 유지됨을 디스크에서도 확인.
5. 사용 중 발견한 Run 기록의 실행 계층 표시 누락을 수정했다. 역할 기본값뿐 아니라 실제 run override와 허용 도구를 표시한다. 완료된 tool-only 응답을 계속 대기 중으로 표시하던 문제도 수정하고 화면에서 재확인했다.
6. 최종 `7bba047`로 다시 만든 desktop staging에서 새 SDK 실행을 시작해 성공까지 확인했다. 앞서 만든 기록도 재시작 뒤 유지됐다.

로컬 화면 증거는 `/tmp/corral-harness-final-cua/`에 있다. 임시 증거의 영구 보관을 전제로 하지 않는다. 자동 MCP OAuth/HTTP·LSP·override E2E와 직접 조작 검증은 별도 증거다.

## 검증 경계

- 실제 유료 LLM의 품질·비용·토큰 개선을 측정하지 않았다. 고정 응답 fixture의 통과를 모델 품질로 해석하면 안 된다.
- Linux x64를 확인했다. Windows의 native 자손 프로세스 정리는 검증 완료가 아니다.
- 신뢰한 native 확장/MCP 서버는 OS sandbox가 아니다. HTTP endpoint fingerprint는 원격 코드의 불변성을 보장하지 않는다.
- 다중 파일 LSP 적용은 파일별 결과를 보존한다. 부분 실패를 전체 성공으로 표시하거나 자동 rollback/replay하지 않는다.
- LSP 변경 제안은 질의 원본과 대상의 실제 bytes가 고정 Git tree의 blob과 일치해야 한다. Git 제외 파일과 clean/EOL 필터 때문에 bytes가 다른 파일은 명시적으로 거절한다. 읽기 전용 질의는 이 제한을 추가하지 않는다.
- MCP spawn 직후 lease 저장 사이의 모든 OS 강제 종료 지점을 주입한 검증은 하지 않았다. 임의 native 코드가 별도 세션을 만들거나 소유 표지를 제거하는 동작까지 sandbox처럼 통제한다고 보장하지 않는다. 소유권이 불명확한 leaderless 그룹은 종료하지 않고 cleanup unconfirmed로 남긴다.

## Pro 검토 반례 수정

모델 선택 메뉴의 Pro(5/5)를 확인하고 브라우저 Oracle 검토를 진행했다. 최종 집중 검토 입력은 `15a933c`의 고정 소스이며 **26분 59초** 뒤 P1 5개를 받았다. Pro의 격리 재현은 Node 22와 일부 대체 의존성을 사용했으므로 Corral 통합 검증으로 간주하지 않았다. 아래 문제를 실제 저장소의 Node 24/Pi 1.3 환경에서 별도 반례로 확인하고 수정했다.

| 경계 | 실패 반례 | 수정 |
|---|---|---|
| LSP 적용 | 비동기 사전 검사 중 닫은 제안이 적용되거나 stale로 덮임 | pending 상태에서만 원자적으로 적용 상태를 선점 (`ed60283`) |
| MCP 복구 | 소유자 종료 중 새로 생긴 자식 registry를 최초 디렉터리 목록이 놓침 | 소유자 종료 확인 뒤 자식 목록을 새로 읽음 (`ed60283`) |
| OAuth 저장 | guard 완료 후 호출자 continuation 전에 로그아웃하면 이전 refresh가 파일을 다시 생성 | 자격 증명 공개·저장 직전 동기 세대 fence (`afe6197`) |
| PID 재사용 | 재사용된 PID의 leader가 zombie면 정체성을 잃고 다른 group을 종료 | zombie의 시작 시각도 확인하고 실행 가능 여부만 별도로 판정 (`7bba047`) |
| LSP 고정 원본 | Git 제외 대상이 질의 중 바뀌어도 이전 edit를 새 내용에 적용한 제안이 생성됨 | 원본·모든 대상의 Git blob과 실제 bytes 일치 확인, 적용 시 재확인 (`7a0132f`) |

앞의 두 반례는 실제 파일/프로세스 테스트, OAuth는 실제 로컬 PKCE/refresh와 microtask interleaving, PID 재사용은 커널 식별 정보를 주입한 테스트로 확인했다. Git 제외된 원본·두 번째 대상, EOL 필터 대상 반례도 모두 거절을 확인했다. 실제 자손 프로세스 복구 테스트도 함께 통과했다.

추가 권고 중 실제로 재현된 이전 logout의 늦은 파일 삭제·새 login 취소와 lease 대기 중 작업 사본 정체성 변경도 `207d9c0`으로 수정했다. leader가 사라진 경우는 새 SDK/MCP의 실행별 소유 표지를 살아 있는 그룹 구성원에서 확인하도록 보강했다(`8652600`). 같은 표지의 자손은 정리되고 다른 표지나 과거 무표지 기록은 다른 그룹을 죽이지 않는다.

소스 검토 원문과 화면은 로컬 Oracle 증거에 보관했다. 최초 hosted PR gate는 `7bba047`에서 [성공](https://github.com/fromiron/corral/actions/runs/39078295200)했다. 마지막 보완과 문서를 포함한 현재 head의 검사·병합 상태는 [PR #55](https://github.com/fromiron/corral/pull/55)에서 확인한다. 이 로컬 보고서는 GitHub 릴리스 게시나 유료 모델 smoke를 뜻하지 않는다.
