# 모델 연결과 자동 모델 목록: 작업 계획

명세: [모델 연결과 자동 모델 목록](../specs/features/model-connections.md), [모델·추론·리소스](../specs/models-and-resources.md), [모델 안내](../guides/models.md), [API 계약](../specs/api-contract.md).

브랜치 `feat/model-connections` (`feat/appearance` @ `fa459eab`에서 분기).

| 단계 | 내용 | 상태 |
|---|---|---|
| 0 | 명세 | 끝 |
| 1 | 서버·계약: 모든 Pi 공급자 연결, 연결에서 온 모델의 프로필 ID와 해석, Pi 추론 수준, 프로필 한도 제거, 엔드포인트 모델 가져오기와 캐시, 모델 단위 엔드포인트 해시, API | 끝 (`24232fad`..`e3dd4a00`) |
| 2 | 화면: 설정 → 모델의 연결 탭과 연결 추가, 엔드포인트 편집(모델 없이 저장, 새로 고침, 값의 출처), 모델 선택기의 검색과 공급자 묶음, 팀 편집기·회의의 모델 선택 | 대기 |
| 3 | 직접 조작(라이브 서버), 확장 E2E 정리, 검사, PR 문서 | 대기 |

## 다음

2단계를 구현하고 1단계의 리뷰 결과를 반영한다.

## 남은 문제

- 동적 목록만으로 아는 모델은 호스트에서 풀리지만 worker는 Pi의 정적 카탈로그에서 모델을 찾는다. 실제 실행은 확인하지 못했다.
- 실제 공급자 로그인(기기 코드 포함), 실제 엔드포인트, models.dev는 확인하지 못했다. 테스트는 가짜와 loopback만 썼다.
- E2E는 돌리지 않았다. 바뀐 동작을 가정할 수 있는 파일: `apps/studio/e2e/server/models.spec.ts`, `settings-controls.spec.ts`, `composer-controls.spec.ts`, `workbench-identification.spec.ts`.
- 금고 내보내기는 여전히 프로필이 쓰는 공급자만 다룬다.
