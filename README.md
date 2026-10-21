# Corral

**대화로 작업을 시작하고, 필요한 팀을 D&D로 설계하며, Reins로 실행을 조율하는 로컬 우선 AI 도구.**

React Studio, 명령·이벤트 Coordinator, SQLite 기록, Pi worker와 Electron Desktop을 포함한 TypeScript 모노레포다. 일반 대화에 Corral 제작을 먼저 요구하지 않으며, 직접 설계한 Corral도 선택해 사용할 수 있다. 승인 계약·구현·환경별 검증 상태는 구분한다.

## 실행

Node 24.15.0 이상인 24.x와 pnpm 10.30.3이 필요하다. 검증·CI 기준은 `.node-version`의 24.19.0이다.

```sh
pnpm install --frozen-lockfile
pnpm dev          # 브라우저의 모의 runtime
pnpm serve        # production Studio + 로컬 서버, 출력된 bootstrap 링크로 접속
pnpm storybook    # 상태별 component와 접근성 검사
```

`/demo`는 키나 로컬 서버 없이 모의 에이전트를 실행한다. 실제 모델 연결은 사용자가 [모델 설정](docs/Models.md)에서 완료한다. credential은 서버 측 설정에 보관하며 Corral 정의나 이벤트에 포함하지 않는다. Desktop 실행·패키징 절차는 [Desktop 안내](apps/desktop/README.md)를 따른다. 공개 배포나 모든 플랫폼·공급자의 검증 완료를 뜻하지 않는다.

## 문서

개발 에이전트는 [공통 작업 규칙](AGENTS.md)을 먼저 읽고 [문서 지도](docs/README.md)에서 작업 범위를 고른다. `CLAUDE.md`는 공통 규칙을 가져오기만 한다.

| 질문 | 읽을 문서 |
|---|---|
| 현재 제품 계약과 기본 흐름은? | [제품](docs/current/product.md), [Workbench](docs/current/workbench.md) |
| 상태·실행·권한을 누가 소유하는가? | [구조](docs/current/architecture.md), [실행과 안전](docs/current/execution-and-safety.md) |
| 모델·추론·Skill·API를 바꾸려면? | [모델과 리소스](docs/current/models-and-resources.md), [API](docs/current/api.md) |
| 남은 작업과 실제 검사 결과는? | [계획 지도](docs/plans/README.md), [검증 기록 안내](docs/evaluation/README.md) |

초기 기획안과 과거 구현 계획은 기본 개발 지침이 아니다. 이력 조사와 문서 이관 대상은 [과거 자료 안내](docs/archive/README.md)에 구분한다.

## 검증

```sh
python -m pip install -r tools/requirements.txt
pnpm spec:check
pnpm contracts:check
pnpm deps:check
pnpm --filter @corral/studio exec playwright install --with-deps chromium firefox
pnpm test
pnpm build
pnpm test:e2e
pnpm test:performance
pnpm release:gate
```

위 명령은 실행 절차이지 이 commit에서의 통과 증거가 아니다. 일반 테스트·release gate는 유료 모델/검색을 호출하지 않는다. 실제 공급자 smoke에는 별도 opt-in과 상한이 필요하며, `release:check`는 같은 후보의 live 증거를 요구한다. [테스트 전략](docs/Test-Strategy.md), [출시 절차](docs/Release.md), [성능 측정](docs/Performance.md)을 참고한다.

## 구조와 라이선스

| 위치 | 역할 |
|---|---|
| `apps/studio`, `packages/react` | 프로젝트·세션·대화, 그래프 편집, Reins와 결과 UI |
| `apps/desktop` | Electron 셸과 로컬 runtime 패키징 |
| `apps/server`, `packages/client` | 설정·서비스, REST/SSE와 클라이언트 |
| `packages/core`, `packages/contracts` | Coordinator와 계약·검증 |
| `packages/storage-sqlite`, `packages/adapter-pi`, `packages/runner-langgraph` | 저장과 실행 어댑터 |
| `packages/cli`, `packages/testkit`, `tools/release`, `tests/live` | CLI·테스트 도구·출시 검사 |

[MIT 라이선스](LICENSE)를 사용한다. 실제 의존성 기록은 [dependency lock](docs/dependency-lock.json), 차용물의 고지는 [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES/) 및 각 번들 디렉터리에 있다. 과거 참고 제품의 동작을 Corral의 현재 계약으로 취급하지 않는다.
