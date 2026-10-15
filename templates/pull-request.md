# 변경 요약

요구 ID / feature spec / task ID / ADR:

## TDD 증거

- Red: 실제로 실패한 테스트와 이유
- Green: 통과시킨 최소 구현
- Refactor: 외부 계약이 바뀌지 않았음을 확인한 방법
- 실행하지 못한 테스트와 정확한 이유

## 계약 점검

명령 재전송 / 취소 fence / 늦은 결과 / artifact version / 키·로그 / UI a11y / IME / state subscription.

## 변경 영향

schema migration, API compat, dependency lock, source license, screenshot/trace(필요한 경우).

## 완료

테스트 개수만 보고 완료하지 않는다. 연결된 수용 기준과 negative/race test를 확인한다. 새 scope는 별도 변경 제안으로 다룬다.
