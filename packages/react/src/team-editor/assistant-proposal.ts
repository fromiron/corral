import {
  type CorralNode,
  DEFAULT_ADVISOR_REVIEW,
  type InputBinding,
  isWorkAgent,
  type OutputNode,
  type RequiredOutputReview,
  type SharedOutrider,
  TeamAssistantReply,
  type TeamAssistantTarget,
  type TeamAssistantTeam,
  type TeamCatalog,
  type TeamComposition,
} from '@corral/contracts';
import {
  type CompileOptions,
  compileDefinition,
  draftFromComposition,
  type ResolvedCatalog,
  reviewedOutputBinding,
  TeamCompositionError,
  type TeamWording,
} from '@corral/core';
import type { EditorDraft } from '../editor/model.ts';
import {
  type EditResult,
  patchTeam,
  setRequiredOutputReview,
  setSharedOutrider,
} from './commands.ts';

export type AssistantText = (key: string, values?: Record<string, string | number>) => string;
type Edits = Extract<TeamAssistantReply, { kind: 'edits' }>['edits'];
type Nodes = ReadonlyMap<string, CorralNode>;
type Target = TeamAssistantTarget & { name: string; producerName: string };

/** The catalog a create request carried, with what its ids stood for on the editor's side. */
export type SentCatalog = ResolvedCatalog & { catalog: TeamCatalog };

export interface Proposal {
  base: EditorDraft;
  result: EditorDraft;
  focus: string;
  reason: string;
  /** A new team: the model's composition and what its catalog ids stood for in that request. */
  plan?: TeamComposition;
  resolved?: SentCatalog;
  canApply: boolean;
  targets: Target[];
  briefChange?: { before: string; after: string };
  changes: string[];
  origin: 'choice' | 'model';
}

interface ProposalOptions {
  reason: string;
  t: AssistantText;
  compileOptions?: Pick<CompileOptions, 'resolveTeam' | 'knownModelProfiles'> | undefined;
}

export function modeOf({ definition }: EditorDraft): 'create' | 'edit' {
  return definition.nodes.some(isWorkAgent) ? 'edit' : 'create';
}

function outputProducer(binding: InputBinding, nodes: Nodes) {
  if (binding.kind !== 'task_output' || !binding.sourceNodeId) return undefined;
  const node = nodes.get(binding.sourceNodeId);
  return (node?.type === 'agent' && node.invocation === 'scheduled') ||
    (node?.type === 'team' && node.source.kind === 'reference')
    ? node
    : undefined;
}

/** The wire format is an allowlist, never a serialized (or redacted) definition. */
export function summarize({ definition }: EditorDraft): TeamAssistantTeam {
  const nodes = new Map(definition.nodes.map((n) => [n.id, n]));
  const roles: TeamAssistantTeam['roles'] = [];
  const outputs: TeamAssistantTeam['outputs'] = [];
  for (const node of definition.nodes) {
    if (node.type === 'agent') roles.push({ nodeId: node.id, name: node.label });
    if (node.type !== 'output') continue;
    outputs.push({
      outputId: node.id,
      results: node.inputBindings.flatMap((binding, index) => {
        const producer = outputProducer(binding, nodes);
        return producer ? [{ index, name: binding.name, producerName: producer.label }] : [];
      }),
    });
  }
  return {
    roles,
    outputs,
    hasSharedOutrider: Boolean(definition.sharedOutrider),
    brief: definition.input.brief,
  };
}

function inputSource(binding: InputBinding, nodes: Nodes, t: AssistantText) {
  if (binding.kind === 'task_output')
    return outputProducer(binding, nodes)?.label ?? t('facts.unknown');
  if (binding.kind === 'previous_iteration_output') {
    const source = binding.sourceNodeId && nodes.get(binding.sourceNodeId);
    return source ? t('facts.prior', { source: source.label }) : t('facts.unknown');
  }
  return t(`Inspector.inputKinds.${binding.kind}`);
}

