# 계약 초안 사용법

JSON Schema 4개는 **구현 전 seed contract**다. 현재 도구로 schema 문법과 첨부 fixture를 검사할 수 있지만, Corral의 실행기/권한/전이 검증을 구현한 것은 아니다.

- `corral-definition.schema.json`: 4종 노드와 역할·control/capability·기본 상한.
- `command.schema.json`: Steer, pause/resume, cancel, 미래 patch, 승인, 조건부 restart.
- `review.schema.json`: 검토 산출물의 구조. 대상/기준 ID의 실제 일치는 런타임이 검사.
- `event-envelope.schema.json`: 봉투만 검사. 모든 event payload의 discriminated union은 C-005에서 구현.
- `requirements.json`: 구현 요구의 원본 ID 목록.
- `backlog.json`: 구현해야 할 태스크. 전부 planned.

실행 전 compiler는 역할/포트/Loop/입력의 의미 검증을 추가해야 한다. JSON Schema만 통과했다고 실행 가능한 것으로 판정하지 않는다. `tools/validate_pack.py`의 구조 검사는 문서 팩 내부 예제의 일관성만 점검하며 제품 compiler를 대체하지 않는다.

P1에서 Zod를 계약의 canonical source로 만들고 JSON Schema를 생성한다. TypeScript DTO를 별도 손으로 재작성해서 세 가지 명세가 드리프트하지 않게 한다.

`modelProfile`은 서버가 설정한 프로필 이름이다. 예제 `model-a/model-b`는 실제 provider model ID가 아니며 키·단가·도구 지원 정보를 제공하지 않는다. 실모델ID는 P0의 호환성 검사에서 선택한다.
