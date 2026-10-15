# P6–P9 셀프 리뷰 수정과 실제 동작 점검

2026-10-15, Linux x64, pnpm 10.30.3. 셀프 리뷰에서 확인한 17개 항목을 수정했다. 아래 테스트는 반례가 수정 전 실패하는 것을 확인한 뒤 수정 후 실행했다. 전체 후보의 최종 판정은 source SHA256에 묶인 `test-results/release/evidence.json`으로 확인한다. 개별 증거가 현재 후보의 전체 gate 결과를 대신하지 않는다.

## 수정 연결

| # | 문제와 수정 | 회귀 검증 위치 |
|---|---|---|
| 1 | 인코딩·absolute URL이 인증 hook을 우회했다. Fastify가 매칭한 route와 파싱한 query로 인증·CSRF·rate 경계를 판단한다. | `apps/server/test/server.test.ts` |
| 2 | 두 번째 서버/CLI가 사용 중인 workspace를 복구했다. 별도 SQLite 소유권 DB의 OS lock을 복구 이전에 획득하며 startup 실패·정상 종료·SIGKILL 뒤 해제된다. | server `workspace-ownership.test.ts`, storage `ownership.test.ts`, CLI `cli.test.ts` |
| 3 | paused 상태의 task restart가 실행을 재개했다. 명시적 resume 이전에는 거절하며 UI에도 같은 경계를 표시한다. 개별 취소도 pause를 유지한다. | core `reins-boundary-regressions.test.ts`, React `reins-controls.test.tsx` |
| 4 | pausing 중 실패가 유실됐다. 실패 결과를 보존하고 resume 이후 확정한다. | core `reins-boundary-regressions.test.ts` |
| 5 | 무진전 승인을 기다릴 때 pause가 끝나지 않았다. 승인 대기를 안전 경계로 처리하고 resume 후에도 승인 대기를 유지한다. | core `reins-boundary-regressions.test.ts` |
| 6 | 다음 Loop 라운드에서 artifact version이 중복됐다. 마지막 실제 version에서 증가한다. | core `reins-boundary-regressions.test.ts` (1→2→3) |
| 7 | LangGraph 재귀 제한이 초기 Loop 값에 고정됐다. 설치 hard cap 기준으로 계산하여 patch·승인으로 허용된 10회가 실제 runner에서 실행된다. | `packages/runner-langgraph/test/runner.test.ts` (참조 runner와 parity) |
| 8 | ask/reply question ID를 artifact 본문으로 취급하여 private archive를 열 수 없었다. 답변 완료 question 참조와 본문 참조를 구분하고 누락 참조는 계속 거절한다. | core `history.test.ts` (실제 협업 성공·export·reopen·변조) |
| 9 | 단일 대형 SSE 기록에서 cursor가 전진하지 않았다. backlog를 flush하고 대형 domain record 하나를 분할 전송한 뒤 재접속한다. client는 domain schema 검증 후 cursor를 전진시킨다. | server `sse.test.ts`, client `sse.test.ts`; [CR-002](../../../docs/change-requests/CR-002-oversized-domain-replay.md), ADR-023 |
| 10 | 응답 유실 후 새 command ID로 중복 지시를 만들었다. 원래 payload/ID를 보존하여 receipt 조회 또는 동일 명령 재전송으로 복구한다. | React `run-session.test.ts`, Studio `e2e/server/reins-recovery.spec.ts` |
| 11 | 늦은 open/start 응답이 현재 Run과 구독을 바꿨다. generation으로 응답·오류·구독 callback을 차단하고 이전 구독을 해제한다. | React `run-session.test.ts` |
| 12 | 미전송 draft가 다음 Agent로 옮겨갔다. draft를 원래 execution에 연결하고 사용자가 명시적으로 대상을 바꾸도록 한다. | React `reins-panel.test.tsx`, Studio `e2e/reins-recovery.spec.ts` |
| 13 | crash 복구 후 질문·승인이 계속 pending이었다. 질문을 cancelled, 승인을 stale로 종료하며 replay해도 같은 상태가 된다. | core `reins-boundary-regressions.test.ts` |
| 14 | 늦은 usage의 세부 항목·rawUsage가 사라졌다. `model.usage_reconciled`로 새로 확인된 항목만 보충하고 실행/본문/완료 상태를 바꾸지 않는다. | core `late-usage.test.ts`, event catalog·생성 JSON Schema·API 계약 |
| 15 | corpus 검색이 event loop를 수 초 막았다. 문서를 한 번 정규화하고 문서 사이 yield·취소 검사를 추가했다. | server `inputs.test.ts` (32MiB corpus와 취소) |
| 16 | release gate가 prerelease·Node·peer 검토를 강제하지 않았다. 설치 tree와 exact version 검토 기록을 대조하는 필수 `dependencies` gate를 추가했다. | `tools/release/dependencies.test.ts`, `tools/deps/check.ts` |
| 17 | 성능 gate가 HTTP·SQLite를 지나지 않았다. 같은 Run의 100개 과거 실행·10,000개 persisted event로 실제 서버 경로를 측정한다. 이 검사가 드러낸 receipt 전체 재조회·과거 이벤트 재파싱도 줄였다. | Studio `e2e/performance/`, React `run-session.test.ts`, core `reins.test.ts`; [원본 성능 근거](../../../docs/Performance.md) |

