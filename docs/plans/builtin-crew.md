# 기본 제공 스킬·에이전트와 템플릿 개편: 작업 계획

Corral에 바로 쓸 수 있는 스킬 묶음과 에이전트를 함께 싣고, 템플릿을 그 에이전트로 다시 짠다. 발상은 poteto의 pstack(Cursor `cursor/plugins`의 `pstack/`, MIT)에서 왔다. 글과 구조를 옮겨 오는 것이 아니라 역할(설계, 구현, 반증, 검증, 심사 …)과 개념(먼저 깊이 이해하기, 가장 작은 변경, 실행으로 증명하기, 나란히 시켜 보고 고르기)을 이어받아 Corral의 스킬·에이전트·팀 그래프로 미리 짜 두는 것이다.

명세: [기본 제공 스킬과 에이전트](../specs/features/builtin-crew.md)(새로 씀), [라이브러리](../specs/features/library.md), [스킬 라이브러리](../specs/features/skill-library.md), [에이전트 라이브러리](../specs/features/agent-library.md), [하네스 계약](../specs/harness-contract.md).

브랜치는 `feat/builtin-crew`이고 `develop`(`c1202f8c`)에서 갈라졌다. 단계마다 명세 → 실패하는 테스트 → 구현 순서로 하고 단계마다 커밋한다. E2E는 건드린 spec만 돌리고 전체는 맨 끝에 한 번 돈다.

| 단계 | 내용 | 상태 |
|---|---|---|
| 0 | 결정 받기, 명세, 이 계획 | 끝 |
| 1 | 스킬 규칙: 확장 없는 묶음은 설치하면 신뢰, 기본 제공 묶음 자동 설치와 버전 잇기, 지정 스킬 + 그 밖에 쓸 수 있는 스킬, 해석기 없는 모의 실행 | 대기 |
| 2 | 내용: `coding` 묶음의 스킬 16개, `core`로 옮긴 `corral-verification`, 에이전트 파일 10개 | 대기 |
| 3 | 생성과 검사: `pnpm builtin:generate`·`builtin:check`, Agent Skills 형식 검사, Pi 로더 검사, 에이전트 파일 검사, 가져오기 파서의 `skills`·`metadata` | 대기 |
| 4 | 프리셋과 템플릿: 에이전트 10개를 프리셋으로, 템플릿 8개의 그래프, 문구(ko·en), 선택기와 카드의 테스트 | 대기 |
| 5 | 목표 초안의 패턴을 템플릿 여덟에 맞춘다(계약, 로컬 고르기, 모델 프롬프트, live 고정 자료의 id) | 대기 |
| 6 | 검토(Fable), 실제 화면 확인, 건드린 E2E, 이 계획 삭제 | 대기 |

1과 2는 서로 다른 파일을 만지므로 함께 한다. 3은 2의 파일이 있어야 하고, 4는 3의 생성 모듈이 있어야 하며, 5는 4의 템플릿 id를 쓴다.

## 결정 장부

### 사용자가 정한 것 (2026-11-20)

1. 에이전트와 스킬은 열린 표준을 따라 만든다. 스킬은 Agent Skills(agentskills.io), 참고는 `michael-denyer/pstack-claude`. Corral은 Pi 기반이니 Pi와 어긋나지 않게 한다.
2. 팀이나 에이전트가 스킬을 미리 지정했으면 그 스킬은 쓸 수 있다. 그 밖의 스킬을 쓸지는 에이전트 판단에 맡긴다.
3. 밖에서 가져온 스킬도 따로 승인하지 않고 쓴다.
4. 템플릿은 전면 개편한다.
5. pstack의 사본이 아니다. 핵심 묶음과 개념을 가져와 기본 에이전트와 팀을 미리 짜 두는 것이다.

### 내가 정한 것

