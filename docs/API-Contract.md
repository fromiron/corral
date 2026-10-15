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
| GET /session | — | 세션 cookie가 유효하면 `{ok:true,csrfToken}`. 모든 변경 요청은 `x-corral-csrf` 헤더로 이 값을 보낸다 |
| GET /runs | — | 실행 이력(최신 먼저): runId, status, corralId, startedAt |
| GET /runs/:id | — | RunSnapshot: 실행에 쓴 정의·definitionHash·출처 revision·criteriaVersionId·mode |
| GET /runs/:id/artifact-versions/:artifactVersionId | — | 불변 본문 `{text}`. 이 run의 산출물 버전과 기준 버전만 |
| POST /corrals/:id/duplicate | `{name}` | 새 id의 사본(revision 1) |
| DELETE /corrals/:id | — | 저장 정의 삭제. 이미 시작한 Run의 snapshot에는 영향 없음 |

P8 입력·기록 주소. 문서 도구에는 이 주소에서 받은 ID만 전달하며 로컬 경로나 원시 URL을 전달하지 않는다.

| Method/path | 요청 | 응답·효과 |
|---|---|---|
| GET /documents | — | 등록 입력의 ID, 종류, 제목, MIME, 바이트 수. 원문·원시 URL 없음 |
| POST /documents/import | `{title,mimeType,text}` 또는 `{url}` | `text/plain`·`text/markdown` 문서를 불변 `documentId`로 저장하거나 공개 HTTPS DNS를 확인하고 `sourceId`로 등록. 중복 입력은 같은 ID |
| POST /runs/:id/export | `{privateTranscript?:boolean}` | 기본은 원문 없는 공개 요약. 명시적 `true`만 비공개 원문 archive |
| POST /history/import | archive | 검증한 읽기 전용 기록. 실행·effect 재전송·현재 workspace 기록 삽입 없음 |

`POST /session`은 기존 204 응답과 함께 `x-corral-csrf` 헤더도 반환한다. 그 외 API 변경 요청은 세션 cookie, 허용 Origin, 세션 CSRF token을 모두 요구한다. API query string의 credential 키 이름은 거절하며 값은 오류에 반영하지 않는다. 요청 본문은 2 MiB(초과 413), 등록 문서는 UTF-8 1 MiB, workspace 입력은 32 MiB·1,000개로 제한한다. 로컬 서버 전체에서 분당 읽기 1,200회·변경 120회(bootstrap 포함), 동시 SSE 16개를 허용하며 초과 시 429다.

`read_document`는 `{documentId}` 또는 `{sourceId}`만 받는다. URL 읽기는 live Run에서만 실행하며 각 연결·redirect에서 모든 DNS 주소를 검사하고 검사한 IP로 연결을 고정한다. HTTPS 443·정상 TLS 인증서·최대 3회 redirect·전체 30초·1 MiB·UTF-8 text/Markdown만 허용한다. HTML·압축 응답·사설/특수 주소·URL 자격 증명은 거절한다. 원격 본문도 불변 documentId로 저장한다.

`search`는 `{query,provider?:"corpus"|"brave",limit?:1..10}`이며 기본은 등록 문서의 키 없는 corpus 검색이다. Brave는 live Run, 명시적 `provider:"brave"`, 서버의 `--allow-live-search`, backend 환경의 `BRAVE_SEARCH_API_KEY`를 모두 요구한다. `--search-request-limit`은 서버 세션 전체의 요청 수(실패 포함)를 제한하며 기본 10·최대 100이다. 자동 재시도·provider 전환은 없고, 결과 URL은 검증 후 sourceId로만 반환한다. Provider 인증 헤더는 redirect에 전달하지 않는다.

모델 로그인 주소(P3, C-058). 응답은 상태와 만료만 담고 token·키·콜백 주소는 담지 않는다([ADR-019](Decisions.md)).

| Method/path | 요청 | 응답·효과 |
|---|---|---|
| GET /model-profiles | — | profileId, provider, modelId, modelName, available, reasoning, contextWindow, maxOutputTokens, method(`oauth`·`api_key`·null), keyConfigured |
| GET /model-auth | — | provider별 signedIn, method, subscription, expiresAt, 진행 중 login(state·authUrl·error) |
| POST /model-auth/:provider/login | — | 202. provider 자체 로그인 시작. 사용자가 여는 authUrl을 돌려준다 |
| POST /model-auth/:provider/login/callback | `{url}` | 브라우저의 최종 redirect 주소(자동 콜백이 닿지 않을 때) |
| DELETE /model-auth/:provider/login | — | 진행 중 로그인 취소 |
| DELETE /model-auth/:provider | — | 로그아웃. 저장한 자격 증명 삭제 |