/** Imported outputs can share both their display label and their input names. Qualifiers
 * stay on screen: request data retains the original names and unfiltered input indexes. */
function outputLabels(nodes: Iterable<CorralNode>) {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const node of nodes) {
    if (node.type !== 'output') continue;
    if (seen.has(node.label)) repeated.add(node.label);
    seen.add(node.label);
  }
  return (output: OutputNode) =>
    repeated.has(output.label) ? `${output.label} (${output.id})` : output.label;
}

/** Use the same visible option for confirmation, button selection, and a typed answer. */
export function targetLabel({ definition }: EditorDraft, target: Target, t: AssistantText): string {
  const output = definition.nodes.find((n) => n.id === target.outputId);
  const label =
    output?.type === 'output' ? outputLabels(definition.nodes)(output) : target.outputId;
  const position = t('Inspector.requiredReviewPosition', { position: target.index + 1 });
  const source = t('Inspector.requiredReviewSource', {
    binding: target.name,
    source: target.producerName,
  });
  return `${label} · ${position} · ${source}`;
}

function resultName(output: OutputNode, binding: InputBinding) {
  return output.inputBindings.some((other) => other !== binding && other.name === binding.name)
    ? `${binding.name} (#${output.inputBindings.indexOf(binding) + 1})`
    : binding.name;
}

function reviewFact(
  output: OutputNode,
  outputLabel: string,
  gate: RequiredOutputReview,
  nodes: Nodes,
  t: AssistantText,
  blocked?: ReadonlySet<string>,
) {
  const binding = reviewedOutputBinding(output, gate);
  const producer = binding && outputProducer(binding, nodes);
  const reviewer = nodes.get(gate.reviewerNodeId);
  const name = binding ? resultName(output, binding) : gate.bindingName;
  if (
    !producer ||
    !isWorkAgent(reviewer) ||
    [output.id, gate.loopNodeId, gate.reviewerNodeId, gate.decisionNodeId].some((id) =>
      blocked?.has(id),
    )
  ) {
    return t('facts.brokenReview', { output: outputLabel, name });
  }
  return t('facts.review', {
    output: outputLabel,
    name,
    producer: producer.label,
    reviewer: reviewer.label,
  });
}

/** Answer from the current working copy. Neither the model's prose nor the last control edge
 * identifies a submitter: only the selected output binding does. */
