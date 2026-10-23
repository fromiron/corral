# CR-046 P11 — 캡처한 컨텍스트와 대화 표시 밀도

범위: CRL-WBD-007 / C-151 / TC-WBD-007-H,N,F. 기준은 `f3042c2`와 이 문서를 포함한 후속 P11 변경이다. 전체 Workbench 완료나 release gate 통과를 뜻하지 않는다. 현재 계약은 [Workbench](../current/workbench.md), 후속 범위는 [실행 계획](../plans/workbench-development-implementation-plan-2026-10-21.md)을 따른다.

## 구현

기존 TextAttachment에 optional provenance를 추가했다. 코드의 full target·UTF-16 범위·saved/draft·전체 버퍼 hash, 터미널의 generation·적용된 output sequence·buffer/geometry/cell 범위, hunk의 고정 tree/patch/IDs, 검사의 실제 verification/command/tree/report metadata를 보존한다. 메타데이터는 사용자 제공 출처이며 권한이나 최신 상태의 증명이 아니다. 첨부 text/bytes/hash 검증과 기존 64KiB/5개 상한을 재사용한다.

문서와 터미널의 실제 선택, Review의 선택 hunk, 완료된 검사 출력을 명시적으로 캡처한다. 미저장 코드는 확인 대화상자에서 고정 본문을 보여준다. 칩은 보존된 본문·원본 상태·원본 열기·교체 확인·삭제를 제공한다. 원본이 변경되거나 사라져도 본문을 자동 갱신하지 않는다. 터미널의 오래된 선택을 새 출력에 적용하지 않는다.

작성 중인 초안에는 대상이 고정된 이벤트로 첨부만 합친다. Review처럼 Composer가 없는 경로는 저장 readback 성공 후 복귀한다. 전송 전에 시작된 늦은 캡처는 소비된 draft revision으로 거절한다. 텍스트 첨부는 next/queue에 포함하고, queue 시작과 원래 command ID 복구는 entry의 고정 첨부를 사용한다. 이미지는 next-only로 유지한다. 설명·실행 지시에는 텍스트 첨부를 조용히 빼지 않고 next/queue 선택을 요구한다.

결과/기본/상세 활동은 표시 설정이다. 상세 활동만 기존 작업 기록을 기본 펼치며 transcript는 여전히 명시적으로 연다. 승인·실패·필요한 조치, 원본 이벤트와 현재 Run 입력은 유지한다. 새 의존성·DB migration·실행 원장은 없다.

## 검증 환경과 결과

Linux, Node 24.19.0, pnpm 10.30.3, Vitest/jsdom, 설치된 Monaco/xterm/Dockview, 인앱 브라우저의 실제 production build를 사용했다. 임시 Git/SQLite/관리 사본과 ScriptedAgentAdapter만 사용했으며 유료 모델 호출은 없다. 최종 entry는 `index-ixYwEsYE.js`, `dist/index.html` SHA-256은 `c651509ecc10f9847468afc2c3ab61175a3431007d5582ddd92d748901e88278`이다. Vite의 기존 큰 chunk 경고는 남는다.

- 계약/core 집중 회귀: 5 files / 80 PASS (`/tmp/corral-p11-core-regression.log`). 계약 범위·큐 보존·다른 출처의 동일 본문·source data 전달·SQLite 저장을 포함한다.
- 최종 관련 회귀: 25 files / 118 PASS (`/tmp/corral-p11-final-regression.log`). source UI/버퍼/터미널, 실제 Composer의 queue/재시도/명시 선택, draft, 경로/도킹, 표시 밀도/위젯/단축키 회귀를 포함한다.
- 추가 계약·저장 및 UI 경계: 6 files / 79 PASS (`/tmp/corral-p11-final-boundaries.log`). 마지막 라우터·도킹·밀도 변경 후 3 files / 14 PASS (`/tmp/corral-p11-final-ui-regression.log`). 중복된 검사가 있으므로 합산하지 않는다.
- `pnpm typecheck`와 Studio production build PASS. 원시 로그는 `/tmp/corral-p11-typecheck-all.log`, `/tmp/corral-p11-build-final.log`이다.
- 최종 `spec:check` 2478 checks와 scenario tags 322/322, `contracts:check` 생성 schema 일치, `git diff --check` PASS. Biome exit 0이며 기존 ChatView/RunMessage/core 영역의 non-null assertion 경고 30개는 그대로다. 로그는 `/tmp/corral-p11-final-spec.log`, `/tmp/corral-p11-final-contracts.log`, `/tmp/corral-p11-final-biome.log`이다.
- 신규 핵심 반례를 먼저 실패시켰다: provenance/queue 및 terminal 범위, 동일 본문 출처 덮어쓰기, 늦은 검사 응답, storage 실패를 성공으로 반환, queue 첨부 유실, 설명 요청의 조용한 누락, merged compose/Run 링크. 각각 수정 후 통과했다. 새 E2E는 추가하지 않았다.

