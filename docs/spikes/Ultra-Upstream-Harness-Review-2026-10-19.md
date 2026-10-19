# Ultra 병렬 실행의 upstream 비교

CR-031 / C-114, 2026-10-19. 기존 C-113은 Corral의 단일 후보 검토 루프를 재사용했다. 아래 비교는 그 구현 이후 Bell이 요청한 보완이며, C-113이 이 소스들을 참고해 만들어졌다는 뜻이 아니다.

## 확인한 자료

공개 소스는 임시 디렉터리에 읽기 전용으로 받아 아래 revision을 확인했다. 외부 저장소의 설치 스크립트·에이전트·모델 호출은 실행하지 않았다. Context7 도구는 이 세션에 없어 설치된 Pi 1.3.0의 문서·예제와 공식 저장소/문서를 확인했다.

| 대상 | 확인한 버전/소스 | Corral에서 사용할 근거 | 직접 설치 시 차이 |
|---|---|---|---|
| Pi | 설치된 `@earendil-works/pi-coding-agent@1.3.0`, [공식 subagent 예제](https://github.com/earendil-works/pi/tree/v1.3.0/packages/coding-agent/examples/extensions/subagent) | 독립 컨텍스트, 역할별 도구, 제한된 worker pool | 예제는 별도 CLI 프로세스를 실행한다. 현재 worker의 Corral provider/permit과 file broker를 자식에게 자동 연결하지 않는다. |
| oh-my-pi | `18.12.2`, [`9d5d4ac5`](https://github.com/can1357/oh-my-pi/tree/9d5d4ac5b50ac2bb5866e4202efc0cf785dfc57a) | 대기열 중단, 이미 시작한 작업의 settlement 대기, 원래 순서의 결과 수집, 사본 기준과 변경 포착/정리의 분리 | Bun 및 `@oh-my-pi/*`·native VCS를 사용하는 별도 하네스다. Pi 1.3.0에 추가하는 작은 확장이 아니다. 자동 apply-back은 Corral의 후보 선택 계약과 다르다. |
| pi-subagents | `@fitchmultz/pi-subagents@0.49.1`, [`1646ab89`](https://github.com/fitchmultz/pi-subagents/tree/1646ab895e25fb56847ad669733c55807bc8ff3c) | 독립 실행/결과 아티팩트, 취소 가능한 worktree 준비, diff 포착 실패 시 변경 보존 | Node `>=24.21.0`이며 Corral 동봉 버전은 `24.19.0`. 별도 runner/session/usage 계층과 clean-HEAD 기반 worktree가 있다. Corral의 미커밋 기준 snapshot·호출 전 예약을 그대로 대체하지 못한다. |
| Codex | [`89461ea6`](https://github.com/openai/codex/tree/89461ea6833832b0551ce24ee32205824d5c108d), [공식 subagents 문서](https://learn.chatgpt.com/docs/agent-configuration/subagents) | 부모의 권한 상한 상속, 시작 전 용량 예약, 미공개 자식의 취소 정리, 공유 예산 계측 | Rust 하네스와 자체 영속 thread/agent graph다. 공개 Codex 구현을 확인했으며 ChatGPT 서비스의 비공개 내부 구현을 확인했다고 주장하지 않는다. |
| Claude Code | [공식 subagents 문서](https://code.claude.com/docs/en/sub-agents) | 역할별 도구, 독립 context, worktree 밖 실행 거절, 변경이 있는 사본의 보존 | 문서에 공개된 동작을 참고한다. 이 검토는 Claude Code 내부 엔진의 오픈소스 재사용이나 라이선스 허가를 전제하지 않는다. |
| DeepSeek Harness | `0.2.1-rc.2`, [`687f282e`](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317) | 영속 child와 현재 activation 구분, 시작 전 capacity 예약, 정확한 activation 취소, descendant teardown 이후 결과 확정 | MIT/TypeScript지만 Cordis·session·scope·sandbox 등 자체 런타임을 요구한다. 확인 버전은 RC이며 Corral 플러그인으로 즉시 호환되는 제품이 아니다. |

### 실제 읽은 구현 지점

- oh-my-pi: [`task/parallel.ts`](https://github.com/can1357/oh-my-pi/blob/9d5d4ac5b50ac2bb5866e4202efc0cf785dfc57a/packages/coding-agent/src/task/parallel.ts), `task/spawn-run.ts`, `task/isolation-runner.ts`, `task/worktree.ts`, `task/executor.ts`의 세션 생성 경계.
- pi-subagents: [`runs/shared/worktree.ts`](https://github.com/fitchmultz/pi-subagents/blob/1646ab895e25fb56847ad669733c55807bc8ff3c/src/runs/shared/worktree.ts), `runs/shared/parallel-utils.ts`, `runs/background/subagent-runner-launcher.ts`, package manifest.
- Codex: [`agent/control/spawn_guard.rs`](https://github.com/openai/codex/blob/89461ea6833832b0551ce24ee32205824d5c108d/codex-rs/core/src/agent/control/spawn_guard.rs), `spawn.rs`, `budget.rs`.
- DeepSeek: [`subagent/src/activation.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/subagent/subagent/src/activation.ts), `manager.ts`의 reserve/dispose/drain 경로, `index.ts`, `docs/subsystems/subagent.md`.

## 적용 판단

1. **기존 Corral 실행 경로에 upstream의 확인된 패턴을 적용한다.** 현재도 `spawnTool`은 자식을 한 commit으로 등록하고 병렬 launch하며 모델 슬롯·취소·예산은 Coordinator가 소유한다. Ultra에는 공통 계획, 후보별 파일 scope, 검증/선택/승격만 연결한다. 일반 다중 에이전트 프레임워크를 새로 만들지 않는다.
2. **Pi 플러그인 직접 채택은 허용한다.** 원문 가이드의 플러그인 일괄 배제는 Bell의 후속 요청으로 적용하지 않는다. 다만 이번에 조사한 확장 자체를 켜는 것만으로 Corral 하위 실행의 예산·권한·복구 계약이 연결되지는 않는다. 신규 버전 채택이 필요하면 고정 버전의 자식 요청/취소 통합 시험을 먼저 수행한다.
3. **하네스 전체 교체는 이번 변경에 넣지 않는다.** OMP/DeepSeek/Codex의 실행·상태 저장 계층을 함께 가져오면 상태와 예산의 권위가 둘이 된다. 필요해질 경우 별도 아키텍처 선택으로 다룬다.

외부 코드가 공개되어 있고 시험이 있다는 사실을 Corral 안에서 안정적이라는 증거로 간주하지 않는다. Pi/OMP/pi-subagents/DeepSeek는 확인한 manifest에서 MIT, Codex는 Apache-2.0이다. 이번 비교는 소스 참고이며 코드 복사나 새 런타임 의존성은 없다. 따라서 번들 크기 변화도 없다. 신규 의존성의 보안 감사나 해당 프로젝트 전체 시험은 수행하지 않았다.

## C-114 수용 기준에 반영할 차이

- 한 후보가 실패해도 다른 후보 결과를 잃지 않는다. Run 취소는 새 dequeue를 멈추고 시작한 실행·파일 준비·검사를 모두 정리한 뒤 종료한다.
- 용량은 준비 전에 확보하며 시작 실패/취소도 반환한다. 후보 id와 실행 attempt를 구별해 과거 취소/늦은 결과가 새 실행을 건드리지 않는다.
- 모든 후보는 동일한 **미커밋 변경을 포함한 시작 tree**에서 출발한다. 사본이 없어지면 메인 사본으로 fallback하지 않는다.
- 별도 CLI/플러그인의 usage 합계에 의존하지 않고 모든 모델 요청이 기존 permit·공유 Run 예약을 통과한다. 80% 신규 작업 중단과 마무리 hold는 Corral 고유 계약이다.
- worktree 분리는 OS 격리와 다르다. 파일 broker·격리 worker·host 소유 검사가 계속 경계를 맡는다.
- 결과 선택과 승격은 별도 단계다. 변경 포착 실패/정리 불확정 시 사본을 보존하며, 자동 apply-back/merge를 하지 않는다.

이 문서는 비교 및 설계 근거다. C-114 구현 완료·실제 모델 품질 개선·플러그인 호환성 통과 증거는 아니다.
