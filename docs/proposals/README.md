# 장기 제안과 검토 후보

여기는 **현재 구현 지시가 아닌 미승인 후보**를 관리한다. 승인됐지만 대기 중인 작업은 [활성 계획](../plans/README.md)에, 실제 구현 상태는 [상태표](../status.md)에 있다. 초기 버전 이름은 일정 약속이 아니다.

| 후보 | 현재 취급 | 착수 전 필요한 결정 |
|---|---|---|
| Corral/Subflow 중첩·재사용, 더 넓은 병렬 그래프 | 초기 v0.3 이후 아이디어. 현행 Loop/그래프 제약 유지 | 편집·실행 의미·취소/예산·migration을 포함한 별도 승인 |
| 외부 AgentAdapter/A2A, LiteLLM | 초기 확장 후보. 현재 Pi 연결 경로를 대체하지 않음 | 실제 사용자 요구, 권한/credential 경계, 의존성과 비용 |
| crash resume·외부 효과 자동 재실행 | 현재 미승인. 재접속·기록 읽기·checkpoint에서 새 Run 시작과 다름 | 멱등성·불확실 효과·비용·복구 계약 |
| Hybrid/자동 정책 최적화 | 초기 후보. 기존 observe·역할별 reasoning apply와 다름 | 평가 기준·호출/비용 한도·적용 권한 |
| [개발 서버를 켠 채 저장(P22 D2)](P22-shared-development-D2.md) | 결정 대기. 승인 전 strict 유지 | A strict 유지·B 공유 개발 owner(권고)·C 실행용 사본 중 선택과 의미 승인 |

일반 대화의 자동 팀 선택(CR-024/043), 역할별 추론 적용(CR-021), 복수 모델 Ultra(CR-031), Desktop 확장(CR-042)은 단순 장기 아이디어가 아니다. 해당 현재 계약과 잔여 계획을 따른다.

이전 Workbench·Personal Harness 제안 원문은 Git 이력으로만 관리한다. 채택된 부분은 현재 계약과 CR로 연결했고, 미채택·미확인 수용 기준은 아래 대조 대상으로 보존한다. 제안 패키지의 별도 요구/태스크/테스트 JSON은 제품 원장에 합산하지 않는다.

## 승인·충족 여부를 다시 확인할 후보

- Workbench 원안 (Git `373764467a52:docs/proposals/workbench-v0.1/README.md`)의 WBREQ/WBTASK/WBTST는 CR-010–017 이후 구현과 ID별 대응이 모두 확정된 상태가 아니다. 원본 ID와 acceptance를 보존하며, 남은 것으로 보인다는 이유만으로 새 기능을 구현하지 않는다.
- Workbench polish 기록 (Git `373764467a52:docs/plans/Workbench-Polish-Plan.md`)의 `/export` 노출 범위, 검색 p95·사용성 평가·편집기 초기 dirty 관찰은 당시 후속 항목이다. 이후 변경으로 해결됐는지 확인 전 완료나 현재 결함으로 단정하지 않는다.

새 제안은 문제·기존 구현·후보·미결정·승인 필요 범위를 짧게 적는다. 채택 시 관련 CR과 태스크를 연결하고 활성 계획으로 넘긴다.
