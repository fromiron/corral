import {
  hasAssistantTarget,
  type TeamAssistantReply,
  type TeamAssistantRequest,
  TeamAssistantResponse,
  type TeamAssistantTarget,
  type TeamAssistantTeam,
  type TeamComposition,
  unusableTeamProposalReason,
} from '@corral/contracts';
import {
  type CompileOptions,
  type ComposableAgent,
  type ComposableSkill,
  reconcileAssistantReply,
  type TeamWording,
  teamCatalog,
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
  type SentCatalog,
  summarize,
  targetLabel,
} from './assistant-proposal.ts';

export interface TeamAssistantHost {
  ask:
    | ((request: TeamAssistantRequest, signal: AbortSignal) => Promise<TeamAssistantResponse>)
    | null;
  modelLabel?: string;
  /** The model list has not arrived yet: whether a model can run is not known. */
  modelPending?: boolean;
  newOperationId(): string;
  /**
   * What the editor can pick by hand ("add agent" and "add skill"), read when a new team is
   * requested: the model composes the team from these alone.
   */
  choices(): Promise<{ agents: readonly ComposableAgent[]; skills: readonly ComposableSkill[] }>;
  /** The names of the steps a composed team adds, in the screen language. */
  wording: Pick<TeamWording, 'labels'>;
  onConnectModel?(): void;
  onBrowseTemplates?(): void;
}

type Decisions = NonNullable<TeamAssistantRequest['decisions']>;
type Messages = TeamAssistantRequest['messages'];
type Turn = {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  /** A proposal the conversation moved past: it stays readable and cannot be applied. */
  proposal?: Proposal;
};
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
  /** The shown composition the person asks to change. */
  proposal?: TeamComposition;
  /** The catalog that composition was made from: its ids mean something only there. */
  catalog?: SentCatalog;
};
type ChoiceIntent = { kind: 'choice'; choice: Choice; brief?: string };
type Intent = MessageIntent | ChoiceIntent;
type Receipt = { base: EditorDraft; request: TeamAssistantRequest; resolved?: SentCatalog };
type ConfirmedTarget = TeamAssistantTarget & { name: string; producerName: string };
type Unanswered = Pick<Conversation, 'question' | 'proposal' | 'decisions' | 'intent' | 'turns'>;

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
  /** The result a person confirmed for a required review, as it was named when confirmed. */
  confirmedTarget: ConfirmedTarget | null;
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
  observe(value: boolean): void;
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
    confirmedTarget: null,
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

/** The server's word for an answer it could not use; a reason code may follow it, never shown. */
function isUnusableAnswer(message: string): boolean {
  return unusableTeamProposalReason(message) !== null;
}

function appendTurn(turns: Turn[], role: Turn['role'], text: string): Turn[] {
  return [...turns, { id: (turns.at(-1)?.id ?? 0) + 1, role, text }];
}