SSE는 영속 이벤트(`event: domain`, `id: runSeq`) 외에 모델 출력 조각을 `event: stream`으로 보낸다. 이 frame에는 id가 없어 재접속 cursor를 움직이지 않고, 저장하지 않으며, 나중에 연결한 구독자에게 다시 보내지 않는다. live 실행 전에 로그인이 없으면 `POST /runs`는 403 `CAPABILITY_DENIED`다.

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
| POLICY_ERROR | 500 | admission gate가 예외로 실패해 요청·도구 호출을 거절함(fail closed). 통과로 처리하지 않음 (CR-003, ADR-024, C-067) |

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
| `message.question_created` | questionId,taskId,sender,targetRole,body,refs,deadline. 구현(P4): taskId는 이 질문에 답하려고 만든 응답 Task이며, 응답 실행은 질문자의 자식이다 |
| `message.answer_committed` | questionId,responseTaskId,body,refs |
| `message.closed` | questionId,answer|cancel|timeout. 닫힌 뒤의 reply는 `observation.late`(originalEventType `reply`)로만 남는다 |
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
| `model.usage_reconciled` | executionId,modelCallId,rawUsage,normalizedUsage,certainty. 종료 후 새로 확인된 사용량만 보충하며 응답 본문·실행 상태는 바꾸지 않음 |
| `budget.reserved` | reservationId,amount,scope |
| `budget.settled` | reservationId,actual,unknownOutstanding |
| `limit.reached` | limitKind,used,reserved,max |
| `cancel.requested` | scope,fenceSeq,reason |
| `cancel.confirmed` | scope,settlementRefs |
| `observation.late` | originalEvent,whyIgnored |
| `output.finalized` | artifactVersionIds,approvalId |
| `decision.requested` | decisionId,questionKind,questionVersion,provider@version,privacy,subject(runId,executionId,attemptNo,modelCallId,contextSnapshotId),inputHash. (CR-003, C-068) |
| `decision.observed` | decisionId,answer,probabilities,evidenceLevel,latencyMs,readyBeforeDispatch,afterRequestFinished. 관찰 전용이며 요청에 적용되지 않음. `readyBeforeDispatch`·`afterRequestFinished`는 기록 시점에 commit된 Run에서 Coordinator가 채운다 |
| `decision.failed` | decisionId,reason(`timeout`·`invalid_response`·`provider_error`·`unavailable`·`cancelled`),latencyMs |

CR-003(C-068)에서 함께 바뀐 기존 payload: `effect.admitted.kind`에 `decision`(외부 provider만), `limit.reached.limitKind`에 `decision_calls`, `run.started.decisions`(선택: 모드·provider snapshot·maxCalls). runtime에 판정 설정이 없으면 `decisions` 필드가 없다(브라우저 데모·기존 Run). 서버는 항상 기록하며 기본값은 `off`다.

구현(P5)에서 정한 검토·승인 규칙:

- `approval.requested.kind`는 `user_action`(approval 모드 Decision, 또는 판정할 수 없는 검토), `loop_cap`(Loop 상한에서 한 라운드 더), `final_output`(Output의 `requireApproval`) 중 하나다. `subjectVersions`의 첫 항목이 승인 대상 버전이고, 뒤에 마지막 검토 버전이 붙는다.
- `resolve_approval`의 `subjectVersionId`는 `subjectVersions[0]`이어야 한다. 검사 순서: 없는 승인 `TARGET_NOT_FOUND` → 이미 해결 `APPROVAL_STALE` → `expectedControlRevision` 불일치 `STALE_CONTROL_REVISION` → 다른 버전 `APPROVAL_STALE`. 같은 commandId 재전송은 처음 receipt를 돌려준다.
- 검토 본문이 `review.schema.json`이 아니거나, 대상이 검토자가 받은 입력이 아니거나, 기준이 Run의 `criteriaVersionId`가 아니면 `review.recorded.verdict`는 `inconclusive`이고 `user_action` 승인으로 넘어간다. 통과로 처리하지 않는다.
- 설치 정책의 Loop hard cap에 닿으면 승인 없이 `limit.reached`(`loop_iterations`)와 함께 Run이 실패한다. 거절한 `loop_cap`·`final_output`은 Run을 취소로 끝낸다.
- 같은 Agent가 다음 Loop 라운드에 쓴 버전은 같은 artifactId의 다음 version이다. 투영의 `parentVersionId`가 이전 버전을 가리킨다.

## 5. timeout·재연결·다중 탭

브라우저 timeout은 서버 명령 실패와 같지 않다. 같은 commandId로 receipt를 조회/재전송한다. 새 ID로 취소/승인을 재시도하면 이중 의미가 생길 수 있으므로 client SDK가 처리한다.

workspace의 활성 Run은 하나지만 탭은 여러 개일 수 있다. 탭별 controlRevision 갱신과 conflict UI가 필요하다. SSE가 끊겼다고 Run을 자동 취소하지 않는다. Run-level wall deadline과 승인 대기 상태를 유지한다.

SSE의 일반 미전송 데이터는 다음 UTF-8 frame을 포함해 1 MiB로 제한한다. 초과하면 이미 쓴 prefix를 flush하고 연결을 종료하여 재접속 cursor가 앞으로 진행한다. 단일 committed domain event가 1 MiB보다 크면 구독을 먼저 해제하고 기존 prefix를 flush한 뒤, 그 이벤트 하나를 64 KiB 이하의 UTF-8 바이트 조각으로 순차 전송한다. 각 쓰기의 완료를 기다리며, 완전한 frame을 보낸 뒤 연결을 닫는다. 10초 동안 flush되지 않는 소켓은 강제 종료한다. 다음 연결은 완전히 받은 이벤트의 cursor부터 재개한다. 기존에 저장한 큰 이벤트도 생략·축약하지 않는다([CR-002](change-requests/CR-002-oversized-domain-replay.md), [ADR-023](Decisions.md)).

추가 전송 큐는 1 MiB 이내이고, 큰 이벤트 전송·파싱에는 현재 domain record 하나의 직렬화 크기에 비례하는 메모리가 필요하다. HTTP 입력의 2 MiB 제한이 patch의 before+after나 기존 내부 기록의 event 크기를 제한하지는 않는다. 클라이언트는 서버 형식의 domain frame 하나를 끝까지 조립한 뒤 RunEvent schema를 검사한다. 잘못된 domain event는 오류로 중지하고 무한 재시도하지 않는다. 고정 상한 예외는 128자 이내의 서버 형식 domain 헤더에만 적용한다. domain이 아닌 frame·주석·불완전 헤더는 2 MiB UTF-8 이내다. 비영속 텍스트 frame·heartbeat는 큰 domain event의 예외를 사용하지 않는다.
