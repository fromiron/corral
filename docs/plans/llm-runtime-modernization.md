# LLM runtime modernization execution

Approved by CR-052. Baseline `401bdf463efab4784cb25c686867ed18f2c5379c`.

| Stage | Task | Completion evidence |
|---|---|---|
| P0 | C-179: route inventory, precedence, CR/ADR and failing probes | 호출 그래프·전송 경계 원장·실제 우선순위·CR/ADR 개정 완료 |
| P1 | C-180: request identity, shared admission and durable accounting | 공통 admission·attempt/operation 원장·late usage·unknown outcome 검사 완료 |
| P2 | C-181: host transport, retry control and delta IPC | Core/SDK 일반/격리 host 전송·Bedrock/HTTP loopback·선형 IPC·105회 실행 확인 |
| P3 | C-182: context/cache/tool ports and checkpoint representation | 공통 압축·최초 대형 입력·원문 복구/fork·필수 Skill·usage anchor 검사 완료 |
| P4 | C-183: unlimited migration, meetings, judge, progress and modalities | 무제한 새 revision·회의 증분 병렬·심판 합계 입력·정체 관측·modality loopback 완료 |
| P5 | C-184: compatibility, live A/B, bundle parity and license evidence | 최종 Core A/B 공급자별 30쌍, Linux 패키지 검증. 전체 gate의 기존 실패와 외부 미검증은 증거에 분리 |

The source of task status is contracts/backlog.json. No stage is complete merely because its interfaces or tests exist. Old data and receipt identities are preserved. Implementation checks use mock/loopback; live verification reuses the authorized ChatGPT subscription and Hive DeepSeek profiles and records incomplete quota-limited experiments.

세부 결과: [구현 보고서](../evaluation/llm-modernization/report.md), [측정 원장](../evaluation/llm-modernization/measurements.md). 실제 Realtime/image·다른 OS·동시성별 live 지연·SDK 일반 과제 품질 동등성은 검증하지 않았다. 기존 전체 UI 회귀 실패 9개는 기준선에서 재현했으며 이 변경으로 숨기거나 삭제하지 않았다.
