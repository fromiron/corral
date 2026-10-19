# CR-008: 모델 화면에서 프로필과 엔드포인트 편집

- 변경 ID / 제안자 / 날짜: CR-008 / Claude(초안) / 2026-10-16
- 상태: **승인**(로드맵 14번. Bell의 지시 "문서 업데이트하고 다음 진행해", v0.2 이후 단계 표. 2026-10-16)
- 연결 문서: [CR-005](CR-005-api-keys-and-compatible-endpoints.md), 스펙 §4.1 `/settings/models`, [ADR-019](../Decisions.md)

## 기존 문구

- 스펙 §4.1: `/settings/models`는 "서버에서 해석되는 프로필, 기능·로그인/키 상태"를 보인다. 프로필은 편집하지 않는다.
- CR-005: 프로필과 OpenAI 호환 엔드포인트는 `.corral/config.json`으로만 편집한다(화면 편집은 후속).

## 제안

1. **카탈로그.** `GET /api/v1/model-catalog`는 pi-ai 내장 provider와 작업 공간의 엔드포인트 목록을 돌려준다. 항목은 다음과 같다:
   - id, 이름.
   - 쓸 수 있는 로그인 방식.
   - 모델 id·이름.

   자격 증명 상태나 키는 담지 않는다.
2. **읽기·저장.**
   - `GET /api/v1/model-config`는 현재 `modelProfiles`와 `modelProviders`를 돌려준다. 프로필을 정하지 않아 기본값을 쓰는 중이면 그 사실도 함께 알린다.
   - `PUT /api/v1/model-config`는 두 목록을 받아 다음을 검사한다:
     - 기존 `parseWorkspaceConfig` 규칙.
     - 엔드포인트 주소 규칙(CR-005).
     - 내장 provider id와 겹치지 않음.
     - 프로필의 provider가 내장 provider이거나 선언한 엔드포인트일 것.
   - 검사를 통과하면 `.corral/config.json`의 이 두 키만 바꾼다. `hardCaps`·`decisions` 등 다른 키는 그대로 둔다. 파일은 임시 파일에 쓴 뒤 이름을 바꿔 원자적으로 교체한다.
   - 동시 편집은 `revision`(파일 내용 해시)으로 막는다. 다르면 `REVISION_CONFLICT`로 거절한다.
3. **즉시 반영.** 저장하면 서버의 모델 registry가 새 프로필과 엔드포인트로 바뀐다. 이미 시작한 Run은 시작할 때 고정한 프로필 snapshot을 그대로 쓴다.
4. **키는 설정이 아니다.** 설정 본문에 키처럼 보이는 필드가 있으면 지금처럼 거절한다. 엔드포인트 주소의 origin을 바꾸면 그 엔드포인트에 저장한 키는 묶음 규칙(CR-005 §4)에 따라 더 쓰이지 않는다. 화면은 저장 전에 이를 알린다.
5. **화면.** 모델 화면의 프로필 표에서 provider·모델을 고르고 프로필을 추가·삭제할 수 있다. 엔드포인트 영역에서는 이름·주소·키 필요 여부·모델 목록을 편집한다. 저장 전에는 바뀐 점을 보이고, 서버 검사 오류는 필드 이름으로 보인다.

## 이유

프로필과 엔드포인트를 바꾸려면 지금은 JSON 파일을 손으로 고치고 서버를 다시 시작해야 한다. 상용 수준의 설정 경험에서는 화면에서 고르고 바로 쓸 수 있어야 한다.

## 기존 합의와 충돌

스펙 §4.1의 모델 화면에 편집이 더해진다. 자격 증명 격리(ADR-019)와 엔드포인트 주소·키 묶음 규칙(CR-005)은 그대로다. 쓰는 파일은 작업 공간의 `.corral/config.json`뿐이다.

## 테스트

- 카탈로그에 내장 provider와 엔드포인트가 있고 키·상태는 없다.
- 저장하면 파일의 두 키만 바뀌고 다른 키는 남는다. 이후 Run은 새 프로필로 해석하고, 진행 중인 Run의 snapshot은 그대로다.
- 다음 경우는 거절하고 파일을 바꾸지 않는다:
  - 알 수 없는 provider.
  - 내장 id와 겹치는 엔드포인트.
  - 비 loopback `http:` 주소.
  - 키 필드가 있는 본문.
  - 오래된 revision.
- E2E: 프로필의 모델을 바꾸고 저장하면 표와 live Run이 새 모델을 쓴다. 엔드포인트를 추가하면 그 프로필을 고를 수 있다.

## 일정·영향

새 의존성 없음. 서버(API·registry 재구성·파일 쓰기), client, 모델 화면이 바뀐다.

