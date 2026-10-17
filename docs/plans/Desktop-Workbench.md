# 데스크톱 Workbench 구현 추적

근거: [CR-014](../change-requests/CR-014-desktop-workbench.md). 기능·화면·설치 결과가 모두 확인되기 전에는 완료하지 않는다.

| 단계 | 완료 조건 | 상태 / 증거 |
|---|---|---|
| 1 | T3 원본 고지, UI 이식 경계·공통 컨트롤·테마 | 완료 — 고정 버전·라이선스·고지 및 deps/inventory 검증 |
| 2 | Sidebar와 ChatView를 실제 Corral 세션·Run에 연결 | 완료 — 실제 저장소 연결, 500세션 성능 검증 |
| 3 | 에이전트 활동·승인·Reins·대기·팀·실행 상세 | 완료 — 전체 브라우저 회귀 157개 통과, 종료한 24개 Run 조회 시 SSE/명령 없음 |
| 4 | 파일 탐색·참조·탭·diff·검토·설정·나머지 화면 | 완료 — 파일 읽기·참조·키보드 탭, 고정 tree 검토, 4가지 너비 접근성 검증 |
| 5 | Electron·동봉 Node·native module·worker·AppImage | 완료 — 개발 실행과 최종 AppImage 각각 전체 lifecycle 통과 |
| 6 | 브라우저/설치 앱 검증·접근성·성능·전체 회귀 | 완료 — 단위 653개/브라우저 157개/production demo 42개, AppImage, 로컬 Actions 전체 통과 |

## 검증 기록

- 착수 상태: `main da3799c`, 작업 트리 clean. 이 구현 전의 검증은 새 UI의 증거가 아니다.
- 참고 소스는 `/tmp/corral-reference-t3code`, `/tmp/corral-reference-pi-desktop`에서 읽었고 commit은 CR-014에 고정했다.
- Context7 MCP는 이 세션에 없다. 사용한 정확한 패키지 버전의 타입·배포 문서와 공식 문서를 확인한다.
- DW-01–03: 전역 shell/명시 theme, 스크롤과 고정 composer, draft 복원, 기존 follow-up/queue/IME 및 한국어 locale 흐름 7 Chromium E2E 통과.
- DW-05: 경로 이탈·symlink·binary·1 MiB 초과·사라진 scope·사용자 읽기와 agent 권한 분리 테스트 포함 file broker 7개 통과. demo 파일 읽기·줄 참조·`@` 선택·파일 탭 복원 E2E 통과. 세션 패널 선택 복원 반례를 추가하여 red 확인 후 수정/green 확인.
- DW-06: Pierre 공개 API + parser/highlighter worker + 가상화. 줄 범위/쪽/인용 단위 테스트 통과. 실제 서버에서 의견 → 후속 실행 → 승인 → 원본에 반영 → 사용자 수정 보호가 있는 되돌리기 E2E 통과. CSP CSS 예외는 CR-014에 기록.
- DW-07: Node 24.19.0/SQLite native module/Pi entry/ONNX runtime가 배포 사본에서 해석되는 self-check 통과. 데스크톱 개발 실행과 309 MiB AppImage 각각에서 모의 실행·SQLite 기록·route/draft/theme 복원·종료 smoke 통과. AppImage는 Node/pnpm만 제거한 PATH에서 검증했다(기본 Linux shell/coreutils는 필요).
- 패키징 중 pnpm의 manifest hardlink 수정 반례를 발견해 원본을 복구했다. 이후 파일 교체 방식과 원본 manifest byte 비교 self-check로 재발을 방지했다.
- DW-08: 1440×900, 1280×800, 1024×768, 390×844에서 대화·팀 설계·설정의 가로 넘침 없음, serious/critical axe 없음. 모바일 사이드바의 Tab containment·Escape 복원, 파일 탭 화살표 이동, 기존 키보드/IME/reduced-motion 흐름 통과.
- DW-09: 500세션·301파일·20회 표본에서 전환 p95 135 ms (최대 147 ms), diff p95 467 ms (최대 483 ms). 사이드바 크기 변경 long task 0, 측정 화면 4곳 serious/critical axe 0. 최초 측정 실패 후 전체 프로젝트 재조회/500개 메뉴 렌더링과 diff API 사용을 수정하여 통과했다.
- 전체 타입 검사, 단위·계약·Storybook 653개 통과/2개 기존 opt-in skip, Chromium·Firefox·실제 서버 E2E 157개 통과/1개 별도 성능 측정 skip. spec 1,014개 검사 및 테스트 태그 126/126, release test 11개, dependency check, 826 package version inventory 통과.
- 개발 desktop lifecycle: 중복 실행 때 최대화 유지, 종료 취소/승인, 중단 기록 유지, 실제 sidecar/renderer 프로세스 종료 후 복구, 접근 불가 workspace의 재시도와 기존 workspace 다시 열기 통과. 테스트 데이터만 사용하며 host Node/pnpm을 PATH에서 제거했다.
- 실제 LLM 호출, ONNX 모델 추론, 사람 5명 사용성 평가는 이 변경의 자동 검증에 포함하지 않는다. ONNX 증거는 native module 로딩까지다.

