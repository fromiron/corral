import {
  type AgentNode,
  type AgentRole,
  advisorReview,
  type CorralNode,
  Identifier,
  type InputBinding,
  type InputBindingKind,
  type LoopLimitPolicy,
  type LoopNode,
  type ObserverAgentNode,
  type OutputContract,
  type ReasoningCapabilities,
  ReasoningLevel,
} from '@corral/contracts';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { ModelSelect, type ProfileChoice, profileChoices } from '../components/ModelSelect.tsx';
import { ReasoningSelect } from '../components/ReasoningSelect.tsx';
import {
  KitButton as Button,
  Collapse,
  KitAccordion,
  KitAccordionContent,
  KitAccordionItem,
  KitAccordionTrigger,
  KitCheckboxGroup,
  KitCheckboxItem,
  KitInputField,
  KitInputGroup,
  KitRadioGroup,
  KitRadioItem,
  KitSwitch,
  Select,
  TabItem,
  Tabs,
  TabsList,
  Textarea,
} from '../design-kit/index.ts';
import {
  ADVISOR_READ_TOOLS,
  connectCapability,
  type EditorDraft,
  withDefinition,
} from '../editor/model.ts';
import type { EditorStore } from '../editor/store.ts';
import { X } from '../ui/icons.ts';
import { patchNode, removeItems, watchAgent } from './commands.ts';

// The settings of one step that the team editor's sheet shows: role, model, tools, inputs and
// call links for agents, and the kind-specific fields of decisions, loops and outputs. Every
// field writes through the editor store, so undo covers it.

/** A model profile the role may use, as the local server knows it. */
export interface ProfileOption extends ProfileChoice {
  reasoningCapabilities?: ReasoningCapabilities | undefined;
}

/** A saved image profile a role can choose. The value stored on the role is profileId. */
export interface ImageProfileChoice {
  profileId: string;
  label: string;
}

function imageProfileChoices(
  saved: readonly ImageProfileChoice[] | null,
  current: string | null | undefined,
  missing: (id: string) => string,
): { value: string; label: string }[] {
  // Unknown list: keep the role's saved id on screen and do not pretend the list is empty.
  if (!saved) return current ? [{ value: current, label: current }] : [];
  const options = saved.map((profile) => ({ value: profile.profileId, label: profile.label }));
  if (current && !saved.some((profile) => profile.profileId === current))
    options.unshift({ value: current, label: missing(current) });
  return options;
}

export type RoleSettings = (role: AgentRole, nodeId: string) => ReactNode;
export type LoopSettings = (node: LoopNode) => ReactNode;

const CONTRACTS: OutputContract[] = ['text', 'notes', 'draft', 'review'];
const INVOCATIONS: AgentNode['invocation'][] = ['scheduled', 'callable', 'observer'];
const BINDING_KINDS: InputBindingKind[] = [
  'run_input',
  'task_output',
  'previous_iteration_output',
  'explicit_version',
  'question_answer',
];

/** One focus session of a field is one undo step. */
function useEditSession(editor: EditorStore) {
  return {
    onFocus: () => editor.getState().beginBatch(),
    onBlur: () => editor.getState().endBatch(),
  };
}

