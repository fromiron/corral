# Corral 전체 UI 구조 개선

승인 근거: Bell의 `ui 개선 구현해`, 2026-10-18. [CR-023](../change-requests/CR-023-ui-structure.md), ADR-030. 기준 main `a9e1a83`.

Oracle Pro는 상단 선택기의 문맥별 축소, 설정 사이드바 교체, 간단한 실행 관찰과 전체 상세 분리, 리소스 관리와 사용 설정 분리를 권고했다. Sidebar+ChatView와 Corral의 팀 그래프·역할별 설정·Reins는 유지한다.

## 전체 구현 범위

- [x] 상단 경로: 실제 route/객체 소속, 전체 프로젝트/공통 설정 문맥, 닫힌 사이드바/좁은 화면 이동 메뉴.
- [x] 설정 프레임: 하나의 내비게이션, 앱/에이전트/프로젝트 그룹, 실행/승인 알림 수명 보존.
- [x] 설정 대상과 복귀: 명시 프로젝트, 같은 범주에서 대상 변경, 최초 작업으로 복귀, 세션 초안/선택/패널 유지.
- [x] 실행 패널: 상태/역할/사용량/대기 요약, Reins 직접 접근, 같은 대상의 넓은 상세, 과거 Run 선택 보존.
- [x] 첫 요청: 새 세션에서 한 번 작성, 기존 목적/초안 보존, 화면 전환 자동 전송 없음.
- [x] 팀 편집: 설계/실행 준비/운영 구분, D&D/역할 모델·추론/직접 실행/미저장 보호 유지.
- [x] 스킬·Hook·MCP: 라이브러리 관리와 작업 방식 연결 분리, MCP 프로젝트 범위, 고정 버전·신뢰·상속 유지.
- [x] 용어·검색·밀도·좁은 화면·키보드·IME·데스크톱 상단 동작 정리.

## 순서와 영향 범위

1. CR/ADR/추적과 중요한 실패 사례를 먼저 기록한다. 기존 E2E를 확장해 현재 실패를 확인한다.
2. RootLayout, Sidebar, SettingsLayout, router와 설정 링크/범위 관련 호출부를 함께 바꾼다. 알림 데이터 조회는 프레임 수명으로 유지한다.
3. SessionPage/RunPage의 요약과 상세를 분리한다. Workbench 패널·Reins·URL 선택은 재사용한다.
4. WorkspacePage의 시작 경로, EditorPage의 설계와 실행 영역을 정리한다. 기존 작성 내용/팀 버전을 보존한다.
5. ResourceSettingsPage/McpSettingsPage/HarnessSettingsPage와 역할 관리 링크를 정리한다. 서버 계약은 유지한다.
6. 번역·접근성·반응형과 관련 기존 테스트를 맞춘다. 설치된 컴포넌트와 의존성을 사용한다.

## 완료 증거

| 수용 기준 | 필요한 증거 | 상태 |
|---|---|---|
| 실제 대상과 상단 위치 일치 | 단일/다중 프로젝트, 전체 목록, 공통 설정, 직접 URL | 통과 — 프로젝트/설정/직접 URL E2E, 실제 팀·세션·실행 경로 확인 |
| 설정 진입/복귀 | 범주 이동 후 초안·Run/파일·패널 보존, 알림 유지 | 통과 — 지연 저장·초안·선택 복원 E2E, 실계정 실행 중 설정 왕복 |
| 첫 요청 한 곳 | 빈 새 세션→요청→실행, 기존 목적 보존/자동 실행 없음 | 통과 — 빈 세션·기존 초안·생성 중 변경·복귀 재생성 방지 E2E |
| 요약·상세·Reins 연결 | 같은 Run/execution/artifact, 늦은 결과에도 선택 보존 | 통과 — exact selection/승인 E2E, 패키지 런타임에서 검토 역할 제어→상세→뒤로가기 |
| 고급 팀 기능 | D&D·연결·모델/추론·작업 방식·저장·직접 실행 | 통과 — Chromium/Firefox D&D·연결·undo·직접 실행, 실계정 역할 모델/추론 변경 |
| 리소스 소유 범위 | 공용 관리/프로젝트 서버/작업 방식/고정 역할 버전 구별 | 통과 — 기존 harness-resources/harness-mcp/reasoning-scope 및 잘못된 대상·고정 버전 E2E |
| URL·검색·뒤로가기 | 기존 deep link, 복귀와 브라우저 이력, 검색 범위 | 통과 — navigation 단위 시험·palette/desktop-workbench E2E·실제 복귀 |
| 실제 패키지 사용성 | 좁은/넓은 화면, 키보드/focus/IME, 제목 표시줄 | 통과 — 패키지 런타임 IAB 1280/480px, 키보드·IME E2E, 실제 AppImage Electron smoke |

