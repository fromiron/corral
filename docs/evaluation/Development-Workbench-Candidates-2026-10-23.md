# P19 Ultra 후보 비교 — 구현·핵심 검증

- 기준: `f16bf03` 위 이 문서를 포함한 P19 구현 묶음. CR-031, C-114, CRL-ULTRA-002, TC-ULTRA-002-H/N/F. 알림 대상 이동은 [별도 기록](Desktop-Notification-Targets-2026-10-23.md)과 커밋으로 분리했다.
- Linux x64, Node 24.19.0, pnpm 10.30.3. 실제 Git·SQLite·관리 사본·Linux 격리 검사와 production Studio를 사용했다. 모델 응답은 결정적 fixture이며 외부 호출·과금은 없다.
- 현재 계약은 [모델 안내](../Models.md#선택적-후보-비교)와 [CR-031](../change-requests/CR-031-ultra-quality.md)이다. 별도 Run/실행 원장·새 의존성·독립 대시보드를 추가하지 않았다.

## 구현

Ultra의 명시 선택으로 2–5개 후보 모델을 고정하고 같은 Run에서 최대 3개를 동시에 실행한다. 기존 compiled recipe·execution·permit·budget·검사·review 경로와 공통 writer를 재사용한다. 후보별 Git 사본과 execution 매핑을 저장하고 기본 사본 fallback을 막는다. 일반 Ultra와 일반 Corral의 20개 노드·1개 loop 제한을 보존한다.

80% admission과 마무리 호출/출력 예약은 spent·reserved·unknown을 포함한다. 검증된 Linux 격리와 등록 검사가 없으면 시작하지 않는다. native 확장·MCP·시작 명령·LSP·임의 host command를 후보에 열지 않는다. 등록 검사는 기존 승인·host broker로만 수행한다.

후보별 상태·검사·파일 diff·보고 usage·미확정 출력량을 기존 검토 화면에서 읽는다. 실패 후보의 확보된 근거도 보존한다. 선택은 정확한 tree의 하나만 가능하며 종료/정산·사본 generation·출처/대상 tree·실제 검사 기록·현재 설정/fingerprint를 재검사하고 반영 전 체크포인트를 남긴다. 반영 중 취소/정지는 거절하고 실패 종료도 반영 promise를 기다려 writer를 조기 해제하지 않는다. 부분 실패·재시작·응답 유실은 자동 반영/재실행하지 않는다.

## 핵심 회귀

| 범위 | 결과 | 로그 |
|---|---|---|
| 후보 5개/동시 3개·기존 Ultra 예산/recipe·후보/Run 취소·전원 실패·단일 선택 | 5파일 23 PASS | `/tmp/corral-p19-core-final.log` |
| 실패 후보 검사 근거 보존 + 기존 Ultra 검사 | 2파일 15 PASS | `/tmp/corral-p19-failed-evidence-green.log` |
| 후보 recipe·일반 노드/loop 경계 | 2파일 12 PASS | `/tmp/corral-p19-recipe-nodecap-green.log` |
| 실제 Git 후보 사본·Linux 검사·단일 반영·기존 file/check | 11 PASS, 선택 필터 밖 43개 제외 | `/tmp/corral-p19-workspace-regression.log` |
| 현재 설정 변경·취소 후 반영 거절 포함 host 핵심 | 3 PASS | `/tmp/corral-p19-workspace-final.log` |
| adapter 후보 검사 broker + 기존 SDK | 53 PASS | `/tmp/corral-p19-adapter-green.log` |
| 실제 Linux SDK/non-SDK 격리 worker | 2 PASS | `/tmp/corral-p19-adapter-sandbox.log` |
| 후보 선택/명령 유실·기존 검토/초안 | 5파일 13 PASS | `/tmp/corral-p19-ui-regression.log` |
| HTTP 인증·일반 Run null·정확한 tree/path 경계 | 1 PASS | `/tmp/corral-p19-routes-green.log` |
| 생성 schema·기존 정의·HTTP 연결 | 3파일 19 PASS | `/tmp/corral-p19-wire-final.log` |
| 선택되지 않은 후보의 쓰기 출처 제외·기존 혼합/외부 출처 | 신규 1 PASS, 기존 1 PASS | `/tmp/corral-p19-provenance-green.log`, `/tmp/corral-p19-provenance-existing.log` |

같은 시험의 중복 실행 수를 합산하지 않는다. 최초 구현 부재, 승격 중 취소, 실패 검사 근거 누락, 일반 노드 한도, 검사 오류를 성공으로 보이는 UI를 실제 red로 확인했다. 관련 로그는 `/tmp/corral-p19-{core,promotion-cancel,failed-evidence,recipe-nodecap}-red.log`와 UI/host red 로그다. 전체 제품·OS matrix를 반복하지 않았다.

실제 화면에서 선택한 파일을 다른 후보의 마지막 쓰기 hash와 비교해 외부 변경으로 오인하는 문제가 나왔다. `/tmp/corral-p19-provenance-red.log`로 재현하고 후보 execution 기록은 기본 사본 출처에서 제외했다. Coordinator의 선택 결과와 실제 적용 완료 원장이 일치하는 후보만 기존 출처 계산에 포함하며 일반 Corral/외부/혼합 변경 구분을 보존했다.

수정된 서버의 실제 화면에서 후보 2를 다시 반영하고 `index.html`과 `notes/write_2.md`의 출처가 모두 **Corral**로 표시되는 것을 확인했다. 선택 결과와 원본 보존을 다시 읽었으며 고립 서버·앱 데이터·인증 메타는 정리했다.

## 실제 화면·파일 결과

인앱 브라우저 1280×720에서 같은 Run의 후보 3개와 각 등록 검사 성공을 확인했다. 후보 2의 `index.html` diff를 읽고 **이 후보만 세션에 반영**을 눌렀다. 반영 중에는 추가 반영이 비활성화됐고, 완료 후 **후보 하나를 반영했습니다**·**선택됨**이 표시됐다. 서버 readback은 Run `succeeded`, 비교 `selected`, `selectedCandidateId: candidate_2`였다.

실제 세션 사본은 후보 2의 HTML과 `notes/write_2.md`만 포함하고 후보 1/3의 파일을 합치지 않았다. 연결한 원본의 HTML은 baseline 그대로였다. 화면 증거는 `/tmp/corral-p19-selected.png`, 비밀값/로컬 경로를 제외한 readback은 `/tmp/corral-p19-ui-readback.json`이다. 검사 실행은 실제 Linux 격리였으며, 모델은 유료 모델/OS worker를 대신한 결정적 adapter였다. 모델 worker의 실제 OS 경계 증거는 위 별도 adapter 시험과 구분한다.

## 범위와 한계

타입은 contracts/core/storage/client/server/Studio 6개 패키지에서 통과했고(`/tmp/corral-p19-integrated-types.log`), 최종 production build는 `/tmp/corral-p19-studio-build-final.log`다. `spec:check`(2858 checks)와 `contracts:check`도 통과했다(`/tmp/corral-p19-spec-final.log`, `/tmp/corral-p19-contracts-final.log`). 변경된 소스 33개 정적 검사 오류 0·기존 형식의 경고 102개와 diff 검사를 확인했다. 문서 검사는 제품/출시 검증을 대신하지 않는다.

외부 모델의 실제 후보 품질·금액·전체 공급자 조합, Windows/macOS, 설치판 전체 여정, 전체 release gate는 이번 검증에 포함하지 않는다. 후보 사본은 세션 사본의 명시 삭제에 연결해 정리하며 사용자가 고르지 않은 후보를 자동 병합하지 않는다. 비용 미확정은 0원이나 예산 준수 증거로 표시하지 않는다.
