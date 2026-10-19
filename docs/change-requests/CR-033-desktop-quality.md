# CR-033: 접근성 성능과 데스크톱 완성도

- 상태: **순차 구현 승인** — Bell, 2026-10-19: “플랜대로 M0부터 순서대로 개선 진행해. CR 등록 → 실패 테스트 → 구현 순서로 하고, 기존 기능 회귀도 확인해.”
- 계획: [통합 개선 실행 계획](../plans/Corral-Improvement-Execution-Plan-2026-10-19.md), M1-7, M4-5.
- 기준: `780591e`(PR #60 수정 포함). 구현/검증 완료 여부는 단계별 증거로 따로 기록한다.
- 추적: 기존 접근성·production E2E·Electron smoke를 확장.

## 계약

1. 새 UI부터 IME·focus·shortcut scope·status announcement·reduced motion·색 외 상태를 검증한다. 기존 D&D/Reins의 키보드 경로를 유지한다.
2. 기존 TanStack Virtual로 긴 대화의 안정 ID·앵커·검색 이동·전체 복사/export를 처리한다. 실제 기기/build/fixture에서 성능 목표를 검증한다.
3. 기존 테마·알림·badge 기반을 재사용해 density·tray/dock·온보딩·editor 열기를 완성한다. 알림은 민감 본문 없이 중복 제거와 정확한 deep link를 갖는다.
4. OTel 외부 export와 CLI browser 비교는 opt-in 후속이며 기본 trace/error ID는 초기부터 쓴다.

## 검증과 배포

새 동작과 데이터·권한·취소 경계의 대표 반례만 구현 전에 실패를 확인한다. 기존 통합 시험을 우선 확장하며 문구·내부 함수·모든 조합을 따라가는 시험은 추가하지 않는다. 적용되는 정상·실패·취소·중복·늦은 이벤트 경계는 기존 시험과 합쳐 확인한다. D&D·Reins·과거 snapshot/hash·전역 활성 Run 제한을 유지한다. live/OS/브라우저 증거는 결정적 fixture와 구별한다.
