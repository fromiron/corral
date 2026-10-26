import type {
  AgentRole,
  CorralNode,
  InputBinding,
  InputBindingKind,
  LoopNode,
  OutputContract,
  ReasoningCapabilities,
} from '@corral/contracts';
import { inputPortsOf, outputPortsOf } from '@corral/core';
import { type ReactNode, useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useStudioStores } from '../context.tsx';
import {
  KitButton as Button,
  KitCard as Card,
  KitCardContent as CardContent,
  KitCardDescription as CardDescription,
  KitCardHeader as CardHeader,
  KitCardTitle as CardTitle,
  KitAccordion,
  KitAccordionContent,
  KitAccordionItem,
  KitAccordionTrigger,
  KitInputField,
  KitInputGroup,
  KitRadioGroup,
  KitRadioItem,
  KitSwitch,
  Select,
  Textarea,
} from '../design-kit/index.ts';
import { checkConnection, connectCapability, type EditorDraft, findNode } from '../editor/model.ts';
import { ReasoningSelect } from './ReasoningSelect.tsx';

const CONTRACTS: OutputContract[] = ['text', 'notes', 'draft', 'review'];
const BINDING_KINDS: InputBindingKind[] = [
  'run_input',
  'task_output',
  'previous_iteration_output',
  'explicit_version',
  'question_answer',
];

/** One focus session of a field is one undo step. */
function useEditSession() {
  const { editor } = useStudioStores();
  return {
    onFocus: () => editor.getState().beginBatch(),
    onBlur: () => editor.getState().endBatch(),
  };
}

/** A model profile the role may use, as the local server knows it. */
export interface ProfileOption {
  profileId: string;
  label: string;
  available: boolean;
  reasoningCapabilities?: ReasoningCapabilities | undefined;
}

/**
 * The team's defaults and the selected node: what applies to every run of the team is
 * kept apart from the selected role, and rarely changed settings are folded away.
 */
type RoleSettings = (role: AgentRole, nodeId: string) => ReactNode;
type LoopSettings = (node: LoopNode) => ReactNode;
export function NodeInspector({
  profiles = null,
  roleSettings,
  loopSettings,
}: {
  profiles?: ProfileOption[] | null;
  roleSettings?: RoleSettings;
  loopSettings?: LoopSettings;
} = {}) {
  const t = useTranslations('Inspector');
  const id = useId();
  const { editor } = useStudioStores();
  const session = useEditSession();
  const brief = useStore(editor, (s) => s.draft.definition.input.brief);
  const node = useStore(editor, (s) =>
    s.selectedNodeId ? findNode(s.draft, s.selectedNodeId) : undefined,
  );

  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-4">
      <h2 id={`${id}-heading`} className="text-subtitle">
        {t('heading')}
      </h2>
      <Card>
        <CardHeader>
          <CardTitle>{t('teamDefaults')}</CardTitle>
          <CardDescription>{t('briefHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <label htmlFor={`${id}-brief`} className="text-caption">
            {t('brief')}
          </label>
          <Textarea
            id={`${id}-brief`}
            value={brief}
            onChange={(e) => editor.getState().setBrief(e.target.value)}
            {...session}
            rows={2}
          />
        </CardContent>
      </Card>
      {node ? (
        <NodeProperties
          node={node}
          profiles={profiles}
          roleSettings={roleSettings}
          loopSettings={loopSettings}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t('none')}</p>
      )}
    </section>
  );
}