## 진행 결과 (2026-10-16)

- 구현:
  - 서버: `GET /api/v1/model-catalog`, `GET·PUT /api/v1/model-config`.
  - `writeModelConfig`: 두 키만 교체, 원자적 쓰기, 내용 해시 revision, 쓰기 전 provider 검사.
  - registry: `reconfigure`·`catalog`.
  - 모델 화면의 "모델 편집"(프로필 provider·모델 선택, 엔드포인트 추가·편집, 주소가 바뀐 키 안내, 필드 이름 오류).
- 함께 고친 점: 이미 OAuth로 로그인한 공급자에는 API 키 입력란을 숨긴다(키를 저장하면 로그인을 대신하므로).
- 테스트:
  - 서버 2: 카탈로그에 자격 증명 없음, 두 키만 바뀌고 `hardCaps` 유지, 다음 Run이 새 프로필 사용; 알 수 없는 provider·내장 이름·비 loopback http·키 필드·오래된 revision 거절, 파일 불변.
  - E2E 2: 프로필 모델 변경·로컬 엔드포인트 추가 후 새로고침해도 유지; 잘못된 주소는 필드 이름으로 거절.
  - 결과: 전체 단위 테스트 584 통과, 서버 E2E 18 통과.

## 2026-10-19 저장 충돌 수정

Bell이 엔드포인트 저장 시 `the config changed since it was read`를 보고했다. 같은 페이지의 로컬 추론 적용 설정도 같은 config 파일을 변경하지만 모델 편집기의 revision은 갱신되지 않는 경로를 재현한다.

- 파일 전체 revision과 서버의 동시 저장 거절은 유지한다. 모델 편집기는 편집 시작 시의 모델/엔드포인트를 고정한다. 저장 직전 최신 모델 항목이 그 기준과 같을 때만 최신 revision으로 저장하며, 실제 모델 변경이면 입력을 보존하고 충돌을 안내한다.
- GET의 모델 항목과 revision은 같은 디스크 내용을 읽은 결과여야 한다. 메모리의 과거 모델 설정에 현재 파일의 revision을 붙이지 않는다.
- 모델 저장 뒤 추론 설정도 최신 revision을 읽는다. auth/라우트 재조회가 편집 중인 draft의 기준 revision을 몰래 바꾸지 않는다.
- 필요한 실패 시험은 추론 적용 변경과 엔드포인트 저장의 양방향 순서, 실제 동시 모델 변경/입력 보존, 외부 파일 변경의 GET snapshot이다. 실제 API 키나 유료 모델 호출은 사용하지 않는다.

### 수정과 검증 결과

- `model-revision-browser-red2.log`: 추론 적용을 변경한 다음 Hive 엔드포인트 저장이 200 대신 409로 거절됐다. `model-revision-browser-red.log`의 별도 동시 편집 시나리오는 auth loader 갱신 뒤 과거 draft를 저장해 충돌 안내 없이 닫히는 문제를 재현했다. 첫 checkbox 시험은 비동기 controlled 상태를 즉시 검사하는 방식 때문에 실패하여 response/최종 상태를 기다리도록 수정한 뒤 실제 409를 확인했다.
- `model-revision-server-red.log`: 외부에서 수정한 모델 대신 메모리의 예전 모델을 현재 파일 revision과 함께 반환하는 실패를 재현했다.
- 모델 편집 기준을 mount 시점에 고정하고 저장 직전 최신 모델 항목과 비교한다. 다른 설정만 바뀌었다면 최신 revision으로 저장하며 실제 모델 변경은 입력을 보존하고 안내한다. 조회와 저장 사이의 경합은 기존 서버 revision 검사로 거절한다. 저장 중 입력/취소도 잠가 제출 이후 입력을 버리지 않는다.
- config GET은 한 번 읽은 파일 내용에서 값과 revision을 만든다. 모델 저장 후 추론 패널을 다시 읽고 추론 저장 후 loader를 갱신한다. 모델/추론 설정 외 사용자 데이터와 credential은 변경하지 않았다.
- `model-revision-regression.log`: 서버 모델/Hive/config/ownership 포함 68개 통과. `model-revision-browser-green.log`: production Studio의 기존 설정 회귀와 새 경계 10개 통과. 전체 타입, spec 1,929 checks / 253 tags, production build, 변경 파일 Biome·diff 검사 통과.
- 사용자 요청으로 기존 작업 폴더에서 수정된 개발 서버를 `127.0.0.1:4317`에 시작하고 실제 모델 설정 화면 및 기존 OpenAI 연결 표시를 확인했다. 유료 모델 호출·Hive 실서비스 도구 호출은 실행하지 않았다.
