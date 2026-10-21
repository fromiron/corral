# Corral — 의존성 선정·유지보수·출처

> 기준일 2026-10-14. **선정안이며 설치된 lockfile·호환성 검사 결과가 아니다.** 공식 문서와 일부 릴리스 API를 직접 확인했다. 조회한 저장소의 최근 릴리스와 npm 패키지의 최신 버전을 혼동하지 않는다. 실시간 정보는 착수 시 다시 확인한다.

## 1. 선정 정책

핵심 의존성은 오픈소스 라이선스, 공개 소스·문서·변경 이력, 교체 가능한 경계, TypeScript·로컬 실행 적합성을 기준으로 선정했다. star 수를 품질 지표로 사용하지 않는다. 빈번한 릴리스만으로 안정성도 보장되지 않는다.

**릴리스 날짜까지 확인한 핵심군:** Pi, xyflow, LangGraph.js 저장소, Fastify, Vitest. 나머지는 공식 문서·저장소를 확인한 후보이며 모두 같은 수준으로 최신 활동을 검증했다고 주장하지 않는다. P0의 버전 잠금 게이트에서 각 패키지의 최신 안정 릴리스·최근 변경·보안 공지·라이선스를 보충한다.

## 2. 도입할 라이브러리

| 계층 | 채택 | 역할·선택 이유 | 라이선스/주의 | 근거 |
|---|---|---|---|---|
| 실행 환경 | Node.js 24 LTS, pnpm workspace | 브라우저/서버/worker의 TS 모노레포 | 배포판·전이 의존성 라이선스 별도 확인 | S26,S29 |
| UI | React 19.2 계열, TypeScript, Vite 8.1 계열 | SEO보다 상호작용 중심 SPA; 서버 수명과 UI build 분리 | React/Vite MIT, TS Apache-2.0; 정확한 patch 잠금 | S27,S28 |
| 캔버스 | @xyflow/react | 노드·포트·연결·선택·뷰포트. 도메인 그래프는 자체 정의 | MIT OSS core. Pro 예제 코드 구매를 전제로 하지 않음 | S01~03,S35 |
| UI 상태 | Zustand | editor / live projection / Reins / stream store 분리 | MIT; React Flow 내부 상태와 중복 mutable truth 금지 | S08 |
| 조회 캐시 | @tanstack/react-query | 정의 목록, 과거 Run, 산출물 요청 | MIT; live run projection은 별도 store | S09 |
| 가상화 | @tanstack/react-virtual | 긴 타임라인·트리 행 | MIT; 현재 focus/선택 행이 사라지는 경우 처리 | S10 |
| UI primitives | Radix Primitives + Tailwind CSS | 접근 가능한 Dialog, Tabs, Tooltip; Corral만의 컴포넌트 디자인 | MIT 계열; 전체 템플릿 복사보다 필요한 primitive만 | S11,S30 |
| 폼 | react-hook-form | 역할·모델·한도·Reins 폼의 dirty/validation 상태 | MIT; 서버 validation은 별도 필수 | S12 |
| 판정 모델 런타임(v0.2) | onnxruntime-node 1.30.0 (`@corral/effort-judge`) | mixdog effort judge ONNX 모델을 worker thread에서 실행(CR-003 C-072). 2026-09-14 배포, Node ≥ 24에서 CPU 바인딩 로드 확인 | MIT. npm 패키지가 모든 플랫폼 CPU 바이너리를 포함(≈301 MB unpacked). postinstall(선택 GPU 빌드 다운로드)은 실행하지 않음. macOS Intel 바인딩 없음 → provider unavailable. 전이 의존성 global-agent BSD-3-Clause, type-fest `(MIT OR CC0-1.0)`(정책에 검토 추가) | npm registry, `packages/effort-judge/NOTICE.md` |
| 계약 | Zod 4 | REST/IPC/정의/command validation 및 JSON Schema 생성 | MIT; TypeBox는 Pi 어댑터 내부 경계에 제한 | S13,S07 |
| 로컬 API | Fastify 5 | 세션, 명령, 조회, SSE, 일관된 오류 | MIT; SSE 취소/정적 UI/보안 plugin 호환성 검사 | S14,S38 |
| 그래프 실행 | @langchain/langgraph | 검증된 정적 그래프/제한된 loop 실행 | MIT. 제품의 authoritative task/patch 상태를 중복 소유하지 않음 | S04,S05,S40 |
| 에이전트 | @earendil-works/pi-agent-core + pi-ai + pi-coding-agent | 기본 tool loop, 역할별 명시 SDK 세션(CR-018) | MIT, 모두 1.3.0 정확 고정. 내장 shell·파일·자동 리소스 탐색 제외 | S06,S07,S36 |
| 저장 | SQLite + better-sqlite3 + Drizzle | 로컬 영속 이벤트·투영·텍스트 산출물의 atomic commit | SQLite public domain / driver MIT / ORM Apache-2.0 | S15,S20~23,S34 |
| 단위·통합 | Vitest | pure reducer, timeout·fake timer, DB/API 통합 | MIT; 관측 릴리스5.0.4를 무조건 채택하지 말고 호환 검증 | S16,S39 |
| 성질 테스트 | fast-check | 무작위 command interleaving·예산·취소 불변식 | MIT; seed와 shrink 결과 보존 | S17 |
| 브라우저 | Playwright + axe 통합 | 실제 D&D·IME·재접속·접근성·취소 경합 | Playwright Apache-2.0. axe 전이 라이선스 P0 기록 | S18 |
| HTTP mock | MSW | Studio 단독 개발, 실패·지연·충돌 응답 | MIT; 런타임 테스트의 Agent mock과 역할 구분 | S19 |
| 컴포넌트 | Storybook + Testing Library | 상태별 Reins·노드·대기 행 테스트 | 각 패키지 라이선스 P0 잠금. 유료 hosted CI 불필요 | S31 |
| 코드 품질 | Biome, TypeScript strict | 일관된 formatting, lint, type check | 문서/JSON/Mermaid 검사도 별도 스크립트 | S32 |

