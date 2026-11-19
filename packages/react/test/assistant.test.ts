import type { TeamAssistantReply, TeamAssistantResponse, TeamPlan } from '@corral/contracts';
import { planFromGoal } from '@corral/core';
import { Gate, linearCorral } from '@corral/testkit';
import { describe, expect, it, vi } from 'vitest';
import { draftFromDefinition, emptyDraft } from '../src/editor/model.ts';
import { createEditorStore } from '../src/editor/store.ts';
import en from '../src/messages/en.json' with { type: 'json' };
import {
  assistantConversation,
  createAssistantActions,
  type TeamAssistantHost,
} from '../src/team-editor/assistant.ts';
import { targetLabel } from '../src/team-editor/assistant-proposal.ts';

const wording = en.TeamDraft.wording;
const t = (key: string, values?: Record<string, string | number>) =>
  [key, ...Object.values(values ?? {})].join(' ');
const model = () => vi.fn<NonNullable<TeamAssistantHost['ask']>>();
const response = (reply: TeamAssistantReply): TeamAssistantResponse => ({
  reply,
  model: 'Test model',
});
const material: TeamAssistantReply = {
  kind: 'question',
  id: 'material',
  choices: ['person', 'team'],
};
const policy: TeamAssistantReply = {
  kind: 'question',
  id: 'review_policy',
  choices: ['opinion_only', 'required'],
};
const plan: TeamPlan = {
  name: 'Notice',
  brief: 'Write a notice.',
  pattern: 'single',
  criteria: ['Name the date.'],
  roles: [{ slot: 'worker', name: 'Writer', duty: 'Write the notice.' }],
  finalApproval: false,
};
const proposed = response({
  kind: 'plan',
  plan,
  reason: 'The writer can use your material. This must not appear.',
});
const review = response({
  kind: 'edits',
  edits: [{ kind: 'require_review', outputId: 'output', index: 0 }],
  reason: 'Review the final result.',
});
const team = () => draftFromDefinition(linearCorral(['Planner', 'Writer']));
function fixture(ask: TeamAssistantHost['ask'] = null, draft = emptyDraft()) {
  const editor = createEditorStore(draft);
  let id = 0;
  const host = { wording, ask, newOperationId: () => `operation-${++id}` };
  const conversation = assistantConversation(editor, { open: true });
  const actions = createAssistantActions(editor, host, t);
  const send = (input: string) => {
    actions.setInput(input);
    return actions.send();
  };
  return { editor, host, conversation, actions, send, state: conversation.getState };
}
const target = { outputId: 'output', index: 0 };
function twoResults() {
  const draft = team();
  const output = draft.definition.nodes.find((node) => node.type === 'output')!;
  output.inputBindings.push({ kind: 'task_output', name: 'source notes', sourceNodeId: 'Planner' });
  return draft;
}

