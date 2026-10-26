# 기능 명세: 데모·출시 — 측정 가능한 출시 근거

- 기준: [제품 계약](../product-contract.md) §10.3.
- 비목표: 자동 공개 배포, 비용 발생 공급자 호출 자동화, v0.2 DecisionProvider, v0.3 중첩 Corral, crash resume.

## 수용 조건

1. `pnpm test:performance`는 개발 서버를 측정하지 않는다. production 최적화 fixture를 별도 빌드하고 Chromium·1280×800·장비·Node·실제 JS/CSS hash를 기록한다. 정상 앱 빌드에서는 `/performance`가 열리지 않는다.
2. fixture는 같은 Run의 20개 설계 노드, 100개 완료 실행과 활성 실행, SQLite에 commit한 10,000개 과거 이벤트를 실제 HTTP/SSE·RunSession·Timeline·Canvas로 재생한다. 로컬 서버 Coordinator를 통과하는 100개의 지시와 초당 50개 목표 텍스트 프레임 중 HTTP 접수 p95≤200ms, 서버 domain commit→다음 paint 기회 p95≤300ms를 검사한다. 실제 수신률도 기록하고 49fps 미만이면 실패한다.
3. Timeline DOM은 60행 미만이며, 상태가 달라지지 않는 수신 부하에서 canvas DOM 변경은 0이다. 같은 측정 중 드래그가 작동해야 한다. React commit 회귀는 기존 canvas render-budget 단위 테스트가 따로 검사한다.
4. CDP CPU profile, 집계 flamegraph, 서버 commit 시각과 개별 latency samples를 저장한다. commit 전후 각각 500ms를 주입한 반례가 두 latency 예산을 모두 실패시키는지 검사한다. 합성 agent 부하로 실행한 로컬 HTTP/SSE/SQLite 측정을 실제 LLM 또는 원격 네트워크 성능이라고 부르지 않는다.
5. 일반 개발·PR CI의 기본 E2E는 Chromium에서 대화 전송·재접속과 캔버스 연결을 확인하는 두 스모크만 실행한다. 상세·다중 브라우저 시나리오는 명시적으로 실행하는 확장 검사다. release gate는 의존성·계약·lint·typecheck·unit/contract/integration/Storybook axe·확장 브라우저 E2E·성능·라이선스/SBOM을 실행한다. 하나라도 실패하면 증거 상태는 실패다. 실행 방법과 테스트 선택 기준은 [테스트 운영](../../guides/testing.md)을 따른다.
6. 모든 증거를 동일한 source SHA256에 묶는다. 유료 smoke는 일반 gate에 포함하지 않는다. 별도 opt-in smoke의 동일 source·성공·최대 10 calls/256 output tokens per call을 확인해야 최종 `release:check`가 통과한다. 없는 결과·실패 결과·다른 source 결과를 통과로 취급하지 않는다.
7. 패키지 inventory는 실제 설치된 모든 전이 의존성의 버전과 선언 라이선스를 담고, 알 수 없는 라이선스는 release를 막는다. SPDX JSON과 배포된 notice를 생성하되 로컬 설치 경로를 출력하지 않는다.

## 검증 연결

- 성능: `apps/studio/e2e/performance/performance.spec.ts`와 canvas render-budget 단위 테스트.
- 출시 gate: `tools/release/release.test.ts` 및 opt-in live smoke.

