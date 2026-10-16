# CR-WB-001 — 지속 작업·결과 검토 경험으로 확장

상태: **제안**, 미승인·미구현. 제안용 ID이며 저장소 적용 전 기존 CR 체계와 충돌을 확인한다.

## 배경

현재 Corral은 정의와 Run·텍스트 산출물 중심이다. 사용자는 프로젝트별 지속 세션과 파일 경로+diff, 상용 수준의 검토·후속 작업 경험을 요청했다. 기존의 D&D·Reins·협업을 제거하는 방향이 아니다.

## 변경

1. Project와 WorkSession을 사용자 작업 탐색 단위로 추가.
2. 실제 작업 폴더를 WorkspaceBinding으로 분리.
3. 단일 출력 UI를 RunResult/ResultRevision으로 확장.
4. 불변 파일 기준·변경 출처·검증과 diff review 제공.
5. 피드백 batch를 기존 Reins 또는 새 후속 Run으로 연결.
6. managed worktree에서만 초기 파일 쓰기를 허용하고 원본 반영·역변경을 별도 명령으로 도입.

## 기존 합의와의 관계

D&D·실시간 개입·최초 실행 버전 고정·앞방향 patch·단일 실행 상태 확정을 보존한다. 기존 MVP에서 제외한 코딩 작업·파일 쓰기는 이번 후속 개선에서 새로 여는 범위다. graph live 구조 변경·다중 사용자·자동 라우팅은 이 CR의 의존 조건이 아니다.

## 상세 명세와 완료 조건

01-Improvement-Spec, 02-UX-Spec, 03-Technical-Design과 requirements.json을 따른다. SDD·TDD 작업과 수용 테스트는 04-Implementation-Plan과 05-Test-Plan에 연결된다. 실제 파일 쓰기는 U2 안전 gate를 통과한 환경에서만, 원본 반영은 U3 gate를 통과한 뒤 제공한다.

## 소유자 검토 사항

제안 기본값은 기존 폴더 관측/별도 worktree 쓰기, 단일 활성 Run 유지, 구조 live editing 제외, session별 전체 결과·diff feedback·명시 원본 반영이다. 변경하려면 해당 acceptance test와 migration·security contract를 함께 수정한다.
