# P25 고급 Git와 충돌 해결 — 구현·핵심 검증

- 기준: `1b84186` 위 이 문서를 포함한 구현 묶음. CR-046 P25, CRL-WBD-022/C-166/TC-WBD-022-H,N,F.
- Linux x64, Node 24.19.0, 실제 Git·격리 SQLite/작업 사본·production Studio. 개인 저장소·원격 push·유료 모델을 쓰지 않는다. 새 제품 의존성은 없다.
- 기존 사용자 Git 패널·파일 diff·편집기·공통 operation/writer·hook/서명 정책을 확장했다. checkpoint hunk와 실제 index hunk를 구분한다.

## 필요한 회귀

| 범위 | 결과 | 로그 |
|---|---|---|
| 선택 hunk·실제 index 잠금/외부 변경·늦은 취소·기존 Git 읽기 | 10 PASS (2파일) | `/tmp/corral-p25-hunks-green.log`, `/tmp/corral-p25-hunks-late-red.log` |
| 실제 merge/rebase 계속·중단·서명 정책·ignored 파일/브랜치 보존 | 4 PASS | `/tmp/corral-p25-sequence-final-boundary.log` |
| 공통 writer·공유 개발·실제 충돌 저장/stage/continue·유실 receipt/불완전 abort | 3 PASS | `/tmp/corral-p25-workspace-final-core.log` |
| 기존 P13/P14/P22 Git·공유 개발 핵심 회귀 | 14 PASS (3파일) | `/tmp/corral-p25-existing-core-final.log` |
| HTTP의 실제 hunk 검토·선택 적용·동일 ID/receipt·타 세션/임의 patch 거절 | 1 PASS | `/tmp/corral-p25-http-red.log`, `/tmp/corral-p25-http-green.log` |
| 기존 Git 패널·새 hunk/sequence/conflict UI·초안·늦은 응답·동일 ID 복구 | 17 PASS (4파일) | `/tmp/corral-p25-ui-regression.log` |

중복 실행을 합산하지 않는다. HTTP의 구현 전 실패는 404였고 이후 실제 index의 첫 hunk만 바뀌며 다른 hunk·다른 사본·원본은 보존되는 것을 확인했다. 일부 새 모듈의 최초 red는 import 부재이며 실행된 assertion 실패와 구분한다.

검토 중 마지막 index 교체 직전의 취소/권한 재확인, 새 continue 요청이 이전 sequence owner를 가리는 문제, 실패한 continue 뒤 소유권 재발견, 불확실 abort의 실제 효과 판별을 별도 반례로 보완했다.

관련 실패 증거는 `/tmp/corral-p25-workspace-continue-red.log`, `/tmp/corral-p25-workspace-retry-red.log`, `/tmp/corral-p25-workspace-abort-red.log`, `/tmp/corral-p25-sequence-obstruction-red.log`다. 정리 확인 없이 owner를 해제하거나 HEAD/metadata 부재만으로 abort 성공을 확정하지 않는다. 무시된 파일 전체를 금지하지 않고 실제 덮어쓸 경로를 검사하므로 일반 `node_modules`는 유지한다.

contracts/client/Studio 타입(`/tmp/corral-p25-root-types.log`)·최종 server 타입(`/tmp/corral-p25-service-final-types.log`)·production Studio build(`/tmp/corral-p25-build-final.log`)가 통과했다. 기존 chunk 크기와 FileDiff의 중복 static/dynamic import 경고는 남는다.

문서·추적 검사 2742개와 367/367 시나리오 태그 연결(`/tmp/corral-p25-spec.log`), generated 계약 검사(`/tmp/corral-p25-contracts.log`), 변경 코드의 Biome 검사(`/tmp/corral-p25-root-biome.log`)가 통과했다. 태그 연결 수는 제품 시험 통과 수가 아니며 기존 스타일 경고는 남는다.

## 실제 화면과 Git 결과

