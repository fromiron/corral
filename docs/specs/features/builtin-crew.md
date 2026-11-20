# 기능 명세: 기본 제공 스킬과 에이전트

- 상태: accepted
- 기준: [라이브러리](library.md), [에이전트 라이브러리](agent-library.md), [스킬 라이브러리](skill-library.md), [하네스 계약](../harness-contract.md), [모델·추론·리소스](../models-and-resources.md)
- 비목표: 다른 도구의 스킬 묶음을 그대로 싣기, 기본 제공 스킬에 스크립트나 확장 넣기, 에이전트 파일로 Pi에 서브에이전트 기능 더하기, 자동 구성(팀을 고르지 않은 세션)의 역할 바꾸기, 기본 제공 에이전트를 화면에서 고치기(고치려면 팀에 넣거나 라이브러리에 저장한 사본을 고친다)

## 사용자 관측 동작

Corral은 바로 쓸 수 있는 스킬과 에이전트를 함께 싣는다. 템플릿([라이브러리](library.md))은 이 에이전트로 짜여 있고, 에이전트는 자기 일에 맞는 스킬을 지정해 둔다. 사람이 먼저 설치하거나 승인할 것은 없다.

1. 처음 실행한 설치의 **라이브러리 › 스킬**에는 기본 제공 스킬이 이미 있고 모두 쓸 수 있다. 출처에는 기본 제공 묶음의 이름이 보인다.
2. 편집기의 **에이전트 추가 › 기본 제공**에는 아래 열 에이전트가 있다. 행은 이름, 맡은 일, 지정한 스킬 이름을 보인다. 고르면 맡은 일·기본 지시·도구·결과 형식·스킬이 채워진 새 자리가 생긴다([에이전트 라이브러리](agent-library.md) 7, 11).
3. 기본 제공 에이전트로 만든 자리의 **사용할 스킬**에는 지정한 스킬이 이름으로 보인다. 더하거나 빼는 것은 다른 자리와 같다([스킬 라이브러리](skill-library.md) 12–18).
4. 앱을 올린 뒤 기본 제공 스킬의 내용이 바뀌었으면 스킬 보기에는 새 버전만 보인다. 이전 버전은 보관돼 있고, 이전 버전을 지정한 팀은 그대로 열리고 실행된다. 그 자리의 스킬 상세가 새 버전 사용을 제공한다([스킬 라이브러리](skill-library.md) 16).
5. 사람이 기본 제공 묶음을 끄거나 지우거나 보관했으면 Corral은 그것을 다시 켜지 않는다. 지운 묶음은 **가져오기 › 기본 제공**으로 다시 설치한다.

### 기본 제공 에이전트

이름과 맡은 일의 문구는 화면 언어를 따른다. 기본 지시는 영어로 쓴 에이전트 파일의 본문이다.

| 에이전트 | 하는 일 | 도구 | 결과 형식 | 지정한 스킬 |
|---|---|---|---|---|
| 설계 `architect` | 코드를 쓰기 전에 자료 모양·경계·순서를 정한다 | 읽기 | notes | `shape-first`, `engineering-principles`, `trace-the-code` |
| 구현 `builder` | 요청을 채우는 가장 작은 변경을 만들고 직접 확인한다 | 읽기·실행·변경 | draft | `smallest-change`, `engineering-principles`, `failing-test-first`, `prove-it`, `corral-change-report` |
| 원인 조사 `investigator` | 문제를 재현하고 처음 잘못된 곳을 근거와 함께 찾는다. 수치의 기준선을 잰다 | 읽기·실행 | notes | `root-cause`, `measure-first`, `corral-evidence` |
| 검토 `reviewer` | 결과를 기준에 대어 통과·돌려보냄을 판정한다 | 읽기 | review | `corral-review`, `change-impact`, `comment-hygiene` |
| 반증 `adversary` | 변경을 깨뜨려 보고, 실행이나 추적으로 보인 것만 보고한다 | 읽기·실행 | notes | `break-it`, `change-impact` |
| 검증 `verifier` | 실제 결과물을 실행해 기준을 채웠는지 판정한다 | 읽기·실행 | review | `prove-it`, `measure-first`, `corral-verification`, `corral-review` |
| 심사 `judge` | 나란히 온 결과를 기준별로 견주어 고르고 합친다 | 읽기 | draft | `pick-and-graft`, `plain-prose` |
| 설명 `explainer` | 코드가 어떻게 동작하고 왜 그렇게 됐는지 근거와 함께 밝힌다 | 읽기 | notes | `trace-the-code`, `ask-the-record` |
| 조사 `researcher` | 질문에 답할 사실과 출처를 모은다 | 읽기 | notes | `ask-the-record`, `corral-evidence` |
| 작성 `writer` | 받은 자료로 읽는 사람에게 맞는 글을 쓴다 | 읽기 | draft | `plain-prose`, `doc-writing` |

