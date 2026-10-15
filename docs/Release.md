# 출시 증거와 게이트

C-049는 코드가 존재하는 것, 결정적 검증 통과, live 검증, 공개 배포를 구분한다. 일반 CI와 `release:gate`는 실제 LLM이나 유료 검색을 호출하지 않는다. 테스트를 통과해도 자동으로 배포하거나 패키지를 발행하지 않는다.

## 실행

```sh
pnpm install --frozen-lockfile
pnpm deps:check
python -m pip install -r tools/requirements.txt
pnpm --filter @corral/studio exec playwright install --with-deps chromium firefox
pnpm release:gate
```

gate는 순서대로 spec:check, 전체 시나리오 소스 연결, 의존성 버전·Node/peer 호환성, contracts:check, lint, typecheck, unit/contract/integration/Storybook axe, release policy self-test, production build, 전체 브라우저 E2E(키보드·IME 포함), production 정적 데모의 Chromium/Firefox 핵심 흐름, 고정 부하 성능, 라이선스/SBOM을 실행한다. 실패한 단계에서 멈추며 `test-results/release/evidence.json`에 단계별 결과와 시각을 남긴다. green 결과를 만들려고 retry하지 않는다.

`spec:check`는 알 수 없는 테스트 ID를 막는다. 추가 release traceability 검사는 catalog의 **모든** 시나리오에 test/spec/story/shared suite의 TC 태그가 있는지도 확인한다. 소스 연결 자체는 실행 통과 증거가 아니다. 각 테스트 runner가 별도로 성공해야 한다.

## 현재 후보와 live 결과

source SHA256은 Git이 추적하는 파일 및 ignore되지 않은 새 파일의 경로·내용을 정렬해 계산한다. 수정되거나 삭제된 파일도 반영한다. 생성 결과와 credential, DB, `test-results/`는 ignore된다. 같은 commit 안의 미커밋 변경도 다른 후보가 된다. 검증 중 소스를 변경하면 다시 실행해야 한다.

실제 공급자 smoke는 필요할 때 사용자가 명시적으로 실행한다.

```sh
# 비용/계정 사용을 의도적으로 허용할 때만 실행
CORRAL_LIVE=1 pnpm test:live
pnpm release:check tests/live/.last-run.json
```

기존 OpenAI smoke는 현재 2개 profile에 각 3 calls/256 output tokens per call 이하, 취소 smoke 1 call로 최대 7 calls다. profile 추가로 10 calls를 넘으면 호출 전에 거절한다. `.last-run.json`은 결과·실행 후보·상한을 기록하며 모든 profile과 취소 검증이 통과해야 `passed`가 true다. 결과 본문과 token/credential은 기록하지 않는다. `release:check`는 live call을 시작하지 않으며, 최신 후보에 맞는 bounded live 증거가 없으면 실패한다. 이전 P3 live 증거는 역사적 사실이며 새 후보의 증거를 대신하지 않는다.

## 라이선스와 SBOM

`pnpm deps:check`는 네트워크 호출이나 기록 갱신 없이 workspace의 직접 의존성 exact pin·설치 버전·라이선스·Node/peer 메타데이터를 `docs/dependency-lock.json`의 검토 기록과 대조한다. 새 버전은 기존 버전의 검토를 물려받지 않는다. 설치된 전체 전이 의존성도 실제 Node 버전과 각 패키지 위치에서 해석한 peer 버전으로 검사한다. optional peer는 미설치일 때만 생략하며 설치된 잘못된 버전은 실패한다. 현재 테스트 의존성의 Node 요구 때문에 Node 24.15.0 이상인 24.x를 지원하며 CI와 최종 검증은 `.node-version`의 24.19.0을 사용한다.

prerelease는 안정 버전이나 MIT 라이선스만으로 승인되지 않는다. 기존 개발 도구의 `@polka/url@1.0.0-next.29`와 `gensync@1.0.0-beta.2`만 정확한 버전·라이선스·출처·Node/peer 메타데이터와 검토 이유를 `reviewedPrereleases`에 기록했다. 어느 값이든 달라지면 다시 검토해야 한다. `deps:record`는 registry 사실만 갱신하며 이 예외를 생성하거나 변경하지 않는다. 의존성 변경자는 upstream 자료와 호환성 결과를 검토한 뒤 기록 변경을 함께 리뷰해야 한다.

이 검사는 npm의 [semver 7.8.5](https://www.npmjs.com/package/semver/v/7.8.5)를 사용한다. 기존 설치 버전을 직접 개발 의존성으로 명시했으며 ISC, Node ≥10, peer 없음이다. TypeScript 선언은 [@types/semver 7.8.0](https://www.npmjs.com/package/@types/semver/v/7.8.0)(MIT)이다. 둘 다 릴리스 도구 전용이라 Studio 런타임 번들에 추가되지 않는다. 설치된 버전의 README·타입·메타데이터를 확인했고 2026-10-15 `pnpm audit --json`은 알려진 취약점 0건을 반환했다. 이는 보안 보증이 아니며 이후 변경 시 다시 확인한다. Context7 도구는 이 세션에 없어 설치 버전 문서와 npm의 공식 registry 메타데이터를 사용했다.

`pnpm release:inventory`는 설치된 pnpm dependency tree에서 production/dev 의존성 모두를 확인한다. `test-results/release/sbom.spdx.json`에는 package/version/purl/license와 source 후보가, `THIRD-PARTY-NOTICES.txt`에는 패키지가 배포한 최상위 LICENSE/NOTICE/COPYING 내용이 들어간다. pnpm 내부 설치 경로는 포함하지 않는다. 다른 OS의 설치되지 않은 optional dependency는 이 inventory에 포함하지 않으므로 배포할 각 플랫폼에서 다시 생성한다.

허용한 정확한 SPDX 표현은 `tools/release/policy.ts`에서 검토한다. permissive 라이선스 외 axe 등 MPL-2.0 도구와 CC-BY-4.0 데이터도 있으므로 MIT 프로젝트라는 이유로 제3자 의무가 사라지지 않는다. 알 수 없는 표현은 fail closed한다. 버전 변경 시 [의존성 기록](dependency-lock.json), upstream LICENSE/NOTICE, 번들에 포함되는 범위를 함께 검토한다. SPDX 생성은 취약점 감사나 법률 판정이 아니다.

형식 근거: [pnpm 10 licenses](https://pnpm.io/10.x/cli/licenses), [SPDX 2.3](https://spdx.github.io/spdx-spec/v2.3.1/). 새 의존성 없이 설치된 pnpm 10.30.3의 JSON 출력과 표준 SPDX package inventory를 사용한다. SPDX 프로젝트의 2.3 공식 JSON Schema(CC-BY-3.0, 원본 LICENSE 동봉)를 `tools/release/spdx.schema.json`에 고정하고 기존 문서 검사용 jsonschema로 매번 생성 결과를 검증한다.

`.github/workflows/release.yml`은 수동 실행 또는 버전 태그에서 같은 결정적 gate를 실행하고 inventory·측정 JSON·CPU profile·flamegraph를 보관한다. Playwright trace는 로컬 진단용이며 소스 경로를 포함할 수 있어 공개 artifact에 자동 업로드하지 않는다. 이 workflow는 live 증명이나 공개 릴리스를 발행하지 않는다.
