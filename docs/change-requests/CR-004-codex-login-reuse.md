# CR-004: Codex CLI 로그인을 읽기 전용으로 재사용한다

- 변경 ID / 제안자 / 날짜: CR-004 / Bell(요청), Claude(초안) / 2026-10-16
- 상태: **승인** (Bell, 2026-10-16: "인증 기능은 OS의 기본 인증 디렉터리 파일을 쓰는 게 좋을 것 같음. `/home/bell/.codex/auth.json`이 GPT OAuth 인증 파일")
- 연결 문서: [CR-001](CR-001-openai-oauth-first.md), [ADR-019](../Decisions.md), 스펙 §10.2

## 기존 문구

CR-001 §3: 발급된 토큰은 **Corral의 서버 측 credential store**(작업 공간 밖 사용자 설정 디렉터리, 0600)에만 둔다. 로그인은 provider 흐름에서 사용자가 직접 완료한다.

## 확인한 사실 (2026-10-16)

- Corral의 credential store는 이미 OS 표준 설정 디렉터리를 쓴다: Linux `$XDG_CONFIG_HOME/corral` 또는 `~/.config/corral`, Windows `%APPDATA%\corral` (`apps/server/src/models/config-dir.ts`). macOS도 `~/.config/corral`이다.
- Codex CLI의 로그인 파일 `~/.codex/auth.json`(또는 `$CODEX_HOME/auth.json`, 권한 0600)은 `tokens.{access_token, refresh_token, id_token, account_id}`와 `last_refresh`를 담는다(값은 열람하지 않고 키 구조만 확인).
- pi-ai 1.2.0의 `openai-codex` provider는 Codex CLI와 같은 OAuth client(`app_EMoamEEZ73f0CkXaXp7hrann`)와 ChatGPT backend를 쓴다. Corral의 `openai` provider(공식 Sign in with ChatGPT)와는 client·scope가 다르므로 Codex 토큰은 `openai-codex`에만 맞는다.

## 제안

1. **읽기 전용 credential source `codex-cli`:** Corral 자체 로그인이 없을 때, `~/.codex/auth.json`의 access token을 `openai-codex` provider의 OAuth credential로 쓴다. 만료 시각은 access token(JWT)의 `exp`에서 읽는다(서명 검증 없음, 표시와 만료 판단용).
2. **갱신하지 않고 쓰지 않는다.** Corral은 Codex의 refresh token을 쓰지 않는다. refresh token은 갱신할 때 회전될 수 있어서, Corral이 갱신하면 Codex CLI 로그인이 깨질 수 있다. Codex 파일에 쓰지도 않는다. 만료되면 "Codex를 한 번 실행해 갱신하거나 여기서 로그인하세요"라고 안내한다.
3. **우선순위:** Corral 자체 로그인(credential store)이 있으면 그것을 쓴다. 없을 때만 Codex 로그인을 읽는다.
4. **기본 프로필:** 작업 공간 설정에 프로필이 없고 Corral 자체 OpenAI 로그인이 없으며 Codex 로그인이 있으면, 기본 두 프로필은 같은 모델 ID로 `openai-codex` provider를 쓴다.
5. **노출 금지(ADR-019 유지):** 토큰·파일 내용은 API 응답·이벤트·로그·export에 넣지 않는다. 화면에는 출처("Codex CLI 로그인, 읽기 전용")와 만료 시각만 보인다. 파일 권한이 0600보다 넓으면 경고를 보인다.
6. **모델 worker의 요청 토큰 store:** pi-ai는 요청별 API key를 API-key 인증이 있는 provider에만 적용한다. `openai-codex`는 OAuth 전용이라 credential store에서 자격 증명을 읽는다. worker는 여전히 영속 store를 갖지 않고(ADR-019), 호스트가 이번 요청과 함께 보낸 토큰 하나만 메모리에 두고 OAuth credential로 내준다. worker에서는 갱신하지 않는다(갱신은 호스트 몫).

## 이유

이미 Codex CLI로 로그인한 사용자가 Corral에서 다시 로그인하지 않아도 된다. 읽기 전용이 Codex CLI 로그인을 깨지 않는 가장 안전한 방법이다.

## 기존 합의와 충돌

CR-001 §3의 "Corral store에만 둔다"는 Corral이 **발급받은** 토큰에 관한 규칙으로 유지한다. 다른 앱이 이미 보관한 자격 증명을 그 자리에서 읽는 경로를 하나 추가한다. Corral은 그 값을 복사·저장하지 않는다.

## 테스트

- `codex-cli` source: 정상 파일 → OAuth credential(만료는 JWT `exp`), 없는 파일·깨진 JSON·토큰 없음 → 없음, 권한 0644 → 경고.
- 계층 store: 자체 로그인 우선, Codex credential에 대해 `modify`는 갱신 함수를 호출하지 않고 파일을 바꾸지 않음, `delete`는 Codex 파일을 지우지 않음.
- 모델 API 응답에 토큰·파일 경로·계정 ID가 없음.
- 기본 프로필 선택: 자체 로그인 > Codex 로그인 > 로그인 필요.
- worker 요청 토큰 store: OAuth 전용 provider가 요청 토큰으로 호출되고 갱신하지 않음, store 없이는 "not configured"로 실패.
- E2E: 모델 화면이 "Codex CLI 로그인(읽기 전용)"과 만료 시각을 보이고 로그아웃 버튼은 없으며, live Run이 Codex 토큰으로 실행되고 페이지에 토큰·`auth.json`이 없음.

## 진행 결과 (2026-10-16)

- 구현: `apps/server/src/models/codex-login.ts`, `registry.ts`(`source`·`permissionsOk`), `live-models.ts`, `packages/adapter-pi/src/request-credentials.ts`, 모델 설정 화면과 en/ko 메시지.
- 테스트: `apps/server/test/codex-login.test.ts`(8), `packages/adapter-pi/test/request-credentials.test.ts`(2), `apps/studio/e2e/server/models.spec.ts`(Codex 1). 전체 단위 테스트와 E2E 87개 통과.
- 실제 확인(1회, 한도: 모델 호출 6·출력 4000 토큰): 빈 Corral 설정 디렉터리에서 `corral exec`가 Codex 로그인으로 성공(모델 호출 3, 출력 128 토큰). 실행 전후 `~/.codex/auth.json`의 수정 시각·크기·해시가 같았고 출력에 토큰이 없었다. 처음 시도는 worker가 OAuth 전용 provider에 토큰을 넘기지 못해 실패했고, 제안 6으로 고쳤다.
- 남은 점: pi-ai는 이 provider 이름을 "OpenAI Codex (legacy)"로 보인다. Codex 토큰이 만료되면 Corral은 갱신하지 않으므로 Codex를 다시 실행해야 한다.

## 일정·영향

새 의존성 없음. 서버 credential 경로, 모델 worker의 요청 토큰 전달, 모델 설정 화면이 바뀐다. 실제 모델 확인은 Bell의 Codex 로그인으로 1회.
