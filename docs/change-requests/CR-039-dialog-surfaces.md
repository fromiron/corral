# CR-039: 공용 대화상자 표면과 메시지 분기 여백 복구

- 기준: `bfd68e6`.
- 요청: Bell, 2026-10-19. 공용 DialogPopup의 투명 배경과 분기 창의 누락된 여백 수정. 디자인 개선에 leeskills 사용.
- 추적: CR-032/C-111/TC-CONTINUITY-001-H, CR-033/TC-UX-001-H/N의 기존 UI 계약 복구. 실행·분기 API·예산·schema 변경 없음.

## 진단과 변경

`dialog-glass` / `dialog-backdrop`에는 CSS 정의가 없다. 공용 popup은 기존 `surface-glass`(raised 82%, blur 12px)를 직접 재사용한다. 기본 backdrop은 명령 팔레트의 `bg-black/40`을 재사용한다. media variant의 투명 popup / 75% backdrop은 유지한다. 분기 창과 같은 누락이 확인된 세션 검색 창은 기존 DialogHeader / DialogPanel로 구성해 제목과 설명, 본문의 여백·스크롤 소유권을 맞춘다.

leeskills `review-components`, `review-visuals`, `verify-changes`(bundled commit `1472032c0521c7f76f8811973b4cbe6b67804988`)를 적용한다. 작업은 edit / targeted이며 기존 색·spacing·mobile sheet·닫기·focus 계약을 복구한다. 새 디자인 토큰·의존성·모션·실행 기능은 추가하지 않는다. 기존 컴포넌트의 공통 표면과 분기 경로, 밝음/어두움·좁은 화면·Escape 복귀를 검사한다. 새 viewport나 요소 수 전체를 열거하는 시험은 추가하지 않는다.

## 검증

기존 브라우저 분기/사이드바 시험에 실제 computed background·blur·padding 검사를 추가해 먼저 실패를 확인한다. 분기 생성·기존 navigation/focus 회귀도 함께 실행한다. 실계정 모델 호출과 설치형 앱 전체 QA는 범위 밖이다. 되돌릴 때는 이 수정 커밋만 revert하여 기존 사용자 데이터·설정·Run을 보존한다.

### 결과

- `red.log`: 실제 popup background가 `rgba(0, 0, 0, 0)`인 실패. `search-red.log`: 검색 창 공통 header 부재 실패.
- `browser-final.log`: 기존 브라우저 시험 5개 통과. light/dark의 배경·blur·24px padding, 390px 가로 overflow/주 동작 노출, 분기 생성·원본 연결·검색·초안 복귀·사이드바 Tab/Escape focus 복귀 포함. `visual.log`: 분기 전체 흐름과 렌더 이미지 재확인.
- Studio production build, Studio/React 타입 검사, 변경 파일 Biome·diff 검사 통과. 기존 utility와 Header/Panel만 재사용하며 hook/state/비동기 요청 경로는 유지했다.
- 화면 캡처는 합성 fixture만 사용했다. 전체 제품 재출시·설치형 앱·스크린리더 전체·성능/실계정 모델 검증은 이번 targeted 확인에 포함하지 않았다.
