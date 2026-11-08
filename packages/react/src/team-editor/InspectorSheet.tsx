import type { ControlEdge, CorralNode, TargetPort } from '@corral/contracts';
import { type Diagnostic, outputPortsOf } from '@corral/core';
import { type ReactNode, useId } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { ProfileOption } from '../components/NodeInspector.tsx';
import { Button, Checkbox, Input, Select, Textarea, useSize } from '../design-kit/index.ts';
import { fontWeights } from '../design-kit/lib/font-weight.ts';
import { cn } from '../design-kit/lib/utils.ts';
import type { EditorStore } from '../editor/store.ts';
import { CircleAlert, Plus, Trash2, TriangleAlert, X } from '../ui/icons.ts';
import {
  checkPorts,
  connectPorts,
  patchNode,
  patchTeam,
  primaryIn,
  removeItems,
  wrapIn,
} from './commands.ts';
import { KIND_ICON, kindOf, roleOf } from './kinds.ts';
import type { TeamSelection } from './TeamGraphCanvas.tsx';

// The floating settings sheet: what the selection is, its settings, where it leads and what is
// wrong with it. Every field writes through the editor store, so undo covers it.

export interface InspectorSheetProps {
  editor: EditorStore;
  diagnostics: readonly Diagnostic[];
  selection: TeamSelection;
  /** Shows the team's own settings instead of the selection's. */
  team: boolean;
  profiles: ProfileOption[] | null;
  onSelect: (selection: TeamSelection) => void;
  onClose: () => void;
}

function Field({
  label,
  hint,
  select = false,
  children,
}: {
  label: string;
  hint?: string;
  /** A select names itself, so the caption above it is not a <label>. */
  select?: boolean;
  children: ReactNode;
}) {
  const size = useSize();
  const caption = <span className={cn(size.type.caption, 'text-muted-foreground')}>{label}</span>;
  const note = hint ? (
    <span className={cn(size.type.micro, 'text-muted-foreground')}>{hint}</span>
  ) : null;
  if (select)
    return (
      <div className="grid gap-1">
        <span aria-hidden>{caption}</span>
        {children}
        {note}
      </div>
    );
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the child passed in.
    <label className="grid gap-1">
      {caption}
      {children}
      {note}
    </label>
  );
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

