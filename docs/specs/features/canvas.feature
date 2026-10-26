Feature: Canvas — 사용자가 정의를 만든다

  Scenario: 빈 캔버스에서 만든 연결대로 실행된다
    Given 빈 캔버스가 열려 있다
    When Agent 두 개와 Output을 드롭하고 순서대로 연결한다
    Then 실행 순서가 연결 순서와 같아야 한다
    When 두 Agent의 순서를 바꿔 다시 연결한다
    Then 실행 순서도 바뀌어야 한다

  Scenario: 레이아웃 이동은 정의 revision을 바꾸지 않는다
    Given 저장된 Corral이 있다
    When 노드와 Loop 영역을 움직이고 저장한다
    Then layoutRevision만 올라가고 definitionHash와 definitionRevision은 그대로여야 한다
    When 역할 프롬프트를 바꾸고 저장한다
    Then definitionRevision이 올라가야 한다

  Scenario: 제어 연결과 위임·질문 허용 관계를 구별한다
    Given Research와 callable Helper가 있다
    When Research에서 Helper로 delegate link를 만든다
    Then 그 선은 control edge와 다른 모양으로 보여야 한다
    And compiler는 Helper를 실행 순서에 넣지 않아야 한다

  Scenario: 잘못된 정의는 실행 전에 막히고 위치가 표시된다
    Given Loop 본문 밖의 노드가 본문 안 노드로 직접 연결되어 있다
    Then 실행 버튼은 비활성이어야 한다
    And 문제 목록의 항목을 누르면 해당 연결로 이동해야 한다
    When 존재하지 않는 role을 참조하는 JSON을 가져온다
    Then 가져오기가 오류로 거절되어야 한다

  Scenario: 되돌리기, 복제, 키보드 연결, IME
    When 노드 하나를 한 번 드래그한 뒤 되돌리기를 누른다
    Then 노드는 드래그 전 위치로 돌아가야 한다
    When 노드를 복제한다
    Then 새 노드는 기존과 겹치지 않는 ID를 가져야 한다
    When 포인터 없이 키보드로 두 노드를 연결한다
    Then control edge가 생겨야 한다
    When 노드 이름을 한국어 IME로 입력하며 조합 중 Enter를 누른다
    Then 아무 명령도 실행되지 않아야 한다