function NodeProperties({
  node,
  profiles,
  roleSettings,
  loopSettings,
}: {
  node: CorralNode;
  profiles: ProfileOption[] | null;
  roleSettings: RoleSettings | undefined;
  loopSettings: LoopSettings | undefined;
}) {
  const t = useTranslations('Inspector');
  const id = useId();
  const { editor } = useStudioStores();
  const session = useEditSession();
  const draft = useStore(editor, (s) => s.draft);
  const update = editor.getState().updateNode;
  const role =
    node.type === 'agent' ? draft.definition.roles.find((r) => r.id === node.roleId) : undefined;
  const sharedBy =
    node.type === 'agent'
      ? draft.definition.nodes.filter((n) => n.type === 'agent' && n.roleId === node.roleId).length
      : 0;
  const loops = draft.definition.nodes.filter((n) => n.type === 'loop');
  const canJoinLoop =
    (node.type === 'agent' && node.invocation === 'scheduled') || node.type === 'decision';

  return (
    <div className="flex flex-col gap-3" data-inspector-node={node.id}>
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
                update(node.id, { invocation: value as typeof node.invocation })
              }
            >
              {(['scheduled', 'callable'] as const).map((value, index) => (
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
          {roleSettings?.(role, node.id)}
          {profiles?.length ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-profile`} className="text-caption">
                {t('modelProfile')}
              </label>
              <Select
                id={`${id}-profile`}
                label={t('modelProfile')}
                value={role.modelProfile}
                onValueChange={(modelProfile) => update(node.id, { modelProfile })}
                options={[
                  ...(profiles.some((p) => p.profileId === role.modelProfile)
                    ? []
                    : [
                        {
                          value: role.modelProfile,
                          label: t('profileMissing', { profile: role.modelProfile }),
                        },
                      ]),
                  ...profiles.map((p) => ({
                    value: p.profileId,
                    label: `${p.profileId} — ${p.label}${p.available ? '' : ` (${t('profileSignIn')})`}`,
                  })),
                ]}
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
              <span className="font-normal text-muted-foreground">{t('editingModeHint')}</span>
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
              <KitInputGroup className="w-full" {...session}>
                <KitInputField
                  index={0}
                  label={t('imageProfile')}
                  value={role.imageProfile ?? ''}
                  onChange={(value) => update(node.id, { imageProfile: value || null })}
                  required
                  aria-describedby={`${id}-image-profile-hint`}
                />
              </KitInputGroup>
              <span id={`${id}-image-profile-hint`} className="font-normal text-muted-foreground">
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
      ) : null}

      {node.type === 'decision' ? (
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
        <KitInputGroup className="w-full" {...session}>
          <KitInputField
            index={0}
            label={t('maxIterations')}
            type="number"
            min={1}
            max={10}
            value={String(node.maxIterations)}
            onChange={(input) => {
              const value = Number(input);
              if (Number.isInteger(value) && value >= 1 && value <= 10)
                update(node.id, { maxIterations: value });
            }}
          />
        </KitInputGroup>
      ) : null}

      {node.type === 'loop' ? loopSettings?.(node) : null}
      {node.type === 'output' ? (
        <>
          <KitSwitch
            label={t('requireApproval')}
            checked={node.requireApproval}
            onToggle={() => update(node.id, { requireApproval: !node.requireApproval })}
          />
          <p className="text-caption text-muted-foreground">{t('outputNote')}</p>
        </>
      ) : null}

      {canJoinLoop && loops.length > 0 ? (
        <label htmlFor={`${id}-loop`} className="flex flex-col gap-1 text-caption">
          {t('loopMembership')}
          <Select
            id={`${id}-loop`}
            label={t('loopMembership')}
            value={('loopId' in node && node.loopId) || ''}
            onValueChange={(value) => editor.getState().setLoopMembership(node.id, value || null)}
            options={[
              { value: '', label: t('notInLoop') },
              ...loops.map((loop) => ({ value: loop.id, label: loop.label })),
            ]}
          />
        </label>
      ) : null}

      {node.type !== 'loop' ? <InputsEditor node={node} draft={draft} /> : null}
      <NextSteps node={node} draft={draft} />
      {node.type === 'agent' ? <Calls nodeId={node.id} draft={draft} /> : null}

      <div className="flex gap-2">
        <Button
          variant="tertiary"
          type="button"
          onClick={() => editor.getState().duplicateNode(node.id)}
        >
          {t('duplicate')}
        </Button>
        <Button
          variant="tertiary"
          className="text-destructive"
          type="button"
          onClick={() => editor.getState().removeNode(node.id)}
        >
          {t('delete')}
        </Button>
      </div>
    </div>
  );
}

function InputsEditor({
  node,
  draft,
}: {
  node: Exclude<CorralNode, { type: 'loop' }>;
  draft: EditorDraft;
}) {
  const t = useTranslations('Inspector');
  const id = useId();
  const { editor } = useStudioStores();
  const [kind, setKind] = useState<InputBindingKind>('task_output');
  const [source, setSource] = useState('');
  const [name, setName] = useState('');
  const agents = draft.definition.nodes.filter((n) => n.type === 'agent' && n.id !== node.id);
  const labelOf = (nodeId?: string) =>
    draft.definition.nodes.find((n) => n.id === nodeId)?.label ?? nodeId ?? '';

  const setBindings = (inputBindings: InputBinding[]) =>
    editor.getState().updateNode(node.id, { inputBindings });
  const add = () => {
    const bindingName = name.trim() || (kind === 'run_input' ? 'brief' : 'input');
    const binding: InputBinding = { kind, name: bindingName };
    if (kind === 'task_output' || kind === 'previous_iteration_output') {
      if (!source) return;
      binding.sourceNodeId = source;
    }
    if (kind === 'previous_iteration_output') binding.optional = true;
    setBindings([...node.inputBindings, binding]);
    setName('');
  };

  return (
    <fieldset className="flex flex-col gap-1 text-caption">
      <legend>{t('inputs')}</legend>
      {node.inputBindings.length === 0 ? (
        <p className="text-muted-foreground">{t('noInputs')}</p>
      ) : null}
      <ul className="flex flex-col gap-1">
        {node.inputBindings.map((binding, index) => (
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
              onClick={() => setBindings(node.inputBindings.filter((_, i) => i !== index))}
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
          value={source}
          onValueChange={setSource}
          options={[
            { value: '', label: t('inputSource') },
            ...agents.map((a) => ({ value: a.id, label: a.label })),
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
        <Button variant="tertiary" type="button" onClick={add}>
          {t('add')}
        </Button>
      </div>
    </fieldset>
  );
}

/** Pointer-free connection: pick an output port and a valid target port. */
function NextSteps({ node, draft }: { node: CorralNode; draft: EditorDraft }) {
  const t = useTranslations('Inspector');
  const tPorts = useTranslations('Canvas.ports');
  const id = useId();
  const { editor } = useStudioStores();
  const [choice, setChoice] = useState<Record<string, string>>({});
  const ports = outputPortsOf(node);
  if (ports.length === 0) return null;
  const labelOf = (nodeId: string) =>
    draft.definition.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;

  return (
    <fieldset className="flex flex-col gap-2 text-caption">
      <legend>{t('connections')}</legend>
      {ports.map((port) => {
        const existing = draft.definition.controlEdges.find(
          (e) => e.source === node.id && e.sourcePort === port,
        );
        if (existing) {
          return (
            <div key={port} className="flex items-center justify-between gap-2">
              <span>
                {t('connectFrom', { port: tPorts(port) })} → {labelOf(existing.target)} (
                {tPorts(existing.targetPort)})
              </span>
              <Button
                variant="tertiary"
                type="button"
                aria-label={t('removeConnection', { target: labelOf(existing.target) })}
                onClick={() => editor.getState().removeEdge(existing.id)}
              >
                ✕
              </Button>
            </div>
          );
        }
        const options = draft.definition.nodes.flatMap((target) =>
          inputPortsOf(target)
            .filter(
              (targetPort) =>
                checkConnection(draft, {
                  source: node.id,
                  sourcePort: port,
                  target: target.id,
                  targetPort,
                }).ok,
            )
            .map((targetPort) => ({
              value: `${target.id}:${targetPort}`,
              label: `${target.label} · ${tPorts(targetPort)}`,
            })),
        );
        const selected = choice[port] ?? '';
        return (
          <div key={port} className="flex items-center gap-1">
            <label htmlFor={`${id}-${port}`} className="w-16 shrink-0">
              {t('connectFrom', { port: tPorts(port) })}
            </label>
            <Select
              id={`${id}-${port}`}
              label={t('connectFrom', { port: tPorts(port) })}
              className="min-w-0 flex-1"
              value={selected}
              onValueChange={(value) => setChoice({ ...choice, [port]: value })}
              options={[{ value: '', label: t('chooseTarget') }, ...options]}
            />
            <Button
              variant="tertiary"
              type="button"
              disabled={!selected}
              onClick={() => {
                const [target, targetPort] = selected.split(':') as [string, never];
                editor
                  .getState()
                  .connect({ source: node.id, sourcePort: port, target, targetPort });
                setChoice({ ...choice, [port]: '' });
              }}
            >
              {t('connect')}
            </Button>
          </div>
        );
      })}
    </fieldset>
  );
}

function Calls({ nodeId, draft }: { nodeId: string; draft: EditorDraft }) {
  const t = useTranslations('Inspector');
  const tLinks = useTranslations('Canvas.linkLabel');
  const id = useId();
  const { editor } = useStudioStores();
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
    <fieldset className="flex flex-col gap-1 text-caption">
      <legend>{t('calls')}</legend>
      <ul className="flex flex-col gap-1">
        {links.map((link) => (
          <li key={link.id} className="flex items-center justify-between gap-2">
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
          </li>
        ))}
      </ul>
      {anyCallable ? (
        <div className="flex items-center gap-1">
          <label htmlFor={`${id}-kind`} className="sr-only">
            {t('callKind')}
          </label>
          <Select
            id={`${id}-kind`}
            label={t('callKind')}
            value={kind}
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
            value={target}
            onValueChange={setTarget}
            className="min-w-0 flex-1"
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