인앱 브라우저 1280×720과 격리 실제 Git 저장소를 사용했다. 30줄 파일의 두 변경 중 첫 hunk만 선택해 stage했고 실제 index에는 첫 변경만, working 파일에는 둘 다 남았다. 선택 unstage 뒤 index는 원래 내용으로 돌아왔고 working 변경은 둘 다 보존됐다. 기존 파일 전체 stage와 commit도 정상 동작했다.

로컬 `feature`를 검토·병합해 실제 충돌을 만들었다. 공통 기준과 현재 쪽·가져올 쪽·작업 파일을 비교한 뒤 기존 편집기로 열고 해결 내용을 입력했다. 미저장 상태에서 중단 버튼이 비활성화되는 것을 확인했다. 명시 저장 → 저장한 파일 stage → 이어가기 검토/실행 후 실제 merge commit의 두 부모, 저장한 해결 내용, clean 사본, 설정된 Git 작성자를 확인했다. 원본 branch와 파일은 그대로였으며 원본도 clean이었다.

임시 화면 증거는 `/tmp/corral-p25-hunk-review.png`, `/tmp/corral-p25-merge-complete.png`다. 실제 화면에서 충돌 창의 내부 여백 누락을 발견해 해당 창의 공통 여백·간격만 추가했다. 기능 흐름은 반복하지 않고 최신 빌드의 충돌 창에서 20px 내부 여백·12px 간격과 하단 편집/스테이징 버튼 접근을 별도 확인했다(`/tmp/corral-p25-conflict-review.png`, `/tmp/corral-p25-conflict-actions.png`). 검증 fixture의 앱·사본·cookie를 정리했다.

## 보존 경계

선택 hunk는 현재 HEAD/index/working 파일과 서버가 생성한 patch identity에 고정한다. 개인 index를 준비한 뒤 Git의 실제 index lock 아래 다시 확인하고 교체하며 working 파일을 쓰지 않는다. ordinary text 수정만 지원하고 새 파일·삭제·rename/mode·binary·symlink/gitlink·filter/인코딩 변환·한도 초과는 이유와 기존 파일 전체 stage/unstage 경로를 유지한다.

충돌은 base/ours/theirs/current를 비교하고 기존 문서 편집기로 연다. 미저장 초안을 새 내용으로 덮지 않는다. 저장은 P04 CAS, 해결한 파일의 stage는 P13의 현재 디스크 내용 기록이라는 기존 의미다. 외부 프로그램의 파일 쓰기와 파일 전체 stage가 원자적이라고 주장하지 않는다.

merge/rebase는 확인한 local branch OID·HEAD/index·working tree hash·sequence identity에 고정한다. 지원하는 Corral 시작 sequence만 계속/중단하며 pick-only rebase 외의 exec/interactive/custom strategy/autostash/update-refs 상태는 거절한다. hook 선택·작성자·필수 서명 정책을 유지하고 명령 편집기를 자동 실행하지 않는다. abort는 영향과 손실을 확인하며 미저장/결과 미확인 초안이 있으면 화면에서 막는다.

Git 결과를 잃으면 같은 operation ID로 조회하며 자동 재실행하지 않는다. 불확실한 프로세스 정리·효과는 owner를 유지하고 명시 재확인으로 증명할 수 있을 때만 정리한다. 공유 개발에서는 선택 stage/unstage만 기존 stage/unstage와 같은 효과로 허용하고 merge/rebase/continue/abort는 제외한다.

## 검증 범위

전체 OS·원격 host·실제 외부 credential/서명 장치·전체 release gate·대규모 성능 검증은 반복하지 않았다. 리베이스·중단은 실제 Git 핵심 시험으로, UI의 대표 완료 흐름은 위 병합으로 확인했으며 모든 조합의 화면 인수로 확대 해석하지 않는다. 이미지 지원 실제 모델 등 P20/P24-B의 남은 qualification도 각각의 기록을 따른다.
