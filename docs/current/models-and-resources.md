---
kind: reference
status: current
baseline: 373764467a52a7c6978de1272ac8253c73a27077
---

# 모델·추론·리소스

연결 방법·프로필 설정·호환 엔드포인트·Ultra·컨텍스트의 상세 사용 계약은 [모델 안내](../Models.md)에서 관리한다. 이 문서는 경계와 관련 자료를 연결하며 모델 목록이나 설정 필드 전체를 복제하지 않는다.

## 연결과 요청 설정

실제 연결은 사용자가 완료한다. 카탈로그에 모델이 있다는 것, credential이 설정되었다는 것, 특정 capability가 검증되었다는 것, 실제 외부 요청이 성공했다는 것을 구분한다. 키를 계획·채팅·Corral 정의·이벤트·공개 export에 넣지 않는다.

프로필 설정과 실제 Run snapshot을 구분한다. 저장 revision·적용 scope를 확인하고 변경을 실행 중인 Run에 소급하지 않는다. 추론 판정의 관찰과 요청 적용은 [CR-021](../change-requests/CR-021-role-reasoning-apply.md) 및 해당 모델 계약으로 구분한다. 초기 관찰 전용 설명을 모든 후속 경로의 제한으로 사용하지 않는다.

공급자 SDK의 일반 지원과 Corral에서 검증한 인증·도구·추론 매핑은 같지 않다. 새 연결을 추가할 때 어댑터·취소·usage·compatibility 시험을 확인한다. 샘플 모델명이나 과거 조사표를 최신 지원 목록으로 복제하지 않는다.

## 복수 모델 Ultra

현재 모델 안내는 서로 다른 모델 2~5개와 검토·판정 모델 선택, 모델별로 검증된 최고 추론 단계, 불변 Run snapshot을 설명한다. 같은 회사의 다른 모델도 가능하나 같은 모델의 프로필 별칭 두 개를 서로 다른 모델로 세지 않는다. 새 요청은 [CR-048](../change-requests/CR-048-ultra-candidate-tournament.md) version 2다. 작업 사본과 Linux 격리가 있으면 격리 후보 경쟁·검사 통과 후보의 익명 판정·우승 사본 고도화·확인 없는 자동 반영을 하고, 없으면 협업 방식으로 실행한다. version 2에는 Corral 사용량 한도가 없고 사용자 취소만 정지 수단이다. version 1 기록은 기존 의미를 유지한다.

Ultra를 초기의 단일 모델 후보 비교로 되돌리지 않는다. 일반 모드의 추론 설정을 덮지 않으며, 미연결 모델·확인되지 않은 최고 추론 매핑을 임의 fallback으로 숨기지 않는다. 모델 검토 통과는 프로젝트 테스트 통과가 아니다. 정확한 상한·요청 필드는 모델 안내와 현재 계약·코드를 함께 확인한다.

## 내장팩·Skill·확장

`apps/server/resources/builtin/`는 개발 조사 문서가 아니라 제품 리소스다. 설치, 신뢰, 바인딩, 본문 전달, 실제 수행과 평가 통과는 서로 다른 상태다. 리소스 선택 자체는 native 코드 실행이나 권한 확대의 허가가 아니다.

내장 design Skill의 [NOTICE](../../apps/server/resources/builtin/design/NOTICE.md)는 고정 upstream과 복사 범위를 기록한다. 이 고지와 LICENSE를 문서 정리 대상으로 제거하지 않는다. 업데이트·rollback은 기존 버전·hash·신뢰 경계를 보존한다.

## 의존성과 출처

설치 버전은 각 package.json과 pnpm-lock, 검사 입력은 [dependency lock](../dependency-lock.json)을 확인한다. 과거 외부 제품·버전 조사는 기본 읽기 경로가 아니다.

실제 차용물 고지는 [THIRD-PARTY-NOTICES](../../THIRD-PARTY-NOTICES)에 유지한다. 외형이 바뀌었다는 이유만으로 코드·본문의 차용 관계가 사라졌다고 판단하지 않는다. 전체 외부 provider·OS 검증 여부는 해당 후보의 [검증 기록](../evaluation/README.md)으로 확인한다.