- **읽기**는 `write_artifact`·`list_files`·`read_file`·`preview_file`이다. **실행**은 여기에 `run_command`·`preview_app`·`preview_action`을 더한다. **변경**은 `write_file`·`delete_file`·`move_file`을 더한다. 모든 에이전트는 `read_artifact`·`submit_result`·`ask_user`를 가진다.
- 검토·검증·심사는 둘째 모델 자리(`model-b`)를, 나머지는 첫째 자리(`model-a`)를 쓴다. 템플릿이 같은 에이전트를 두 갈래에 나란히 놓을 때는 둘째 갈래를 `model-b`로 둔다.
- 명령 실행은 세션의 실행 정책이 있을 때만 실제로 쓸 수 있다([LLM 런타임](../llm-runtime.md)). 실행 도구를 쓸 수 없는 자리에서 에이전트는 추적한 것과 실행한 것을 구분해 보고한다.

### 기본 제공 스킬

| 묶음 | 스킬 |
|---|---|
| `core` (Corral 안에서만 뜻이 통하는 절차) | `corral-change-report`, `corral-delegation`, `corral-evidence`, `corral-handoff`, `corral-review`, `corral-verification` |
| `coding` (어느 도구에서나 쓰는 엔지니어링 절차) | `engineering-principles`, `shape-first`, `smallest-change`, `root-cause`, `failing-test-first`, `prove-it`, `break-it`, `change-impact`, `behavior-pin`, `measure-first`, `trace-the-code`, `ask-the-record`, `plain-prose`, `doc-writing`, `comment-hygiene`, `pick-and-graft` |
| `design` | 고정한 upstream을 내용 변경 없이 실은 열 개([NOTICE](../../../apps/server/resources/builtin/design/NOTICE.md)) |
| `browser` | `corral-browser-verification` |

- `engineering-principles`는 원칙의 색인이다. 본문은 원칙마다 언제 적용하는지를 한 줄로 적고, 각 원칙의 전문은 그 스킬의 `references/` 파일에 있다. 에이전트는 적용하는 원칙의 파일만 읽는다.
- `coding` 묶음은 역할과 개념을 다른 엔지니어링 스킬 묶음에서 이어받되 글은 Corral이 쓴다. 이어받은 출처는 그 묶음의 NOTICE에 적는다.

## 계약

### 파일 형식

정본은 `apps/server/resources/builtin/`의 파일이다. 코드에 같은 내용을 따로 적지 않는다.

