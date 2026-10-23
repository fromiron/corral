# CR-048 Ultra 후보 경쟁 — 구현·핵심 검증

- 범위: [CR-048](../change-requests/CR-048-ultra-candidate-tournament.md), C-173 / CRL-ULTRA-004 / TC-ULTRA-004-H,N,F.
- 기준: `e56d6bd`(CR-048 문서) 위 `feat/ultra-tournament`의 구현 커밋. 아래 검증은 커밋 직전 작업 트리에서 실행했다.
- 환경: Linux x64, Node 24.14.0, pnpm 10.30.3. 모델 응답은 결정적 fixture이며 외부 유료 호출은 없다.

## 구현

1. `UltraSelection` version 2(후보·고도화 라운드·자동 반영)와 snapshot의 `mode`·`fallbackReason`을 추가했다. 작업 사본과 후보 사본·복원·diff·Linux 격리가 있으면 후보 경쟁, 없으면 협업이다. version 1은 그대로 해석한다.
2. 후보 그래프에 검토 모델의 `judge` 노드를 두고 검사 통과 후보만 A–E 익명 라벨로 판정한다. 판정은 strict JSON으로 받고 host가 라벨·순위·차용 파일을 검증하며, 무효면 한 번 다시 묻고 그래도 무효면 직접 선택으로 넘긴다.
3. 우승 Loop의 다음 회차로 작성·종합(등록 검사 포함)을 다시 실행하고 판정 모델이 직전 채택본과 비교한다. 폐기 라운드는 서버의 `restoreCandidate`로 사본을 채택 tree로 되돌린 뒤 tree 일치를 확인한다.
4. 기존 승격 경로로 `auto_apply_<runId>` 명령을 사용자 확인 없이 한 번 실행한다. 거절되면 `auto_apply_held`로 사유를 남기고 직접 선택을 연다.
5. version 2 Run은 Run 기한·호출 시간 제한·예산/진행 없음 gate·recipe/후보/Ultra allowance를 적용하지 않는다. 호출당 허용량은 worker가 모델 카탈로그 최대값으로 낮춘다.
6. Studio 선택 화면은 version 2 조작(후보 수·모델, 고도화 라운드, 자동 반영, 한도 없음 안내)으로 바꿨다. 후보 비교 화면은 판정·라운드·보류 사유, 우승 표시, 보류/판정 실패에서의 직접 선택, 고도화 중단을 보여 준다. 사용량 화면은 version 2에서 한도 대신 확인된 출력·호출 수·진행 중·미확인 호출을 보여 준다. CLI `exec auto --ultra`는 version 2를 보낸다.
7. 새 의존성은 없다. Corral 정의 노드 상한을 27에서 28로 올리고 생성 JSON Schema를 갱신했다.

## 실패 재현과 핵심 회귀

| 확인 | 결과 |
|---|---|
| 구현 전 `packages/core/test/ultra-tournament.test.ts` | 14개 중 13 FAIL(version 2 선택 거절), version 1 유지 1 PASS |
| 같은 파일 구현 후 | 14 PASS. 익명 판정·고도화 수용/폐기·자동 반영 1회·단일 통과 후보·무효 판정 재시도·실패 후보/없는 파일 차용 거절·검사 실패/퇴보 폐기·보류 후 직접 선택·자동 반영 끔·기한/호출 시간 없음·협업 전환·version 1 유지·우승 취소·판정 중 Run 취소·재시작 |
| 호출당 출력 상한 helper | 구현 전 FAIL, 구현 후 PASS |
| 실제 Git 후보 사본 diff·정산 전 복원 거절·복원 후 tree/파일 | 구현 전 FAIL(메서드 없음), 구현 후 기존 포함 4 PASS |
| Studio 선택 화면·후보 비교(보류·고도화 중단)·사용량 화면 단위 | PASS |
| core·contracts 전체 | 71 파일 468 PASS |
| 전체 `vitest run` | 1984 PASS, 3 FAIL. `locales`(DebuggerSettings.attachHint)와 `markdownAgentImport`(full graph)는 `main`에서도 같은 실패. `workbench-journey`는 전체 실행 부하에서만 실패했고 단독 3회 PASS |
| E2E `auto-regressions` TC-ULTRA-003-H(재빌드한 Studio·실제 서버·mock 모델) | 1 PASS. UI가 version 2를 보내고 작업 사본 없는 요청이 협업으로 성공 |
| 전체 typecheck, `contracts:check` | PASS |
| Biome | 새 오류 없음. 기존 `packages/react/src/ui/icons.ts` 정렬 오류 1건 유지, non-null assertion 경고 증가 |

## 실제 화면

- 데모 Studio(시뮬레이션)에서 `/ultra` 선택 화면: 참여 모델, 검토·판정 모델, 후보 2개와 모델, 고도화 라운드 2, 자동 반영 켬, 사용량 한도 없음 안내가 표시되고 가로 넘침이 없다.
- 첫 시도에서 데모 런타임이 version 2 협업 전환을 반영하지 않아 “Ultra model reasoning metadata changed”로 거절되는 것을 재현해 고쳤다. 고친 뒤 같은 요청이 시작되고 사용량 화면에 “이 실행에는 사용량 한도가 없습니다”가 표시된다.
- 데모 실행은 두 번째 종합에서 `review_recipe:repeated_output`으로 끝났다. 시뮬레이션 종합 응답이 같은 문장을 반복하기 때문이며 `main`의 version 1 데모도 같은 단계에서 같은 사유로 끝나는 것을 확인했다.

## 확인하지 못한 범위

- 실제 서버·관리 사본·Linux 격리·등록 검사로 version 2 후보 경쟁 전체(판정·고도화·복원·자동 반영)를 한 번에 실행한 통합 검증은 하지 않았다. core 결정적 시험, 실제 Git diff/복원 단위, 기존 C-114 승격 검증으로 나눠 확인했다.
- 실제 공급자 호출, 판정·고도화의 품질 향상, 비용, 다른 OS·설치판, 스크린리더는 확인하지 않았다.
- 후보 비교 화면의 판정·고도화 상태는 단위 시험으로만 확인했고 실제 화면 캡처는 없다.
- 시작 전 실행 방식 예측 표시는 구현하지 않았다. 실제 방식은 시작 응답과 Run snapshot에 계획 호출 전에 기록된다.
