# 구조와 상태 소유권

상태의 소유권을 라이브러리나 화면 편의에 따라 중복하지 않는다. 현재 코드 위치는 다음과 같다.

| 경계 | 위치 | 역할 |
|---|---|---|
| 사용자 인터페이스 | `apps/studio`, `packages/react` | 편집 draft, 조회 캐시, 실행 projection, 대화·결과·Reins |
| Desktop | `apps/desktop` | Electron 셸, 로컬 runtime 수명과 패키징 |
| 서버·클라이언트 | `apps/server`, `packages/client` | 설정·프로젝트 서비스, HTTP·SSE와 클라이언트 계약 |
| 도메인 | `packages/core`, `packages/contracts` | Coordinator, 명령·이벤트·상태·사용량, 검증 가능한 타입 |
| 실행 어댑터 | `packages/adapter-pi`, `packages/runner-langgraph` | 모델·도구 실행과 정적 제어 흐름을 기존 Coordinator 경로에 연결 |
| 관리형 모델 요청 | `apps/server/src/models/request-runtime.ts`, `packages/pi-runtime-port` | host 전송·attempt 정산·공유 context/stream 정책 |
| 저장 | `packages/storage-sqlite` | 영속 기록·투영·재열람 |
| 도구 | `packages/cli`, `packages/testkit`, `tools/release` | CLI, 결정적 시험 대역, 출시 검사 |

## Studio 화면 폴더

Studio의 화면은 `apps/studio/src/pages/<기능>/` 기능 폴더에 있고, 폴더 이름은 [용어집](glossary.md)의 코드·URL 이름이다. 폴더 맨 위의 `*Page.tsx`가 그 폴더의 입구이고, `shell/`만 `RootLayout.tsx`와 `StartupFailure.tsx`가 입구다. `pages/` 맨 위의 파일은 여러 화면이 쓰는 공용 파일이다.

- 기능 폴더 안의 파일끼리, 그리고 기능 폴더에서 `workbench/`, `src/` 맨 위, `pages/` 맨 위, 패키지로는 자유롭게 import한다.
- 기능 폴더 밖의 파일(다른 기능 폴더, `workbench/`, `src/` 맨 위, `packages/`)은 그 폴더의 입구만 import한다. 테스트(`*.test.ts`, `*.test.tsx`)와 스토리(`*.stories.tsx`)는 다른 기능 폴더의 `*.fixture.tsx`, `*.story-fixture.tsx`도 import한다.
- `pages/` 맨 위의 공용 파일은 누구나 import하고, 공용 파일은 기능 폴더를 import하지 않는다.
- `vi.mock` 계열의 경로와 테스트가 소스를 글자로 읽는 경로는 import가 아니다.

`pnpm lint`가 [feature-folders.ts](../../tools/lint/feature-folders.ts)로 이 경계를 검사한다. 무엇을 import로 세는지와 입구·fixture를 가리는 방법은 그 코드가 정본이다.

새 파일은 다음 자리에 둔다.

- 한 기능 폴더만 쓰는 파일은 그 폴더에 둔다. 다른 기능이 쓸 것은 입구 파일에서 export한다.
- 화면(라우트의 화면이거나, 다른 화면이 통째로 그리는 화면)은 자기 기능 폴더를 가지고, 그 `<이름>Page.tsx`가 입구다. 화면은 부품 폴더(`workbench/session/`, `workbench/harness/`, `feature-preview/`)에 두지 않는다.
- 두 기능 폴더 이상이 쓰는 파일은 그 부품이 속한 `workbench/`의 폴더에 두고, 맞는 폴더가 없으면 `pages/` 맨 위에 둔다.
- 테스트는 검사하는 파일과 같은 폴더에 `<파일>.<관점>.test.tsx`로 두고, fixture는 그것을 쓰는 테스트의 폴더에 둔다.

## 소유권

Run·Task·Execution·Approval, event sequence, control revision, 실행 효과의 permit·사용량·완료는 Coordinator 경로에서 확정한다. Pi와 GraphRunner는 실행 어댑터이며, UI store는 관찰용 투영이다. 스트리밍 delta나 어댑터 반환만으로 Run 성공을 확정하지 않는다.

정의·설정·import·금고의 저장은 각 기존 서비스의 revision·원자 저장 경로를 따른다. 모든 설정 변경을 새로운 Coordinator 원장으로 옮기거나, 반대로 설정 저장소가 실행 효과를 직접 확정하게 만들지 않는다.

영속 이벤트와 현재 SQL 투영의 트랜잭션 경계를 지킨다. 실행 당시 snapshot과 산출물 버전은 불변이다. 편집 draft나 미래 설정 변경은 과거 Run의 입력을 바꾸지 않는다.

`contracts/core`는 DOM·React에 의존하지 않는다. Studio에서 DB·Pi·credential 저장소를 직접 다루지 않는다. 구체적인 인터페이스 변경은 코드와 해당 계약 시험을 함께 확인한다.

## 상세 자료

[기술 설계](technical-design.md)의 상태 소유·전이·통신 상세를 필요한 범위만 읽는다. 그 문서의 인터페이스 예시는 실제 라이브러리 호출 코드가 아니다. Desktop·host·동시성 변경 범위를 함께 확인한다.

실행 불변식은 [실행과 안전](execution-and-safety.md), API 변경은 [API](api.md)에 연결한다.
