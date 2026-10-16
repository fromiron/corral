# CR-009: Run 결과 화면(모든 결과·부분 결과·격리된 HTML 미리보기)

- 변경 ID / 제안자 / 날짜: CR-009 / Bell(제안 `CR-WB-001`), Claude(저장소 적용) / 2026-10-16
- 상태: **승인**(Bell: "출력 패널에서 출력물을 확인하기 힘든 것 … 개선플랜을 작성 후 개선해", 2026-10-16. 로드맵 21번)
- 연결 문서:
  - [Workbench 개선 플랜](../plans/Workbench-Improvement-Plan.md) §3.1.
  - 제안 [01 §6](../proposals/workbench-v0.1/01-Improvement-Spec.md)과 [02 §3](../proposals/workbench-v0.1/02-UX-Spec.md).
  - 스펙 §4.3 Run 화면, §10.2 안전한 표시(C-025).

## 기존 문구

- 스펙 §4.3: Run 화면의 상세 탭 중 Output은 Output 노드의 결과를 안전한 Markdown으로 보인다.
- 구현: Output 노드가 받은 버전 중 첫 번째 하나만 읽는다. 결과가 없으면 "출력 대기"를 보인다.
- 스펙 §10.2: 모델이 만든 HTML은 실행하지 않는다.

## 제안

1. **결과 보기.** Run 화면에 `결과 | 실행` 보기 전환을 둔다.
   - 보기와 고른 버전은 주소의 `view`, `result`에 남는다.
   - 페이지를 열 때 이미 끝난 Run은 결과 보기로, 진행 중이던 Run은 실행 보기로 연다. 보는 중에 끝나도, 사용자가 보기를 골랐거나 실행 보기에서 무언가를 골랐어도 보기를 바꾸지 않는다.
2. **결과 집합(화면 계산).** projection에서 다음을 계산한다. 새 이벤트·저장은 없다.
   - 최종 결과: `output.artifactVersionIds` 전부.
   - 중간 산출물: 나머지 산출물을 같은 artifactId끼리 묶고 최신 버전 먼저.
   - 부분 결과: Run이 `failed`·`cancelled`·`interrupted`로 끝났고 최종 결과가 없을 때, 이미 만든 산출물.
3. **상태 분리.** 다음을 서로 다른 칸으로 보인다.
   - Run 실행 상태.
   - 버전별 검토 판정(없으면 "검토 없음").
   - 제출 여부.
   - "파일 작업 없음 · 검증 명령 없음": 기능이 없음을 뜻한다. 통과·변경 없음으로 적지 않는다.
4. **읽기 화면.**
   - 넓은 본문 칸에 보기 형식(문서·원문·HTML 미리보기)을 둔다.
   - 복사, 내려받기, 이전 버전과 비교, 이 버전에서 새 Run(CR-007)을 둔다.
   - 내려받기는 사용자가 누를 때만 한다.
5. **HTML 미리보기.** HTML 문서(`<!doctype html` 또는 `<html`로 시작)만 미리보기를 제공한다.
   - 로컬 서버: `GET /api/v1/runs/:runId/artifact-versions/:versionId/preview`가 본문을 `text/html`로 준다. 응답 header는 다음과 같다:
     - `content-security-policy: sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`.
     - `x-frame-options: SAMEORIGIN`.
     - 다른 API와 같은 세션 검사.
   - Studio CSP에 `frame-src 'self'`를 더한다.
   - 브라우저 데모: 같은 정책을 `meta`로 앞에 붙인 `srcdoc`을 쓴다.
   - 두 경우 모두 iframe에 빈 `sandbox` 속성을 준다. 스크립트·폼·팝업·같은 origin 권한은 없다.
   - 본문이 HTML 문서가 아니면 이 주소는 404다.
6. **Output 탭.** 아래 칸 Output 탭은 남긴다. 최종 결과가 여럿이면 모두 나열하고 "결과 화면에서 보기"를 둔다.

## 이유

- 결과를 읽는 것이 Run의 목적이다. 그런데 지금은 결과가 화면 아래 작은 칸에 하나만 보인다. 실패한 Run의 산출물은 찾기 어렵다.
- 모델이 HTML 문서를 결과로 내는 일이 실제로 생겼다(PR #34 이후 작업 중 변경 `SafeMarkdown`의 HTML 원문 표시).

## 기존 합의와 충돌

- 결과 판단은 projection의 확정 사실만 쓴다(Coordinator 경로, AGENTS 5).
- raw HTML을 Studio 문서에서 실행하지 않는다는 §10.2는 그대로다. 미리보기는 별도 응답과 sandbox로 격리한다.
- 미리보기 응답은 Studio CSP보다 넓은 `style-src 'unsafe-inline'`을 쓴다. 이 정책은 opaque origin의 sandbox 문서에만 적용된다.

## 테스트

- 단위:
  - `runResults`: 최종 결과 3개 모두; 중간 산출물 묶음·최신 순서; 실패 Run의 부분 결과; 검토 판정 연결.
  - 결과 화면 컴포넌트: 세 결과 전환 시 각 본문 표시; "출력 대기"만 보이지 않음; 상태 칸 분리.
- 서버: 미리보기 header, HTML 아닌 본문 404, 세션 없으면 401, 없는 버전 404.
- E2E:
  - 데모 Run 종료 후 결과 보기, 산출물 전환·원문·실행 보기 왕복 시 선택 유지.
  - HTML 결과 미리보기에서 스크립트가 실행되지 않고 외부 이미지 요청이 없음.

## 일정·영향

새 의존성 없음. react(결과 계산·화면), studio(Run 화면·CSP), server(미리보기 route·header), client(미리보기 주소)가 바뀐다.

## 진행 결과 (2026-10-16)

- 구현: `runResults`(projection에서 계산), `RunResults` 화면, Run 화면 보기 전환, Output 탭 최종 결과 목록, 미리보기 route·header, Markdown 표(`remark-gfm` 4.0.1).
- 테스트:
  - unit: 결과 계산 5, 화면 5, Output 탭 1, Markdown 표 1, 서버 미리보기 2. Output 탭·표·서버 테스트는 변경 전 실패를 확인했다.
  - E2E: 데모 3(결과 3종 탐색·부분 결과·보기 유지), 서버 2(새로고침 유지·HTML 격리).
- 바뀐 기존 테스트: 끝난 Run의 실행 보기를 검사하던 E2E에 "실행" 탭 선택 한 단계를 더했다. 단정은 같다.
- 확인 못 한 것: 실제 모델이 만든 HTML 결과로는 확인하지 않았다.
