# 스튜디오 화면의 기능 폴더: 작업 계획

`apps/studio/src/pages`에는 파일 120개가 한 폴더에 평평하게 있다. 이 계획은 화면마다 기능 폴더를 두어 그 화면의 부품·테스트·fixture를 한곳에 모으고, 다른 폴더는 그 기능 폴더의 입구 파일로만 들어오게 한다. 동작은 바꾸지 않는다. 단계마다 `git mv`와 경로 고침만 한다.

명세: 바꿀 동작이 없어 고칠 명세는 없다. 폴더 이름은 [용어집](../specs/glossary.md)의 코드·URL 이름을 쓴다. `shell`은 [Workbench › 전역 셸과 화면 틀](../specs/workbench.md#전역-셸과-화면-틀)의 셸이고, `changes`는 [세션 패널](../specs/features/session-panel.md)의 변경 탭이다. 용어집의 [파일명](../specs/glossary.md#파일명) 줄은 경로만 고친다.

브랜치는 `develop`에서 가른 `refactor/studio-feature-folders`다. 단계마다 커밋 하나이고, 각 단계는 따로 합칠 수 있다. [정할 것](#정할-것)이 정해지기 전에는 파일을 옮기지 않는다.

| 단계 | 내용 | 상태 |
|---|---|---|
| S0 | 이 계획 | 정할 것을 기다린다 |
| M1 | `pages/performance/` | 할 일 |
| M2 | `pages/schedules/` | 할 일 |
| M3 | `pages/compare/` | 할 일 |
| M4 | `pages/projects/` | 할 일 |
| M5 | `feature-preview/`에 기능 미리보기 화면 | 할 일 |
| M6 | `pages/inbox/` | 할 일 |
| M7 | `pages/meeting/` | 할 일 |
| M8 | `pages/editor/` | 할 일 |
| M9 | `pages/library/` | 할 일 |
| M10 | `pages/session/` | 할 일 |
| M11 | `pages/models/` | 할 일 |
| M12 | `pages/shell/` | 할 일 |
| M13 | `pages/run/` | 할 일 |
| M14 | `workbench/harness/`에 `McpConnection` | 할 일 |
| M15 | `pages/harness/` | 할 일 |
| M16 | `pages/changes/` | 할 일 |
| M17 | `pages/settings/` | 할 일 |
| E | 마무리 확인: smoke E2E 한 번 | 할 일 |
| L | 기능 폴더 경계 lint | 할 일, 따로 정한다 |

단계 순서는 밖에서 그 폴더의 파일을 가리키는 파일(import, `vi.mock`, 경로를 읽는 테스트, 문서 링크)이 적은 것부터다. 각 단계의 수는 [단계별 고칠 곳](#단계별-고칠-곳)에 있다.

## 목표 구조

파일 이름은 바뀌지 않는다. 옛 경로는 `apps/studio/src/pages/<이름>`이고 새 경로는 아래 표의 폴더 안의 같은 이름이다. 표의 폴더는 `apps/studio/src/` 아래 경로다.

| 폴더 | 화면과 주소 | 입구 | 옮기는 파일 |
|---|---|---|---|
| `pages/shell/` | 루트 라우트의 틀, 오류·없음 화면, 시작 실패 | `RootLayout.tsx`, `StartupFailure.tsx` | `RootLayout.tsx`, `StartupFailure.tsx` |
| `pages/projects/` | `/projects`, `/projects/$projectId` | `ProjectsPage.tsx`, `WorkspacePage.tsx` | `ProjectsPage.tsx`, `WorkspacePage.tsx`, `ProjectsPage.test.tsx`, `WorkspacePage.test.tsx` |
| `pages/session/` | `/sessions/$sessionId` | `SessionPage.tsx` | `SessionPage.tsx`, `SessionPage.annotate.test.tsx`, `SessionPage.browser.test.tsx`, `SessionPage.context.test.tsx`, `SessionPage.debuggerDocuments.test.tsx`, `SessionPage.dock.test.tsx`, `SessionPage.documentTabs.test.tsx`, `SessionPage.graphTab.test.tsx`, `SessionPage.shell.test.tsx`, `SessionPage.terminalTabs.test.tsx`, `SessionPage.toolsTab.test.tsx`, `SessionPage.treeColumn.test.tsx`, `sessionShell.fixture.tsx` |
| `pages/meeting/` | 회의 대화(대화 화면이 그린다) | `MeetingPage.tsx` | `MeetingPage.tsx`, `MeetingPage.selection.test.tsx`, `MeetingPage.shared.test.ts`, `MeetingPage.test.tsx` |
| `pages/run/` | `/runs/$runId`, 패널의 실행 탭(`RunDetail`) | `RunPage.tsx` | `RunPage.tsx`, `RunPage.layout.test.tsx`, `RunPage.owner.test.tsx` |
| `pages/changes/` | 패널의 변경 탭(`ReviewContent`, `Checks`, `FileDiff`). 라우트 없음 | `ReviewPage.tsx` | `LspProposals.tsx`, `ReviewPage.tsx`, `LspProposals.test.tsx`, `ReviewPage.attachments.test.tsx`, `ReviewPage.changes.test.tsx`, `ReviewPage.checks.test.tsx`, `ReviewPage.content.test.tsx`, `ReviewPage.feedback.test.tsx`, `ReviewPage.review.test.tsx` |
| `pages/editor/` | `/corrals/…/edit`, `/demo`, 패널의 팀 그래프 탭(`TeamDesign`) | `EditorPage.tsx` | `EditorPage.tsx`, `EditorPage.stacked.test.tsx` |
| `pages/library/` | `/library/*` | `LibraryPage.tsx` | `LibraryAgents.tsx`, `LibraryPage.tsx`, `LibraryResources.tsx`, `LibrarySkills.tsx`, `LibraryTeams.tsx`, `LibraryAgents.test.tsx`, `LibraryPage.test.tsx`, `LibrarySkills.test.tsx` |
| `pages/inbox/` | `/inbox` | `InboxPage.tsx` | `InboxPage.tsx`, `InboxPage.story-fixture.tsx`, `InboxPage.test.tsx` |
| `pages/schedules/` | `/schedules` | `ScheduledPage.tsx` | `ScheduledPage.tsx`, `ScheduledPage.test.tsx` |
| `pages/compare/` | `/compare` | `ComparePage.tsx` | `ComparePage.tsx`, `ComparePage.test.tsx` |
| `pages/performance/` | `/performance`(performance 모드에서만) | `PerformancePage.tsx` | `PerformancePage.tsx` |
| `pages/settings/` | 설정 대화상자의 틀과 일반·화면·작업 폴더·진단·금고 구역 | `SettingsPage.tsx`, `DiagnosticsSettingsPage.tsx`, `VaultSettingsPage.tsx` | `AppearanceSettings.tsx`, `DebuggerSettings.tsx`, `DeploymentSettings.tsx`, `DiagnosticsSettingsPage.tsx`, `ProjectToolSettings.tsx`, `projectToolValues.ts`, `SettingsPage.tsx`, `SettingsScroll.tsx`, `ThemeEditor.tsx`, `ThemePreview.tsx`, `VaultSettingsPage.tsx`, `AppearanceSettings.test.tsx`, `DeploymentSettings.test.tsx`, `DiagnosticsSettingsPage.test.tsx`, `ProjectToolSettings.test.tsx`, `SettingsFrame.test.tsx`, `SettingsPage.appearance.test.tsx`, `SettingsPage.density.test.tsx`, `VaultSettingsPage.test.ts` |
| `pages/harness/` | 설정의 Harness·개인 기본·프로젝트 기본·Skill·Hook·MCP 구역 | `HarnessSettingsPage.tsx`, `HarnessDefaultsPage.tsx`, `ResourceSettingsPage.tsx`, `McpSettingsPage.tsx` | `HarnessDefaultsPage.tsx`, `HarnessMcpTools.tsx`, `HarnessSettingsPage.tsx`, `McpSettingsPage.tsx`, `ResourceSettingsPage.tsx`, `HarnessDefaultsPage.test.tsx`, `HarnessSettingsPage.project.test.tsx`, `McpSettingsPage.test.tsx`, `ResourceSettingsPage.empty.test.tsx`, `ResourceSettingsPage.test.tsx` |
| `pages/models/` | 설정의 모델 구역 | `ModelSettingsPage.tsx` | `AddConnectionDialog.tsx`, `ApiKeyInput.tsx`, `DecisionApiSettings.tsx`, `download-size.ts`, `EffortRoutingSettings.tsx`, `ImageProfileSettings.tsx`, `LocalAiPanel.tsx`, `ModelCatalogDialog.tsx`, `modelConnections.ts`, `ModelConnections.tsx`, `ModelImportPanel.tsx`, `ModelProfilesEditor.tsx`, `ModelSettingsPage.tsx`, `ModelUsageChart.tsx`, `ModelUsagePanel.tsx`, `AddConnectionDialog.test.tsx`, `DecisionApiSettings.test.tsx`, `EffortRoutingSettings.test.tsx`, `imageProfileId.test.ts`, `ImageProfileSettings.test.tsx`, `LocalAiPanel.test.tsx`, `modelConnections.test.ts`, `ModelConnections.test.tsx`, `ModelProfilesEditor.test.tsx`, `modelSettings.lifecycle.test.tsx`, `ModelSettingsPage.tabs.test.tsx`, `modelTestDom.ts`, `ModelUsagePanel.test.tsx` |
| `feature-preview/` | `/preview`, `/preview/$feature` | `PreviewPage.tsx` | `PreviewPage.tsx`, `PreviewPage.test.tsx` |
| `workbench/harness/` | 공용 Harness 부품 | (공용) | `McpConnection.tsx`, `McpConnection.test.tsx` |
| `pages/`(그대로) | 공용, 잠정 | (공용) | 옮기지 않는다: `FilesViews.tsx`, `GettingStarted.tsx`, `Workbench.tsx`, `FilesViews.link-row.test.tsx`, `FilesViews.trust.test.tsx`, `FilesViews.working-copy.test.tsx` |

두 기능이 쓰는 파일의 주인:

- `SettingsPage.tsx`의 `SettingsLayout`은 `settings`, `harness`, `models`의 화면이 모두 쓴다. 설정 대화상자의 틀이라 `settings`가 가진다.
- `EditorPage.tsx`의 `TeamDesign`은 대화 화면의 팀 그래프 탭이 쓴다. 편집기의 화면이라 `editor`가 가진다.
- `RunPage.tsx`의 `RunDetail`은 `workbench/session/SessionPanels.tsx`(실행 탭)가 쓴다. `run`이 가진다.
- `HarnessSettingsPage.tsx`의 `HarnessPreviewView`는 `workbench/HarnessRoleSettings.tsx`와 `workbench/RunHarnessOverrides.tsx`가 쓴다. `harness`가 가진다.
- `MeetingPage.tsx`는 `SessionPage.tsx`만 그리지만 화면 하나를 채우므로 자기 폴더를 가진다([정할 것](#정할-것) 4).
- `ReviewPage.tsx`는 라우트가 없고 `workbench/`의 변경 탭 부품만 쓴다. 변경 탭의 화면이라 `changes`가 가진다([정할 것](#정할-것) 5).
- `McpConnection.tsx`는 `harness`의 두 화면과 `workbench/RoleToolPicker.tsx`가 쓴다. `McpEditor.tsx`가 있는 `workbench/harness/`로 간다([정할 것](#정할-것) 6).
- `FilesViews.tsx`(`useBinding`, `WorkFolderSection`, `WorkingCopyPanel`, `WORKSPACE_CHANGED`)는 `session`, `settings`, `changes`와 `workbench/`의 여덟 파일이 쓴다. `Workbench.tsx`(`useRemembered`, `WorkbenchLayout`)와 `GettingStarted.tsx`(`markRunReviewed`)도 `workbench/`와 여러 화면이 쓴다. 이 셋과 `FilesViews`의 테스트 셋은 이 계획에서 옮기지 않는다([정할 것](#정할-것) 7).
- `download-size.ts`와 `ApiKeyInput.tsx`는 `models` 안의 두 파일씩만 쓴다. `modelTestDom.ts`는 `models`의 테스트만 쓴다.
- `sessionShell.fixture.tsx`는 `session`의 테스트 열 개와 `workbench/browser/BrowserMenuDialogs.test.tsx`가 쓴다. `session`이 가진다.
- `InboxPage.story-fixture.tsx`는 `packages/react/src/components/NeedsYouAdvice.stories.tsx`만 쓴다. `inbox`가 가진다.
- `SettingsFrame.test.tsx`가 검사하는 `workbench/SettingsContent.tsx`는 설정 화면들을 그리는 틀이다. 설정의 테스트라 `settings`로 간다.

## 경계 규칙

lint로 옮길 수 있게 경로로 쓴다. 기능 폴더는 `pages/<기능>/`과 `feature-preview/`다.

1. 기능 폴더 안의 파일끼리는 자유롭게 import한다.
2. 기능 폴더 밖의 파일(다른 기능 폴더, `workbench/`, `src/` 맨 위, `packages/`)은 그 폴더의 입구 파일만 import한다. 입구는 폴더 맨 위의 `*Page.tsx`이고, `shell/`만 `RootLayout.tsx`와 `StartupFailure.tsx`다.
3. 테스트(`*.test.ts`, `*.test.tsx`)와 스토리(`*.stories.tsx`)는 다른 기능 폴더의 `*.fixture.tsx`, `*.story-fixture.tsx`도 import할 수 있다. 테스트가 아닌 코드는 fixture를 import하지 않는다.
4. `vi.mock`의 경로와 테스트가 소스를 글자로 읽는 경로는 import가 아니다. 규칙 2를 받지 않는다.
5. `pages/` 맨 위의 공용 파일은 누구나 import한다. 공용 파일은 기능 폴더를 import하지 않는다.
6. 기능 폴더는 `workbench/`, `src/` 맨 위, `packages/`를 자유롭게 import한다.

이동이 끝난 뒤에도 `workbench/`에서 기능 폴더의 입구로 가는 import는 남는다. 규칙 2에 맞지만 공용이 기능에 기대는 방향이므로, L 단계의 lint는 이 목록을 그대로 허용해 시작한다.

- `workbench/SettingsContent.tsx` → `settings`의 세 입구, `harness`의 네 입구, `models/ModelSettingsPage.tsx`
- `workbench/HarnessRoleSettings.tsx`, `workbench/RunHarnessOverrides.tsx` → `harness/HarnessSettingsPage.tsx`
- `workbench/session/SessionPanels.tsx` → `run/RunPage.tsx`, `changes/ReviewPage.tsx`
- `workbench/SessionChangesPanel.tsx`, `workbench/GitPanel.tsx`, `workbench/GitConflicts.tsx`(`import()`), `workbench/EditProposalReview.tsx`(`import()`) → `changes/ReviewPage.tsx`

## 새 파일의 자리

- 한 기능 폴더만 쓰는 파일은 그 폴더에 둔다.
- 화면(라우트의 화면이거나, 다른 화면이 통째로 그리는 화면)은 자기 기능 폴더를 가진다. 이름은 `<이름>Page.tsx`이고 그 폴더의 입구다. 폴더 이름은 용어집의 코드·URL 이름이다.
- 그 기능만의 부품 폴더가 이미 있으면 화면도 거기에 둔다(`feature-preview/`). 여러 화면이 함께 쓰는 부품 폴더(`workbench/session/`, `workbench/harness/`)에는 화면을 두지 않는다.
- 테스트는 검사하는 파일과 같은 폴더에 `<파일>.<관점>.test.tsx`로 둔다. fixture는 그것을 쓰는 테스트의 폴더에 둔다.
- 두 기능 폴더 이상이 쓰는 파일은 기능 폴더에 두지 않는다. 그 부품이 속한 `workbench/`의 폴더에 두고, 맞는 폴더가 없으면 `pages/` 맨 위에 둔다(잠정).
- 다른 기능이 쓸 것은 입구 파일에서 export한다.

## 단계마다

한 커밋에 하는 것:

- `git mv`로 옮긴다.
- 경로만 고친다: 옮긴 파일 안의 상대 경로(`../`가 `../../`가 되고, 아직 `pages/` 맨 위에 있는 파일은 `./`가 `../`가 된다), 옮긴 파일을 import·`import()`·`vi.mock`하는 파일, 경로를 글자로 가진 테스트, 코드 경로를 가리키는 문서, 경로를 키로 쓰는 lint 기준선. `biome check --write`가 import의 순서와 줄바꿈을 바꾼 것은 받는다. 그 밖의 고침은 이 계획의 단계가 아니다.
- 옮긴 파일은 모두 `git show -M --stat`에서 이름 바꿈(`R`)으로 보여야 한다.

확인. 단계의 바탕 커밋에서 같은 것을 먼저 돌려 두고 비교한다.

- `pnpm typecheck`가 바탕과 같이 끝난다. 정적 import, `import()`, JSON import의 경로는 여기서 잡힌다.
- `pnpm lint`: 오류가 없고 경고·정보 수가 바탕과 같다.
- studio 단위 테스트 전체(`pnpm test --project studio`): 실패 목록이 바탕과 같다. `vi.mock`이 가리키는 파일이 없으면 테스트가 실패하지 않고 지나갈 수 있으므로, 옮긴 파일의 테스트만이 아니라 전체를 돌린다.
- `pnpm --filter @corral/studio build`. `new URL(…, import.meta.url)`의 경로는 typecheck가 보지 않는다.
- 옛 경로가 남지 않았다: 옮긴 이름마다 `rg -n "pages/<이름>" apps packages docs tools`가 비어 있다. `apps/server/test/files.test.ts`와 `packages/core/test/fuzzy.test.ts`의 `src/pages/SessionPage.tsx`는 이 저장소의 경로가 아닌 시험용 문자열이라 고치지 않는다.
- `vi.mock`의 상대 경로가 모두 있는 파일을 가리킨다. 아래 명령의 출력이 바탕과 같다.

```sh
rg -U -n --no-heading -o "vi\.mock\(\s*'(\.[^']+)'" -r '$1' apps packages |
  while IFS=: read -r f _ p; do [ -e "$(dirname "$f")/$p" ] || echo "$f: $p"; done
```

끝난 조건: 위 확인이 모두 바탕과 같고, 커밋에는 이름 바꿈과 경로 고침만 있다.

smoke E2E는 단계마다 돌리지 않는다. 마지막 이동(M17) 뒤 E 단계에서 [테스트 운영](../guides/testing.md)의 기본 E2E를 한 번 돌린다.

## 단계별 고칠 곳

"밖"은 옮기는 폴더 밖에서 옮기는 파일을 가리키는 파일이다. 경로는 `apps/studio/src/` 아래이고, 앞 단계에서 옮겨진 파일은 그 새 자리에서 고친다.

| 단계 | 옮김 | 밖 | 밖에서 고칠 곳 | 따로 볼 것 |
|---|---|---|---|---|
| M1 performance | 1 | 1 | `router.tsx`의 `import()` | |
| M2 schedules | 2 | 1 | `router.tsx` | |
| M3 compare | 2 | 1 | `router.tsx` | |
| M4 projects | 4 | 1 | `router.tsx` | |
| M5 feature-preview | 2 | 2 | `router.tsx`, `feature-preview/boundary.test.ts`의 `page` 경로 | 옮긴 뒤 `../feature-preview/…`는 `./…`이고 `../workbench/…`는 깊이가 같아 그대로다 |
| M6 inbox | 3 | 2 | `router.tsx`, `packages/react/src/components/NeedsYouAdvice.stories.tsx`(import 둘) | `InboxPage.test.tsx`가 `InboxPage.tsx`의 import 글자 `'../workbench/RunResponseArea.tsx'`를 단언하고 `../workbench/session/PendingTray.tsx`를 읽는다. 둘 다 한 단계 깊어진다 |
| M7 meeting | 4 | 2 | `SessionPage.tsx`, `density.test.ts`(`panels.meeting`과 `keptSmall` 두 줄) | `MeetingPage.shared.test.ts`가 `import.meta.dirname`에서 `../workbench/…`를 푼다. 한 단계 깊어진다 |
| M8 editor | 2 | 3 | `router.tsx`, `SessionPage.tsx`, `docs/plans/team-editor-usability.md`(링크 둘) | |
| M9 library | 8 | 3 | `router.tsx`, `docs/plans/team-composition-and-agent-library.md`(`LibraryResources`, `LibraryPage`), `docs/plans/team-editor-usability.md`(`LibraryTeams`) | `LibrarySkills.test.tsx`의 `./ResourceSettingsPage.tsx` import와 `./SettingsPage.tsx` mock은 `../…`가 된다 |
| M10 session | 13 | 3 | `router.tsx`, `design.test.ts`(`SessionPage.tsx` 경로), `workbench/browser/BrowserMenuDialogs.test.tsx`(fixture import) | `SessionPage.shell.test.tsx`의 `./AppearanceSettings.tsx` mock과 `SessionPage.context.test.tsx`의 `./Workbench.tsx` mock은 `../…`가 된다 |
| M11 models | 28 | 3 | `router.tsx`, `workbench/SettingsContent.tsx`, `docs/plans/session-usability.md`(경로 둘) | `ModelSettingsPage.tsx`의 import와 `ModelSettingsPage.tabs.test.tsx`의 mock `./SettingsPage.tsx`는 `../SettingsPage.tsx`가 된다 |
| M12 shell | 2 | 4 | `main.tsx`, `router.tsx`, `main.test.tsx`(mock 둘), `design.test.ts`(`RootLayout.tsx` 경로) | |
| M13 run | 3 | 4 | `router.tsx`, `workbench/session/SessionPanels.tsx`와 그 테스트의 mock, `density.test.ts`(`panels.runs`와 `keptSmall` 네 줄) | |
| M14 McpConnection | 2 | 5 | `workbench/RoleToolPicker.tsx`, `HarnessMcpTools.tsx`, `McpSettingsPage.tsx`와 그 테스트의 mock, `docs/specs/glossary.md`의 파일명 줄 | 옮긴 뒤 `../workbench/harness/…`는 `./…`, `../workbench/…`는 `../…`, `../services.tsx`는 `../../services.tsx`다 |
| M15 harness | 10 | 8 | `router.tsx`, `workbench/SettingsContent.tsx`, `workbench/HarnessRoleSettings.tsx`와 그 테스트의 mock, `workbench/RunHarnessOverrides.tsx`, `library/LibrarySkills.test.tsx`, `docs/specs/glossary.md`의 파일명 줄, `docs/plans/team-composition-and-agent-library.md`(`ResourceSettingsPage`) | |
| M16 changes | 9 | 12 | `workbench/`의 `SessionChangesPanel.tsx`, `GitPanel.tsx`, `GitConflicts.tsx`, `EditProposalReview.tsx`, `session/SessionPanels.tsx`와 그 테스트 다섯(`SessionChangesPanel.test.tsx`, `SessionChangesPanel.git.test.tsx`, `GitConflicts.test.tsx`, `EditProposalReview.test.tsx`, `session/SessionPanels.test.tsx`)의 mock, `density.test.ts`(`panels.changes` 두 줄과 `keptSmall` 한 줄), `docs/plans/session-panel.md` | `ReviewPage.tsx`의 `new URL('../diff.worker.ts', import.meta.url)`이 `'../../diff.worker.ts'`가 된다 |
| M17 settings | 19 | 15 | `router.tsx`, `workbench/SettingsContent.tsx`, `harness/`의 화면 넷과 테스트 다섯, `models/ModelSettingsPage.tsx`와 `ModelSettingsPage.tabs.test.tsx`, `library/LibrarySkills.test.tsx`, `session/SessionPage.shell.test.tsx`의 `AppearanceSettings` mock | |

경로를 가졌지만 이동으로 바뀌지 않는 것: Vitest의 `include: ['src/**/*.test.{ts,tsx}']`, Storybook의 `packages/react/src/**/*.stories.tsx`, `apps/studio/tsconfig.json`의 `include: ["src", …]`, `biome.json`의 `apps/**`와 먼저 합쳐지는 `apps/studio/src/**` 덮어쓰기, `index.css`의 `@source`(`packages/react/src`만 가리킨다). `e2e/`는 `src/demo/`만 import한다. `tools/`와 `.github/`에는 이 경로가 없다.

## 경로를 키로 쓰는 기준선

효과 훅·주석의 "늘지 않음" 검사는 파일 경로를 키로 한 기준선을 가진다. 이동 단계를 시작할 때 그 검사의 실제 파일과 명령을 다시 읽는다.

- 이동 커밋 안에서 옮긴 파일의 키를 새 경로로 바꾼다. 값은 그대로 둔다.
- 이동 단계에서는 기준선을 다시 만들지 않는다. 다시 만들면 늘어난 값이 함께 들어간다.
- 기준선 파일의 diff는 키 이름만 바뀌어야 한다. 두 검사가 바탕과 같이 끝나야 한다.

## 합쳐지지 않은 브랜치

`develop`에 없는 커밋이 `apps/studio/src/pages`를 고치는 로컬 브랜치는 아래 명령으로 다시 뽑는다. `git cherry`는 같은 patch만 합쳐진 것으로 보므로, squash로 합친 브랜치도 나온다. 나온 것은 하나씩 손으로 본다.

```sh
git for-each-ref --format='%(refname:short)' refs/heads | while read -r b; do
  for c in $(git cherry develop "$b" | sed -n 's/^+ //p'); do
    git show --format= --name-only "$c" -- apps/studio/src/pages | grep -q . && echo "$b $c"
  done
done | sort -u
```

- 살릴 브랜치는 그 파일을 옮긴 단계가 `develop`에 합쳐진 뒤 리베이스한다. `git mv`와 경로 고침이 한 커밋에 있어 이름 바꿈 추적이 옛 경로의 고침을 새 경로로 옮긴다.
- 그 브랜치가 `pages/` 맨 위에 새 파일을 더했다면 리베이스 뒤 [새 파일의 자리](#새-파일의-자리)대로 옮긴다.

## 정할 것

1. 화면의 자리: `pages/<기능>/`에 모으고, 그 기능만의 부품 폴더가 이미 있으면(`feature-preview/`) 거기에 둔다. 권장. 다른 길은 화면이 이름이 같은 공용 부품 폴더(`workbench/session/`, `workbench/harness/`)로 들어가는 것이다. 그러면 `session`의 파일 열세 개와 `harness`의 파일 열 개가 `workbench/`의 두 폴더로 가고 경계 규칙이 `workbench/`의 공용 파일과 화면을 가르지 못한다. 권장안에서는 `session`과 `harness`가 `pages/`와 `workbench/` 두 곳에 이름으로 있다.
2. 기능 미리보기 화면: `feature-preview/`에 넣는다(권장). 다른 길은 `pages/feature-preview/`다.
3. 입구: 폴더 맨 위의 `*Page.tsx`(`shell/`은 두 파일)로 한다(권장, 새 파일이 없고 지금의 `vi.mock`과 `import()` 경로가 그대로 맞는다). 다른 길은 폴더마다 `index.ts`를 새로 두는 것이다. `apps/studio/src`에는 아직 `index.ts`가 없다.
4. 회의 화면: `pages/meeting/`에 따로 둔다(권장). 다른 길은 `pages/session/` 안이다.
5. 변경 탭(`ReviewPage.tsx`, `LspProposals.tsx`와 테스트): `pages/changes/`에 둔다(권장). 다른 길은 그 탭의 다른 부품이 있는 `workbench/` 맨 위다.
6. `McpConnection.tsx`: `workbench/harness/`로 옮긴다(권장). 다른 길은 `pages/harness/`에 두고 `workbench/RoleToolPicker.tsx`를 경계 규칙의 예외로 두는 것이다.
7. 공용 세 파일(`FilesViews.tsx`, `Workbench.tsx`, `GettingStarted.tsx`)과 `FilesViews`의 테스트 셋: 이 계획에서는 `pages/` 맨 위에 둔다(권장). 다른 길은 `workbench/` 맨 위로 옮기는 것이다.
8. 설정: `settings`, `harness`, `models` 셋으로 나눈다(권장). 다른 길은 `pages/settings/` 하나(57개)다.
9. 합쳐지지 않은 브랜치: 이동은 기다리지 않고, 살릴 브랜치는 그 단계가 합쳐진 뒤 리베이스한다(권장).
10. 경계 lint(L 단계): `biome.json`의 `noRestrictedImports` 덮어쓰기로 폴더마다 쓴다(권장, 먼저 합쳐지는 `apps/studio/src/**`의 import 경계도 이 방식이다). 다른 길은 `feature-preview/boundary.test.ts` 같은 Vitest 검사다.
