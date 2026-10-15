# 예제의 실행 의미

`research-team.corral.json`은 저장 정의의 예시다. **이 팩에는 실제 Corral 실행기나 설치 가능한 CLI가 없다.** JSON Schema와 일부 참조/연결의 정적 검사만 수행했다.

제어 흐름: Research → Loop(Writer → Reviewer → Decision) → Approval → Output.

동적 관계: Research→Helper 위임, Writer→Responder 질문, Responder→Helper 위임. Responder는 Research와 같은 역할을 쓸 수 있지만 별도 callable node이므로 미래 설정 패치의 대상은 각각 다르다. callable 노드는 제어 그래프 순서로 자동 실행하지 않는다.

Review Decision의 `revise`는 Loop.repeat, `pass`는 Loop.exit에 연결된다. Loop.next로 나오는 draft는 마지막으로 통과한 iteration의 Writer 제출 버전이다. Approval의 reject는 Run 사용자 반려 종료의 내장 결과이며 Output으로 연결하지 않는다. review `inconclusive`는 사용자 확인으로 정지하는 내장 결과다.

`commands.json`은 명령 모양의 독립 예시이며, 10개를 그대로 순서대로 실행하면 모두 성공한다는 뜻이 아니다. 대상 instance·revision·approval 상태를 먼저 충족해야 한다. schema 통과는 그 precondition 충족을 증명하지 않는다.

모든 model profile은 자리표시 이름이다. 실제 모델명·키를 이 파일에 넣지 않고 server ModelRegistry에서 해석한다. `review-pass.json`도 실제 모델 평가 결과가 아닌 fixture다.