`react-markdown + remark-gfm`, 텍스트 diff 라이브러리, CLI 인자 파서는 작은 보조 의존성으로만 추가한다. P0에서 라이선스·최근 유지보수 확인 후 정확한 버전을 결정한다. HTML passthrough·실행 가능한 Markdown 확장은 사용하지 않는다. 필요 없는 편집기 SDK·거대한 아이콘 패키지는 초기 필수 의존성으로 두지 않는다.

### 2.1 두 종류의 schema 도구를 무분별하게 섞지 않는다

Corral 도메인 스키마의 원본은 Zod다. Pi가 요구하는 TypeBox 도구 parameter는 어댑터 안에서 생성하거나 얇게 매핑한다. 양쪽을 별개 수작업 사양으로 유지하지 않는다. 변환 가능한 제한된 JSON Schema subset을 정하고 golden round-trip test로 동등성을 확인한다. 이 팩의 JSON Schema는 그 전 단계의 **계약 초안**이며, 구현 착수 후 Zod 원본에서 생성하도록 이동한다.

## 3. 유지보수 증거와 버전 잠금

| 프로젝트 | 조회에서 관측한 것 | 이 사실이 보장하지 않는 것 |
|---|---|---|
| Pi | v1.2.0, 2026-10-12. 태그의 agent-core package는 MIT·Node >=22.19.0 | Corral worker/steering 어댑터의 완성, 모든 provider 취소 품질 |
| xyflow | @xyflow/system@0.0.83, 2026-09-24 | @xyflow/react의 현재 버전이 0.0.83이라는 뜻이 아님 |
| LangGraph.js | @langchain/vue@1.2.4, 2026-10-12 | @langchain/langgraph 런타임이 같은 버전이라는 뜻이 아님 |
| Fastify | v5.12.7, 2026-10-13 | 모든 SSE/static/session plugin과의 자동 호환 |
| Vitest | v5.0.4, 2026-10-12 | Pi repo의 개발용 Vitest와 동일할 필요 없음; Vite/Node 호환 검증 필요 |
| React / Vite | 공식 페이지 React19.2, Vite8.1 발표 확인 | 이후 patch의 최신성이나 무결함 보장 아님 |