## 설치 파일

- `apps/desktop/release/Corral-0.1.0-x86_64.AppImage` — 323,179,255 bytes.
- SHA-256: `99e74382a7deec87ea886f8c74996073a643d6bb1e6c4164dc0fc67d4de0c8cd`.
- 최종 AppImage에서 DW-07 전체 lifecycle을 재실행해 통과했다. Node/pnpm이 없는 PATH, sandbox 켜짐, 실제 renderer/sidecar 종료, 새 workspace와 기존 workspace 모두 포함한다.
- Production 정적 빌드의 별도 Chromium/Firefox demo·캔버스·Reins·IME·접근성 E2E 42개 통과.
- 로컬 Actions 최초 실행에서 기존 CLI 정상 실행 테스트가 5초 한도를 초과했다. assertion과 timeout은 변경하지 않고, 다른 검증과 CPU를 분리해 전체 workflow를 재실행했고 통과했다. 같은 CLI 테스트는 686 ms에 끝났고 전체 653개와 브라우저 157개가 통과했다. assertion과 timeout 변경, retry 설정은 없다.

## 의존성 판단

- T3의 MIT UI 코드는 고정 commit과 원본 고지를 보존한다. PI의 LGPL 코드는 복사하지 않았다.
- Base UI 1.4.1, lucide-react 0.564.0, clsx 2.1.1, tailwind-merge 3.4.0, class-variance-authority 0.7.1은 T3 UI의 기존 의존성 범위이다. 모든 직접 버전을 고정했다.
- Pierre 1.5.2(Apache-2.0)는 diff 계산·구문 강조·줄 선택·가상화를 맡으며, React 19 호환 타입과 공개 API를 사용한다. 별도 chunk/worker로 지연 로딩한다.
- Electron 44.4.5(MIT), electron-builder 26.15.6(MIT): Linux x64 배포 도구이다. Node 24.19.0을 따로 동봉해 기존 SQLite와 Pi/ONNX worker의 Node ABI를 유지한다.
- npm audit: moderate 1건(`sprintf-js <=1.1.3`, GHSA-hp3w-g68c-fv3c), 수정 버전 없음. `electron-builder → @electron/get → global-agent → roarr` 빌드 도구 경로이며 설치 앱의 renderer/server runtime dependency에는 포함하지 않는다. 이 한계는 최종 전달에서 숨기지 않는다.

## 완료 감사

DW-01–09의 자동 검증을 완료했다. 실제 native screenshot은 `apps/desktop/release/desktop-smoke.png`에 남겼다. T3 참고 화면과 비교해 전역 Sidebar/상단 헤더/중앙 대화/하단 composer/우측 작업 패널 구조를 확인했다. 위에 적은 live model·ONNX inference·사람 사용성 평가의 경계는 남는다. AppImage는 로컬 산출물이며 GitHub Release 게시나 자동 업데이트를 뜻하지 않는다.
