# CR-030: 체크포인트와 안전한 이어하기

- 상태: **순차 구현 승인** — Bell, 2026-10-19: “플랜대로 M0부터 순서대로 개선 진행해. CR 등록 → 실패 테스트 → 구현 순서로 하고, 기존 기능 회귀도 확인해.”
- 계획: 통합 개선 실행 계획 (Git `373764467a52:docs/plans/Corral-Improvement-Execution-Plan-2026-10-19.md`), M2-1, M3-3/4.
- 기준: `780591e`(PR #60 수정 포함). 구현/검증 완료 여부는 단계별 증거로 따로 기록한다.
- 추적: M2/M3 착수 시 파일·저장소·worker 복구 시험 확장.

## 계약

1. 기존 Git tree/ref/write lease로 checkpoint manifest·소유 세션/Run·event seq·보존 정책을 기록한다. 미완성 checkpoint를 사용 가능으로 표시하지 않는다.
2. 복구 전 checkpoint와 exact content 전제를 검사해 사용자 수정을 보호한다. 복구는 새 기록이고 기존 검토/시험의 stale를 재판정한다. ignored/untracked/binary 포함 범위를 표시한다.
3. compaction은 공개 Pi 경계를 사용하고 규약·지시·계획·미해결 질문·근거·선택 resource를 보호한다. 정책/승인 원장을 요약으로 대체하지 않고 새 permit·비용 경로를 사용한다.
4. interrupted Run은 terminal로 남기고 checkpoint에서 새 Run/attempt와 resumedFrom을 만든다. 이전 worker·resource/tree·대기·미정산·unknown effect를 확인하며 비멱등 효과를 자동 재실행하지 않는다.

## 검증과 배포

새 동작과 데이터·권한·취소 경계의 대표 반례만 구현 전에 실패를 확인한다. 기존 통합 시험을 우선 확장하며 문구·내부 함수·모든 조합을 따라가는 시험은 추가하지 않는다. 적용되는 정상·실패·취소·중복·늦은 이벤트 경계는 기존 시험과 합쳐 확인한다. D&D·Reins·과거 snapshot/hash·[CR-042](CR-042-desktop-capabilities.md) ABS-06으로 확장된 host admission·작업 사본별 단일 writer 제한을 유지한다. live/OS/브라우저 증거는 결정적 fixture와 구별한다.


## C-101 파일 체크포인트 v1

- run 시작/종료 및 수동 체크포인트는 Git commit을 만들지 않고 tree/ref와 version 1 manifest(hash, session, Run/seq, 생성 목적)를 기록한다. ref나 manifest 확정 전 중단은 incomplete다.
- tracked 파일과 ignore되지 않은 untracked 파일(바이너리 포함)은 snapshot에 포함한다. ignored 파일과 빈 디렉터리, 외부 API/DB/비용은 제외한다. symlink/submodule/file-directory 전환을 포함한 복구는 v1에서 거절한다.
- 복구 계획은 checkpoint hash와 현재 tree에 결합한다. Coordinator가 전역 Run 시작/복구 경쟁을 차단하고, 작업 사본 lease 아래 다시 확인한 뒤 pin된 복구 전 체크포인트를 만든다. Git의 임시 index와 dirty-file 보호를 사용하며 원본 저장소/사용자 index는 바꾸지 않는다. 중간 실패/중단은 partial/uncertain으로 남기고 자동 반복하지 않는다.
- 기본 수동 보존은 pin, Run 체크포인트는 unpinned다. 명시 GC는 30일 지난 unpinned 체크포인트 중 최신 50개 밖의 것만 만료시킨다. 복구가 참조하는 체크포인트는 제외하고 Corral checkpoint ref만 제거한다. Git 객체의 실제 압축/삭제는 실행하지 않는다.

C-108 보완: 새 checkpoint manifest v2는 original/working_copy 대상을 명시한다. 선택 hunk로 계산한 target tree는 hunk_proposal이고 실제 과거 파일 상태와 구별한다. 기존 v1은 작업 사본만 대상으로 해석한다. 원본 복구는 연결된 동일 Git 저장소·신뢰·현재 tree를 다시 확인하며 미리보기에도 원본임을 명시한다.

## C-109 보호 컨텍스트와 압축 요청

- Coordinator가 소유 실행의 criteria·계획·질문/답변·Reins·입력/리소스 참조를 private 보호 컨텍스트로 제공한다. 두 worker는 매 모델 요청 직전에 다시 읽고 hash를 기록한다. 요약이 권한·승인·검증 사실을 대체하지 않는다. 보호 컨텍스트는 한도를 넘으면 거절하며 조용히 잘라내지 않는다.
- 자동 SDK 압축 뒤에도 고정 안전 구획과 최신 보호 컨텍스트/필수 콘텐츠를 provider 요청에 다시 넣는다. 압축 모델 호출도 기존 permit/비용/취소 경로를 통과한다.
- `compact_context`는 현재 execution/attempt/control revision을 검증하고 SDK의 다음 안전 경계에 대기시킨다. Pi 1.3.0의 수동 compact가 현재 작업을 abort하므로 진행 중 도구/질문을 끊어 호출하지 않는다. 경계에서 중단 없이 유휴가 된 뒤 압축하고 미완료 업무를 이어간다. 이미 완료/취소된 실행은 압축을 건너뛴다. pi-core의 수동 압축은 지원하지 않는다.
- 요청·시작·완료/실패/취소/건너뜀을 구별하고 완료는 실제 compaction 목적 모델 호출과 결합한다. 실패/취소는 기존 context를 보존한다. 원래 Run/Task 완료나 도구 permit 재사용을 만들지 않는다.

수동 압축은 외부 `session_before_compact` hook이 있으면 본문 변경 전에 거절한다. 원본 요청/입력은 요약으로 대체하지 않고 다음 turn에서 누락되었을 때 다시 제공한다. 자동 압축의 반환 요약 또한 Coordinator의 권한/완료 사실을 대체하지 않는다.

## C-110 버전 있는 실행 체크포인트와 새 Run 이어하기

- 모델 요청 전 안전 경계에서 v1 manifest, private Pi 1.3.0 메시지 context·실행 입력, source Run/attempt/sequence, criteria/model/harness hash와 파일 checkpoint를 결합한다. 참조와 이벤트가 함께 확정된 항목만 복구 후보이며 본문은 공개 export에 포함하지 않는다.
- v1은 상태를 검증할 수 있는 단일 agent→output 실행, pi-core 또는 콘텐츠 전용 strict SDK를 지원한다. 네이티브 확장/MCP/check/LSP·사용자 정의 session state·팀/Loop 상태는 자동 복구하지 않고 새 요청이 필요하다고 표시한다. 기존 D&D·Reins 실행 기능을 제한하는 것은 아니다.
- 이어하기는 사용자가 고른 checkpoint/hash/source sequence에 결합한 별도 시작 경로다. 이전 Run은 terminal로 유지한다. 이전 worker 정리, 동일 파일 tree/retained ref, model/resource/criteria, 대기·미정산 사용량·unknown effect/file operation, checkpoint 뒤의 효과를 다시 검사한다. 불명확하면 실행하지 않는다.
- 새 Run에는 새 실행/permit/승인/파일 read ledger와 resumedFrom lineage를 만든다. 이전 사용량을 차감한 한도로 시작하며 과거 system 구획은 현재 고정 구획으로 교체한다. 역사 메시지의 도구 호출을 자동 실행하거나 과거 artifact/approval ID를 현재 소유권으로 받아들이지 않는다.
- 재열람과 context-only 새 요청은 실행 복구와 구별한다. 지원하지 않거나 부족한 checkpoint를 실행 가능으로 표시하지 않는다. 본문은 4 MiB/항목, Run당 64 MiB로 제한하며 한도 도달은 기록하고 정상 작업 자체를 중단하지 않는다.
