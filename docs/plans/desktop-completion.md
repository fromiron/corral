---
kind: plan
status: active
baseline: 373764467a52a7c6978de1272ac8253c73a27077
change_requests: [CR-042, CR-033]
---

# Desktop의 남은 구현과 환경 검증

승인 동작·수용 기준은 [Desktop 상세](../current/desktop-contract.md)와 [CR-042](../change-requests/CR-042-desktop-capabilities.md), 기존 결과는 [기능별 기록](../evaluation/Desktop-Capabilities-Implementation-Progress.md)에서 관리한다. ABS-01–15를 처음부터 다시 구현하지 않는다.

| 추적 | 이미 있는 것 | 남은 일과 완료 조건 |
|---|---|---|
| C-125 / ABS-04 | 파일·HTML·관리 service preview, 과거 Windows 검증, 현재 Linux TCP 경쟁 회귀와 AppImage native 검증 | macOS TCP 소유권 구현과 해당 OS 실제 앱 preview 검증. 미확인 경로는 계속 차단 |
| C-128 / ABS-07 | Windows 번들·portable, tray·종료·단축키 등 구현과 현재 Linux unpacked recovery/AppImage native 검증 | NSIS 설치/제거, macOS·지원 arch, 서명·실제 업데이트·유예/복구를 해당 산출물에서 확인. portable 첫 실행 지연도 기존 결과를 기준으로 측정 |
| C-135 / ABS-14 | host partition·SSH 실패·인증 경계·receipt/SSE 복구 구현 | 허용된 SSH host에서 성공 연결→실행/preview→끊김→복구. 다른 host로 명령·자료·credential이 넘어가지 않고 local fallback 없음 |
| C-136 / ABS-15 | WebRTC·고정 대상·확정 발화 중복 방지·종료 구현 | 실제 장치·지원 provider의 양방향 음성/끼어들기/권한 철회. 오발송·녹음 저장·마이크/socket 잔존 없음 |

## 기존 환경 미검증 항목

이미지·외부 모델·S3 계정 쓰기의 실제 호출은 결정적 fixture와 별도다. 기능 구현 상태를 일괄 미구현으로 되돌리지 않으며, 이번 작업에서 허용된 계정·비용·대상 없이 live 시험을 시작하지 않는다. 코드 서명·업데이트 채널·공개 배포도 각각 별도 증거가 필요하다.

2026-10-21 GPT OAuth·Hive API 실행은 [현재 기록](../evaluation/Quality-Completion-2026-10-21.md)에서 확인한다. SSH/S3 등록 대상과 이미지 프로필, 음성에 필요한 OpenAI API 키가 없어 이 외부 통합들은 검증 대기로 유지한다.

## CR-033-B / M4-5의 중첩 범위

[CR-033](../change-requests/CR-033-desktop-quality.md)의 알림 대상 이동·중복 억제는 C-171로 구현했다. 현재 계약은 [Desktop](../current/desktop-contract.md), Linux Electron의 정확한 Run·승인 이동과 늦은 클릭·재시작 경계는 [실행 기록](../evaluation/Desktop-Notification-Targets-2026-10-23.md)을 따른다. density·tray/dock·editor 열기·온보딩은 CR-042 기존 구현과 먼저 대조하고 충족한 항목을 중복 구현하지 않는다. 전체 M4-5나 모든 OS 알림 전달을 완료했다고 간주하지 않는다.

OTel 외부 export와 CLI browser 비교는 원래의 opt-in 후속 범위다. 기본 tracing·기존 browser 도구를 대체하거나 새 의존성을 설치할 근거가 아니다.

완료 판정은 OS·빌드 identity·mock/live·실행한 흐름·실패/skip을 구분한다. Windows 성공, Linux 단위 회귀, macOS 미지원은 서로 대체할 수 없다.

2026-10-21 Linux unpacked recovery와 AppImage native 흐름은 [현재 실행 기록](../evaluation/Quality-Completion-2026-10-21.md)으로 검증했다. 해당 candidate 이후 변경과 Windows/macOS 실기는 구분한다. 사용자는 현재 환경에서 불가능한 Windows/macOS 검증을 별도 후속 작업으로 지정했다.

2026-10-23 P29의 현재 Linux unpacked native/Monaco worker·시작 재시도·작업 공간 전환·sidecar/renderer 복구 코어를 [실행 기록](../evaluation/Development-Workbench-Qualification-2026-10-23.md)에서 확인했다. 이전 세대의 복구 페이지 로드가 늦게 실패하며 잘못된 재설치 안내를 띄우던 경합을 수정했다. 이 결과는 위 Windows/macOS·서명/업데이트·장치·외부 host 조건을 완료하지 않는다.
