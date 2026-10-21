# 개발 Workbench P05–06: 공유 문서 편집과 복구 검증

- 기준: `413f6bf` 이후 이 기록을 포함한 변경. CR-046 / CRL-WBD-003 / C-145·146 / TC-WBD-003-H,N,F.
- 환경: Linux, Node 24.19.0, pnpm 10.30.3, Monaco 0.57.0, 실제 인앱 Chromium 브라우저. 임시 Git/SQLite/서버와 시뮬레이션 adapter만 사용했다. 사용자 작업 폴더·기존 서버는 변경하지 않았다.
- 이 기록은 P05–06의 구현과 아래 환경 검증이다. 전체 개발 Workbench, 모든 OS/설치판, release gate 통과가 아니다.

## 적용

Studio client별 root store가 전체 host/project/binding/session/generation/path identity의 단일 Monaco 모델과 undo를 소유한다. 화면은 selection/scroll만 소유하며 설정·route 왕복으로 초안을 버리지 않는다. 저장은 제출한 내용만 baseline으로 인정하고 더 새 입력을 dirty로 유지한다. 불확실 응답은 원래 receipt를 조회하며, 404를 확인한 명시 재시도도 같은 operation ID를 쓴다.

표준 IndexedDB에 renderer별 초안을 저장하고 transaction 완료로 acknowledgement를 구분한다. 다른 renderer의 후보는 자동 적용하지 않는다. quota 실패는 메모리 초안을 보존한다. 현재 dirty 초안을 저장/버리기 전에는 다른 후보로 덮지 않는다. 사본 삭제·재생성 후 과거 후보도 같은 host/project/session에서 읽고 명시 폐기할 수 있으며 새 사본에 자동 저장하지 않는다. 마지막 view 닫기는 저장/버리기/취소다.

FilePanel은 관리 사본 text만 편집하고 원본·binary·큰 파일은 기존 읽기 경로를 유지한다. LF/CRLF·BOM은 보존하고 mixed/CR은 명시 변환 후 편집한다. 저장되지 않은 줄 참조는 비활성화한다. 저장 성공은 기존 workspace change event를 보내 Diff·파일 목록을 갱신한다. 사용자 변경의 기존 `external_observed` 분류는 유지하며 문구는 “사용자 또는 외부 변경”으로 고쳤다.

Monaco는 공개 API로 지연 로딩하며 syntax 정의와 self-hosted editor worker만 번들한다. TS/LSP language-service worker나 React wrapper는 추가하지 않았다. 기존 CSP를 바꾸지 않았다. [의존성 고지](../../THIRD-PARTY-NOTICES/monaco-editor.md)에 버전·라이선스·vendored DOMPurify low advisory 2건의 제한된 도달성 검토를 기록했다.

## 실패 확인과 수정

- 최초 공유 모델/저장/복구 capability 검사 6개가 미구현 상태에서 실패한 뒤 통과했다.
- 재열기/파일 목록 새로고침이 최신 disk를 적용하지 않는 실패를 공용 applyFile 경로로 수정했다. dirty 내용은 conflict로 남긴다.
- 과거 generation 복구 후보에 접근할 수 없는 실패를 session index 및 문서가 없는 상태의 조회로 수정했다.
- 실제 인앱 저장 후 Diff가 “변경 없음”으로 남는 것을 관찰했다. 성공 acknowledgement의 이벤트 누락 회귀를 red→green으로 수정하고 실제 Diff의 추가 줄을 재확인했다.
- 목록/문서 조회 실패로 본문 접근이 사라지는 경로를 보존된 초안 목록으로 수정했다. 실제 서버를 종료하고 파일 새로고침한 뒤에도 입력한 초안을 읽을 수 있었다.
- GET404 이후 disk conflict가 원래 저장 요청의 명시 재시도까지 막는 실패를 수정했다. 자동 새 요청은 만들지 않는다.

## 실행한 검사

| 검사 | 결과와 범위 |
|---|---|
| 관련 단위·통합 | 8파일 37개 통과: store/Monaco import/FilePanel tab cap, 기존 graph/composer draft·navigation, 실제 파일 및 HTTP document API |
| locale | 기존 1파일 3개 통과; 총 9파일 40개 고유 사례 |
| TypeScript | 전체 `pnpm typecheck` 통과. Studio 마지막 변경 별도 재확인도 통과 |
| Build | Studio production build 통과. 기존 큰 chunk 경고는 남음 |
| 계약·의존성 | `pnpm contracts:check`, `pnpm deps:check` 통과 |
| 추적 문서 | `pnpm spec:check` 2393 checks, 310/310 scenario tags 통과 |

