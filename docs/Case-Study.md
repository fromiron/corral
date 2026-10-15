# Corral: 실행 중 바뀌는 요청을 사실과 구분하기

Corral은 D&D로 구성한 에이전트 팀을 관찰하면서 지시·취소·설정 변경을 전달하는 로컬 우선 도구다. 편집 중인 그래프, 실행 중인 시도, 변경할 수 없는 산출물 버전을 같은 객체로 다루면 늦은 결과가 화면과 기록을 되돌릴 수 있다. 그래서 Coordinator가 명령을 확인하고 commit한 이벤트만 실행 상태를 바꾼다. UI는 접수 receipt와 실제 적용 시점을 구분해서 표시한다.

## 설계와 검증 근거

| 결정 | 사용자에게 미치는 결과 | 확인할 근거 |
|---|---|---|
| 정의와 레이아웃 revision 분리 | 노드 위치를 바꿔도 실행 정의를 변경했다고 기록하지 않는다 | `packages/core/src/repository/`, Canvas 저장·undo E2E, [P1](../specs/001-canvas/evidence/P1.md) |
| 명령→Coordinator→commit→projection | UI 클릭만으로 작업 완료나 예산 환급을 확정하지 않는다 | `packages/core/src/coordinator.ts`, `coordinator-store.test.ts`, `budget-coordinator.test.ts` |
| 실행 시도와 취소 경계 | 지난 실행의 결과가 새 시도에 붙지 않으며 중복 명령은 같은 receipt를 돌려준다 | `packages/core/test/reins.test.ts`, seeded `coordinator-property.test.ts` |
| artifact/context/criteria version 참조 | 새 지시가 접수되기 전에 시작한 요청의 산출물을 새 지시의 결과라고 표시하지 않는다 | `packages/core/src/projection.ts`, review·reins·Pi adapter 테스트 |
| 구독 상태를 분리하고 Timeline 가상화 | 텍스트 프레임마다 캔버스를 다시 그리거나 10,000개 행을 DOM에 쌓지 않는다 | `packages/react/test/canvas-render-budget.test.tsx`, [production 측정](Performance.md) |
| 데모도 같은 runtime 계약 사용 | 모의 팀에서 지시가 결과에 반영되는 흐름을 계정 없이 확인한다 | `apps/studio/src/demo.worker.ts`, `apps/studio/e2e/demo.spec.ts` |
| 실제 설치 tree의 SPDX inventory | 빌드 후보와 제3자 라이선스 기록을 연결한다 | [release gate](Release.md), `tools/release/release.test.ts` |

이 표는 주장과 검증 위치를 연결한다. 특정 후보의 모든 테스트가 통과했다는 선언은 해당 후보의 gate 결과로 판단한다. 초기 P0–P5 증거와 이번 성능 snapshot도 각각의 실행 당시 결과다.

## 알려진 한계

- v0.2의 Local/Jev DecisionProvider 교체, v0.3 중첩/재사용 Corral, 외부 A2A adapter는 구현 범위가 아니다. MVP는 조사→작성→검토와 제한된 Loop를 대상으로 한다.
- crash 후 기록을 interrupted로 복구하고 읽는 것과 중단 지점에서 실행을 재개하는 crash resume은 다르다. crash resume은 제공하지 않는다.
- run 삭제·보존 정책은 정하지 않았다. DB와 artifact를 자동으로 지우지 않는다.
- process worker는 장애 격리 경계이며 완전한 보안 sandbox가 아니다. 임의 shell 실행 도구를 제공하지 않는다.
- 모의 데모에는 실제 모델의 답변 품질·비용·지연 보장이 없다. 실제 공급자 결과는 별도 opt-in smoke에 한정된다.
- [성능 수치](Performance.md)는 기록된 장비·브라우저에서 로컬 HTTP/SSE·SQLite와 합성 agent 부하를 측정한 결과다. 실제 모델·원격 네트워크·모바일·저사양 기기의 보장으로 일반화하지 않는다. production JS의 500kB chunk 경고는 남아 있다.
- 자동 axe, 키보드/IME 합성 E2E는 실제 한국어/일본어 OS IME와 screen reader를 사용한 사람의 점검을 대신하지 않는다. 그런 수동 점검을 했다고 주장하지 않는다.
- 이 저장소의 구현과 release workflow 추가는 공개 호스팅·npm 발행·상표 확보가 완료됐다는 뜻이 아니다. 최신 후보의 유료 smoke도 별도 증거가 필요하다.
