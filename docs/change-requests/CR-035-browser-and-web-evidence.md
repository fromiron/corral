# CR-035: 브라우저와 웹 근거 수집

- 상태: **순차 구현 승인** — Bell, 2026-10-19: “플랜대로 M0부터 순서대로 개선 진행해. CR 등록 → 실패 테스트 → 구현 순서로 하고, 기존 기능 회귀도 확인해.”
- 계획: 통합 개선 실행 계획 (Git `373764467a52:docs/plans/Corral-Improvement-Execution-Plan-2026-10-19.md`), M2-4, M3-6.
- 기준: `780591e`(PR #60 수정 포함). 구현/검증 완료 여부는 단계별 증거로 따로 기록한다.
- 추적: M2/M3에서 MCP·safe HTTP·프로세스 lease 시험을 확장.

## 계약

1. 첫 backend는 기존 pi-mcp를 통한 Playwright MCP다. Run/execution/attempt·session·origin·profile·출력 경로·timeout/capacity·실제 종료를 소유한다.
2. 개인 프로필·임의 evaluate/run-code·전역 kill·임의 업로드·설치 명령을 기본 허용하지 않는다. 등록 launch recipe와 local fixture부터 시작하며 strict를 자동 해제하지 않는다.
3. 관찰→readiness assertion→행동→결과 assertion→불변 근거 저장을 따른다. networkidle/sleep이나 screenshot만으로 행동 성공을 선언하지 않는다.
4. search/read_document·sourceId/documentId를 재사용한다. URL/redirect/DNS/IP/MIME/용량 검증, 원문/추출본·수집 시점·extractor version·비용 정산을 유지한다. 외부 쓰기는 대상/내용에 결합한 별도 승인 경계가 필요하다.

## 검증과 배포

새 동작과 데이터·권한·취소 경계의 대표 반례만 구현 전에 실패를 확인한다. 기존 통합 시험을 우선 확장하며 문구·내부 함수·모든 조합을 따라가는 시험은 추가하지 않는다. 적용되는 정상·실패·취소·중복·늦은 이벤트 경계는 기존 시험과 합쳐 확인한다. D&D·Reins·과거 snapshot/hash·[CR-042](CR-042-desktop-capabilities.md) ABS-06으로 확장된 host admission·작업 사본별 단일 writer 제한을 유지한다. live/OS/브라우저 증거는 결정적 fixture와 구별한다.


## C-104 로컬 fixture 단계

기존 stdio MCP 등록에 선택 browser recipe를 추가한다. argv는 검토한 dev server 명령이며 브라우저 backend는 호스트의 고정 Playwright MCP다. origin은 명시 127.0.0.1 포트 하나이고 HTTP 준비 응답을 확인한다. 실행 소유 임시 HOME/프로필/출력과 기존 process lease를 재사용한다. 안전한 관찰/행동/assertion 도구만 허용하고 임의 코드, 업로드/다운로드, 새 profile, 확장/개인 브라우저 연결, 설치·네트워크 재설정 도구를 차단한다.

이 단계는 신뢰한 로컬 fixture 검증이다. Playwright의 origin 옵션은 OS 보안 경계가 아니고 redirect도 격리하지 않는다. 생성된 page 초기화에서 HTTP/WS origin·다운로드를 제한하지만 외부 승인 환경과 제품 OS sandbox 보장은 M3에서 별도로 검증한다. 기존 strict 및 review_only의 native 시작 거절을 자동 해제하지 않는다.

## C-112 버전 있는 웹 본문 추출과 수집 근거

- 등록 source의 HTTPS 읽기에만 HTML을 추가한다. URL·DNS/IP 고정·redirect·MIME/UTF-8·1 MiB·timeout/취소 경계를 그대로 적용한다. 직접 document import와 검색 provider JSON 수신의 MIME 허용 범위는 넓히지 않는다.
- 이미 설치된 `parse5@8.0.1`(MIT, TypeScript 포함)을 서버 직접 의존성으로 고정한다. 표준 HTML 파서를 사용하고 script/style/template/navigation/form·숨김 내용은 본문에서 제외한다. article/main을 우선하되 일반 body 텍스트를 안전하게 추출한다. DOM 실행·하위 리소스 요청은 하지 않는다. 추출 결과 자체는 신뢰되지 않은 근거 자료다.
- 원문과 추출본을 별도 불변 기록으로 보존한다. source/최종 URL, 수집 시각, 원문/본문 hash, extractor 버전, 있으면 발행/수정 metadata와 HTTP Last-Modified를 저장한다. 같은 URL의 다음 수집은 이전 document를 덮지 않는다. 본문·출처의 선택 조회는 인증 API로 제공하고 원문 HTML을 실행하지 않는다.
- 승인된 로컬 browser fixture의 기존 Playwright MCP 관찰/assertion/취소/소유 프로세스 검증을 함께 재실행한다. 이 변경은 외부 로그인 계정·게시/구매·원격 서비스의 쓰기 권한이나 native browser의 OS 격리를 열지 않는다.
