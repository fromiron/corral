# CR-044 문맥형 설정 UI 구현·검증

- 승인: Bell의 검토된 1–6단계 순차 구현·검증·셀프리뷰·커밋 요청(2026-10-21).
- 계약: [CR-044](../change-requests/CR-044-contextual-settings-ui.md), [Workbench](../current/workbench.md), [위젯](../current/chat-widgets-contract.md), ADR-037.
- 추적: C-140 / CRL-UX-006 / TC-UX-006-H,N.
- 기준: `ab3a103`. 환경: Linux x64, Node 24.19.0, pnpm 10.30.3, Chromium/Firefox, Electron 44.4.5.
- 1–6단계 native 검증 UI 자산: `index-C95TUVIG.js`, SHA-256 `0909b17829947cb8d8c3293004337df9ff47c772490e77d1e9ad1e13bcf92e0a`. Studio dist와 staged Desktop의 자산이 동일하다.
- 외부 모델 호출 없이 기존 격리 서버·SQLite·deterministic adapter/fake provider를 사용했다. 테스트 이름의 live는 로컬 fake transport를 통한 제품 경로이며 실제 공급자 품질 검증이 아니다.

## 적용 단위

| 단계 | 커밋/범위 |
|---|---|
| 1 계약 | `c2db55c`: CR·요구·태스크·시나리오·ADR 등록 |
| 2 공유 콘텐츠 | `6453276`: route wrapper에서 폼 분리, 설정 리소스만 갱신 |
| 3 저장·이탈 | `590f87d`: 공통 미저장 보호, 대상별 pending 잠금·폼 밖 결과·재시도 ID |
| 4 모달 | `0fcc670`: 같은 Outlet, URL/history, 정확한 프로젝트, 포커스·중첩 Escape·단축키 |
| 5 Composer | `5a6ce4c`: 기존 상태 알약, 변경 요약 이동, 다음 요청 모델 표현 |
| 6 보강·검증 | `ba6ae50`: 지연 응답/세션 생성·복귀·비밀 입력 보강. `4bde876`: 느린 모델 상태 조회 직렬화. 마지막 검증 문서 커밋에 native/포커스 검증 보강 포함 |

새 의존성·DB migration·계측 API·Run 구독을 추가하지 않았다. 짧은 상세는 기존 ContextInspector·요약 팝오버를 재사용했다. D&D·Todo·Reins·기존 독립 설정 URL은 유지한다.

## 측정 결과

| 검사 | 결과와 경계 |
|---|---|
| 전체 단위/계약/통합 | 1,583 통과, 기존 opt-in 23 제외. 254 파일 통과·6 제외. 마지막 UI 보강은 아래 실제 UI 회귀로 확인 |
| 위젯·모델 선택 | 관련 단위 27 통과. 상태/컨텍스트/과거 실행/완료 계획 E2E 4 통과 |
| 전체 브라우저 E2E | `ba6ae50`에서 155 통과, 기존 조건부 3 제외(158개). Chromium·Firefox·실제 로컬 서버 경로 |
| 마지막 인증 조회 보강 | 모델/설정 19개 중 18 통과 후 포커스 판정의 비동기 복귀 대기를 보강. 영향받은 키보드·느린 OAuth 2개 재실행 통과. 시나리오를 중복 합산하지 않음 |
| 타입 | 전체 workspace·tools·live 타입 검사 통과. 최종 Studio·Desktop 재검사 통과 |
| 정적 검사 | 변경 파일 Biome 오류 0, 기존 non-null assertion 경고 유지. spec 2,267 검사·299/299 시나리오 태그, contracts:check·deps:check 통과 |
| 화면 | 1280×800 밝은 테마, 390×844 한국어 어두운 테마, reduced-motion, 중첩 Select/Escape, 키보드 진입/순환/복귀. 밝은 화면 axe serious/critical 0 |
| Native Linux | 새 staged runtime에서 DW-07 통과: SQLite 이력·초안/테마/경로·single instance·종료 확인·renderer/sidecar 복구·startup retry·폴더 전환. host Node/pnpm 제거된 PATH |
| Native 확대 | Electron zoomFactor 2, CSS viewport 720×450 / DPR 3. 닫기 접근·가로 넘침·단축키 차단·작업 복귀 통과. 실제 `capturePage` 2160×1350 이미지 확인 |

Native 최초 확대 캡처는 Playwright screenshot이 절반 크기로 잘려 DOM 결과만으로 채택하지 않았다. 확대 후 viewport 안정화를 기다리고 Electron capturePage로 전체 창을 다시 캡처해 확인했다.

## 실패에서 보강한 항목

