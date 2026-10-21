# ABS-04 파일·앱 미리보기 검증

2026-10-20, CR-042 I06. Windows 작업 사본에서 검증했다.

기존 Files 패널에서 HTML·이미지 미리보기를 열고 갱신하거나 종료할 수 있다.
일반 브라우저의 HTML은 스크립트를 제거한 격리 frame에 표시한다. Desktop의
인터랙티브 보기와 모델 browser 도구는 별도 실행 환경에서 같은 preview lease를
참조한다. 실행 중 모델이 만든 lease는 Files의 열린 미리보기에 나타나며 원본 Run으로
이동할 수 있다. Run 종료·취소와 실행 실패 시 소유 lease 및 브라우저를 정리한다.

미리보기는 Corral과 다른 loopback host인 127.0.0.2에서 제공한다. 공개 lease 응답에
인터랙티브 렌더링용 헤더를 포함하지 않는다. 신뢰된 작업 사본의 정규 파일만 읽으며,
심볼릭 링크·숨김 경로·사본 밖 경로를 거절한다. 읽기 전용 Run의 파일은 입장 시점의
Git snapshot을 사용한다. Desktop의 raw HTML에서는 같은 사본 내 상대 asset 및
루트 상대 asset을 제공한다.

로컬 앱은 실행 중인 소유 command operation을 지정해야 한다. 실제 연결을 만든 뒤
그 established TCP 연결의 소유 프로세스가 Windows Job에 속하는지 확인하고 나서
HTTP/WS 바이트를 전달한다. 따라서 임의 localhost 포트 목록을 권한으로 사용하지
않는다. 앱 자신의 cookie·Authorization은 격리된 브라우저에서 유지하고 Corral의
인증 정보와 private preview 헤더는 upstream 앱에 전달하지 않는다. 다른 origin으로
향하는 리디렉션과 WebSocket은 차단한다.

검증 결과:

- `apps/server/test/preview.test.ts`: 6/6 통과. 실제 Windows Job의 HTTP·WebSocket,
  다른 세션 거절, 다른 origin 리디렉션 차단, 종료 후 재사용 거절, reader snapshot,
  static asset 갱신, script 제거, 만료되는 위임 credential을 확인했다.
- 같은 테스트에서 설치된 Chrome으로 실제 snapshot → 버튼 클릭 → `Count: 1`
  assertion → PNG 캡처를 실행했다. 같은 effect의 재시도가 두 번 클릭하지 않으며
  다른 Run은 lease를 사용할 수 없다. 불변 JSON/이미지 증거는 종료 뒤에도 조회된다.
- `apps/studio/e2e/server/file-preview.spec.ts`: 최종 자산
  `index-bFSG6hZg.js` / `index-P0zuN5FL.css`에서 2/2 통과.
  폴더 연결·신뢰·작업 사본 생성·Files 열기·갱신·종료 및 cookie 격리를 확인했다.
  일반 요청의 Coordinator 도구 경로에서 모델 lease를 만들고 실제 Chrome으로
  클릭·assert한 후, Files에서 정확히 같은 lease URL과 Run 출처를 확인했다.
  사용자 질문 응답과 기본 예산 승인 화면을 거쳐 Run 성공 및 lease 종료를 readback했다.
- `apps/studio/e2e/server/service-preview.spec.ts`: 같은 최종 자산에서 1/1 통과.
  일반 요청으로 service 명령 시작 → 포트를 늦게 여는 앱의 `preview_app` →
  실제 Chrome snapshot/assert → Files의 앱·명령·Run 출처 표시 → 전체 Run 취소를
  거쳐 command의 `cleanupConfirmed: true`와 lease 종료를 확인했다.
- `apps/server/test/preview-readiness.test.ts`: 실제 소유 서비스의 지연 bind와
  초기 503 후 정상 응답을 검사한다. 수정 전 즉시 `ECONNREFUSED`로 실패했고,
  수정 후 기존 native HTTP/WS 검사와 함께 통과했다. 15초의 전체 시작 예산 안에서
  연결·응답을 재시도하며 매번 실행 소유권과 작업 사본을 다시 확인한다.
  준비 중 lease는 목록과 Desktop 대상에 노출하지 않으며, 세션 8개·전체 64개의
  동시 시작 제한과 종료 정리에는 포함한다.
- `pnpm --filter @corral/server typecheck`와 변경한 preview 파일의 Biome 검사가 통과했다.

최종 backend 실행에서는 Chrome 경로를 명시해 두 preview 테스트 파일의 7개 검사가
모두 통과했다(2026-10-20 23:59 JST). 준비 상태 수정 후 서비스 UI 흐름도 다시 통과했다.

UI 화면은 `test-results/preview-final/`의 `file-preview.png`와
`run-owned-preview.png`, `test-results/preview-service-final/`의 `service-preview.png`에서
확인했다. 초기 모델 E2E 실패는 전체 대화에서 요소 참조를
찾아 다른 요소를 클릭한 테스트 오류였다. 최신 browser tool 결과만 읽도록 수정했고,
실제 클릭 결과 assertion을 유지했다. 완료 검사에서는 기존 기본 예산 승인 화면을
사용했다. 테스트용으로 예산이나 Coordinator 경로를 우회하지 않았다.

E2E의 모델 응답은 로컬 fake provider가 공급한다. 생산 prompt·도구·승인·Coordinator
경로와 실제 OS/브라우저 효과를 검사하며, 유료 모델의 판단 품질을 검증한 것은 아니다.
패키징된 Electron 창의 실제 조작은 Desktop 검증 문서에서 별도로 기록한다.
macOS의 앱 TCP 소유권 확인은 제공하지 않으며 실패 시 차단한다. Linux 구현은 이
Windows 실행에서 검증하지 않았다.
