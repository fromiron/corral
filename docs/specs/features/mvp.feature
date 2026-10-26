Feature: Corral MVP의 설계·협업·실시간 개입
  # 수용 기준 원문. 실행 가능한 테스트 코드가 아니다.

  Scenario: 실제 연결 편집이 실행을 변경한다
    Given 사용자가 빈 Canvas를 열었다
    When Agent와 Output을 드롭하고 포트를 연결한다
    And 추가 검토 Agent를 중간에 삽입하여 저장한다
    Then mock 실행은 추가 검토 단계를 거쳐야 한다
    And 레이아웃만 이동해도 definitionHash는 유지되어야 한다

  Scenario: 부모 대기가 자식 실행 슬롯을 막지 않는다
    Given 모델 동시성 한도가 3이다
    When 부모가 두 서브에이전트를 만들고 결과를 기다린다
    Then 부모는 모델 permit을 점유하지 않아야 한다
    And 자식 두 개가 병렬로 시작할 수 있어야 한다
    When 사용자 전체 취소가 확정된다
    Then 부모와 자식과 도구가 정리되기 전에는 cancelled를 표시하지 않아야 한다

  Scenario: 검토 회차의 현재 출력과 이전 입력을 구분한다
    Given 회차1의 draft@1과 review@1이 존재한다
    When 회차2 writer가 두 버전을 입력으로 draft@2를 제출한다
    Then 회차2 reviewer는 draft@2를 읽어야 한다
    And draft@1에 대한 review@1은 draft@2의 pass로 사용하면 안 된다

  Scenario: 지시 접수와 실제 요청 전달은 다르다
    Given 요청 A의 snapshot이 확정되어 실행 중이다
    When 지시 D를 접수한다
    And A가 산출물 V1을 만든다
    Then D는 아직 다음 요청 전달 대기여야 한다
    And V1에 D의 직접 적용 연결이 없어야 한다
    When 요청 B가 D를 포함해 시작한다
    And B가 V2를 만든다
    Then B와 V2에는 D의 적용 연결이 있어야 한다

  Scenario: 모델 설정은 미래 활성화에만 바뀐다
    Given Writer 실행 w1이 이미 활성화되었다
    When Writer 노드의 미래 모델 프로필을 B로 변경한다
    Then w1의 모델은 유지되어야 한다
    And 다음 Writer 활성화는 B를 사용해야 한다
    And 원본 Corral 정의와 그래프 구조는 바뀌지 않아야 한다

  Scenario: 일시정지 중 승인해도 자동 재개되지 않는다
    Given Run이 paused이며 최종 승인도 대기 중이다
    When 사용자가 특정 산출물을 승인한다
    Then Approval만 해결되고 Run은 paused여야 한다
    When 사용자가 resume한다
    Then 승인된 정확한 버전으로 다음 단계를 진행해야 한다

  Scenario: 개별 응답자 취소가 질문자를 깨운다
    Given Writer가 Research 응답 작업을 기다린다
    When 사용자가 응답 작업을 취소한다
    Then Writer에게 취소 결과가 전달되어야 한다
    And 질문은 열린 상태로 남지 않아야 한다

  Scenario: 한도 변경이 사용량을 환급하지 않는다
    Given 소환을 3회 사용했고 현재 상한은 4이다
    When 상한을 6으로 변경한다
    Then 추가 허용량은 3이어야 한다
    And 기존 사용량은 3이어야 한다

  Scenario: 승인 명령 재전송은 같은 결과다
    Given 승인 명령 C가 처리되고 HTTP 응답이 유실되었다
    When 동일 commandId와 payload를 다시 보낸다
    Then 같은 receipt가 반환되어야 한다
    And 승인 효과는 한 번만 발생해야 한다

  Scenario: 프로세스 재시작은 실행 재개가 아니다
    Given 실행 중 backend가 종료되었다
    When backend를 다시 시작한다
    Then 이전 Run은 interrupted로 표시되어야 한다
    And 저장된 effect를 외부로 재발행하면 안 된다
    And 기록 열람은 모델 키 없이 가능해야 한다
