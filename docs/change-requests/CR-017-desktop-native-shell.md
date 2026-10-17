# CR-017: 데스크톱 앱의 네이티브 동작

- 요청: Bell, 2026-10-17 — T3 Code·PI-Desktop·Claude/ChatGPT 데스크톱 수준의 완성도. [Workbench 완성도 개선 플랜](../plans/Workbench-Polish-Plan.md) P5.
- 기준: CR-014(데스크톱 워크벤치, Linux x64 AppImage). 새 라이브러리 없음. 렌더러는 계속 파일 시스템에 손대지 않는다.

## 바뀌는 것

| 영역 | 지금(CR-014) | 바뀐 뒤 |
|---|---|---|
| 창 버튼 | `frame:false`. Studio가 −·□·× 버튼을 직접 그림 | Linux/Windows는 `titleBarStyle:'hidden'` + `titleBarOverlay`(높이 52px, 위쪽 바와 같음), macOS는 `hiddenInset`. 시스템이 창 버튼을 그리고, Studio는 `env(titlebar-area-*)`만큼 오른쪽을 비운다. 직접 그린 버튼은 지운다 |
| 테마 | 배경 `#151515` 고정 | 페이지 테마를 `desktop:theme(dark)`로 받아 창 배경색과 오버레이 색을 바꾼다. 마지막 테마를 기억해 다음 실행 때 그 색으로 연다. 첫 화면이 그려진 뒤에 창을 보인다(`ready-to-show`) |
| 메뉴 | Corral(작업 공간 열기, 종료), Edit, View | **파일**: 새 세션, 작업 공간 열기, 최근 작업 공간(5개), 설정, 종료<br>**편집**: 서식 없이 붙여넣기 추가<br>**보기**: 명령 팔레트, 사이드바, 사이드 패널, 요청 입력칸, 뒤로·앞으로, 확대, 전체 화면<br>**창**<br>**도움말**: 단축키, 릴리스 |
| 메뉴 → 페이지 | 없음 | 메뉴는 `desktop:command` 이벤트로 **이름만** 보낸다. 허용 목록(`DESKTOP_COMMANDS`)은 main(`security.ts`)과 preload 양쪽에서 확인한다. 페이지는 같은 이름의 단축키 명령(CR-016 레지스트리)을 실행한다 |
| 우클릭 | 없음 | 입력칸: 맞춤법 제안·잘라내기·복사·붙여넣기·전체 선택. 선택한 글자: 복사. http(s) 링크: 링크 복사 |
| 창 상태 | 이동·종료 때만 저장 | 크기·위치·최대화가 바뀔 때마다 500ms 뒤 저장한다(비정상 종료에도 남음) |
| 알림 | 없음 | 설정 › 일반의 "알림"을 켰을 때(기본 꺼짐)만 보낸다. 조건은 Inbox 항목이 늘었고 창이 포커스 밖일 때다. 알림 글자는 제어 문자를 지우고 제목 120자·본문 300자로 자른다. 작업 표시줄 배지는 Inbox 개수다(지원하는 데스크톱 환경에서만) |
| 제목 표시줄 더블클릭 | 없음 | 빈 위쪽 바를 더블클릭하면 최대화·복원한다 |

## 보안 경계

- **새 IPC**: `theme`·`notify`·`badge`. 모두 기존 `trustedSender` 검사(메인 프레임, 신뢰한 origin 또는 시작 화면)를 지나야 한다.
- **입력 검증**: `themeColors`는 boolean만, `notificationText`는 문자열과 길이·제어 문자, `badge`는 0–999 정수만 받는다.
- **preload**: `onCommand`는 허용된 이름의 문자열만 콜백에 넘긴다. Electron 이벤트 객체는 페이지로 넘기지 않는다.
- **최근 작업 공간**: 절대 경로 5개까지 `desktop.json`에 둔다. 메뉴에만 보이고 페이지로는 보내지 않는다.

## 테스트

| ID | 내용 | 위치 |
|---|---|---|
| CR-017 command | 허용 목록 밖의 이름·형식은 null | `apps/desktop/test/security.test.ts` |
| CR-017 theme | boolean만 색으로 바뀜 | 같은 파일 |
| CR-017 notify | 길이 제한, 제어 문자 제거, 빈 제목 거절 | 같은 파일 |
| CR-017 recent | 절대 경로 5개, 중복 없음, 최신 순 | 같은 파일 |
| — | 단축키 표가 데스크톱에서만 Ctrl+N·숫자 키를 쓰는지 | `apps/studio/src/shortcuts.test.ts` |

## 검증하지 못한 것

- Linux의 `titleBarOverlay` 투명도와 Wayland/X11에서의 버튼 표시는 실제 AppImage smoke로만 확인할 수 있다. 결과는 최종 보고에 적는다.
- macOS·Windows는 CR-014대로 패키징 범위 밖이다. 코드는 분기만 두었고 실행해 보지 않았다.
- 알림 배지(`app.setBadgeCount`)는 Unity 계열 데스크톱에서만 보인다.
