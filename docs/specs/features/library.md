# 기능 명세: 라이브러리

- 상태: accepted
- 비목표: Skill·Hook·MCP·패키지 설정 폼을 설정 모달 밖으로 옮기기, 설정 주소 변경, 팀 정의·revision 규칙 변경

## 사용자 관측 동작

사이드바 주 메뉴의 **라이브러리**는 다시 쓰는 구성 요소를 찾고 상태를 확인하는 곳이다. 세 보기로 나뉜다.

| 보기 | 주소 | 내용 |
|---|---|---|
| 팀 | `/library/teams` | 저장한 Corral(팀) 목록 → 상세 → "이 팀으로 새 대화"·"편집"·"복제" |
| 템플릿 | `/library/templates` | 팀 템플릿과 목표에서 초안 만들기 |
| 리소스 | `/library/resources` | Skill·Hook·MCP 서버·패키지·확장 목록과 상태 |

- 팀과 템플릿은 프로젝트 필터(`?project=`)를 가진다. 필터가 없으면 마지막으로 연 프로젝트를 쓴다. 프로젝트 작업공간에는 팀 탭이 없다. 옛 `/projects/:projectId#corrals` 주소는 `/library/teams?project=:projectId`로 replace 이동한다.
- 리소스 행은 이름, 범위(개인·프로젝트), 상태, 실패 원인과 다음 행동을 보인다. 실패 원인으로 읽는 것:
  - 패키지 설치 거부(크기·파일 수 한도)
  - 루트 `SKILL.md` 패키지의 Skill 판정
  - 하네스 보고 코드 `extension_load_failed`, `resource_invalid`, `policy_denied`, `sdk_start_failed`(`packages/contracts/src/harness.ts`)
  - 충돌한 도구 이름처럼 계약에 없는 세부는 보이지 않는다.
- 리소스의 "관리"는 라이브러리 주소에 `settings=<section>`·`settingsProject=<id>`를 더해 [설정 모달](../workbench.md#문맥형-설정)을 그 위에 연다. 편집·신뢰·설치·미저장 보호는 설정 모달이 소유한다. 모달을 닫으면 라이브러리의 같은 보기와 스크롤로 돌아온다.
- 세션의 팀 선택기에서 "Corral 만들기·관리"는 `/library/teams?project=<id>&returnTo=<세션 주소>`로 간다. 돌아가기는 세션의 초안·탭을 그대로 복원한다.

## 계약

- 팀 목록·상세·생성·복제·삭제는 기존 Corral API와 revision 규칙을 그대로 쓴다. 명시한 Corral이 삭제된 세션은 조용히 auto로 바뀌지 않는다.
- 리소스 보기는 읽기 전용이다. 라이브러리 화면 자체에는 저장할 폼이 없다.
- 리소스 조회가 실패하면 그 묶음만 실패와 다시 시도를 보이고 다른 묶음은 유지한다. 조회 실패를 "없음"으로 표시하지 않는다.
- 브라우저 데모에서 서버 전용 리소스는 "로컬 서버에서 사용" 상태 하나로 보인다.

## 수용 시나리오

```gherkin
Given 프로젝트 A에 저장한 팀 두 개가 있다
When 사용자가 /projects/A#corrals 를 연다
Then 주소가 /library/teams?project=A 로 바뀌고 두 팀이 보인다
And 뒤로가기는 이전 작업 화면으로 간다

Given 라이브러리 리소스에서 MCP 서버의 "관리"를 누른다
When 설정 모달에서 값을 바꾸고 저장하지 않은 채 닫으려 한다
Then 저장하고 이동 / 버리기 / 계속 편집을 묻는다

Given 패키지가 크기 한도로 설치 거부되었다
When 리소스 보기를 연다
Then 그 행에 한도 초과 원인과 다음 행동이 보인다
```

## 보안·성능·접근성

- 리소스 행은 로컬 경로·토큰을 보이지 않는다.
- 보기 전환은 디자인킷 Tabs이고 목록은 Table이다.
