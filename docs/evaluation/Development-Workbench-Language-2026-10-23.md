# P23 프로젝트 언어 지원 — 구현·핵심 검증

- 기준: `9992aa2` 위 이 문서를 포함한 구현 묶음. CR-046 P23, CRL-WBD-018/C-162/TC-WBD-018-H,N,F.
- Linux, Node 24.19.0, pnpm 10.30.3, 실제 Git/SQLite/TypeScript Language Server 6.0.2 + TypeScript 6.0.3, production Studio/Chromium 인앱. 모델 호출·배포·원격 계정은 사용하지 않았다.
- 기존 단발 agent LSP와 문서 저장/undo 원장은 유지했다. 상시 언어 프로세스·세대·controller·dirty 문서 버전을 연결하고 기존 Problems/Monaco/dock을 재사용했다. Linux 실행 신원·공통 process capacity·nonwriter receipt로 재시작/미확인 정리를 보존한다. 다른 OS는 시작을 노출하지 않는다.

## 필요한 회귀만 확인

| 범위 | 결과 | 로그 |
|---|---|---|
| 새 transport red → full/incremental·UTF-16·cancel/crash·메시지 한도 | 5 PASS | `/tmp/corral-p23-language-red.log`, `/tmp/corral-p23-language-final.log` |
| 새 transport + 기존 단발 LSP | 16 PASS | `/tmp/corral-p23-language-green.log` |
| broker + P22 저장·공유 owner | 8 PASS | `/tmp/corral-p23-broker-regression.log` |
| passive owner의 저장/공유 종료·uncertain 보존 red→green | 8 PASS (2파일) | `/tmp/corral-p23-owner-red.log`, `/tmp/corral-p23-owner-green.log` |
| HTTP 경계 red→green | 1 PASS | `/tmp/corral-p23-http-red.log`, `/tmp/corral-p23-http-green.log` |
| UI 동기화·늦은 위치 이동·버전 미확인 Problems·기존 문서/Problems | 17 PASS (7파일) | `/tmp/corral-p23-ui-regression.log`, `/tmp/corral-p23-ui-location-red.log` |
| broker 대상/신원/URI 핵심 재검토 | 4 PASS, 추가 서버 결함 없음 | `/tmp/corral-p23-core-boundary-review.log` |

묶음 간 중복 시험 수를 합산하지 않는다. 늦은 definition 이동의 await 이후 세대 재검사 누락은 실패 테스트로 재현하고 수정했다. host crash 회귀는 주입한 OS 신원의 복구 경로이며 실제 컴퓨터 재시작 시험은 아니다.

타입 검사에서 UI 테스트의 Promise 타입 오류를 발견해 수정했다. 나머지 workspace 12개는 통과했고 최종 Studio 검사도 통과했다(`/tmp/corral-p23-typecheck.log`, `/tmp/corral-p23-studio-types.log`). tools/live 테스트 소스 타입 검사도 통과했다(`/tmp/corral-p23-tools-types.log`). production build·generated 계약·의존성 경계 검사 통과. 큰 chunk 경고는 기존과 같다. 최종 문서 검사 2671 checks PASS, 태그 355/358(남은 3개는 아직 시작하지 않은 P24-A 선언).

## 실제 화면과 서버

격리된 사본에 tsconfig path alias, 별도 imported `.ts`, 로컬 dependency `.d.ts`, `.tsx`를 준비했다. 실제 TLS가 이 프로젝트를 읽는 상태에서 다음을 확인했다.

1. 문서 툴바의 실행 명령 검토 → 신뢰하고 시작. 탭을 여는 것만으로 실행하지 않는다.
2. `src/main.ts`의 string→number 대입 오류가 기존 Problems에 나타났다. TLS 6.0.2는 push 진단에 version을 주지 않고 pull 진단도 제공하지 않아 **“버전 모름”**으로 표시했다. 현재 버전 marker로 임의 승격하지 않는다.
3. 저장하지 않은 상태에서 타입을 string으로 고치자 Problems가 갱신됐다. UI는 dirty를 유지했고 사본 디스크·원본 파일에는 이전 number 코드가 그대로 남았다.
4. 자동완성 `greet` 후보를 확인하고 F12로 path alias를 따라 `src/math.ts` 정의의 2행을 열었다.
5. Shift+F12가 3개 파일의 참조 5개를 표시했다. 아직 열지 않은 `src/usage.ts` 참조를 두 번 눌러 기존 문서 탭 2행으로 이동했고 main.ts 초안은 유지됐다.
6. 언어 서버를 명시 중지한 뒤에도 dirty 초안이 남았다. 실제 프로세스 종료 확인과 fixture 정리를 수행했다.

화면 임시 증거: `/tmp/corral-p23-language-navigation.png`, `/tmp/corral-p23-dirty-diagnostics.png`.

실제 서버 검증용 패키지는 `/tmp/corral-p23-language-tools`에만 설치했고 제품 manifest/lockfile 의존성은 추가하지 않았다. TLS [공식 6.0.2 manifest](https://github.com/typescript-language-server/typescript-language-server/blob/v6.0.2/package.json)는 Apache-2.0, Node ≥22.22.2, TS6 사용을 명시한다. 기존 protocol 3.18.4와 Monaco 0.57 공개 API를 사용했다. 임시 도구 설치는 배포 지원이나 자동 설치 기능이 아니다.

## 남은 경계

전체 플랫폼/성능/스크린리더/실제 host 재시작은 반복하지 않았다. 원격 host, 원본 편집, 서버 command/workspace edit, 다중 파일 refactor는 이 범위가 아니다. 신뢰한 LSP는 호스트 프로세스이므로 OS 파일 쓰기 격리를 보장하지 않는다. 롤백 전 언어 세션을 명시 종료하고 미확인 신원/예약을 삭제하지 않는다.