- 설정 모달·독립 공유 폼·미저장 보호·Composer 알약 테스트의 기존 구현 실패를 확인한 뒤 연결했다.
- 설정 안 Select에서 Escape가 외부 Dialog까지 닫히는 반례를 수정하고 메뉴만 닫기/포커스 복귀를 확인했다.
- A 프로필 저장 중 닫기 → B 저장 응답 유실 → A 완료 → B 재시도에서 명령 ID가 섞이는 실패를 재현했다. 프로필별 receipt로 분리한 뒤 같은 B 명령 ID·revision 2를 확인했다.
- 미저장 기본값 저장 409는 입력을 보존한다. 저장 중 A 프로젝트를 닫고 B를 열어도 B의 기본값·dirty 상태를 바꾸지 않는다.
- 세션 생성 지연 응답이 모달을 닫고 이동하던 경로를 수정했다. 생성 결과와 원래 입력을 보존하고 명시한 새 세션 링크로 접근한다. 일회성 newSession 플래그를 재생하지 않는다.
- 설정 열기를 작업 이탈로 사용하던 기존 취소 테스트는 실제 프로젝트 이동으로 검증하도록 수정했다. 별도 모달 테스트는 Run·질문·구독 유지와 배경 명령 차단을 검증한다.
- 1.9초 인증 조회가 1.5초 주기보다 느리면 모든 응답이 stale 처리되는 실패를 재현했다. 응답 후 다음 poll을 예약해 완료 로그인 표시·동시 요청 최대 1을 확인했다.
- 본문 입력/첨부/커서·그래프 초안, 긴 대화의 anchor+offset, 과거 결과, Ultra pool, 모델·추론·컨텍스트·MCP·Skill·Vault 회귀를 확인했다.
- 포커스 순환 판정은 기존 DW-08과 같이 focus guard의 비동기 복귀를 기다린다. 복귀 대상·검사 범위는 유지한다.
- 첫 전체 실행의 개발 서버 동일 URL 재로드와 이전 설정 경로 기대 실패를 포함해 수정/재검증했다. 완료 판단은 뒤의 전체 155 통과 실행을 사용한다. native fixture는 순서에 의존한 첫 제안 대신 명시한 Single agent를 선택한다.

## 원시 실행 기록과 반복 명령

로컬 로그: `/tmp/corral-ui-all-unit.log`, `/tmp/corral-ui-final-e2e.log`, `/tmp/corral-ui-poll-red.log`, `/tmp/corral-ui-poll-green.log`, `/tmp/corral-ui-final-focused.log`, `/tmp/corral-ui-desktop-smoke-zoom.log`. 화면은 `/tmp/corral-ui-evidence/`와 Desktop release 디렉터리의 생성 PNG다. 개인 데이터·키는 포함하지 않으며 이 임시 파일의 영구 보존을 전제하지 않는다.

```sh
pnpm exec vitest run --maxWorkers=2
pnpm typecheck
pnpm --filter @corral/studio build
pnpm --filter @corral/studio exec playwright test --workers=2
pnpm --filter @corral/studio exec playwright test --project=server server/models.spec.ts server/contextual-settings.spec.ts --workers=2
pnpm --filter @corral/desktop prepare:runtime
pnpm --filter @corral/desktop exec node scripts/smoke.ts
pnpm spec:check
pnpm contracts:check
pnpm deps:check
```

## 미검증과 되돌리기

Windows/macOS 실기는 기존 사용자 결정대로 별도다. 실제 OS IME·스크린리더·모든 provider/host·전체 AppImage 재패키징·서명/업데이트·외부 live 호출은 이번 검증이 아니다. 한국어/일본어 composition 이벤트 시험을 실제 입력기 검증이나 새 일본어 번역 지원으로 주장하지 않는다. `native-smoke.ts`의 패키지 시나리오는 새 모달 계약에 맞췄지만 이번 실행은 `smoke.ts`의 Linux staged runtime이다. 전체 WCAG 준수나 출시 준비 완료를 선언하지 않는다.

롤백은 이번 UI 커밋을 역순 revert한다. 데이터 migration·사용자 리소스 삭제는 필요하지 않다. 완료 계획은 삭제하고 Git 이력으로 보존했다.


## 화면 코멘트 후속 정리

`b655e0c` 이후 사용자 코멘트 1–5·7의 표시 정리와 8의 세로 정렬을 반영했다. 정상 연결 배지, 설정의 공통 적용 설명과 중복 복귀 링크를 제거했다. 모달은 이름·툴팁을 가진 닫기 아이콘을 사용하며, 공통 Dialog는 장식 외곽선 없이 표시하되 고대비 모드의 outline을 유지한다. 실행 상세 패널과 전체 프로젝트의 생성·보관·복원 경로는 유지한다.

- 기존 UI에서 정상 배지·중복 복귀 링크에 대한 두 실패를 먼저 확인했다. 고대비 경계 검사도 실패를 확인하고 실제 outline style을 보강했다.
- 최종 생산용 Studio build에서 설정·모델·UX 회귀 22개 통과. 별도 Workbench·언어 회귀 4개도 통과했다. 일반/좁은 공통 모달의 border 0, 고대비 outline, 키보드·Escape·초점 복귀, 미저장/늦은 저장, 미연결 차단을 확인했다.
- 1280×800 밝은 모델 설정, 390×844 한국어 어두운 설정, 정상 연결 사이드바의 실제 fixture 화면을 확인했다. 실제 사용자 데이터나 외부 공급자는 사용하지 않았다.
- 로컬 PR workflow의 첫 실행에서 기존 native smoke의 마지막 캡처 코드 포맷 오류 1건을 발견해 수정했다. 전역 non-null 경고는 별도 기존 경고다.
- native smoke의 모달 닫기 selector와 단축키 검증 위치를 갱신했다. 이번 후속 스타일의 패키지/실기 재검증은 하지 않았으며 앞의 native 자산 증거와 구분한다.

로그: `/tmp/corral-ui-feedback-red.log`, `/tmp/corral-ui-feedback-final.log`, `/tmp/corral-ui-feedback-models-final.log`. 중간 파일 패널 1건은 실행 중 번역 파일 수정으로 Vite가 리로드되어 발생했고 소스가 안정된 뒤 같은 검사가 통과했다. 최종 회귀의 성공과 중간 실패를 구분한다.
