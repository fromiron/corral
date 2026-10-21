# 리소스 관리 구현·실행 증거 — 2026-10-18

CR-022 / C-085. 당시 계획 (Git `373764467a52:docs/plans/Resource-Management-Plan.md`)의 최종 검증 절을 이관했다. 아래 hash·Run ID·결과는 당시 기록이며 문서 정리에서 다시 실행한 결과가 아니다. 현재 상태는 [상태표](../status.md)를 따른다.

## 검증 증거

초기 완성 후보는 무료 테스트 1,001개 통과·5개 opt-in skip, 로컬 act PR gate와 E2E 83개 통과·1개 opt-in skip을 확인했다. 전체 E2E 수는 84개로 유지했다. Electron 패키지는 호스트 Node/pnpm 없는 실행, 재시작, SQLite 이력, 초안·테마·경로 복원, renderer/sidecar 복구 smoke를 통과했다.

패키지에 포함된 Node/server/Studio를 별도 작업 공간에서 실행하고 인앱브라우저로 작성·등록·신뢰·선택을 조작했다. 첫 실계정 Run `run_2dbac286383d44cdb1c774917d637093`는 두 역할이 각각 SKILL.md 읽기 → 로컬 MCP read_evidence → 결과 작성·제출을 완료했다. wire 메타데이터는 GPT-6.1 Sol/low 4회, GPT-6 Luna/medium 4회를 확인했다. 생성한 session_start Hook과 가져온 tool_result Hook은 두 역할에서 모두 실행됐다. Native Electron 전체 조작과 인앱브라우저의 패키지 UI 조작은 서로 다른 증거다.

최종 공통 확인 창은 기존 리소스 E2E에 취소·포커스 복귀·재확인·보관/복구 검증을 추가해 확인했다. 최종 로컬 act도 테스트 1,001개 및 E2E 83개를 통과했다(각각 5개·1개 opt-in skip). 새로운 E2E 시나리오는 추가하지 않았다.

추가 실계정 Run `run_1eba881f0a084f08a50777390ead7e94`는 최종 패키지 API로 검증했다. 편집한 SKILL.md의 알 수 없는 메타데이터를 보존했고, 두 역할이 읽은 내용과 제출 결과에 `SKILL_COPY_V2`를 확인했다. 생성한 확인 Hook의 요청·응답은 각각 2건이었다. 해제한 알림/결과 Hook의 알림은 0건이었다. 첫 확인 Hook 대기 중 MCP를 비활성화해도 기존 Run은 고정 설정으로 성공했고, 다음 실행 미리보기에는 `mcp_server_disabled`가 나타났다. 현재 역할에서 사용 중인 MCP 삭제는 거절됐으며, 사용을 해제한 뒤 삭제·복구하면 비활성 상태로 돌아왔다. 리소스 보관·복구와 첫 Run snapshot 불변도 확인했다. 실제 모델 호출은 두 Run 합계 16회이며, 모든 요청이 Sol/low 또는 Luna/medium으로 전송됐다.

최종 AppImage SHA-256: `a4aad61527784d4caf6f1c52e0337203a33cd7d87b290a6c036650635217f2dc`. 해당 패키지의 Electron smoke도 다시 통과했다. 원시 증거는 `live-first-evidence.json`, `live-second-evidence.json`, `api-lifecycle-result.json`, `act.log`, `desktop-smoke-final.log`에 기록했다.

검증 경계: 처음 등록·신뢰·연결 시험·역할 선택·실계정 Run은 인앱브라우저에서 직접 조작했다. 사본 저장 이후 브라우저 기본 확인 창 때문에 인앱 입력 도구가 응답하지 않아 후반 생명주기는 패키지 API로 수행했다. 이를 직접 UI 조작으로 주장하지 않는다. 최종 관리 확인 창과 보관/복구 UI는 production Studio E2E로 확인했다. Electron 네이티브 전체 수동 조작은 제공되지 않아 수행하지 못했다. 인증 정보와 실제 사용자 본문은 증거에 포함하지 않는다.
