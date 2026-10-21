# 기본 대화 UX 구현·셀프리뷰

2026-10-21. [CR-043](../change-requests/CR-043-chat-first-optional-corral.md)의 변경 범위 검증이다. 전체 제품 출시 승인이나 사용자 연구 결과가 아니다.

## 적용한 흐름

새 대화 → 메시지 작성 → 전송 → 결과 확인이 기본 흐름이다. 사용자 Corral, 목적, 제목, 템플릿, 작업 폴더를 먼저 만들지 않는다. 기존 `corralId: null` → auto 시작 → Coordinator → Run → 저장 이력을 사용한다.

- 새 프로젝트는 Sessions 탭부터 시작한다. Corral 제작을 시작 안내의 필수 단계에서 제거했다. 저장한 탭, 명시 `#corrals` 링크, 편집기, D&D, Reins는 유지했다.
- 빈 대화에서는 안내와 입력창을 가까이 배치하고 입력에 초점을 둔다. 메시지가 생기면 같은 입력 컴포넌트를 유지한 채 하단 대화 흐름으로 전환한다.
- 기본 입력창에는 입력, 첨부·참조, 모델, 권한, 음성, 전송을 남겼다. Corral·작업 스타일·역할별 설정·품질·검증·자료·템플릿은 요청 옵션에서 연다.
- 선택한 Corral 및 비기본 설정은 닫힌 입력창에도 요약한다. 오류·승인·전송 차단 이유와 복구는 숨기지 않는다.
- 기존 승인 정책을 유지한다. 선택하지 않은 추론의 내부 설명만 모델 칩에서 제거하고, 명시한 추론은 긴 모델명과 별도로 표시한다.

`AUTHORITY INVERSION`: Corral 없는 시작을 허용하는 CR-024 및 사용자 요청과 달리, 기존 기본 팀 탭·시작 안내가 Corral 제작을 선행 조건처럼 제시했다. 기본 진입을 바로잡았으며 실행 엔진을 교체하지 않았다.

## 적용한 판단

이해하기 쉬워졌다는 판단은 설계 판단이며 실제 사용자 연구의 측정값이 아니다. 자주 쓰는 조작은 입력창에 두고, 선택 구성은 메뉴에 둔다. 권한 선택은 입력창에 두고, 실제 승인·거절은 요청 맥락에서 처리한다. 다른 제품의 권한 기본값은 이 변경의 계약이 아니다.

## 셀프리뷰에서 실제로 수정한 문제

1. **숨겨진 전송 차단 이유:** Review only/Release를 선택한 채 Queue로 바꾸면 전송은 막히지만 안내도 옵션 안에 숨었다. 실제 요청의 `awaiting_user` → Queue → 옵션 닫기로 RED를 확인했다. 안내와 `Change scope` 복구를 항상 보이는 영역으로 이동했고, 초안 유지 → 설정 해제 → 실제 큐 저장까지 GREEN이다.
2. **참조 목록 잘림:** 줄인 입력창의 `overflow-hidden`이 위로 열리는 Results/Runs 목록을 잘라 일반 클릭이 뒤쪽 대화에 닿았다. 실패 trace·실제 캡처로 확인하고 외곽 clipping을 제거했다. 같은 클릭 → 정확한 결과 버전 참조 → 재로드 → Coordinator brief 검사가 통과했다.
3. **닫힌 옵션 뒤 첨부 오류 유실:** 자료를 선택한 뒤 Escape를 누르면 늦은 HTTP 409 오류가 숨었다. 지연 실패를 실제 첨부 UI에 주입해 RED를 확인하고 부모 입력창으로 오류를 전달했다. 실패 시 초안·기존 첨부 보존, 다시 선택 → 실제 HTTP 성공 → 재로드 보존을 확인했다.
4. **긴 모델명에 추론 설정이 가려짐:** 390px에서 High가 잘렸고, 첫 수정 후에는 긴 Ultra 표시가 버튼 밖으로 밀렸다. 모델명만 줄이고 명시 추론에 필요한 폭을 허용했다. High·Automatic·영어/한국어 Ultra의 실제 글자 영역과 문서 폭을 확인했다.
5. **팀 탭 링크 고착:** `#corrals` 진입 후 다른 탭을 눌러도 hash가 다시 팀 탭으로 돌렸다. 명시 탭 전환 시 hash를 정리해 재로드까지 선택을 보존한다.

기존 비서버 테스트 한 건은 실제 demo 응답과 다른 testkit 기본 문구를 기대했다. 변경 전 소스와 CR-024의 모의 실행 표기를 확인한 뒤 실제 `Simulated … No model was called.` 문구, 입력한 목적, 성공 상태, 단일 실행과 노드 완료를 함께 검사하도록 바로잡았다. 실제 모델 성공으로 대체하지 않았다.

