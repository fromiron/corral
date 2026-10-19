# M2 변경·디자인·이미지 검증 증거

기준은 M1과 같은 `feat/integrated-improvements` 작업 트리다. C-101~106은 CR-027/029/030/034/035/036 등록 후 필요한 실패 시험과 기존 회귀를 확장해 구현했다. 유료 모델 호출, 커밋·게시·배포는 하지 않았다. 테스트의 live 표시는 로컬 가짜 provider/실제 HTTP 경로를 의미하며 실제 모델 품질을 뜻하지 않는다.

## 구현과 경계

- **C-101 파일 체크포인트:** 파일 tree/ref/manifest와 세션·Run/sequence를 고정한다. 명시 복구 계획은 현재 tree에 묶이고 전역 실행/작업 사본 lease로 시작 경쟁을 막는다. 복구 전 pin된 보존본을 만든다. 사용자 index/원본 저장소는 유지하며 symlink/submodule/file-directory 전환은 거절한다. 불완전·부분 실패·재시작 불확실 결과를 성공으로 바꾸지 않는다. 수동 pin, 30일/최신 50개 보존 및 명시 만료를 제공한다. 외부 API·DB·비용은 복원 범위가 아니다.
- **C-102 상태 카드:** 환경, 선택 실행의 추정 컨텍스트/실측 사용량, 시작 시 연결 정보, 변경 요약을 제공한다. Pi 1.3.0 공개 추정 함수를 실제 요청에 적용하며 모델 한도와 구별한다. 현재 OS 격리는 활성화되어 있지 않다고 표시한다. 압축 버튼은 아직 열지 않는다.
- **C-103 디자인 검증:** 상세 보고서·토큰 제안의 불변 산출물과 선호 출처를 review에 연결한다. 실제 질문 답변이 없는 사용자 선택, 다른 Run/미공유 산출물, 필수 unknown/fail 검사가 있는 pass, targeted를 release로 올리는 판정을 거절한다. 이 adapter는 상위 보고서의 범위/필수 검사만 읽으며 전체 upstream validator나 실제 브라우저 검사를 대체하지 않는다. 템플릿은 입력만 만들고 권한은 바꾸지 않는다. 선택 전문팩은 명시 설치·바인딩 경로를 유지한다.
- **C-104 로컬 브라우저:** 등록된 dev-server recipe와 고정 Playwright MCP 0.0.83을 별도 임시 프로필에서 실행한다. 관찰·클릭·명시 assertion만 제공하고 임의 evaluate/upload/install/resource 호출은 막는다. loopback fixture의 외부 origin과 redirect는 차단한다. timeout/취소는 소유 자식만 종료한다. MCP의 isError 반환을 성공 효과로 기록하던 기존 문제도 수정했다. 브라우저는 trusted-native 기능이며 origin 검사로 OS 격리나 인증된 외부 서비스 검증을 주장하지 않는다.
- **C-105 Skill 지표:** 바인딩, 전체 본문 읽기, 실제 provider payload의 전체 본문 포함을 각각 기록한다. CLI eval은 필요한/금지된 Skill의 누락·불필요 전달, payload 수/크기와 입력 token을 집계한다. 미측정은 null이며 절차 준수/품질을 추정해 채우지 않는다. 실제 품질 비교는 미실행이다.
- **C-106 이미지:** 브라우저에서 PNG/JPEG/WebP를 최대 2048×2048 PNG로 변환하고 서버가 CRC·구조/치수·1 MiB·세션 64 MiB 한도 및 hash를 재검사한다. 요청당 최대 3개, private 바이너리와 Run 본문을 보존한다. 모든 역할이 이미지 지원을 명시해야 시작한다. 두 runtime의 실제 HTTP 이미지 블록을 확인하며 단순 base64 텍스트를 성공으로 세지 않는다. 초안·설정 왕복·entry 기록·재열기·private export를 연결하고 공개 export에서는 본문을 제외한다.

## 실패 재현과 검증

핵심 red 로그는 checkpoint-red, checkpoint-admission-red, status-context-red, design-adapter-red, browser-policy/SDK MCP error, skill delivery/eval, image-admission 및 image-boundaries다. 추가 통합 검증에서 CSP 때문에 이미지 Blob URL 디코딩이 거절되어 표준 ImageBitmap으로 바꿨다. 템플릿 ICU 중괄호, legacy DB fixture의 새 테이블 잔류, SDK에서 컨텍스트 추정 필드를 누락하는 전달 경로도 확인 후 수정했다. 테스트 단언이나 시간 제한을 완화하지 않았다.

| 검증 | 증거 |
|---|---|
| 전체 단위·컴포넌트 | `m2-full-serial-green.log`: 171개 파일, 1,118 통과, opt-in 6 skip. 병렬 빌드/브라우저와 겹친 앞 실행의 5초 timeout 2건은 작업 수 2로 재실행해 통과 |
| 체크포인트 | 관련 122개 통과, 실제 파일 화면의 저장·복구 및 복구 전 보존본 확인 |
| 디자인 review | 관련 9개 통과: 정상 보고서 연결과 release 불일치/가짜 선호 거절 |
| 실제 브라우저 MCP opt-in | `browser-boundaries.log`: 정상 관찰·실패 assertion·redirect 차단·취소·자식 정리·unrelated server 생존·readiness timeout 통과 |
| 실제 HTTP provider 경로 | core/SDK × keyed/keyless 4경로의 Skill payload hash·이미지 블록 확인. 컨텍스트 필드 누락 red 후 adapter 회귀 재확인 |
| 실제 Studio 브라우저 | `m2-browser-final.log` 3개: checkpoint/files, 1,000개 대화 앵커, 첨부/설정/질문/계획/결과/4개 카드. `m2-auto-reins.log` 14개: 자동 시작·취소·응답 유실·Reins |
| 타입·정적 검사 | 전체 workspace/tools/live 타입 통과. 스펙 1,835검사, 235/235 시나리오 태그. lint 오류 0, 기존 경고 유지 |
| 의존성 | 직접 64개 고정 버전/Node/peer 검증, production audit 0건. MCP의 고정 prerelease transitive 예외와 pngjs 승격 이유 별도 기록 |

임시 증거는 `/tmp/corral-improvement-evidence/`에 있다. M3~M4, 실제 유료 품질 평가, 외부 인증 브라우저, 다른 OS, 새 후보의 hosted CI/배포는 아직 확인하지 않았다. M1의 D&D/키보드 회귀 증거는 별도 M1 문서에 있다.

M2 후속 확인: SDK 컨텍스트 추정 필드 전달 수정 후 adapter 31개 통과. Linux 패키징 runtime staging에서 Node/SQLite/Pi/ONNX/Studio 검사를 통과했다. 패키징된 GUI 전체 흐름을 확인한 것은 아니다.