export function describe(
  { definition }: EditorDraft,
  topic: 'submitter' | 'members' | 'review',
  t: AssistantText,
): string {
  const nodes = new Map(definition.nodes.map((n) => [n.id, n]));
  const lines: string[] = [];
  if (topic === 'submitter') {
    const outputs = definition.nodes.filter((n) => n.type === 'output');
    const label = outputs.length > 1 ? outputLabels(outputs) : null;
    for (const output of outputs) {
      for (const binding of output.inputBindings) {
        const producer = outputProducer(binding, nodes);
        if (!producer) continue;
        const sentence = t('facts.submitted', {
          name: resultName(output, binding),
          producer: producer.label,
        });
        lines.push(label ? `${label(output)} · ${sentence}` : sentence);
      }
    }
    return lines.length ? lines.join('\n') : t('facts.noSubmitter');
  }
  if (topic === 'members') {
    for (const node of definition.nodes) {
      if (node.type !== 'agent') continue;
      const member = node.label;
      if (!isWorkAgent(node)) {
        lines.push(t('facts.observer', { member }));
        continue;
      }
      lines.push(t('facts.member', { member, result: node.outputName }));
      for (const binding of node.inputBindings) {
        lines.push(
          t('facts.receives', {
            member,
            name: binding.name,
            source: inputSource(binding, nodes, t),
          }),
        );
      }
    }
    return lines.length ? lines.join('\n') : t('facts.noMembers');
  }

  const gateDecisions = new Set<string>();
  const gateReviewers = new Set<string>();
  const label = outputLabels(nodes.values());
  // A saved policy can outlive a hand-edited wire. Never describe a blocked output as
  // guaranteed to pass through the original loop. Use the compiler's bypass detection.
  const blocked = new Set<string>();
  if (definition.nodes.some((n) => n.type === 'output' && n.requiredReviews?.length)) {
    for (const issue of compileDefinition(definition).diagnostics) {
      if (issue.code !== 'REQUIRED_OUTPUT_REVIEW') continue;
      const at = issue.nodeId ?? definition.controlEdges.find((e) => e.id === issue.edgeId)?.target;
      if (at) blocked.add(at);
    }
  }
  for (const output of definition.nodes) {
    if (output.type !== 'output') continue;
    if (output.requireApproval) lines.push(t('facts.finalApproval', { output: label(output) }));
    for (const gate of output.requiredReviews ?? []) {
      lines.push(reviewFact(output, label(output), gate, nodes, t, blocked));
      gateDecisions.add(gate.decisionNodeId);
      gateReviewers.add(gate.reviewerNodeId);
    }
  }
  if (!gateDecisions.size) lines.push(t('facts.noGate'));
  const reviewRoles = new Set(
    definition.roles.filter((r) => r.outputContract === 'review').map((r) => r.id),
  );
  for (const node of definition.nodes) {
    if (isWorkAgent(node) && reviewRoles.has(node.roleId) && !gateReviewers.has(node.id)) {
      lines.push(t('facts.reviewer', { member: node.label }));
    }
    if (node.type === 'decision' && node.mode === 'review' && !gateDecisions.has(node.id)) {
      lines.push(t('facts.reviewStep', { step: node.label }));
      for (const binding of node.inputBindings) {
        lines.push(
          t('facts.receives', {
            member: node.label,
            name: binding.name,
            source: inputSource(binding, nodes, t),
          }),
        );
      }
    }
  }
  const scope = (targets: SharedOutrider['targets']) =>
    targets.kind === 'all'
      ? t('facts.all')
      : targets.nodeIds.map((id) => nodes.get(id)?.label ?? id).join(', ') || t('facts.none');
  const advice = definition.sharedOutrider;
  if (advice) {
    lines.push(
      advice.targets.kind === 'all'
        ? t('facts.adviceAll')
        : t('facts.adviceSelected', { targets: scope(advice.targets) }),
    );
    if (advice.artifactReview) lines.push(t('facts.artifactAdvice'));
    if (advice.observation)
      lines.push(t('facts.observation', { targets: scope(advice.observation.targets) }));
  } else {
    lines.push(t('facts.noAdvice'));
  }
  for (const link of definition.capabilityLinks) {
    const from = nodes.get(link.sourceNodeId)?.label;
    const to = nodes.get(link.targetNodeId)?.label;
    if (!from || !to) continue;
    if (link.kind === 'advise') lines.push(t('facts.advises', { advisor: from, worker: to }));
    if (link.kind === 'question') lines.push(t('facts.question', { worker: from, advisor: to }));
  }
  return lines.join('\n');
}

function accepted(change: EditResult, t: AssistantText): EditorDraft {
  if (!change.ok) throw new Error(t(`TeamEditor.rejected.${change.reason}`));
  return change.draft;
}

function addAdvice(draft: EditorDraft, t: AssistantText): EditorDraft {
  if (draft.definition.sharedOutrider) return draft;
  return accepted(
    setSharedOutrider(draft, {
      modelProfile: draft.definition.roles[0]?.modelProfile ?? '',
      principles: t('TeamEditor.sharedOutrider.defaultPrinciples'),
      targets: { kind: 'all' },
    }),
    t,
  );
}