export function NodeSettings({
  editor,
  node,
  profiles,
  imageProfiles,
  roleSettings,
  loopSettings,
}: {
  editor: EditorStore;
  node: CorralNode;
  profiles: ProfileOption[] | null;
  imageProfiles: readonly ImageProfileChoice[] | null;
  roleSettings: RoleSettings | undefined;
  loopSettings: LoopSettings | undefined;
}) {
  const t = useTranslations('Inspector');
  const tm = useTranslations('ModelSelect');
  const id = useId();
  const session = useEditSession(editor);
  const draft = useStore(editor, (s) => s.draft);
  const update = editor.getState().updateNode;
  const role =
    node.type === 'agent' ? draft.definition.roles.find((r) => r.id === node.roleId) : undefined;
  const sharedBy =
    node.type === 'agent'
      ? draft.definition.nodes.filter((n) => n.type === 'agent' && n.roleId === node.roleId).length
      : 0;

  return (
    <div className="flex flex-col gap-3" data-node-settings={node.id}>
      <KitInputGroup className="w-full" {...session}>
        <KitInputField
          index={0}
          label={t('label')}
          value={node.label}
          onChange={(label) => update(node.id, { label })}
        />
      </KitInputGroup>

      {node.type === 'agent' && role ? (
        <>
          <fieldset>
            <legend className="text-caption">{t('invocation')}</legend>
            <KitRadioGroup
              aria-label={t('invocation')}
              value={node.invocation}
              onValueChange={(value) =>
                update(node.id, { invocation: value as AgentNode['invocation'] })
              }
            >
              {INVOCATIONS.map((value, index) => (
                <KitRadioItem key={value} index={index} value={value} label={t(value)} />
              ))}
            </KitRadioGroup>
          </fieldset>
          <label htmlFor={`${id}-prompt`} className="flex flex-col gap-1 text-caption">
            {t('prompt')}
            <Textarea
              id={`${id}-prompt`}
              value={role.prompt}
              onChange={(e) => update(node.id, { prompt: e.target.value })}
              {...session}
              rows={8}
              className="resize-y"
            />
          </label>
          {sharedBy > 1 ? (
            <p className="text-caption text-warning">{t('sharedRole', { count: sharedBy })}</p>
          ) : null}
          {node.invocation === 'observer' ? null : roleSettings?.(role, node.id)}
          {profiles?.length ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-profile`} className="text-caption">
                {t('modelProfile')}
              </label>
              <ModelSelect
                id={`${id}-profile`}
                label={t('modelProfile')}
                value={role.modelProfile}
                onValueChange={(modelProfile) => update(node.id, { modelProfile })}
                options={profileChoices(profiles, {
                  profiles: tm('profiles'),
                  unavailable: t('profileSignIn'),
                })}
              />
            </div>
          ) : (
            <KitInputGroup className="w-full" {...session}>
              <KitInputField
                index={0}
                label={t('modelProfile')}
                value={role.modelProfile}
                onChange={(modelProfile) => update(node.id, { modelProfile })}
              />
            </KitInputGroup>
          )}
          <ReasoningSelect
            value={role.reasoning}
            capabilities={
              profiles?.find((p) => p.profileId === role.modelProfile)?.reasoningCapabilities
            }
            onChange={(reasoning) => update(node.id, { reasoning })}
          />
          {node.invocation === 'observer' ? (
            <AdvisorFields editor={editor} node={node} role={role} draft={draft} />
          ) : (
            <WorkTools
              editor={editor}
              node={node}
              role={role}
              draft={draft}
              sharedBy={sharedBy}
              imageProfiles={imageProfiles}
            />
          )}
        </>
      ) : null}

      {node.type === 'decision' && 'rule' in node ? (
        <label htmlFor={`${id}-mode`} className="flex flex-col gap-1 text-caption">
          {t('mode')}
          <Select
            id={`${id}-mode`}
            label={t('mode')}
            value={node.mode}
            onValueChange={(mode) => update(node.id, { mode })}
            options={(['review', 'approval', 'rule'] as const).map((value) => ({
              value,
              label: t(`modes.${value}`),
            }))}
          />
        </label>
      ) : null}

      {node.type === 'loop' ? (
        <LoopLimit editor={editor} node={node} profiles={profiles} draft={draft} />
      ) : null}

      {node.type === 'loop' ? loopSettings?.(node) : null}
      {node.type === 'output' ? (
        <KitSwitch
          label={t('requireApproval')}
          checked={node.requireApproval}
          onToggle={() => update(node.id, { requireApproval: !node.requireApproval })}
        />
      ) : null}

      {(node.type === 'team' ? node.source.kind === 'reference' : 'inputBindings' in node) ? (
        <InputsEditor
          editor={editor}
          node={node as Extract<CorralNode, { inputBindings?: unknown }>}
          draft={draft}
        />
      ) : null}
      {node.type === 'agent' && node.invocation === 'scheduled' ? (
        <Calls editor={editor} nodeId={node.id} draft={draft} />
      ) : null}
    </div>
  );
}

/** A working agent's tools and output: files, commands, the team plan, images and previews. */
function WorkTools({
  editor,
  node,
  role,
  draft,
  sharedBy,
  imageProfiles,
}: {
  editor: EditorStore;
  node: CorralNode;
  role: AgentRole;
  draft: EditorDraft;
  sharedBy: number;
  imageProfiles: readonly ImageProfileChoice[] | null;
}) {
  const t = useTranslations('Inspector');
  const id = useId();
  const update = editor.getState().updateNode;
  return (
    <>
      <div className="flex flex-col gap-1">
        <KitSwitch
          label={t('fileTools')}
          checked={role.allowedWorkTools.includes('write_file')}
          onToggle={() =>
            update(node.id, { fileTools: !role.allowedWorkTools.includes('write_file') })
          }
        />
        <p className="text-caption text-muted-foreground">{t('fileToolsHint')}</p>
      </div>
      {role.allowedWorkTools.includes('write_file') ? (
        <label htmlFor={`${id}-editing`} className="flex flex-col gap-1 text-caption">
          {t('editingMode')}
          <Select
            id={`${id}-editing`}
            label={t('editingMode')}
            value={role.editingMode ?? 'pi'}
            onValueChange={(editingMode) => update(node.id, { editingMode })}
            options={[
              { value: 'pi', label: t('editingModePi') },
              { value: 'hashline', label: t('editingModeHashline') },
            ]}
          />
          <span className="text-muted-foreground">{t('editingModeHint')}</span>
        </label>
      ) : null}
      <div className="flex flex-col gap-1">
        <KitSwitch
          label={t('runCommand')}
          checked={role.allowedWorkTools.includes('run_command')}
          onToggle={() =>
            update(node.id, { runCommand: !role.allowedWorkTools.includes('run_command') })
          }
        />
        <p className="text-caption text-muted-foreground">{t('runCommandHint')}</p>
      </div>
      <KitSwitch
        label={t('teamPlanOwner')}
        checked={draft.definition.planOwnerRoleId === role.id}
        disabled={sharedBy > 1}
        onToggle={() =>
          update(node.id, { teamPlanOwner: !(draft.definition.planOwnerRoleId === role.id) })
        }
      />
      <div className="flex flex-col gap-1">
        <KitSwitch
          label={t('generateImage')}
          checked={role.allowedWorkTools.includes('generate_image')}
          onToggle={() =>
            update(node.id, {
              generateImage: !role.allowedWorkTools.includes('generate_image'),
            })
          }
        />
        <p className="text-caption text-muted-foreground">{t('generateImageHint')}</p>
      </div>
      {role.allowedWorkTools.includes('generate_image') ? (
        <div className="flex flex-col gap-1 text-caption">
          <Select
            label={t('imageProfile')}
            describedBy={`${id}-image-profile-hint`}
            value={role.imageProfile ?? null}
            placeholder={t('imageProfilePlaceholder')}
            onValueChange={(imageProfile) => update(node.id, { imageProfile })}
            options={imageProfileChoices(
              imageProfiles,
              role.imageProfile,
              (profileId) => `${profileId} (${t('imageProfileMissing')})`,
            )}
          />
          <span id={`${id}-image-profile-hint`} className="text-muted-foreground">
            {t('imageProfileHint')}
          </span>
        </div>
      ) : null}
      <KitAccordion className="w-full">
        <KitAccordionItem value="previews">
          <KitAccordionTrigger>{t('previews')}</KitAccordionTrigger>
          <KitAccordionContent>
            <div className="mt-2 flex flex-col gap-3">
              {(
                [
                  ['previewFile', 'preview_file'],
                  ['previewApp', 'preview_app'],
                  ['previewAction', 'preview_action'],
                ] as const
              ).map(([key, tool]) => (
                <div key={key} className="flex flex-col gap-1">
                  <KitSwitch
                    label={t(key)}
                    checked={role.allowedWorkTools.includes(tool)}
                    onToggle={() =>
                      update(node.id, { [key]: !role.allowedWorkTools.includes(tool) })
                    }
                  />
                  <p className="text-caption text-muted-foreground">{t(`${key}Hint`)}</p>
                </div>
              ))}
            </div>
          </KitAccordionContent>
        </KitAccordionItem>
      </KitAccordion>
      <KitAccordion className="w-full">
        <KitAccordionItem value="advanced">
          <KitAccordionTrigger>{t('advanced')}</KitAccordionTrigger>
          <KitAccordionContent>
            <div className="mt-2 flex flex-col gap-3">
              <label htmlFor={`${id}-contract`} className="flex flex-col gap-1 text-caption">
                {t('contract')}
                <Select
                  id={`${id}-contract`}
                  label={t('contract')}
                  value={role.outputContract}
                  onValueChange={(outputContract) => update(node.id, { outputContract })}
                  options={CONTRACTS.map((value) => ({
                    value,
                    label: t(`contracts.${value}`),
                  }))}
                />
              </label>
            </div>
          </KitAccordionContent>
        </KitAccordionItem>
      </KitAccordion>
    </>
  );
}

/**
 * What only an advisor has: the tools it reads with, the agents it watches as name chips with a
 * way to add one, and how many model requests of theirs pass between its reviews. Its other
 * review setting is kept as it is.
 */
function AdvisorFields({
  editor,
  node,
  role,
  draft,
}: {
  editor: EditorStore;
  node: ObserverAgentNode;
  role: AgentRole;
  draft: EditorDraft;
}) {
  const t = useTranslations('Inspector');
  const id = useId();
  const session = useEditSession(editor);
  const { applyDraft, updateNode } = editor.getState();
  const reads = ADVISOR_READ_TOOLS.filter((tool) => role.allowedWorkTools.includes(tool));
  const checked = new Set(
    ADVISOR_READ_TOOLS.flatMap((tool, index) => (reads.includes(tool) ? [index] : [])),
  );
  const labelOf = (nodeId: string) =>
    draft.definition.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;
  const watching = draft.definition.capabilityLinks.filter(
    (link) => link.kind === 'advise' && link.sourceNodeId === node.id,
  );
  const candidates = draft.definition.nodes.filter((n) => watchAgent(draft, node.id, n.id).ok);
  const review = advisorReview(node);
  // A removed chip's focus goes to the next chip, else to the add list, never to the page.
  const chips = useRef<HTMLDivElement>(null);
  const [refocus, setRefocus] = useState<{ next: string | null } | null>(null);
  useEffect(() => {
    if (!refocus) return;
    const target =
      (refocus.next
        ? chips.current?.querySelector<HTMLElement>(`[data-watch="${refocus.next}"]`)
        : null) ?? document.getElementById(`${id}-add-watch`);
    target?.focus();
    setRefocus(null);
  }, [refocus, id]);
  return (
    <>
      <div className="flex flex-col gap-1">
        <span id={`${id}-reads`} className="text-caption">
          {t('readTools')}
        </span>
        <KitCheckboxGroup
          aria-labelledby={`${id}-reads`}
          checkedIndices={checked}
          className="w-full"
        >
          {ADVISOR_READ_TOOLS.map((tool, index) => (
            <KitCheckboxItem
              key={tool}
              index={index}
              label={t(`readTool.${tool}`)}
              checked={reads.includes(tool)}
              onToggle={() =>
                updateNode(node.id, {
                  readTools: reads.includes(tool)
                    ? reads.filter((other) => other !== tool)
                    : [...reads, tool],
                })
              }
            />
          ))}
        </KitCheckboxGroup>
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-caption">{t('watches')}</legend>
        {watching.length ? (
          <div ref={chips} className="flex flex-wrap gap-1.5">
            {watching.map((link, index) => (
              <Button
                key={link.id}
                data-watch={link.id}
                variant="secondary"
                size="compact"
                trailingIcon={X}
                aria-label={t('removeWatched', { target: labelOf(link.targetNodeId) })}
                onClick={() => {
                  applyDraft(removeItems(editor.getState().draft, [link.id]));
                  setRefocus({ next: watching[index + 1]?.id ?? null });
                }}
              >
                {labelOf(link.targetNodeId)}
              </Button>
            ))}
          </div>
        ) : null}
        {candidates.length ? (
          <Select
            id={`${id}-add-watch`}
            label={t('addWatched')}
            placeholder={t('addWatched')}
            value={null}
            onValueChange={(agent: string) => {
              const result = watchAgent(editor.getState().draft, node.id, agent);
              if (result.ok) applyDraft(result.draft);
            }}
            options={candidates.map((n) => ({ value: n.id, label: n.label }))}
          />
        ) : null}
      </fieldset>
      <div className="flex items-center gap-2 text-body">
        <span aria-hidden="true">{t('reviewEvery')}</span>
        <KitInputGroup className="w-16" {...session}>
          <KitInputField
            index={0}
            label={t('reviewField')}
            labelHidden
            type="number"
            min={1}
            value={String(review.interval)}
            onChange={(input) => {
              const interval = Number(input);
              if (Number.isSafeInteger(interval) && interval >= 1)
                applyDraft(
                  patchNode(editor.getState().draft, node.id, { review: { ...review, interval } }),
                );
            }}
          />
        </KitInputGroup>
        <span aria-hidden="true">{t('reviewRequests', { count: review.interval })}</span>
      </div>
    </>
  );
}

type LimitChoice = Exclude<LoopLimitPolicy['kind'], 'unlimited'>;
const LIMIT_CHOICES: LimitChoice[] = ['exhaust', 'raise_reasoning', 'upper_model'];
const RAISE_LEVELS = ReasoningLevel.options.filter((level) => level !== 'off');
const DEFAULT_ROUNDS = 3;

/**
 * A Loop's limit, read as a sentence: up to N rounds or no limit, and at the limit end, raise
 * reasoning to a level or switch to another model. Each choice is one write, so the Loop never
 * passes through a state that team-graph.md structure rule 4 rejects. Turning the cap back on
 * starts from three rounds that end; undo brings back what was there.
 */
function LoopLimit({
  editor,
  node,
  profiles,
  draft,
}: {
  editor: EditorStore;
  node: LoopNode;
  profiles: ProfileOption[] | null;
  draft: EditorDraft;
}) {
  const t = useTranslations('Inspector.loopLimit');
  const level = useTranslations('Reasoning.level');
  const tm = useTranslations('ModelSelect');
  const ti = useTranslations('Inspector');
  const id = useId();
  const session = useEditSession(editor);
  const write = (change: Record<string, unknown>) =>
    editor.getState().applyDraft(patchNode(editor.getState().draft, node.id, change));

  const policy = node.limitPolicy;
  const unlimited = policy?.kind === 'unlimited';
  const choice: LimitChoice = !policy || policy.kind === 'unlimited' ? 'exhaust' : policy.kind;
  // A review recipe ends the Loop at its attempts, so the Loop can only end.
  const recipe = node.reviewRecipe !== undefined;
  const reason = recipe ? `${id}-recipe` : undefined;
  // A runnable profile first; with no list, the model a role already uses.
  const upperProfile = [
    profiles?.find((profile) => profile.available)?.profileId,
    profiles?.[0]?.profileId,
    draft.definition.roles[0]?.modelProfile,
  ].find((profile) => profile !== undefined && Identifier.safeParse(profile).success);
  const unavailable = (value: LimitChoice) =>
    (recipe && value !== 'exhaust') || (value === 'upper_model' && !upperProfile);

  const toggleUnlimited = () =>
    write(
      unlimited
        ? { maxIterations: DEFAULT_ROUNDS, limitPolicy: undefined }
        : { maxIterations: undefined, limitPolicy: { kind: 'unlimited' } },
    );
  const choose = (next: string) => {
    if (next === choice || unavailable(next as LimitChoice)) return;
    write({
      limitPolicy:
        next === 'raise_reasoning'
          ? { kind: 'raise_reasoning', level: 'high' }
          : next === 'upper_model'
            ? { kind: 'upper_model', modelProfile: upperProfile }
            : undefined,
    });
  };

  return (
    // Named by its first line rather than a legend, so the switch can share that line.
    <fieldset
      aria-labelledby={`${id}-limit`}
      aria-describedby={reason}
      className="flex flex-col gap-2"
    >
      {/* The switch sits on the group's own line, so it stays put when the rows below go. */}
      <div className="flex items-center justify-between gap-2">
        <span id={`${id}-limit`} className="text-caption">
          {t('group')}
        </span>
        <KitSwitch
          label={t('unlimited')}
          checked={unlimited}
          disabled={recipe && !unlimited}
          onToggle={toggleUnlimited}
        />
      </div>
      {reason ? (
        <span id={reason} className="sr-only">
          {t('recipeOnly')}
        </span>
      ) : null}
      {/* The kit's fold, as other rows that come and go with a choice; the margin keeps focus
          rings outside its clip. */}
      <Collapse
        open={!unlimited}
        hideWhenClosed
        className="-m-1"
        innerClassName="flex flex-col gap-2 p-1"
      >
        <div className="flex items-center gap-2 text-body">
          <span aria-hidden="true">{t('upTo')}</span>
          <KitInputGroup className="w-16" {...session}>
            <KitInputField
              index={0}
              label={t('roundsField')}
              labelHidden
              type="number"
              min={1}
              value={String(node.maxIterations ?? '')}
              onChange={(input) => {
                const value = Number(input);
                if (Number.isSafeInteger(value) && value >= 1)
                  editor.getState().updateNode(node.id, { maxIterations: value });
              }}
            />
          </KitInputGroup>
          <span aria-hidden="true">{t('rounds', { count: node.maxIterations ?? 0 })}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body">
          <span id={`${id}-at`}>{t('atLimit')}</span>
          <Tabs value={choice} onValueChange={choose} size="compact">
            <TabsList aria-labelledby={`${id}-at`} aria-describedby={reason}>
              {LIMIT_CHOICES.map((value) => (
                <TabItem
                  key={value}
                  value={value}
                  label={t(`policy.${value}`)}
                  disabled={unavailable(value)}
                  // The kit's tabs draw no disabled state; this one matches its Switch.
                  className={unavailable(value) ? 'pointer-events-none opacity-50' : undefined}
                />
              ))}
            </TabsList>
          </Tabs>
        </div>
      </Collapse>
      {!recipe && policy?.kind === 'raise_reasoning' ? (
        <Select
          label={t('level')}
          value={policy.level}
          onValueChange={(next) =>
            write({ limitPolicy: { kind: 'raise_reasoning', level: ReasoningLevel.parse(next) } })
          }
          options={RAISE_LEVELS.map((value) => ({ value, label: level(value) }))}
        />
      ) : null}
      {!recipe && policy?.kind === 'upper_model' ? (
        profiles?.length ? (
          <ModelSelect
            label={t('model')}
            value={policy.modelProfile}
            onValueChange={(modelProfile) =>
              write({ limitPolicy: { kind: 'upper_model', modelProfile } })
            }
            options={profileChoices(profiles, {
              profiles: tm('profiles'),
              unavailable: ti('profileSignIn'),
            })}
          />
        ) : (
          <KitInputGroup className="w-full" {...session}>
            <KitInputField
              index={0}
              label={t('model')}
              value={policy.modelProfile}
              onChange={(modelProfile) => {
                // As the role's model field: a blank or malformed id keeps the one before.
                if (Identifier.safeParse(modelProfile).success)
                  write({ limitPolicy: { kind: 'upper_model', modelProfile } });
              }}
            />
          </KitInputGroup>
        )
      ) : null}
    </fieldset>
  );
}

function InputsEditor({
  editor,
  node,
  draft,
}: {
  editor: EditorStore;
  node: Extract<CorralNode, { inputBindings?: unknown }>;
  draft: EditorDraft;
}) {
  const t = useTranslations('Inspector');
  const bindings = node.inputBindings ?? [];
  const id = useId();
  const [kind, setKind] = useState<InputBindingKind>('task_output');
  const [source, setSource] = useState('');
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  // Agents in the flow produce outputs to read; callable agents answer their caller. A
  // referenced Team gives what its Output collects.
  const sources = draft.definition.nodes.filter(
    (n) =>
      n.id !== node.id &&
      ((n.type === 'agent' && n.invocation === 'scheduled') ||
        (kind === 'task_output' && n.type === 'team' && n.source.kind === 'reference')),
  );
  const needsSource = kind === 'task_output' || kind === 'previous_iteration_output';
  const ready = needsSource
    ? Boolean(source)
    : kind === 'explicit_version'
      ? Boolean(version.trim())
      : true;
  const labelOf = (nodeId?: string) =>
    draft.definition.nodes.find((n) => n.id === nodeId)?.label ?? nodeId ?? '';

  const setBindings = (inputBindings: InputBinding[]) =>
    editor.getState().updateNode(node.id, { inputBindings });
  const add = () => {
    const bindingName = name.trim() || (kind === 'run_input' ? 'brief' : 'input');
    if (!ready) return;
    const binding: InputBinding = { kind, name: bindingName };
    if (needsSource) binding.sourceNodeId = source;
    if (kind === 'explicit_version') binding.artifactVersionId = version.trim();
    if (kind === 'previous_iteration_output') binding.optional = true;
    setBindings([...bindings, binding]);
    setName('');
    setVersion('');
  };

  return (
    <fieldset className="flex flex-col gap-1 text-caption">
      <legend>{t('inputs')}</legend>
      {bindings.length === 0 ? <p className="text-muted-foreground">{t('noInputs')}</p> : null}
      <ul className="flex flex-col gap-1">
        {bindings.map((binding, index) => (
          <li
            key={`${binding.kind}:${binding.name}:${binding.sourceNodeId ?? ''}`}
            className="flex items-center justify-between gap-2"
          >
            <span>
              <span>{binding.name}</span> · {t(`inputKinds.${binding.kind}`)}
              {binding.sourceNodeId ? ` · ${labelOf(binding.sourceNodeId)}` : ''}
            </span>
            <Button
              variant="tertiary"
              type="button"
              aria-label={t('removeInput', { name: binding.name })}
              onClick={() => setBindings(bindings.filter((_, i) => i !== index))}
            >
              ✕
            </Button>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-2 gap-1">
        <label htmlFor={`${id}-kind`} className="sr-only">
          {t('inputKind')}
        </label>
        <Select
          id={`${id}-kind`}
          label={t('inputKind')}
          className="w-full min-w-0"
          value={kind}
          onValueChange={setKind}
          options={BINDING_KINDS.map((value) => ({ value, label: t(`inputKinds.${value}`) }))}
        />
        <label htmlFor={`${id}-source`} className="sr-only">
          {t('inputSource')}
        </label>
        <Select
          id={`${id}-source`}
          label={t('inputSource')}
          className="w-full min-w-0"
          value={source}
          onValueChange={setSource}
          options={[
            { value: '', label: t('inputSource') },
            ...sources.map((a) => ({ value: a.id, label: a.label })),
          ]}
        />
        <KitInputGroup className="w-full">
          <KitInputField
            index={0}
            label={t('inputName')}
            labelHidden
            placeholder={t('inputName')}
            value={name}
            onChange={setName}
          />
        </KitInputGroup>
        {kind === 'explicit_version' ? (
          <KitInputGroup className="col-span-2 w-full">
            <KitInputField
              index={0}
              label={t('inputVersion')}
              labelHidden
              placeholder={t('inputVersion')}
              value={version}
              onChange={setVersion}
            />
          </KitInputGroup>
        ) : null}
        <Button variant="tertiary" type="button" disabled={!ready} onClick={add}>
          {t('add')}
        </Button>
      </div>
    </fieldset>
  );
}

function Calls({
  editor,
  nodeId,
  draft,
}: {
  editor: EditorStore;
  nodeId: string;
  draft: EditorDraft;
}) {
  const t = useTranslations('Inspector');
  const tLinks = useTranslations('Canvas.linkLabel');
  const id = useId();
  const [kind, setKind] = useState<'delegate' | 'question'>('delegate');
  const [target, setTarget] = useState('');
  const links = draft.definition.capabilityLinks.filter((l) => l.sourceNodeId === nodeId);
  const callables = draft.definition.nodes.filter(
    (n) => connectCapability(draft, nodeId, n.id, kind).ok,
  );
  const labelOf = (id: string) => draft.definition.nodes.find((n) => n.id === id)?.label ?? id;
  const anyCallable = draft.definition.nodes.some(
    (n) => n.type === 'agent' && n.invocation === 'callable',
  );

  return (
    <fieldset className="flex min-w-0 flex-col gap-1 text-caption">
      <legend>{t('calls')}</legend>
      <ul className="flex flex-col gap-1">
        {links.map((link) => (
          <li key={link.id} className="flex flex-col gap-1">
            <span className="flex items-center justify-between gap-2">
              <span>
                {tLinks(link.kind)} {labelOf(link.targetNodeId)}
              </span>
              <Button
                variant="tertiary"
                type="button"
                aria-label={t('removeCall', { target: labelOf(link.targetNodeId) })}
                onClick={() => editor.getState().removeLink(link.id)}
              >
                ✕
              </Button>
            </span>
            {link.kind === 'delegate' ? (
              <KitSwitch
                label={t('parentQuestions')}
                checked={link.parentQuestions === true}
                onToggle={() => {
                  const { draft } = editor.getState();
                  editor.getState().applyDraft(
                    withDefinition(draft, {
                      ...draft.definition,
                      capabilityLinks: draft.definition.capabilityLinks.map((l) => {
                        if (l.id !== link.id) return l;
                        const { parentQuestions: _was, ...rest } = l;
                        return link.parentQuestions ? rest : { ...rest, parentQuestions: true };
                      }),
                    }),
                  );
                }}
              />
            ) : null}
          </li>
        ))}
      </ul>
      {anyCallable ? (
        <div className="grid min-w-0 grid-cols-1 gap-1">
          <label htmlFor={`${id}-kind`} className="sr-only">
            {t('callKind')}
          </label>
          <Select
            id={`${id}-kind`}
            label={t('callKind')}
            value={kind}
            className="w-full min-w-0"
            onValueChange={setKind}
            options={(['delegate', 'question'] as const).map((value) => ({
              value,
              label: tLinks(value),
            }))}
          />
          <label htmlFor={`${id}-target`} className="sr-only">
            {t('callTarget')}
          </label>
          <Select
            id={`${id}-target`}
            label={t('callTarget')}
            placeholder={t('callTarget')}
            value={target}
            onValueChange={setTarget}
            className="w-full min-w-0"
            options={[
              { value: '', label: t('callTarget') },
              ...callables.map((n) => ({ value: n.id, label: n.label })),
            ]}
          />
          <Button
            variant="tertiary"
            type="button"
            disabled={!target}
            onClick={() => {
              editor.getState().connectCapability(nodeId, target, kind);
              setTarget('');
            }}
          >
            {t('addCall')}
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground">{t('noCallableAgents')}</p>
      )}
    </fieldset>
  );
}
