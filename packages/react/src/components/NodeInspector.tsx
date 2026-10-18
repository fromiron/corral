import type {
  AgentRole,
  CorralNode,
  InputBinding,
  InputBindingKind,
  LoopNode,
  OutputContract,
} from '@corral/contracts';
import { inputPortsOf, outputPortsOf } from '@corral/core';
import { type ReactNode, useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useStudioStores } from '../context.tsx';
import { checkConnection, connectCapability, type EditorDraft, findNode } from '../editor/model.ts';

const CONTRACTS: OutputContract[] = ['text', 'notes', 'draft', 'review'];
const BINDING_KINDS: InputBindingKind[] = [
  'run_input',
  'task_output',
  'previous_iteration_output',
  'explicit_version',
  'question_answer',
];
const field = 'rounded-md border border-line bg-surface p-2 text-sm';
const smallButton = 'rounded border border-line px-2 py-1 text-xs';

/** One focus session of a field is one undo step. */
function useEditSession() {
  const { editor } = useStudioStores();
  return {
    onFocus: () => editor.getState().beginBatch(),
    onBlur: () => editor.getState().endBatch(),
  };
}

/** A model profile the role may use, as the local server knows it (UX-06). */
export interface ProfileOption {
  profileId: string;
  label: string;
  available: boolean;
}

