# P27 배포 task와 결과 확인 — 구현·핵심 검증

- 기준: `83c7897` 위 이 문서를 포함한 P26·P27 구현 묶음. CR-046 P27, CRL-WBD-024/C-168/TC-WBD-024-H,N,F.
- Linux x64, Node 24.19.0, 격리된 실제 Git/SQLite/작업 사본과 production Studio. 외부 계정·provider·유료 호출을 사용하지 않은 로컬 통합이다.
- 기존 사람 operation·task runtime·공통 writer·프로젝트 도구 설정을 확장했다. 별도 배포 서비스나 credential 저장소를 만들지 않았다.

## 핵심 회귀

| 범위 | 결과 | 로그 |
|---|---|---|
| 고정된 source/config·명시 readback·중복/응답 유실·정리·불확실 결과 | 4 PASS | `/tmp/corral-p27-backend-final.log` |
| 기존 task와 process runtime 포함 | 15 PASS, 기존 플랫폼 조건 2 SKIP | `/tmp/corral-p27-core.log` |
| UI 검토·dirty 재검토·응답 유실·접수 전 거절·설정 | 3파일 8 PASS | `/tmp/corral-p27-ui-green.log` |
| HTTP 인증·다른 target·필수 fingerprint 경계 | 1 PASS (P26 공통 시험) | `/tmp/corral-p26-p27-http-green.log` |

최초 HTTP 404(`/tmp/corral-p26-p27-http-red.log`), 여러 줄 환경 비밀값의 출력 유출(`/tmp/corral-p27-redaction-red.log`), malformed 결과 후 기존 deployment ID 유실(`/tmp/corral-p27-identity-red.log`), dirty 검토 경쟁과 접수 전 거절의 잘못된 결과 미확인 표시(`/tmp/corral-p27-ui-dirty-red.log`, `/tmp/corral-p27-ui-refusal-red.log`)를 실제 실패로 확인하고 수정했다. 겹치는 시험 수를 합산하지 않는다.

## 실제 화면과 파일 결과

인앱 브라우저 1280×720에서 등록된 로컬 배포 구성을 선택하고 source commit·clean 상태·환경 변수 참조를 검토했다. 명시 시작 후 동일 operation 상태를 조회하면 종료 코드 0이어도 **결과 확인 필요**로 표시됐다. **배포 결과 확인**을 눌러 저장된 결과를 읽은 뒤에만 **배포 성공 확인**과 안전한 결과 URL이 나타났다.

로컬 fixture는 배포 결과 JSON을 쓰고 확인 명령은 그 파일만 읽었다. 배포 호출 표식은 정확히 한 번이었고 관리 사본과 원본 Git 상태는 모두 clean이었다. 결과 링크는 표시만 확인했으며 외부 페이지를 방문하지 않았다. 화면 증거는 `/tmp/corral-p27-deployment-confirmed.png`다.

## 보존 경계와 미검증 범위

명령·환경·commit/tree·dirty·credential 참조를 검토 지문에 고정한다. 실행과 결과 확인은 원래 target/operation에 귀속하며 deployment ID·환경·source가 다른 결과는 수용하지 않는다. 비밀값은 broker에서만 해석하며 공통 출력 필터로 제거한다. 공유 개발 중 배포는 허용하지 않고 strict writer 경계를 유지한다.

프로세스 종료와 원격 배포 성공을 구분한다. 취소·timeout·응답 유실 뒤 자동 재배포하지 않는다. 명시 중지는 로컬 정리와 예약 해제를 끝내지만 원격 결과는 미확인이다. 중지 뒤 앱에서 확인 작업을 다시 실행하지 않으며 대상 서비스에서 수동 확인하도록 안내한다.

실제 외부 provider 배포·credential·원격 host·다른 OS·설치판·전체 release gate는 확인하지 않았다. 로컬 결과 파일과 URL 표시를 실제 외부 배포 성공으로 확대하지 않는다. 공통 타입·build·계약/문서 검사 결과는 [P26 통합 기록](Development-Workbench-Debugging-2026-10-23.md)을 따른다.
