# 통합 개선 M1 구현 증거

2026-10-19 · `feat/integrated-improvements` 작업 사본 · 배포/병합 전

CR-025~028, 032~034의 M1 범위를 C-093~100으로 연결했다. 새 테스트는 질문/승인/계획/파일·입력 경계와 대표 사용자 흐름에 집중하고 기존 하네스·파일·세션·D&D·Reins 시험을 확장했다. 유료 호출은 없다.

## 구현

- `ask_user`: 명시 답변, private 질문/답변, schema hash·attempt·revision 검증, 대기/취소, 두 Pi runtime, CLI의 `needs_input`와 hash에 결합된 answers 파일.
- 구조화 권한: 최종 인자·descriptor hash·policy revision을 고정한다. deny/역할/strict 상한 유지, 정확한 한 번의 승인과 다음 실행용 정책 저장을 구분한다.
- `update_plan`: 실행/지정 planner 소유, revision·criteria 검증, 검증 필수 항목은 실제 등록 check·현재 tree 근거를 요구한다. 계획 완료는 Task/Run 성공이 아니다.
- 프롬프트: 8개 결정적 보호 구획, TaskBrief 투영, 실제 provider payload 보존 검사, pi-core/pi-sdk의 구획 hash/byte/포함 이유 기록. review_only는 관리 파일 쓰기를 제거하고 native/MCP/codemode 실행을 거절한다.
- 내장 Core 5개/Coding 3개/leeskills 10개: 기존 설치→내용 검토→신뢰→명시 profile 바인딩을 사용한다. SDK가 필요한 팩 때문에 pi-core를 자동 전환하지 않는다. 바인딩된 sibling Skill만 매핑한다.
- 대화: 요청 소유 Run 안에 질문/승인/계획/도구 상태, UTF-8 텍스트 첨부, 단일 모델/추론 메뉴, 작업·검증 범위, 초안 revision/재시도/설정 복귀, IME 및 질문 답변 후 focus 복귀.
- 읽기 전용 Run diff: 고정 시작/종료 tree, 파일/줄 수와 미집계 파일 표시, 기존 Review 링크. 종료 tree가 없으면 나중 사용자 변경으로 채우지 않는다. 진행 중 종료 기록의 완료만 기다린다.
- 긴 대화: 설치된 TanStack React Virtual 3.14.19(virtual-core 3.19.4), 40개 초과 시 가상 목록, entryId/runId + 화면 offset 복원, focus 행 유지, 과거 읽기 중 자동 스크롤 중단.

## 검증

| 범위 | 결과 |
|---|---|
| 전체 단위·통합 | 1,108 통과, 기존 opt-in 5 skip (종료 tree 누락 수정 전 전체 실행) |
| 마지막 도구 상태/종료 tree 경계 | core tool-lifecycle + server files/server 80 통과 |
| 사용자 흐름 | auto 취소·이동·응답 유실 13개, 긴 대화 1개, Reins 1개 통과. 파일 검토와 첨부→질문→답변 흐름 2개는 발견한 오류 수정 후 각각 통과 |
| D&D·접근성 | Chromium 기존 8개 통과: 드래그/연결/실행, 키보드/Undo/Reins, IME, 자동 axe 검사 |
| 타입 | 전체 workspace + tools/live 통과 |
| 생성 계약·추적 | schema 재생성, spec 1,782 검사, 시나리오 태그 223/223 통과 |
| 패키징 | Linux x64 runtime staging 성공. 내장팩의 원본/staging 내용 비교 일치. 설치된 AppImage 화면 검증과는 구별 |

질문·정책·계획·프롬프트·첨부·작업 범위는 기능/경계 실패를 확인한 후 구현했다. 브라우저에서 IME Enter, 요청 범위 전달 누락, 번역 namespace, 종료 snapshot 경합도 실제 실패로 확인했다. 긴 대화 시험의 초기 fixture는 CSRF/요청 제한에 걸렸고, 기존 성능 시험의 격리 SQLite fixture 방식으로 고쳐 1,000개 요청의 제한된 DOM과 앵커 복원을 검증했다. 이 fixture 실패를 제품 기능의 red 증거로 계산하지 않는다.

로그: `/tmp/corral-improvement-evidence/`의 `user-input-*`, `permission-*`, `work-plan-*`, `prompt-packs-*`, `task-brief-*`, `entry-retry-*`, `m1-full-test.log`, `m1-diff-green.log`, `m1-browser*.log`, `m1-canvas-accessibility.log`, `m1-types-final.log`, `m1-spec-final.log`, `m1-desktop-stage.log`. 작업 사본이 계속 바뀌므로 이후 단계의 전체 검증으로 최종 후보를 다시 확인한다.

실제 유료 모델 품질, 현재 후보의 AppImage GUI, 다른 OS, 제품 worker의 OS sandbox, hosted CI/배포는 이 기록의 검증 범위가 아니다. 모델에는 필수 지침을 전달하지만 프롬프트만으로 운영체제 격리를 보장하지 않는다. 이미지 첨부는 M2, OS 격리·hunk·compaction·이어하기는 M3 범위다.