function turnsWithProposal(state: Conversation): Turn[] {
  const { proposal } = state;
  if (!proposal) return state.turns;
  const turns = appendTurn(state.turns, 'assistant', proposal.reason);
  // A new team's proposal stays in the conversation as it was shown.
  if (proposal.plan) turns[turns.length - 1] = { ...(turns.at(-1) as Turn), proposal };
  return turns;
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
    plan: TeamComposition,
    options: {
      reason: string;
      resolved: SentCatalog;
      target?: TeamAssistantTarget | undefined;
    },
    decisions: Decisions = getState().decisions,
  ) {
    const { initialName, confirmedTarget } = getState();
    const build = (target: TeamAssistantTarget | undefined) =>
      createProposal(base, plan, {
        ...options,
        target,
        observe: decisions.observeWork,
        initialName,
        wording,
        t,
        compileOptions,
      });
    if ('target' in options || !decisions.reviewTarget) return present(build(options.target));
    // A regenerated proposal keeps a confirmation only while the confirmed result is still the
    // same result of the same producer; otherwise the person confirms again.
    const open = build(undefined);
    const same = open.targets.some(
      (row) =>
        row.outputId === confirmedTarget?.outputId &&
        row.index === confirmedTarget.index &&
        row.name === confirmedTarget.name &&
        row.producerName === confirmedTarget.producerName,
    );
    if (same) return present(build(decisions.reviewTarget));
    setState({ decisions: withoutTarget(decisions), confirmedTarget: null });
    present(open);
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
    resolved: SentCatalog | undefined,
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
      case 'plan':
        // A plan is allowed only in create mode, whose request carried the catalog.
        if (!resolved) return unusable();
        return previewPlan(base, reply.plan, { reason: reply.reason, resolved });
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
      intent = { kind: 'model', mode, messages: [intent.messages[0]] };
      setState({ decisions: {}, confirmedTarget: null });
      before = undefined;
    }
    setState({
      intent,
      question: before?.question ?? null,
      proposal: null,
      failure: null,
      receipt: null,
    });
    const controller = new AbortController();
    const active = () =>
      getState().pending?.controller === controller && !controller.signal.aborted;
    // Cancelling an answer reopens that exact question, not the whole conversation (the
    // composer may have been edited in the meantime). A second answer replaces the cancelled turn.
    const unanswered = before && {
      question: before.question,
      proposal: before.proposal,
      decisions: before.decisions,
      intent: before.intent,
      turns: before.turns,
    };
    let request = receipt?.request;
    let resolved = receipt?.resolved;
    setState({
      pending: {
        operationId: request?.operationId ?? '',
        controller,
        ...(unanswered && { unanswered }),
      },
    });
    if (!request) {
      // An edit is read against the team; a new team against the catalog it is composed from.
      let to: { team: TeamAssistantTeam } | { catalog: SentCatalog };
      if (mode === 'edit') to = { team: summarize(base) };
      else {
        // A new team is composed from what the editor offers now. The reply is read against
        // exactly the catalog this request carries; a refinement keeps its proposal's.
        let catalog = intent.catalog;
        if (!catalog) {
          try {
            const { agents, skills } = await host.choices();
            catalog = teamCatalog(agents, skills);
          } catch {
            if (!active()) return;
            setState({ pending: null, question: null, failure: t('logic.catalog') });
            return;
          }
          if (!active()) return;
        }
        resolved = catalog;
        to = { catalog };
      }
      let { decisions } = getState();
      // Create confirmations point into the preview, never into the wire summary.
      if ('catalog' in to) decisions = withoutTarget(decisions);
      else if (decisions.reviewTarget && !hasAssistantTarget(to.team, decisions.reviewTarget)) {
        decisions = withoutTarget(decisions);
        setState({ decisions });
      }
      const common = {
        operationId: host.newOperationId(),
        messages: intent.messages,
        ...(Object.keys(decisions).length > 0 && { decisions }),
      };
      request =
        'catalog' in to
          ? {
              ...common,
              mode: 'create',
              catalog: to.catalog.catalog,
              ...(intent.proposal && { proposal: intent.proposal }),
            }
          : { ...common, mode: 'edit', team: to.team };
      setState({
        pending: {
          operationId: request.operationId,
          controller,
          ...(unanswered && { unanswered }),
        },
      });
    }
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
          isUnusableAnswer(error.message)
        ) {
          unusable();
        } else if (!code || code === 'REQUEST_OUTCOME_UNKNOWN') {
          // If even the receipt was lost, Retry first retrieves the same operation.
          // A confirmed unknown is terminal; only explicit Retry starts a new one.
          setState({
            question: null,
            failure: t('logic.unknown'),
            receipt: !code ? { request, base, ...(resolved && { resolved }) } : null,
          });
        } else {
          failed(error);
        }
        return;
      }
      if (active()) receive(base, intent, request, result, resolved);
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

  /** Rebuild the shown proposal from the same composition with the person's new choices. */
  function adjust(reason: string, decisions: Decisions) {
    const { proposal } = getState();
    const { plan, resolved } = proposal ?? {};
    if (!proposal || !plan || !resolved || proposal.base !== editor.getState().draft) return;
    try {
      previewPlan(
        proposal.base,
        plan,
        { reason, resolved, target: decisions.reviewTarget },
        decisions,
      );
      const target = proposal.targets.find(
        (row) => decisions.reviewTarget && sameTarget(row, decisions.reviewTarget),
      );
      setState({ decisions, confirmedTarget: target ?? null });
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
    const intent =
      state.intent?.kind === 'model' && state.intent.mode === mode ? state.intent : null;
    // A message under a new team's proposal asks to change it: the request carries it.
    const shown = mode === 'create' && intent ? state.proposal : null;
    const refined = shown?.plan && shown.resolved ? shown : undefined;
    // A refinement still refines its proposal until a newer one is shown, however it ended:
    // refused, unknown, or cancelled. The next message continues it.
    const refining = mode === 'create' && Boolean(intent?.proposal);
    const continuation = state.question || refined || refining ? intent : null;
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
    if (!continuation) setState({ decisions: {}, confirmedTarget: null });
    const message: UserMessage = { role: 'user', content: text };
    const proposal = refined?.plan ?? continuation?.proposal;
    const catalog = refined?.resolved ?? continuation?.catalog;
    return run(
      {
        kind: 'model',
        mode,
        messages: continuation ? [...continuation.messages, message] : [message],
        ...(proposal && { proposal }),
        ...(catalog && { catalog }),
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
      // What a cancel brings back: the state before the press, before anything below changes it.
      const shown = getState();
      const { pending, receipt, intent, proposal, failure, decisions } = shown;
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
      // Asking again for a shown proposal keeps it to come back to if the request is cancelled.
      else await run(next, receipt, proposal ? shown : undefined);
    },
    chooseEdit(choice: Choice) {
      const state = getState();
      if (state.pending || modeOf(editor.getState().draft) !== 'edit') return;
      setState({
        turns: appendTurn(turnsWithProposal(state), 'user', t(`choice.${choice}`)),
        decisions: choice === 'require_review' ? { reviewPolicy: 'required' } : {},
        confirmedTarget: null,
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
    observe(value: boolean) {
      const { proposal, decisions } = getState();
      if (proposal?.plan)
        adjust(t(value ? 'logic.observeOn' : 'logic.observeOff'), {
          ...decisions,
          observeWork: value,
        });
    },
    confirmTarget(target: TeamAssistantTarget | undefined) {
      const { proposal, decisions } = getState();
      if (proposal?.plan?.outrider !== 'required_review') return;
      if (target && !proposal.targets.some((option) => sameTarget(option, target))) return;
      adjust(t('logic.required'), {
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
        turns: appendTurn(state.turns, 'assistant', proposal.reason),
        proposal: null,
        intent: null,
        receipt: null,
        decisions: {},
        confirmedTarget: null,
      });
      return proposal.focus;
    },
  };
}
