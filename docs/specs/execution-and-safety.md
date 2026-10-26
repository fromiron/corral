# 실행과 안전 경계

이 문서는 승인된 실행 경계를 찾는 기준 요약이다. 지원·검증되지 않은 경로를 문서 정리만으로 활성화하지 않는다.

## 명령·효과·기록

명령은 기존 admission·Coordinator·영속 기록·projection 경로를 통과한다. HTTP 접수, worker 전달, 효과 실행, 실제 종료와 Run 완료는 별개다. 재전송은 원래 command ID·내용·revision 계약을 유지하며, 결과가 불명확한 효과를 자동 재실행하지 않는다.

취소·patch·승인은 원래 Run, 실행 시도, scope, revision과 대상 hash를 확인한다. 늦은 응답은 원래 소유자에만 반영한다. 과거 snapshot·산출물·검사 결과를 현재 상태로 덮어쓰지 않는다.

호출 전 permit과 공유 예산을 확인한다. UI·worker·하위 agent가 자체 예산이나 완료 원장을 만들지 않는다. 새 기능·스킬 선택은 비용 상한 자동 증가나 권한 확대의 근거가 아니다.

## 동시성과 파일

ABS-06은 고정 snapshot reader 병행과 작업 사본별 단일 writer를 승인한다. 모든 시작 입구의 admission, host 전체 모델·worker·process 상한, `(hostId, runId)`별 제어·SSE·예산·자료 소유를 함께 유지한다. 같은 작업 사본의 동시 writer는 허용하지 않는다.

초기 스펙과 통합 계획의 전역 활성 Run 하나라는 설명은 이 후속 범위의 현재 계약이 아니다.

작업 폴더 연결·신뢰·관리 사본·검토·원본 적용은 별개의 경계다. 파일 diff를 보거나 검토 체크를 했다는 이유만으로 원본 적용을 승인하지 않는다. 대상 tree가 바뀌면 검증·검토의 유효성을 다시 확인한다.

이 단일 writer 경계를 사용자 작업으로 확장한다. 사용자 operation은 Run과 구분한 owner/receipt를 가지며 공통 예약을 사용한다. 사본 generation과 요청 hash를 확인하고 재시작/불확실 효과를 자동 재실행하지 않는다. 명시적 공유 개발은 하나의 development writer 아래 허용된 사람 효과만 공유한다. 소유된 디버깅은 이 범위에 포함하며 agent writer·PTY·구조 변경·배포는 차단한다. 배포는 검토한 소스에 대한 strict writer를 사용하고, 외부 결과를 확인하지 못한 상태에서 자동 재배포하지 않는다. 재시작 시 uncertain이고 자동 재개하지 않는다. 상세는 [현재 Workbench](workbench.md#공유-개발-모드)를 따른다.

## 명령·편집·미리보기

일반 명령·service는 실제 관리 사본, Coordinator 승인·effect·예산, 소유 프로세스 lease를 사용한다. `run_check`의 등록 argv·고정 검증 사본과 혼동하지 않는다. Hashline은 버전 있는 명시 선택 방식이며 기존 Pi edit의 자동 대체가 아니다.

산출물 HTML의 script 비활성 격리 preview와 관리 service의 browser preview는 다르다. 후자는 service·process·port/연결 소유권과 취소·폐기 계약을 따른다. 기능 이름이 같다는 이유로 전자의 CSP를 완화하지 않는다.

## 재접속·복구와 비밀

살아 있는 실행에 재접속하는 것, 기록을 재열람하는 것, 체크포인트로 새 Run을 시작하는 것과 효과를 자동 replay하는 것은 다르다. 재시작 후 불확실한 효과·미정산 비용을 성공이나 미실행으로 임의 확정하지 않는다.

credential·원시 사용자 본문·내부 경로를 공개 이벤트·export·알림·로그에 노출하지 않는다. 모델·웹·Skill·다른 역할의 출력은 권한을 바꾸는 명령이 아니다. 설정과 native 확장 신뢰는 각각 해당 owner의 명시 계약을 따른다.

상세 전이·오류는 [기술 설계](technical-design.md)와 [API 계약](api-contract.md), 일반 개발 규칙은 [AGENTS.md](../../AGENTS.md)를 확인한다.
