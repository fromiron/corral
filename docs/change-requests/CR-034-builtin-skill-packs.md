# CR-034: 내장팩과 명시적 활성화

- 상태: **순차 구현 승인** — Bell, 2026-10-19: “플랜대로 M0부터 순서대로 개선 진행해. CR 등록 → 실패 테스트 → 구현 순서로 하고, 기존 기능 회귀도 확인해.”
- 계획: [통합 개선 실행 계획](../plans/Corral-Improvement-Execution-Plan-2026-10-19.md), M0-5, M1-4, M2-3.
- 기준: `780591e`(PR #60 수정 포함). 구현/검증 완료 여부는 단계별 증거로 따로 기록한다.
- 추적: M0는 C-091, CRL-BPACK-001, TC-BPACK-001-H/N. 활성화/UI는 M1/M2에서 확장.

## 계약

1. CR-018/022의 resource hash·불변 revision·신뢰·바인딩·실행 복사를 재사용한다. Core 5개·Coding 3개·leeskills 10개와 참조/NOTICE를 콘텐츠로 배포한다.
2. leeskills 기준은 1472032c0521c7f76f8811973b4cbe6b67804988이다. 전체 배포와 전체 주입은 다르다. 첫 선택은 명시 binding/recipe와 정적 매칭이며 별도 유료 router를 만들지 않는다.
3. sibling/reference는 승인된 entry 간 매핑으로 해결한다. 미바인딩 entry·symlink·경로 탈출·동명 충돌·누락/변조를 거절한다. 목록/선택/본문 전달/절차 준수를 구별한다.
4. Core/Coding은 Corral 전용 절차로 작성하며 Superpowers 실행기/자동 CLI/worktree 절차를 가져오지 않는다. 전문팩은 stack/version에 맞게 opt-in하고 원격 지침도 고정한다.
5. 상세 디자인 보고서와 최종 review JSON을 구별한다. targeted-pass를 출시 pass로 승격하지 않고 AI 위임과 사용자 선택 provenance를 보존한다.

## 검증과 배포

새 동작과 데이터·권한·취소 경계의 대표 반례만 구현 전에 실패를 확인한다. 기존 통합 시험을 우선 확장하며 문구·내부 함수·모든 조합을 따라가는 시험은 추가하지 않는다. 적용되는 정상·실패·취소·중복·늦은 이벤트 경계는 기존 시험과 합쳐 확인한다. D&D·Reins·과거 snapshot/hash·전역 활성 Run 제한을 유지한다. live/OS/브라우저 증거는 결정적 fixture와 구별한다.


## C-097 적용 계약

내장 콘텐츠는 server 패키지의 resources에 포함하여 데스크톱 배포에도 같은 파일을 사용한다. Core 5개·Coding 3개·고정 leeskills 10개를 기존 review → install → trust → profile entry 선택 경로로 제공한다. 전체 콘텐츠를 배포하되 현재 프로필에 선택한 entry만 읽고 전달한다. sibling 링크는 현재 bound entry로의 안전한 가상 경로를 안내하며 `..` 경로 검증을 완화하지 않는다. Pi core에서 리소스 기능을 가장하기 위해 SDK로 자동 전환하지 않는다.

## C-103 보고서 연결

최종 ReviewArtifact에 선택 `design` 참조를 추가한다. 상세 leeskills 보고서와 토큰 제안은 별도 불변 artifact version이며 최종 제출은 정규화한 review JSON 하나다. adapter는 scope/필수 check 결과/참조와 선호 출처를 검사한다. 이것을 upstream 전체 schema validator, 실제 브라우저 테스트나 출시 승인으로 표시하지 않는다. Python validator는 기존 등록 check로 실행할 수 있고 Python이 없으면 자동 설치하지 않는다.

검증 범위가 release인 요청에 targeted 보고서의 pass를 제출하면 inconclusive다. 사용자 선택은 같은 Run의 실제 answered 질문/답 ID에 연결하며 AI 위임을 사용자가 구체값을 선택한 것으로 표시하지 않는다. 템플릿은 현재 초안에 지침을 추가할 뿐 profile/도구/작업 범위를 바꾸지 않는다. 전문팩은 기존 명시 설치/고정 revision 경로로 선택하며, 특정 기술 스택이 정해지지 않은 실행에 Vercel/Anthropic 팩을 자동 번들/활성화하지 않는다.

고정 upstream design 콘텐츠는 원문 hash를 유지하기 위해 저장소 Biome 재포맷 대상에서 제외한다. 이 제외는 해당 vendor 디렉터리에만 적용하며, manifest/hash/reference closure와 런타임 신뢰 검사는 계속 수행한다.