- **스킬**은 [Agent Skills 명세](https://agentskills.io/specification)를 따르는 폴더다.
  - `SKILL.md`의 frontmatter는 `name`, `description`과 선택 필드 `license`, `compatibility`, `metadata`만 쓴다. `name`은 소문자·숫자·하이픈 1–64자이고 하이픈으로 시작하거나 끝나지 않으며 하이픈이 이어지지 않고 폴더 이름과 같다. `description`은 1–1,024자이고 무엇을 하는지와 언제 쓰는지를 적는다.
  - 본문은 500줄 이하다. 긴 참고 자료는 `references/`에 두고 스킬 폴더 기준 상대 경로로 가리킨다. 참조는 한 단계다.
  - 다른 스킬은 이름으로 가리킨다. `../`로 시작하는 경로를 쓰지 않는다.
  - 기본 제공 스킬은 모두 에이전트가 스스로 골라 쓰는 스킬이므로 `disable-model-invocation`을 두지 않는다. 스크립트·실행 파일·확장을 넣지 않는다.
  - Corral 밖에서 뜻이 통하지 않는 스킬만 이름에 `corral-`을 붙이고 `compatibility`에 Corral을 적는다.
- **묶음**은 Pi 패키지다. `package.json`의 `pi.skills`가 스킬 폴더를 가리키고 `pi.extensions`는 없다. 묶음마다 `LICENSE`와 `NOTICE.md`가 있다.
- **에이전트**는 `agents/<name>.md`다. Agent Skills 명세는 에이전트 형식을 정하지 않으므로 여러 도구가 함께 읽는 Markdown 에이전트 형식을 쓴다.
  - frontmatter: `name`(파일 이름과 같다), `description`, `tools`, `skills`, `metadata`.
  - `tools`는 `Read`, `Glob`, `Grep`, `Bash`, `Edit`, `Write` 가운데 고른다. `Bash`가 있으면 실행, `Edit`과 `Write`가 있으면 변경이다.
  - `skills`는 기본 제공 스킬의 이름 목록이다.
  - `metadata`는 문자열 값만 갖는 한 단계 맵이다. Corral이 읽는 키는 `corral-output`(결과 형식)과 `corral-model-slot`(`a` 또는 `b`)이다.
  - 본문이 기본 지시다. 본문은 특정 도구의 기능 이름에 기대지 않는다. Corral은 본문 뒤에 공통 작업 규칙을 붙여 역할의 지시로 쓴다.
  - 모든 에이전트 파일은 Corral의 Markdown 에이전트 가져오기([에이전트 라이브러리](agent-library.md))가 오류 없이 읽는다.
- `design` 묶음은 upstream을 바이트 그대로 싣는다. 위 스킬 형식 검사에서 어긋나는 항목이 있으면 그 항목을 검사 코드에 이름으로 적어 예외로 둔다.

### 생성과 검사

- `pnpm builtin:generate`가 정본 파일에서 두 가지를 만든다: 묶음별 해시·파일 수·스킬 수를 담은 `apps/server/resources/builtin/manifest.json`, 그리고 에이전트(도구, 결과 형식, 모델 자리, 기본 지시, 스킬 참조)와 스킬(이름, 설명, 묶음, 해시, 항목 경로)을 담은 `packages/core`의 생성 모듈.
- 묶음의 해시는 설치가 쓰는 것과 같은 계산이다. 해시 계산은 한 곳에 있다.
- `pnpm builtin:check`는 생성물이 정본과 다르면 실패한다. 일반 테스트도 같은 검사를 한다.
- 일반 테스트는 다음도 확인한다.
  - 모든 기본 제공 스킬이 위 스킬 형식을 지킨다.
  - Corral이 쓰는 Pi 버전의 스킬 로더가 각 묶음을 진단 없이 읽는다.
  - 모든 에이전트 파일이 가져오기 파서를 오류 없이 지나고, `skills`의 이름이 모두 기본 제공 스킬이며, `tools`와 `metadata`가 위 값만 쓴다.
  - 에이전트 파일의 도구 이름을 Corral 도구로 옮기는 표는 가져오기가 쓰는 표와 한 곳에 있다.

### 프리셋

- 기본 제공 에이전트의 id가 역할 프리셋의 id다. `AgentRole.origin`은 `{ kind: 'preset', presetId: <에이전트 id> }`다.
- 프리셋으로 만든 역할의 `skills`는 생성 모듈의 `{ resourceHash, entry }`다. 해석은 [하네스 계약의 역할 스킬 선택](../harness-contract.md#역할의-스킬-선택)이 정한다.
- 맡은 일은 화면 언어의 문구이고 그 자리의 단계 지시가 된다. 기본 지시는 에이전트 파일의 본문과 공통 작업 규칙이다([에이전트 라이브러리](agent-library.md) 11).
- 알 수 없는 `presetId`를 가진 저장된 팀은 그대로 열리고 실행된다. 출처 행만 보이지 않는다.

### 설치

- 서버가 시작할 때, 저장소에 없는 기본 제공 묶음 버전(해시)을 설치한다. 이미 있는 버전은 상태(켜짐, 꺼짐, 지움, 보관, 승인 해제)와 상관없이 건드리지 않는다.
- 새 버전을 설치할 때 같은 묶음의 이전 기본 제공 버전이 있으면, 이름이 같은 스킬끼리 이전 항목의 다음 버전으로 잇고 이전 항목을 보관한다. 사람이 이미 보관했거나 다음 버전을 이은 항목은 바꾸지 않는다.
- 설치는 여러 번 해도 결과가 같다. 설치가 실패해도 서버는 시작하고, 그 묶음의 스킬을 지정한 역할은 [고른 항목을 쓸 수 없을 때](../harness-contract.md#역할의-스킬-선택)의 규칙을 따른다.
- 묶음의 내용이 `manifest.json`과 다르면 설치하지 않는다.

## 수용 시나리오

```gherkin
Given 새 설치다
When 서버를 시작하고 스킬 보기를 연다
Then 기본 제공 스킬이 모두 보이고 사용 승인이 필요한 행이 없다

Given 새 설치다
When 기능 구현 템플릿으로 새 대화를 시작한다
Then 스킬을 설치하거나 승인하라는 안내 없이 실행이 시작된다

Given 기본 제공 coding 묶음을 지웠다
When 서버를 다시 시작한다
Then 그 묶음은 다시 설치되지 않는다
And 그 묶음의 스킬을 지정한 자리에는 스킬 이름과 원인, 다시 연결과 선택 해제가 보인다

Given 이전 버전의 coding 묶음을 지정한 팀이 있다
When 새 버전이 든 앱으로 서버를 시작한다
Then 스킬 보기에는 새 버전만 보이고 그 팀은 이전 버전으로 그대로 실행된다

Given 기본 제공 스킬 파일을 고쳤다
When 생성물을 다시 만들지 않고 검사를 실행한다
Then 검사가 실패한다

Given 스킬 이름이 폴더 이름과 다르거나 disable-model-invocation이 든 기본 제공 스킬이 있다
Then 형식 검사가 그 스킬을 이름으로 알리며 실패한다

Given 에이전트 파일이 기본 제공에 없는 스킬 이름을 적었다
Then 검사가 그 에이전트와 이름을 알리며 실패한다
```

## 보안·성능·접근성

- 기본 제공 스킬은 글이다. 스킬을 지정해도 도구 권한은 생기지 않는다([스킬 라이브러리](skill-library.md)).
- 묶음은 `manifest.json`의 해시와 같을 때만 설치되고, 설치 뒤에도 읽을 때마다 파일 해시를 확인한다.
- 스킬 본문과 에이전트 지시를 로그와 공개 이벤트에 남기지 않는다.
- 스킬의 이름과 설명만 요청에 먼저 실리고 본문은 에이전트가 읽을 때 실린다. 묶음 하나의 스킬 수는 이 비용을 기준으로 정한다.
- 화면 변화는 기존 목록(스킬 표, 에이전트 선택기, 템플릿 카드)의 내용뿐이다. 새 컴포넌트는 없다.