## 실행 증거

기준 checkout은 `feat/desktop-capabilities`, base HEAD `ad0bb6da6f20ca685e58b619e4e311464102a0b9`의 미커밋 변경이다. 앞선 기능 구현과 이번 UX 변경을 포함한다.

| 검사 | 결과와 자산 |
|---|---|
| 새 프로젝트 진입 4개 | `Bqcqpk39`에서 4/4 PASS. Corral 0개 → 실제 요청 → Coordinator 성공 → 저장·재로드, 선택 템플릿·목적·탭·호환 모델 준비 |
| 새 composer 4개 | `oZ0AUNMA`에서 4/4 PASS. 기본 대화, 선택 옵션 snapshot·초안, Corral 선택·해제, Queue 차단 복구 |
| 자료 첨부 실패·재시도 | `oZ0AUNMA`에서 1/1 PASS. 실제 서버 자료 생성·첨부, 실패만 HTTP 주입 |
| 긴 모델명·추론 2개 | 최종 `DEI0pIX7`에서 2/2 PASS. 390px, 영어/한국어, 명시 선택 저장·재로드 |
| 최종 UI 배치 재검사 | `DEI0pIX7`에서 기본 대화·390px 옵션 2/2 PASS. reduced-motion 실제 설정·readback, popup 표시·닫기·초점 복귀·실제 실행 snapshot 확인 |
| 기존 서버 UI 회귀 | 36개 고유 사례 PASS. 최초 `Bqcqpk39` 35 PASS/1 FAIL, clipping 수정 후 `oZ0AUNMA`에서 같은 실패 사례와 관련 2개 PASS. 과거 실패 로그 보존 |
| 기존 편집·탐색 회귀 | Chromium 12/12 PASS. Vite 개발 소스 환경이며 배포 번들 검사와 구분 |
| locale·초안·역할 설정 | 3파일 10/10 PASS |
| 타입·정적 검사 | Studio typecheck PASS. 변경 제품 파일 Biome 오류 0, 기존 ChatView non-null 경고 3개. diff check PASS |
| spec 검사 | 문서·추적표 갱신 후 PASS, 시나리오 태그 292/293. 태그는 실행 성공의 증거가 아님 |

최종 UI 자산은 `index-DEI0pIX7.js` / `index-CqCuaHxa.css`다. Bqc → oZ에는 오류 표시·참조 clipping 수정, oZ → DEI에는 모델 칩 폭 수정만 포함된다. 후속 재검사는 변경의 영향을 받는 경로에 한정했다.

테스트 모델 응답은 localhost provider가 공급했다. 실제 UI, 서버, adapter, Coordinator, 저장 경로를 실행했지만 외부 모델의 판단 품질·유료 호출·외부 서비스 성공을 증명하지 않는다. 실패 주입은 오류 복구 검증에만 사용했으며 정상 완료는 실제 서버 응답과 저장 상태로 확인했다.

## 직접 사용한 인앱 브라우저

최종 자산에서 `대화 시작`을 눌러 `session_c5c7e8be`를 만들었다. Corral·폴더·별도 제목 없이 일반 한국어 요청을 작성하고 보내기 버튼을 눌렀다. `run_7ccb3f97cbd14032b114e867acf6a26c`의 성공과 `artv_a6db79d5b3884963a7210df30eeab42c` 결과를 확인한 뒤 새로고침으로 같은 요청·결과가 다시 표시되는 것을 확인했다. 요청 옵션에서 `기본 대화`와 선택적 Corral 안내를 읽고 Escape로 닫아 초점이 트리거로 돌아오는 것도 직접 확인했다.

읽기 전용 저장 상태 검증 (로컬 검증 자료: `test-results/ux-simplification/iab-readback.json`)에서 `corralId: null`, 사용자 Corral 0개, 요청 1개·실행 1개, `succeeded`, 결과 본문·hash 일치를 확인했다. 제공 중인 최종 JS/CSS도 HTTP 200과 SHA-256으로 확인했다. 인증값·개인 경로·사용자 요청 본문은 증거 JSON에서 제외했다.

같은 1765×1244 viewport의 변경 전 (로컬 검증 자료: `test-results/ux-simplification/before-new-session.png`), 새 대화 (로컬 검증 자료: `test-results/ux-simplification/after-new-session.png`), 결과 재로드 (로컬 검증 자료: `test-results/ux-simplification/after-request-reload.png`), 요청 옵션 (로컬 검증 자료: `test-results/ux-simplification/after-request-options.png`)을 저장했다. 생성한 이미지나 참고 앱 화면으로 대체하지 않았다.