export function InspectorSheet({
  editor,
  diagnostics,
  selection,
  team,
  profiles,
  onSelect,
  onClose,
}: InspectorSheetProps) {
  const t = useTranslations('TeamEditor');
  const f = useTranslations('TeamEditor.fields');
  const portName = useTranslations('Canvas.ports');
  const codeText = useTranslations('Validation.codes');
  const size = useSize();
  const id = useId();
  const draft = useStore(editor, (s) => s.draft);
  const { definition } = draft;
  const apply = editor.getState().applyDraft;
  const batch = {
    onFocus: () => editor.getState().beginBatch(),
    onBlur: () => editor.getState().endBatch(),
  };
  const nodes = new Map(definition.nodes.map((n) => [n.id, n]));
  const name = (nodeId: string) => nodes.get(nodeId)?.label ?? nodeId;
  const issueText = (d: Diagnostic) =>
    codeText.has(d.code) ? codeText(d.code, { message: d.message }) : d.message;

  const issues = (ids: string[]) => {
    const list = diagnostics.filter((d) => ids.includes(d.nodeId ?? d.edgeId ?? d.linkId ?? ''));
    if (!list.length) return null;
    return (
      <section className="grid gap-1.5" aria-label={t('issues')}>
        {list.map((d, i) => {
          const Icon = d.severity === 'error' ? CircleAlert : TriangleAlert;
          return (
            <p
              // biome-ignore lint/suspicious/noArrayIndexKey: diagnostics have no id of their own.
              key={i}
              className={cn(
                size.type.caption,
                'flex gap-1.5',
                d.severity === 'error' ? 'text-destructive' : 'text-warning',
              )}
            >
              <Icon size={14} aria-hidden className="mt-px shrink-0" />
              <span className="text-foreground">{issueText(d)}</span>
            </p>
          );
        })}
      </section>
    );
  };

  const number = (value: string) => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : undefined;
  };

  let title = '';
  let body: ReactNode = null;

  if (team) {
    title = t('teamSettings');
    const limits = definition.limits;
    const limitField = (key: keyof typeof limits, label: string, scale = 1) => (
      <Field label={label}>
        <Input
          type="number"
          min={1}
          value={String(Math.round(limits[key] / scale))}
          onChange={(e) => {
            const value = number(e.target.value);
            if (value && value > 0) apply(patchTeam(draft, { limits: { [key]: value * scale } }));
          }}
          {...batch}
        />
      </Field>
    );
    body = (
      <>
        <Field label={f('label')}>
          <Input
            value={definition.name}
            onChange={(e) => apply(patchTeam(draft, { name: e.target.value }))}
            {...batch}
          />
        </Field>
        <Field label={f('brief')}>
          <Textarea
            value={definition.input.brief}
            onChange={(e) => apply(patchTeam(draft, { brief: e.target.value }))}
            {...batch}
          />
        </Field>
        <Field label={f('criteria')} hint={f('criteriaHint')}>
          <Textarea
            value={(definition.input.criteria ?? []).join('\n')}
            onChange={(e) => apply(patchTeam(draft, { criteria: lines(e.target.value) }))}
            {...batch}
          />
        </Field>
        <section className="grid gap-3">
          <h3
            className={cn(size.type.caption, 'text-foreground')}
            style={{ fontVariationSettings: fontWeights.semibold }}
          >
            {f('limits')}
          </h3>
          <div className="grid grid-cols-2 gap-3">
            {limitField('maxModelCalls', f('maxModelCalls'))}
            {limitField('maxOutputTokens', f('maxOutputTokens'))}
            {limitField('maxDelegationDepth', f('maxDelegationDepth'))}
            {limitField('maxSpawns', f('maxSpawns'))}
            {limitField('runDeadlineMs', f('runDeadlineSeconds'), 1000)}
          </div>
        </section>
      </>
    );
  } else if (selection.edge) {
    const edge = definition.controlEdges.find((e) => e.id === selection.edge);
    const link = definition.capabilityLinks.find((l) => l.id === selection.edge);
    title = t('connection');
    const from = edge ? edge.source : link?.sourceNodeId;
    const to = edge ? edge.target : link?.targetNodeId;
    body = (
      <>
        <dl className={cn(size.type.body, 'grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5')}>
          <dt className="text-muted-foreground">{t('from')}</dt>
          <dd>
            {from ? name(from) : ''}
            {edge ? (
              <span className="text-muted-foreground"> · {portName(edge.sourcePort)}</span>
            ) : null}
          </dd>
          <dt className="text-muted-foreground">{t('to')}</dt>
          <dd>
            {to ? name(to) : ''}
            {edge ? (
              <span className="text-muted-foreground"> · {portName(edge.targetPort)}</span>
            ) : null}
          </dd>
        </dl>
        {issues([selection.edge])}
        <Button
          variant="secondary"
          size="compact"
          className="justify-self-start"
          onClick={() => {
            apply(removeItems(draft, [selection.edge as string]));
            onSelect({ nodes: [], edge: null });
          }}
        >
          <Trash2 /> {t('delete')}
        </Button>
      </>
    );
  } else if (selection.nodes.length > 1) {
    title = t('selectedCount', { count: selection.nodes.length });
    const wrap = (kind: 'loop' | 'team') => wrapIn(draft, selection.nodes, kind);
    const loop = wrap('loop');
    body = (
      <>
        <ul className={cn(size.type.body, 'grid gap-1')}>
          {selection.nodes.map((nodeId) => (
            <li key={nodeId}>{name(nodeId)}</li>
          ))}
        </ul>
        {loop.ok ? null : (
          <p className={cn(size.type.caption, 'text-muted-foreground')}>
            {t(`rejected.${loop.reason}`)}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {(['loop', 'team'] as const).map((kind) => {
            const result = kind === 'loop' ? loop : wrap('team');
            return (
              <Button
                key={kind}
                variant="secondary"
                size="compact"
                disabled={!result.ok}
                onClick={() => {
                  if (!result.ok) return;
                  apply(result.draft);
                  onSelect({ nodes: [result.nodeId as string], edge: null });
                }}
              >
                {t(kind === 'loop' ? 'wrapLoop' : 'wrapTeam')}
              </Button>
            );
          })}
          <Button
            variant="secondary"
            size="compact"
            onClick={() => {
              apply(removeItems(draft, selection.nodes));
              onSelect({ nodes: [], edge: null });
            }}
          >
            <Trash2 /> {t('deleteCount', { count: selection.nodes.length })}
          </Button>
        </div>
      </>
    );
  } else if (selection.nodes.length === 1) {
    const node = nodes.get(selection.nodes[0] as string);
    if (node) {
      title = t(`kinds.${kindOf(node)}`);
      body = (
        <>
          <NodeFields
            node={node}
            label={(key) => f(key)}
            profiles={profiles}
            batch={batch}
            idPrefix={id}
            editor={editor}
          />
          {issues([node.id])}
          <Connections editor={editor} node={node} onSelect={onSelect} />
          <div className="flex flex-wrap gap-2">
            {node.type !== 'loop' && node.type !== 'team' ? null : (
              <Button
                variant="secondary"
                size="compact"
                onClick={() => {
                  apply(removeItems(draft, [node.id]));
                  onSelect({ nodes: [], edge: null });
                }}
              >
                <Trash2 /> {t('delete')}
              </Button>
            )}
            {node.type === 'loop' || node.type === 'team' ? null : (
              <>
                {(['loop', 'team'] as const).map((kind) => {
                  const result = wrapIn(draft, [node.id], kind);
                  return result.ok ? (
                    <Button
                      key={kind}
                      variant="secondary"
                      size="compact"
                      onClick={() => {
                        apply(result.draft);
                        onSelect({ nodes: [result.nodeId as string], edge: null });
                      }}
                    >
                      {t(kind === 'loop' ? 'wrapLoop' : 'wrapTeam')}
                    </Button>
                  ) : null;
                })}
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={() => {
                    apply(removeItems(draft, [node.id]));
                    onSelect({ nodes: [], edge: null });
                  }}
                >
                  <Trash2 /> {t('delete')}
                </Button>
              </>
            )}
          </div>
        </>
      );
    }
  }

  const selectedNode =
    !team && selection.nodes.length === 1 ? nodes.get(selection.nodes[0] as string) : undefined;
  const Icon = selectedNode ? KIND_ICON[kindOf(selectedNode)] : null;
  return (
    <aside
      aria-label={t('inspector')}
      className="pointer-events-auto flex h-full w-[344px] flex-col overflow-hidden rounded-[14px] border border-border bg-background shadow-lg"
    >
      <header className="flex items-center gap-2 border-b border-border py-2 pr-2 pl-4">
        {Icon ? <Icon size={14} aria-hidden className="text-muted-foreground" /> : null}
        <h2
          className={cn(size.type.body, 'grow truncate text-foreground')}
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {title}
        </h2>
        <Button variant="ghost" size="icon-compact" aria-label={t('close')} onClick={onClose}>
          <X />
        </Button>
      </header>
      <div className="grid content-start gap-4 overflow-y-auto p-4">{body}</div>
    </aside>
  );
}

function NodeFields({
  node,
  label,
  profiles,
  batch,
  idPrefix,
  editor,
}: {
  node: CorralNode;
  label: (key: string) => string;
  profiles: ProfileOption[] | null;
  batch: { onFocus: () => void; onBlur: () => void };
  idPrefix: string;
  editor: EditorStore;
}) {
  const t = useTranslations('TeamEditor');
  const draft = useStore(editor, (s) => s.draft);
  const { updateNode, applyDraft: apply } = editor.getState();
  const patch = (change: Record<string, unknown>) => apply(patchNode(draft, node.id, change));
  const number = (value: string) => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : undefined;
  };
  const name = (
    <Field label={label('label')}>
      <Input
        value={node.label}
        onChange={(e) => updateNode(node.id, { label: e.target.value })}
        {...batch}
      />
    </Field>
  );
  const note = (
    <Field label={label('note')}>
      <Textarea
        size="sm"
        value={node.note ?? ''}
        onChange={(e) => patch({ note: e.target.value || undefined })}
        {...batch}
      />
    </Field>
  );
  switch (node.type) {
    case 'agent': {
      const role = roleOf(draft.definition, node);
      return (
        <>
          {name}
          {role ? (
            profiles?.length ? (
              <Field select label={label('model')}>
                <Select
                  label={label('model')}
                  id={`${idPrefix}-model`}
                  value={role.modelProfile}
                  onValueChange={(modelProfile) => updateNode(node.id, { modelProfile })}
                  options={[
                    ...(profiles.some((p) => p.profileId === role.modelProfile)
                      ? []
                      : [{ value: role.modelProfile, label: role.modelProfile }]),
                    ...profiles.map((p) => ({ value: p.profileId, label: p.label })),
                  ]}
                />
              </Field>
            ) : (
              <Field label={label('model')}>
                <Input
                  value={role.modelProfile}
                  onChange={(e) => updateNode(node.id, { modelProfile: e.target.value })}
                  {...batch}
                />
              </Field>
            )
          ) : null}
          <Field select label={label('invocation')}>
            <Select
              label={label('invocation')}
              id={`${idPrefix}-invocation`}
              value={node.invocation}
              onValueChange={(invocation) => updateNode(node.id, { invocation })}
              options={[
                { value: 'scheduled', label: label('scheduled') },
                { value: 'callable', label: label('callable') },
              ]}
            />
          </Field>
          {role ? (
            <Field label={label('prompt')}>
              <Textarea
                value={role.prompt}
                onChange={(e) => updateNode(node.id, { prompt: e.target.value })}
                {...batch}
              />
            </Field>
          ) : null}
          {node.invocation === 'scheduled' ? (
            <Field label={label('retry')}>
              <Input
                type="number"
                min={0}
                value={String(node.retry?.maxAttempts ?? 0)}
                onChange={(e) => {
                  const value = number(e.target.value) ?? 0;
                  patch({ retry: value > 0 ? { maxAttempts: value } : undefined });
                }}
                {...batch}
              />
            </Field>
          ) : null}
          {note}
        </>
      );
    }
    case 'decision':
      return (
        <>
          {name}
          {node.mode === 'review' || node.mode === 'approval' || node.mode === 'rule' ? (
            <Field select label={t('kinds.rule')}>
              <Select
                label={t('kinds.rule')}
                id={`${idPrefix}-mode`}
                value={node.mode}
                onValueChange={(mode) => updateNode(node.id, { mode })}
                options={(['review', 'approval', 'rule'] as const).map((mode) => ({
                  value: mode,
                  label: t(`kinds.${mode}`),
                }))}
              />
            </Field>
          ) : null}
          {node.mode === 'check' ? (
            <Field label={label('checks')} hint={label('checksHint')}>
              <Textarea
                size="sm"
                value={node.checkIds.join('\n')}
                onChange={(e) => {
                  const ids = lines(e.target.value);
                  if (ids.length) patch({ checkIds: ids });
                }}
                {...batch}
              />
            </Field>
          ) : null}
          {node.mode === 'router' ? (
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-caption text-muted-foreground">{label('routes')}</legend>
              {node.routes.map((route, index) => (
                <span key={route.id} className="flex items-center gap-1.5">
                  <Input
                    aria-label={label('routeLabel')}
                    value={route.label}
                    onChange={(e) =>
                      patch({
                        routes: node.routes.map((r, i) =>
                          i === index ? { ...r, label: e.target.value } : r,
                        ),
                      })
                    }
                    {...batch}
                  />
                  <Button
                    variant="ghost"
                    size="icon-compact"
                    aria-label={label('removeRoute').replace('{route}', route.label)}
                    disabled={node.routes.length <= 1}
                    onClick={() => {
                      const routes = node.routes.filter((r) => r.id !== route.id);
                      const next = patchNode(draft, node.id, { routes });
                      apply(
                        removeItems(
                          next,
                          next.definition.controlEdges
                            .filter((e) => e.source === node.id && e.sourcePort === route.id)
                            .map((e) => e.id),
                        ),
                      );
                    }}
                  >
                    <X />
                  </Button>
                </span>
              ))}
              <Button
                variant="ghost"
                size="compact"
                className="justify-self-start"
                disabled={node.routes.length >= 20}
                onClick={() => {
                  const taken = new Set(node.routes.map((r) => r.id));
                  let n = node.routes.length + 1;
                  while (taken.has(`route_${n}`)) n += 1;
                  patch({ routes: [...node.routes, { id: `route_${n}`, label: `Route ${n}` }] });
                }}
              >
                <Plus /> {label('addRoute')}
              </Button>
            </fieldset>
          ) : null}
          {note}
        </>
      );
    case 'loop':
      return (
        <>
          {name}
          <Field label={label('maxIterations')}>
            <Input
              type="number"
              min={1}
              value={String(node.maxIterations)}
              onChange={(e) => {
                const value = number(e.target.value);
                if (value && value >= 1) updateNode(node.id, { maxIterations: value });
              }}
              {...batch}
            />
          </Field>
          <fieldset className="grid grid-cols-3 gap-2">
            <legend className="mb-1 text-caption text-muted-foreground">{label('budget')}</legend>
            {(
              [
                ['maxModelCalls', 1],
                ['maxOutputTokens', 1],
                ['maxWallSeconds', 1000],
              ] as const
            ).map(([key, scale]) => {
              const field = key === 'maxWallSeconds' ? 'maxWallMs' : key;
              const value = node.budget?.[field];
              return (
                <Field key={key} label={label(key)}>
                  <Input
                    type="number"
                    min={1}
                    placeholder={label('unset')}
                    value={value === undefined ? '' : String(Math.round(value / scale))}
                    onChange={(e) => {
                      const n = number(e.target.value);
                      const budget = { ...node.budget };
                      if (n && n > 0) budget[field] = n * scale;
                      else delete budget[field];
                      patch({ budget: Object.keys(budget).length ? budget : undefined });
                    }}
                    {...batch}
                  />
                </Field>
              );
            })}
          </fieldset>
          <Checkbox
            label={label('stallDetection')}
            checked={node.stallDetection ?? false}
            onToggle={() => patch({ stallDetection: node.stallDetection ? undefined : true })}
          />
          {note}
        </>
      );
    case 'team':
      return (
        <>
          {name}
          <Field label={label('source')}>
            <span className="text-body text-foreground">
              {node.source.kind === 'inline'
                ? t('inline')
                : t('reference', { revision: node.source.definitionRevision })}
            </span>
          </Field>
          {note}
        </>
      );
    case 'join':
      return (
        <>
          {name}
          <Field select label={label('policy')}>
            <Select
              label={label('policy')}
              id={`${idPrefix}-policy`}
              value={node.policy}
              onValueChange={(policy) => patch({ policy })}
              options={[
                { value: 'all', label: label('policyAll') },
                { value: 'any', label: label('policyAny') },
              ]}
            />
          </Field>
          {note}
        </>
      );
    case 'output':
      return (
        <>
          {name}
          <Checkbox
            label={label('requireApproval')}
            checked={node.requireApproval}
            onToggle={() => updateNode(node.id, { requireApproval: !node.requireApproval })}
          />
          {note}
        </>
      );
  }
}

