import { RunEvent } from '@corral/contracts';
import {
  collaborationCorral,
  FakeClock,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import { exportRunArchive, openRunArchive } from '../src/history.ts';
import {
  applyEvent,
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
  const projection = await waitForProjection(runtime, runId, (p) => p.status === 'succeeded');
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
    const final = await waitForProjection(runtime, runId, (p) => p.status === 'succeeded');
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
    const final = await waitForProjection(runtime, runId, (p) => p.status === 'succeeded');
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

  it('exports committed final response text and verifies its archived body', async () => {
    const { store, runId } = await recordedRun();
    const finished = store.readEvents(runId, 0).find((event) => event.type === 'model.finished');
    if (finished?.type !== 'model.finished' || !finished.payload.responseRef)
      throw new Error('response reference expected');
    const ref = finished.payload.responseRef;
    const archive = exportRunArchive(store, runId, { privateTranscript: true });
    if (archive.visibility !== 'private') throw new Error('private archive expected');
    expect(archive.artifacts[ref]).toBe(store.getArtifactText(runId, ref));
    expect(() =>
      openRunArchive({
        ...archive,
        artifacts: { ...archive.artifacts, [ref]: 'modified response' },
      }),
    ).toThrow();
    const bodies = { ...archive.artifacts };
    delete bodies[ref];
    expect(() => openRunArchive({ ...archive, artifacts: bodies })).toThrow();
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

  it('includes criteria revisions referenced by immutable patch events', async () => {
    const { store, runId, projection } = await recordedRun();
    const started = store.readEvents(runId, 0)[0];
    if (!started) throw new Error('run start expected');
    const patched = RunEvent.parse({
      ...started,
      eventId: 'event_patch_history',
      runSeq: projection.lastSeq + 1,
      type: 'patch.committed',
      payload: {
        patchId: 'patch_history',
        kind: 'criteria',
        scope: { nodeId: null },
        before: { criteriaVersionId: store.getRun(runId)?.snapshot.criteriaVersionId },
        after: { criteriaVersionId: 'criteria_new', criteria: ['new criterion'] },
        controlRevision: 1,
      },
    });
    store.transaction(() => {
      store.appendEvents(runId, [patched]);
      store.saveProjection(runId, applyEvent(projection, patched));
      store.putArtifactText(runId, 'criteria_new', 'new criterion');
    });
    const archive = exportRunArchive(store, runId, { privateTranscript: true });
    const opened = openRunArchive(archive);
    expect(opened.visibility === 'private' && opened.artifacts.criteria_new).toBe('new criterion');
    if (archive.visibility !== 'private') throw new Error('private expected');
    expect(() =>
      openRunArchive({
        ...archive,
        artifacts: { ...archive.artifacts, criteria_new: 'tampered criteria' },
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