describe('a conversation belongs to one working copy', () => {
  it('retains input, turns and open state across remounts, never sharing even between stores with equal team IDs', async () => {
    const f = fixture();
    await f.send('Write a letter.');
    f.actions.setInput('unfinished next request');
    f.actions.setOpen(false);
    const again = assistantConversation(f.editor, { open: true });
    expect(again).toBe(f.conversation);
    expect(again.getState()).toMatchObject({
      open: false,
      input: 'unfinished next request',
      turns: expect.arrayContaining([{ id: 1, role: 'user', text: 'Write a letter.' }]),
    });
    expect(assistantConversation(createEditorStore()).getState()).toMatchObject({
      turns: [],
      input: '',
      proposal: null,
    });
    expect(f.editor.getState().past).toHaveLength(0);
  });

  it('keeps each occurrence of a repeated turn independently identifiable', () => {
    const f = fixture(null, team());
    f.actions.chooseEdit('describe');
    const first = f.state().turns.map((turn) => turn.id);
    f.actions.chooseEdit('describe');
    const all = f.state().turns.map((turn) => turn.id);
    expect(all.slice(0, first.length)).toEqual(first);
    expect(new Set(all).size).toBe(4);
  });

  it('serializes sends and ignores even a valid late answer after cancelling and starting a new request', async () => {
    const gate = new Gate();
    const ask = model()
      .mockImplementationOnce(async () => {
        await gate.wait();
        return response(material);
      })
      .mockResolvedValueOnce(proposed);
    const f = fixture(ask);
    const old = f.send('Cancelled goal');
    const signal = ask.mock.calls[0]![1];
    await f.actions.send();
    expect(ask).toHaveBeenCalledTimes(1);
    f.actions.cancel();
    expect(signal.aborted).toBe(true);
    await f.send('Actual goal');
    const active = f.state().proposal;
    gate.open();
    await old;
    expect(f.state()).toMatchObject({ proposal: active, pending: null, question: null });
    expect(active).not.toBeNull();
    expect(f.state().turns.some((turn) => turn.text === t('question.material'))).toBe(false);
  });

  it('captures the request base before waiting, and applies only the displayed result as one undoable edit', async () => {
    const gate = new Gate();
    const ask = model()
      .mockImplementationOnce(async () => {
        await gate.wait();
        return proposed;
      })
      .mockResolvedValueOnce(proposed);
    const f = fixture(ask);
    const old = f.editor.getState().draft;
    const pending = f.send('Write a notice.');
    f.editor.getState().setName('My name');
    const changed = f.editor.getState().draft;
    gate.open();
    await pending;
    expect(f.state().proposal?.base).toBe(old);
    expect(f.actions.apply()).toBeNull();
    expect(f.editor.getState().draft).toBe(changed);
    expect(ask).toHaveBeenCalledTimes(1);
    await f.actions.retry();
    expect(ask.mock.calls[1]![0].messages).toEqual(ask.mock.calls[0]![0].messages);
    const { result, focus, base, reason } = f.state().proposal!;
    expect(base).toBe(changed);
    expect(reason).toBe('The writer can use your material.');
    expect(f.actions.apply()).toBe(focus);
    expect(f.editor.getState().draft).toBe(result);
    expect(result.definition.name).toBe('My name');
    expect(f.actions.apply()).toBeNull();
    f.editor.getState().undo();
    expect(f.editor.getState().draft).toBe(changed);
  });
});

