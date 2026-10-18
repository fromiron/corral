# 수동·자동 추론 구현 진행

기준 main `6ada359`. Bell 승인: 2026-10-18. 결정 계약은 [CR-021](../change-requests/CR-021-role-reasoning-apply.md), 기존 관찰 계약은 CR-003이다.

## 필수 완료 범위

- [x] 역할별 fixed / auto / provider-default 계약, 모델 capability, Run-only와 미래 실행 패치
- [x] SDK·legacy permit → stream 옵션 → 실제 payload, 요청별 기록·재생
- [x] Mixdog v6 turn/tool-step 입력, bounded ONNX worker·취소·fallback
- [x] Coordinator 요청 전 판정, stale 재준비·예산·소유권
- [x] 역할/컴포저/실행 기록 UI, undo/import/export
- [x] 다른 팀 Run 표시 차단, 명시 live/mock 선택 보존
- [x] 결정적 회귀·로컬 act·빌드·desktop 검증
- [x] 실제 계정 Sol/Luna low/high/auto, 역할 변경·파일/check·재시작 (초기 48회; 추가 검증 한도는 사용자 요청으로 해제)
- 전달 단계: 커밋·PR exact-head CI·머지·main 동기화. 최종 전달 여부는 이 변경의 PR merge 상태와 main commit을 기준으로 확인한다.

## 작업 기록

- 시작: clean main 확인. 새 의존성 없음. Context7 미노출로 Pi 1.3 설치 소스·타입을 확인한다.
- Oracle Pro 원문은 이번 세션의 `/tmp/corral-oracle-reasoning-plan-20261018/implementation-plan.txt`에 보존돼 있다. 구현 계약은 임시 파일에 의존하지 않도록 CR-021에 옮겼다.

## 출처

- T3 Code MIT `16918b57d6754d6f145e9b6367c825aa31a740da`: capability 기반 옵션과 선택/실제 사용 구분.
- DeepSeek Harness MIT `687f282e8625c6b8d11ff58211a90524be2e4317`: assembled 선택 고정과 strict 수동 검증.
- PI Desktop LGPL-3.0 `e219a3e4c0e4cc73ddacde78005987a85d5977d6`: end-to-end 동작 참고, 코드 직접 복제 없음.
- Mixdog Apache-2.0 `81558aa4230744e504972e01cb248ec9369e35bc`: 기존 파생 판정기와 step 입력·bounded 실행 패턴. 파생 코드는 effort-judge/NOTICE.md에 기록한다.

실계정 상세 결과와 검증 한계: [검증 기록](../validation/Reasoning-Controls-2026-10-18.md).