/**
 * The team's defaults and the selected node (UX-10): what applies to every run of the team is
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
      <h2 id={`${id}-heading`} className="text-sm font-semibold">
        {t('heading')}
      </h2>
      <div className="flex flex-col gap-1 rounded-lg bg-subtle/60 p-2.5">
        <p className="text-2xs font-medium text-muted">{t('teamDefaults')}</p>
        <label htmlFor={`${id}-brief`} className="text-xs font-medium">
          {t('brief')}
        </label>
        <p className="text-2xs text-muted">{t('briefHint')}</p>
        <textarea
          id={`${id}-brief`}
          value={brief}
          onChange={(e) => editor.getState().setBrief(e.target.value)}
          {...session}
          rows={2}
          className={field}
        />
      </div>
      {node ? (
        <NodeProperties
          node={node}
          profiles={profiles}
          roleSettings={roleSettings}
          loopSettings={loopSettings}
        />
      ) : (
        <p className="text-sm text-muted">{t('none')}</p>
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
      <label htmlFor={`${id}-label`} className="flex flex-col gap-1 text-xs font-medium">
        {t('label')}
        <input
          id={`${id}-label`}
          value={node.label}
          onChange={(e) => update(node.id, { label: e.target.value })}
          {...session}
          className={field}
        />
      </label>

      {node.type === 'agent' && role ? (
        <>
          <fieldset className="flex flex-col gap-1 text-xs">
            <legend className="font-medium">{t('invocation')}</legend>
            {(['scheduled', 'callable'] as const).map((value) => (
              <label key={value} className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`${id}-invocation`}
                  checked={node.invocation === value}
                  onChange={() => update(node.id, { invocation: value })}
                />
                {t(value)}
              </label>
            ))}
          </fieldset>
          <label htmlFor={`${id}-prompt`} className="flex flex-col gap-1 text-xs font-medium">
            {t('prompt')}
            <textarea
              id={`${id}-prompt`}
              value={role.prompt}
              onChange={(e) => update(node.id, { prompt: e.target.value })}
              {...session}
              rows={8}
              className={`${field} min-h-32 resize-y leading-6`}
            />
          </label>
          {sharedBy > 1 ? (
            <p className="text-xs text-warning">{t('sharedRole', { count: sharedBy })}</p>
          ) : null}
          {roleSettings?.(role, node.id)}
          <label htmlFor={`${id}-profile`} className="flex flex-col gap-1 text-xs font-medium">
            {t('modelProfile')}
            {profiles?.length ? (
              <select
                id={`${id}-profile`}
                value={role.modelProfile}
                onChange={(e) => update(node.id, { modelProfile: e.target.value })}
                className={field}
              >
                {profiles.some((p) => p.profileId === role.modelProfile) ? null : (
                  <option value={role.modelProfile}>
                    {t('profileMissing', { profile: role.modelProfile })}
                  </option>
                )}
                {profiles.map((p) => (
                  <option key={p.profileId} value={p.profileId}>
                    {p.profileId} — {p.label}
                    {p.available ? '' : ` (${t('profileSignIn')})`}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`${id}-profile`}
                value={role.modelProfile}
                onChange={(e) => update(node.id, { modelProfile: e.target.value })}
                {...session}
                className={field}
              />
            )}
          </label>
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={role.allowedWorkTools.includes('write_file')}
              onChange={(e) => update(node.id, { fileTools: e.target.checked })}
            />
            <span>
              <span className="font-medium">{t('fileTools')}</span>
              <span className="block text-muted">{t('fileToolsHint')}</span>
            </span>
          </label>
          <details className="text-xs">
            <summary className="cursor-pointer font-medium text-muted">{t('advanced')}</summary>
            <div className="mt-2 flex flex-col gap-3">
              <label htmlFor={`${id}-contract`} className="flex flex-col gap-1 text-xs font-medium">
                {t('contract')}
                <select
                  id={`${id}-contract`}
                  value={role.outputContract}
                  onChange={(e) =>
                    update(node.id, { outputContract: e.target.value as OutputContract })
                  }
                  className={field}
                >
                  {CONTRACTS.map((c) => (
                    <option key={c} value={c}>
                      {t(`contracts.${c}`)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </details>
        </>
      ) : null}

      {node.type === 'decision' ? (
        <label htmlFor={`${id}-mode`} className="flex flex-col gap-1 text-xs font-medium">
          {t('mode')}
          <select
            id={`${id}-mode`}
            value={node.mode}
            onChange={(e) => update(node.id, { mode: e.target.value as typeof node.mode })}
            className={field}
          >
            {(['review', 'approval', 'rule'] as const).map((mode) => (
              <option key={mode} value={mode}>
                {t(`modes.${mode}`)}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {node.type === 'loop' ? (
        <label htmlFor={`${id}-max`} className="flex flex-col gap-1 text-xs font-medium">
          {t('maxIterations')}
          <input
            id={`${id}-max`}
            type="number"
            min={1}
            max={10}
            value={node.maxIterations}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isInteger(value) && value >= 1 && value <= 10)
                update(node.id, { maxIterations: value });
            }}
            {...session}
            className={field}
          />
        </label>
      ) : null}

      {node.type === 'loop' ? loopSettings?.(node) : null}
      {node.type === 'output' ? (
        <>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={node.requireApproval}
              onChange={(e) => update(node.id, { requireApproval: e.target.checked })}
            />
            {t('requireApproval')}
          </label>
          <p className="text-xs text-muted">{t('outputNote')}</p>
        </>
      ) : null}

      {canJoinLoop && loops.length > 0 ? (
        <label htmlFor={`${id}-loop`} className="flex flex-col gap-1 text-xs font-medium">
          {t('loopMembership')}
          <select
            id={`${id}-loop`}
            value={('loopId' in node && node.loopId) || ''}
            onChange={(e) => editor.getState().setLoopMembership(node.id, e.target.value || null)}
            className={field}
          >
            <option value="">{t('notInLoop')}</option>
            {loops.map((loop) => (
              <option key={loop.id} value={loop.id}>
                {loop.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {node.type !== 'loop' ? <InputsEditor node={node} draft={draft} /> : null}
      <NextSteps node={node} draft={draft} />
      {node.type === 'agent' ? <Calls nodeId={node.id} draft={draft} /> : null}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => editor.getState().duplicateNode(node.id)}
          className={smallButton}
        >
          {t('duplicate')}
        </button>
        <button
          type="button"
          onClick={() => editor.getState().removeNode(node.id)}
          className="rounded border border-danger px-2 py-1 text-xs text-danger"
        >
          {t('delete')}
        </button>
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
    <fieldset className="flex flex-col gap-1 text-xs">
      <legend className="font-medium">{t('inputs')}</legend>
      {node.inputBindings.length === 0 ? <p className="text-muted">{t('noInputs')}</p> : null}
      <ul className="flex flex-col gap-1">
        {node.inputBindings.map((binding, index) => (
          <li
            key={`${binding.kind}:${binding.name}:${binding.sourceNodeId ?? ''}`}
            className="flex items-center justify-between gap-2"
          >
            <span>
              <span className="font-medium">{binding.name}</span> ·{' '}
              {t(`inputKinds.${binding.kind}`)}
              {binding.sourceNodeId ? ` · ${labelOf(binding.sourceNodeId)}` : ''}
            </span>
            <button
              type="button"
              aria-label={t('removeInput', { name: binding.name })}
              onClick={() => setBindings(node.inputBindings.filter((_, i) => i !== index))}
              className={smallButton}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-2 gap-1">
        <label htmlFor={`${id}-kind`} className="sr-only">
          {t('inputKind')}
        </label>
        <select
          id={`${id}-kind`}
          value={kind}
          onChange={(e) => setKind(e.target.value as InputBindingKind)}
          className={field}
        >
          {BINDING_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`inputKinds.${k}`)}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-source`} className="sr-only">
          {t('inputSource')}
        </label>
        <select
          id={`${id}-source`}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className={field}
        >
          <option value="">{t('inputSource')}</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-name`} className="sr-only">
          {t('inputName')}
        </label>
        <input
          id={`${id}-name`}
          placeholder={t('inputName')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={field}
        />
        <button type="button" onClick={add} className={smallButton}>
          {t('add')}
        </button>
      </div>
    </fieldset>
  );
}

/** Pointer-free connection: pick an output port and a valid target port (UX-001). */
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
    <fieldset className="flex flex-col gap-2 text-xs">
      <legend className="font-medium">{t('connections')}</legend>
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
              <button
                type="button"
                aria-label={t('removeConnection', { target: labelOf(existing.target) })}
                onClick={() => editor.getState().removeEdge(existing.id)}
                className={smallButton}
              >
                ✕
              </button>
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
            <select
              id={`${id}-${port}`}
              value={selected}
              onChange={(e) => setChoice({ ...choice, [port]: e.target.value })}
              className={`${field} min-w-0 flex-1`}
            >
              <option value="">{t('chooseTarget')}</option>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!selected}
              onClick={() => {
                const [target, targetPort] = selected.split(':') as [string, never];
                editor
                  .getState()
                  .connect({ source: node.id, sourcePort: port, target, targetPort });
                setChoice({ ...choice, [port]: '' });
              }}
              className={`${smallButton} disabled:opacity-40`}
            >
              {t('connect')}
            </button>
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
    <fieldset className="flex flex-col gap-1 text-xs">
      <legend className="font-medium">{t('calls')}</legend>
      <ul className="flex flex-col gap-1">
        {links.map((link) => (
          <li key={link.id} className="flex items-center justify-between gap-2">
            <span>
              {tLinks(link.kind)} {labelOf(link.targetNodeId)}
            </span>
            <button
              type="button"
              aria-label={t('removeCall', { target: labelOf(link.targetNodeId) })}
              onClick={() => editor.getState().removeLink(link.id)}
              className={smallButton}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      {anyCallable ? (
        <div className="flex items-center gap-1">
          <label htmlFor={`${id}-kind`} className="sr-only">
            {t('callKind')}
          </label>
          <select
            id={`${id}-kind`}
            value={kind}
            onChange={(e) => setKind(e.target.value as never)}
            className={field}
          >
            <option value="delegate">{tLinks('delegate')}</option>
            <option value="question">{tLinks('question')}</option>
          </select>
          <label htmlFor={`${id}-target`} className="sr-only">
            {t('callTarget')}
          </label>
          <select
            id={`${id}-target`}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className={`${field} min-w-0 flex-1`}
          >
            <option value="">{t('callTarget')}</option>
            {callables.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!target}
            onClick={() => {
              editor.getState().connectCapability(nodeId, target, kind);
              setTarget('');
            }}
            className={`${smallButton} disabled:opacity-40`}
          >
            {t('addCall')}
          </button>
        </div>
      ) : (
        <p className="text-muted">{t('noCallableAgents')}</p>
      )}
    </fieldset>
  );
}