정확한 설치 버전은 P0에서 `package.json + pnpm-lock.yaml + runtime version file + dependency-evidence.json`으로 고정한다. 버전 evidence에는 license, integrity, upstream tag/commit, release date, 확인일, peer/Node 요구, 검사한 테스트를 적는다. `latest`, 무제한 `*`, RC 문서 예시를 그대로 설치하지 않는다.

특히 Drizzle 공식 SQLite 문서에 `@rc` 설치 예시가 있으므로, 최신 웹 문서를 읽었다는 이유로 pre-release를 제품 기본값으로 채택하지 않는다. 안정판 태그의 migration/API를 검증한다. 드라이버는 Node24/Linux/Windows WSL 환경에서 설치·transaction·shutdown 테스트한다.

## 4. 넣지 않는 것과 이유

| 의존성/기능 | MVP 처리 | 재검토 조건 |
|---|---|---|
| Next.js | 사용하지 않음 | 공개 콘텐츠 SEO나 서버 렌더링이 실제 요구일 때. 로컬 장수 Run의 수명은 Next 요청 수명에 묶지 않음 |
| Tauri / Electron | 사용하지 않음 | 로컬 웹 MVP 후 설치·OS 통합이 필요할 때 |
| XState / Redux / RxJS | 추가하지 않음 | 이미 정의한 Coordinator·Zustand를 대체할 구체적 이익이 있을 때 |
| Redis / BullMQ / Kafka / Temporal | 추가하지 않음 | 분산 실행·durable resume·멀티유저가 실제 요구일 때 |
| LiteLLM | 후속 | provider/유저 비용 운영 필요가 커졌을 때 |
| Local / Jev | v0.2: Local은 관찰 전용 `reasoning_effort`로 구현(CR-003). Jev는 별도 spike | 적용(apply)·자동 라우팅은 관찰 데이터 평가 뒤 별도 CR |
| Langfuse | 자체 Run 기록을 대체하지 않음 | 외부 observability export 필요 시 |
| Spec Kit / OpenSpec | 선택 문서 도우미 | 저장소 명세·테스트 규칙을 훼손하지 않는 경우. 필수 런타임 없음 |
| React Flow Pro / Chromatic | 필수 아님 | 유료 예제·서비스의 가치를 별도로 판단할 때 |

## 5. 오픈소스와 외부 서비스의 경계

Corral 소스의 배포 라이선스는 **MIT를 제안**한다. 아직 실제 저장소의 소유자·저작권 고지·배포 절차를 확정했다는 뜻은 아니다. npm scope `@corral/*`, CLI bin, 상표·도메인 사용 가능성도 이 조사에서 검증하지 않았다. 우선 private workspace로 사용한다.

자체 실행·UI·저장·테스트 경로는 OSS 구성으로 만든다. 실제 LLM 호출과 Brave Search는 별도의 외부 서비스이며 키·이용조건·과금이 적용될 수 있다. mock/corpus demo는 그 비용 없이 작동해야 한다. 서비스 구독의 비공식 OAuth 재사용을 기본 인증으로 설계하지 않는다.

배포 전 직접·전이 의존성의 SPDX 목록, 원문 license/NOTICE, 공급망 audit를 만든다. 보조 패키지의 라이선스는 여기서 미검증인 경우 그 사실을 유지한다. 법률상 사용 가능성 전체를 이 표가 보장하지 않는다.

## 6. 출처와 증거 원장

아래 출처는 기능 사실 확인용이다. 제품의 새 상태 모델·예산 정책·작업 분해·일정은 Corral 설계 판단이다. 사용자 PDF는 원문을 이 ZIP에 중복 포함하지 않고 문서명·절을 참조한다.

### [B1] 합의 기준: agent-harness-mvp-spec_v1.1.pdf