function requireReview(
  draft: EditorDraft,
  target: TeamAssistantTarget,
  t: AssistantText,
): EditorDraft {
  const output = draft.definition.nodes.find((n) => n.id === target.outputId);
  if (output?.type !== 'output') throw new Error(t('TeamEditor.rejected.unknownNode'));
  const binding = output.inputBindings[target.index];
  if (binding?.kind !== 'task_output' || !binding.sourceNodeId) {
    throw new Error(t('TeamEditor.rejected.invalidResultInput'));
  }
  // Older policies lack binding IDs. Match exactly as the compiler does, including the
  // ambiguity rule. Never reset advice settings to install a gate or to repeat a no-op.
  if (output.requiredReviews?.some((g) => reviewedOutputBinding(output, g) === binding))
    return draft;
  return accepted(
    setRequiredOutputReview(
      addAdvice(draft, t),
      output.id,
      binding.name,
      binding.sourceNodeId,
      {
        loop: t('Inspector.requiredReviewLabels.loop'),
        reviewer: t('Inspector.requiredReviewLabels.reviewer'),
        decision: t('Inspector.requiredReviewLabels.decision'),
      },
      target.index,
    ),
    t,
  );
}

function check(draft: EditorDraft, { t, compileOptions }: ProposalOptions) {
  const compiled = compileDefinition(draft.definition, compileOptions);
  if (compiled.ok) return;
  const issue = compiled.diagnostics.find((d) => d.severity === 'error')!;
  const path = issue.schemaPath;
  if (path && /^input\.(?:brief|criteria)(?:\.\d+)?$/.test(path))
    throw new Error(t('Validation.schema.runInput'));
  if (path && /^nodes\.\d+\.inputBindings$/.test(path))
    throw new Error(t('Validation.schema.inputBindings'));
  if (path && ['entryNodeId', 'nodes', 'controlEdges', 'roles'].includes(path))
    throw new Error(t(`Validation.schema.${path}`));
  if (issue.code === 'JOIN_PARTIAL' || issue.code === 'PARALLEL_UNJOINED')
    throw new Error(t('invalid.compile', { code: issue.code }));
  throw new Error(
    t(`Validation.codes.${issue.code}`, {
      message: issue.message,
      node: draft.definition.nodes.find((n) => n.id === issue.nodeId)?.label ?? '',
    }),
  );
}

export function createProposal(
  base: EditorDraft,
  plan: TeamComposition,
  options: ProposalOptions & {
    wording: Pick<TeamWording, 'labels'>;
    initialName: string;
    resolved: SentCatalog;
    target?: TeamAssistantTarget | undefined;
    /** The person turned automatic observation on in the proposal. */
    observe?: boolean | undefined;
  },
): Proposal {
  const { t, target, resolved } = options;
  if (
    base.definition.nodes.length ||
    base.definition.roles.length ||
    base.definition.sharedOutrider
  ) {
    throw new Error(t('invalid.occupied'));
  }
  const parsed = TeamAssistantReply.safeParse({ kind: 'plan', plan, reason: options.reason });
  if (!parsed.success || parsed.data.kind !== 'plan') throw new Error(t('invalid.proposal'));
  let definition: ReturnType<typeof draftFromComposition>;
  try {
    definition = draftFromComposition(parsed.data.plan, base.definition.id, resolved, {
      ...options.wording.labels,
      join: t('TeamEditor.kinds.join'),
      // A group side by side that starts the team sits in a Team, named as one made by hand.
      group: t('TeamEditor.kinds.team'),
    });
  } catch (error) {
    if (error instanceof TeamCompositionError) throw new Error(t('logic.unusable'));
    throw error;
  }
  // Only these newly generated template slots are defaults. An edit to an existing team
  // keeps its authored profile IDs, even when a profile is no longer installed.
  const profiles = options.compileOptions?.knownModelProfiles;
  const first = profiles?.[0];
  if (profiles && first) {
    const bind = (seat: { modelProfile?: string | undefined }) => {
      if (seat.modelProfile && !profiles.includes(seat.modelProfile)) seat.modelProfile = first;
    };
    for (const role of definition.roles) bind(role);
    if (definition.sharedOutrider) bind(definition.sharedOutrider);
    for (const node of definition.nodes) {
      if (node.type === 'decision' && node.mode === 'router') bind(node);
      if (node.type === 'loop' && node.limitPolicy?.kind === 'upper_model') bind(node.limitPolicy);
    }
  }
  if (base.definition.name !== options.initialName) definition.name = base.definition.name;
  // draftFromComposition already constructed a new graph. Keep the editor's ID counters for its
  // lifetime; nextId also checks the plan's new graph before allocating any node or edge ID.
  let result = { ...base, definition };
  if (options.observe) {
    const shared = definition.sharedOutrider;
    result = accepted(
      setSharedOutrider(result, {
        modelProfile: shared?.modelProfile ?? definition.roles[0]?.modelProfile ?? 'model-a',
        principles: shared?.principles ?? t('TeamEditor.sharedOutrider.defaultPrinciples'),
        targets: shared?.targets ?? { kind: 'all' },
        ...(shared?.artifactReview ? { artifactReview: true as const } : {}),
        observation: { targets: { kind: 'all' }, review: { ...DEFAULT_ADVISOR_REVIEW } },
      }),
      t,
    );
  }
  const targets =
    plan.outrider === 'required_review'
      ? summarize(result).outputs.flatMap(({ outputId, results }) =>
          results.map((r) => ({ ...r, outputId })),
        )
      : [];
  if (target) {
    if (!targets.some((row) => row.outputId === target.outputId && row.index === target.index)) {
      throw new Error(t('TeamEditor.rejected.invalidResultInput'));
    }
    result = requireReview(result, target, t);
  }
  check(result, options);
  return {
    base,
    result,
    reason: parsed.data.reason,
    plan,
    resolved,
    targets,
    changes: [],
    // A new team's plan comes from the model alone.
    origin: 'model',
    focus: definition.nodes.find(isWorkAgent)!.id,
    canApply: plan.outrider !== 'required_review' || Boolean(target),
  };
}

