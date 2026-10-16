# Corral

**D&D로 설계하고, 자율 협업을 관찰하며, Reins로 실행 중인 팀을 조율하는 로컬 우선 AI 도구.**

React Studio, 명령·이벤트 Coordinator, SQLite 기록, 격리된 Pi worker, 모의 공개 데모를 포함한 TypeScript 모노레포다. 설계 자료와 실행된 검증 증거를 함께 관리한다. 테스트 목록은 통과 결과가 아니며, 현재 후보의 준비 상태는 [release gate](docs/Release.md)로 확인한다.

## 실행

Node 24.15.0 이상인 24.x와 pnpm 10.30.3이 필요하다. 검증·CI 기준은 `.node-version`의 24.19.0이다.

```sh
pnpm install --frozen-lockfile
pnpm dev          # 브라우저의 모의 runtime
pnpm serve        # production Studio + 로컬 서버, 출력된 bootstrap 링크로 접속
pnpm storybook    # 상태별 component와 접근성 검사
```

`/demo`는 키나 로컬 서버 없이 모의 에이전트를 실행한다. 실제 모델 연결은 로컬 서버의 Models 설정에서 사용자가 완료한다(로그인, API 키, Codex CLI 로그인, Ollama 같은 OpenAI 호환 엔드포인트: [모델 연결](docs/Models.md)). provider credential은 서버 측 설정에 보관하며 Corral 정의나 이벤트에 포함하지 않는다. 공개 호스팅이나 npm 발행은 이 저장소에 포함된 실행 사실이 아니다.

## 검증

```sh
python -m pip install -r tools/requirements.txt
pnpm --filter @corral/studio exec playwright install --with-deps chromium firefox
pnpm test
pnpm build
pnpm test:e2e
pnpm test:performance
pnpm release:gate
```

일반 테스트·release gate는 유료 모델/검색을 호출하지 않는다. 실제 공급자 smoke에는 별도 opt-in과 상한이 있으며, `release:check`는 같은 후보의 live 증거가 없으면 실패한다. 자세한 절차는 [출시 증거](docs/Release.md), 장비·build hash·원본 sample은 [성능 측정](docs/Performance.md), 설계 판단과 미구현 범위는 [사례 문서](docs/Case-Study.md)를 참고한다.

## 구조와 명세

| 위치 | 역할 |
|---|---|
| `apps/studio`, `packages/react` | 그래프 편집, 실행/산출물/지시 패널, 번역 메시지, Storybook |
| `apps/server`, `packages/client` | loopback session, REST/SSE, 안전한 외부 입력 |
| `packages/core`, `packages/contracts` | Coordinator, 예산·취소·version 규칙, Zod/JSON Schema |
| `packages/storage-sqlite`, `packages/adapter-pi` | 기록·재열람, 실제 모델 worker |
| `packages/cli`, `packages/testkit` | CLI와 결정적인 모의 agent/clock/ID |
| `tools/release`, `tests/live` | 후보별 gate·라이선스·SPDX와 opt-in live 증거 |

- [제품·실행 스펙](Corral-Spec-v0.1.md), [구현 플랜](Corral-Implementation-Plan-v0.1.md), [추가 태스크와 의존](docs/plans/Corral-Implementation-Plan-v0.2-Supplement.md)
- [기술 설계](docs/Technical-Design.md), [API 계약](docs/API-Contract.md), [ADR](docs/Decisions.md)
- [테스트 전략](docs/Test-Strategy.md), [추적 매트릭스](tests/traceability.json), [P6–P9 셀프 리뷰 수정 근거](specs/001-canvas/evidence/review-fixes.md)
- [선정 근거](docs/Dependencies-and-Sources.md), [고정 버전 기록](docs/dependency-lock.json), [MIT 라이선스](LICENSE)

MVP 범위는 D&D·협업·제한된 Loop·subagents·Reins다. Local/Jev DecisionProvider, Corral 중첩, crash resume은 후속 범위이며 현재 기능으로 표시하지 않는다.
