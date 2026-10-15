# 001-canvas 태스크 상태

`implemented`는 로컬 게이트를 통과했지만 CI 증거가 아직 없다는 뜻이다. CI에서 연결된 테스트가 통과하면 `done`으로 바꾼다. 증거: [P0](evidence/P0.md), [P1](evidence/P1.md).

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
| C-005 | implemented | 명령·이벤트·검토 Zod, JSON Schema 생성과 `contracts:check` ([P1 증거](evidence/P1.md)) |
| C-006 | implemented | 4종 노드, 포트 핸들, 호출 링크 |
| C-007 | implemented | Loop 영역, 본문 편입·이탈, 멤버 동반 이동 |
| C-008 | implemented | `compileDefinition` 진단과 IR |
| C-009 | implemented | 정의 중심 편집 모델, import/export, 브라우저 저장소(별도 revision) |
| C-010 | implemented | Undo/Redo, 키보드 연결, IME·입력란 예외 |
| C-056 | implemented | 라우팅과 작업 공간. `/settings/models`는 C-058, `/demo`는 C-046 |

## 다음 단계를 위해 미리 만든 것

- C-012: in-memory Coordinator(명령 dedupe, 원자 commit, 구독). SQLite와 순수 decide/reduce 분리는 P2에서 한다.
- C-057 일부: Run 시작 시 정의·입력·모델 프로필 snapshot 기록(`run.started`). 활성 Run 1개 제약은 브라우저 세션 단위로만 적용된다.
