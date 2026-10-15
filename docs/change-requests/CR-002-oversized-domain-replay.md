# CR-002: 큰 영속 이벤트도 cursor를 진행하며 재생한다

- 변경 ID / 날짜: CR-002 / 2026-10-15
- 상태: 결함 수정에 적용. 사용자의 셀프 리뷰 후 수정 진행 지시에 따른 전송 방식 보완이다.
- 관련 요구·태스크: CRL-OBS-002, C-041, AC-16
- 연결 문서: [API 계약](../API-Contract.md) §5, [ADR-023](../Decisions.md), [기술 설계](../Technical-Design.md) §12.2

## 문제와 변경

1 MiB outgoing 상한은 작은 이벤트 여러 개의 prefix 재생에는 맞지만, 1 MiB보다 큰 단일 이벤트 앞에서는 매번 같은 cursor로 연결이 끊어진다. 2 MiB 요청 제한 안의 취소 사유도 이 문제를 만들며, 미래 설정 patch는 before+after를 함께 기록해 요청보다 큰 이벤트가 된다. 이미 저장한 이벤트를 새 입력 제한으로 복구할 수 없다.

일반 outgoing 상한과 prefix 재생은 유지한다. 큰 committed domain event를 만나면 구독을 해제하고 prefix를 flush한 뒤, 해당 이벤트 한 건을 작은 UTF-8 바이트 조각으로 순차 전송한다. 완전한 frame을 보낸 뒤 연결을 닫으며, 10초 flush deadline과 다음 연결의 cursor 재개를 유지한다. domain record 한 건의 직렬화·파싱 메모리가 필요함을 명시한다.

## 계약과 반례

도메인 이벤트의 내용·순서·schema와 명령 접수 범위는 바꾸지 않는다. 새 의존성·저장 migration은 없다. 이벤트 생략이나 축약, cursor를 앞당긴 성공 처리는 허용하지 않는다. 비영속 frame·헤더·주석의 고정 상한을 유지하고, 잘못된 domain event는 오류로 중지한다.

TC-OBS-002-H/N에 다음 반례를 추가한다: 실제 서버가 접수한 1.1 MB 취소 사유의 재생, 두 번의 2 MB 미래 prompt patch로 저장한 약 4 MB 이벤트의 클라이언트 재접속, 느린 쓰기에서 한 조각씩 전송, UTF-8 분할 복원, 전송 중 실패·취소, 잘못된 domain schema와 과대한 비영속 frame. 기존 작은 이벤트의 prefix·중복 제거·gap 복구 테스트를 유지한다.