시간 상한의 성공을 성능 기준으로 사용하지 않았다. 저장/영속화 경합은 Gate로 제어하고 새 E2E는 추가하지 않았다. 실제 브라우저 관찰에서 발견한 문제를 필요한 단위 회귀로 고쳤다.

## 실제 화면과 디스크 증거

- production CodeEditorView 두 개와 동일 공개 모델의 임시 fixture: 실제 한/일 문자 입력이 두 view에 반영됨, 다른 copy URI 모델은 불변, undo/redo와 두 번째 view 닫기/재생성 유지. 기본 Ctrl+M으로 Tab 모드를 전환한 뒤 모든 editor를 빠져나와 외부 입력에 도달했다. root store의 identity/수명은 별도 단위 검사로 확인했다.
- 실제 서버 앱: 편집→Ctrl+S→관리 사본 bytes 확인, 원본 불변, 기존 Diff에서 추가 줄 확인. `BOM + CRLF`를 exact bytes로 보존했고 mixed 파일은 LF 명시 선택 후에만 변환되어 저장됐다.
- 설정 overlay 왕복 후 dirty 본문 유지. 새 renderer는 IndexedDB 후보를 자동 채택하지 않고 명시 복원 후 dirty로 표시. 닫기 취소와 명시 버리기를 확인했다.
- 외부 disk 변경과 dirty 초안의 base/ours/theirs를 확인하고 명시 “초안 유지” 후 저장했다. clean 상태의 기존 파일 새로고침은 최신 disk 본문을 표시했다.
- 작업 사본 삭제 후 memory 초안 목록을 확인했다. 새 renderer를 열고 이전 renderer를 종료한 뒤에도 IndexedDB의 과거 사본 본문을 읽을 수 있었다. 새 사본으로 자동 적용되지 않았다.
- 390×844에서 복구 본문·폐기 버튼과 코드 편집 컨트롤에 접근했다. body scrollWidth와 viewport 모두 390px였다. binary·1MiB 초과 파일 안내, 원본 폴더의 기존 읽기 화면을 확인했다.
- 최종 정상 편집기에서 browser error/warn 로그가 없었다. 서버 종료 후 파일 새로고침에서는 실패 안내와 보존된 초안 읽기를 확인했다.

임시 화면 증거: `/tmp/corral-p05-shared-editor.png`, `/tmp/corral-p05-recovery-390.png`, `/tmp/corral-p05-editor-390.png`, `/tmp/corral-p05-offline-draft.png`. 임시 fixture 서버와 탭은 정리했고 viewport override도 해제했다.

## 남은 환경 검증과 한계

물리 한국어/일본어 OS IME·스크린리더·Windows/macOS·패키지 앱은 실행하지 않았다. 실제 화면은 다크 테마였으며 라이트 전환·reduced-motion의 별도 실증은 수행하지 않았다. 한/일 문자열 자동 입력은 실제 OS 조합 입력 검증이 아니다. 모델 로딩 실패의 원문 보존은 주입 단위 검사로 확인했으며 실제 worker fault 주입은 이번 화면 검증에서 수행하지 않았다. crash 직전 IndexedDB ack되지 않은 입력의 영속화, 독립 창 live sync, 전체 language service 지원을 주장하지 않는다.

Production build의 editor worker는 약304kB이며 features 등록 chunk는 약1.18MB다. 초기 main chunk 약1.89MB 및 기존 format chunk 약2.36MB 경고가 남아 있다. 지연 로딩 성공을 전체 성능/접근성 qualification으로 간주하지 않는다. 설치판·지원 환경 qualification은 활성 계획의 후속 작업에서 이어간다.

되돌림은 이 기능 커밋을 revert하면 된다. P04 서버 API/DB migration을 되돌릴 필요는 없으며 IndexedDB 초안은 명시 폐기하기 전 남겨 둔다. P07 PTY와 이후 도킹/Git/개발 여정은 아직 남아 있다.
