# Corral — HTTP·이벤트·오류 계약

## 1. 명령과 조회

모든 주소는 제안된 로컬 same-origin `/api/v1` 기준이다. 인증 세션, workspace binding, Host/Origin 검사 후 처리한다. API key는 이 API의 응답에 포함하지 않는다.

| Method/path | 요청 | 응답·효과 |
|---|---|---|
| GET /corrals | cursor? | 정의 목록; 본문·레이아웃은 필요 시 조회 |
| POST /corrals | 정의+레이아웃 | 새 저장 정의. clone 시 ID 재발급 |
| GET /corrals/:id | — | definition/layout/revisions |
| PUT /corrals/:id | If-Match definition revision,definition | conflict 검사 후 저장; 실행 중 Run 원본에는 영향 없음 |
| POST /corrals/validate | 현재 draft definition | diagnostics + executable IR summary; side effect 없음 |
| POST /runs | commandId,corralId,definitionRevision,input,mode | runId+receipt; validation 완료 전 모델 호출 없음 |
| GET /runs/:id/snapshot | — | read model + snapshotSeq |
| GET /runs/:id/events?after=N | cursor | commit된 domain events의 SSE; token frames 별도 type |
| POST /runs/:id/commands | command.schema.json | accepted receipt 또는 4xx; HTTP202는 적용 완료가 아님 |
| GET /runs/:id/commands/:commandId | — | command 상태·관련 events·적용 scope |
| GET /runs/:id/artifacts/:artifactId/versions/:version | — | 불변 본문·생성/읽기/지시/검토 경로 |
| GET /model-profiles | — | public profileId·지원 capability·keyConfigured, secret 없음 |
| POST /runs/:id/export | redaction policy | 공개용 bundle. 원문 비공개가 기본 |

구현 중 추가한 주소(P2, [ADR-022](Decisions.md)). 모두 같은 세션·Host/Origin 검사를 거친다. `health`와 `POST /session`만 세션 없이 받는다.

| Method/path | 요청 | 응답·효과 |
|---|---|---|
| GET /health | — | `ok`, schemaVersion, version, backendSessionId, agents(`mock`). secret 없음 |
| POST /session | `{token}` | 일회성 bootstrap token을 교환해 HttpOnly·SameSite=Strict 세션 cookie. 재사용은 401 |
| GET /session | — | 세션 cookie가 유효하면 200 |
| GET /runs | — | 실행 이력(최신 먼저): runId, status, corralId, startedAt |
| GET /runs/:id | — | RunSnapshot: 실행에 쓴 정의·definitionHash·출처 revision·criteriaVersionId·mode |
| GET /runs/:id/artifact-versions/:artifactVersionId | — | 불변 본문 `{text}`. 이 run의 산출물 버전과 기준 버전만 |
| POST /corrals/:id/duplicate | `{name}` | 새 id의 사본(revision 1) |
| DELETE /corrals/:id | — | 저장 정의 삭제. 이미 시작한 Run의 snapshot에는 영향 없음 |

`POST /runs`는 `CreateRunRequest`만 받는다(정의 본문을 직접 보내면 400). 같은 commandId의 재전송은 200과 처음 receipt, 새 Run은 201이다. 두 번째 활성 Run은 409 `RUN_ALREADY_ACTIVE`다. `PUT /corrals/:id`는 `If-Match`에 기준 definition revision이 없으면 400, 다르면 409 `REVISION_CONFLICT`다. 명령 응답의 HTTP 상태는 receipt를 따른다: 거절은 오류 코드의 상태, `accepted`·`queued`는 202, 그 밖은 200이다.

SSE event는 `id: runSeq`, `event: domain`을 가진다. SnapshotSeq 이하 event는 재적용하지 않는다. Last-Event-ID와 after가 충돌하면 서버 계약으로 하나를 선택하고 오류/우선순위를 문서화한다. 첫 구현은 Last-Event-ID가 유효하면 우선한다. 범위 밖 cursor·다른 Run cursor는 400이다.

## 2. Receipt

receipt는 commandId, runId, status, acceptedSeq, target, requestedBoundary, relatedEventIds, error를 갖는다. status는 `accepted / queued / applied / rejected / superseded / expired / cancelled`다. 일부 target에만 적용하는 다중 대상 steer는 MVP에 제공하지 않아 부분 적용 모델을 미룬다.

steer receipt의 applied는 입력 dispatch 확인을 의미한다. 품질 준수 여부는 review로 별도 표시한다. 설정 patch의 applied는 policy commit이며, 미래 execution이 실제 사용한 patch.activated와 구분한다.

## 3. 오류

