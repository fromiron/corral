# P20 미리보기 요소 피드백 — 구현·핵심 검증

- 기준: `d658830` 위 이 문서를 포함한 구현 묶음. CR-046 P20, CRL-WBD-020/C-164/TC-WBD-020-H,N,F.
- Linux x64, Node 24.19.0, Electron 44.4.5, 현재 production Studio와 `prepare:runtime`으로 갱신한 Desktop 실행물. 개인 작업 공간·provider credential·유료 호출을 사용하지 않는다.
- 기존 실제 Desktop preview view·partition·lease와 Composer 첨부를 재사용했다. agent의 별도 headless browser를 사람 화면의 관측으로 대체하지 않았으며, preview에 preload나 임의 실행 API를 추가하지 않았다. 새 제품 의존성은 없다.

## 필요한 회귀

| 범위 | 결과 | 로그 |
|---|---|---|
| native 캡처 수명·선택 요소 추출과 기존 preview 정책/원격 수명 | 10 PASS (4파일) | `/tmp/corral-p20-capture-red.log`, `/tmp/corral-p20-observation-red.log`, `/tmp/corral-p20-desktop-green.log` |
| UI 검토/첨부·미저장 대화 세대·취소·범위·기존 source/Composer 연결 | 24 PASS (7파일) | `/tmp/corral-p20-ui-regression.log` |
| 잘못된 사본 응답과 최종 검토 UI | 위 UI 묶음에 포함, 최종 3 PASS | `/tmp/corral-p20-feedback-scope-red.log`, `/tmp/corral-p20-feedback-final.log` |
| preview provenance·인증 URL/가짜 source revision 거절 | 3 PASS | `/tmp/corral-p20-contract-red.log`, `/tmp/corral-p20-contract-green.log` |

묶음의 중복 시험을 합산하지 않는다. 텍스트·이미지 원자 첨부의 실패 반례는 `/tmp/corral-p20-atomic-red.log`, 출처 경계는 `/tmp/corral-p20-source-red.log`에 남았다. native capture 메서드 부재로 3개 core 시험이 실패했고 구현 후 통과했다. 요소 추출의 첫 red는 구현 module 부재에 의한 import 실패였으며 본문 assertion 실패로 표현하지 않는다.

contracts/core·Studio·Desktop 타입 검사, production Studio build·Desktop runtime 준비, generated 계약 검사가 통과했다. 기존 큰 chunk 경고는 유지된다. 타입 결과는 `/tmp/corral-p20-contract-types.log`, `/tmp/corral-p20-feedback-types.log`, `/tmp/corral-p20-desktop-types.log`, 실행물 준비는 `/tmp/corral-p20-build.log`, `/tmp/corral-p20-prepare.log`에 있다. 변경 코드의 Biome 오류와 공백 오류는 없고 기존/fixture 경고는 남았다.

## 실제 Desktop 확인

`apps/desktop/scripts/preview-feedback-smoke.ts`는 격리 data-dir와 실제 Git 사본·Node HTTP task를 사용한다. provider 대신 기존 mock mode의 요청 한 번만 사용하며, 이후의 파일 수정은 fixture가 명시적으로 수행한다. 모델이 실제 코드를 고쳤다는 증거로 쓰지 않는다.

최종 결과는 PASS(`/tmp/corral-p20-native.log`). 실제 view의 CSS·버튼 동작, 별도 cookie jar·preload/require 부재, native 창 닫기와 동일 lease 재열기를 확인했다. 선택한 요소의 실제 crop → 검토 → 텍스트/이미지 첨부를 확인했고, 기존 mock 모델의 이미지 입력 미지원 거절(403) 뒤에도 두 첨부와 초안이 남았다. UI에서 이미지만 제거한 텍스트 mock Run 한 번은 성공했다. 명시 CAS 저장 뒤 같은 lease/URL의 화면이 갱신됐으며 원본 파일은 그대로였다. task 중지 시 preview가 자동으로 닫히고 cleanupConfirmed가 true가 됐다. fixture 앱/task/사본을 정리했다.

준비 중 APIRequestContext가 Desktop partition cookie를 공유하지 않는 점, CreateCorral의 발급 ID와 native 선택 준비 순서를 fixture에서 바로잡았다. 인증 경계나 제품 타임아웃을 완화하지 않았다. 이미지 포함 mock의 초기 거절 로그는 `/tmp/corral-p20-native-image-boundary.log`에 보존했다. 실제 이미지 지원 모델 실행은 검증하지 않았고 이를 위해 기존 mock capability를 바꾸지 않았다.

임시 화면 증거: `/tmp/corral-p20-preview.png`, `/tmp/corral-p20-review.png`, `/tmp/corral-p20-attached.png`, `/tmp/corral-p20-updated.png`. 최종 검토 화면은 선택 내용·이미지를 먼저, 기술 정보를 접힌 상세에 표시하는 것을 직접 확인했다.

## 범위와 한계

선택 요소의 텍스트·스타일은 한정하고 입력/편집 값은 제외한다. 스크린샷은 선택 영역만, 최대 2048px·1MiB이며 입력 영역이 포함되면 거절한다. 콘솔은 명시 포함 시 캡처 대기 중 최대 20개·각 1000자다. 캡처 중 탐색/lease 변경·종료·Esc·30초 제한을 검사한다. source revision은 확인 불가이며 관측 시점의 DOM과 Git tree가 원자적으로 일치한다고 주장하지 않는다.

구현 API는 설치된 Electron 44.4.5 타입과 [공식 webContents 문서](https://www.electronjs.org/docs/latest/api/web-contents)의 isolated world·context menu·capturePage 경로를 확인했다. Context7 도구는 이 세션에서 제공되지 않았다. 원격 capture·모든 지원 OS·설치/서명/업데이트·전체 성능/접근성 인수는 이번 핵심 검증 범위가 아니다. 기존 원격 미리보기 열기는 유지한다.
