# 편집 도구 비교

Hashline은 비교 실험에만 사용한다. Corral 제품 도구나 설치 의존성으로 추가하지 않는다.

원본은 [oh-my-pi의 고정 커밋](https://github.com/can1357/oh-my-pi/tree/647f9fa5dfae227d48a9588251f1a8439811e0e2)의 `pi-edit` 18.11.3이다. 원본 MIT 라이선스는 해당 저장소의 LICENSE에 있다. 이 디렉터리의 Rust 파일은 공개 `HashlineEngine.stage`를 호출하는 Corral의 작은 fixture adapter이며, Hashline 알고리즘을 복사하지 않는다. 해당 커밋은 nightly-2026-10-06 Rust toolchain을 지정한다.

```sh
git clone https://github.com/can1357/oh-my-pi /tmp/corral-hashline-source
git -C /tmp/corral-hashline-source checkout --detach 647f9fa5dfae227d48a9588251f1a8439811e0e2
mkdir -p /tmp/corral-hashline-source/crates/pi-edit/examples
cp tools/evaluation/hashline-driver.rs /tmp/corral-hashline-source/crates/pi-edit/examples/corral_fixture.rs
cargo +nightly-2026-10-06 build --manifest-path /tmp/corral-hashline-source/Cargo.toml -p pi-edit --example corral_fixture --locked
pnpm corral eval examples/eval/coding-tools.json --hashline-binary /tmp/corral-hashline-source/target/debug/examples/corral_fixture --out /tmp/corral-coding-tools-report.json
```

실제 실행 전 해당 소스와 실행 파일을 신뢰해야 한다. CLI는 지정한 바이너리를 shell 없이 실행한다. 자동 다운로드·설치·빌드는 하지 않는다. fixture driver는 제한된 입력과 임시 `fixture.txt` 한 개만 처리하며 변환을 stage하고 종료한다. 모델이나 사용자 저장소는 사용하지 않는다. 일반 CI에서는 주입된 Hashline transformer와 실제 Corral broker를 검증하며, 원본 Hashline 빌드는 이 명시적 로컬 실험에서 수행한다.

`{tag}`는 driver가 실제 읽은 파일에서 얻은 4자리 Hashline tag로 바꾼다. 전체 쓰기와 Pi edit도 같은 초기 bytes의 별도 Git 작업 사본에서 시작한다. stale fixture에서는 읽기 뒤 외부 변경을 넣고 세 방법 모두 거절해야 한다. 결과에는 원본 커밋·최종 내용 해시·바이너리 해시를 남기며 로컬 경로와 원문은 포함하지 않는다.

`correct`는 기대 최종 bytes 도달 여부다. 중복 문자열을 모호하게 지정한 Pi edit는 안전하게 거절하므로 이 값이 false여도 도구 결함을 의미하지 않는다. 전체 쓰기는 이미 완성된 정답 문자열을 입력받는 기준선이다. 인자 bytes는 토큰 수가 아니며 지연에는 각 transformer 프로세스 시작 비용이 포함된다. 실제 LLM의 편집 성공률·품질·토큰 절감을 이 결과로 주장하지 않는다.
