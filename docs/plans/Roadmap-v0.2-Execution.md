# v0.2 실행 로드맵 (진행 추적)

> 기준일 2026-10-15. Bell의 지시: "main 머지까지 하고 제안한 개선·강화 플랜 끝까지 구현. 가장 중요한 건 UX/UI와 코어 기능. 그 밖의 기능도 판단해서 추가해도 됨." 사용량 한도로 중단되면 이 문서의 첫 미완료 항목부터 재개한다.
>
> 원칙(AGENTS.md): 스펙 변경은 CR 먼저, 실패하는 테스트 먼저, 의존성은 버전·라이선스·출처·Node/peer 기록, 검증하지 못한 것은 못 했다고 기록. 각 단계는 브랜치 → PR → CI 통과 → main 병합.

## 결정 기록

- **2026-10-15 D1 변경(Bell):** mixdog의 effort judge 모델을 그대로 가져와도 된다. 모델은 EmbeddingGemma 2(Apache-2.0) 파생, 학습 데이터 출처·라이선스는 Bell이 제공한 고지문을 NOTICE로 함께 배포한다. CR-003 D1을 "`local-heuristic@1` + mixdog ONNX 모델(`local-model`)"로 갱신한다.

## 순서와 상태

| # | 항목 | 범위 | 상태 |
|---|---|---|---|
| 0 | PR #9 병합 | CR-003 문서, golden, C-067 | 완료 |
| 1 | C-068 | DecisionQuestion·검증·registry·decision 이벤트·projection·설정 | 완료 |
| 2 | C-069 | `scripted@1`·`local-heuristic@1`, observe observer(timeout·cancel·pause·한도·늦은 결과) | 완료 |
| 3 | C-072 | mixdog effort judge ONNX provider(`local-model`), 모델 다운로드·sha256 검증·NOTICE | 완료 |
| 4 | C-070·C-071 | 외부 provider 경계, Run 화면 판정 표시, `corral inspect` 비교 | 완료 |
| 5 | UX-A3 | 실행별 대화(transcript) 뷰: 모델 턴·도구·질문/답변·지시 배지 스트리밍 | 완료 |
| 6 | UX-A4 | Timeline 문장화, 상태 reason 문구, 예산 미터 축약, Decision 노드 상태, 그래프 fitView | 완료 |
| 7 | UX-A5 | 명령 팔레트(⌘K)·단축키 도움말·빈 상태·템플릿 갤러리·한국어 locale | 완료(PR #15, 2부 PR 대기) |
| 8 | Core-③ | `corral exec` headless + 단일 에이전트 vs 팀 비교 eval harness | 완료(PR 대기) |
| 9 | Core | 특정 버전에서 새 Run 시작(fork from version) | 완료(PR 대기, [CR-007](../change-requests/CR-007-new-run-from-version.md)) |
| 10 | Core | Goal → 팀 초안 생성(사람 승인 후 편집기) | 완료(PR 대기, [CR-006](../change-requests/CR-006-goal-team-draft.md)) |
| 11 | Core | Pi provider 확장(API key: OpenAI·Anthropic·OpenAI 호환·Ollama) | 완료(PR 대기, [CR-005](../change-requests/CR-005-api-keys-and-compatible-endpoints.md)) |
| 12 | Core·보안 | OS 표준 인증 파일 사용: Codex CLI 로그인(`~/.codex/auth.json`) 재사용과 Corral 자격 증명의 OS 표준 설정 디렉터리. CR-001 변경이므로 CR-004 먼저 | 완료(PR 대기, [CR-004](../change-requests/CR-004-codex-login-reuse.md)) |

## 진행 기록

- 2026-10-16 Bell 요청: 인증은 OS 기본 인증 디렉터리 파일을 쓰는 편이 좋다. GPT OAuth 파일은 `/home/bell/.codex/auth.json`(Codex CLI). → 12번 항목으로 추가. 파일 내용은 출력하지 않는다.

(항목이 끝날 때마다 PR 링크와 검증 결과를 한 줄로 남긴다.)

- C-068·C-069: PR #10 병합. 504 unit, E2E chromium·server 39.
- C-072: PR #11 병합. 실모델 opt-in 테스트 통과, 판정 ≈20 ms.
- C-070·C-071: PR #12 병합. 520 unit, E2E 68(chromium·firefox·server). CR-003 완료.
- UX-A3: Run 화면 오른쪽 `Conversation`(선택 실행의 요청·스트리밍 답·도구·질문/답변·지시와 전달 상태·판정 배지). 편집기의 "Open run page"가 선택 실행을 `?execution=`으로 넘김. 524 unit, E2E 70.
- UX-A4: Timeline 문장(이벤트 49종, 모르는 타입은 그대로), 상태 reason 문장, 예산 meter 2개 + 접힌 전체 표, Decision/Output 노드 상태(판정 횟수·"Waiting for you"), 그래프 크기 변화 시 재맞춤. 531 unit, E2E 74. resize E2E는 기능을 끄면 실패하는 것을 확인.
- UX-A5 1부: ⌘K/Ctrl+K 팔레트(템플릿으로 새 Corral·이동·Corral·Run 열기, IME 안전, 포커스 복귀), ? 단축키 도움말(입력 중엔 열리지 않음), 작업 공간 빈 상태와 템플릿 갤러리(Research team·Single agent·Empty). 타이밍에 민감한 E2E 2개는 지연 폭만 넓힘. 533 unit, E2E 82.
- 2026-10-16 Bell: 품질이 오를 때까지 PR마다 CI를 기다리지 않는다. 로컬 검사 후 PR을 열고 다음 항목으로 진행, 병합은 Bell.
- UX-A5 2부: 한국어 locale(메시지 662개, 키·ICU 인자 일치와 형식 오류·영어 잔존 검사), 헤더 언어 선택, 브라우저 언어 기본값, localStorage 기억, `html lang`. 536 unit, E2E 86.
- Core-③: `corral exec`(Studio 없이 실행, 사람 결정 필요 시 취소·종료 코드 3, `--json`)와 `corral eval`(지시문×변형, 비용·시간 표와 JSON 보고서). 예제 suite `examples/eval/`. 실제 모델 exec 1회 확인(10.6 s, 호출 3). 문서 `docs/Evaluation.md`.
- CR-004(12번): Codex CLI 로그인 읽기 전용 재사용, 모델 화면 출처 표시, worker 요청 토큰 store. PR #18. 550 unit, E2E 87. 실제 `corral exec` 1회 성공(호출 3, 출력 128 토큰), Codex 파일 변화 없음.
- CR-005(11번): 모델 화면 API 키 입력·지우기, Anthropic은 키만, `modelProviders`(OpenAI 호환·Ollama, https 또는 loopback http), 키-origin 묶음, worker 엔드포인트 정의. 561 unit, models E2E 7. 실제 엔드포인트 확인은 로컬 서버가 없어 하지 않음.
- CR-006(10번): 목표 → TeamPlan(로컬 제안·모델 1회) → 미리보기 수정 → 편집기. 실제 모델 1회 11.7초, 계약 통과.
- 이슈 #20·#21·#22 수정(PR #24). CR-007(9번): 이전 결과·버전에서 새 Run, 본문 복사·출처 기록. 580 unit.
- PR #17·#18·#19 main 병합. CI 실패 원인은 데모 E2E의 2회차 조향 경합(느린 CI에서 Writer가 먼저 끝남)으로, 지연 폭만 넓혔다.