## 보안 수정 판정

항목 1의 판정은 **fixed**다. 비인증·CSRF 누락 요청이 인코딩/absolute URL과 raw `#` query를 통해 인증된 API 경계를 넘던 반례를 차단했다. 수정 전 3개 우회 반례와 별도 query-parser 반례의 실패를 확인했다. health/bootstrap/static 및 정상 session+CSRF 요청은 계속 동작한다. 독립 조사와 수정 후 별도 reviewer가 확인했으며, 최종 변경 뒤 server 보안 9개 테스트가 통과했다. 이 판정은 해당 route/인증 경계에 한정하며 모든 향후 보안 위험이 없다는 뜻은 아니다.

## 실제 앱 조작과 기록 대조

에이전트 구현 종료 후 별도 임시 workspace에서 production Studio와 실제 로컬 서버·SQLite를 실행했다. 외부 모델을 끈 `--no-live`와 모의 adapter를 사용했다. headed Chromium에서 화면 snapshot을 읽고 실제 입력·버튼·네트워크 전환으로 다음을 확인했다.

- JSON import → Run → 지시 전송 → pause 접수 → 활성 요청 drain → Paused 및 Applied receipt. pause 동안 새 모델 요청이 추가되지 않았다.
- reviewer 미래 prompt 변경의 Current→Proposed·scope preview → 확정 → resume. SQLite 기록에서 patch가 새 reviewer execution에만 활성화되고 기존 writer에는 적용되지 않은 것을 확인했다.
- reviewer 지시가 Delivered로 바뀌고 최종 output에 포함됐다. 오프라인 후 재연결·reload 시 성공 상태, 최종 텍스트, 사용량을 기록에서 복구했다. 최초 writer의 마지막 요청 이후 접수한 지시는 전달 완료로 오표시하지 않고 expired로 끝났다.
- 개별 실행 취소 → required task Blocked → Run은 Waiting for you. pause 후 전체 취소를 오프라인으로 전송하면 미확인 receipt가 표시됐다. 온라인 복구 뒤 안전 재시도는 원래 command ID를 유지했고 Run이 Cancelled로 종료됐다.
- 실제 협업 Run에서 부모가 기다리는 자식을 취소했다. paused 상태에서는 입력을 채워도 restart가 비활성화되며 resume 안내가 표시됐다. 명시적 resume 후 새 execution의 Attempt 2가 생기고 이전 Cancelled execution이 보존됐다. 이어서 전체 취소한 DB 기록에서 활성 후손이 없는 것도 확인했다.
- CLI `inspect`, private `export`, `inspect --archive`를 실제 프로세스로 실행했다. 성공 Run의 89개 event·projection이 SQLite 원본과 archive 재생 결과에서 정확히 일치했다.

브라우저 snapshot·화면·CLI 기록은 로컬 `test-results/manual-review/`에 보관한다. 사용자 본문과 credential이 없는 합성 입력만 사용했으며, bootstrap 로그·cookie는 결과물에 복사하지 않는다. 오프라인 점검 때 발생한 네트워크 실패와 receipt 미존재 404는 주입한 조건에 따른 결과다. 정상 완료 페이지의 console error는 0개였다.

## 최종 검증과 한계

새 의존성 gate가 기본 Node 24.14와 설치된 jsdom 계열의 Node 요구 불일치를 발견했다. 지원 조건을 Node `^24.15.0`, 기준을 `.node-version`의 24.19.0으로 맞췄으며 최종 통합 검증은 번들된 Node 24.19에서 수행한다. 시스템 Node는 변경하지 않았다. 기존 `semver@7.8.5`를 개발 의존성으로 명시하고 TypeScript 선언을 추가한 근거·라이선스·audit 결과는 [Release](../../../docs/Release.md)에 있다.

```sh
CORRAL_PYTHON=/path/to/venv/bin/python pnpm release:gate
pnpm release:check
```

첫 명령은 13개 결정적 gate와 source hash를 기록한다. 두 번째는 현재 후보의 bounded live smoke가 없을 때 반드시 실패해야 한다. live 요청 자체를 실행하는 명령이 아니다. 검증 중 source를 바꾸면 결과를 재생성한다.

통합 실행에서 기존 SSE text 테스트의 구독 준비 경합도 발견했다. 별도 snapshot이 먼저 도착하면 실제 text 구독 이전에 모의 응답을 방출하던 테스트였으며, SSE 연결을 40ms 지연시켜 같은 timeout을 재현했다. 해당 구독이 `model.request_prepared`를 수신한 뒤 응답을 방출하도록 동기화했고, 모든 text가 최종 본문과 같다는 검증은 유지했다. 테스트 timeout을 늘리지 않았다.

workspace 소유권은 Linux 로컬 filesystem에서 검증했으며 다른 OS/network filesystem은 미검증이다. SSE는 제한된 backlog 외 현재 domain record 하나의 직렬화·파싱 메모리가 필요하다. 미확인 command outbox는 탭 내 이동에서 보존되며 browser refresh 영속화는 제공하지 않는다. 실제 유료 모델/Brave, OS IME·screen reader 수동 검증, 다른 장비의 성능, hosted CI·배포는 이번 검증에서 실행하지 않았다. production bundle 500kB 경고가 남는다.
