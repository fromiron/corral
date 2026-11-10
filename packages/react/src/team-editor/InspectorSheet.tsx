import type { ControlEdge, CorralNode, TargetPort } from '@corral/contracts';
import { type Diagnostic, outputPortsOf } from '@corral/core';
import { type ReactNode, useId } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { Button, Checkbox, Input, Select, Textarea, useSize } from '../design-kit/index.ts';
import { fontWeights } from '../design-kit/lib/font-weight.ts';
import { cn } from '../design-kit/lib/utils.ts';
import type { EditorDraft } from '../editor/model.ts';
import type { EditorStore } from '../editor/store.ts';
import { CircleAlert, ExternalLink, Plus, Trash2, TriangleAlert, X } from '../ui/icons.ts';
import {
  applyPattern,
  checkPorts,
  connectPorts,
  type EditResult,
  type Pattern,
  patchNode,
  patchTeam,
  primaryIn,
  removeItems,
  type TeamReference,
  wrapIn,
} from './commands.ts';
import { KIND_ICON, kindOf } from './kinds.ts';
import {
  type LoopSettings,
  NodeSettings,
  type ProfileOption,
  type RoleSettings,
} from './NodeSettings.tsx';
import type { TeamSelection } from './TeamGraphCanvas.tsx';

// The floating settings sheet: what the selection is, its settings, where it leads and what is
// wrong with it; or the team's own settings; or every problem in the team. Every field writes
// through the editor store, so undo covers it.

export type SheetView = 'selection' | 'team' | 'problems';

export interface InspectorSheetProps {
  editor: EditorStore;
  diagnostics: readonly Diagnostic[];
  selection: TeamSelection;
  view: SheetView;
  profiles: ProfileOption[] | null;
  roleSettings?: RoleSettings | undefined;
  loopSettings?: LoopSettings | undefined;
  /** Other saved teams at their latest revision, for reference teams. */
  teams: readonly TeamReference[];
  onOpenTeam?: ((corralId: string) => void) | undefined;
  onSelect: (selection: TeamSelection) => void;
  onClose: () => void;
}

export const PATTERNS: readonly Pattern[] = ['reviewLoop', 'checkLoop', 'parallel'];

type FocusBatch = { onFocus: () => void; onBlur: () => void };

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

const number = (value: string) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
};

function IssueRow({ diagnostic, text }: { diagnostic: Diagnostic; text: string }) {
  const Icon = diagnostic.severity === 'error' ? CircleAlert : TriangleAlert;
  return (
    <>
      <Icon
        size={14}
        aria-hidden
        className={cn(
          'mt-0.5 shrink-0',
          diagnostic.severity === 'error' ? 'text-destructive' : 'text-warning',
        )}
      />
      <span className="text-foreground">{text}</span>
    </>
  );
}

