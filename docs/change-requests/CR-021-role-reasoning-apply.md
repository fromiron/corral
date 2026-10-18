# CR-021: 역할별 추론 설정과 로컬 자동 판정의 실제 적용

- 상태: 승인 — Bell의 2026-10-18 Oracle 플랜 전체 구현·실계정 검증·PR 병합 요청.
- 기준: main `6ada359`, Oracle Pro 계획과 T3 `16918b57d675`, DeepSeek Harness `687f282e8625`, PI Desktop `e219a3e4c0e4`, Mixdog `81558aa42307`.
- 추적: C-084, CRL-RSN-001~004, TC-RSN-001-H/N~004-H/N.

## 계약

1. 공유 모델 프로필은 provider/model을 소유한다. 역할의 선택적 `reasoning`은 `fixed(level)`, `auto`, `provider_default`다. 필드가 없는 구자료는 기존 wire 동작과 hash를 유지한다. 수동 미지원 값은 clamp하지 않고 거절한다. off·필드 생략·공급자 기본은 다르다.
2. 우선순위는 미래-node patch → 이번 Run 역할 override → 저장된 역할이다. 수동 패치는 미래 execution만 바꾸며, auto만 각 요청에서 결정한다. 모델/추론을 함께 저장·패치할 수 있다. 이미 시작한 실행은 고정된 모델·capability·정책을 유지한다.
3. CR-003의 off/observe는 그대로 유지한다. 별도 apply는 local-model 한 개만 사용한다. auto는 실제 turn/tool-step 입력을 제한된 private IPC로 받고, 입력 hash·모델/판정 버전·선택/적용/wire만 공개 기록한다. 모델 슬롯·예산 예약 전에 비동기 판정하고 최종 commit 직전에 owner/attempt/입력/지시를 재검사한다. stale이면 재준비(최대 2회), 취소면 permit을 발급하지 않는다. observer는 계속 요청을 바꿀 수 없다.
4. 자동 기준은 medium, 후보는 지원 단계와 low/medium/high/xhigh의 교집합이다. medium이 없는 모델의 auto는 거절한다. 기대비용으로 판정한 단계의 medium 기준 상대 이동을 지원 ladder에 적용하고 양끝에서 제한한다. sparse ladder도 판정값·실제값·정책 버전으로 구분하며 매 요청 medium에서 다시 시작한다. fixed는 auto가 덮지 않는다. compaction은 명시적인 medium 기본값을 기록한다. missing/error/timeout/한도는 medium fallback과 사유를 기록한다. fallback-only를 자동 적용 검증 통과로 보지 않는다.
5. 기존 ONNX v6·tokenizer·calibration을 재사용하며 steps 지원을 확인한다. 실제 추론은 backend당 1개, 대기 최대 3개, 대기 1초·warm 1.5초·cold 포함 3초, stuck 10초 뒤 실제 종료 확인 후 교체, load 실패 60초 cooldown. timeout 뒤 실제 worker 점유를 해제한 척하지 않는다. 판정 상한은 Run 모델 요청 한도(default), hard cap 100이며 observe/apply가 합산하고 stale 재판정도 센다. 자동 설치·유료 판정은 추가하지 않는다.
6. SDK와 legacy의 실제 요청은 Coordinator permit의 확정값을 사용한다. proxy metadata를 보존하고 최종 payload에서 의미를 확인한다. retry·확장·compaction도 permit·예산을 거친다. 구 이벤트는 추론 정보 미기록으로 표시하고 복구 때 자동 재호출하지 않는다.
7. 편집기의 Run·Canvas·출력·승인·Reins는 현재 팀 소유로 제한한다. 화면 이동은 실행 취소가 아니며 미확인 명령을 잃지 않는다. 실행 모드는 안정적인 workspace/project/session 또는 corral 범위에 명시 선택만 저장한다. 첫 방문/잘못된 값은 mock, live 사용 불가 때 자동 mock 전환 대신 시작을 막는다.

8. 산출물 결과 뷰는 실행·검토·제출 상태만으로 파일 변경/검사 유무를 단정하지 않는다. 이전 CR-009의 무조건적인 “파일 변경·검증 명령 없음” 배지는 제거하고, 실제 파일/검사 증거는 기존 세션 변경·검증 패널과 검증 요약을 따른다.

9. Coordinator가 `submit_result` 또는 담당 질문의 `reply` 성공을 확인하면 해당 Pi turn의 도구 처리를 마친 뒤 실행을 종료한다. 완료 확인용 모델 요청으로 예산을 추가 소비하지 않는다. 거절된 제출은 완료로 취급하지 않고, 취소·필수 hook 실패는 유지한다. 실계정 스킬·hook 검증에서 제출 뒤 한도 초과로 역할만 실패하는 사례를 재현했다.

## 검증과 완료

문서·계약 → 실패 반례 실행 → 구현 → 관련 회귀 → 전체 gate → 실제 패키지 UI 검증 순서다. 수동 low/high와 실제 ONNX turn/tool-step auto가 Sol/Luna wire까지 도달해야 한다. 실계정 검증은 이번 사용자 opt-in과 초기 최대 48회에서 시작했으며, 스킬·hook 실사용 결함 재검증 중 사용자가 배치 호출 한도를 폐지했다. 필요한 확인만 수행하고 제품의 Run별 예산 제한은 유지한다. 모델 내부 추론량·판정 정확도·비용 절감은 배선 성공만으로 주장하지 않는다. 변경 계획과 진행은 `docs/plans/Reasoning-Implementation-Plan.md`에 기록한다.
