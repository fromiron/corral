import {
  hasAssistantTarget,
  hasReviewLoop,
  type TeamAssistantReply,
  type TeamAssistantRequest,
  TeamAssistantResponse,
  type TeamAssistantTarget,
  type TeamPattern,
  type TeamPlan,
} from '@corral/contracts';
import {
  type CompileOptions,
  planWithPattern,
  reconcileAssistantReply,
  type TeamWording,
  withWorkObservation,
} from '@corral/core';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { EditorDraft } from '../editor/model.ts';
import type { EditorStore } from '../editor/store.ts';
import {
  type AssistantText,
  createProposal,
  describe,
  editProposal,
  modeOf,
  type Proposal,
  summarize,
  targetLabel,
} from './assistant-proposal.ts';

export interface TeamAssistantHost {
  ask:
    | ((request: TeamAssistantRequest, signal: AbortSignal) => Promise<TeamAssistantResponse>)
    | null;
  modelLabel?: string;
  newOperationId(): string;
  wording: TeamWording;
  onConnectModel?(): void;
  onBrowseTemplates?(): void;
}

type Decisions = NonNullable<TeamAssistantRequest['decisions']>;
type Messages = TeamAssistantRequest['messages'];
type Turn = { id: number; role: 'user' | 'assistant'; text: string };
type Mode = TeamAssistantRequest['mode'];
type Choice = 'describe' | 'add_shared_advice' | 'require_review' | 'set_brief';
type Question = {
  id: 'material' | 'review_policy' | 'review_target' | 'brief';
  choices: (string | TeamAssistantTarget)[];
  source: 'model' | 'choice';
};
type UserMessage = Extract<Messages[number], { role: 'user' }>;
type MessageIntent = {
  kind: 'model';
  mode: Mode;
  messages: [UserMessage, ...Messages];
};
type ChoiceIntent = { kind: 'choice'; choice: Choice; brief?: string };
type Intent = MessageIntent | ChoiceIntent;
type Receipt = { base: EditorDraft; request: TeamAssistantRequest };
type Unanswered = Pick<Conversation, 'question' | 'decisions' | 'intent' | 'turns'>;

export interface Conversation {
  /**
   * Whether the conversation is open by a person's or the host's choice. Null until one of them
   * chooses: then its place decides (docs/specs/features/team-assistant.md 2).
   */
  open: boolean | null;
  input: string;
  turns: Turn[];
  question: Question | null;
  proposal: Proposal | null;
  failure: string | null;
  model: string | null;
  decisions: Decisions;
  pending: { operationId: string; controller: AbortController; unanswered?: Unanswered } | null;
  initialName: string;
  // Only these messages can leave the working copy. Display history is never serialized.
  intent: Intent | null;
  // A lost HTTP response is not proof that the server didn't execute the operation.
  receipt: Receipt | null;
  chosenPattern: TeamPattern | null;
  confirmedPlan: TeamPlan | null;
  cancel(): void;
}

export interface AssistantActions {
  send(): Promise<void>;
  retry(): Promise<void>;
  cancel(): void;
  setInput(input: string): void;
  setOpen(open: boolean): void;
  chooseEdit(choice: Choice): void;
  answer(value: string | TeamAssistantTarget, label: string): Promise<void>;
  pattern(value: TeamPattern): void;
  observe(value: boolean): void;
  reviewPolicy(value: 'opinion_only' | 'required'): void;
  confirmTarget(target: TeamAssistantTarget | undefined): void;
  apply(): string | null;
}

const conversations = new WeakMap<EditorStore, StoreApi<Conversation>>();

export function assistantConversation(editor: EditorStore, start?: { open: boolean }) {
  const existing = conversations.get(editor);
  if (existing) return existing;
  const conversation = createStore<Conversation>((set, get) => ({
    open: start?.open ?? null,
    input: '',
    turns: [],
    question: null,
    proposal: null,
    failure: null,
    model: null,
    decisions: {},
    pending: null,
    initialName: editor.getState().draft.definition.name,
    intent: null,
    receipt: null,
    chosenPattern: null,
    confirmedPlan: null,
    cancel() {
      const { pending } = get();
      if (!pending) return;
      set({ ...pending.unanswered, pending: null });
      pending.controller.abort();
    },
  }));
  // Using the conversation is choosing to have it open: it does not fold away with its place
  // while a person is writing in it or reading its answer.
  conversation.subscribe((state) => {
    if (
      state.open === null &&
      (state.input || state.turns.length || state.question || state.proposal || state.pending)
    )
      conversation.setState({ open: true });
  });
  conversations.set(editor, conversation);
  return conversation;
}

