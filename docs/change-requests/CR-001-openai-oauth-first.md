# CR-001: 모델 연결을 OpenAI 구독 OAuth로 시작한다

- 변경 ID / 제안자 / 날짜: CR-001 / Bell / 2026-10-15
- 상태: **승인** (Bell, 2026-10-15)
- 연결 문서: [스펙](../../Corral-Spec-v0.1.md) §3.1·§4.1·§10.2·§11·§13, [기술 설계](../Technical-Design.md) §7.1, [ADR-019](../Decisions.md), [v0.2 보완](../plans/Corral-Implementation-Plan-v0.2-Supplement.md)

## 기존 요구 ID와 문구

| 위치 | 기존 문구 |
|---|---|
| 스펙 §3.1 연결 | Pi agent-core, 서로 다른 공급자 모델 프로필 2개. 사용자 API 키 직접 사용 |
| 스펙 §4.1 `/settings/models` | 서버에서 해석되는 두 프로필, 기능·키 존재 여부 |
| 스펙 §10.2 | API 키는 backend 환경/키 저장소에서만 읽는다 |
| 스펙 §11 AC-18 (CRL-DEV-004, CRL-OBS-004) | 실제 모델 프로필 두 개의 요청·usage·취소 계약 스모크 |
| 백로그 C-020, C-058 | 모델 2프로필, 키는 env 전용 |

## 제안 문구

1. **MVP 연결:** Pi agent-core + pi-ai의 **OpenAI 구독 OAuth(ChatGPT 로그인)** 하나로 시작한다. 같은 provider 안에서 서로 다른 모델 프로필 2개를 둔다. 미래 설정 patch(RNS-006)로 모델을 바꾸는 시나리오를 실모델로 검증하기 위해서다.
2. **확장 목표:** Pi가 지원하는 provider와 인증 방식(API 키, 다른 OAuth)을 모두 지원한다. 단, **Anthropic 구독(Pro/Max) OAuth는 지원하지 않는다.** Anthropic은 제3자 앱이 구독 자격 증명으로 요청하거나 토큰을 보관·중개하는 것을 허용하지 않는다([Claude Code Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), 2026-10-15 확인). Anthropic은 API 키로 지원한다.
3. **자격 증명 경계:** OAuth 로그인은 provider의 자체 흐름에서 사용자가 직접 완료한다. Corral은 비밀번호를 받지 않는다. 발급된 토큰은 서버 측 credential store(workspace 밖 사용자 설정 디렉터리, 파일 권한 0600)에만 둔다. Corral JSON, SQLite, 이벤트 payload, export, 클라이언트 번들, 로그에는 넣지 않는다. 토큰 갱신은 host가 하고, worker에는 요청 시점에 필요한 access token만 전달한다.
4. **Pi provider 선택:** pi-ai v1.2.0에는 OpenAI OAuth가 두 가지 있다. 공식 Sign in with ChatGPT 흐름(`OpenAI (Sign in with ChatGPT)`)을 우선하고, `OpenAI Codex (legacy)`는 대안으로만 둔다. 실제 동작은 C-052에서 판정한다.

## 이유

사용자 목표 변경. 구독 기반 사용을 먼저 지원하고, 장기적으로 Pi가 지원하는 범위 전체를 제공한다.

## 기존 합의와 충돌하는 부분

- “서로 다른 공급자 2개”는 provider 간 usage 형식 차이를 실모델로 검증하는 장치였다. MVP에서는 live 검증이 OpenAI 하나로 줄어든다. 대신 usage normalization 계약 테스트는 pi-ai가 반환하는 2종 이상의 provider usage 형식 fixture로 유지한다(스펙 §9).
- 구독 사용량에는 토큰 단가가 없다. 금액은 null과 “plan usage”로 표시하고, 토큰·호출 상한은 그대로 적용한다. 확인값·추정값·미확인값 구분(CRL-OBS-004)은 유지한다.

## 이벤트·저장 schema 영향

- 모델 프로필에 `auth: "oauth" | "api_key"`와 provider ID를 둔다. 프로필에는 자격 증명 값이 아니라 credential 참조 이름만 둔다.
- `run.started`의 모델 스냅샷에 provider·model ID·인증 종류를 기록한다. 토큰 값은 기록하지 않는다.

## 기존 테스트 중 변경할 것과 유지해야 할 반례

- TC-DEV-004-H, TC-OBS-004-H(live smoke): OpenAI OAuth 프로필 2개로 수행한다. 로그인이 필요하므로 CI가 아닌 수동 opt-in이다.
- TC-SEC-002-N: OAuth access/refresh token이 클라이언트 번들·export·로그·이벤트에 없는지 검사를 추가한다.
- 유지할 반례: usage 누락을 0으로 표시하지 않는다(TC-OBS-004-N). 키가 없어도 mock 협업은 동작한다(TC-DX-003-N).

## 일정·보안·호환성 영향

- C-058에 OAuth 로그인 시작·완료·로그아웃·만료 상태 UI가 추가된다(+2–4h 예상).
- OpenAI 정책이 바뀔 위험이 있다. 그 경우 확장 1순위인 API 키 경로로 전환한다. ModelRegistry는 처음부터 인증 방식을 교체할 수 있게 설계한다.
- 공개 데모는 변경 없음. mock만 사용하고 로그인 기능을 노출하지 않는다.

## 승인 / 보류 / 반려와 근거

승인. Bell이 2026-10-15에 “일단 OpenAI OAuth만 지원하고 추후 Pi가 지원하는 것 전부로 확장”으로 결정했다.
