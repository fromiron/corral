# Corral 개발 에이전트 작업 규칙

이 파일은 구현 착수 후 저장소 규칙으로 사용할 초안이다.

1. `Corral-Spec-v0.1.md`와 해당 feature spec, contract, 테스트 ID를 먼저 읽는다. 범위를 추측으로 넓히지 않는다.
2. 한 변경은 명시한 요구/태스크를 가진다. 사용자 승인 없이 D&D 또는 Reins를 나중으로 미루지 않는다.
3. 정상·실패·취소·중복·늦은 이벤트 반례를 정의하고 테스트가 실제 실패하는 것을 확인한 뒤 구현한다. 테스트를 작성했다는 말과 실행 통과는 다르다.
4. 외부 호출·시간·ID는 주입한다. 일반 CI에 유료 LLM/검색 호출을 넣지 않는다. live test는 명시적 opt-in과 한도가 필요하다.
5. Pi/LangGraph의 내부 상태나 UI store에서 Task 완료·예산 사용량을 임의로 확정하지 않는다. Coordinator 명령 경로를 거친다.
6. 모든 취소/patch는 현재 시도·scope·revision을 확인한다. 과거 context/artifact를 덮지 않는다.
7. provider key·local path·사용자 본문을 로그/스크린샷/공개 export에 노출하지 않는다. generated UI에서 raw HTML을 실행하지 않는다.
8. library를 추가할 때 버전·라이선스·공식 근거·Node/peer compat를 기록한다. 문서가 RC를 예시로 든다는 이유로 RC를 기본 설치하지 않는다.
9. 검증을 못 했으면 못 했다고 보고한다. 통합 테스트 없이 현재 API가 지원할 것이라고 단정하지 않는다.
10. spec 변경이 필요하면 Change Request와 관련 테스트·ADR를 먼저 갱신한다. red test를 삭제하거나 완화해서 완료하지 않는다.
