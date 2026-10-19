# CR-037: 프로필 컨텍스트와 압축 정책

- 상태: **구현 승인** — Bell, 2026-10-19: “프로필 컨텍스트 설정과 런타임 구현까지 모두 포함”.
- 기준: `3236759`. 첨부 제안과 현재 작업 브랜치를 대조하며 Pi 1.3.0을 사용한다.
- 추적: C-120, CRL-CONTEXT-001, TC-CONTEXT-001-H/N.

## 설정과 해석

프로필에 optional `contextWindow`, `compaction.reserveTokens`, `compaction.keepRecentTokens`를 추가한다. 빈 UI 입력은 생략하며 0은 명시값이다. 안전한 정수만 허용한다(C: 1~10,000,000, R/K: 0 이상). 숫자 문자열/null/소수/NaN/Infinity는 설정에서 거절한다. UI용 행 identity와 metadata는 API에 저장하지 않는다.

컨텍스트 우선순위는 프로필 명시값 → 해당 endpoint 모델의 명시값 → 같은 provider/model 카탈로그 → 해당 연결의 기존 fallback이다. 정규화된 fallback과 명시값을 구분한다. 미등록 모델을 숫자 설정만으로 등록하지 않는다. 압축 기본 R=16,384, K=20,000을 유지하고 자동 clamp/비례값은 추가하지 않는다.

명시 정책은 해석 후 R<C, K<C-R을 요구한다. 기존 무오버라이드는 Pi 기본 경로를 보존하며 이 관계를 만족하지 않아도 실행/다른 설정 저장을 일괄 거절하지 않고 경고한다. 모든 오버라이드를 지우면 이 호환 경로로 돌아간다. 예: C=32,000/R=16,384/K=20,000은 기본 호환 경고이며 새 명시 정책으로는 거절한다.

유효값은 C/R/K·각 출처·설정 revision·바탕 모델 한도를 함께 제공한다. R이 다음 요청 출력 한도보다 작은 경우, C가 바탕 모델보다 큰 경우 경고한다. 이는 Corral 계산값이며 실제 공급자 한도를 늘리거나 요청 성공을 보장하지 않는다.

## 실행과 저장

자동 선택의 최초 모델 호출 전에 프로필별 정책을 고정하고 Run 모델 snapshot에 기록한다. 이후 역할·하위 에이전트·재시도/지원 재개는 같은 값과 provider/model 바인딩을 사용한다. 대기열은 실제 Run 생성 시 고정한다. 과거 snapshot이 없으면 현재 설정으로 과거 값을 추정하지 않는다. 실행 중 컨텍스트 변경 경로는 추가하지 않는다.

공통 해석/검증 → Run snapshot → AgentStartInput → adapter → 버전별 IPC → worker로 전달한다. SDK의 원래 모델과 proxy 모델에 같은 C를 적용하며 공유 카탈로그 객체는 복사한다. SettingsManager.inMemory에 R/K를 전달하고 다른 설정을 유지한다. legacy worker의 압축 미지원은 명시하며 조용히 적용된 것처럼 표시하지 않는다. 버전 불일치는 명시 거절한다.

Pi의 임계 비교 `estimatedContextTokens > C-R`와 메시지/도구 경계 처리를 유지한다. R=0은 압축 끄기가 아니며 K=0은 모든 원문 삭제를 보장하지 않는다. 자동/수동/overflow 압축은 같은 purpose/permit/예산/취소/기록 경로를 사용한다. 요약의 최종 maxTokens는 기존 Corral permit 우선 정책을 유지한다. R을 일반 출력 토큰 편집값으로 설명하지 않는다.

credentialPaths는 `modelProfiles[*].compaction` 아래 정확한 숫자 R/K 필드만 예외로 둔다. 다른 경로/문자열/객체의 token 키는 계속 거절하고 오류에 값을 노출하지 않는다. 초안을 연 revision을 저장까지 유지한다. 충돌·검증 실패는 파일 바이트와 실행 설정을 바꾸지 않으며 다른 설정 키는 원자 저장으로 보존한다.

## UI와 검증

프로필 편집에서 저장값·유효값·기본 출처·추정 압축 임계점을 구분한다. endpoint 모델 ID 편집을 유지하며 편집 행의 원본 metadata를 보존해 endpoint ID 변경에도 같은 모델의 name/contextWindow/maxOutput/reasoning 등이 사라지지 않게 한다. 새 행이 삭제한 행의 metadata를 상속하지 않는다.

필요한 실패 시험으로 숫자/관계/credential 경계·기본 호환·충돌 시 파일 불변·Run A/B snapshot·SDK/legacy 전달과 객체 비오염·T-1/T/T+1·R=0 최종 stream cap·취소/예산을 검증한다. 브라우저 저장/재열람과 경고/출처를 확인한다. 유료 호출·출력 상한 변경·압축 알고리즘 포크·프로젝트별 스위치·Ultra 라우팅 재설계는 범위 밖이다.
