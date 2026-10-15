# 001-canvas 태스크 상태

`implemented`는 로컬 게이트를 통과했지만 CI 증거가 아직 없다는 뜻이다. CI에서 연결된 테스트가 통과하면 `done`으로 바꾼다. 증거: [evidence/P0.md](evidence/P0.md).

| 태스크 | 상태 | 결과물 |
|---|---|---|
| C-001 | implemented | [헌장](../constitution.md), [Reins 상태 계약](../reins/spec.md) |
| C-002 | implemented | `docs/dependency-lock.json`, `pnpm deps:record`. TypeScript는 6.0.3(7.x는 tool API 호환 미검증) |
| C-003 | implemented | `packages/testkit` (FakeClock, SequentialIdFactory, Gate, ScriptedAgentAdapter, linearCorral) |
| C-004 | implemented | `apps/studio`, `packages/react` (캔버스, 팔레트, Inspector, 검증, Run, Reins, Storybook) |
| C-051 | implemented | pnpm workspace, Biome, TypeScript strict, Vitest projects, Playwright, CI 워크플로, `pnpm spec:check`, LICENSE, CLAUDE.md |
| C-052 | implemented | [스파이크 보고서](../../docs/spikes/C-052-p0-spikes.md). 실제 OAuth 로그인은 C-020 |
| C-053 | implemented | `RuntimeTransport`, `InProcessTransport`, `@corral/core/testing` 공통 계약 suite |
| C-054 | implemented | 정의 schema, JCS, definitionHash |

## P1을 위해 미리 만든 것

다음은 P0 세로 절편에 필요해 일부를 먼저 만들었다. 해당 태스크는 아직 `planned`다.

- C-005: 정의 schema 전체(4종 노드), steer 명령, P0 이벤트 19종. 나머지 명령·이벤트와 JSON Schema 생성은 남았다.
- C-006: Agent·Output 노드와 연결 규칙. Decision·Loop 노드와 capability link는 남았다.
- C-008: P0 선형 runner 계획(`planLinearRun`). 정식 compiler·IR은 남았다.
- C-012: in-memory Coordinator(명령 dedupe, 원자 commit, 구독). SQLite와 순수 decide/reduce 분리는 남았다.

## P1 시작 시 할 일

이 기능 묶음의 `spec.md`, `plan.md`, `acceptance.feature`를 P1 착수 때 작성한다([헌장 §6](../constitution.md)).
