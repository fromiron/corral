# CR-022: 스킬·Hook·MCP 관리 생명주기

- 상태: 승인 — Bell의 2026-10-18 Oracle 계획 작성 후 도입 요청.
- 기준: main `098dbbc`, Oracle Pro(5/5) 브라우저 검토. 실행 계약 CR-018·020 유지.
- 추적: C-085, CRL-MGR-001~002, TC-MGR-001-H/N~002-H/N.

## 계약

1. 설정은 작업 방식·스킬·Hook/확장·MCP 목록과 상세 편집으로 나눈다. 라이브러리는 workspace 범위이며 전역 실행 토글이 아니다. 설치·신뢰·작업 방식 선택·실제 Run 적용을 구분한다. 검사/LSP는 작업 폴더 설정에 둔다.
2. 스킬 작성·단일 파일/폴더/고정 패키지 가져오기·원문 편집을 제공한다. 한국어 표시명과 자동 내부 ID를 분리한다. 내용은 64 KiB UTF-8 제한, 기존 Pi 검사와 복사·경로·비밀 파일 경계를 유지한다. 알 수 없는 frontmatter는 원문 편집으로 보존한다.
3. 편집은 전체 bundle의 새 사본·hash다. 기존 bytes·외부 원본·Run snapshot을 수정하지 않고 신뢰도 승계하지 않는다. 변경한 entry만 선택적으로 새 profile revision에 반영한다. 내용을 열어도 native 코드를 실행하지 않는다.
4. entry/profile 관리 메타데이터는 실행 내용과 분리한다. 목록 제거는 보관이며 복구할 수 있다. 기존 참조와 실행은 유지하고, 선택 중인 보관 항목은 화면에서 숨기지 않는다. 신뢰 철회는 별도 동작이다. 사용처는 고정 revision을 표시하며 자동 최신화하지 않는다.
5. 관리 요청은 expected revision과 operation receipt로 중복·응답 유실을 처리한다. 개인/프로젝트 기본 작업 방식의 선택 변경은 profile revision 저장과 해당 default CAS를 한 transaction에 묶는다. 상위 리소스 합집합·필수 유지와 도구/서버 교집합을 바꾸지 않는다.
6. Hook은 기존 Pi extension이다. 시작 알림·시작 확인 폼은 버전 있는 메타데이터와 안전하게 직렬화한 소스를 생성한다. 생성 소스가 일치할 때만 폼 편집한다. 일반 확장은 원문 사본 편집과 entry 단위 선택만 제공하고 개별 handler 자동 발견을 주장하지 않는다. strict 정책을 자동 변경하지 않는다.
7. MCP `enabled?: boolean` 누락은 기존 동작을 유지한다. 새 UI 등록은 비활성으로 시작하고 다음 Run 합성에서 비활성을 제외하되 진단을 표시한다. 진행 중 Run은 고정 config를 계속 사용한다. 삭제는 현재 설정에서 제거하며 현재 선택 사용처를 transaction에서 검사한다. 과거 revision과 인증은 보존하고 ID를 다른 서버에 재사용하지 않는다.
8. endpoint/auth scope/client 변경은 새 credential reference를 사용한다. 로그아웃은 정확한 config revision의 인증만 폐기한다. 기존 fingerprint 신뢰를 새 revision에 자동 복사하지 않는다.
9. 연결 시험은 모델 호출 없는 Pi 공개 MCP client의 initialize/listTools/close다. stdio는 선택한 관리 사본에서만 실행한다. 한 workspace에서 한 probe만 허용하고 timeout·취소·화면 이탈·설정 변경 시 소유 프로세스 종료를 확인한다. 결과는 해당 fingerprint의 관측이며 0개 도구도 정상일 수 있다. 발견은 도구 허용이 아니며 사용자가 선택한 정확한 이름만 profile에 추가한다.
10. 늦은 응답은 프로젝트·entry·revision·operation 소유권을 확인한다. 오류/409에서 초안을 보존한다. 미저장 이탈과 키보드 focus, IME를 처리한다. 실제 빌드에서 작성→편집→사용→해제/보관→복구→재시작을 검증한다. 일반 CI는 무료 fixture, 별도 실계정 Sol/Luna 검증은 사용자 승인 범위에서 수행한다.

## 범위 밖

새 Hook 엔진·marketplace·HMR·범용 폼 framework·사용자 원본 삭제·과거 자산 GC는 도입하지 않는다. 구현 순서와 증거는 계획 (Git `373764467a52:docs/plans/Resource-Management-Plan.md`)에 기록한다.
