# CR-019: broker 코딩 도구·자동 검증·제한된 개선 (R2)

- 상태: 채택·구현 중, 2026-10-18. Bell의 H2–H8 구현 계속 요청.
- 기준: 개인 하네스 구현 플랜 H4–H6, CR-018, CR-012·013.
- Pi `read/edit/write`의 공개 계약을 기존 파일 broker에 연결한다. 읽은 근거는 execution별로 보관하며 다른 실행의 읽기가 쓰기 권한을 대신하지 않는다. symlink·범위 밖 경로·변경된 hash는 거절한다.
- 검증은 기존 등록 argv만 실행한다. 모델은 argv/env를 바꾸지 못한다. Run·execution·attempt·effect에 묶고, 시작 tree와 명령 fingerprint를 고정한다. 별도 검증 복사본에서 수행하며 취소는 자식 프로세스까지 정리한다.
- 검증 실행 상태와 품질 판정을 분리한다. error/cancelled/stale를 pass로 취급하지 않는다. 시간·외부 호출·ID는 주입한다.
- 검토 recipe의 기준·평가 역할·검사·시도/수정/시간/토큰 상한은 불변 revision이다. 기존 Agent→Review→Decision→Loop를 재사용한다. 동일 결과·같은 실패·상한 도달은 명시한 이유로 멈춘다.
- LSP 조회는 사용자가 등록한 서버만 실행한다. Hashline은 고정 fixture의 비교 평가 후보이며 기본 편집 방식으로 추가하지 않는다.
- 인간 승인과 원본 반영은 별도 동작이다. 자동 commit/push/deploy는 추가하지 않는다.

## 반례·완료 조건

TC-HAR-010/011: Pi 편집 계약, 변경된 읽기 근거·실행 간 혼선·경로 탈출 거절.
TC-HAR-012/013: spawn 실패, 중복 종료, 취소 후 자식 잔존, 변경된 fingerprint, stale 보고서 거절.
TC-HAR-014: 첫 시도를 포함한 상한, 기준 변경 거절, 같은 출력/실패 반복 중지, 부모 취소 후 후속 호출 없음.
일반 CI는 로컬 fixture/fake provider를 사용한다. 실제 품질·비용 개선은 opt-in 평가 없이 주장하지 않는다.

### H4 편집 경계

- SDK 역할에는 역할의 기존 파일 권한과 하네스 allowlist를 함께 만족하는 Pi `read/edit/write` 별칭을 제공한다. 기존 기본 worker의 파일 도구 계약은 유지한다.
- Pi 1.3.0의 `edit` 입력은 `{path, edits:[{oldText,newText}]}`다. 각 블록은 원본 파일에서 찾고 겹침·모호한 일치·변경 없음은 공식 도구와 같은 의미로 처리한다. BOM·줄바꿈·diff/patch 형식도 공개 도구를 재사용한다.
- 파일 I/O는 계속 서버 broker가 수행한다. Pi 편집 변환은 리소스·확장·세션을 로드하지 않는 별도 임시 worker에서 공개 `createEditTool`의 메모리 operations로 계산한다. 실제 파일 경로나 자격 증명을 보내지 않는다. 변경된 결과만 broker의 쓰기 lease 및 execution별 읽기 hash 검사로 반영한다.
- 검증 대상: 원본 Pi와 같은 정상 결과/오류, 여러 블록의 전부 성공 또는 무변경 실패, BOM/CRLF, 중복 문자열·겹침, 취소 시 무반영, 계산 중 원본 변경 거절. 단일 파일 도구는 기존 원자적 교체·파일 작업 기록을 재사용한다.

### 프로젝트 실행 설정과 신뢰

- 등록 검사와 LSP 서버 정의는 `ProjectToolConfigRevision`에 저장한다. 프로젝트별 증가 revision과 내용 hash를 가지며 수정·삭제하지 않는다. 역할은 등록 ID를 선택하고 Run 시작 시 해당 설정 revision을 고정한다. 실제 argv·로컬 경로는 공개 Run 이벤트에 넣지 않는다.
- 실행 신뢰는 프로젝트·종류·ID·launch fingerprint별 별도 결정이다. 설정 revision만으로 실행을 허가하지 않는다. fingerprint에는 정의, 실행 파일, 관련 scripts/lockfiles와 Node 버전을 포함한다. 신뢰 철회는 이미 고정된 설정에도 적용한다.
- 기존 `workspace_bindings.verify_json`은 migration에서 첫 설정 revision으로 보존한다. 자동 실행 신뢰로 승격하지 않는다. 이후 기존 수동 검사 설정 API도 같은 revision 저장소를 사용한다.
- TC-HAR-012/013은 이전 revision 보존, 동시 저장 충돌, 잘못된 argv/중복 ID, 기존 설정 이관 및 신뢰 비승격도 확인한다. LSP·검증 실행기는 같은 설정을 읽되 별도 수명으로 관리한다.

### Pro 재검토 후 파일 변경 전제조건

- edit는 계산을 시작할 때 확인한 원본 hash를 최종 적용까지 유지한다. 계산 중 파일 삭제·교체 또는 같은 execution의 재조회가 이 전제조건을 바꾸지 않는다. 없는 파일 생성과 기존 파일 편집을 구별한다.
- broker와 사람용 파일 조회는 같은 제한 바이트 읽기·파일 핸들 검사를 사용하되, 사람의 열람은 agent 읽기 기록을 만들지 않는다. 편집용 문자열은 BOM을 보존한다.
- 최종 OS 변경 제출 직전에 취소·원본 hash·대상 존재 여부를 재검사한다. 새 파일 생성은 이미 존재하는 경로를 덮지 않는다. 이미 OS에 제출한 작업을 취소가 되돌린다고 보장하지 않는다.
- 파일 변경 성공 후 기록만 실패하면 작업은 `uncertain`으로 남긴다. `failed`로 바꿔 실제 변경을 없던 것으로 기록하지 않는다. 임시 파일은 정리한다. TC-HAR-010/011의 삭제·재조회·BOM·최종 쓰기 취소·기록 실패 반례로 확인한다.
- 검증 명령 자체가 후보 복사본의 파일을 바꾼 경우 `targetUnchanged=false`와 `inconclusive`로 기록한다. 종료 코드 0만으로 실행 시작 tree의 통과를 확정하지 않는다. Git에서 제외한 의존성 준비는 별도이며 원본 폴더와 공유하지 않는다.