export function InspectorSheet({
  editor,
  diagnostics,
  selection,
  view,
  profiles,
  roleSettings,
  loopSettings,
  teams,
  onOpenTeam,
  onSelect,
  onClose,
}: InspectorSheetProps) {
  const t = useTranslations('TeamEditor');
  const f = useTranslations('TeamEditor.fields');
  const portName = useTranslations('Canvas.ports');
  const codeText = useTranslations('Validation.codes');
  const size = useSize();
  const draft = useStore(editor, (s) => s.draft);
  const { definition } = draft;
  const apply = editor.getState().applyDraft;
  const batch: FocusBatch = {
    onFocus: () => editor.getState().beginBatch(),
    onBlur: () => editor.getState().endBatch(),
  };
  const nodes = new Map(definition.nodes.map((n) => [n.id, n]));
  const name = (nodeId: string) => nodes.get(nodeId)?.label ?? nodeId;
  const issueText = (d: Diagnostic) =>
    codeText.has(d.code)
      ? codeText(d.code, { message: d.message, node: d.nodeId ? name(d.nodeId) : '' })
      : d.message;
  const fixText = useTranslations('Validation');
  // A reviewer without the criteria: give it the run input that carries them.
  const giveCriteria = (nodeId: string) => {
    const node = nodes.get(nodeId);
    if (!node || !('inputBindings' in node)) return;
    editor.getState().updateNode(nodeId, {
      inputBindings: [...(node.inputBindings ?? []), { kind: 'run_input', name: 'criteria' }],
    });
  };
  const heading = (text: string) => (
    <h3
      className={cn(size.type.caption, 'text-foreground')}
      style={{ fontVariationSettings: fontWeights.semibold }}
    >
      {text}
    </h3>
  );
  const issues = (ids: string[]) => {
    const list = diagnostics.filter((d) => ids.includes(d.nodeId ?? d.edgeId ?? d.linkId ?? ''));
    if (!list.length) return null;
    return (
      <section className="grid gap-1.5" aria-label={t('issues')}>
        {list.map((d, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: diagnostics have no id of their own.
          <div key={i} className="grid gap-1">
            <p className={cn(size.type.caption, 'flex gap-1.5')}>
              <IssueRow diagnostic={d} text={issueText(d)} />
            </p>
            {d.code === 'REVIEW_WITHOUT_CRITERIA' && d.nodeId ? (
              <Button
                variant="secondary"
                size="compact"
                className="justify-self-start"
                onClick={() => giveCriteria(d.nodeId as string)}
              >
                {fixText('giveCriteria')}
              </Button>
            ) : null}
          </div>
        ))}
      </section>
    );
  };
  /** Applies an edit and selects what it made. */
  const run = (result: EditResult) => {
    if (!result.ok) return;
    apply(result.draft);
    onSelect(result.nodeId ? { nodes: [result.nodeId], edge: null } : { nodes: [], edge: null });
  };
  const structureActions = (ids: string[]) => {
    const boxes =
      ids.length === 1 && ['loop', 'team'].includes(nodes.get(ids[0] as string)?.type ?? '');
    const actions = boxes
      ? []
      : [
          ...(['loop', 'team'] as const).map((kind) => ({
            key: kind,
            label: t(kind === 'loop' ? 'wrapLoop' : 'wrapTeam'),
            result: wrapIn(draft, ids, kind),
          })),
          ...PATTERNS.map((pattern) => ({
            key: pattern,
            label: t(`patterns.${pattern}`),
            result: applyPattern(draft, pattern, ids),
          })),
        ];
    return (
      <div className="flex flex-wrap gap-2">
        {actions
          .filter((action) => action.result.ok)
          .map((action) => (
            <Button
              key={action.key}
              variant="secondary"
              size="compact"
              onClick={() => run(action.result)}
            >
              {action.label}
            </Button>
          ))}
        <Button
          variant="secondary"
          size="compact"
          onClick={() => {
            apply(removeItems(draft, ids));
            onSelect({ nodes: [], edge: null });
          }}
        >
          <Trash2 /> {ids.length > 1 ? t('deleteCount', { count: ids.length }) : t('delete')}
        </Button>
      </div>
    );
  };

  let title = '';
  let body: ReactNode = null;
  const single =
    view === 'selection' && selection.nodes.length === 1
      ? nodes.get(selection.nodes[0] as string)
      : undefined;

  if (view === 'problems') {
    title = t('problemsList');
    body = diagnostics.length ? (
      <ul className="grid gap-1">
        {diagnostics.map((d, i) => {
          const edge = d.edgeId ?? d.linkId;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: diagnostics have no id of their own.
            <li key={i}>
              <button
                type="button"
                disabled={!d.nodeId && !edge}
                className={cn(
                  size.type.caption,
                  'flex w-full gap-1.5 rounded-md px-1.5 py-1 text-left enabled:hover:bg-hover',
                )}
                onClick={() => {
                  if (d.nodeId) onSelect({ nodes: [d.nodeId], edge: null });
                  else if (edge) onSelect({ nodes: [], edge });
                }}
              >
                <IssueRow diagnostic={d} text={issueText(d)} />
                {d.nodeId ? (
                  <span className="ml-auto shrink-0 text-muted-foreground">{name(d.nodeId)}</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    ) : (
      <p className={cn(size.type.body, 'text-muted-foreground')}>{t('noProblems')}</p>
    );
  } else if (view === 'team') {
    title = t('teamSettings');
    const limits = definition.limits;
    const limitField = (key: keyof typeof limits, label: string) => (
      <Field label={label}>
        <Input
          type="number"
          min={1}
          value={String(limits[key])}
          onChange={(e) => {
            const value = number(e.target.value);
            if (value && value > 0) apply(patchTeam(draft, { limits: { [key]: value } }));
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
          {heading(f('limits'))}
          <div className="grid grid-cols-2 gap-3">
            {limitField('maxDelegationDepth', f('maxDelegationDepth'))}
            {limitField('maxSpawns', f('maxSpawns'))}
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
    body = (
      <>
        <ul className={cn(size.type.body, 'grid gap-1')}>
          {selection.nodes.map((nodeId) => (
            <li key={nodeId}>{name(nodeId)}</li>
          ))}
        </ul>
        {structureActions(selection.nodes)}
      </>
    );
  } else if (single) {
    title = t(`kinds.${kindOf(single)}`);
    body = (
      <>
        <NodeSettings
          editor={editor}
          node={single}
          profiles={profiles}
          roleSettings={roleSettings}
          loopSettings={loopSettings}
        />
        <MoreFields
          editor={editor}
          node={single}
          teams={teams}
          onOpenTeam={onOpenTeam}
          batch={batch}
        />
        {issues([single.id])}
        <Connections editor={editor} node={single} onSelect={onSelect} />
        {structureActions([single.id])}
      </>
    );
  }

  const Icon = single ? KIND_ICON[kindOf(single)] : null;
  return (
    <aside
      aria-label={t('inspector')}
      className="pointer-events-auto flex h-full w-[344px] flex-col overflow-hidden rounded-[14px] border border-border bg-card shadow-lg"
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

/** The settings the team graph model adds: retries, notes, checks, routes and teams. */
function MoreFields({
  editor,
  node,
  teams,
  onOpenTeam,
  batch,
}: {
  editor: EditorStore;
  node: CorralNode;
  teams: readonly TeamReference[];
  onOpenTeam?: ((corralId: string) => void) | undefined;
  batch: FocusBatch;
}) {
  const t = useTranslations('TeamEditor');
  const f = useTranslations('TeamEditor.fields');
  const id = useId();
  const draft = useStore(editor, (s) => s.draft);
  const apply = editor.getState().applyDraft;
  const patch = (change: Record<string, unknown>) => apply(patchNode(draft, node.id, change));
  const note = (
    <Field label={f('note')}>
      <Textarea
        size="sm"
        value={node.note ?? ''}
        onChange={(e) => patch({ note: e.target.value || undefined })}
        {...batch}
      />
    </Field>
  );
  switch (node.type) {
    case 'agent':
      return (
        <>
          {node.invocation === 'scheduled' ? (
            <Field label={f('retry')}>
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
    case 'decision':
      return (
        <>
          {node.mode === 'check' ? (
            <Field label={f('checks')} hint={f('checksHint')}>
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
              <legend className="mb-1 text-caption text-muted-foreground">{f('routes')}</legend>
              {node.routes.map((route, index) => (
                <span key={route.id} className="flex items-center gap-1.5">
                  <Input
                    aria-label={f('routeLabel')}
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
                    aria-label={f('removeRoute', { route: route.label })}
                    disabled={node.routes.length <= 1}
                    onClick={() => {
                      const next = patchNode(draft, node.id, {
                        routes: node.routes.filter((r) => r.id !== route.id),
                      });
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
                <Plus /> {f('addRoute')}
              </Button>
            </fieldset>
          ) : null}
          {note}
        </>
      );
    case 'loop':
      return (
        <>
          <Checkbox
            label={f('stallDetection')}
            checked={node.stallDetection ?? false}
            onToggle={() => patch({ stallDetection: node.stallDetection ? undefined : true })}
          />
          {note}
        </>
      );
    case 'team': {
      const source = node.source;
      const latest =
        source.kind === 'reference'
          ? teams.find((team) => team.corralId === source.corralId)
          : undefined;
      return (
        <>
          <Field label={f('source')}>
            <span className="text-body text-foreground">
              {source.kind === 'inline'
                ? t('inline')
                : t('reference', { revision: source.definitionRevision })}
            </span>
          </Field>
          {source.kind === 'reference' ? (
            <div className="flex flex-wrap gap-2">
              {onOpenTeam ? (
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={() => onOpenTeam(source.corralId)}
                >
                  <ExternalLink /> {t('openTeam')}
                </Button>
              ) : null}
              {latest && latest.definitionRevision > source.definitionRevision ? (
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={() =>
                    patch({ source: { ...source, definitionRevision: latest.definitionRevision } })
                  }
                >
                  {t('useRevision', { revision: latest.definitionRevision })}
                </Button>
              ) : null}
            </div>
          ) : null}
          {note}
        </>
      );
    }
    case 'join':
      return (
        <>
          <Field select label={f('policy')}>
            <Select
              label={f('policy')}
              id={`${id}-policy`}
              value={node.policy}
              onValueChange={(policy) => patch({ policy })}
              options={[
                { value: 'all', label: f('policyAll') },
                { value: 'any', label: f('policyAny') },
              ]}
            />
          </Field>
          {note}
        </>
      );
    case 'output':
      return note;
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
  const targetsFor = (current: EditorDraft, port: string) =>
    current.definition.nodes.flatMap((target) => {
      const candidates: TargetPort[] =
        target.type === 'loop'
          ? ['enter', 'exit', 'repeat']
          : target.type === 'team'
            ? ['enter', 'exit']
            : [primaryIn(target)].filter((p): p is TargetPort => p !== null);
      return candidates
        .filter(
          (targetPort) =>
            checkPorts(current, {
              source: node.id,
              sourcePort: port,
              target: target.id,
              targetPort,
            }).ok,
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
        const options = targetsFor(draft, port);
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
