# CR-046 P17 — 변경 검토와 근거 연결

범위: CRL-WBD-013 / C-157 / TC-WBD-013-H,N,F. 2026-10-23 재검토에 따라 기존 검토 화면·첨부·검사·Problems의 의미를 나누고 근거를 연결한 구현의 검증 기록이다. 설치판·다른 OS·스크린리더를 포함하는 release gate가 아니다. 계약은 [Workbench](../current/workbench.md)와 [CR-046](../change-requests/CR-046-development-workbench.md)의 P17 절을 따른다.

## 환경

- 기준 commit `faae41a`(P16) 위의 작업 트리. 이 기록은 그 위의 P17 commit에 포함된다.
- Linux, Node 24.14.0, pnpm 10.30.3, Git, Playwright Chromium.
- 유료 모델·외부 검색·외부 push는 쓰지 않았다. agent는 결정적 adapter이고 파일은 broker의 `write_file`로 쓴다.

## red 확인

구현 전에 새 시험이 실패하는 것을 확인했다.

- `apps/server/test/files.test.ts` “change review evidence”: 사람이 고친 Corral 파일이 `managed_agent`로 나옴, `configChanged` 필드 없음.
- `reviewMarks.test.tsx`: 모듈 없음. `sources.test.ts`·`ContextAttachments.test.tsx`: `applies` 없음과 표시 없음.
- `ReviewPage.review.test.tsx`: `DecisionPanel`이 export되지 않음. `ProblemsPanel.test.tsx`: “이전 설정”·“버전 모름” 없음.

## 결과

| 시험 | 결과 |
|---|---|
| `pnpm -r typecheck` | 통과 |
| Studio 단위 전체(`apps/studio`, vitest) | 58 파일 253건 통과 |
| Server 관련(`files`, `server`, `command-broker`, `user-tasks`, `documents-api`) | 5 파일 97건 통과 |
| `e2e/server/files.spec.ts`(server build + Chromium) | 1건 통과. 변경 조각 영역 이름이 “Selected changes”로 바뀌어 selector만 고쳤고 단언은 그대로다 |
| `pnpm spec:check` | 통과(아래 실행) |

TC-WBD-013-H

- Corral만 쓴 파일은 `managed_agent`다(server).
- 같은 비교의 변경 검토는 유지되고, 표시하면 내용 읽음도 함께 남는다(Studio).
- 정확한 비교의 승인은 현재 판단이며 반영 계획을 연다.
- 첨부 확인은 출처 상태와 적용성을 함께 보인다. 예: “current · applies.config_changed”.

TC-WBD-013-N

- 사람이 고친 Corral 파일은 `mixed`, Corral이 손대지 않은 파일은 `external_observed`다.
- 같은 최종 blob이라도 C→B에서는 검토가 표시되지 않는다.
- 다른 비교의 승인은 “이전 버전 기준”이며 반영을 열지 않는다.
- 다른 검사를 추가하면 `configChanged`가 false로 남는다. 자기 명령을 바꾸거나 삭제하면 true다.
- 세션·host가 다르면 검토 표시를 쓰지 않는다. 예전 형식의 읽음 키는 읽음으로만 해석한다.
- task 출력 위치는 “Version unknown”으로 보인다.

TC-WBD-013-F

- hunk 출처는 온전한 채로 세 경우를 나눈다. 사본이 바뀌었어도 그 파일이 같으면 `yes`, 파일이 바뀌면 `files_changed`, 현재 사본 조회가 실패하면 `unknown`이다.
- 검사의 `stale`은 `files_changed`, `configChanged`는 `config_changed`로 이어진다.

## 인앱 확인

`node apps/server/src/main.ts --no-live --static apps/studio/dist`로 임시 workspace의 서버를 띄웠다. 인앱 브라우저(1280×800)에서 임시 Git 저장소의 세션 사본을 열고 사본 파일을 디스크에서 직접 고쳤다. 사람 변경을 흉내 낸 것이다.

1. 세션 전체 비교에서 `greet.js`를 “검토함”으로 표시했다. 파일 목록과 Diff 머리에 ✓가 나왔다.
2. “지금까지 모두 읽음” 뒤 `greet.js`를 다시 고쳤다. 세션 전체 비교에서는 내용이 달라져 검토 표시가 사라졌다. 다시 검토로 표시했다.
3. “읽음 기록 이후”로 바꿨다. 같은 최종 내용인데 기준이 다르다. `greet.js`는 ✓가 아니라 “다른 비교에서 읽음” 표시였다.
4. 등록 검사 `Syntax`를 실행해 통과했다. 명령 인자만 API로 바꾸고 다시 읽자 tree는 같은데 “이전 검사 설정 기준”이 보였다.
5. 세션 전체 비교를 승인하자 “승인”과 원본 반영 영역이 보였다.
6. 비교 범위의 시각 라벨은 숨겼다. 접근 가능한 이름(“비교 범위”)은 label 안에 남아 있다.
7. 다시 빌드한 화면에서 언어 서버 제안 영역을 확인했다. 제안이 없을 때는 제목, 새로고침 아이콘(접근 이름 “제안 새로고침”), 빈 상태 한 줄만 보인다.

출력이 빈 검사는 첨부 버튼이 비활성인 기존 동작이라 Composer의 적용성 표시는 단위 시험으로만 확인했다. 인앱에서 Corral 쓰기와 사람 쓰기가 섞인 `mixed` 표시는 보지 않았고, 서버 통합 시험으로 확인했다.

## 한계와 남은 일

- 다른 OS·설치판·실제 스크린리더·IME는 확인하지 않았다.
- 검토 표시는 브라우저 저장소의 view state다. 다른 기기와 공유되지 않으며 승인 기록이 아니다.
- R0 잔여 통합 여정은 [활성 계획](../plans/workbench-development-implementation-plan-2026-10-21.md)의 재검토 절에 남아 있다. 실제 desktop preview 프레임, PTY transport 재연결, 설정·Run 왕복, 390px가 그 범위다.
- tsc `--pretty` 형식(`path:l:c - error`)은 Problems 파서가 읽지 않는다. P23 fixture 보완 범위로 남긴다.
