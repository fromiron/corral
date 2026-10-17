# CR-019: broker 코딩 도구·자동 검증·제한된 개선 (R2)

- 상태: 채택·구현 중, 2026-10-18. Bell의 H2–H8 구현 계속 요청.
- 기준: 개인 하네스 구현 플랜 H4–H6, CR-018, CR-012·013.
- Pi `read/edit/write`의 공개 계약을 기존 파일 broker에 연결한다. 읽은 근거는 execution별로 보관하며 다른 실행의 읽기가 쓰기 권한을 대신하지 않는다. symlink·범위 밖 경로·변경된 hash는 거절한다.
- 검증은 기존 등록 argv만 실행한다. 모델은 argv/env를 바꾸지 못한다. Run·execution·attempt·effect에 묶고, 시작 tree와 명령 fingerprint를 고정한다. 별도 검증 복사본에서 수행하며 취소는 자식 프로세스까지 정리한다.
- 검증 실행 상태와 품질 판정을 분리한다. error/cancelled/stale를 pass로 취급하지 않는다. 시간·외부 호출·ID는 주입한다.
- 검토 recipe의 기준·평가 역할·검사·시도/수정/시간/토큰 상한은 불변 revision이다. 기존 Agent→Review→Decision→Loop를 재사용한다. 동일 결과·같은 실패·상한 도달은 명시한 이유로 멈춘다.
- LSP 조회는 사용자가 등록한 서버만 실행한다. Hashline은 고정 fixture의 비교 평가 후보이며 기본 편집 방식으로 추가하지 않는다.
- 인간 승인과 원본 반영은 별도 동작이다. 자동 commit/push/deploy는 추가하지 않는다.

## 반례·완료 조건

TC-HAR-010/011: Pi 편집 계약, 변경된 읽기 근거·실행 간 혼선·경로 탈출 거절.
TC-HAR-012/013: spawn 실패, 중복 종료, 취소 후 자식 잔존, 변경된 fingerprint, stale 보고서 거절.
TC-HAR-014: 첫 시도를 포함한 상한, 기준 변경 거절, 같은 출력/실패 반복 중지, 부모 취소 후 후속 호출 없음.
일반 CI는 로컬 fixture/fake provider를 사용한다. 실제 품질·비용 개선은 opt-in 평가 없이 주장하지 않는다.
