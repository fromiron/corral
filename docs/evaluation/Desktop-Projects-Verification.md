# ABS-09 프로젝트·자료 구현 검증

2026-10-20, CR-042의 I11 범위.

프로젝트 목록에서 저장소를 새 폴더에 복제하고, 기존 폴더 연결 경로로 프로젝트를 만들 수 있다.
복제와 저장소 신뢰는 별개다. 기존 폴더는 덮어쓰지 않으며 Git hooks와 checkout filter 설정을
차단한 상태에서 파일을 체크아웃한다. 빈 저장소를 복제해도 초기 commit을 만들지 않는다.
취소는 소유 프로세스 종료 확인과 구분하며, 종료를 확인한 실패·취소 작업만 미완료 폴더를
정리할 수 있다. 정리 전에 예약했던 절대 경로와 디렉터리 identity를 다시 확인한다.
재시작한 작업은 interrupted로 표시하고 자동 실행하거나 PID만으로 프로세스를 종료하지 않는다.

프로젝트 폴더 탭에서 지침·메모리를 작성하고 새 버전을 저장하거나 보관한다.
컴포저의 ‘프로젝트 자료 첨부’에서 선택해야 요청에 들어간다. 기존 TextAttachment의
내용·SHA-256·크기 검증과 요청 snapshot 경로를 그대로 사용하며 자동 prompt 주입은 없다.
보관·수정·설정 금고의 복구는 과거 버전과 기존 요청 snapshot을 덮지 않는다.

검증된 흐름:

- Windows에서 실제 Git clone, 파일 내용 readback, 기존 대상 거절, URL credential 거절.
- 실제 소유 프로세스 취소와 종료 확인, 확인 후 미완료 폴더 정리.
- 빈 저장소 복제 후 HEAD가 없음을 확인.
- 문서 수정·보관·서비스 재생성 후 과거 첨부 snapshot 보존, 다른 프로젝트 접근 거절.
- 설정 금고의 명시 프로젝트 binding, 관련 없는 문서 보존, 중복 operationId 처리,
  새 버전을 추가하는 apply/restore와 원본 첨부 보존.
- Studio 프로젝트 화면에서 clone → 폴더 선택 → 프로젝트 생성 → trusted=false readback →
  신뢰 checkbox를 통한 명시 선택 → 문서 저장/새로고침 → 세션에서 직접 첨부 →
  초안 새로고침 → Send → Coordinator의 RunSnapshot에 선택한 내용이 들어감을 확인.

`apps/server/test/project-materials.test.ts`의 6개 테스트와
`apps/studio/e2e/server/project-materials.spec.ts`의 실제 UI 흐름 1개가 통과했다.
E2E의 Studio 자산은 `index-DwXevtmi.js` / `index-CSYNBMFu.css`였다.
마지막 성공 실행에서는 서버 종료와 임시 폴더 정리도 완료됐다.
초기의 UI 검사 실패는 기존 비동기 trust checkbox에 대한 즉시 `check()` 검사와
부분 이름으로 여러 Request combobox를 찾은 선택자 때문이었다. 실제 서버 readback을
기다리고 정확한 accessible name을 선택하도록 수정했다.

지침 첨부 화면은 로컬 검사 결과
`test-results/abs-project-materials/server-project-materials---d667e-tach-versioned-instructions-server/explicit-project-document.png`
에서 확인했다. 기존 한 줄 헤더와 오른쪽 요약 카드가 유지되고 첨부 자료가 대화에 표시됐다.

Git clone은 로컬 저장소를 실제 OS Git으로 검사했다. 외부 Git 서비스의 인증,
SSH 키 설정, 네트워크 장애 복구는 이번 검사에서 수행하지 않았다. 요청 전달은 기존
시뮬레이션 실행을 사용했으므로 유료 모델의 지침 이해 품질에 대한 검증은 아니다.
