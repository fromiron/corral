# 문서 팩 검증 결과

기준일: 2026-10-14.

**문서·계약 검사: 513개 검사 통과.**

요구 48개, 태스크 50개, 계획된 테스트 시나리오 112개를 연결했다. JSON Schema 문법, 예제 JSON, 일부 그래프 참조·포트, 태스크 의존 순환, 요구 추적, Markdown 링크·코드 블록을 검사했다.

**Corral 제품 테스트를 112개 실행했다는 뜻이 아니다.** 앱 구현, Pi/LangGraph 통합, 공급자 호출, 브라우저 E2E, 성능 시험은 실행하지 않았다. 해당 테스트들은 구현 플랜의 작업이다.

재검사: `python tools/validate_pack.py`. JSON 결과는 `tests/pack-validation-report.json`에 기록된다.
