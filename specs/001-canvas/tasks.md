# 001-canvas 태스크 상태

`implemented`는 로컬 게이트를 통과했지만 CI 증거가 아직 없다는 뜻이다. CI에서 연결된 테스트가 통과하면 `done`으로 바꾼다. 증거: [P0](evidence/P0.md), [P1](evidence/P1.md), [P2](evidence/P2.md), [P3](evidence/P3.md), [P4](evidence/P4.md), [P5](evidence/P5.md), [P6](evidence/P6.md), [P7](evidence/P7.md), [P8](evidence/P8.md), [P9](evidence/P9.md), [셀프 리뷰 수정·실제 동작 점검](evidence/review-fixes.md).

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
| C-020 | implemented | usage normalization, 실행 모드·모델 고정. 실제 호출 smoke는 수동 opt-in이며 2026-10-15에 한 번 실행해 통과 ([P3](evidence/P3.md) §5) |
| C-058 | implemented | `ModelRegistry`, 자격 증명 파일(workspace 밖), Sign in with ChatGPT 흐름, `/settings/models` |
| C-021 | implemented | Task당 활성 시도 하나, 재배정 없음, Coordinator가 결정하는 취소 결과 |
| C-022 | implemented | `spawn_subagents`·`await_tasks`, 모델 슬롯(대기 중 미점유), 상주 실행 상한, 부모 종료 시 자식 정리 |
| C-023 | implemented | `ask`·`reply`, 새 응답 Task, 단회 종결(답·타임아웃·종료), 늦은 reply 감사 기록 |
| C-024 | implemented | 실행별 artifactId, 제출 버전만 전달, `read_artifact` 범위·기록 |
| C-025 | implemented | Pi 협업 도구, Task Board·질문 패널·산출물 보기, SafeMarkdown, `examples/research-brief` |
| C-026 | implemented | 같은 Loop 안의 `task_output`은 이번 라운드 버전만, `previous_iteration_output`은 라운드 시작에 고정(`pinnedCarryInputs`). 다음 라운드의 draft는 같은 artifactId의 다음 version |
| C-027 | implemented | 기본 Decision 정책: 검토 JSON·대상(검토자가 받은 입력)·기준 버전 검사, 실패는 `inconclusive`와 사람 승인 |
| C-028 | implemented | Loop 상한에서 `loop_cap` 승인, 설치 hard cap은 승인으로 넘을 수 없음(`limit.reached`) |
| C-029 | implemented | `approval.requested/resolved`, `resolve_approval`(대상 버전·control revision·재전송), Output `requireApproval`의 최종 승인, Studio 승인 패널 |
| C-030 | implemented | 산출물 보기의 계보(수정 대상·입력 버전), 이전 버전과 줄 diff, 검토 판정·이슈. 지시 경로(CRL-RNS-010)는 P6 |
| C-031 | implemented | Steer enqueue·delivery receipt ([P6 증거](evidence/P6.md)) |
| C-032 | implemented | Pause/drain/resume 경계 ([P6 증거](evidence/P6.md)) |
| C-033 | implemented | 전체·개별 cancel과 후손 정리 ([P6 증거](evidence/P6.md)) |
| C-034 | implemented | 명시적 재시작과 이전 epoch 차단 ([P6 증거](evidence/P6.md)) |
| C-035 | implemented | 미래 config patch·범위 미리보기 ([P6 증거](evidence/P6.md)) |
| C-036 | implemented | 지시/기준 변경과 산출물 연결 ([P6 증거](evidence/P6.md)) |
| C-037 | implemented | 예산 예약·정산·설정 변경 ([P7 증거](evidence/P7.md)) |
| C-038 | implemented | wait graph·총량·deadline·no progress ([P7 증거](evidence/P7.md)) |
| C-039 | implemented | 경합 property test·late results ([P7 증거](evidence/P7.md)) |
| C-040 | implemented | crash interrupted·기록 export/reopen ([P7 증거](evidence/P7.md)) |
| C-041 | implemented | backpressure·재접속·마지막 텍스트 복구 ([P7 증거](evidence/P7.md)) |
| C-042 | implemented | CSRF·rate/size·키 누출·DNS rebinding 전체 감사 ([P8 증거](evidence/P8.md)) |
| C-043 | implemented | 문서 import·안전 URL reader ([P8 증거](evidence/P8.md)) |
| C-044 | implemented | SearchProvider mock+Brave live ([P8 증거](evidence/P8.md)) |
| C-045 | implemented | CLI 동일 command/query 경로 ([P8 증거](evidence/P8.md)) |
| C-046 | implemented | public DemoDriver와 fixture pack ([P9 증거](evidence/P9.md)) |
| C-047 | implemented | Storybook 상태·Playwright 키보드/IME ([P9 증거](evidence/P9.md)) |
| C-048 | implemented | 부하·가상화·profiling 예산 ([P9 증거](evidence/P9.md)) |
| C-049 | implemented | release gate·SBOM·라이선스 ([P9 증거](evidence/P9.md)) |
| C-050 | implemented | 포트폴리오 사례 문서·known limitations ([P9 증거](evidence/P9.md)) |
| C-061 | implemented | BudgetInspector·usage 표시 ([P7 증거](evidence/P7.md)) |

## 다음 단계를 위해 미리 만든 것

- Coordinator의 `decisions` 포트는 테스트가 분기를 직접 정할 때만 주입한다. 주입하지 않으면 C-027·C-029의 기본 정책이 쓰인다.
