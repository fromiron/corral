---
kind: reference
status: current
baseline: a9bb0bb93411cd89a24e27d8b237b53d3e9cf813
---

# 구조와 상태 소유권

상태의 소유권을 라이브러리나 화면 편의에 따라 중복하지 않는다. 현재 코드 위치는 다음과 같다.

| 경계 | 위치 | 역할 |
|---|---|---|
| 사용자 인터페이스 | `apps/studio`, `packages/react` | 편집 draft, 조회 캐시, 실행 projection, 대화·결과·Reins |
| Desktop | `apps/desktop` | Electron 셸, 로컬 runtime 수명과 패키징 |
| 서버·클라이언트 | `apps/server`, `packages/client` | 설정·프로젝트 서비스, HTTP·SSE와 클라이언트 계약 |
| 도메인 | `packages/core`, `packages/contracts` | Coordinator, 명령·이벤트·상태·예산, 검증 가능한 타입 |
| 실행 어댑터 | `packages/adapter-pi`, `packages/runner-langgraph` | 모델·도구 실행과 정적 제어 흐름을 기존 Coordinator 경로에 연결 |
| 저장 | `packages/storage-sqlite` | 영속 기록·투영·재열람 |
| 도구 | `packages/cli`, `packages/testkit`, `tools/release` | CLI, 결정적 시험 대역, 출시 검사 |

## 소유권

Run·Task·Execution·Approval, event sequence, control revision, 실행 효과의 permit·예산·완료는 Coordinator 경로에서 확정한다. Pi와 GraphRunner는 실행 어댑터이며, UI store는 관찰용 투영이다. 스트리밍 delta나 어댑터 반환만으로 Run 성공을 확정하지 않는다.

정의·레이아웃·설정·import·금고의 저장은 각 기존 서비스의 revision·원자 저장 경로를 따른다. 모든 설정 변경을 새로운 Coordinator 원장으로 옮기거나, 반대로 설정 저장소가 실행 효과를 직접 확정하게 만들지 않는다.

영속 이벤트와 현재 SQL 투영의 트랜잭션 경계를 지킨다. 실행 당시 snapshot과 산출물 버전은 불변이다. 편집 draft나 미래 설정 변경은 과거 Run의 입력을 바꾸지 않는다.

`contracts/core`는 DOM·React에 의존하지 않는다. Studio에서 DB·Pi·credential 저장소를 직접 다루지 않는다. 구체적인 인터페이스 변경은 코드와 해당 계약 시험을 함께 확인한다.

## 상세 자료

[기술 설계](../Technical-Design.md)의 상태 소유·전이·통신 상세를 필요한 범위만 읽는다. 그 문서의 초기 디렉터리 예시나 미도입 판단은 현재 트리를 대신하지 않는다. [CR-042](../change-requests/CR-042-desktop-capabilities.md)의 Desktop·host·동시성 변경 범위를 함께 확인한다.

결정의 이유와 대체 관계는 [Decisions](../Decisions.md), 실행 불변식은 [실행과 안전](execution-and-safety.md), API 변경은 [API](api.md)에 연결한다.
