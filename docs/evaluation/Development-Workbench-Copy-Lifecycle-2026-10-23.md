# CR-046 P21-A — 작업 사본 보관과 삭제 전 요약

범위: CRL-WBD-016 / C-160 / TC-WBD-016-H,N,F. 세션 보관과 작업 사본 삭제의 분리, 삭제 전 요약, copy generation 고정의 검증 기록이다. 원격 복귀(P21-B)·설치판·다른 OS·스크린리더는 포함하지 않는다. 계약은 [CR-046](../change-requests/CR-046-development-workbench.md)의 P21-A 절을 따른다.

## 환경

- 기준 commit `3556671`(P18-B) 위의 작업 트리. 이 기록은 그 위의 P21-A commit에 포함된다.
- Linux, Node 24.14.0, pnpm 10.30.3, Git, Chromium(인앱 브라우저). 유료 모델·외부 호출은 없었다.

## red 확인

구현 전에 다음이 실패했다.

- `files.test.ts`의 H·N: `removalPlan`이 없었고, 이전 generation의 삭제 요청을 거절하지 않았다.
- `copy-lifecycle-routes.test.ts`: client의 `removalPlan`이 없었다.
- `CopyRemovalDialog.test.tsx`: 모듈이 없었다.
- F(일부만 지워진 사본을 삭제로 기록하지 않음)는 구현 전에도 통과했다. 폴더 삭제가 실패하면 오류가 그대로 올라와 `removed_at`을 쓰지 않았기 때문이다. 이번에 폴더가 남는 경우를 명시적으로 거절하도록 바꾸고, 그 시험을 회귀로 남긴다.

## 결과

| 시험 | 결과 |
|---|---|
| Studio 단위 전체 | 61 파일 264건 통과 |
| Server: `files`, `copy-lifecycle-routes`, `server`, `workspace-ownership`, `user-tasks-routes`, `terminal-routes` | 98건 통과 |
| `packages/react` locale | 3건 통과 |
| 타입 검사(server·studio)·lint·`pnpm spec:check` | 통과 |

- H: Git 변경, 보내지 않은 의견, 열린 Run이 있는 사본을 요약했다. 이 브라우저의 미저장 문서와 복구 초안도 보였고, 다른 세션 문서는 빠졌다. 삭제는 보인 generation으로 요청했다. 보관한 세션의 사본은 남았다(HTTP).
- N: owner가 있으면 서버와 화면 모두 삭제를 막고 종류를 보였다. 이전 generation의 삭제 요청은 `REVISION_CONFLICT`였고 다시 만든 사본은 남았다. 늦은 거절은 대화상자 안에 이유로 보였다.
- F: 권한을 잠근 하위 폴더 때문에 일부만 지워진 사본은 삭제로 기록되지 않았다. root·Windows에서는 이 시험을 건너뛴다. 읽지 못한 Git 상태는 “읽지 못함”으로 보였다.

## 인앱 확인

임시 workspace와 scratchpad의 사본 폴더로 서버를 띄우고 인앱 브라우저(1280×800)에서 확인했다.

1. 새 세션의 사본에서 추적 파일 하나를 고치고 새 파일 하나를 만들었다.
2. Changes의 “작업 복사본 지우기”를 눌렀다. 대화상자가 “커밋하지 않은 변경: 스테이지 0 · 미스테이지 1 · 추적 안 함 1”을 보였다. “사본 유지”로 닫았다.
3. 터미널 pane에서 새 터미널을 열었다. 요약 API는 owner `{kind:user, operation:terminal, writer:true}`를 돌려줬다.
4. 다시 연 대화상자는 터미널이 사용 중이라고 밝혔고 “사본 지우기”는 잠겨 있었다. 처음 문구의 조사(“터미널이(가)”)가 어색해 “사용 중: 터미널 · 먼저 멈추세요.”로 고쳤다.

서버를 끈 뒤 남은 터미널 프로세스와 사용자 데이터 폴더의 새 항목이 없는 것을 확인했다.

## 한계와 남은 일

- 원격 host의 단절·재접속·복구(P21-B)는 C-135와 함께 승인된 실제 host에서 검증한다.
- 고친 한국어 문구는 단위 시험과 locale 시험으로만 확인했고 다시 빌드한 화면은 보지 않았다.
- 미저장 문서·복구 초안은 이 브라우저의 것만 보인다. 다른 창·기기의 초안은 알 수 없다.
- 다른 OS·설치판·실제 스크린리더는 확인하지 않았다.
