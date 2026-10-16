# Corral Workbench 개선안 v0.1

프로젝트·세션 중심의 지속 작업, 파일 변경 검토, 다중 산출물, 검증, Reins를 기존 Corral Studio에 연결하는 제안이다.

- 기준: `fromiron/corral@a9ecda50175e614fe1f559152dd1974e016883e8` / 확인일 2026-10-16.
- 상태: 검토·구현 준비 문서. 저장소 코드·설정·브랜치·커밋을 변경하지 않았다.
- 포함: 40개 요구, 32개 구현 태스크, 56개 계획 테스트. **테스트 구현/실행 결과가 아니다.**
- 신규 앱 버전·release 일정은 확정하지 않았다. U0–U3는 이 개선의 내부 단계다.

## 읽는 순서

1. [제품 개선 명세](01-Improvement-Spec.md): 목적·범위·도메인·동작·요구 ID.
2. [UI/UX 명세](02-UX-Spec.md): 작업/팀/검토 화면, 전환·입력·오류·품질 목표.
3. [기술 설계](03-Technical-Design.md): 저장·API·이벤트·파일 효과·안전·migration.
4. [SDD·TDD 구현 플랜](04-Implementation-Plan.md): 단계·첫 PR·의존관계·Done.
5. [테스트 계획](05-Test-Plan.md): Given–When–Then, fault·security·E2E.
6. [근거와 결정](06-Sources-and-Decisions.md): 현재 소스 사실·외부 공식 자료·제안 구분.

[변경 요청 초안](specs/CR-WB-001.md)과 [기능 명세 템플릿](specs/Feature-Spec-Template.md)을 함께 제공한다. diagram 원본은 [도메인](diagrams/01-domain.mmd), [검토 흐름](diagrams/02-review-flow.mmd), [파일 효과](diagrams/03-file-effect.mmd)다. 이미지가 아니라 Mermaid 텍스트다.

## 핵심 선택

D&D는 팀 설계의 주요 화면으로 유지한다. Session은 여러 Run의 목적을 이어가고 Workspace는 실제 디렉터리를 분리한다. Output은 복수 결과로 확장한다. diff의 버전·출처·검토 scope를 고정한다. 기존 폴더는 먼저 관측하고 초기 쓰기는 managed worktree로 제한한다. 의견은 Reins와 후속 수정 Run에 연결한다. 실행·검증·검토·반영·commit을 구분한다.

## 기계 판독 자료

[requirements.json](requirements.json), [backlog.json](backlog.json), [test-cases.json](test-cases.json), [traceability.json](traceability.json)은 예정 작업 데이터다. 구현 코드나 실제 test runner가 아니다. [문서 검증 결과](validation-report.json)와 [무결성 목록](MANIFEST.sha256)을 포함한다.

## 적용 방법

먼저 CR과 기본값을 검토한다. 구현 담당은 기준 commit이 달라졌으면 소스 현황을 재검증한다. 문서를 저장소에 반영할 때 기존 spec·CR·ADR 번호와 연결한다. 첫 PR은 새 Shell·복수 결과·모의 Reins 상호작용으로 작게 시작하되, 이후 실제 파일 안전 gate를 생략하지 않는다.
