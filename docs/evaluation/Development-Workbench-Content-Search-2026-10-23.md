# P24-A 파일 내용 검색 — 구현·핵심 검증

- 기준: `c02663e` 위 이 문서를 포함한 구현 묶음. CR-046 P24-A, CRL-WBD-019/C-163/TC-WBD-019-H,N,F.
- Linux, Node 24.19.0, pnpm 10.30.3, 실제 Git/SQLite와 production Studio/Chromium 인앱. 격리 fixture만 사용했고 모델 호출·외부 계정·배포는 사용하지 않았다.
- 기존 파일 패널의 이름 검색·가상 목록·문서 store·dock 줄 이동을 재사용했다. 내용 검색은 관리 사본의 저장된 파일에 한정하며 초안을 섞지 않는다. 기존 읽기 정책과 ignore·보호 경로·symlink 경계를 유지한다. 새 의존성·검색 index·별도 문서 원장은 없다.

## 필요한 회귀

| 범위 | 결과 | 로그 |
|---|---|---|
| 서버의 literal/UTF-16·ignore/binary·한도·취소/대상 검사, 기존 문서 읽기/저장·경로 보호 | 선택한 8 PASS (3파일) | `/tmp/corral-p24-search-red.log`, `/tmp/corral-p24-search-regression.log` |
| 기존 HTTP fixture의 검색 endpoint·대상·인증·schema 연결 | 1 PASS | `/tmp/corral-p24-http-red.log`, `/tmp/corral-p24-http-green.log` |
| 검색/취소·늦은 응답·결과 이동·dirty/stale 보존과 기존 문서 연결 | 6 PASS (2파일) | `/tmp/corral-p24-ui-red.log`, `/tmp/corral-p24-ui-green.log` |
| 열린 clean 문서의 오래된 캐시 갱신 | 위 UI 묶음에 포함, red→green | `/tmp/corral-p24-cached-open-red.log` |

서버 묶음의 56 skipped는 이름 필터로 제외한 기존 시험이며 실패나 새 제품 미지원이 아니다. 새 core 시험이 실제 실패하는 것을 확인한 뒤 구현했다. 새 검색 결과와 디스크 hash가 같더라도 열린 clean 문서의 캐시가 이전 hash일 수 있어, 기존 refresh를 거친 뒤 대상·hash·dirty 상태를 다시 확인하도록 고쳤다. 미저장/pending 문서는 refresh하지 않는다. 독립 읽기 검토에서 추가 data-loss/path/scope 결함은 발견하지 못했다.

최종 contracts/client/server/Studio 타입 검사와 production Studio build가 통과했다(`/tmp/corral-p24-types-final.log`, `/tmp/corral-p24-build-final.log`). 기존 큰 chunk 경고는 유지된다. 문서 검사 2685 checks·시나리오 태그 358/358, generated 계약, 의존성 경계 검사가 통과했다(`/tmp/corral-p24-spec-final.log`, `/tmp/corral-p24-contracts-final.log`, `/tmp/corral-p24-deps-final.log`). 변경 코드의 Biome 검사는 오류 없이 통과했고 기존 파일과 테스트의 경고는 남았다. 공백 검사도 통과했다.

## 실제 화면

1. 기본 파일 이름 목록이 유지되고 같은 파일 패널에서 내용 모드로 바뀌었다. `greet` 검색은 7개 파일 중 main.ts 두 곳과 math.ts 한 곳, 총 3개 결과를 반환했다. 디스크 기준·초안 제외 안내가 보였다.
2. math.ts 결과를 누르자 기존 문서 탭의 2행과 해당 단어로 이동했다.
3. math.ts에 미저장 표시를 만든 뒤 같은 결과를 눌렀다. 저장/버리기 안내와 함께 이동을 거절했고 초안·dirty 탭을 유지했다. 사본 디스크와 원본 파일에 초안 내용이 없음을 별도로 확인했다.
4. main.ts를 연 뒤 fixture 디스크에 한 줄을 추가했다. 이전 검색 결과를 누르면 새 검색이 필요하다는 안내가 나오고 오래된 줄로 이동하지 않았다.
5. 다시 검색한 결과는 3행을 가리켰다. 이를 누르자 이미 열린 clean 문서가 갱신되고 정확한 3행으로 이동했다. 다른 math.ts의 미저장 초안은 그대로 남았다.

임시 화면 증거: `/tmp/corral-p24-search-navigation.png`, `/tmp/corral-p24-search-draft.png`, `/tmp/corral-p24-search-refreshed.png`. fixture 서버·사본·탭은 확인 뒤 정리했다.

## 범위와 남은 경계

500개 후보 파일, 파일당 1 MiB, 총 8 MiB, 200개 결과의 한도를 표시하며 일부 제외/잘림을 전체 검색 완료로 표현하지 않는다. 정규식·교체/refactor·원본 폴더 내용 검색·전체 저장소 index는 범위 밖이다. 검색 취소·늦은 응답은 회귀로 확인했고 실제 화면에서는 정상 이동과 데이터 보존에 집중했다. 전체 OS·부하·설치판/원격·스크린리더 인수는 반복하지 않았다. P24-B 이후 변경에 맞춰 해당 core만 재검증한다.
