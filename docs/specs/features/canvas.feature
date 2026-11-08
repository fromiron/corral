Feature: 팀 편집기 — 사용자가 정의를 만든다

  Scenario: 빈 팀에서 만든 연결대로 실행된다
    Given 빈 팀 편집기가 열려 있다
    When 에이전트 두 개를 차례로 추가하고 마지막 에이전트 뒤에 출력을 추가한다
    Then 실행 순서가 추가한 순서와 같아야 한다
    When 두 번째 에이전트를 지우고 첫 에이전트와 출력 사이에 새 에이전트를 끼운다
    Then 실행 순서도 바뀌어야 한다

  Scenario: 놓는 자리가 구조를 정한다
    Given 에이전트 A에서 B로 이어진 팀이 있다
    When 검토를 A와 B 사이의 연결 위에 놓는다
    Then A, 검토, B 순서로 이어지고 원래 연결은 사라져야 한다
    When 출력을 A 위에 놓는다
    Then 출력은 A의 갈래로 붙어야 한다
    When 에이전트를 출력 위에 놓는다
    Then 이유와 함께 거절되고 정의는 바뀌지 않아야 한다

  Scenario: 저장과 복제는 정의 hash를 지킨다
    Given 저장된 팀이 있다
    When 아무것도 바꾸지 않고 저장한다
    Then definitionRevision은 그대로여야 한다
    When 역할 프롬프트를 바꾸고 저장한다
    Then definitionRevision이 올라가야 한다
    When 팀을 복제한다
    Then 사본은 새 ID와 첫 revision을 가지고 원본은 바뀌지 않아야 한다

  Scenario: 감싸기와 풀기
    Given A, B, C가 이어진 팀이 있다
    When B를 Loop로 감싼다
    Then A는 Loop의 enter로, Loop의 본문은 B로, B는 exit으로, Loop의 next는 C로 이어져야 한다
    And compiler는 상자 경계 위반을 보고하지 않아야 한다
    When 그 Loop를 지운다
    Then A, B, C가 다시 이어지고 B는 맨 위에 있어야 한다

  Scenario: 선택에 검토 루프 패턴을 적용한다
    Given A에서 B로 이어진 팀에서 A를 선택했다
    When 검토 루프로 감싸기를 고른다
    Then Loop 안에서 A, 검토 에이전트, 검토 판정이 이어져야 한다
    And 판정의 pass는 Loop의 exit으로, revise는 repeat으로 가야 한다
    And Loop의 next는 B로 가야 한다
    And 승인 단계는 생기지 않아야 한다

  Scenario: 앞 단계가 없는 단계는 병렬로 나누지 않는다
    Given 시작 에이전트 A 하나뿐인 팀이 있다
    When A에 병렬로 나누기를 고른다
    Then 이유와 함께 거절되어야 한다

  Scenario: 제어 연결과 호출 링크를 구별한다
    Given Research와 호출 전용 Helper가 있다
    When Research에서 Helper로 위임 링크를 만든다
    Then 그 선은 점선과 이름표로 보여야 한다
    And compiler는 Helper를 실행 순서에 넣지 않아야 한다
    And 입력 출처 목록에는 Helper가 나오지 않아야 한다

  Scenario: 잘못된 연결은 끄는 동안 거절된다
    Given Loop 안에 A와 B가 이어져 있다
    When B의 출력 포트를 A로 끈다
    Then A가 거절 표시되고 순환이 생긴다는 이유가 포인터 옆에 보여야 한다
    When 놓는다
    Then 정의는 바뀌지 않아야 한다

  Scenario: 문제 목록에서 위치로 이동한다
    Given 연결되지 않은 판정 갈래가 있는 팀이 있다
    Then 판정 노드에 경고 기호가 보여야 한다
    When 구조 목록의 문제 수를 누르고 그 문제를 고른다
    Then 판정 노드가 선택되고 화면 안에 보여야 한다

  Scenario: 되돌리기, 키보드, IME
    When 연결 위에 단계를 끼운 뒤 되돌리기를 누른다
    Then 원래 연결 하나로 돌아가야 한다
    When 포인터 없이 설정 시트의 연결할 곳 목록으로 두 단계를 잇는다
    Then control edge가 생겨야 한다
    When 단계 이름을 한국어 IME로 입력하며 조합 중 Enter를 누른다
    Then 아무 명령도 실행되지 않아야 한다