사용한 `qa-ui-model`은 모든 일반 입력에 명시적인 로컬 검증 응답을 돌려주는 통제 모델이다. 세션·Corral·결과를 주입하지 않았으며 실제 Pi SDK의 `write_artifact` → `submit_result`, Coordinator, 저장을 통과했다. 이는 사용자 인터페이스와 실행 연결 검증이며 AI 판단 능력의 검증이 아니다.

기존 검증 서버의 종료·재시작 명령이 자동 승인 검토에서 `blocked by policy`로 거부됐다. 상세 이유는 제공되지 않았다. 해당 동작을 재시도하지 않고 기존 서버·작업 공간·기록을 보존했으며, 별도의 임시 작업 공간과 서버로 최종 검증을 진행했다.

## Windows 앱 확인

최종 UI를 포함한 `win-unpacked/corral.exe`에서도 사용자 Corral 0개·`corralId: null` → 기본 요청 → Coordinator 성공 → 공개 저장 상태 → reload → 전체 앱 재시작 후 같은 대화·Run·초안 복원을 확인했다. 두 번의 정상 Quit과 listener 종료도 확인했다. 첫 진단 스크립트는 Quit 이후 이미 종료된 automation 객체를 조회하면서 실패했으며, 제품 종료 실패로 분류하지 않았다. 종료 전에 프로세스 핸들을 보존하도록 진단만 수정한 뒤 전체 흐름을 다시 통과했다.

네이티브 검증은 제품의 명시적 모의 모델 모드다. 위 인앱 브라우저의 로컬 HTTP provider·실제 Pi SDK 검증과 구분하며, 두 경로 모두 외부 모델 호출을 주장하지 않는다.

Studio 외 런타임 26,212개와 app.asar는 이전 독립 실행 검증본과 동일하고, 새 Studio 406개는 최종 dist와 파일별로 일치한다. 링크 0개를 확인했다. 최종 앱 트리의 패키징·추출 대조 결과와 새 EXE 해시는 배포 증거에 별도 기록한다. 설치 프로그램 실행이나 새 Portable 자체의 부팅을 수행하지 않은 부분은 native unpacked 실행·압축 내부 동일성과 구분한다.

Portable·NSIS의 내부 payload는 같고 추출본은 최종 unpacked의 26,691개 파일과 일치한다. 네이티브에서 실행한 26,690개 파일은 그대로이며, 최종 패키징이 더한 파일은 설치 도구 원본과 hash를 대조한 `resources/elevate.exe` 하나다. 이 차이와 설치 미검증을 배포 manifest에 명시했다.

## 변경 범위의 디자인 검증

| 항목 | 판단 |
|---|---|
| 삭제·통합 | 상시 고급 행을 제거한 뒤 기본 요청 및 선택 설정·템플릿·Corral 경로를 다시 실행했다. 기능 삭제 없음 |
| 의미·접근 경로 | 입력·모델·권한·전송의 이름, 옵션 dialog/fieldset, 상태·오류, 복구 버튼 유지. 옵션의 Escape·초점 복귀 확인 |
| 첫 화면의 우선순위 | 빈 상태 안내와 입력창을 함께 배치. Corral 제작·적용은 옵션으로 표시 |
| 상태 증가·긴 콘텐츠 | 긴 모델명·추론, 비기본 옵션·Corral 요약, 실행 후 대화/큐/참조 검증. 매우 많은 프로젝트와 대화의 성능은 이번 범위 밖 |
| reflow | 390×844 및 데스크톱 viewport에서 입력·전송·선택·복구 접근과 가로 넘침 검사 |
| 동작 줄이기 | 브라우저 reduced-motion 설정과 readback을 확인하고 옵션 표시·닫기·초점·전송을 재실행. 새로운 장식 애니메이션 없음 |
| 구성요소 | 기존 Button·Select·Popover와 spacing/width 토큰 사용. 입력창·popup 경계 clipping은 실제 실패 후 수정 |
| 권한·실행 의미 | 기본 권한 확대 없음. 삭제된 명시 Corral은 자동 대체하지 않고 사용자가 복구. 초안·큐·revision·command 경로 보존 |
| 근거·한계 | 참고 소스와 UI 캡처/실행/저장을 구분. 전체 screen reader, 확대 배율별 접근성, 다른 OS·외부 모델 품질은 검증하지 않음 |

검증 범위는 새 대화와 요청 옵션 및 영향을 받는 기존 경로다. 다른 설정 페이지 전체 개편, 새로운 실행 아키텍처, 전체 제품 접근성 인증은 범위 밖이다. 롤백 시 이번 CR-043의 UI·메시지·관련 테스트 변경만 되돌리며 앞선 ABS 기능과 사용자 workspace는 보존한다.

배포 파일의 최신 identity와 네이티브 검증은 [Windows 배포 증거](Desktop-Delivery-Verification.md)를 따른다. 이전 UI의 EXE 검증을 새 UI 검증으로 표시하지 않는다.
