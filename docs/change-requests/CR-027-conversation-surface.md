# CR-027: 요청 중심 대화와 변경 검토

- 상태: **순차 구현 승인** — Bell, 2026-10-19: “플랜대로 M0부터 순서대로 개선 진행해. CR 등록 → 실패 테스트 → 구현 순서로 하고, 기존 기능 회귀도 확인해.”
- 계획: [통합 개선 실행 계획](../plans/Corral-Improvement-Execution-Plan-2026-10-19.md), M1-5/6/7, M2-5, M3-2.
- 기준: `780591e`(PR #60 수정 포함). 구현/검증 완료 여부는 단계별 증거로 따로 기록한다.
- 추적: M1 착수 때 기존 transcript/파일/세션 회귀를 우선 확장한다.

## 계약

1. 기존 session entry·Run·execution transcript를 연결해 공개 진행·도구·질문/승인·결과를 표시한다. 사용자 요청과 Pi turn은 별개다. token frame 중복·늦은 결과는 원래 실행에만 반영한다.
2. InteractionView와 Inbox는 동일 domain 사실을 보여 주며 응답 receipt 확정 전 대기를 닫지 않는다. 닫기/Escape는 거절·취소가 아니다. shortcut은 카드 focus에서만 동작하고 IME·입력 영역을 침범하지 않는다.
3. 세션별 초안·의도·첨부·대상·스크롤을 보존한다. 첫 첨부는 서버가 MIME/용량/개수/hash를 검증한 텍스트다. 이미지 capability는 별도다.
4. 읽기 전용 diff는 기존 고정 tree 비교를 요청 카드에 연결한다. hunk 쓰기는 CR-030 checkpoint 이후 exact precondition·lease로 처리하며 검토 판단/원본 반영/사본 되돌리기를 구별한다.

## 검증과 배포

새 동작과 데이터·권한·취소 경계의 대표 반례만 구현 전에 실패를 확인한다. 기존 통합 시험을 우선 확장하며 문구·내부 함수·모든 조합을 따라가는 시험은 추가하지 않는다. 적용되는 정상·실패·취소·중복·늦은 이벤트 경계는 기존 시험과 합쳐 확인한다. D&D·Reins·과거 snapshot/hash·전역 활성 Run 제한을 유지한다. live/OS/브라우저 증거는 결정적 fixture와 구별한다.


## C-098 텍스트 첨부 계약

- 텍스트 첨부는 파일 경로 권한이 아닌 source data다. 최대 5개, 각 UTF-8 64 KiB, 총 320 KiB이며 MIME·파일명·NUL·byte length·SHA-256을 검사한다. 새 저장 엔진 대신 기존 Run reference/private snapshot을 확장한다.
- 본문은 현재 Run 입력에 복사하고 public 이벤트에는 노출하지 않는다. 사용자 요청 카드는 파일명·크기·hash로 표시하고 private 내용만 명시적으로 열 수 있다. 재시도는 같은 command/hash, 새 초안은 기존 revision 소비 규칙으로 보존한다.
- 첨부는 새 요청에만 전송한다. steer/queue/explain에서 silently drop하거나 본문 명령으로 바꾸지 않는다. 해당 의도에서는 새 요청으로 변경하도록 표시한다.

세션 요청 기록도 commandId와 불변 내용에 결합한다. 기록 응답 유실 후 같은 요청을 재전송하면 기존 entry를 반환하고, 같은 ID로 본문·첨부·대상·범위를 바꾸면 거절한다. 기존 기록의 상태 변경은 보존하며 과거 중복 기록을 삭제하지 않는다.

## C-100 읽기 전용 요약과 긴 대화

Run 종료 tree의 파일 수와 알려진 추가/삭제 줄 수만 집계한다. 바이너리/미집계 파일 수와 기준 없음은 따로 표시하며 요약 조회는 snapshot을 생성하지 않는다. 기존 Review 범위와 출처를 유지한다.

40개 초과 요청은 기존 TanStack Virtual로 가상화한다. entryId/runId와 화면 offset으로 읽던 위치를 보존하고 focus 중인 행은 유지한다. 새 요청/스트림은 마지막을 보고 있을 때만 따라간다.

## C-106 이미지 첨부

브라우저가 PNG/JPEG/WebP를 최대 2048×2048 PNG로 정규화한다. 서버는 PNG CRC·청크 구조·치수(최대 4,194,304 픽셀)·비인터레이스 8-bit RGB/RGBA를 검사하고 다시 인코딩해 ancillary metadata를 제거한다. 1개 1 MiB, 요청당 최대 3개이며 파일 본문을 path 권한으로 사용하지 않는다. 설치된 pngjs 7.0.0의 기존 pure-JS decoder를 직접 의존성으로 재사용하고 별도 native 이미지 런타임을 추가하지 않는다.

세션 소유 SQLite BLOB에 저장하고 새 Run 시작 때 해당 bytes를 private 기록으로 복사한다. public export에는 image bytes/이름을 넣지 않는다. 이미지 지원이 시작 snapshot에 확인되지 않은 모델/역할이 하나라도 있으면 실행을 거절한다. 실제 payload hook 이후 이미지 bytes 포함을 다시 확인한다. 이미지 내용의 지시는 사용자/시스템 권한으로 승격하지 않는다.

## C-108 변경 조각 승인과 반영

- 기존 고정 from/to tree·Review 화면을 확장한다. Git이 만든 텍스트 patch의 hunk hash를 선택하며 임의 patch 본문을 받지 않는다. 바이너리·대형 파일·mode/type 변경·symlink·파일/디렉터리 전환은 거절한다.
- `apply_original`과 `revert_working_copy`는 별개 동작이다. 선택 hash·파일 hash·전체 patch hash·from/to·대상 현재 tree를 고정한 미리보기를 만든 뒤 명시 적용한다. 사용자 수정이 있으면 fuzzy merge 없이 충돌이다.
- C-101의 immutable checkpoint/ref와 복구 원장을 재사용한다. 새 v2 manifest에는 대상(original/working_copy)과 선택 patch 근거를 명시한다. 과거 v1은 working_copy로만 읽고 hash를 재작성하지 않는다. 적용 전 같은 대상의 pin된 보존본을 만들며 user Git index를 건드리지 않는다.
- 기존 전체 파일 원본 반영/되돌리기도 같은 대상 lease·전역 실행 guard·복구 전 보존본을 거친다. 검토 승인·실제 파일 반영·파일 복구를 동일 상태로 취급하지 않는다. 부분/중단/불명확 결과를 자동 반복하지 않는다.
