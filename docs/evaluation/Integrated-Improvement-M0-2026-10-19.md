# 통합 개선 M0 구현과 검증

- 기준: `780591e`(PR #60 자동 시작·취소·작업 사본 수정 포함), 작업 브랜치 `feat/integrated-improvements`.
- 요청: M0부터 CR 등록 → 핵심 실패 테스트 → 구현 → 기존 회귀. 테스트는 필요한 동작/권한 경계만 추가한다.
- 범위: M0 C-088~091 완료, M1-1의 첫 공통 안전 수정 C-092 완료. M1 전체 완료는 아니며 나머지 단계는 실행 계획 (Git `373764467a52:docs/plans/Corral-Improvement-Execution-Plan-2026-10-19.md`)을 따른다.

## M0 기준선과 계약

CR-025~036을 등록했다. 새 구현은 기존 eval에 별도 skill_quality 비교군과 제한된 반복을 더한다. 개인 하네스 비교군·기존 API/Run snapshot·활성 Run 제한은 유지한다. 새 테스트는 평가 핵심 2개와 같은 pack의 entry 바인딩 경계 1개다. 격리 PoC는 실제 OS에서 assert 기반 자체 검사를 실행한다.

기존 auto-team·시작/취소·과거 replay·초안/그래프·하네스·파일·리소스·eval의 10개 파일, **100개 테스트가 변경 전 통과**했다. PR #60의 정확한 HEAD와 hosted gate 성공도 read-only로 확인했다.

## 실패 후 구현

TC-QEVAL-001-H/N은 구현 전 모두 실패했다. 기존 schema가 skill_quality·prompt_only·repetitions를 거절하는 것을 확인했다. 새 비교 종류/군과 반복 상한을 구현한 뒤 기존 평가 시험 6개와 새 시험 2개가 함께 통과했다.

총 실행 상한은 새 비교에만 적용한다. 기존 personal_harness의 5군 조건과 다른 legacy suite 입력을 변경하지 않는다. 매 반복의 고정 작업 사본, calibration/holdout 분리, 반복 중 취소, 누락/중복/혼합 군과 초과 실행을 확인했다.

## Linux 격리 가능성

`node tools/sandbox/probe.ts`는 설치된 bubblewrap 0.13.1을 사용했다. 임시 sentinel과 loopback fixture만 접근했고 실제 자격 증명을 읽지 않았다. 비격리 대조 실행에서는 sentinel과 host endpoint가 보여야 검사가 유효하다. 격리 실행에서는 private 파일 숨김·작업 사본 쓰기·host network 거절·별도 PID/IPC/network namespace·stdio 왕복·취소 후 후손 종료를 확인했다.

이것은 **현재 Linux의 PoC**이며 Corral 제품 worker에 sandbox를 연결한 것이 아니다. 제품 Node fork IPC·허용된 provider egress·실제 native extension/browser 통합, macOS/Windows/WSL은 후속 검증이다. 실패/미지원은 별도 종료 상태로 남고 비격리 실행으로 대체하지 않는다.

## leeskills 콘텐츠와 runtime

고정 commit `1472032c0521c7f76f8811973b4cbe6b67804988`을 별도 임시 경로에 받아 검사했다. manifest는 0.7.0/MIT, 10개 Skill이다. skills 하위는 90개 파일·659,403 bytes이며 Markdown의 로컬 참조는 모두 해당 트리 안에서 존재한다. 원문·schema·보조 Python script·eval 자료는 M1 번들에 함께 보존한다. script 존재가 실행 허가는 아니다.

현재 lockResources는 pack hash만으로 다른 entry를 허용하지 않는다. 같은 bundle의 bound/sibling Skill을 넣고 바인딩 밖 entry와 누락 파일을 거절하는 회귀를 추가했다. 이 경계는 기존 코드로 통과하므로 중복 loader를 구현하지 않았다. sibling 경로의 명시 매핑과 동명 namespace는 M1 작업이다.

pi-core는 공통 Corral 프롬프트/도구 경로를 사용한다. Skill은 명시 pi-sdk binding에서 지원하며 자동 runtime 교체를 하지 않는다. 기존 Pi 1.3.0 spike는 virtual read가 있어야 목록이 payload에 나타나고 mandatory 본문이 압축 이후 turn 요청에도 남는지 확인한다.

## M1 첫 안전 수정

기본 runtime의 authorizeTool은 원본 proposal 객체를 보관하고 SDK 경로에서만 사본을 만들고 있었다. 승인 후 `approved.txt`를 `changed.txt`로 바꾸면 실제 backend가 변경된 경로를 읽는 실패를 TC-SAFE-001-H/N 한 테스트로 재현했다. 모든 runtime에 기존 사본 처리를 적용하는 한 줄 수정으로 해결했다. 중복 호출은 기존대로 거절하며 native descriptor·취소·후속 호출의 경계를 80개 관련 테스트로 확인했다. 구조화 정책과 영구 규칙 저장 UI는 아직 구현하지 않았다.

## 추적 검사 보완

릴리스 추적 검사에서 기존 실패 6개를 확인했다. 5개는 실제 존재하는 TC-REF의 F/D 태그를 H/N 전용 정규식이 누락한 경우다. 기존 parser 테스트에 두 예시를 추가해 red를 확인하고 허용 suffix를 H/N/F/D로 수정했다. 나머지 TC-HAR-008-H는 기존 strict 프로필 저장/해석과 strict Run의 LSP 승인 실행 시험에 연결했다. 새 제품 테스트를 추가하거나 기존 단언을 약화하지 않았다. 이후 207/207 시나리오의 실행 가능한 태그 연결을 확인했다.

## 검증 기록

| 검사 | 결과 |
|---|---|
| 변경 전 기준선 | 10개 파일, 100개 통과 |
| 평가 red → green | 신규 2개 실패 확인 → 기존 포함 8개 통과 |
| 인자 고정 red → green | 변경된 파일 경로 실행 재현 → 관련 80개 통과 |
| 전체 단위·컴포넌트 | 1,090개 통과, 기존 opt-in 5개 skip |
| 마지막 변경의 집중 회귀 | 태그 검사·core/server 하네스·리소스·도구 생명주기 53개 통과 |
| production Studio build와 E2E | 빌드 성공, Chromium/서버의 기존 23개 통과. D&D·연결·Undo·Reins 영수증·세션/초안·auto 취소/재시도·파일 검토 포함 |
| 타입 | 전체 workspace/tools/live 타입 통과, core 수정 후 core 타입 재확인 |
| OS opt-in | `CORRAL_SANDBOX_PROBE=1 node --test tools/release/sandbox.test.ts` 통과. 일반 CI에서는 opt-in skip |
| 추적 | `node tools/release/traceability.ts`: 207/207 |
| 스펙·lint | 스펙 1,470 검사와 태그 207/207 통과. lint 오류 없음, 저장소 경고는 남음 |
| 계약·의존성 | 생성 schema 일치, 기존 정확한 버전·Node/peer 호환 검사 통과. 새 제품 의존성 없음 |

전체 단위 시험 뒤에는 테스트 fixture의 비-null 단언 정리, 기존 태그 parser와 태그 연결만 변경하고 해당 53개를 재실행했다. 마지막 core 수정이 브라우저의 in-process runtime에도 포함되도록 Studio를 다시 빌드하고 D&D·연결·레이아웃·Undo·검토·접근성의 기존 Chromium 6개를 재확인했다. UI를 바꾸지 않았으며 E2E 케이스도 추가하지 않았다. 신규 제품 회귀 함수는 평가 2개·pack entry 1개·인자 고정 1개뿐이며 OS probe의 opt-in 실행 연결 1개를 별도로 두었다.

로그는 작업 중 임시 증거에 남겼다. 일반 CI/이번 실행에 유료 모델·검색 호출은 없다. 실제 모델 품질·다른 OS·전체 release gate·새 후보의 hosted CI·배포는 검증하지 않았다. 모든 임시 Git/DB/browser/프로세스는 테스트 소유 범위다. 커밋·PR 생성·병합은 하지 않았다.

## 출처

- [CR-025](../change-requests/CR-025-harness-safety.md), [CR-034](../change-requests/CR-034-builtin-skill-packs.md), [CR-036](../change-requests/CR-036-quality-evaluation.md).
- [bubblewrap 공식 경계 설명](https://github.com/containers/bubblewrap#sandbox-security). 실제 명령 옵션은 설치된 0.13.1의 `bwrap --help`와 대조했다.
- [leeskills 고정 manifest](https://github.com/fromiron/leeskills/blob/1472032c0521c7f76f8811973b4cbe6b67804988/manifest.json), [라이선스](https://github.com/fromiron/leeskills/blob/1472032c0521c7f76f8811973b4cbe6b67804988/LICENSE).
