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
| 4 | C-070·C-071 | 외부 provider 경계, Run 화면 판정 표시, `corral inspect` 비교 | 완료(PR 대기) |
| 5 | UX-A3 | 실행별 대화(transcript) 뷰: 모델 턴·도구·질문/답변·지시 배지 스트리밍 | 대기 |
| 6 | UX-A4 | Timeline 문장화, 상태 reason 문구, 예산 미터 축약, Decision 노드 상태, 그래프 fitView | 대기 |
| 7 | UX-A5 | 명령 팔레트(⌘K)·단축키 도움말·빈 상태·템플릿 갤러리·한국어 locale | 대기 |
| 8 | Core-③ | `corral exec` headless + 단일 에이전트 vs 팀 비교 eval harness | 대기 |
| 9 | Core | 특정 버전에서 새 Run 시작(fork from version) | 대기 |
| 10 | Core | Goal → 팀 초안 생성(사람 승인 후 편집기) | 대기 |
| 11 | Core | Pi provider 확장(API key: OpenAI·Anthropic·OpenAI 호환·Ollama) | 대기 |
| 12 | Core·보안 | OS 표준 인증 파일 사용: Codex CLI 로그인(`~/.codex/auth.json`) 재사용과 Corral 자격 증명의 OS 표준 설정 디렉터리. CR-001 변경이므로 CR-004 먼저 | 대기 |

## 진행 기록

- 2026-10-16 Bell 요청: 인증은 OS 기본 인증 디렉터리 파일을 쓰는 편이 좋다. GPT OAuth 파일은 `/home/bell/.codex/auth.json`(Codex CLI). → 12번 항목으로 추가. 파일 내용은 출력하지 않는다.

(항목이 끝날 때마다 PR 링크와 검증 결과를 한 줄로 남긴다.)

- C-068·C-069: PR #10 병합. 504 unit, E2E chromium·server 39.
- C-072: PR #11 병합. 실모델 opt-in 테스트 통과, 판정 ≈20 ms.
- C-070·C-071: 520 unit, E2E 68(chromium·firefox·server).