## 실제 인앱 관찰

1. 저장된 코드 L3:1–L5:2 선택을 첨부하고 원본 이동을 확인했다. 미저장 `DRAFT_ONLY` 선택은 확인 후 별도 캡처가 됐고, 기존 입력과 앞선 첨부를 보존했다. 원본 변경 시 stale 상태와 이전 본문을 표시했다. 교체 미리보기에서 saved→draft와 새 버퍼 hash를 확인하고 명시 확정했다.
2. 완료된 검사 출력과 선택 hunk를 첨부했다. Review에서 `compose=true`로 복귀해 기존 초안·첨부가 유지됐다. 반환된 hunk는 고정 from/to와 선택 patch를 사용했다. 실제 화면에서 찾은 번역 namespace 누락도 수정했다.
3. 코드 두 개·검사·hunk를 queue에 저장하고 현재 Run 승인을 정상 Coordinator 경로로 끝낸 후 수동 시작했다. SQLite entry에는 네 출처가 유지됐고 ScriptedAgentAdapter의 실제 입력/반환에서 네 본문과 bufferHash/patchHash를 확인했다. `DRAFT_ONLY`는 디스크 파일에 없었다. `/tmp/corral-p11-queue-readback.json`에 bounded readback을 기록했다. 이는 유료 모델·provider 검증이 아니다. 자동 queue는 같은 시작 경로를 재사용하며 별도의 실제 자동 시작 여정은 실행하지 않았다.
4. 별도 사본의 실제 Bash PTY에서 `P11_TERMINAL_SELECTED` 21바이트를 선택해 첨부했다. 캡처한 geometry/sequence가 표시됐다. 새 출력을 만든 뒤 원본 열기는 stale 안내와 이전 본문을 보여줬다. 첨부 삭제 및 PTY 종료 코드 0을 확인했다.
5. 표시 밀도의 기본→상세 활동→결과 전환에서 작업 기록 기본 펼침/접힘, 입력 보존, 승인/실행 제어 접근을 확인했다. 첨부 preview가 작성창을 밀어내는 문제를 실제 1280×720에서 재현했다. 칩을 접고 목록·작성창 스크롤을 제한했으며, 포커스 이동으로 fixed 도킹 프레임이 스크롤되지 않도록 clip 경계를 적용했다. 최종 chat/dock scrollTop은 0이고 보내기에 접근할 수 있다.
6. `compose=true`와 Run 선택이 병합되는 링크는 TanStack이 raw parent search를 함께 보존하므로, 선택 해석에서도 정규화했다. 최종 빌드에서 Review→첨부→작성창→승인 링크가 정확한 Run 패널/최종 승인 버튼으로 이동했다. 뒤로 이동·새로고침 후 작성 중 텍스트와 캡처도 유지됐다.
7. 390×844에서 실제 document scrollWidth=390, 입력과 보내기, 전역 승인/취소에 접근했다. 최종 렌더러 warn/error 로그는 0이었다. 모든 임시 탭·서버·작업 사본과 viewport override를 정리했다.

화면 증거는 `/tmp/corral-p11-context-desktop.png`, `/tmp/corral-p11-context-390.png`, `/tmp/corral-p11-dirty-confirm.png`, `/tmp/corral-p11-terminal-stale.png`에 있다. fixture는 `/tmp/corral-p11-preview.ts`이며 `--check` 자체 검사도 통과했다. 임시 산출물은 배포 자산이 아니다.

실제 OS IME·스크린리더·Windows/macOS·설치판 GUI·유료 모델은 이번 P11에서 검증하지 않았다. 기존 IME 키 보호와 관련 단위 회귀는 보존했다. P12 이후 Git·개발 여정과 P29 플랫폼 qualification은 별도 후속이다.
