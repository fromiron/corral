# 알림의 정확한 작업 대상 이동 — 구현·핵심 검증

- 기준: `6aa3374` 위 이 문서를 포함한 알림 대상 이동 구현 묶음. CR-033-B, C-171, CRL-ABS-007, TC-DESK-010-H/N/F.
- Linux x64, Node 24.19.0, Electron 44.4.5, 현재 Studio production build와 staged runtime. 모델은 mock이며 개인 앱 데이터와 분리한 임시 작업 공간을 사용했다.
- 기존 알림·inbox·SPA 이동·compact Run 대응 영역을 재사용했다. 새 레이아웃·의존성·별도 승인 화면은 없다.

## 실행 결과

| 범위 | 결과 | 로그 |
|---|---|---|
| 대상 payload·비공개 본문 배제·중복/같은 개수 교체·삭제/해결된 대상·기존 lifecycle | 3파일 15 PASS | `/tmp/corral-notification-green.log` |
| 기존 코드의 대상 이동 누락 | 새 helper 부재와 기존 native 빌드의 run query 누락을 red로 확인 | `/tmp/corral-notification-red.log`, `/tmp/corral-notification-native-red.log` |
| 실제 Electron 알림 클릭 경로 | H/N/F PASS | `/tmp/corral-notification-native-green.log` |
| Desktop 타입·변경 파일 정적 검사 | PASS | `/tmp/corral-notification-desktop-types.log`, `/tmp/corral-notification-biome.log` |

실제 Electron에서 mock Run의 승인이 대기하는 동안 다른 화면으로 이동한 뒤 알림을 클릭했다. 정확한 세션·Run query와 해당 승인 카드가 열렸다. 취소로 inbox에서 사라진 대상의 늦은 클릭은 현재 화면을 바꾸지 않았고, 두 인자 알림은 기존 창 포커스만 유지했다. SPA의 `performance.timeOrigin`이 유지되었으며 sidecar 재시작 전 알림은 새 renderer로 전달되지 않았다. 화면 `/tmp/corral-notification-target.png`를 직접 확인했다.

## 범위

OS 알림의 표시만 수집으로 대체하고 실제 main Notification click listener→preload→Studio 대상 조회/이동을 사용했다. 개인 알림을 발송하지 않았고 임시 앱·작업 공간은 종료/정리했다. 실제 OS 알림 센터 전달·Windows/macOS·설치판 전체 여정·스크린리더·외부 모델은 이번 검증에 포함하지 않는다. 문서 수명 보존은 SPA와 기존 store를 재사용한 근거이며 모든 편집기의 모든 미저장 상태를 재시험했다는 뜻은 아니다.
