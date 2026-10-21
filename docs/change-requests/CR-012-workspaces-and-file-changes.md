# CR-012: 작업 폴더, 격리 작업 복사본, 파일 도구, 변경 비교와 검증 명령

- 변경 ID / 제안자 / 날짜: CR-012 / Bell(제안 `CR-WB-001`), Claude(저장소 적용) / 2026-10-16
- 상태: **승인**(Bell /goal "개선플랜의 완성까지", 2026-10-16. Workbench 플랜 W3 = 제안 U2)
- 연결 문서:
  - Workbench 개선 플랜 (Git `373764467a52:docs/plans/Workbench-Improvement-Plan.md`).
  - 제안 01 §7–§8 (Git `373764467a52:docs/proposals/workbench-v0.1/01-Improvement-Spec.md`), 03 §8–§9 (Git `373764467a52:docs/proposals/workbench-v0.1/03-Technical-Design.md`).
  - ADR-019(자격 증명 격리), CR-010·CR-011.

## 기존 문구

MVP는 파일 쓰기와 명령 실행을 제외했다. 작업 도구는 `search`·`read_document`·`write_artifact`뿐이다.

## 제안

1. **작업 폴더 연결(WorkspaceBinding).** 로컬 서버에서만 프로젝트당 폴더 하나를 연결한다.
   - 경로는 서버가 실제 경로(realpath)로 바꾸고 디렉터리인지 확인한다. 화면에는 줄인 경로를 보인다.
   - Corral 데이터 폴더(`.corral`)와 자격 증명 폴더는 연결할 수 없다.
   - 연결은 **읽기 전용 관측**이다. Git이면 branch·HEAD·바뀐 파일 수를 보인다. 연결만으로 에이전트는 아무것도 읽거나 쓰지 못한다(WB-WSP-001).
   - Git 저장소의 hook·filter·설정은 실행될 수 있는 코드다. 그래서 작업 복사본과 검증 명령은 사람이 "이 저장소를 신뢰"를 켠 뒤에만 쓸 수 있다. 신뢰는 격리가 아니라고 화면에 적는다.
2. **격리 작업 복사본(session worktree).** 세션마다 `git worktree add --detach`로 만든다(WB-WSP-002).
   - 위치: Corral 데이터 디렉터리(`$CORRAL_DATA_DIR` 또는 `~/.local/share/corral/worktrees`). 원본 폴더 밖이다.
   - 기준: 지금 HEAD commit. 원본의 커밋하지 않은 변경은 들어가지 않는다. 화면에서 먼저 확인받는다. 자동 stash·commit은 하지 않는다.
   - 한 작업 복사본은 한 세션만 쓴다. 제거는 별도 명령이며, 원본 폴더를 지우지 않는다.
3. **파일 도구.** 작업 도구에 `list_files`·`read_file`·`write_file`·`delete_file`·`move_file`을 더한다. 역할이 허용하고, 그 Run의 세션에 작업 복사본이 있을 때만 쓸 수 있다(WB-SEC-001).
   - 경로: 작업 복사본 기준 상대 경로만 받는다. 절대 경로, `..`, `.git`, symlink를 거친 경로는 거절한다.
   - 대상: UTF-8 일반 텍스트 1 MiB 이하만 다룬다.
   - 덮어쓰기 조건: 이미 있는 파일은 이 Run에서 `read_file`로 읽은 내용과 지금 내용이 같을 때만 덮어쓰거나 지운다. 다르면 충돌로 거절한다(WB-WSP-004).
   - 기록: 쓰기마다 작업 기록(`file_operations`)에 의도(planned)를 먼저 남기고, 결과(applied·failed)를 남긴다. 서버가 그 사이에 멈추면 다음 시작 때 `uncertain`으로 바꾸고 자동으로 다시 하지 않는다(WB-WSP-005).
   - 직렬화: 같은 작업 복사본의 쓰기는 한 줄로 직렬화한다(WB-WSP-003).
   - 도구 호출 자체는 기존 effect intent·tool 이벤트 경로를 그대로 탄다.
4. **변경 snapshot과 비교(WB-DIF-001–005).**
   - snapshot: 작업 복사본 전체를 임시 index로 `git write-tree`한 tree다. 불변이고 내용 주소다. `refs/corral/…`로 고정해 GC되지 않게 한다.
   - 찍는 때: 작업 복사본을 만들 때(기준), Run 시작·종료 때.
   - 비교 범위:
     - 이번 Run: 시작 → 종료.
     - 세션 전체: 기준 → 지금.
     - 마지막 검토 이후: 검토 snapshot → 지금.
     - Git 상태: 원본 폴더의 HEAD → 작업 트리. 원본 폴더는 관측만 한다.
   - 파일 목록: 추가·수정·삭제와 +/− 줄 수를 보인다. 바이너리·1 MiB 초과는 내용 없이 표시하고 숨기지 않는다.
   - 출처: Corral 파일 도구가 쓴 경로는 `managed_agent`, 그 밖에 바뀐 경로는 `external_observed`로 표시한다. 작성자를 시간으로 추정하지 않는다.
   - 기준이 없는 지난 Run은 "기준 없음"으로 표시한다.
5. **검증 명령(WB-WSP-006).**
   - 등록: 프로젝트 연결에 argv 배열 명령(예: `["pnpm","test"]`)·시간 상한을 둔다. 사람이 신뢰를 켠 저장소에서만 등록·실행한다.
   - 실행: 셸 없이 작업 복사본에서 사람이 누를 때 실행한다. 환경 변수는 `PATH`·`HOME`·`LANG`만 넘긴다.
   - 기록: 실행할 때의 snapshot·종료 코드·signal·시간 초과·소요 시간·출력 끝 64 KiB를 남긴다. snapshot이 바뀌면 그 결과는 "지난 버전 기준"으로 표시한다.
   - 에이전트는 명령을 실행하지 않는다(임의 shell 비허용).

## 하지 않는 것(이번 CR)

원본 폴더 직접 쓰기, 원본 반영·되돌리기·검토 의견(CR-013), 비Git 폴더의 작업 복사본, hunk 단위 적용, 자동 commit·push, 에이전트의 명령 실행, OS 샌드박스.

## 테스트

- 경로 정책: `..`·절대·`.git`·symlink 거절.
- 덮어쓰기: 읽지 않은 파일, 읽은 뒤 바뀐 파일 덮어쓰기 거절.
- 중단 복구: planned 기록이 남은 채 재시작하면 `uncertain`.
- snapshot·diff: 추가·수정·삭제·바이너리를 집계한다. Run A·B가 바꿨다 되돌린 파일은 세션 순변경 0이고 Run별 변경에는 보인다.
- 검증: 종료 코드·시간 초과·snapshot 기록. 신뢰하지 않은 저장소는 거절한다.
- E2E(서버): 폴더 연결 → 신뢰 → 세션 작업 복사본 → 파일 도구를 가진 팀의 모의 Run → 변경 목록과 diff → 검증 실행.