describe('the explicit model request boundary', () => {
  it('sends only the current proposal’s turns and the allowlisted summary, never instructions, paths, skills or tools', async () => {
    const draft = team();
    draft.definition.roles[0]!.prompt = 'secret role prompt /home/private/key';
    draft.definition.roles[0]!.skills = [
      { entry: 'private/SKILL.md', resourceHash: 'a'.repeat(64) },
    ];
    const ask = model().mockResolvedValue(response({ kind: 'describe', topic: 'members' }));
    const f = fixture(ask, draft);
    await f.send('First question');
    await f.send('x'.repeat(2030));
    const request = ask.mock.calls[1]![0];
    expect(request).toMatchObject({
      mode: 'edit',
      messages: [{ role: 'user', content: 'x'.repeat(2000) }],
      team: {
        roles: [
          { nodeId: 'Planner', name: 'Planner' },
          { nodeId: 'Writer', name: 'Writer' },
        ],
        outputs: [
          { outputId: 'output', results: [{ index: 0, name: 'final', producerName: 'Writer' }] },
        ],
        hasSharedOutrider: false,
        brief: draft.definition.input.brief,
      },
    });
    expect(JSON.stringify(request)).not.toMatch(
      /First question|private|allowedWorkTools|write_artifact|resourceHash|stepInstruction/,
    );
    expect(f.editor.getState().draft).toBe(draft);
  });

  it('sends exact question IDs and direct answers without parsing translated text; recommendations are not a material choice', async () => {
    const ask = model()
      .mockResolvedValueOnce(response(material))
      .mockResolvedValueOnce(response(policy))
      .mockResolvedValueOnce(proposed);
    const f = fixture(ask);
    await f.send('Write a newsletter.');
    f.actions.setInput('An unfinished note');
    await f.actions.answer('recommend', 'Recommend one');
    expect(ask).toHaveBeenCalledTimes(2);
    expect(f.state().input).toBe('An unfinished note');
    expect(f.state().turns.filter((turn) => turn.text === 'Recommend one')).toHaveLength(1);
    await f.send('Only an opinion, no gate.');
    const request = ask.mock.calls[2]![0];
    expect(request.messages).toEqual([
      { role: 'user', content: 'Write a newsletter.' },
      { role: 'assistant', questionId: 'material', content: t('question.material') },
      { role: 'user', content: 'Recommend one' },
      { role: 'assistant', questionId: 'review_policy', content: t('question.review_policy') },
      { role: 'user', content: 'Only an opinion, no gate.' },
    ]);
    expect(request).not.toHaveProperty('team');
    expect(request.decisions?.material).toBeUndefined();
    expect(f.state().proposal?.origin).toBe('model');
  });

  it('sends one selected answer, restores the question on cancel, and ignores the old reply', async () => {
    const gate = new Gate();
    const ask = model()
      .mockResolvedValueOnce(response(material))
      .mockImplementationOnce(async () => {
        await gate.wait();
        return response(policy);
      })
      .mockResolvedValueOnce(proposed);
    const f = fixture(ask);
    await f.send('Write a notice');
    f.actions.setInput('Unfinished, not for the model');
    const first = f.actions.answer('team', 'Research it');
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1]?.[0]).toMatchObject({
      decisions: { material: 'team' },
      messages: [
        { role: 'user', content: 'Write a notice' },
        { role: 'assistant', questionId: 'material', content: t('question.material') },
        { role: 'user', content: 'Research it' },
      ],
    });
    expect(f.state().turns.at(-1)).toMatchObject({ role: 'user', text: 'Research it' });
    await f.actions.answer('person', 'I have sources');
    expect(ask).toHaveBeenCalledTimes(2);
    f.actions.cancel();
    expect(ask.mock.calls[1]?.[1].aborted).toBe(true);
    expect(f.state().question?.id).toBe('material');
    expect(f.state().decisions.material).toBeUndefined();
    await f.actions.answer('person', 'I have sources');
    gate.open();
    await first;
    expect(ask).toHaveBeenCalledTimes(3);
    expect(ask.mock.calls[2]?.[0].messages).toHaveLength(3);
    expect(ask.mock.calls[2]?.[0].decisions).toEqual({ material: 'person' });
    const userTurns = f.state().turns.filter((turn) => turn.role === 'user');
    expect(userTurns.map((turn) => turn.text)).toEqual(['Write a notice', 'I have sources']);
    expect(f.state().input).toBe('Unfinished, not for the model');
    expect(f.state().proposal?.origin).toBe('model');
    await f.actions.answer('team', 'Obsolete');
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('continues a displayed model question locally if the model disconnects before the choice', async () => {
    const ask = model().mockResolvedValueOnce(response(material));
    const f = fixture(ask);
    await f.send('Write a newsletter');
    const offline = createAssistantActions(f.editor, { ...f.host, ask: null }, t);
    offline.setInput('Keep this');
    await offline.answer('team', 'Research the material');
    expect(ask).toHaveBeenCalledTimes(1);
    expect(f.state()).toMatchObject({
      question: null,
      input: 'Keep this',
      decisions: { material: 'team' },
      proposal: { origin: 'local', plan: { pattern: 'research_write_review' } },
    });
  });

  it('previews an explicit edit decision locally if the model disconnects after asking', async () => {
    const ask = model().mockResolvedValueOnce(response(policy));
    const f = fixture(ask, team());
    await f.send('Review before publishing.');
    const offline = createAssistantActions(f.editor, { ...f.host, ask: null }, t);
    await offline.answer('opinion_only', 'Advice only');
    expect(ask).toHaveBeenCalledTimes(1);
    expect(f.state().proposal?.result.definition.sharedOutrider).toBeDefined();
    expect(f.state().decisions).toEqual({ reviewPolicy: 'opinion_only' });
  });

  it('will neither ask three questions nor carry a completed proposal’s question budget into the next one', async () => {
    const ask = model()
      .mockResolvedValueOnce(response(material))
      .mockResolvedValueOnce(response(policy))
      .mockResolvedValueOnce(response(material))
      .mockResolvedValueOnce(response(material));
    const f = fixture(ask);
    await f.send('A newsletter');
    await f.send('You decide');
    await f.send('You decide');
    expect(f.state().question).toBeNull();
    expect(f.state().proposal).toMatchObject({ origin: 'local', recovery: 'unusable' });
    expect(ask).toHaveBeenCalledTimes(3);
    await f.send('A different newsletter');
    expect(ask.mock.calls[3]![0].messages).toEqual([
      { role: 'user', content: 'A different newsletter' },
    ]);
    expect(f.state().question?.id).toBe('material');
  });

  it('declines a repeated edit question even for a typed answer rather than displaying it again', async () => {
    const ask = model().mockResolvedValue(response(policy));
    const f = fixture(ask, team());
    await f.send('Review before publishing.');
    await f.send('My own answer.');
    expect(f.state().turns.at(-1)?.text).toBe(t('logic.unsupported'));
    expect(f.state().question).toBeNull();
    expect(f.state().proposal).toBeNull();
  });

  it.each([
    {
      kind: 'edits',
      edits: [
        { kind: 'set_brief', brief: 'new' },
        { kind: 'require_review', outputId: 'absent', index: 0 },
      ],
      reason: 'Review this.',
    },
    {
      kind: 'edits',
      edits: [{ kind: 'set_brief', brief: 'new', tools: ['run_command'] }],
      reason: 'Injected action.',
    },
    { kind: 'plan', plan, reason: 'Replace team.' },
  ])('rejects the entire untrusted edit response: %j', async (reply) => {
    const ask = model().mockResolvedValue({ reply, model: 'model' } as TeamAssistantResponse);
    const f = fixture(ask, team());
    const base = f.editor.getState().draft;
    await f.send('Propose a change');
    expect(f.state().failure).toBeTruthy();
    expect(f.state().proposal).toBeNull();
    expect(f.actions.apply()).toBeNull();
    expect(f.editor.getState().draft).toBe(base);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('retrieves the same operation on explicit retry after transport loss, without another paid request ID', async () => {
    const ask = model()
      .mockRejectedValueOnce(new TypeError('Disconnected'))
      .mockResolvedValueOnce(proposed);
    const f = fixture(ask);
    await f.send('Write a notice');
    expect(f.state().failure).toBe(t('logic.unknown'));
    f.editor.getState().setName('Changed while disconnected');
    await f.actions.retry();
    expect(ask.mock.calls[1]![0]).toEqual(ask.mock.calls[0]![0]);
    expect(f.state().proposal?.origin).toBe('model');
    expect(f.actions.apply()).toBeNull();
  });

  it('tells a confirmed unknown outcome from a definite refusal, and starts a new operation only on explicit retry', async () => {
    const ask = model()
      .mockRejectedValueOnce(
        Object.assign(new Error('Unconfirmed'), { code: 'REQUEST_OUTCOME_UNKNOWN' }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('Provider is unavailable'), { code: 'MODEL_UNAVAILABLE' }),
      )
      .mockResolvedValueOnce(proposed);
    const f = fixture(ask);
    await f.send('Write a notice');
    expect(f.state().failure).toContain(t('logic.unknown'));
    expect(f.state().proposal).toBeNull();
    f.actions.setOpen(false);
    f.actions.setOpen(true);
    expect(ask).toHaveBeenCalledTimes(1);
    await f.actions.retry();
    expect(f.state().failure).toContain('Provider is unavailable');
    expect(f.state().proposal).toBeNull();
    await f.actions.retry();
    expect(ask.mock.calls.map(([req]) => req.operationId)).toEqual([
      'operation-1',
      'operation-2',
      'operation-3',
    ]);
    expect(f.state().turns.filter((turn) => turn.role === 'user')).toHaveLength(1);
  });
});

describe('create proposals and human decisions', () => {
  it.each(['작성자 한 명으로 이 안내문을 써 줘', 'Have a single writer write the notice.'])(
    'does not ask what the person already decided: %s',
    async (goal) => {
      const ask = model().mockResolvedValue(response(material));
      for (const f of [fixture(), fixture(ask)]) {
        await f.send(goal);
        expect(f.state().question).toBeNull();
        expect(f.state().proposal?.plan).toMatchObject({
          pattern: 'single',
          roles: [{ slot: 'worker', name: wording.roles.writer.name }],
        });
        expect(f.state().proposal?.plan?.roles[0]?.duty).toBe(t('logic.writerDuty'));
        expect(f.state().proposal?.reason).toBe(t('rationale.single'));
        expect(f.state().proposal?.result.definition.nodes.map((node) => node.type)).toEqual([
          'agent',
          'output',
        ]);
      }
      expect(ask.mock.calls.length).toBeLessThanOrEqual(1);
    },
  );

  it('uses legacy local advice rules and never invents gates, observation or human approval after a denied policy', async () => {
    const goal = '작성자가 필요할 때만 전문가에게 자문한다. 검토 통과나 자동 관찰은 필요 없다';
    const wrong = planFromGoal('Write and review a notice', wording)!;
    const ask = model().mockResolvedValue(
      response({
        kind: 'plan',
        plan: { ...wrong, observeWork: true, finalApproval: true, outrider: 'required_review' },
        reason: 'Require review.',
      }),
    );
    for (const f of [fixture(), fixture(ask)]) {
      await f.send(goal);
      const preview = f.state().proposal!;
      expect(preview.plan).toMatchObject({
        pattern: 'single',
        outrider: 'consultation',
        finalApproval: false,
      });
      expect(preview.plan?.observeWork).toBeFalsy();
      expect(preview.result.definition.nodes.map((node) => node.type)).toEqual(['agent', 'output']);
      expect(preview.result.definition.sharedOutrider).not.toHaveProperty('observation');
    }
  });

  it('shows same-goal local recovery for an unusable answer, not for a provider failure', async () => {
    const ask = model()
      .mockRejectedValueOnce(
        Object.assign(new Error('The model did not return a usable team proposal.'), {
          code: 'MODEL_UNAVAILABLE',
        }),
      )
      .mockResolvedValueOnce(proposed);
    const f = fixture(ask);
    await f.send('Write the team newsletter.');
    expect(f.state().proposal).toMatchObject({
      origin: 'local',
      recovery: 'unusable',
      plan: { brief: 'Write the team newsletter.' },
    });
    await f.actions.retry();
    expect(f.state().proposal?.origin).toBe('model');
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('does not substitute one worker for an explicit division of labor after an unusable advice proposal', async () => {
    const ask = model().mockRejectedValue(
      Object.assign(new Error('The model did not return a usable team proposal.'), {
        code: 'MODEL_UNAVAILABLE',
      }),
    );
    const f = fixture(ask);
    await f.send(
      'Give a planner and a writer distinct roles. They can ask for expert advice when needed.',
    );
    expect(f.state().proposal).toBeNull();
    expect(f.state().failure).toBeTruthy();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('keeps on-demand advice single even when a valid model plan adds unrelated steps', async () => {
    const ask = model().mockResolvedValue(
      response({
        kind: 'plan',
        plan: planFromGoal('Write and review a report.', wording)!,
        reason: 'Every report needs a reviewer.',
      }),
    );
    const f = fixture(ask);
    await f.send('Write a notice and consult an expert when needed.');
    expect(f.state().proposal).toMatchObject({
      origin: 'local',
      recovery: 'incompatible',
      plan: { pattern: 'single', outrider: 'consultation' },
    });
  });

  it('uses a local example without charging even with a live model; adjustments preview only, preserve observation and invalidate confirmation on pattern change', () => {
    const ask = model();
    const f = fixture(ask);
    f.actions.setInput('Write a notice.');
    f.actions.suggestLocal();
    expect(f.state().proposal?.origin).toBe('local');
    f.actions.observe(true);
    f.actions.reviewPolicy('required');
    expect(f.state().proposal?.canApply).toBe(false);
    const first = f.state().proposal!.targets[0]!;
    f.actions.confirmTarget({ outputId: first.outputId, index: first.index });
    expect(f.state().proposal?.canApply).toBe(true);
    f.actions.pattern('single');
    expect(f.state().proposal).toMatchObject({
      canApply: false,
      plan: { pattern: 'single', observeWork: true, outrider: 'required_review' },
    });
    f.actions.reviewPolicy('opinion_only');
    expect(f.state().proposal).toMatchObject({
      canApply: true,
      plan: { outrider: 'artifact_review' },
    });
    f.actions.observe(false);
    expect(f.state().proposal?.plan?.observeWork).toBeFalsy();
    expect(ask).not.toHaveBeenCalled();
    expect(f.editor.getState().canUndo).toBe(false);
  });

  it('keeps confirmed results on matching regenerated plans, but never confirms a renamed producer by its array position', async () => {
    const ask = model()
      .mockResolvedValueOnce(proposed)
      .mockResolvedValueOnce(proposed)
      .mockResolvedValueOnce(
        response({
          kind: 'plan',
          reason: 'A different producer writes it.',
          plan: { ...plan, roles: [{ slot: 'worker', name: 'Editor', duty: 'Edit it.' }] },
        }),
      );
    const f = fixture(ask);
    await f.send('Prepare the notice');
    f.actions.reviewPolicy('required');
    f.actions.confirmTarget(f.state().proposal!.targets[0]);
    await f.actions.retry();
    expect(ask.mock.calls[1]![0].decisions).toEqual({ reviewPolicy: 'required' });
    expect(f.state().proposal?.canApply).toBe(true);
    await f.actions.retry();
    expect(f.state().decisions.reviewTarget).toBeUndefined();
    expect(f.state().proposal?.canApply).toBe(false);
  });

  it('does not let a model contradict the person’s material choice in a local recovery', async () => {
    const ask = model().mockResolvedValueOnce(response(material)).mockResolvedValueOnce(proposed);
    const f = fixture(ask);
    await f.send('A newsletter');
    await f.actions.answer('team', 'The team finds the material');
    expect(ask.mock.calls[1]![0].decisions).toMatchObject({ material: 'team' });
    expect(f.state().proposal).toMatchObject({
      origin: 'local',
      plan: { pattern: 'research_write_review' },
    });
  });
});

describe('edit choices are commands, never paid interpretations', () => {
  it.each(['name', 'display label'])(
    'matches structured result text locally without a model call: %s',
    async (answer) => {
      const ask = model();
      const f = fixture(ask, twoResults());
      f.actions.chooseEdit('require_review');
      const displayed = targetLabel(
        f.editor.getState().draft,
        { outputId: 'output', index: 1, name: 'source notes', producerName: 'Planner' },
        t,
      );
      await f.send(answer === 'name' ? 'source notes' : displayed);
      expect(ask).not.toHaveBeenCalled();
      const output = f
        .state()
        .proposal?.result.definition.nodes.find((node) => node.type === 'output');
      expect(output?.requiredReviews).toMatchObject([
        { bindingName: 'source notes', sourceNodeId: 'Planner' },
      ]);
    },
  );

  it('describes the current submitter, previews advice and preserves prior hand edits on one undo', () => {
    const ask = model();
    const f = fixture(ask, team());
    f.editor.getState().updateNode('Writer', { prompt: 'My hand-written task.' });
    const before = f.editor.getState().draft;
    f.actions.chooseEdit('describe');
    expect(f.state().turns.at(-1)?.text).toContain('Writer');
    expect(f.state().turns.at(-1)?.text).toContain('final');
    expect(f.state().proposal).toBeNull();
    f.actions.chooseEdit('add_shared_advice');
    expect(f.actions.apply()).toBe('@advice');
    expect(f.editor.getState().draft.definition.controlEdges).toEqual(
      before.definition.controlEdges,
    );
    expect(f.editor.getState().draft.definition.sharedOutrider?.targets).toEqual({ kind: 'all' });
    f.actions.chooseEdit('add_shared_advice');
    expect(f.state().proposal).toBeNull();
    f.editor.getState().undo();
    expect(f.editor.getState().draft).toBe(before);
    expect(ask).not.toHaveBeenCalled();
  });

  it('previews only the chosen result and uses the current draft on explicit local regeneration', async () => {
    const ask = model();
    const f = fixture(ask, twoResults());
    f.actions.chooseEdit('require_review');
    expect(f.state().question).toMatchObject({
      id: 'review_target',
      choices: [target, { ...target, index: 1 }],
    });
    expect(f.state().proposal).toBeNull();
    f.actions.answer({ ...target, index: 1 }, 'Planner: source notes');
    const old = f.state().proposal;
    expect(old?.canApply).toBe(true);
    f.editor.getState().setBrief('My newer brief.');
    expect(f.actions.apply()).toBeNull();
    await f.actions.retry();
    expect(f.state().proposal?.base).toBe(f.editor.getState().draft);
    expect(f.actions.apply()).toBeTruthy();
    const out = f.editor.getState().draft.definition.nodes.find((node) => node.type === 'output');
    expect(out?.requiredReviews).toMatchObject([
      { bindingName: 'source notes', sourceNodeId: 'Planner' },
    ]);
    expect(ask).not.toHaveBeenCalled();
  });

  it('does not transfer a human target selection to a different result at the same index', async () => {
    const f = fixture(null, twoResults());
    f.actions.chooseEdit('require_review');
    f.actions.answer({ ...target, index: 1 }, 'Planner: source notes');
    f.editor.getState().updateNode('output', {
      inputBindings: [
        { kind: 'task_output', name: 'source notes', sourceNodeId: 'Planner' },
        { kind: 'task_output', name: 'final', sourceNodeId: 'Writer' },
      ],
    });
    await f.actions.retry();
    expect(f.state().proposal).toBeNull();
    expect(f.state().question?.id).toBe('review_target');
    expect(f.state().decisions.reviewTarget).toBeUndefined();
  });

  it('honors a structured opinion-only answer over a model gate, even if the button label says otherwise', async () => {
    const ask = model().mockResolvedValueOnce(response(policy)).mockResolvedValueOnce(review);
    const f = fixture(ask, team());
    await f.send('Review before publishing.');
    await f.actions.answer('opinion_only', 'Require review');
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1]![0].decisions).toEqual({ reviewPolicy: 'opinion_only' });
    expect(f.state().proposal?.result.definition.sharedOutrider).toBeDefined();
    expect(
      f.state().proposal?.result.definition.nodes.find((node) => node.type === 'output')
        ?.requiredReviews?.length ?? 0,
    ).toBe(0);
  });

  it('does not interpret free-form edits offline, but an explicit new brief previews and applies locally', async () => {
    const f = fixture(null, team());
    await f.send('Delete the writer!');
    expect(f.state().proposal).toBeNull();
    expect(f.state().turns.at(-1)?.text).toBe(t('logic.unsupported'));
    f.actions.chooseEdit('set_brief');
    await f.send('Write a new notice.');
    expect(f.state().proposal?.result.definition.input.brief).toBe('Write a new notice.');
    expect(f.actions.apply()).toBe('@request');
  });
});