사용자 첨부, 2026-10-14, 14쪽

확인일: 2026-10-14. 원문 1부 §1~8 기준. 이 문서 팩의 새 결정은 명시적으로 구분한다.

### [B2] 이전 리뷰와 역제안

사용자 첨부 plan-review.md / mvp-spec.md / v1.0 PDF

확인일: 2026-10-14. D&D 연기·YAML-only 부분은 최신 합의로 대체됨. 상태·테스트 분석만 참고.

### [S01] React Flow 공식 문서

https://reactflow.dev/learn

확인일: 2026-10-14. D&D 캔버스 기반. 그래프 실행기는 아님.

### [S02] React Flow 성능

https://reactflow.dev/learn/advanced-use/performance

확인일: 2026-10-14. 컴포넌트 메모이제이션과 좁은 상태 구독.

### [S03] React Flow 접근성

https://reactflow.dev/learn/advanced-use/accessibility

확인일: 2026-10-14. 키보드·스크린리더 구성.

### [S04] LangGraph 영속성

https://docs.langchain.com/oss/javascript/langgraph/persistence

확인일: 2026-10-14. checkpointer와 store의 다른 책임.

### [S05] LangGraph interrupts

https://docs.langchain.com/oss/javascript/langgraph/interrupts

확인일: 2026-10-14. resume 시 노드 재진입과 부작용 주의.

### [S06] Pi agent-core, 확인한 릴리스 v1.2.0

https://github.com/earendil-works/pi/blob/v1.2.0/packages/agent/README.md

확인일: 2026-10-14. 훅·요청 준비·도구 이벤트·취소. main 문서도 함께 확인, 태그 차이는 P0 검사.

### [S07] Pi package metadata v1.2.0

https://github.com/earendil-works/pi/blob/v1.2.0/packages/agent/package.json

확인일: 2026-10-14. MIT, Node >=22.19.0, pi-ai와 typebox 의존.

### [S08] Zustand 공식 저장소

https://github.com/pmndrs/zustand

확인일: 2026-10-14. MIT; vanilla store와 selector 기반 상태.

### [S09] TanStack Query

https://tanstack.com/query/latest/docs/framework/react/overview

확인일: 2026-10-14. 서버 조회 상태. 라이선스: https://github.com/TanStack/query

### [S10] TanStack Virtual

https://tanstack.com/virtual/latest

확인일: 2026-10-14. 긴 실행 트리·타임라인 가상화. 라이선스: https://github.com/TanStack/virtual

### [S11] Radix Primitives

https://www.radix-ui.com/primitives/docs/overview/introduction

확인일: 2026-10-14. Dialog·Tabs 등 저수준 UI. MIT: https://github.com/radix-ui/primitives

### [S12] React Hook Form

https://github.com/react-hook-form/react-hook-form

확인일: 2026-10-14. 폼 상태·검증, MIT.

### [S13] Zod

https://zod.dev/

확인일: 2026-10-14. v4 stable, JSON Schema 지원. MIT: https://github.com/colinhacks/zod

### [S14] Fastify

https://fastify.dev/

확인일: 2026-10-14. 로컬 Node API 기반. MIT: https://github.com/fastify/fastify

### [S15] Drizzle SQLite

https://orm.drizzle.team/docs/sqlite/get-started-sqlite

확인일: 2026-10-14. 드라이버·타입 SQL. 문서 @rc 예시는 안정판 확정 전 복사 금지.

### [S16] Vitest

https://vitest.dev/guide/

확인일: 2026-10-14. 단위·통합 테스트. MIT: https://github.com/vitest-dev/vitest

### [S17] fast-check 모델 기반 테스트

https://fast-check.dev/docs/advanced/model-based-testing/

확인일: 2026-10-14. 명령 순서/상태 전이 성질 검증. MIT: https://github.com/dubzzz/fast-check

### [S18] Playwright 접근성 테스트

https://playwright.dev/docs/accessibility-testing

