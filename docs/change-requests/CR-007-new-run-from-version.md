# CR-007: 이전 버전에서 새 Run 시작

- 변경 ID / 제안자 / 날짜: CR-007 / Claude(초안) / 2026-10-16
- 상태: **승인**(로드맵 9번. Bell의 /goal 지시 "제안한 개선·강화 플랜 끝까지 구현"에 포함된 항목. 2026-10-16)
- 연결 문서: 스펙 §3.2(제외 범위), §7.4(산출물), §10.1(재열람), Technical-Design §9.2(버전 바인딩)

## 기존 문구

- 스펙 §3.2: "임의 시점의 외부 작업 재실행", "과거 산출물의 직접 수정"은 MVP 제외.
- Technical-Design §9.2: 바인딩은 같은 Run 안의 버전만 가리킨다(`explicit_version`도 같은 Run).
- 끝난 Run의 결과를 이어서 다듬으려면 사람이 텍스트를 복사해 새 Run의 브리프에 붙여야 한다.

## 제안

1. **새 Run, 복사한 시작점.** 끝난(또는 진행 중인) Run의 산출물 버전 하나를 골라 같은 Corral로 새 Run을 시작한다. Coordinator는 그 버전의 본문을 원래 Run의 기록에서 읽어 새 Run의 브리프 뒤에 정해진 형식으로 붙인다. 형식은 "Start from this earlier version" 머리말과 출처 줄, 그리고 본문이다. 새 Run은 다른 Run의 버전을 **참조하지 않는다**. 실행 중에는 자기 입력만 쓴다.
2. **출처 기록.** `run.started`에 `startedFrom: { runId, artifactVersionId }`를 남긴다(선택 필드). Run 화면은 "Run X의 draft v2에서 시작"과 원래 Run 링크를 보인다. 출처는 클라이언트가 보낸 텍스트가 아니라 Coordinator가 읽은 기록으로 정한다.
3. **명령.** `CreateRunRequest`와 `StartRunRequest`에 선택 필드 `startFrom: { runId, artifactVersionId }`를 더한다. 다음 경우는 `TARGET_NOT_FOUND`로 거절한다:
   - 없는 Run.
   - 그 Run에 없는 버전.
   - 본문을 읽을 수 없는 버전.
4. **크기.** 붙인 본문은 새 Run의 산출물 크기 한도(`maxArtifactBytes`)를 넘을 수 없다. 넘으면 `LIMIT_REACHED`로 거절한다.
5. **화면.** 산출물 보기에 "이 버전에서 새 Run"을 둔다. 대화상자는 원래 브리프(수정 가능)와 함께 "이 버전의 본문이 브리프에 붙습니다"를 보이고, 모드(모의/실제)를 고른 뒤 시작한다.

## 이유

결과를 한 번 더 다듬거나 다른 모델·기준으로 이어 가는 일이 잦다. 본문을 복사해 새 Run의 입력으로 쓰면 다음 두 가지가 그대로 지켜진다:
- 같은 Run 안에서만 버전을 묶는다는 규칙(§9.2).
- 과거 산출물은 바꾸지 않는다는 규칙(§3.2).

## 기존 합의와 충돌

없음. 과거 Run의 작업을 다시 실행하거나 과거 산출물을 수정하지 않는다. 새 Run은 일반 Run과 같은 검증·한도·기록을 거친다. 계약에 선택 필드 두 개가 늘어난다(이전 이벤트·명령과 호환).

## 테스트

- 원래 Run의 버전 본문이 새 Run 브리프에 붙고, `run.started.startedFrom`이 남으며, 새 Run의 에이전트 첫 요청에 그 본문이 들어간다.
- 다른 Run의 버전 id, 없는 Run, 너무 큰 본문은 거절하고 새 Run을 만들지 않는다. 원래 Run의 기록은 바뀌지 않는다.
- 서버 HTTP와 브라우저 runtime이 같은 결과를 낸다.
- E2E: 산출물 보기 → 이 버전에서 새 Run → 새 Run 화면에 출처 링크.

## 일정·영향

새 의존성 없음. contracts(명령·이벤트 선택 필드, JSON Schema 재생성), core(Coordinator 시작 경로), server·client(전달), react·Studio(버튼·대화상자·출처 표시)가 바뀐다.

## 진행 결과 (2026-10-16)

- 구현:
  - `StartFrom` 계약(`StartRunRequest`·`CreateRunRequest.startFrom`, `run.started.startedFrom`).
  - `Coordinator.startFromVersion`: 원래 Run 기록에서 본문을 읽고 크기를 확인한 뒤 브리프 뒤에 붙인다.
  - projection `startedFrom`.
  - 화면:
    - 실행 결과 아래 "이 결과에서 새 Run".
    - 산출물 보기의 "이 버전에서 새 Run".
    - Run 버튼 위 시작점 안내와 "지우기".
    - Run 화면 요약의 "시작점" 링크.
    - Run 화면에서 고르면 편집기를 `?fromRun=&fromVersion=`으로 열어 같은 안내를 보인다.
- 요구·테스트·태스크: CRL-ART-005, TC-ART-005-H/N, C-074.
- 테스트:
  - core 2: 복사·출처·원래 기록 불변; 없는 Run·다른 Run의 버전·크기 초과(저장소를 공유한 다른 설치 한도) 거절.
  - E2E 2: 결과에서 새 Run → 출처 링크; 지우기 후에는 출처 없음.
  - 서버와 브라우저 runtime은 같은 Coordinator 경로를 쓴다.
