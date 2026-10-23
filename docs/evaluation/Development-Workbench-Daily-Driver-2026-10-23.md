# P28 JS/TS 일상 개발 — 코어 인수

- 기준: `a3711bc`의 P26·P27 구현과 이 문서를 포함한 인수 묶음. CR-046 P28, CRL-WBD-025/C-169/TC-WBD-025-H,N,F.
- Linux x64, Node 24.19.0, 실제 격리 Git/SQLite와 production Studio. 새 제품 기능이나 의존성 없이 기존 개발 기능의 연결을 확인했다. 외부 계정·유료 호출은 사용하지 않았다.

## 같은 소스를 끝까지 유지하는 통합 시험

`apps/server/test/workbench-journey.test.ts` 한 개에서 인증된 HTTP client와 실제 Git을 사용했다. TS import 검사 실패 → 두 파일의 저장된 텍스트 교체 → 같은 검사 통과 → branch/stage/commit → 로컬 bare remote push → 배포 검토/실행/명시 readback을 연결했다. 검사 tree·commit tree·배포 source가 같고, 오래된 source fingerprint는 실행 전에 거절되며, 중복 시작에도 배포 명령은 한 번만 실행됐다. 원본과 remote의 기존 main은 보존됐다.

최종 1/1 PASS(`/tmp/corral-p28-journey-final.log`, 5.32초), server 타입 검사(`/tmp/corral-p28-journey-types.log`)와 변경 파일 Biome이 통과했다. 기존 구현에 대한 인수 시험이 처음부터 통과했으므로 인위적인 red를 만들지 않았다. 이 시험은 Node의 실제 TS import와 프로그램 검사를 사용하며 언어 서버 진단 시험이라고 보고하지 않는다.

## 실제 편집 화면

인앱 브라우저 1280×720의 별도 사본에서 실제 TypeScript Language Server 6.0.2와 TypeScript 6.0.3을 사용했다.

1. 등록 검사에서 `src/main.ts`의 string→number 타입 오류를 확인하고 Problems에서 해당 2행으로 이동했다. 언어 서버도 같은 오류를 보고했으며 버전 없는 진단은 계속 버전 미확인으로 표시했다.
2. `result: string`으로 수정해 미저장 상태로 설정을 열고 Escape로 닫았다. 같은 문서와 초안이 남고 포커스는 설정 버튼으로 돌아왔다. Undo로 마지막 줄바꿈을 되돌리고 Redo로 복원한 뒤 명시 저장했다. 저장 전 언어 진단은 갱신되지만 이전 검사 결과는 현재 검사로 승격되지 않았다.
3. 내용 검색의 `greet`→`welcome` 변경안을 검토·적용했다. TS 3개 파일의 호출/정의 5곳과 검사 스크립트의 로그 문구 1곳이 바뀌었다. 다시 실행한 TypeScript 및 프로그램 검사가 종료 코드 0으로 통과했고 이전 실패는 이전 버전 기준으로 남았다.
4. 사본 디스크의 저장 내용과 원본의 기존 타입/함수 이름·clean Git을 별도로 확인했다. 언어 서버를 명시 종료하고 fixture 서버·사본·탭을 정리했다. 임시 화면 증거는 `/tmp/corral-p28-edit-check.png`다.

390px 패널·대화 전환과 키보드 확인은 [P29 기록](Development-Workbench-Qualification-2026-10-23.md)에 있다. UI와 통합 시험의 여정을 한 브라우저에서 외부 배포까지 모두 실행한 것처럼 합치지 않는다.

## 재사용한 증거와 경계

동일 기준선에 포함된 [P22 live edit](Development-Workbench-Shared-Development-2026-10-23.md), [P20 preview 피드백](Development-Workbench-Preview-Feedback-2026-10-23.md), [P25 Git 충돌](Development-Workbench-Advanced-Git-2026-10-23.md), [P26 실제 Node/Chromium 디버깅](Development-Workbench-Debugging-2026-10-23.md), [P27 배포 화면](Development-Workbench-Deployment-2026-10-23.md)은 해당 commit·환경의 증거로 연결했다. 사용자 요청에 따라 이 전체 흐름을 반복하지 않았다.

현재 코어 인수는 AI 미연결 수동 개발을 확인한 Linux 로컬 결과다. 실제 외부 Git/provider 배포·AI 이미지 피드백·다른 OS/adapter·설치판 전체 여정은 별도 환경 인수이며 G4/G5 전체 출시 판정으로 확대하지 않는다.
