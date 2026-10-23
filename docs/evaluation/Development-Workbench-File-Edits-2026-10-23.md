# P24-B 파일 변경 제안 — 구현·핵심 검증

- 기준: `8f44489` 위 이 문서를 포함한 구현 묶음. CR-046 P24-B, CRL-WBD-021/C-165/TC-WBD-021-H,N,F.
- Linux x64, Node 24.19.0, production Studio, 격리 Git 사본. 실제 언어 서버는 임시 설치한 typescript-language-server 6.0.2와 TypeScript 6.0.3이다. 새 제품 의존성·유료 호출·개인 저장소 쓰기는 없다.
- 기존 검색·지속 언어 세션·파일 CAS·공통 writer·FileDiff·DocumentStore를 재사용했다. 사람의 변경안을 별도 불변 제안으로 저장하며 가짜 Run을 만들지 않는다.

## 필요한 회귀

| 범위 | 결과 | 로그 |
|---|---|---|
| batch 적용·부분 실패·불확실 receipt·기존 P04 저장/P22 소유권 | 16 PASS (3파일) | `/tmp/corral-p24b-core-regression.log` |
| 저장소·migration·제안 계약 | 5 PASS (3파일) | `/tmp/corral-p24b-proposal-green.log` |
| 본문 없는 제안 목록·저장소 | 3 PASS | `/tmp/corral-p24b-proposal-list-green.log` |
| 언어 세션 UI | 5 PASS (아래 UI 묶음과 중복) | `/tmp/corral-p24b-language-green.log` |
| 현재 파일의 진단 힌트와 버전 제외 | 선택한 2 PASS | `/tmp/corral-p24b-hints-green.log` |
| HTTP preview/apply/중복/receipt·session 검증 | 1 PASS | `/tmp/corral-p24b-http-green.log` |
| 교체·이름 변경·검토/복구·초안·기존 편집기 UI | 20 PASS (7파일) | `/tmp/corral-p24b-ui-regression.log` |

중복 실행 수는 합산하지 않는다. 언어 backend의 25 PASS 보고는 원본 로그가 UI 실행으로 덮였으므로 보존된 수치에 포함하지 않는다. 구현 전 batch·proposal·언어/UI·HTTP 실패를 확인했다. 추가로 동시 같은 요청의 proposal 중복, 최종 receipt 저장 실패, 진단 힌트 누락을 각각 실패로 재현하고 수정했다. 관련 red 로그는 `/tmp/corral-p24b-{batch,proposal,language,replace,review,refactor-ui,http,duplicate,receipt,hints}-red.log`다. 초기 모듈 부재 실패와 본문 assertion 실패는 구분한다.

contracts/client/storage/server/Studio 타입 검사(`/tmp/corral-p24b-types-final.log`)와 최종 production build(`/tmp/corral-p24b-build-final.log`)가 통과했다. 기존 chunk 크기 및 이미 정적으로 가져온 FileDiff의 동적 import 경고는 남는다.

## 실제 화면과 디스크

인앱 브라우저 1280×720에서 실제 언어 서버를 시작하고 `greet`를 `welcome`으로 바꾸는 제안을 생성했다. `main.ts`, `math.ts`, `usage.ts` 세 파일의 diff를 선택해 검토한 뒤 명시 적용했다. 세 파일 모두 적용 완료 표시와 디스크의 변경을 확인했고 원본 세 파일은 `greet`를 유지했다.

이후 내용 검색의 5개 일치를 `salute`로 교체하는 제안을 검토·적용했다. 세 파일의 실제 저장을 읽어 확인했다. 별도 복구 제안을 다시 검토·적용해 세 파일이 `welcome`으로 돌아왔고 `salute`는 남지 않았다. 언어 서버 중지와 검증용 앱·사본·cookie를 정리했다.

실제 검토 창에서 diff에 눌려 파일 목록 높이가 0이던 문제를 발견했다. 목록에만 `shrink-0`를 추가했고 최신 실행물에서 88px 높이와 다른 파일 선택을 확인했다. 미지원 action 목록도 접힌 상세로 바꿔 편집기를 밀어내지 않는다. 정적 서버가 시작 시 index를 보관하므로 빌드 교체 뒤 검증 서버를 재시작해 최종 자산으로 확인했다.

임시 화면 증거: `/tmp/corral-p24b-rename-review.png`, `/tmp/corral-p24b-rename-applied.png`, `/tmp/corral-p24b-inverse-applied.png`.

## 보존 경계와 한계

저장된 파일만 대상으로 하며 dirty/pending/conflict 문서는 자동 저장하지 않는다. 제안은 최대 32파일·전체 before/after 8MiB·파일당 1MiB다. 적용 전 대상·언어 세대·버전·각 hash를 확인하고 한 batch writer로 처리한다. 일부 적용 후 실패는 파일별 결과를 남기며 자동 rollback으로 외부 변경을 덮지 않는다. 불확실 효과는 writer를 유지하고 명시 readback으로 판별한다. 복구 역시 현재 after hash가 모두 맞아야 생성되는 새 제안이다.

실제 TypeScript 서버의 import 추가 등 code action은 서버 명령 실행이 필요해 미지원으로 표시됐다. 명령을 허용해 성공으로 만들지 않았다. edit-only code action은 프로토콜 fixture로 검증했으며 이 서버의 실제 성공 사례로 보고하지 않는다. 버전 없는 진단은 후보 탐색 힌트로만 쓰고 계속 버전 미확인으로 표시한다. 파일 생성·이동·삭제 WorkspaceEdit는 지원하지 않는다.

전체 플랫폼·원격 host·대용량/부하·전체 release gate는 반복하지 않았다. 이번 결과는 Linux의 핵심 회귀와 위 실제 화면 흐름에 한정된다.
