# CR-016: 컴포저 `/` 명령과 `@` 참조

- 요청: Bell, 2026-10-17 — "`/`나 `@`로 시작하는 명령어셋, 파일이나 폴더 지정 등이 많이 부족함." [Workbench 완성도 개선 플랜](../plans/Workbench-Polish-Plan.md) P2·P4.
- 기준: `c6bc29d`, CR-011(의도 구분), CR-007(이전 결과에서 시작), CR-012(파일 broker), CR-014(참조는 권한을 주지 않음).
- 새 라이브러리 없음. 모델 호출 없음. 권한·도구 범위 변경 없음.

## 바뀌는 것

| 영역 | 지금 | 바뀐 뒤 |
|---|---|---|
| `/` | 없음. 의도는 라디오 버튼으로만 고름 | 입력 맨 앞의 `/`가 명령 메뉴를 연다. 명령은 하나의 레지스트리(`apps/studio/src/commandRegistry.ts`)에 있고, ⌘K·단축키·`/`가 같은 목록을 읽는다. 지금 쓸 수 없는 명령은 `/` 메뉴에서 숨기고, ⌘K에서는 이유와 함께 흐리게 보인다 |
| `@` | 파일만, 부분 문자열, 상위 8개, 서버 목록 500개 제한 | 파일·폴더·결과(버전 고정)·실행·역할을 한 메뉴에서 찾는다. 파일·폴더는 서버 검색 API가 fuzzy 순위로 돌려준다 |
| 참조 전달 | 요청 본문 글자로만 | 시작 요청의 `references` 필드로 구조화해 보낸다. 본문에도 읽을 수 있는 토큰(`@src/app.ts`, `@"report v2"`)이 남는다 |
| 검색 순위 | 없음 | `@corral/core`의 `fuzzyScore`/`rankFuzzy` 하나를 서버 검색, `@` 메뉴, `/` 메뉴가 같이 쓴다 |

## 계약

`StartRunRequest`와 `CreateRunRequest`에 선택 필드 `references: RunReference[]`(최대 20개)를 더한다. `RunInput`과 정의 스냅숏 스키마는 바꾸지 않는다.

```
RunReference =
  | { kind: 'file', path, lines?: { start, end } }   // 상대 경로, `..`·`.`·절대 경로·역슬래시 금지
  | { kind: 'folder', path }
  | { kind: 'result', runId, artifactVersionId }      // 고른 버전으로 고정
  | { kind: 'run', runId }
  | { kind: 'role', roleId }
```

Coordinator는 시작할 때 brief 뒤에 "References" 목록을 붙인다.

- **파일·폴더·실행·역할**: 가리키기만 한다. 문구에 "파일이나 도구 접근을 주지 않는다"를 적는다. 에이전트는 역할이 이미 가진 파일 도구로만 읽는다.
- **결과**: 그 버전의 본문을 복사한다(CR-007과 같은 방식). 여러 결과를 합친 크기가 설치의 artifact 상한을 넘으면 잘라내지 않고 `LIMIT_REACHED`로 거절한다.
- **없는 대상**: 없는 실행·결과·역할은 `TARGET_NOT_FOUND`로 거절하고 Run을 만들지 않는다.
- **같은 요청 재전송**: 같은 commandId와 같은 references면 첫 receipt를 돌려준다(기존 멱등성 그대로).

`references`는 의도가 "후속 작업(next)"일 때만 보낸다. 지시(steer)·대기(queue)·결과 질문(explain)에서는 본문 토큰만 남는다. 대기열에서 나중에 시작할 때는 본문만 쓴다.

## 검색 API

`GET /api/v1/projects/:id/workspace/search?q=&limit=`
`GET /api/v1/sessions/:id/worktree/search?q=&limit=`

- **응답**: `{ items: { path, kind: 'file' | 'folder' }[], truncated }`. `limit`은 1–50, `q`는 200자까지.
- **대상**: git 추적 파일과 무시되지 않은 새 파일, 그리고 그 폴더들. Git이 아닌 폴더는 기존 bounded walk를 쓴다. 후보는 50,000개까지 본다.
- **읽는 것**: 이름만 읽는다. 결과마다 심볼릭 링크를 거치지 않는지 확인한다. 등록된 scope만 검색한다.
- **데모**: 데모 워커(`demo/workspace.ts`)도 같은 순위를 쓴다.

## 단축키와 보내기

- 보내기는 Enter, 줄바꿈은 Shift+Enter가 기본이다. 설정 › 일반에서 Ctrl/⌘+Enter로 바꿀 수 있다. IME 조합 중 Enter는 보내지 않는다(WB-UX-005 유지).
- 단축키는 `apps/studio/src/shortcuts.ts` 표 하나에서 정의한다. 툴팁, `?` 도움말, 설정 › 단축키, 전역 키 처리가 모두 이 표를 읽는다.
- 브라우저가 가로채는 키(새 창 Ctrl+N, 숫자 키)는 웹에서 대체 키를 쓰거나 숨긴다.

## 테스트

| ID | 내용 | 위치 |
|---|---|---|
| TC-REF-001-H | 파일·폴더·실행·역할을 brief 뒤에 포인터로 나열, 권한 없음 문구 | `packages/core/test/references.test.ts` |
| TC-REF-002-H | 결과 참조는 고른 버전 본문 복사, 옛 Run 버전을 가리키지 않음 | 같은 파일 |
| TC-REF-003-F | 없는 결과·실행·역할은 거절, Run 없음 | 같은 파일 |
| TC-REF-004-F | 결과 합계가 상한을 넘으면 거절(자르지 않음) | 같은 파일 |
| TC-REF-005-F | 절대·탈출 경로, 21개 이상, 거꾸로 된 줄 범위는 스키마에서 거절 | 같은 파일 |
| TC-REF-006-D | 같은 commandId 재전송은 첫 Run | 같은 파일 |
| TC-REF-010-H | 서버 검색: fuzzy, 파일명 우선, 무시 파일·심볼릭 링크 제외, limit | `apps/server/test/files.test.ts` |
| TC-REF-011-F | 등록되지 않은 scope 거절 | 같은 파일 |
| TC-REF-020~024 | `/`·`@` 트리거, 토큰, 지워진 토큰의 참조는 보내지 않음 | `apps/studio/src/workbench/composerMenu.test.ts` |
| — | fuzzy 순위 | `packages/core/test/fuzzy.test.ts` |
| — | 명령 레지스트리 동일성·비활성·숫자 이동 | `apps/studio/src/commandRegistry.test.ts` |
| — | 보내기 키 설정 | `apps/studio/src/workbench/preferences.test.ts` |

## 검증하지 못한 것

- 실제 모델이 참조 목록을 어떻게 쓰는지는 측정하지 않았다(유료 호출 없음).
- 2만 개 이상 추적 파일에서의 검색 응답 시간은 아직 측정하지 않았다(플랜 §7 목표 p95 200ms, opt-in 측정 예정).
