# H4 편집 도구 fixture 비교 결과

- 실행일: 2026-10-18. Node 24.19.0, Linux, 실제 Corral broker 및 새 Git 작업 사본.
- Pi edit 1.3.0, OMP pi-edit 18.11.3 / Hashline v2, Rust debug build. 유료/외부 모델 호출 없음.
- 원본 Hashline commit: `647f9fa5dfae227d48a9588251f1a8439811e0e2`.
- 실행 파일 SHA-256: `38016e0346b34e0ad14cb0b78a5481ddb3cf98c0b14fac6e544cb537c2f14b81`.

| 방법 | 기대 bytes 도달/보호 | 적용 | 거절 | 정상 편집 지연 중앙값(ms) |
|---|---:|---:|---:|---:|
| full_write | 6/6 | 5 | 1 | 2.33 |
| pi_edit | 5/6 | 4 | 2 | 571.17 |
| hashline | 6/6 | 5 | 1 | 9.39 |

단일 줄, 다중 블록, BOM+CRLF, 한글/유니코드 및 마지막 줄 개행 없음에서 세 방법이 같은 최종 bytes를 만들었다. 읽기 뒤 외부 변경을 넣은 fixture는 세 방법 모두 변경 없이 거절했다.

중복 문자열을 문맥 없이 지정한 Pi edit는 모호한 일치를 안전하게 거절했다. Hashline은 지정한 세 번째 줄을 바꿨다. 이는 준비된 입력의 표현력 차이를 확인한 것이며 Pi 결함이나 실제 모델 정확도 차이라는 뜻이 아니다.

전체 쓰기는 완성된 정답 문자열을 입력받는다. 지연에는 각 변환 프로세스의 시작 비용이 들어가며, Pi의 임시 Node worker와 Rust 실행 파일의 비용이 다르다. 토큰 절감·LLM 품질 향상·일반 성능 우위를 주장하지 않는다. Hashline을 기본 도구로 채택하지 않는다.

상세 상태·인자 bytes·초기 커밋·최종 해시는 [JSON 결과](Harness-Coding-Tools-Results.json), 재현은 [fixture 실행 안내](../../tools/evaluation/README.md)를 따른다.