export function editProposal(
  base: EditorDraft,
  edits: Edits,
  options: ProposalOptions & { origin: 'choice' | 'model' },
): Proposal {
  const { t } = options;
  const parsed = TeamAssistantReply.safeParse({ kind: 'edits', edits, reason: options.reason });
  if (!parsed.success || parsed.data.kind !== 'edits') throw new Error(t('invalid.proposal'));
  let result = base;
  const changedReviews: TeamAssistantTarget[] = [];
  for (const edit of parsed.data.edits) {
    switch (edit.kind) {
      case 'add_shared_advice':
        result = addAdvice(result, t);
        break;
      case 'require_review': {
        const next = requireReview(result, edit, t);
        if (next !== result) changedReviews.push(edit);
        result = next;
        break;
      }
      case 'set_brief':
        if (result.definition.input.brief !== edit.brief)
          result = patchTeam(result, { brief: edit.brief });
        break;
    }
  }
  const changes: string[] = [];
  let focus = '@request';
  const before = base.definition.input.brief;
  const after = result.definition.input.brief;
  const briefChange = before === after ? undefined : { before, after };
  if (result.definition.sharedOutrider && !base.definition.sharedOutrider) {
    changes.push(t('diff.advice'));
    focus = '@advice';
  }
  if (changedReviews.length) {
    const nodes = new Map(result.definition.nodes.map((n) => [n.id, n]));
    const label = outputLabels(nodes.values());
    for (const { outputId, index } of changedReviews) {
      const output = nodes.get(outputId);
      const gate =
        output?.type === 'output' &&
        output.requiredReviews?.find(
          (g) => reviewedOutputBinding(output, g) === output.inputBindings[index],
        );
      if (!gate || output?.type !== 'output')
        throw new Error(t('TeamEditor.rejected.requiredReviewNeedsSource'));
      changes.push(reviewFact(output, label(output), gate, nodes, t));
      focus = outputId;
    }
  }
  const canApply = Boolean(briefChange || changes.length);
  if (!canApply) result = base;
  check(result, options);
  return {
    base,
    result,
    reason: parsed.data.reason,
    origin: options.origin,
    focus,
    canApply,
    ...(briefChange && { briefChange }),
    targets: [],
    changes,
  };
}
