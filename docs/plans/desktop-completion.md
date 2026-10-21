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
| C-125 / ABS-04 | 파일·HTML·관리 service preview, Windows 검증, Linux TCP accept 경쟁 회귀 | macOS TCP 소유권 구현과 실제 OS별 앱 preview 검증. 미확인 경로는 계속 차단. Linux 집중 회귀를 전체 packaged 검증으로 확대하지 않음 |
| C-128 / ABS-07 | Windows 번들·portable, tray·종료·단축키 등 구현 및 일부 native 증거 | NSIS 설치/제거, macOS·지원 arch, 서명·실제 업데이트·유예/복구를 해당 산출물에서 확인. portable 첫 실행 지연도 기존 결과를 기준으로 측정 |
| C-135 / ABS-14 | host partition·SSH 실패·인증 경계·receipt/SSE 복구 구현 | 허용된 SSH host에서 성공 연결→실행/preview→끊김→복구. 다른 host로 명령·자료·credential이 넘어가지 않고 local fallback 없음 |
| C-136 / ABS-15 | WebRTC·고정 대상·확정 발화 중복 방지·종료 구현 | 실제 장치·지원 provider의 양방향 음성/끼어들기/권한 철회. 오발송·녹음 저장·마이크/socket 잔존 없음 |

## 기존 환경 미검증 항목

이미지·외부 모델·S3 계정 쓰기의 실제 호출은 결정적 fixture와 별도다. 기능 구현 상태를 일괄 미구현으로 되돌리지 않으며, 이번 작업에서 허용된 계정·비용·대상 없이 live 시험을 시작하지 않는다. 코드 서명·업데이트 채널·공개 배포도 각각 별도 증거가 필요하다.

## CR-033-B / M4-5의 중첩 범위

[CR-033](../change-requests/CR-033-desktop-quality.md)의 density·알림 deep link/중복 억제·tray/dock·editor 열기·온보딩은 CR-042 기존 구현과 먼저 대조한다. 충족한 항목은 중복 구현하지 않고 남은 세부 수용 기준만 다음 태스크로 좁힌다. 전체 M4-5를 완료했다고 간주하지 않는다.

OTel 외부 export와 CLI browser 비교는 원래의 opt-in 후속 범위다. 기본 tracing·기존 browser 도구를 대체하거나 새 의존성을 설치할 근거가 아니다.

완료 판정은 OS·빌드 identity·mock/live·실행한 흐름·실패/skip을 구분한다. Windows 성공, Linux 단위 회귀, macOS 미지원은 서로 대체할 수 없다.
