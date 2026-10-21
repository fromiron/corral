# CR-032: 세션 연속성과 검색 분기

- 상태: **순차 구현 승인** — Bell, 2026-10-19: “플랜대로 M0부터 순서대로 개선 진행해. CR 등록 → 실패 테스트 → 구현 순서로 하고, 기존 기능 회귀도 확인해.”
- 계획: 통합 개선 실행 계획 (Git `373764467a52:docs/plans/Corral-Improvement-Execution-Plan-2026-10-19.md`), M1-5, M3-5.
- 기준: `780591e`(PR #60 수정 포함). 구현/검증 완료 여부는 단계별 증거로 따로 기록한다.
- 추적: 기존 sessionDraft/navigation/세션 E2E를 우선 재사용.

## 계약

1. 기존 sessionDraft revision·references·의도·대상·설정 복귀·미저장 그래프를 보존하고 첨부/스크롤 앵커/선택 실행으로 확장한다. 탭 닫기와 세션 만들기는 실행 효과가 아니다.
2. metadata부터 private transcript 검색으로 확장한다. 한국어/일본어/경로/식별자, 보관·삭제·index version을 처리한다. 탭 수는 활성 Run 한도를 늘리지 않는다.
3. 메시지 분기는 CR-030 checkpoint/context로 새 lineage를 만든다. 원본 메시지와 downstream을 수정하지 않으며 미래 context를 과거 지점에 넣지 않는다. 옛 기록은 context-only임을 표시한다.

## 검증과 배포

새 동작과 데이터·권한·취소 경계의 대표 반례만 구현 전에 실패를 확인한다. 기존 통합 시험을 우선 확장하며 문구·내부 함수·모든 조합을 따라가는 시험은 추가하지 않는다. 적용되는 정상·실패·취소·중복·늦은 이벤트 경계는 기존 시험과 합쳐 확인한다. D&D·Reins·과거 snapshot/hash·[CR-042](CR-042-desktop-capabilities.md) ABS-06으로 확장된 host admission·작업 사본별 단일 writer 제한을 유지한다. live/OS/브라우저 증거는 결정적 fixture와 구별한다.


## C-111 검색·탭·메시지 분기

- 로컬 검색은 기본 metadata 범위에서 시작한다. 명시적으로 본문을 포함하면 private SQLite FTS5 trigram index v1에 사용자 메시지·고정 산출물·모델 응답을 색인한다. 한국어/일본어/경로/식별자를 NFKC 정규화하고 짧은 검색은 같은 index의 literal 부분 문자열로 찾는다. 보관/삭제는 현재 세션·프로젝트와 결합해 반영하며 인덱스 재구축은 원본 기록을 변경하지 않는다. 검색은 인증된 POST이고 키/credential 저장소는 색인하지 않는다.
- 작업 탭은 세션 ID와 기존 URL 선택만 기억한다. 탭 닫기는 Run 취소/세션 삭제가 아니며 초안·스크롤은 기존 저장소를 쓴다. 브라우저 기본 단축키는 보존하고 Electron의 Cmd/Ctrl+1–9만 탭 선택에 사용한다.
- 분기는 고정 메시지의 source sequence를 기준으로 한다. 기준 이후의 context/지시/파일을 끌어오지 않는다. 사용할 수 있는 runtime/file checkpoint는 새 세션 작업 사본과 새 lineage/권한으로 연결하고 시작 비용을 표시한다. 지원되지 않거나 옛 기록은 context-only로 명시한다. 원본/형제 기록과 원본 작업 사본을 변경하지 않는다.