function sameTarget(a: TeamAssistantTarget, b: TeamAssistantTarget) {
  return a.outputId === b.outputId && a.index === b.index;
}

function selectedBinding(draft: EditorDraft, { outputId, index }: TeamAssistantTarget) {
  const output = draft.definition.nodes.find((node) => node.id === outputId);
  const binding = output?.type === 'output' ? output.inputBindings[index] : undefined;
  return binding?.kind === 'task_output' ? binding : undefined;
}

function withoutTarget(decisions: Decisions): Decisions {
  const { reviewTarget: _oldTarget, ...rest } = decisions;
  return rest;
}

function appendTurn(turns: Turn[], role: Turn['role'], text: string): Turn[] {
  return [...turns, { id: (turns.at(-1)?.id ?? 0) + 1, role, text }];
}

function turnsWithProposal(state: Conversation): Turn[] {
  return state.proposal ? appendTurn(state.turns, 'assistant', state.proposal.reason) : state.turns;
}

/** Actions read the working copy at invocation, not at the time the view rendered. */
export function createAssistantActions(
  editor: EditorStore,
  host: TeamAssistantHost,
  t: AssistantText,
  compileOptions?: Pick<CompileOptions, 'resolveTeam' | 'knownModelProfiles'>,
): AssistantActions {
  const { getState, setState } = assistantConversation(editor);
  const { wording } = host;

  function say(text: string) {
    setState((s) => ({
      turns: appendTurn(s.turns, 'assistant', text),
      question: null,
      proposal: null,
      failure: null,
    }));
  }

  function present(proposal: Proposal) {
    if (proposal.base === proposal.result && proposal.canApply) {
      say(t('logic.noChange'));
    } else {
      setState({ proposal, question: null, failure: null });
    }
  }

  function askQuestion(question: Question, intent: Intent) {
    const text = t(`question.${question.id}`);
    if (intent.kind !== 'choice' && question.id !== 'brief') {
      intent = {
        ...intent,
        messages: [
          ...intent.messages,
          { role: 'assistant', questionId: question.id, content: text.slice(0, 2000) },
        ],
      };
    }
    setState((s) => ({
      question,
      proposal: null,
      intent,
      failure: null,
      turns: appendTurn(s.turns, 'assistant', text),
    }));
  }

  function previewPlan(
    base: EditorDraft,
    plan: TeamPlan,
    options: { reason: string; target?: TeamAssistantTarget | undefined },
  ) {
    const { initialName, confirmedPlan, decisions } = getState();
    let target = options.target;
    if (!('target' in options) && decisions.reviewTarget) {
      // Pattern wiring is deterministic. A regenerated plan can reuse a confirmation
      // only if it still describes the same people filling the same positions.
      if (
        plan.outrider === 'required_review' &&
        confirmedPlan?.pattern === plan.pattern &&
        confirmedPlan.roles.every((role) =>
          plan.roles.some((r) => r.slot === role.slot && r.name === role.name),
        )
      ) {
        target = decisions.reviewTarget;
      } else {
        setState({ decisions: withoutTarget(decisions), confirmedPlan: null });
      }
    }
    present(
      createProposal(base, plan, { ...options, target, initialName, wording, t, compileOptions }),
    );
  }

  function previewEdits(
    base: EditorDraft,
    edits: Extract<TeamAssistantReply, { kind: 'edits' }>['edits'],
    reason: string,
    origin: 'model' | 'choice',
  ) {
    const proposal = editProposal(base, edits, { reason, origin, t, compileOptions });
    if (proposal.result === base) {
      say(
        t(
          edits.every((edit) => edit.kind === 'add_shared_advice')
            ? 'logic.hasAdvice'
            : 'logic.noChange',
        ),
      );
    } else {
      present(proposal);
    }
  }

  function failed(error: unknown) {
    setState({
      proposal: null,
      question: null,
      failure: error instanceof Error ? error.message : t('logic.failed'),
    });
  }

  // An answer that cannot be used is a failure with Retry; nothing stands in for it.
  function unusable() {
    failed(new Error(t('logic.unusable')));
  }

  function receive(
    base: EditorDraft,
    intent: MessageIntent,
    request: TeamAssistantRequest,
    raw: unknown,
  ) {
    const parsed = TeamAssistantResponse.safeParse(raw);
    if (!parsed.success) return unusable();
    const { model, reply: original } = parsed.data;
    setState({ model });
    const reply = reconcileAssistantReply(original, request);
    if (!reply) return unusable();
    switch (reply.kind) {
      case 'question':
        return askQuestion({ id: reply.id, choices: reply.choices, source: 'model' }, intent);
      case 'plan': {
        const { chosenPattern } = getState();
        let plan = reply.plan;
        if (chosenPattern && chosenPattern !== plan.pattern)
          plan = planWithPattern(plan, chosenPattern, wording);
        previewPlan(base, plan, {
          reason: chosenPattern ? t(`rationale.${plan.pattern}`) : reply.reason,
        });
        return;
      }
      case 'edits':
        return previewEdits(base, reply.edits, reply.reason, 'model');
      case 'describe':
        return say(describe(editor.getState().draft, reply.topic, t));
      case 'unsupported':
        return say(t('logic.unsupported'));
    }
  }

  async function run(intent: MessageIntent, receipt: Receipt | null = null, before?: Unanswered) {
    // Without a model nothing is sent, and nothing is guessed in its place.
    const { ask } = host;
    if (!ask) return;
    const base = receipt?.base ?? editor.getState().draft;
    const mode = modeOf(base);
    if (intent.mode !== mode) {
      // A manual first role (or undo of a creation) changes the allowed response kinds.
      // Do not send previous-mode questions or choices as if they described this team.
      intent = { ...intent, mode, messages: [intent.messages[0]] };
      setState({ decisions: {}, chosenPattern: null });
      before = undefined;
    }
    setState({
      intent,
      question: before?.question ?? null,
      proposal: null,
      failure: null,
      receipt: null,
    });
    let request = receipt?.request;
    if (!request) {
      const team = mode === 'edit' ? summarize(base) : undefined;
      let { decisions } = getState();
      // Create confirmations point into the preview, never into the wire summary.
      if (mode === 'create') decisions = withoutTarget(decisions);
      else if (decisions.reviewTarget && !hasAssistantTarget(team, decisions.reviewTarget)) {
        decisions = withoutTarget(decisions);
        setState({ decisions });
      }
      request = {
        operationId: host.newOperationId(),
        messages: intent.messages.slice(-12),
        ...(Object.keys(decisions).length > 0 && { decisions }),
        ...(team ? { mode: 'edit', team } : { mode: 'create' }),
      };
    }
    const controller = new AbortController();
    const active = () =>
      getState().pending?.controller === controller && !controller.signal.aborted;
    // Cancelling an answer reopens that exact question, not the whole conversation (the
    // composer may have been edited in the meantime). A second answer replaces the cancelled turn.
    const unanswered = before && {
      question: before.question,
      decisions: before.decisions,
      intent: before.intent,
      turns: before.turns,
    };
    setState({
      pending: { operationId: request.operationId, controller, ...(unanswered && { unanswered }) },
    });
    try {
      let result: TeamAssistantResponse;
      try {
        result = await ask(request, controller.signal);
      } catch (error) {
        if (!active()) return;
        const code =
          typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
        if (
          code === 'MODEL_UNAVAILABLE' &&
          error instanceof Error &&
          error.message === 'The model did not return a usable team proposal.'
        ) {
          unusable();
        } else if (!code || code === 'REQUEST_OUTCOME_UNKNOWN') {
          // If even the receipt was lost, Retry first retrieves the same operation.
          // A confirmed unknown is terminal; only explicit Retry starts a new one.
          setState({
            question: null,
            failure: t('logic.unknown'),
            receipt: !code ? { request, base } : null,
          });
        } else {
          failed(error);
        }
        return;
      }
      if (active()) receive(base, intent, request, result);
    } catch (error) {
      if (active()) failed(error);
    } finally {
      if (active()) setState({ pending: null });
    }
  }

  function runChoice(intent: ChoiceIntent) {
    const base = editor.getState().draft;
    setState({ intent, proposal: null, question: null, failure: null, receipt: null });
    if (modeOf(base) !== 'edit') return say(t('logic.unsupported'));
    try {
      switch (intent.choice) {
        case 'describe':
          return say(describe(base, 'submitter', t));
        case 'add_shared_advice':
          return previewEdits(base, [{ kind: 'add_shared_advice' }], t('logic.advice'), 'choice');
        case 'set_brief':
          if (!intent.brief)
            return askQuestion({ id: 'brief', choices: [], source: 'choice' }, intent);
          return previewEdits(
            base,
            [{ kind: 'set_brief', brief: intent.brief }],
            t('logic.brief'),
            'choice',
          );
        case 'require_review': {
          const team = summarize(base);
          const choices = team.outputs.flatMap(({ outputId, results }) =>
            results.map(({ index }) => ({ outputId, index })),
          );
          let target = getState().decisions.reviewTarget;
          if (target && !hasAssistantTarget(team, target)) target = undefined;
          if (!target && choices.length > 1)
            return askQuestion({ id: 'review_target', choices, source: 'choice' }, intent);
          target ??= choices[0];
          if (!target) return failed(new Error(t('facts.noSubmitter')));
          return previewEdits(
            base,
            [{ kind: 'require_review', ...target }],
            t('logic.required'),
            'choice',
          );
        }
      }
    } catch (error) {
      failed(error);
    }
  }

  function adjust(plan: TeamPlan, reason: string, decisions: Decisions, pattern?: TeamPattern) {
    const { proposal } = getState();
    if (
      !proposal?.plan ||
      proposal.origin === 'choice' ||
      proposal.base !== editor.getState().draft
    )
      return;
    try {
      previewPlan(proposal.base, plan, { reason, target: decisions.reviewTarget });
      setState({
        decisions,
        confirmedPlan: decisions.reviewTarget ? plan : null,
        ...(pattern && { chosenPattern: pattern }),
      });
    } catch (error) {
      failed(error);
    }
  }

  function startInput() {
    const state = getState();
    const text = state.input.trim().slice(0, 2000);
    // A choice's own question takes its answer here without a model; anything else needs one.
    const local = state.question?.source === 'choice' && state.intent?.kind === 'choice';
    if (!text || state.pending || (!local && !host.ask)) return;
    const mode = modeOf(editor.getState().draft);
    const continuation =
      state.question && state.intent?.kind !== 'choice' && state.intent?.mode === mode
        ? state.intent
        : null;
    setState({ input: '', turns: appendTurn(turnsWithProposal(state), 'user', text) });
    if (state.question?.source === 'choice' && state.intent?.kind === 'choice') {
      if (state.question.id === 'brief') {
        runChoice({ ...state.intent, brief: text });
      } else {
        // The composer identifies this as a local action. A typed answer may
        // identify one of the listed results, but must never trigger a paid call.
        const draft = editor.getState().draft;
        const matches = summarize(draft).outputs.flatMap(({ outputId, results }) =>
          results.flatMap((result) => {
            const target = { outputId, index: result.index };
            return result.name === text ||
              result.producerName === text ||
              targetLabel(draft, { outputId, ...result }, t) === text
              ? [target]
              : [];
          }),
        );
        const [matched] = matches;
        if (!matched || matches.length !== 1) {
          setState({ input: text, failure: t('TeamEditor.rejected.invalidResultInput') });
          return;
        }
        setState({ decisions: { ...state.decisions, reviewTarget: matched } });
        runChoice(state.intent);
      }
      return;
    }
    if (!continuation) setState({ decisions: {}, chosenPattern: null });
    const message: UserMessage = { role: 'user', content: text };
    return run(
      {
        kind: 'model',
        mode,
        messages: continuation ? [...continuation.messages, message] : [message],
      },
      null,
      continuation ? state : undefined,
    );
  }

  return {
    cancel: getState().cancel,
    setOpen(open: boolean) {
      setState({ open });
    },
    setInput(input: string) {
      setState({ input });
    },
    async send() {
      await startInput();
    },
    async retry() {
      const { pending, receipt, intent, proposal, failure, decisions } = getState();
      if (pending || !intent || !(failure || proposal)) return;
      let next = intent;
      const current = editor.getState().draft;
      if (proposal && !proposal.plan && proposal.base !== current && decisions.reviewTarget) {
        // An index still in bounds may now refer to somebody else's result.
        const before = selectedBinding(proposal.base, decisions.reviewTarget);
        const after = selectedBinding(current, decisions.reviewTarget);
        if (
          !before ||
          !after ||
          before.name !== after.name ||
          before.sourceNodeId !== after.sourceNodeId
        ) {
          setState({ decisions: withoutTarget(decisions) });
          if (intent.kind !== 'choice') next = { ...intent, messages: [intent.messages[0]] };
        }
      }
      if (next.kind === 'choice') runChoice(next);
      else await run(next, receipt);
    },
    chooseEdit(choice: Choice) {
      const state = getState();
      if (state.pending || modeOf(editor.getState().draft) !== 'edit') return;
      setState({
        turns: appendTurn(turnsWithProposal(state), 'user', t(`choice.${choice}`)),
        decisions: choice === 'require_review' ? { reviewPolicy: 'required' } : {},
        chosenPattern: null,
      });
      runChoice({ kind: 'choice', choice });
    },
    async answer(value, label) {
      const state = getState();
      const { question, intent, decisions, pending } = state;
      if (!question || pending || !intent || question.id === 'brief') return;
      // A new team's question waits for the model to come back; nothing answers it locally.
      if (!host.ask && intent.kind !== 'choice' && intent.mode === 'create') return;
      const next = { ...decisions };
      if (question.id === 'material') delete next.material;
      else if (question.id === 'review_policy') delete next.reviewPolicy;
      else delete next.reviewTarget;
      const delegate = value === 'recommend' && question.source === 'model' && host.ask !== null;
      if (value === 'recommend' && !delegate) {
        const first = question.choices[0];
        if (!first) return;
        value = first;
      }
      if (typeof value === 'object') {
        const target = value;
        if (
          question.id !== 'review_target' ||
          !question.choices.some((v) => typeof v === 'object' && sameTarget(v, target))
        )
          return;
        next.reviewTarget = { outputId: target.outputId, index: target.index };
      } else if (
        question.id === 'review_policy' &&
        (value === 'required' || value === 'opinion_only')
      )
        next.reviewPolicy = value;
      else if (question.id === 'material' && (value === 'person' || value === 'team'))
        next.material = value;
      else if (!delegate) return;
      setState({ turns: appendTurn(state.turns, 'user', label), decisions: next });
      if (intent.kind === 'choice') return runChoice(intent);
      if (!host.ask && intent.mode === 'edit') {
        if (question.id === 'review_target' || question.id === 'review_policy') {
          return runChoice({
            kind: 'choice',
            choice: next.reviewPolicy === 'opinion_only' ? 'add_shared_advice' : 'require_review',
          });
        }
        return say(t('logic.unsupported'));
      }
      await run(
        {
          ...intent,
          messages: [...intent.messages, { role: 'user', content: label.slice(0, 2000) }],
        },
        null,
        state,
      );
    },
    pattern(value: TeamPattern) {
      const { proposal, decisions } = getState();
      if (proposal?.plan && proposal.plan.pattern !== value) {
        adjust(
          planWithPattern(proposal.plan, value, wording),
          t(`rationale.${value}`),
          withoutTarget(decisions),
          value,
        );
      }
    },
    observe(value: boolean) {
      const { proposal, decisions } = getState();
      if (proposal?.plan)
        adjust(
          withWorkObservation(proposal.plan, value),
          t(value ? 'logic.observeOn' : 'logic.observeOff'),
          { ...decisions, observeWork: value },
        );
    },
    reviewPolicy(value: 'opinion_only' | 'required') {
      const { proposal, decisions } = getState();
      if (!proposal?.plan) return;
      const plan =
        value === 'opinion_only' &&
        (hasReviewLoop(proposal.plan.pattern) || proposal.plan.pattern === 'adversarial_review')
          ? planWithPattern(proposal.plan, 'single', wording)
          : proposal.plan;
      adjust(
        { ...plan, outrider: value === 'required' ? 'required_review' : 'artifact_review' },
        t(value === 'required' ? 'logic.required' : 'logic.opinion'),
        { ...withoutTarget(decisions), reviewPolicy: value },
        plan.pattern !== proposal.plan.pattern ? plan.pattern : undefined,
      );
    },
    confirmTarget(target: TeamAssistantTarget | undefined) {
      const { proposal, decisions } = getState();
      if (proposal?.plan?.outrider !== 'required_review') return;
      if (target && !proposal.targets.some((option) => sameTarget(option, target))) return;
      adjust(proposal.plan, t('logic.required'), {
        ...withoutTarget(decisions),
        ...(target && { reviewTarget: { outputId: target.outputId, index: target.index } }),
      });
    },
    apply(): string | null {
      const state = getState();
      const { proposal } = state;
      if (
        !proposal?.canApply ||
        state.pending ||
        proposal.base !== editor.getState().draft ||
        proposal.base === proposal.result
      )
        return null;
      editor.getState().applyDraft(proposal.result);
      setState({
        turns: turnsWithProposal(state),
        proposal: null,
        intent: null,
        receipt: null,
        decisions: {},
        chosenPattern: null,
        confirmedPlan: null,
      });
      return proposal.focus;
    },
  };
}
