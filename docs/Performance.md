# 고정 부하 production 성능 측정

C-048은 `pnpm test:performance`로 실제 로컬 서버, SQLite, HTTP 명령과 SSE, production Studio를 함께 측정한다. 이전 in-process benchmark는 서버 접수·영속화 비용을 포함하지 않아 §10.3의 출시 근거로 충분하지 않았다. 수정된 gate는 처음 실행에서 지시 접수 p95 **469.7ms**를 기록하여 200ms 목표를 실제로 실패했다([수정 전 원본](performance/before-server-fix.json)).

**2026-10-15 21:37 JST 최종 실행은 2개 테스트 모두 통과**했다. 서버는 receipt가 접수된 sequence부터 필요한 이벤트를 읽고, UI는 관련 상태가 바뀐 미완료 receipt만 갱신한다. 이 실행의 고정 workload에서 접수 p95는 **21.80ms**, 영속 이벤트→UI p95는 **16.00ms**다.

| 조건·측정 | 이 실행의 값 |
|---|---|
| JS/CSS build SHA256 | `27b9920dcb3e1d96ba4d4168f027dcb204a0de2e3b7b48372b6ed1f2379f1e07` |
| 브라우저 / 화면 | Chromium 156.0.8078.4 / 1280×800 |
| CPU / 메모리 | AMD Ryzen 5 5600X / 논리 CPU 12 / 33,566,945,280 bytes |
| Node | v24.19.0 |
| 지시 / domain samples | 100 / 100 |
| 측정 길이 / 실제 수신 | 12,116ms / 606 frames / 50.02fps |
| Timeline DOM / 고정 상태 canvas 변경 | 20행 / 0건 |
| 부하 중 드래그 | 성공 (2,512건의 상호작용 DOM 변경) |

CPU sampling을 활성화한 실행이다. 수정 전 실패 snapshot은 Node 24.14.0, 최종 실행은 저장소 engine 범위에 맞는 Node 24.19.0이므로 두 수치를 런타임까지 통제한 별도 A/B 실험으로 표현하지 않는다.

## 고정 부하와 경로

- production Vite `build --mode performance`, Chromium 156, 1280×800, worker 1, retry 0. 일반 앱 build에는 `/performance` fixture가 없다.
- 각 테스트는 새 임시 workspace, 실제 `startCorralServer`, `SqliteRunStore`를 사용한다. SQLite 설정은 WAL·`synchronous=FULL`이다. 사용자 workspace와 DB를 사용하지 않는다.
- 노드 20개: 바깥 entry 1, Loop 안 Agent 16, Loop·Decision·Output 각 1. 실제 LangGraph/Coordinator가 100개의 실행을 완료하고 101번째 실행을 모델 요청 경계에 유지한다. 과거 실행과 새 이벤트가 **같은 Run projection**에 쌓인다.
- 완료된 합성 응답의 중복 관측을 `AgentHost.observe`로 전달해 최초 이벤트를 정확히 10,000개로 맞춘다. 모두 실제 Coordinator 판정과 SQLite 트랜잭션으로 기록된다. DB·projection·sequence를 임의로 주입하거나 transport에서 이벤트 번호를 바꾸지 않는다.
- 브라우저는 `HttpSseTransport`로 저장된 10,000개 이벤트를 SSE replay하여 실제 RunSession·Timeline·RunView를 채운다. 측정 중 지시 100개는 실제 HTTP 인증·CSRF·Coordinator·SQLite·receipt 경로를 거친다.
- 텍스트는 20ms 간격 목표(50fps)로 서버 AgentHost에서 발행한다. 프레임마다 ASCII `x` 1자다. 브라우저에서 실제 수신한 frame 수와 RunView에 표시된 텍스트를 검사한다.
- 측정 끝에 SQLite를 읽기 전용으로 다시 열어 이벤트 10,100개, 명령 101개(start 포함), 실행 101개를 확인한다. 합성 응답과 중복 관측은 고정 workload이며 실제 LLM의 응답 속도나 작업 품질을 나타내지 않는다.

## 측정과 실패 기준

| 측정 | 시작·종료 | 실패 조건 |
|---|---|---|
| 지시 접수 p95 | 브라우저 RunSession.steer 호출 → 실제 HTTP receipt 반환 | >200ms |
| 영속 이벤트 반영 p95 | SQLite commit 이후 서버 subscriber → 해당 sequence의 React layout effect 후 requestAnimationFrame | >300ms |
| incoming frame rate | 측정 중 실제 SSE 수신 frame 수 / 측정 시간 | <49fps |
| Timeline DOM | 실제 가상 목록 행 수 | ≥60 |
| 고정 상태의 canvas DOM 변경 | 이벤트·텍스트 수신 중 MutationObserver | >0 |
| 수신 부하 중 캔버스 드래그 | 실제 노드 위치 변경 | 위치 변경 실패 |

p95는 전체 sample을 정렬한 nearest-rank 95번째 백분위다. receipt는 브라우저 monotonic clock을 사용한다. 서버 commit 이후 callback과 브라우저 UI 시각은 같은 장비의 `Date.now()`로 연결하므로 해상도는 1ms다. 두 endpoint의 원본 시각과 event ID, 계산한 latency를 함께 저장한다. UI 종료점은 **paint 기회**이며 화면 픽셀 완성 시각을 직접 측정한 것이 아니다. commit 전 직렬화·트랜잭션 시간은 receipt 지연에 포함된다.

별도 음성 테스트가 서버 명령 처리 전 500ms 정지와 commit 후 SSE 전달 500ms 지연을 주입한다. 실제 명령·저장·SSE 경로는 그대로 실행하고 동일한 latency 판정 함수가 두 예산 위반을 모두 검출해야 테스트가 통과한다. 주입은 E2E harness에만 존재한다. 최종 음성 실행은 receipt p95 528ms, 영속 이벤트→UI p95 628ms로 두 위반을 모두 검출했다([원본](performance/delay-detection.json)).

## 재현과 증거

```sh
pnpm test:performance
```

Playwright의 global setup은 production fixture를 새로 build하고, 각 테스트가 로컬 서버를 시작하고 종료한다. 결과는 `test-results/performance/`에 개별 latency 배열, 장비·Node·브라우저·JS/CSS SHA256, CPU profile, flamegraph, 지연 검출 JSON으로 저장한다. 실패한 실행에는 trace가 남는다. release gate의 필수 `performance` 단계가 이 명령을 실행하므로 서버 부하 검사를 생략한 채 통과할 수 없다.

- [원본 개별 sample과 메타데이터](performance/measurements.json)
- [CPU profile](performance/cpu-profile.cpuprofile) · [CPU flamegraph](performance/cpu-flamegraph.svg)
- React commit 회귀는 `packages/react/test/canvas-render-budget.test.tsx`가 별도로 검사한다. MutationObserver만으로 동일 DOM을 생성하는 모든 React render까지 측정했다고 주장하지 않는다.

초기 로딩·모바일·다른 장비·무기한 실행·실제 모델 지연은 이 측정의 범위가 아니다. production JS의 500kB chunk 경고도 별도 한계로 남는다. 성능 gate 통과는 hosted 검증이나 유료 live smoke를 포함한 최종 출시 승인이 아니다.
