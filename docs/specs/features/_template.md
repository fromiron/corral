# 기능 명세: <제목>

- 상태: proposed / accepted / implemented
- 비목표:

## 사용자 관측 동작

누가 어떤 상태에서 무엇을 조작하고 무엇을 보게 되는가. 접수와 실제 효과를 나누어 작성한다.

## 계약

입력 스키마 / 필수 참조 / 상태 precondition / 이벤트 순서 / effect admission / 멱등성 / 오류코드 / 취소 / timeout / revision 충돌 / secret 처리.

## 수용 시나리오

정상, 거절, 중복, 취소와 경합, 늦은 결과, 저장 실패를 `.feature` 파일이나 아래 형식으로 쓴다.

```gherkin
Given <사전 상태>
When <명령 또는 관측>
Then <사용자가 확인할 결과>
And <반드시 지켜야 하는 불변식>
```

## 보안·성능·접근성

영향 없음도 이유를 기록한다. 라이브러리 API 사실은 잠근 버전의 링크와 line/commit을 남긴다.