코드 검사·테스트·빌드와 실제 패키지 조작은 별도 증거로 기록한다. 기존 PR 수명 완료 요청에 따라 검증된 변경을 커밋/PR/머지하고 최종 main 상태를 확인한다. 모든 항목이 증명되기 전에는 완료로 표시하지 않는다.

## 작업 기록

- 2026-10-18: main과 origin/main `a9e1a83` 일치, 깨끗한 체크아웃 확인. `ui-workbench-structure` 브랜치에서 착수. 신규 의존성 계획 없음.
- 설정 E2E를 먼저 확장해 기존 작업 사이드바가 남는 실패(기대 0, 실제 1)를 확인했다. 프레임 구독 유지·설정 사이드바 교체·범주 이동 후 초안 복귀 구현 뒤 해당 흐름 통과. 복귀 URL 경계 단위 시험 2개와 Studio 타입 검사 통과.
- 기존 세션 E2E에 간단한 실행 패널→Reins→같은 execution의 전체 상세→복귀를 추가했다. 기존 중첩 Results 탭이 남는 실패(기대 0, 실제 1)를 확인한 뒤 compact 패널을 구현했다. 첫 재실행에서 이 구간은 통과했고 패널 닫기 선택자 중복을 고쳤다. 전체 재검증은 진행 중이다.
- Context7 MCP는 현재 도구 목록에 없어 TanStack 공식 문서와 설치된 router-core의 `href` 타입을 대조했다. Router/React 등의 버전·의존성은 바꾸지 않았다.

- 팀 편집기의 설계/실행 시험 패널, 설정 왕복 시 미저장 그래프/undo/저장 기준 revision 보존을 구현했다. 기존 D&D→연결→실행과 저장/레이아웃 회귀 흐름을 Chromium/Firefox에서 통과했다. 캐시의 소유자 격리와 dirty/clean 외부 revision 처리 단위 시험 2개도 통과했다.
- 다중 프로젝트의 작업 방식 초안을 유지하며 대상만 변경하고 선택한 프로젝트 기본값에만 저장하는 흐름, 잘못된 MCP 프로젝트 URL에서 저장을 차단하고 대상을 고르는 흐름을 확인했다. 라이브러리와 작업 방식 연결·신뢰·교체·보관/복구의 기존 주요 시나리오를 확장했다.
- 자동 새 세션이 캐시된 팀 목록으로 시작하던 회귀와 데모 실행의 소속 표시를 실패 시험으로 확인해 수정했다. 설정 사이드바 닫기/열기와 세션 화면 axe 검사도 기존 왕복 시나리오에 추가해 통과했다.
- 전체 타입 검사, 단위·컴포넌트 1,005개 통과(5개 기존 skip), spec 1,341 검사, contracts/deps 검사 통과. 첫 전체 E2E 이후 실패 사례를 원인별로 수정하고 해당 흐름을 재검증 중이다. E2E 개수는 늘리지 않았다.
- 포장 작업과 Vite 개발 E2E를 동시에 실행하면서 서비스 모듈 HMR로 2개 시험이 중단됐다. trace에서 재연결과 Provider 오류를 확인했고, 고정 production build로 같은 시험을 재실행해 통과했다. 실제 배포 런타임 오류로 분류하지 않았다.
- compact 결과 표시에서 기존 ResultReader를 재사용해 문서/HTML 미리보기·비교·다운로드·후속 실행을 유지했다. 승인 대상의 정확한 결과 표시, HTML sandbox, 세션 follow-up/IME 흐름이 production build에서 통과했다.
- 패키지된 Electron 바이너리의 기존 smoke workflow 통과: titlebar overlay/최대화, single instance, SQLite/초안/테마/route 복원, 종료 확인, sidecar/renderer 실패 복구, 작업 공간 재열기. AppImage extract-and-run 검사는 추출 로그가 시험 harness의 stdout 한도를 넘겨 중단되어 동일 패키지의 linux-unpacked 바이너리로 검증했다. FUSE 실행 자체의 완료 증거와 구분한다.
- 17:51 Oracle의 같은 인앱 Pro 세션에 구현 diff+핵심 소스 20개를 첨부해 2차 검토 요청. 별도 실제 계정 시험 공간에서 패키지 런타임을 열어 Sol/Luna UI 검증 진행 중.

