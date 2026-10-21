# CR-026: Worker 프롬프트와 작업 범위

- 상태: **순차 구현 승인** — Bell, 2026-10-19: “플랜대로 M0부터 순서대로 개선 진행해. CR 등록 → 실패 테스트 → 구현 순서로 하고, 기존 기능 회귀도 확인해.”
- 계획: 통합 개선 실행 계획 (Git `373764467a52:docs/plans/Corral-Improvement-Execution-Plan-2026-10-19.md`), M1-4, M3-3.
- 기준: `780591e`(PR #60 수정 포함). 구현/검증 완료 여부는 단계별 증거로 따로 기록한다.
- 추적: M1 착수 때 필요한 요구·테스트만 등록한다.

## 계약

2026-10-19 모델 식별 보완: 역할명과 별도로 현재 실행에 고정된 provider/model ID를 identity section v2에 전달한다. 이는 Corral이 설정한 요청 대상이며 공급자의 내부 구현을 독립 검증한 정보가 아님을 함께 명시한다. API 키·주소·로컬 경로·다른 모델의 원시 대화는 넣지 않는다. core/SDK의 공통 prompt builder를 사용하고 과거 기록을 다시 쓰지 않는다.

검증: `model-identity-red.log`에서 identity 누락을 확인한 뒤 `model-identity-green.log`의 공통 prompt/SDK 회귀 48개를 통과했다. live 전용 `hive-endpoint.live.test.ts`는 `CORRAL_HIVE_LIVE=1`에서만 실행하며 최대 3요청·회당 4,096출력·150초 Run 제한을 사용한다. 2026-10-19 실제 실행은 Hive `/api/v3`의 지정 모델에 high로 2요청, 입력 합계 2,940·출력 합계 219토큰(보고된 추론 42는 출력에 포함), 미정산 0으로 성공했다. write_artifact→submit_result와 설정 모델 ID/확인 문자열을 검증했다. 대상 source hash는 `b92a5e846e4640c0a81f5bc34e9705cc5c8bdafd93a08075457df670e31c9cd5`이며 `test-results/live/hive-endpoint.json`에 비밀 없는 증거를 기록했다. 이후 Ultra 변경 전체의 live 증거로 전용하지 않는다.

1. systemPrompt와 ModelRequestRecord를 확장해 identity·operating_rules·tools_policy·safety·project_context·mandatory_skills·assignment·output_contract를 결정적으로 조립한다. 역할·출처·hash·포함 이유·추정 context를 기록한다.
2. TaskBrief는 RunInput/assignment/criteria/snapshot 참조의 투영이다. review_only/허용 수정·targeted/release·대상 tree·선택팩·예산을 구별한다. 별도 실행 엔진을 만들지 않는다.
3. 실제 등록 descriptor에 있는 도구만 안내한다. ask_user/update_plan의 동작 경로가 먼저 구현돼야 해당 행동 규칙을 넣는다. 필수 규칙을 조용히 잘라 넣지 않는다.
4. 승인한 프로젝트 규약만 snapshot에 포함하며 자동 AGENTS 탐색을 켜지 않는다. 공통 계약은 두 runtime에서 검증하고 Skill 지원 때문에 runtime을 조용히 교체하지 않는다.

## 검증과 배포

새 동작과 데이터·권한·취소 경계의 대표 반례만 구현 전에 실패를 확인한다. 기존 통합 시험을 우선 확장하며 문구·내부 함수·모든 조합을 따라가는 시험은 추가하지 않는다. 적용되는 정상·실패·취소·중복·늦은 이벤트 경계는 기존 시험과 합쳐 확인한다. D&D·Reins·과거 snapshot/hash·[CR-042](CR-042-desktop-capabilities.md) ABS-06으로 확장된 host admission·작업 사본별 단일 writer 제한을 유지한다. live/OS/브라우저 증거는 결정적 fixture와 구별한다.


## C-096 적용 계약

공통 프롬프트는 역할·운영·권한·안전·프로젝트 자료 경계·스킬·assignment·출력 계약으로 결정적으로 조립한다. 기존 지침·출력 JSON 계약을 유지하며 필수 내용을 잘라내지 않는다. 기존 ModelRequestRecord의 구획에 버전·포함 이유를 붙이고 pi-core도 같은 기록을 전달한다. 추가 API 호출은 없다. 프로젝트 규약은 사용자가 바인딩한 불변 리소스/명시 입력만 사용하며 자동 파일 탐색은 하지 않는다.

## C-099 TaskBrief와 검토 전용 범위

RunInput의 optional taskScope=review_only와 verificationScope=targeted|release를 사용한다. 기본은 기존 작업 범위/targeted다. review_only는 관리 파일 쓰기 권한을 실행 snapshot에서 제거하고 native extension/MCP/codemode 시작을 거절한다. 기존 등록 검사와 출력 artifact 작성은 유지한다. 검토 범위는 OS 격리를 뜻하지 않는다. TaskBrief는 이 snapshot의 입력 hash·criteria·assignment·실효 파일 권한·한도·resource refs를 조합한 worker 입력이며 별도 상태 원장이 아니다. 확인되지 않은 target tree를 만들어 넣지 않는다.