확인일: 2026-10-14. 실브라우저/a11y 테스트. Apache-2.0: https://github.com/microsoft/playwright

### [S19] MSW

https://mswjs.io/

확인일: 2026-10-14. 브라우저·Node 요청 mock. MIT: https://github.com/mswjs/msw

### [S20] SQLite WAL

https://sqlite.org/wal.html

확인일: 2026-10-14. WAL 작동·제약. SQLite는 public domain.

### [S21] SQLite transaction

https://sqlite.org/lang_transaction.html

확인일: 2026-10-14. 원자적 명령·이벤트·투영 갱신의 저장 기반.

### [S22] SQLite foreign keys

https://sqlite.org/foreignkeys.html

확인일: 2026-10-14. 연결 제약 활성화·검증.

### [S23] better-sqlite3

https://github.com/WiseLibs/better-sqlite3

확인일: 2026-10-14. MIT, 동기 SQL driver. native binary 호환성은 P0 검증.

### [S24] OWASP SSRF Prevention

https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

확인일: 2026-10-14. 외부 URL·리다이렉트·내부 주소 접근 방어 근거.

### [S25] Brave Search API

https://api-dashboard.search.brave.com/app/documentation/web-search/get-started

확인일: 2026-10-14. 선택적인 실검색 Provider. 유료/정책 의존 SaaS이며 OSS로 분류하지 않음.

### [S26] Node release schedule

https://nodejs.org/en/about/previous-releases

확인일: 2026-10-14. Node24 LTS를 기본 런타임 후보로 선택.

### [S27] React versions

https://react.dev/versions

확인일: 2026-10-14. 확인 페이지 React19.2. 정확한 patch는 잠금 단계에서 선택.

### [S28] Vite 공식 블로그

https://vite.dev/blog

확인일: 2026-10-14. 8.1 발표 2026-06-23 확인. 최신 patch 보장 아님.

### [S29] pnpm workspaces

https://pnpm.io/workspaces

확인일: 2026-10-14. 내부 모노레포 패키지 연결.

### [S30] Tailwind Vite 설치

https://tailwindcss.com/docs/installation/using-vite

확인일: 2026-10-14. 스타일 토큰·유틸리티 기반.

### [S31] Storybook 테스트

https://storybook.js.org/docs/writing-tests

확인일: 2026-10-14. 상태별 컴포넌트 검증. Chromatic 유료 서비스는 필수 아님.

### [S32] Biome

https://biomejs.dev/

확인일: 2026-10-14. 포맷·정적 품질 도구. lock 단계에 정확한 패키지 라이선스 확인.

### [S33] GitHub Spec Kit

https://github.github.io/spec-kit/

확인일: 2026-10-14. 선택적인 SDD 문서 작업 도우미. Corral 명세/테스트를 대체하지 않음.

### [S34] Drizzle 공식 저장소

https://github.com/drizzle-team/drizzle-orm

확인일: 2026-10-14. Apache-2.0. 안정판 태그·migration 호환성 검증.

### [S35] xyflow 릴리스 조회

https://api.github.com/repos/xyflow/xyflow/releases?per_page=1

확인일: 2026-10-14. 2026-09-24 @xyflow/system@0.0.83 관측; React package version이 아님.

### [S36] Pi 릴리스 조회

https://api.github.com/repos/earendil-works/pi/releases?per_page=1

확인일: 2026-10-14. 2026-10-12 v1.2.0 관측.

### [S37] LangGraph.js 릴리스 조회

https://api.github.com/repos/langchain-ai/langgraphjs/releases?per_page=1

확인일: 2026-10-14. 2026-10-12 @langchain/vue@1.2.4 관측; runtime package version이 아님.

### [S38] Fastify 릴리스 조회

https://api.github.com/repos/fastify/fastify/releases?per_page=1

확인일: 2026-10-14. 2026-10-13 v5.12.7 관측.

### [S39] Vitest 릴리스 조회

https://api.github.com/repos/vitest-dev/vitest/releases?per_page=1

확인일: 2026-10-14. 2026-10-12 v5.0.4 관측.

