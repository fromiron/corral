# CR-031: Ultra 검증과 후보 비교

- 상태: **순차 구현 승인** — Bell, 2026-10-19: “플랜대로 M0부터 순서대로 개선 진행해. CR 등록 → 실패 테스트 → 구현 순서로 하고, 기존 기능 회귀도 확인해.”
- 계획: [통합 개선 실행 계획](../plans/Corral-Improvement-Execution-Plan-2026-10-19.md), M4-1/2.
- 기준: `780591e`(PR #60 수정 포함). 구현/검증 완료 여부는 단계별 증거로 따로 기록한다.
- 추적: M4 착수 시 admission/파일 격리/eval 핵심 반례 등록.

## 계약

1. mode mock/live와 독립된 qualityPreset default/ultra를 시작 snapshot에 선택적으로 추가한다. 지원 built-in 팀만 planner→executor→verifier로 실행하며 수정은 최대 2회다.
2. 후보 비교는 검증 OS 격리·checkpoint·eval 뒤에 도입한다. 후보 기본 3/최대 5, 모델 동시성 최대 3을 분리하고 후보별 worktree/lease/비용을 소유한다.
3. 필수 검증 실패 후보를 먼저 제외하고 후보 하나만 승격한다. 전원 실패는 no_acceptable_candidate다. 자동 병합이나 사용자 팀·권한 변경은 하지 않는다.
4. 절대 예산에 계획/후보/판정/요약/검증/수정을 포함한다. 80%에서 신규 fan-out/revise를 멈추고 종료 비용을 예약한다. default 대비 최종 선택 결과·총비용·성공당 비용을 비교한다.

## 검증과 배포

새 동작과 데이터·권한·취소 경계의 대표 반례만 구현 전에 실패를 확인한다. 기존 통합 시험을 우선 확장하며 문구·내부 함수·모든 조합을 따라가는 시험은 추가하지 않는다. 적용되는 정상·실패·취소·중복·늦은 이벤트 경계는 기존 시험과 합쳐 확인한다. D&D·Reins·과거 snapshot/hash·전역 활성 Run 제한을 유지한다. live/OS/브라우저 증거는 결정적 fixture와 구별한다.


## C-113 Ultra 기본 프리셋

자동 세션의 시작 요청에 optional `qualityPreset: default | ultra`를 추가한다. 기존 미지정 경로와 저장된 정의/hash는 바꾸지 않는다. Ultra는 고정 write_review 팀과 기존 immutable review recipe를 사용해 planner→writer→수정 권한 없는 reviewer를 실행한다. 최초 실행+최대 두 번 수정(3회 검토)이며 반복 실패·예산 상한·취소는 기존 Coordinator가 종료한다. 사용자 정의 팀에는 프리셋을 적용하거나 역할/권한을 변경하지 않는다.

모델과 명시 reasoning, installation policy, 기존 기본 예산은 유지하며 template 선택 모델 호출은 생략한다. route reasoning은 기존 local 기본 medium을 쓰고 출처를 기록한다. 후보 fan-out과 80% 마무리 예약은 다음 C-114에서 같은 총예산 안에 추가한다. 기본/Ultra의 동일 과제 결정적 비교는 기능과 사용량 계측 증거이며 실제 품질 개선 주장이 아니다. UI 선택은 초안·재시도 identity와 Run/entry 기록에 남는다.

C-113의 토글과 `/ultra`, `corral exec auto --ultra`는 `createAutoStarter`에서 고정 정의를 만들어 같은 Coordinator 시작 경로로 전달한다. CLI custom 파일에는 적용하지 않으며 별도 파일 권한을 부여하지 않는다. 선택은 시작 metadata와 세션 요청/초안에 기록해 거절된 요청의 다시 편집도 보존한다.
