# Corral — SDD / TDD 설계 패키지 v0.1

**D&D로 설계하고, 자율 협업을 관찰하며, Reins로 실시간 조율하는 로컬 우선 AI 팀 도구.**

2026-10-14 · Bell 개인 프로젝트 · 구현 착수용 설계안

[통합 PDF — 스펙·기술 설계·구현 플랜](Corral-SDD-TDD-Blueprint-v0.1.pdf)

## 먼저 읽을 문서

| 순서 | 문서 | 목적 |
|---|---|---|
| 1 | [제품·실행 스펙](Corral-Spec-v0.1.md) | 목표, 용어, 범위, 네 노드, 협업, Reins, 상한, 20개 수용 기준 |
| 2 | [구현 플랜](Corral-Implementation-Plan-v0.1.md) | SDD·TDD 절차, P0~P9, 50개 태스크, 의존·완료 게이트 |
| 3 | [기술 설계](docs/Technical-Design.md) | 상태 소유, GraphRunner/Pi worker, 데이터·IPC·SSE·보안 |
| 4 | [API 계약](docs/API-Contract.md) | 명령·receipt·오류·이벤트 payload 목록 |
| 5 | [테스트 전략](docs/Test-Strategy.md) | 불변식·반례·경합·실모델 평가 분리 |
| 6 | [의존성과 출처](docs/Dependencies-and-Sources.md) | OSS 선정, 유지보수 관측, 버전/라이선스 미검증 구분 |
| 7 | [ADR](docs/Decisions.md) | 범위·스택·상태·스티어링에 대한 13개 결정 |

## 첨부 자료

- `contracts/`: 48개 요구, 50개 백로그, seed JSON Schema 4종, 이벤트 목록.
- `tests/`: 112개 **계획된** 테스트 시나리오, 추적 매트릭스, Gherkin, 문서 검사 결과.
- `examples/`: 그래프·레이아웃·개입 명령·검토 산출물 fixture.
- `templates/`, `AGENTS.md`: 기능 명세·변경 요청·PR과 에이전트 구현 규칙.
- `diagrams/`: 편집 가능한 Mermaid 원본. PDF의 도식은 같은 관계를 문서용으로 배치한 것.
- `tools/validate_pack.py`: 문서·스키마·참조 일관성 검사.

## 지금 생성한 것과 아직 하지 않은 것

**생성:** 명세, 구현 계획, 용어/상태/개입 계약, 태스크·테스트 설계, 예제 JSON과 검사용 스크립트.

**아직 하지 않음:** Corral 앱 구현, npm 패키지 발행, 이름/상표 확보, 라이브러리 조합 설치·통합 검증, 실제 LLM 실행, 제품 테스트 실행, 성능 측정. 테스트 목록은 통과 결과가 아니다. 문서 검사 결과와 제품 구현 결과를 혼동하지 않는다.

## 문서 팩 검사

```bash
python -m pip install -r tools/requirements.txt
python tools/validate_pack.py
```

이 명령은 계획 문서의 링크·스키마·예제·추적성을 검사한다. 향후 제품 저장소의 `pnpm test:*`를 대체하지 않는다.

## 구현의 출발점

P0부터 실제 D&D 캔버스와 mock 실행을 연결한다. 작업판과 runtime 계약을 검증하는 동안 UI는 기다리지 않는다. 첫 릴리스의 필수 기능은 D&D + 협업 + 제한된 Loop + subagents + Reins이며, 실행 중 구조 변경·crash resume·Local/Jev는 별도 후속 범위다.

설정한 이름은 **Corral(실행 경계) / Loop(반복) / Reins(제어 패널) / Steer(지시)**다. Task Board와 Artifacts는 이해하기 쉬운 일반 용어를 유지한다.
