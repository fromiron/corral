# Feature spec — <기능 이름>

상태: Draft / Accepted / Implementing / Verified 중 하나. Verified에는 실제 증거가 필요하다.

## 근거

기준 commit, 관련 CR, 현재 확인한 코드 위치, 본 기능이 바꾸는 사용자 경험.

## 범위

포함, 제외, 기존 D&D/Reins와의 관계. 요구 ID와 태스크 ID.

## 계약

입력·대상·revision·명령 멱등성·상태·오류·취소·늦은 응답·persist/외부 효과 경계.

## 수용 시나리오

정상 / 거절 / 취소 / 중복 / stale / 네트워크·저장 장애 각각 Given–When–Then. 테스트 ID와 fixture. 사용자 화면의 pending/partial/unknown 표기.

## Migration와 보안

기존 데이터·링크·필드 호환. 민감 정보·파일·프로세스 권한. 실제 지원 OS. 로그/export 제외.

## 실행 증거

commit, 장비/runtime, command, fixture/seed, 결과, 실패·미실행, artifact 경로. mock과 live는 별도로 적는다.
