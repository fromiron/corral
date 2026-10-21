# CR-025: 하네스 권한과 OS 격리

- 상태: **순차 구현 승인** — Bell, 2026-10-19: “플랜대로 M0부터 순서대로 개선 진행해. CR 등록 → 실패 테스트 → 구현 순서로 하고, 기존 기능 회귀도 확인해.”
- 계획: 통합 개선 실행 계획 (Git `373764467a52:docs/plans/Corral-Improvement-Execution-Plan-2026-10-19.md`), M0-4, M1-1, M3-1.
- 기준: `780591e`(PR #60 수정 포함). 구현/검증 완료 여부는 단계별 증거로 따로 기록한다.
- 추적: M0는 C-090, CRL-SBX-001, TC-SBX-001-H/N. M1의 공통 인자 고정은 C-092, CRL-SAFE-001, TC-SAFE-001-H/N. 구조화 정책·영구 규칙 UI는 별도 후속 범위다.

## 계약

1. 기존 managed hook와 tool approval 경로에서 hook 이후 최종 인자·descriptor/schema hash·정책 revision을 승인하고 실행 직전에 재검사한다. deny·역할 capability·strict 상한을 allow로 넓히지 않는다.
2. 이번 실행의 승인과 다음 실행의 규칙 저장을 분리한다. 필수 hook 오류/timeout은 차단하며 tool_result는 사후 감사로만 취급한다.
3. Linux bubblewrap의 파일·network·process·IPC 경계를 먼저 PoC로 확인한다. 이 결과만으로 제품 worker가 격리된다고 표시하지 않는다. macOS/Windows·WSL은 별도 capability다.
4. 검증된 launch/stop/probe만 제품에 연결한다. 실패/미지원 시 silent fallback은 없다. 자격 증명·원본·private DB·공유 Git 정보는 worker 밖에 둔다.

## 검증과 배포

새 동작과 데이터·권한·취소 경계의 대표 반례만 구현 전에 실패를 확인한다. 기존 통합 시험을 우선 확장하며 문구·내부 함수·모든 조합을 따라가는 시험은 추가하지 않는다. 적용되는 정상·실패·취소·중복·늦은 이벤트 경계는 기존 시험과 합쳐 확인한다. D&D·Reins·과거 snapshot/hash·[CR-042](CR-042-desktop-capabilities.md) ABS-06으로 확장된 host admission·작업 사본별 단일 writer 제한을 유지한다. live/OS/브라우저 증거는 결정적 fixture와 구별한다.


## C-094 구조화 정책 계약

- 기존 profile은 기존 권한 동작과 hash를 보존한다. 새 `permissionPolicy`를 저장하면 `default=ask|deny`와 최대 64개 규칙을 적용한다. 각 레이어의 정책을 모두 만족해야 하며 어느 레이어든 deny면 차단한다.
- 규칙은 정확한 tool name, optional descriptor hash, 인자 값 조건 및 검증된 상대 경로 prefix를 사용한다. allow는 descriptor hash 필수다. deny를 우선하고 나머지는 더 구체적인 규칙을 우선하며 동률은 ask가 우선한다. allow는 기존 role capability·strict·MCP 신뢰·broker 검사보다 권한을 넓히지 않는다.
- `resolve_approval`의 기존 불변 subject/현재 revision 검사를 재사용한다. 새 도구 승인은 최종 인자·descriptor·snapshot hash·정책 revision에 결합하며 실제 효과 직전에 모두 다시 검사한다. 동시 중복 실행은 승인 대기 전부터 차단한다.
- 승인 UI는 이번 호출만 허용한다. 영구 규칙은 설정에서 별도 profile revision으로 저장하고 다음 Run에 적용한다. 현재 snapshot은 바뀌지 않는다.

## C-107 Linux worker 격리와 host 모델 broker

- 모델 profile의 선택 필드 `workerIsolation: linux-bwrap`로 요청한다. 기존 profile/hash는 바꾸지 않는다. 미지원 OS, bubblewrap 부재, mount/IPC 실패는 실행 실패이며 비격리 실행으로 대체하지 않는다. 설정과 시작 시 snapshot에서 요청을 추적한다.
- worker는 별도 mount/PID/network/IPC/user namespace와 비권한 capability에서 실행한다. 읽기 전용 애플리케이션 코드/의존성·선택 콘텐츠만 보이고 원본 프로젝트·작업 사본·자격 증명·DB·Git 관리 디렉터리와 host socket은 mount하지 않는다. 파일 효과는 기존 host broker를 통한다. 임시 홈과 임시 쓰기 공간만 제공한다.
- provider 호출은 host의 고정 모델과 Coordinator permit으로 1회씩 실행한다. worker의 URL/headers/credential/출력 상한 제안을 받지 않는다. worker에는 키를 전달하지 않고 model context, payload 확인, stream만 전용 IPC로 오간다. payload 변경은 거절한다. 취소/종료 시 broker와 소유 namespace 자식을 정리한다.
- 첫 capability는 pi-core 및 콘텐츠 전용 strict pi-sdk다. 직접 native extension/MCP와 비격리 host check/LSP recipe는 이 격리 profile에서 명시 거절한다. 기존 trusted-native profile은 비격리임을 표시한다. 이 제한을 넘어서는 승인 환경 브라우저는 C-112에서 별도로 검증한다.
- 설치된 Pi 1.3.0 공개 stream/event 타입과 기존 IPC/lease를 재사용한다. Linux 실제 네임스페이스·파일·network·종료와 가짜 HTTP provider로만 검증하며 유료 호출/다른 OS 지원을 추정하지 않는다.