/** Where a step leads, with a keyboard way to connect each output and to remove a connection. */
function Connections({
  editor,
  node,
  onSelect,
}: {
  editor: EditorStore;
  node: CorralNode;
  onSelect: (selection: TeamSelection) => void;
}) {
  const t = useTranslations('TeamEditor');
  const portName = useTranslations('Canvas.ports');
  const size = useSize();
  const id = useId();
  const draft = useStore(editor, (s) => s.draft);
  const { definition } = draft;
  const apply = editor.getState().applyDraft;
  const name = (nodeId: string) => definition.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;
  const ports = outputPortsOf(node);
  if (!ports.length) return null;
  const outgoing = definition.controlEdges.filter((e) => e.source === node.id);
  const portLabel = (port: string) =>
    node.type === 'decision' && node.mode === 'router'
      ? (node.routes.find((r) => r.id === port)?.label ?? port)
      : portName(port);
  const targetsFor = (port: string) =>
    definition.nodes.flatMap((target) => {
      const ports: TargetPort[] =
        target.type === 'loop'
          ? ['enter', 'exit', 'repeat']
          : target.type === 'team'
            ? ['enter', 'exit']
            : [primaryIn(target)].filter((p): p is TargetPort => p !== null);
      return ports
        .filter(
          (targetPort) =>
            checkPorts(draft, { source: node.id, sourcePort: port, target: target.id, targetPort })
              .ok,
        )
        .map((targetPort) => ({
          value: `${target.id}\u0000${targetPort}`,
          label: targetPort === 'in' ? target.label : `${target.label} · ${portName(targetPort)}`,
        }));
    });
  const remove = (edge: ControlEdge) => apply(removeItems(draft, [edge.id]));
  return (
    <section className="grid gap-2" aria-label={t('connections')}>
      <h3
        className={cn(size.type.caption, 'text-foreground')}
        style={{ fontVariationSettings: fontWeights.semibold }}
      >
        {t('connections')}
      </h3>
      {ports.map((port) => {
        const edges = outgoing.filter((e) => e.sourcePort === port);
        const options = targetsFor(port);
        return (
          <div key={port} className="grid gap-1">
            {edges.map((edge) => (
              <span key={edge.id} className={cn(size.type.body, 'flex items-center gap-1.5')}>
                <span className="text-muted-foreground">{portLabel(port)}</span>
                <span aria-hidden className="text-muted-foreground">
                  →
                </span>
                <button
                  type="button"
                  className="truncate text-left text-foreground hover:underline"
                  onClick={() => onSelect({ nodes: [edge.target], edge: null })}
                >
                  {name(edge.target)}
                  {edge.targetPort !== 'in' ? (
                    <span className="text-muted-foreground"> · {portName(edge.targetPort)}</span>
                  ) : null}
                </button>
                <span className="grow" />
                <Button
                  variant="ghost"
                  size="icon-compact"
                  aria-label={t('removeConnection', {
                    source: node.label,
                    target: name(edge.target),
                  })}
                  onClick={() => remove(edge)}
                >
                  <X />
                </Button>
              </span>
            ))}
            {options.length ? (
              <Select
                id={`${id}-${port}`}
                label={t('connectTo', { port: portLabel(port) })}
                value={null}
                placeholder={t('connectTo', { port: portLabel(port) })}
                onValueChange={(value: string) => {
                  const [target, targetPort] = value.split('\u0000') as [string, TargetPort];
                  const result = connectPorts(editor.getState().draft, {
                    source: node.id,
                    sourcePort: port,
                    target,
                    targetPort,
                  });
                  if (result.ok) apply(result.draft);
                }}
                options={options}
              />
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
