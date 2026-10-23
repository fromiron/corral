# CR-047 검토·비교 화면 개선

- 범위: C-172 / CRL-UX-008 / TC-WBUI-003-H,N.
- 기준: `e26039972e1c8ce20eb17dbccbd1c6d014ce7ebd` 위 `fix/review-comparison-layout` 변경. 아래 검증은 커밋 전 작업 트리에서 실행했다.
- 기준 커밋 대비 UI 소스 diff SHA-256: `55d345d017f11afae58e4f2df4d983ebd340296dc1f73dacec71f776a8701205` (`git diff e260399 -- apps/studio/src packages/react/src/components/RunComparison.tsx packages/react/src/messages`).
- 환경: Linux, Node 24.19.0, Studio production build, 격리된 임시 Git/SQLite 서버와 인앱 Chromium. 모델 응답은 결정적 fixture이며 외부 유료 호출은 없다.

## 구현

1. Review는 창 전체가 아닌 workbench 가용 폭으로 재배치한다. 중간 폭에서 파일 목록과 diff를 나란히 두고 검토 도구를 아래에 둔다. 넓은 폭에서는 3열, 좁은 폭에서는 세로 배치한다. 패널을 재마운트하지 않는다.
2. 실행 비교 표는 같은 폭의 열, 수치 우측/tabular 정렬, 긴 ID의 키보드 disclosure를 사용한다. 본문 제목을 남기고 앱 상단 중복 제목만 제거한다.
3. 후보 창의 제목/안내와 반영·취소·receipt·오류를 본문 스크롤과 분리한다. 짧은 diff는 콘텐츠 높이에 맞추고 긴 diff는 기존 최대 높이 안에서 스크롤한다. 원문 SourceCode 높이는 바꾸지 않는다.
4. 후보 카드는 제목·상태·두 사용량 수치·검사를 같은 순서에 놓고 실패/미확정 설명을 하단에 보존한다. 긴 모델명은 줄바꿈해 전체 값을 숨기지 않는다. 기존 토큰·공용 컨트롤·폰트를 사용하며 의존성을 추가하지 않았다.

## 실패 재현과 핵심 회귀

| 확인 | 결과 |
|---|---|
| 수정 전 Review 1024px 중앙 폭 | 192px로 최소 400px 회귀 실패 |
| 수정 전 후보 창 1280×720 | 반영 버튼 아래 949px > 창 아래 684px로 노출 실패 |
| 수정 전 실행 비교 수치 | 우측 정렬 회귀에서 실제 left로 실패 |
| CandidateComparison·Review 판단/첨부 단위 3파일 | 6 PASS. 정확한 비교/후보/tree, 중복·receipt 회복, 실패 근거와 첨부 대상 보존 |
| 기존 run-compare E2E 확장 | 1 PASS. 두 실행 생성/선택, 출력 diff, 390px 표 폭, 숫자 정렬, 제목 한 개, Enter 전체 ID |
| 기존 server/files E2E 확장 | 새 폭·390px overflow·의견 초안 보존 및 기존 검사/승인/반영/복구 단계 통과. 마지막 콘솔 오류 검사에서 FAIL, 아래 참조 |
| Studio 타입·production build | PASS. 기존 큰 chunk/비효과적 dynamic import 경고는 유지 |
| 변경 파일 Biome·diff 검사, 문서/추적 검사 | PASS. spec:check 2874 checks |

server/files의 마지막 `corral.errors=[]`는 사본 생성 전 `/worktree/development`, `/worktree/deployments`의 404 두 건 때문에 실패했다. 새 레이아웃 assertion을 제거한 HEAD의 기존 테스트도 같은 현재 빌드에서 동일 실패했다. 이 작업은 해당 요청 경로를 수정하지 않았고, 오류 검사를 완화하거나 전체 E2E PASS로 기록하지 않았다. 사본 없는 초기 조회의 별도 수정이 남는다.

## 실제 화면

- CSS viewport 1024px에서 중앙 약 565px, 검토 도구는 아래. 1600px에서는 `224 / 800 / 320px` 3열이고 페이지 가로 넘침은 0이다.
- 후보 창 1280×720에서 반영 버튼 아래 664px < 창 아래 684px. 짧은 diff viewer는 96px이며 390px에서도 반영 버튼이 창 안에 있다.
- 181줄의 긴 diff는 최대 높이 안에서 마지막 줄까지 스크롤/가상 렌더된다.
- 후보 하나를 실제 UI로 반영한 뒤 선택 완료 상태와 사본의 Candidate 1 내용, 연결된 원본의 기존 내용을 확인했다.
- 390px 한국어 실행 비교에서 두 값 열·항목명이 보이고 가로 넘침은 0이다. 숫자 우측/tabular, 제목 한 개, 키보드로 전체 ID 공개를 확인했다.
- 로컬 캡처: `corral-layout-candidates-after.png`, `corral-layout-compare-390-after.png`. 캡처와 로그는 임시 실행 자료이며 저장소 영구 테스트 증거로 의존하지 않는다.

전체 OS·설치판·실제 스크린리더·유료 공급자·전체 출시 검증은 반복하지 않았다. 현재 화면과 핵심 동작을 확인한 것이며 모든 환경 통과를 뜻하지 않는다.
