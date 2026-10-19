# CR-026: Worker 프롬프트와 작업 범위

- 상태: **순차 구현 승인** — Bell, 2026-10-19: “플랜대로 M0부터 순서대로 개선 진행해. CR 등록 → 실패 테스트 → 구현 순서로 하고, 기존 기능 회귀도 확인해.”
- 계획: [통합 개선 실행 계획](../plans/Corral-Improvement-Execution-Plan-2026-10-19.md), M1-4, M3-3.
- 기준: `780591e`(PR #60 수정 포함). 구현/검증 완료 여부는 단계별 증거로 따로 기록한다.
- 추적: M1 착수 때 필요한 요구·테스트만 등록한다.

## 계약

1. systemPrompt와 ModelRequestRecord를 확장해 identity·operating_rules·tools_policy·safety·project_context·mandatory_skills·assignment·output_contract를 결정적으로 조립한다. 역할·출처·hash·포함 이유·추정 context를 기록한다.
2. TaskBrief는 RunInput/assignment/criteria/snapshot 참조의 투영이다. review_only/허용 수정·targeted/release·대상 tree·선택팩·예산을 구별한다. 별도 실행 엔진을 만들지 않는다.
3. 실제 등록 descriptor에 있는 도구만 안내한다. ask_user/update_plan의 동작 경로가 먼저 구현돼야 해당 행동 규칙을 넣는다. 필수 규칙을 조용히 잘라 넣지 않는다.
4. 승인한 프로젝트 규약만 snapshot에 포함하며 자동 AGENTS 탐색을 켜지 않는다. 공통 계약은 두 runtime에서 검증하고 Skill 지원 때문에 runtime을 조용히 교체하지 않는다.

## 검증과 배포

새 동작과 데이터·권한·취소 경계의 대표 반례만 구현 전에 실패를 확인한다. 기존 통합 시험을 우선 확장하며 문구·내부 함수·모든 조합을 따라가는 시험은 추가하지 않는다. 적용되는 정상·실패·취소·중복·늦은 이벤트 경계는 기존 시험과 합쳐 확인한다. D&D·Reins·과거 snapshot/hash·전역 활성 Run 제한을 유지한다. live/OS/브라우저 증거는 결정적 fixture와 구별한다.


## C-096 적용 계약

공통 프롬프트는 역할·운영·권한·안전·프로젝트 자료 경계·스킬·assignment·출력 계약으로 결정적으로 조립한다. 기존 지침·출력 JSON 계약을 유지하며 필수 내용을 잘라내지 않는다. 기존 ModelRequestRecord의 구획에 버전·포함 이유를 붙이고 pi-core도 같은 기록을 전달한다. 추가 API 호출은 없다. 프로젝트 규약은 사용자가 바인딩한 불변 리소스/명시 입력만 사용하며 자동 파일 탐색은 하지 않는다.

## C-099 TaskBrief와 검토 전용 범위

RunInput의 optional taskScope=review_only와 verificationScope=targeted|release를 사용한다. 기본은 기존 작업 범위/targeted다. review_only는 관리 파일 쓰기 권한을 실행 snapshot에서 제거하고 native extension/MCP/codemode 시작을 거절한다. 기존 등록 검사와 출력 artifact 작성은 유지한다. 검토 범위는 OS 격리를 뜻하지 않는다. TaskBrief는 이 snapshot의 입력 hash·criteria·assignment·실효 파일 권한·한도·resource refs를 조합한 worker 입력이며 별도 상태 원장이 아니다. 확인되지 않은 target tree를 만들어 넣지 않는다.
