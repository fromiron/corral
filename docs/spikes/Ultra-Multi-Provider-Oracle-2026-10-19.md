# 복수 LLM Ultra: Oracle 재검토

2026-10-19, CR-031 C-118. Bell이 명확히 한 목표는 여러 회사의 서로 다른 LLM을 최대 지원 추론으로 함께 사용하는 Ultra다. 기존 단일 모델 가정을 수정한다.

[사용자 지정 Oracle 세션](https://chatgpt.com/g/g-p-6ad1f206e5ec8191904cfee1105213e3-corral/c/6ad4cfb8-3fe0-83ec-9099-aa745252231f)의 Pro/파워 5에서 검토를 완료했다(화면상 20분 40초). local HEAD `e7594dbc992f06bb816bf93de5c4095ae06fe115`의 19개 관련 소스/명시한 발췌와 `09fe207..e7594db` 전체 Ultra diff를 한 문서로 첨부했다. bundle SHA-256은 `e7b607b1aebc5a166f761954950b5a6898b43c7413ff83aae7192f923de02ec9`다. 검토는 설계 의견이며 테스트 재실행 또는 실모델 성공 증거가 아니다.

## 추가 확인한 사용자 지정 소스

- DeepSeek Harness `687f282e8625c6b8d11ff58211a90524be2e4317`: 기존 비교와 동일. child/activation 소유권, 정리 후 capacity 반환을 참고한다.
- [oh-my-openagent `5273cc11`](https://github.com/code-yeongyu/oh-my-openagent/tree/5273cc11ddedc0bdad745f2c0d702dcdba88b5f8): `5.1.36`. `senpi-task/manager/concurrency.ts`의 task/epoch 소유권과 global/model/provider 제한, `manager/types.ts`의 requested/resolved/effective 모델 구분을 확인했다. 루트 `LICENSE.md`는 SUL-1.0이고 개별 컴포넌트는 별도 고지가 있다. 동작·설계만 참고하며 코드를 복사하거나 런타임을 도입하지 않는다.
- [Codex multi_agents.rs](https://github.com/openai/codex/blob/89461ea6833832b0551ce24ee32205824d5c108d/codex-rs/core/src/session/multi_agents.rs): Ultra를 proactive 협업 정책으로 해석한다.
- [Codex reasoning_effort.rs](https://github.com/openai/codex/blob/89461ea6833832b0551ce24ee32205824d5c108d/codex-rs/protocol/src/openai_models/reasoning_effort.rs): 모델 metadata로 Ultra를 실제 wire effort에 매핑한다. 이 enum/fallback을 다른 provider에 복제하지 않는다.

## 채택한 권고

1. 기본 Ultra는 고정 pool의 멀티모델 협업이다. C-113은 legacy, C-114 best-of-N은 선택 전략으로 분리한다.
2. 기존 역할별 model snapshot, 그래프, callable node와 spawn/await/read/submit을 재사용한다. 새 범용 scheduler나 가짜 controller adapter를 만들지 않는다.
3. planner/executor/synthesizer/verifier를 고정하고 다른 모델의 검토는 필수다. 종합 뒤 검토하여 이전 산출물의 pass를 새 문서에 붙이지 않는다. 파일 작성자는 executor 하나다.
4. pool·배정·전송 범위는 사용자 설정과 Run 시작 기록에 묶는다. 필수 모델 실패를 다른 회사로 자동 대체하지 않는다. 한 회사의 여러 모델과 여러 회사 참여를 구분한다.
5. maximum_supported는 모델/transport별 검증된 최고 제어다. 일반 effort를 저장된 설정에서 덮어쓰지 않고, 상충하는 새 요청은 거절한다. 지원하지 않는 값을 medium/max로 추측하지 않는다.
6. 모델 호출 전체 동시성 3을 유지한다. 위임·80% draining·마무리 hold·unknown usage는 기존 원장과 permit 경계에 연결한다. 마무리 예약은 남아 있는 필수 역할의 capped 요청을 기준으로 하며 C-114의 두 호출 helper를 그대로 완료 정책으로 쓰지 않는다.
7. 최종 wire의 모델/endpoint·추론·총생성량을 검증하고 숨은 HTTP 재시도를 한 permit의 추가 호출로 허용하지 않는다. wire cap 미지원은 실제 청구량 hard cap이라고 표시하지 않는다.
8. 코딩 완료의 필수 검사는 host 소유 격리 효과로 분리한다. unsupported/failed/unknown/stale 검사를 모델 pass로 대체하지 않는다.

## 독립적으로 재확인한 경계

설치된 Pi 1.3.0의 실제 serializer를 네트워크 전송 직전 중단해 점검했다. 네트워크 요청 수는 0이다.

- OpenAI `gpt-6.1-sol` API 경로는 최상위 effort가 medium이어도 마지막 `configuration_update`가 max일 수 있다. 기존 Corral의 최상위 effort 검사만으로는 정상 요청을 잘못 거절한다.
- DeepSeek `deepseek-v4-pro`는 `thinking.type=enabled`와 `reasoning_effort=max`, `max_tokens`를 사용한다.
- Anthropic의 일부 모델은 system 설정 메시지에 현재 effort를 기록한다. budget 기반 모델은 base 4096에 thinking 16384를 더해 `max_tokens=20480`으로 만들 수 있다.
- Gemini는 모델별 level/budget 형식이 다르다. Pi의 공통 옵션 이름만 같다고 wire 통제를 검증한 것으로 간주하지 않는다.

증거는 `pi-ultra-wire-probe.json`, `pi-ultra-wire-boundaries.json`, `oracle-ultra-multi-provider-answer.txt`에 저장했다. 실제 서비스의 모델 접근 권한·품질·청구·지연은 확인하지 않았다.
