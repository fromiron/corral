import {
  collaborationCorral,
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import { exportRunArchive, openRunArchive } from '../src/history.ts';
import {
  Coordinator,
  createAutoStarter,
  InMemoryRunStore,
  InProcessTransport,
  waitForProjection,
} from '../src/index.ts';

async function recordedRun() {
  const store = new InMemoryRunStore();
  const definition = linearCorral(['writer']);
  definition.name = 'private-title';
  const role = definition.roles[0];
  if (!role) throw new Error('role expected');
  role.prompt = 'private prompt /home/private key=sk-private';
  const runtime = new InProcessTransport(
    new Coordinator({
      store,
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({ turns: 1 }),
    }),
  );
  const { runId } = await runtime.startRun({
    schemaVersion: '0.1',
    commandId: 'cmd_archive',
    definition,
    mode: 'mock',
  });
  if (!runId) throw new Error('run not started');
  await waitForProjection(runtime, runId, (p) => p.status === 'succeeded');
  const { projection } = await runtime.getSnapshot(runId);
  return { store, runId, projection };
}

describe('record archives', () => {
  it('reopens answered questions without mistaking their IDs for artifact bodies', async () => {
    const store = new InMemoryRunStore();
    const runtime = new InProcessTransport(
      new Coordinator({
        store,
        clock: new FakeClock(),
        ids: new SequentialIdFactory(),
        agents: new ScriptedAgentAdapter({ turns: 1 }),
      }),
    );
    const { runId } = await runtime.startRun({
      schemaVersion: '0.1',
      commandId: 'archive_team',
      definition: collaborationCorral(),
      mode: 'mock',
    });
    if (!runId) throw new Error('run not started');
    await waitForProjection(runtime, runId, (p) => p.status === 'succeeded');
    const { projection: final } = await runtime.getSnapshot(runId);
    const question = Object.values(final.questions)[0];
    if (!question) throw new Error('question expected');
    expect(question.status).toBe('answered');
    const archive = exportRunArchive(store, runId, { privateTranscript: true });
    if (archive.visibility !== 'private') throw new Error('private archive expected');
    const reopened = openRunArchive(archive);
    expect(reopened.visibility === 'private' && reopened.projection).toEqual(final);
    expect(archive.artifacts).not.toHaveProperty(question.questionId);
    const badEvents = archive.events.map((event) =>
      event.type === 'tool.finished' && event.payload.resultRef === question.questionId
        ? { ...event, payload: { ...event.payload, resultRef: 'missing_question' } }
        : event,
    );
    expect(() => openRunArchive({ ...archive, events: badEvents })).toThrow(/question/);
  });

  it('reopens private history without a runtime or reissuing effects', async () => {
    const { store, runId, projection } = await recordedRun();
    const archive = exportRunArchive(store, runId, { privateTranscript: true });
    const reopened = openRunArchive(JSON.parse(JSON.stringify(archive)));
    expect(reopened.visibility).toBe('private');
    if (reopened.visibility !== 'private') throw new Error('private archive expected');
    expect(reopened.projection).toEqual(projection);
    expect(reopened.artifacts).toEqual(archive.visibility === 'private' ? archive.artifacts : {});
    expect(reopened).not.toHaveProperty('submit');
    expect(reopened).not.toHaveProperty('startRun');
    expect(Object.isFrozen(reopened.projection)).toBe(true);
  });

  it('reopens a completed auto run and rejects changed or missing route metadata', async () => {
    const store = new InMemoryRunStore();
    const coordinator = new Coordinator({
      store,
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({ turns: 1 }),
    });
    const runtime = new InProcessTransport(coordinator);
    const starter = createAutoStarter({ startRun: (request) => coordinator.startRun(request) });
    const { runId, autoRoute } = await starter.start(
      {
        commandId: 'cmd_auto_archive',
        brief: 'What is a run?',
        mode: 'mock',
        choice: { modelProfile: 'model-a', reasoning: { mode: 'route' } },
      },
      { fileTools: false },
    );
    if (!runId || !autoRoute) throw new Error('auto run expected');
    await waitForProjection(runtime, runId, (p) => p.status === 'succeeded');
    const { projection: final } = await runtime.getSnapshot(runId);
    const archive = exportRunArchive(store, runId, { privateTranscript: true });
    if (archive.visibility !== 'private') throw new Error('private archive expected');
    const opened = openRunArchive(JSON.parse(JSON.stringify(archive)));
    if (opened.visibility !== 'private') throw new Error('private archive expected');
    expect(opened.snapshot.autoRoute).toEqual(autoRoute);
    expect(opened.projection).toEqual(final);
    for (const altered of [undefined, { ...autoRoute, reason: 'Changed choice.' }]) {
      expect(() =>
        openRunArchive({ ...archive, snapshot: { ...archive.snapshot, autoRoute: altered } }),
      ).toThrow(/snapshot does not match its run start/);
      expect(() =>
        openRunArchive({
          ...archive,
          events: archive.events.map((event) =>
            event.type === 'run.started'
              ? { ...event, payload: { ...event.payload, autoRoute: altered } }
              : event,
          ),
        }),
      ).toThrow(/snapshot does not match its run start/);
    }
    expect(JSON.stringify(exportRunArchive(store, runId))).not.toContain('autoRoute');
  });

  it('exports only the current final artifact and declares internal response bodies unavailable', async () => {
    const { store, runId } = await recordedRun();
    const finished = store.readEvents(runId, 0).find((event) => event.type === 'model.finished');
    if (finished?.type !== 'model.finished' || !finished.payload.responseRef)
      throw new Error('response reference expected');
    const ref = finished.payload.responseRef;
    const archive = exportRunArchive(store, runId, { privateTranscript: true });
    if (archive.visibility !== 'private') throw new Error('private archive expected');
    expect(archive.formatVersion).toBe(3);
    expect(store.getArtifactText(runId, ref)).toBeNull();
    expect(archive.artifacts).not.toHaveProperty(ref);
    expect(archive.unavailableBodyRefs).toContain(ref);
    const output = store.getRun(runId)?.projection.output?.artifactVersionIds[0];
    if (!output) throw new Error('final artifact expected');
    expect(archive.artifacts[output]).toBe(store.getArtifactText(runId, output));
    expect(() =>
      openRunArchive({
        ...archive,
        artifacts: { ...archive.artifacts, [ref]: 'modified response' },
      }),
    ).toThrow();
    const bodies = { ...archive.artifacts };
    delete bodies[output];
    expect(() => openRunArchive({ ...archive, artifacts: bodies })).toThrow();
    expect(() =>
      openRunArchive({
        ...archive,
        unavailableBodyRefs: archive.unavailableBodyRefs?.filter((id) => id !== ref),
      }),
    ).toThrow(/availability manifest/);
  });

  it('public export defaults to an allowlisted timeline without user text or paths', async () => {
    const { store, runId } = await recordedRun();
    const archive = exportRunArchive(store, runId);
    const text = JSON.stringify(archive);
    for (const privateValue of [
      'private-title',
      'private prompt',
      '/home/private',
      'sk-private',
      runId,
    ])
      expect(text).not.toContain(privateValue);
    expect(openRunArchive(archive).visibility).toBe('public');
    expect(archive.events.length).toBeGreaterThan(0);
  });

  it('keeps criteria revision references without exporting their retired bodies', async () => {
    const store = new InMemoryRunStore();
    const gate = new Gate();
    const coordinator = new Coordinator({
      store,
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({
        turns: 1,
        beforeReply: (_turn, input) =>
          input.role.outputContract === 'review' ? gate.wait() : Promise.resolve(),
      }),
    });
    const transport = new InProcessTransport(coordinator);
    const { runId } = coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'criteria_history',
      definition: CorralDefinition.parse(researchTeam),
      mode: 'mock',
    });
    if (!runId) throw new Error('run expected');
    const active = await waitForProjection(transport, runId, (p) =>
      Object.values(p.executions).some(
        (execution) => execution.nodeId === 'review' && execution.modelCallIds.length > 0,
      ),
    );
    const receipt = coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'criteria_patch',
      runId,
      type: 'patch',
      expectedControlRevision: active.controlRevision,
      payload: {
        kind: 'criteria',
        baseCriteriaVersionId: active.currentCriteriaVersionId ?? '',
        criteria: ['new criterion'],
      },
    });
    expect(receipt.status).toBe('applied');
    const criteriaId = coordinator.getSnapshot(runId).projection.currentCriteriaVersionId;
    if (!criteriaId) throw new Error('patched criteria expected');
    expect(store.getArtifactText(runId, criteriaId)).toBe('new criterion');
    await transport.sendCommand({
      schemaVersion: '0.1',
      commandId: 'cancel',
      runId,
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'stop' },
    });
    gate.open();
    await waitForProjection(transport, runId, (p) => p.status === 'cancelled');
    expect(store.getArtifactText(runId, criteriaId)).toBeNull();
    const archive = exportRunArchive(store, runId, { privateTranscript: true });
    const opened = openRunArchive(archive);
    if (archive.visibility !== 'private' || opened.visibility !== 'private')
      throw new Error('private expected');
    expect(opened.artifacts).not.toHaveProperty(criteriaId);
    expect(archive.unavailableBodyRefs).toContain(criteriaId);
    expect(archive.events).toContainEqual(
      expect.objectContaining({
        type: 'patch.committed',
        payload: expect.objectContaining({
          after: expect.objectContaining({ criteriaVersionId: criteriaId }),
        }),
      }),
    );
    expect(() =>
      openRunArchive({
        ...archive,
        artifacts: { ...archive.artifacts, [criteriaId]: 'tampered criteria' },
      }),
    ).toThrow();
  });

  it('rejects missing, reordered, foreign, and unknown archive events', async () => {
    const { store, runId } = await recordedRun();
    const archive = exportRunArchive(store, runId, { privateTranscript: true });
    if (archive.visibility !== 'private') throw new Error('private archive expected');
    expect(() => openRunArchive({ ...archive, events: archive.events.slice(1) })).toThrow();
    expect(() => openRunArchive({ ...archive, events: [...archive.events].reverse() })).toThrow();
    expect(() => openRunArchive({ ...archive, runId: 'foreign' })).toThrow();
    expect(() => openRunArchive({ ...archive, formatVersion: 99 })).toThrow();
    expect(() => openRunArchive({ ...archive, events: archive.events.slice(0, -1) })).toThrow();
    expect(() =>
      openRunArchive({
        ...archive,
        snapshot: {
          ...archive.snapshot,
          definition: { ...archive.snapshot.definition, name: 'tampered' },
        },
      }),
    ).toThrow();
    const artifactId = Object.keys(archive.artifacts).find(
      (id) => id !== archive.snapshot.criteriaVersionId,
    );
    if (!artifactId) throw new Error('artifact expected');
    expect(() =>
      openRunArchive({ ...archive, artifacts: { ...archive.artifacts, [artifactId]: 'tampered' } }),
    ).toThrow();
    expect(() => exportRunArchive(store, 'missing')).toThrow();
  });
});

import { CorralDefinition } from '@corral/contracts';