| 코드 | HTTP | 의미 |
|---|---|---|
| SCHEMA_INVALID | 400 | 이해하지 못하는 형식·unknown field |
| GRAPH_INVALID | 422 | 포트·Loop·role·binding 등 의미 불일치 |
| CAPABILITY_DENIED | 403 | 도구/질문/위임 관계가 허용되지 않음 |
| STALE_CONTROL_REVISION | 409 | 준비 중 다른 제어 변경이 발생 |
| IDEMPOTENCY_CONFLICT | 409 | 같은 commandId에 다른 payload |
| TARGET_NOT_FOUND | 404 | 대상 Run·실행·작업이 없음 (구현 중 추가, P0 C-053) |
| COMMAND_NOT_SUPPORTED | 501 | 형식은 올바르지만 현재 runtime 단계에서 아직 처리하지 않는 명령. 효과 없음 (구현 중 추가, P1 C-005) |
| TARGET_TERMINAL | 409 | 종료된 실행에 지시 등 적용 불가 |
| REVISION_CONFLICT | 409 | Corral 저장의 기준 definition revision이 현재와 다름(다른 탭에서 저장). 저장하지 않음 (구현 중 추가, P2 C-015) |
| RUN_ALREADY_ACTIVE | 409 | workspace에 이미 활성 Run이 있음(스펙 §6.2). 새 Run과 effect 없음 (구현 중 추가, P2 C-057) |
| RESOURCE_CAPACITY | 409 | 동적 자식/응답 worker 용량 예약 실패. 부모를 무기한 대기에 넣지 않음 |
| CRITERIA_CHANGE_REQUIRES_NEW_RUN | 409 | Loop가 이미 종료되어 완료 기준 변경은 새 Run 필요 |
| RESTART_NOT_ALLOWED | 409 | 부모가 더 이상 대기하지 않거나 downstream 진행 |
| APPROVAL_STALE | 409 | 대상/기준 버전 변경 또는 이미 해결 |
| LIMIT_REACHED | 409 | 새 effect admission 불가; 별도 approval/상한 변경 필요 |
| STORAGE_UNAVAILABLE | 503 | 사실 기록이 불가하므로 신규 admission 닫음 |
| SESSION_INVALID | 401 | 세션/부트스트랩 오류 |
| ORIGIN_REJECTED | 403 | 허용하지 않는 Origin/Host/CSRF |

provider/network error는 사용자 키 원문·응답 헤더를 포함하지 않는다. trace용 errorId와 마스킹된 이유를 제공한다. 도구 실행 중 실패는 HTTP success/error와 별개로 ToolOutcome에 structured error를 넣는다.

## 4. 이벤트 payload 목록

봉투 schema만 이 팩에 포함되어 있다. 아래 payload별 검증은 C-005에서 Zod discriminated union으로 구현하고 fixture를 늘린다. causal graph는 cause 1개에 한정하지 않는다.

| type | 반드시 기록할 내용 |
|---|---|
| `run.started` | 정의/입력/모델 snapshot과 최초 limits |
| `run.state_changed` | from,to,reasonCode |
| `run.interrupted` | previousStatus,backendSessionId |
| `execution.created` | parentExecutionId,nodeId,taskId,attemptNo,depth,iterationId |
| `execution.state_changed` | from,to,activity,waitingOn |
| `execution.settled` | outcome,terminationMode,error |
| `task.created` | role,node,contract,dependencies |
| `task.attempt_assigned` | executionId,attemptNo |
| `task.submitted` | artifactVersionIds |
| `task.completed` | completionEvidence |
| `task.blocked` | cause,requiredUserAction |
| `message.question_created` | questionId,taskId,sender,targetRole,body,refs,deadline |
| `message.answer_committed` | questionId,responseTaskId,body,refs |
| `message.closed` | questionId,answer|cancel|timeout |
| `artifact.version_created` | artifactId,version,bodyRef,hash,parentVersion,authorExecutionId,modelCallId,contextSnapshotId |
| `artifact.read` | requestedRef,resolvedVersionId,consumerExecutionId |
| `review.recorded` | reviewVersion,targetVersion,criteriaVersion,verdict,issues |
| `review.stale` | reviewVersion,newCriteriaVersion,cause |
| `loop.iteration_started` | iterationId,no,pinnedCarryInputs,criteriaVersion |
| `loop.iteration_finished` | outcome,submittedVersions |
| `approval.requested` | approvalId,kind,subjectVersions,criteriaVersion |
| `approval.resolved` | decision,actor,subjectVersions |
| `directive.accepted` | directiveId,target,body,commandId |
| `directive.attached` | contextSnapshotId,modelCallId |
| `directive.dispatched` | modelCallId,executionEpoch |
| `directive.undelivered` | reason |
| `patch.committed` | patchId,scope,before,after,controlRevision |
| `patch.activated` | patchId,executionId|iterationId |
| `effect.admitted` | effectId,scope,epoch,reservationId |
| `effect.dispatch_observed` | effectId,providerRequestId |
| `effect.settled` | effectId,outcome |
| `tool.requested` | toolCallId,name,validatedArgs |
| `tool.allowed` | toolCallId,policyVersion |
| `tool.blocked` | toolCallId,reason |
| `tool.started` | effectId,toolCallId |
| `tool.finished` | resultRef,error |
| `model.request_prepared` | modelCallId,contextSnapshotId,profile,configRevision |
| `model.finished` | responseRef,rawUsage,normalizedUsage,certainty |
| `budget.reserved` | reservationId,amount,scope |
| `budget.settled` | reservationId,actual,unknownOutstanding |
| `limit.reached` | limitKind,used,reserved,max |
| `cancel.requested` | scope,fenceSeq,reason |
| `cancel.confirmed` | scope,settlementRefs |
| `observation.late` | originalEvent,whyIgnored |
| `output.finalized` | artifactVersionIds,approvalId |

## 5. timeout·재연결·다중 탭

브라우저 timeout은 서버 명령 실패와 같지 않다. 같은 commandId로 receipt를 조회/재전송한다. 새 ID로 취소/승인을 재시도하면 이중 의미가 생길 수 있으므로 client SDK가 처리한다.

workspace의 활성 Run은 하나지만 탭은 여러 개일 수 있다. 탭별 controlRevision 갱신과 conflict UI가 필요하다. SSE가 끊겼다고 Run을 자동 취소하지 않는다. Run-level wall deadline과 승인 대기 상태를 유지한다.