- Oracle 구현 검토에서 제시한 4건을 재현해 수정했다. (1) 생성 중 제목·목적·팀과 외부 템플릿 변경을 차단하고 제출한 초안만 초기화, (2) 결과/artifact의 view별 선택과 Reins의 실행 view 이동 정규화, (3) 저장 중 상태·baseline·오류를 working copy의 Zustand store 하나로 공유하고 오래된 loader snapshot이 새 baseline/undo를 되돌리지 않도록 처리, (4) 설정 복귀 URL에서 newSession/draft 일회성 플래그 제거. 기존 통합 시험에 응답 지연·설정 왕복·Undo·정확한 결과/제어 선택을 넣어 실패 후 4개 모두 통과했다.
- 실계정 UI 시험에서 같은 세션의 2개 실행이 완료됐다. 첫 실행 Sol low→Luna medium, 두 번째 실행 Luna low→Sol high를 역할 UI에서 변경·저장했으며 실제 전송 8회의 model/reasoning payload가 선택과 일치했다. 두 실행의 최종 상태와 저장된 결과를 UI에서 확인했다. 시뮬레이션은 이 시험 런타임에서 거절하도록 설정했다.
- AppImage의 일반 FUSE 실행으로 데스크톱 smoke 전체가 통과했다. 따라서 앞서 extract-and-run의 출력 버퍼 한계는 AppImage 실행 불가를 뜻하지 않는다. Oracle 수정이 포함된 최종 패키지와 gate는 별도로 재검증 중이다.

## 최종 검증 (2026-10-18)

- 마지막 실사용에서 요청 직후 설정으로 이동하면 전송된 초안이 남는 오류를 발견했다. 제출 시 초안 revision을 기록하고 성공 시 같은 revision만 소비해, 설정에서 완료되거나 새 Composer가 열린 경우에도 처리한다. 이후 작성한 다른 초안은 지우지 않는다. 기존 ux-review E2E에 두 경우를 넣어 red→green 확인했고 실계정 네 번째 실행에서도 입력창이 비워짐을 확인했다.
- 최종 변경의 로컬 PR gate (`act`, `.github/workflows/pr.yml`, Node 24.19.0/pnpm 10.30.3) 전체 성공: spec/contracts/dependencies, lint, typecheck, 단위·컴포넌트 1,005 통과/5 기존 skip, production build, E2E 83 통과/1 기존 성능 측정 opt-in skip. E2E 케이스 수는 늘리지 않았다. lint 오류는 없으며 저장소 경고는 210개다.
- 최종 AppImage의 `prepare:runtime`→`package`→일반 FUSE 실행 smoke를 순차 완료했다. 실제 Electron의 titlebar, single instance, SQLite·초안·테마·route 복원, 종료/시작 실패와 sidecar/renderer 복구가 모두 통과했다.
- 최종 패키지에 포함된 서버·Studio를 인앱브라우저에서 직접 조작했다. 같은 세션의 4개 다단계 작업이 모두 성공했다. Sol low→Luna medium, Luna low→Sol high, Sol medium→Luna low 두 번을 검증했다. 실제 OAuth 요청 총 16회에서 선택한 모델과 provider reasoning payload가 일치했다. 시뮬레이션 adapter는 이 시험에서 오류를 반환하도록 하여 실제 호출과 구분했다.
- 4번째 실행 `run_1bb092b79304428b8ee268a80c42416a`: 설정 왕복 후 빈 입력창, 검토 역할 Reins, 같은 execution의 전체 상세, 브라우저 뒤로가기, 480px 작업 패널 접근을 확인했다. 개인 작업 공간은 사용하지 않았다.
- 임시 증거: `/tmp/corral-ui-structure-review-20261018/`의 `act-delivery.log`, `act-delivery-result.json`, `package-delivery.log`, `package-delivery-result.json`, `live/wire.jsonl`, `live/executions.jsonl`, `delivery-complete.jpg`. 임시 폴더의 보존은 보장하지 않는다.
- 증거 경계: 직접 컴퓨터 사용은 패키지된 서버/Studio의 인앱브라우저에서, 네이티브 창 동작은 기존 Electron smoke에서 검증했다. Windows/macOS 패키지는 실행하지 않았다. 이번 UI 변경에서는 자동 추론 판정기 및 외부 skill/hook/MCP의 실서비스 호출을 다시 수행하지 않았고 기존 결정적 회귀 시험을 통과했다.