### [S40] LangGraph core license

https://github.com/langchain-ai/langgraphjs/blob/main/libs/langgraph-core/LICENSE

확인일: 2026-10-14. MIT, 해당 OSS 라이브러리 범위. 외부 호스팅 서비스 조건과 구별.

## 개인 하네스 런타임 의존성 (CR-018, 2026-10-18)

H1에서 검증한 `@earendil-works/pi-coding-agent@1.3.0`을 H2에서 adapter-pi의 runtime dependency로 옮긴다. 새 프레임워크나 별도 확장 로더는 추가하지 않는다. 공개 SDK 타입과 공식 [v1.3.0 SDK 문서](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/sdk.md)를 기준으로 한다. Node >=22.19.0 요구를 동봉 Node 24.19.0이 만족하며, 실제 자식 프로세스 + 로컬 HTTP provider 테스트에서 확인했다. TypeScript 선언이 배포 패키지에 포함된다.

정확한 registry integrity·MIT 라이선스·배포일·전이 의존성은 `dependency-lock.json` 및 `pnpm-lock.yaml`에 고정한다. SDK는 worker에서만 import한다. 기본 core worker와 Studio 브라우저 번들에 SDK를 import하지 않는다. pi-tui, jiti, 이미지 처리 및 향후 MCP/codemode 관련 의존성으로 설치 크기가 증가하며, desktop 패키징 검증은 R1 완료 조건에 포함한다. Native 확장은 샌드박스가 아니며 HOME/XDG/Claude/jiti 경로 격리는 사용자 설정 오염 방지용이다. 엄격 정책에서는 네이티브 확장을 거절한다.

## LSP 통신 (CR-019, 2026-10-18)

