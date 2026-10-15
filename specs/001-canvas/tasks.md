# 001-canvas 태스크 상태

`implemented`는 로컬 게이트를 통과했지만 CI 증거가 아직 없다는 뜻이다. CI에서 연결된 테스트가 통과하면 `done`으로 바꾼다. 증거: [P0](evidence/P0.md), [P1](evidence/P1.md), [P2](evidence/P2.md), [P3](evidence/P3.md), [P4](evidence/P4.md).

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
| C-062 | implemented | `.corral/config.json` schema, 스펙 §9 hard cap, 자격 증명 거절 |
| C-011 | implemented | `packages/storage-sqlite` (migration, RunStore, Corral repository, [ADR-021](../../docs/Decisions.md)) |
| C-012 | implemented | `Coordinator` over `RunStore`, 재시작 시 interrupted, fast-check 모델 테스트. 취소 fence는 P6 |
| C-013 | implemented | effect intent·epoch·activation key |
| C-014 | implemented | `GraphRunner`, 참조 runner, `packages/runner-langgraph` |
| C-057 | implemented | `CreateRunRequest`, RunSnapshot, 활성 Run 1개 |
| C-015 | implemented | `apps/server` REST·SSE, `packages/client` |
| C-055 | implemented | bind·Host·Origin·bootstrap 세션·CSP ([ADR-022](../../docs/Decisions.md)) |
| C-016 | implemented | 실행 트리·대기 이유·실행 이력·render budget. 캔버스 배지의 대기 이유는 P4 |
| C-060 | implemented | 가상화 Timeline과 필터 |
| C-059 | implemented | Playwright `server` project와 harness |
| C-017 | implemented | `packages/adapter-pi` IPC schema, 실행당 worker 프로세스, 생명주기 검사 |
| C-018 | implemented | 요청별 permit·지시 snapshot·access token, 비영속 text stream(SSE `event: stream`) |
| C-019 | implemented | `authorizeTool`/`executeTool` 분리, 역할이 허용한 도구만 노출 |
| C-020 | implemented | usage normalization, 실행 모드·모델 고정. **실제 호출 smoke는 수동 opt-in, 미실행** ([P3](evidence/P3.md) §5) |
| C-058 | implemented | `ModelRegistry`, 자격 증명 파일(workspace 밖), Sign in with ChatGPT 흐름, `/settings/models` |
| C-021 | implemented | Task당 활성 시도 하나, 재배정 없음, Coordinator가 결정하는 취소 결과 |
| C-022 | implemented | `spawn_subagents`·`await_tasks`, 모델 슬롯(대기 중 미점유), 상주 실행 상한, 부모 종료 시 자식 정리 |
| C-023 | implemented | `ask`·`reply`, 새 응답 Task, 단회 종결(답·타임아웃·종료), 늦은 reply 감사 기록 |
| C-024 | implemented | 실행별 artifactId, 제출 버전만 전달, `read_artifact` 범위·기록 |
| C-025 | implemented | Pi 협업 도구, Task Board·질문 패널·산출물 보기, SafeMarkdown, `examples/research-brief` |

## 다음 단계를 위해 미리 만든 것

- C-030(P5): Coordinator의 decision policy 포트. 지금은 테스트만 주입한다. 정책이 없으면 Decision 단계와 최종 승인이 있는 정의는 이유와 함께 시작을 거절한다.
