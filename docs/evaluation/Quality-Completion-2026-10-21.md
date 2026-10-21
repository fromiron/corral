# 품질 작업 실행 기록 — 2026-10-21

- 기준: `d02898b680cc8b7c44e3e16ee2287474a22794b7`, `feat/complete-quality-workflow`.
- 현재 사용자 승인 범위: C-118 → 가능한 OS 패키지 검증 → CR-036-C/D → 준비된 외부 연동. C-114는 범위 밖이다.
- 환경: Linux x86_64, Node 24.19.0, pnpm 10.30.3. Windows/macOS 실기는 사용자가 별도 후속 검증으로 지정했다.
- 현재 연결된 OAuth/API live 시험은 사용자 승인됨. GPT 구독 인증을 우선한다. 외부 대상이 없는 SSH/S3를 임의 구성하지 않는다.

## C-118 격리 검사

새 Ultra의 저장소 요청은 effective harness의 검사 선택을 recipe에 고정한다. 종합 시작 전 서비스 정리 후 후보 tree를 고정하고, Coordinator가 검사와 교차 검토를 연결한다. 텍스트/legacy 요청은 기존 경로를 유지한다. 정확한 계약은 [CR-031](../change-requests/CR-031-ultra-quality.md)의 코딩 검사 절이다.

실패 확인: 기존 코드에서 검사 호출 0회인 성공, 격리 요청을 일반 host 명령으로 실행, Git filter의 host 실행, 서비스 정리 후 변경된 tree의 성공을 재현했다. 등록 검사 없음/격리 미지원/오류/stale/격리 증거 누락/모델 pass에 의한 검사 fail 덮기는 회귀에서 차단한다.

Linux 실제 bubblewrap으로 host 파일·환경·Git 관리 경로·외부 network interface 차단을 확인한다. 전용 JSON 상태 채널, PID namespace init 종료, detached 자식과 취소, exec 실패, 필터 없는 snapshot/checkout/status, 별도 격리 fingerprint를 검사한다. 일반 Git 작업의 사용자 filter 계약은 유지한다.

Oracle: 인앱 ChatGPT의 현재 Pro 모델로 설계와 기준 commit을 검토했다. [검토 대화](https://chatgpt.com/c/6ad838f6-18e0-83ee-b4a0-f5768dff9464). 후보 tree 연결, Git filter, launch identity, namespace cleanup, bootstrap 실패 분류를 보강했다. Oracle의 정적 검토를 실행 테스트로 집계하지 않는다. Bubblewrap 동작은 [공식 구현](https://github.com/containers/bubblewrap/blob/main/bubblewrap.c)과 설치된 CLI 설명에 대조했다.

검증: core Ultra/recipe + server runner/file broker 5개 파일 88개 테스트 통과(22.64초). core/server TypeScript, `spec:check` 2,090개 검사 및 TC 293/293, `contracts:check` 통과. C-118 전체 완료·다른 OS 지원·모델 품질 향상은 이 검사 연결만으로 주장하지 않는다.

## Provider conformance

Anthropic adaptive thinking의 기본 effort와 message-level effort를 API key/OAuth serializer + 결정적 429 HTTP로 확인했다. SDK가 본문의 beta 설정을 헤더로 옮기는 변환까지 permit에 묶으며 추가 dispatch/변조를 거절한다. provider default 및 광고한 모든 수동 추론 수준도 실제 serializer로 확인했다. 4개 파일 19개 테스트(실제 Linux Pi worker 2종 포함)가 통과했다. 이는 Anthropic 구독 로그인 지원이나 실제 공급자 품질 검증이 아니다.

Gemini는 설치된 Pi 1.3.0에서 custom fetch를 거절하는 것을 네트워크 0회로 재현했다. Ultra permit 경계를 지킬 수 없어 미지원 상태를 유지한다. 구형 Anthropic budget-thinking도 이 conformance 범위 밖이다.

## 남은 순서

1. Provider/API conformance와 현재 후보 GPT live 검증.
2. 현재 Linux 패키지 검증. Windows/macOS는 별도 후속 작업.
3. 기존 Skill draft에 fixture/eval/명시 채택을 연결한 뒤 update/rollback.
4. 사용 가능한 인증·외부 대상으로 실제 연동 검증. 준비되지 않은 환경은 명시한다.