- `vscode-languageserver-protocol@3.18.4`를 서버에만 추가한다. [Microsoft의 공개 프로토콜 구현](https://github.com/microsoft/vscode-languageserver-node)을 사용하며 별도 JSON-RPC 프레이머를 만들지 않는다. 공식 저장소의 3.18.4 릴리스 기록과 정확한 npm 배포 타입을 확인했다. Context7 도구는 이 세션에 제공되지 않았다.
- MIT이며 TypeScript 선언을 포함한다. 전이 의존은 `vscode-jsonrpc@9.0.3`(MIT, Node >=14)와 `vscode-languageserver-types@3.18.4`(MIT)뿐이다. 프로젝트의 Node 24.19를 사용한다. npm unpacked 크기는 각각 404,899 / 225,485 / 414,344 bytes(합계 약 1 MiB)이며 Studio 브라우저 의존성이 아니다. 설치 스크립트는 실행하지 않았다.
- 설치 후 production audit에 알려진 취약점이 없음을 확인했다. 실제 LSP 서버는 자동 설치하지 않고 사용자가 등록·검토·신뢰한 argv만 실행한다. 서버 프로세스의 직접 파일/네트워크 접근을 OS 샌드박스로 제한한다고 보장하지 않는다.

## codemode 종료 관찰 패치 (CR-020, 2026-10-18)

- 기존 MIT `@earendil-works/pi-coding-agent@1.3.0`에 버전 고정 [pnpm patch](https://pnpm.io/10.x/cli/patch)를 적용한다. `patches/@earendil-works__pi-coding-agent@1.3.0.patch`가 공식 codemode factory와 tool 옵션에서 `onWorkerStarted(toolCallId, exited)`를 전달한다. 실제 실행기·QuickJS·작업 제한 로직을 복사하거나 교체하지 않는다.
- 설치된 `@earendil-works/pi-codemode@1.3.0`의 공개 `CodemodeSandboxOptions.onWorkerStarted(exited)`를 사용한다. `dist/runtime/host.js`는 실제 Node Worker exit에서만 이 Promise를 해결한다. `sandbox.close()`와 도구 결과는 종료 요청 직후 반환할 수 있으므로 host capacity 반환의 근거로 쓰지 않는다.
- 새 의존성은 없다. JS 두 파일의 콜백 전달 두 줄과 배포 TypeScript 선언 두 곳만 확장한다. 미사용 시 기존 호출자는 동일하게 동작하며 기존 Node >=22.19.0 / 동봉 Node 24.19.0 요구를 유지한다. Studio 브라우저 번들에는 포함하지 않는다.
- patch는 정확한 1.3.0에만 적용한다. Pi 업그레이드 시 공식 옵션 도입 여부, Worker 생성 실패·실제 종료·취소 후 늦은 종료를 다시 검증하고 불필요해진 patch를 제거한다. 일반 CI의 `codemode-lifecycle.test.ts`가 실제 로컬 Worker로 콜백 전달을 확인한다.

## MCP transport와 OAuth (CR-020, 2026-10-18)

이미 Pi coding-agent의 전이 의존성인 `@earendil-works/pi-mcp@1.3.0`을 server/adapter의 직접 의존성으로도 선언한다. [Pi 공식 MCP 패키지](https://github.com/earendil-works/pi/tree/v1.3.0/packages/mcp)의 공개 StdioTransport/StreamableHttpTransport, MCP client, OAuth provider·PKCE callback·flow를 재사용하여 프로토콜과 인증 코드를 다시 만들지 않는다. 설치된 배포의 MIT, Node >=22.19.0, TypeScript 선언, 유일한 자체 의존성 cross-spawn 7.0.6을 확인했다. 기존에 설치된 정확한 버전이므로 새 전이 런타임 패키지는 늘지 않으며 Studio 의존성도 아니다. 직전 production audit는 0 advisories다. 설치 스크립트는 실행하지 않았다. Context7을 검색했으나 제공되지 않아 설치된 1.3.0 공개 선언과 구현을 대조했다.

## CR-035 로컬 브라우저 backend (2026-10-19)

기존 pi-mcp의 stdio/프로세스 lease 경로에 Microsoft의 `@playwright/mcp` **0.0.83**을 정확히 고정했다. Apache-2.0, TypeScript 선언 제공, Node >=18(현재 Node 24.19.0). wrapper와 두 전이 패키지는 설치 시 약 18.4 MiB이며 브라우저 바이너리는 자동 다운로드하거나 개인 프로필에서 가져오지 않는다. 사용자가 지정한 설치된 Chromium 실행 파일까지 실행 fingerprint에 포함한다.

공식 MCP 고정 의존성인 `playwright`/`playwright-core` **1.64.0-alpha-1790635538000**은 별도 검토 예외로 기록했다. 안정판으로 강제 치환하거나 `npx @latest`를 실행하지 않는다. 실제 loopback fixture에서 명시 snapshot·준비 assertion·클릭·결과 assertion·거짓 assertion·외부 origin/redirect 거절·시작 timeout·소유 자식 종료를 검증했다. `pnpm audit --prod`는 조회 시 알려진 advisory 0건이며 무취약 보장은 아니다. 새 런타임은 OS 격리 전 신뢰한 비로그인 로컬 fixture로 제한한다.

`--allowed-origins`는 redirect를 포함한 보안 격리를 보장하지 않으므로 HTTP 응답의 redirect를 거절하고 WebSocket/다운로드를 차단하는 호스트 생성 초기화를 추가했다. 이 브라우저 제약도 운영체제 격리로 표시하지 않는다. ([공식 설정 설명](https://github.com/microsoft/playwright-mcp), [고정 패키지](https://www.npmjs.com/package/@playwright/mcp/v/0.0.83))

### C-106 이미지 정규화

이미 lockfile에 있던 `pngjs@7.0.0`(MIT, Node >=14.19.0)을 서버의 직접 의존성으로 고정하고 `@types/pngjs@6.0.5`(MIT)를 개발 의존성으로 추가했다. 순수 JavaScript PNG 디코더를 서버에서만 사용하므로 브라우저 번들/네이티브 설치가 늘지 않는다. 기존 7.0.0 소스·동기 API와 타입을 확인했고 새 파서를 직접 만들지 않았다. 수신 전에 1 MiB·2048×2048·8-bit RGB/RGBA·non-interlaced 구조를 제한하고 CRC 디코드/재인코드로 부수 메타데이터를 제거한다. 브라우저는 표준 ImageBitmap/Canvas로 PNG·JPEG·WebP를 정규화한다. 레지스트리의 게시일/engine/integrity/license는 dependency-lock에 기록했고 현재 production audit은 0건이다. 유지보수 빈도가 낮은 안정판이므로 새로운 포맷을 열 때는 다시 검토한다. 공식 소스: https://github.com/pngjs/pngjs/tree/v7.0.0


### C-112 웹 본문 추출 (2026-10-19)

이미 설치된 `parse5@8.0.1`을 서버 직접 의존성으로 고정했다. MIT, 자체 TypeScript 선언, 별도 Node engine/peer 요구 없음이며 현재 Node 24.19.0에서 실제 Worker 추출을 검증했다. 표준 HTML 파서로 기존 jsdom/rehype 생태계에서도 사용하는 의존성이다. [공식 parse API](https://parse5.js.org/functions/parse5.parse.html)와 설치 버전의 공개 선언·라이선스를 대조했다. Context7은 이 세션에 제공되지 않았다.

parse5 설치 크기는 약 444 KiB이며 기존 전이 의존성 `entities@8.1.0`(BSD-2-Clause)을 재사용한다. Studio 번들에 넣지 않고 서버의 제한된 Worker에서만 실행한다. DOM/스크립트 실행이나 하위 리소스 fetch는 없다. 입력/출력 1 MiB, 노드 30,000개, 동시 4개, 5초·메모리 상한을 적용하며 취소 시 Worker 종료를 기다린다. 플랫폼 API는 [Node 24.19.0 Worker 문서](https://nodejs.org/download/release/v24.19.0/docs/api/worker_threads.html)를 확인했다. 이 Worker는 응답성·용량 경계이며 OS sandbox라는 보장은 하지 않는다.

registry integrity/배포일/라이선스는 dependency-lock에 기록했다. production audit는 이번 조회에서 알려진 취약점 0건이다. 라이브 HTML/CSS 렌더링과 본문 품질 점수는 제공하지 않으며 발행/수정 시각은 페이지가 선언한 비신뢰 metadata다.

### CR-042 설정 금고와 S3 서명 (2026-10-20)

이미 lockfile에 있던 `@smithy/signature-v4@5.7.4`를 서버의 직접 의존성으로 정확히 고정했다. 설치된 배포의 Apache-2.0, Node >=18, TypeScript 선언, 의존성 `@smithy/core`/`@smithy/types`/`tslib`와 공개 `SignatureV4.sign` API를 확인했다. 현재 Node 24.19.0에서 사용하며 Studio 번들에는 넣지 않는다. 요청 정규화와 AWS 서명은 Smithy가 수행하고 Node SHA-256/HMAC은 얇은 어댑터로 제공한다. 설치 스크립트는 실행하지 않았다. [Smithy 공식 소스 위치](https://github.com/smithy-lang/smithy-typescript/tree/main/packages/signature-v4), [S3 조건부 쓰기](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html).

금고 암호화는 [Node 24.19.0의 crypto](https://nodejs.org/download/release/v24.19.0/docs/api/crypto.html)를 사용한다. AES-256-GCM, 매 암호화마다 새 32-byte salt와 12-byte nonce, 16-byte 인증 태그, 고정 scrypt N=32768/r=8/p=1 및 64 MiB 메모리 한도를 적용한다. 버전·알고리즘·KDF 값은 AAD와 strict schema에 결합한다. 암호는 보관하지 않으며 중단된 적용 journal과 S3 연결 정보도 암호화한다. 실제 loopback HTTP에서 SigV4 헤더, If-Match/If-None-Match, 412 충돌, 업로드 뒤 GET readback을 검증한다. 외부 S3 계정과 실제 cloud write는 이번 검증에 포함하지 않았다.
