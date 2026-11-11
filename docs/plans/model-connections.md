# 모델 연결과 자동 모델 목록: 작업 계획

명세: [모델 연결과 자동 모델 목록](../specs/features/model-connections.md), [모델·추론·리소스](../specs/models-and-resources.md), [모델 안내](../guides/models.md), [API 계약](../specs/api-contract.md).

브랜치 `feat/model-connections` (`feat/appearance` @ `fa459eab`에서 분기).

| 단계 | 내용 | 상태 |
|---|---|---|
| 0 | 명세 | 끝 |
| 1 | 서버·계약: 모든 Pi 공급자 연결, 연결에서 온 모델의 프로필 ID와 해석, Pi 추론 수준, 프로필 한도 제거, 엔드포인트 모델 가져오기와 캐시, 모델 단위 엔드포인트 해시, API | 끝 (`24232fad`..`e3dd4a00`) |
| 2 | 화면: 설정 → 모델의 연결 탭과 연결 추가, 엔드포인트 편집(모델 없이 저장, 새로 고침, 값의 출처), 모델 선택기의 검색과 공급자 묶음, 팀 편집기·회의의 모델 선택 | 끝 (`ed1b7a1b`..`95f41803`, 서버 리뷰 반영 `040be219`). 디자인 검토 수정과 코드 리뷰가 진행 중 |
| 3 | 직접 조작(라이브 서버), 확장 E2E 정리, 검사, PR 문서 | 진행 중: 실제 OpenAI 구독 로그인으로 연결·프로필·선택기를 읽기 전용으로 확인함 |

## 다음

디자인 검토 수정과 화면 코드 리뷰 결과를 반영하고, 병합한 트리에서 검사를 다시 돌린 뒤 PR 문서를 쓴다. 확장 E2E 정리는 뒤로 미뤄져 있다.

## 남은 문제

- 동적 목록만으로 아는 모델은 호스트에서 풀리지만 worker는 Pi의 정적 카탈로그에서 모델을 찾는다. 실제 실행은 확인하지 못했다.
- 실제 공급자 로그인(기기 코드 포함), 실제 엔드포인트, models.dev는 확인하지 못했다. 테스트는 가짜와 loopback만 썼다.
- E2E는 돌리지 않았다. 옛 화면을 조작하는 파일: `apps/studio/e2e/server/{models,model-recovery,model-imports,settings-controls,contextual-settings,harness-mcp,layout,image-profiles,ux-review}.spec.ts`, `composer-controls.spec.ts`, `workbench-identification.spec.ts`, `apps/studio/e2e/workbench.ts`.
- 서버를 다시 시작한 뒤에는 재시작 전 새로 고침으로 값이 바뀐 엔드포인트 모델의 Run 요청이 거절된다(고정한 정의가 프로세스 안에 있다).
- Pi가 주소로 알아보는 호스트의 엔드포인트는 Corral이 전송 형식을 대조하지 않는다.
- 실제 Anthropic 구독 로그인, 기기 코드 로그인, 키 저장과 연결 해제는 화면에서 눌러 보지 않았다(공유 자격 증명을 건드리지 않으려고).
- 서버의 거절 사유는 영어 문장 그대로 보인다(한국어 화면 포함).
- 금고 내보내기는 여전히 프로필이 쓰는 공급자만 다룬다.