6. 3번의 범위: 확장(코드)이 없는 묶음만 설치할 때 신뢰한다. 확장이 든 묶음은 지금처럼 사람이 승인해야 하고 그 안의 스킬도 그때 쓸 수 있다. 신뢰의 틀(승인 해제, 파일이 바뀌면 신뢰 철회)은 그대로 둔다.
7. 2번의 범위: 스킬을 하나 이상 지정한 역할만 그 밖의 스킬을 받는다. `skills`가 없는 역할은 지금 경로 그대로이고, 빈 목록은 지금처럼 필수만이다. 그 밖의 스킬은 시작을 막지 않는다.
8. 스킬을 지정해도 도구는 줄지 않는다는 것은 계약을 바꿀 일이 아니었다. 폴더를 연결한 세션의 실제 실행에서는 세션의 실행 정책이 역할에 붙고(`packages/core/src/auto-team.ts`의 "A Corral role without its own work style works in the session's"), 그 정책이 없는 곳에서는 스킬이 있든 없든 명령 실행이 없다.
9. 브라우저 모드처럼 해석기가 없는 곳의 모의 실행은 스킬만 지정한 역할을 스킬 없이 돌린다. 기본 제공 에이전트가 모두 스킬을 가지므로 이것이 없으면 데모에서 새 템플릿이 하나도 돌지 않는다.
10. `coding` 묶음은 id를 그대로 두고 내용을 바꾼다. 어느 도구에서나 뜻이 통하는 스킬은 접두사 없이, Corral에서만 뜻이 통하는 스킬은 `corral-`로 이름 짓는다. 옛 `corral-debugging`·`corral-minimal-change`는 `root-cause`·`smallest-change`가 대신하고, `corral-verification`은 Corral 전용이라 `core`로 옮긴다.
11. 원칙은 스킬 하나(`engineering-principles`)의 색인과 참조 파일로 둔다. 원칙마다 스킬 행을 만들지 않는다.
12. 에이전트는 Markdown 에이전트 파일로 쓴다. Agent Skills 명세에는 에이전트 형식이 없고 Pi 패키지에도 에이전트 항목이 없다. Pi는 이 파일을 읽지 않으므로 해가 없다.
13. 반증의 결과 형식은 `notes`다. 검토 JSON은 실행한 명령과 출력을 실을 자리가 없다. 루프를 판정하는 검증은 `review`다.
14. 단일 에이전트와 조사 팀은 데모가 쓰는 정의라 그대로 둔다. 자동 구성 셋은 고정 테스트(`auto-team-frozen.test.ts`)가 있어 건드리지 않는다.
15. 목표 초안의 패턴은 템플릿 여덟을 모두 따라간다(8 → 11).

## 구현하는 쪽이 지킬 것

- `packages/core/test/auto-team-frozen.test.ts`는 다시 기록하지 않고 통과해야 한다. `draftFromPlan`, `basePatternFromGoal`, `ROLE_RULES`를 함께 쓴다.
- `apps/studio/src/demo/templates.ts`의 `starter`와 `research-team`은 고치지 않는다.
- `apps/server/resources/builtin/design/`은 한 바이트도 고치지 않는다.
- 기본 제공 묶음의 스킬 수는 `Resources.builtinPacks` 문구와 `apps/server/test/harness.test.ts`에 박혀 있다.
- 개발 중이라 옮겨 주는 코드(migration, 호환 층)는 쓰지 않는다. 옛 프리셋 id를 가진 저장된 팀은 출처 행만 사라진다.
- 유료 모델 호출을 일반 테스트에 넣지 않는다. `tests/live/team-draft.live.test.ts`의 고정 자료는 id만 맞추고 돌리지 않는다.

## 확인하지 않은 것

- 패턴 고르기의 정확도는 패턴이 바뀐 뒤 다시 재지 않았다. 사람이 지켜보는 live 실행이 필요하다.
- 기본 제공 스킬이 실제 모델의 결과를 낫게 하는지는 재지 않았다. 형식 검사와 로더 검사는 형식만 본다.
