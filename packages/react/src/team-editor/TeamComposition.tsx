import type { CorralDefinition, CorralNode } from '@corral/contracts';
import type { Diagnostic } from '@corral/core';
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import { useTranslations } from 'use-intl';
import { Button, EmptyState, useSize } from '../design-kit/index.ts';
import { focusRing } from '../design-kit/lib/focus.ts';
import { fontWeights } from '../design-kit/lib/font-weight.ts';
import { cn } from '../design-kit/lib/utils.ts';
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Eye,
  FileText,
  GitBranch,
  type LucideIcon,
  Plus,
  Split,
  TriangleAlert,
} from '../ui/icons.ts';
import { seatTaskSummary } from './commands.ts';
import type { SheetView } from './InspectorSheet.tsx';
import { KIND_ICON, kindOf } from './kinds.ts';
import { type RosterRow, type RosterStep, rosterOf } from './roster.ts';
import { ProblemCountBadge } from './StructureTree.tsx';
import type { ResultOffer, TeamSelection } from './TeamGraphCanvas.tsx';

interface TeamCompositionProps {
  definition: CorralDefinition;
  hasWorkAgent: boolean;
  order: ReadonlyMap<string, number>;
  selection: TeamSelection;
  collapsed: ReadonlySet<string>;
  sheetView: SheetView | null;
  diagnostics: readonly Diagnostic[];
  validationStatus?: string | undefined;
  resultOffer?: ResultOffer | undefined;
  onNode: (id: string) => void;
  onRequest: () => void;
  onToggle: (id: string) => void;
  onAdd: () => void;
  onSharedOutrider: () => void;
  onProblems: () => void;
  onShowInGraph?: ((id: string) => void) | undefined;
  onDelete: (ids: string[]) => void;
}

/** One focus owner for the whole outline, including secondary actions. Up/down travel across
 * rows; left/right stay within the row. The DOM order already accounts for every disclosure. */
function useListNavigation(
  selection: TeamSelection,
  view: SheetView | null,
  onDelete: TeamCompositionProps['onDelete'],
) {
  const root = useRef<HTMLDivElement>(null);
  const stop = useRef<HTMLButtonElement | null>(null);
  const lastSelection = useRef({ selection, view });
  const hadFocus = useRef(false);
  function setStop(next: HTMLButtonElement) {
    if (stop.current && stop.current !== next) stop.current.tabIndex = -1;
    next.tabIndex = 0;
    stop.current = next;
  }
  useLayoutEffect(() => {
    const list = root.current;
    if (!list) return;
    const previous = stop.current;
    const changed =
      lastSelection.current.selection !== selection || lastSelection.current.view !== view;
    lastSelection.current = { selection, view };
    if (
      previous &&
      list.contains(previous) &&
      !previous.disabled &&
      (!changed || list.contains(document.activeElement))
    )
      return;
    const target =
      list.querySelector<HTMLButtonElement>('button[aria-pressed="true"]:not(:disabled)') ??
      list.querySelector<HTMLButtonElement>('ul [data-composition-main]');
    if (!target) return;
    setStop(target);
    if (
      previous &&
      !previous.isConnected &&
      hadFocus.current &&
      document.activeElement === document.body
    )
      target.focus();
  });
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const here = event.target;
    if (!(here instanceof HTMLButtonElement)) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      // A native button would otherwise activate on the Enter that accepts an IME candidate.
      if (event.key === 'Enter') event.preventDefault();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'Delete') {
      event.preventDefault();
      if (!event.repeat && selection.nodes.length) onDelete(selection.nodes);
      return;
    }
    const vertical =
      event.key === 'ArrowDown' ||
      event.key === 'ArrowUp' ||
      event.key === 'Home' ||
      event.key === 'End';
    if (!vertical && event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const row = here.closest('[data-composition-row]');
    if (!row) return;
    const buttons = vertical
      ? [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
            '[data-composition-main]:not(:disabled)',
          ),
        ]
      : [...row.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const current = vertical
      ? row.querySelector<HTMLButtonElement>('[data-composition-main]')
      : here;
    if (!current) return;
    const i = buttons.indexOf(current);
    const next =
      event.key === 'Home'
        ? buttons[0]
        : event.key === 'End'
          ? buttons.at(-1)
          : buttons[i + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1)];
    event.preventDefault();
    next?.focus();
  }
  return {
    ref: root,
    onKeyDown,
    onFocus: (event: FocusEvent<HTMLDivElement>) => {
      hadFocus.current = true;
      if (event.target instanceof HTMLButtonElement) setStop(event.target);
    },
    onBlur: (event: FocusEvent<HTMLDivElement>) => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget))
        hadFocus.current = false;
    },
    onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
      const button = event.target instanceof Element && event.target.closest('button');
      if (button && !button.disabled) setStop(button);
    },
  };
}

type RowContent = {
  name: string;
  summary?: string | undefined;
  singleLine?: boolean;
  result?: string | undefined;
  tag?: string | undefined;
};
function Row({
  icon: Icon,
  name,
  summary,
  singleLine,
  result,
  tag,
  nodeId,
  selected,
  onSelect,
  toggle,
  problem,
  detail,
  children,
}: RowContent & {
  icon: LucideIcon;
  nodeId?: string;
  selected?: boolean;
  onSelect: () => void;
  /** The fold control of a group; it stands in the same leading slot as the outline's. */
  toggle?: ReactNode;
  problem?: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
}) {
  const size = useSize();
  const id = useId();
  const descriptions = [
    tag && `${id}-tag`,
    nodeId && summary && `${id}-summary`,
    result && `${id}-result`,
    problem && `${id}-problem`,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <li>
      <div data-composition-row>
        {/* The row's fill covers the leading slot too, so chosen rows share one left edge. */}
        <div className="relative">
          {toggle}
          <Button
            variant="ghost"
            tabIndex={-1}
            data-composition-main=""
            data-composition-node={nodeId}
            aria-labelledby={`${id}-name${!nodeId && summary ? ` ${id}-summary` : ''}`}
            aria-describedby={descriptions || undefined}
            aria-pressed={selected}
            onClick={onSelect}
            className={cn(
              'h-auto w-full min-w-0 justify-start gap-2 whitespace-normal py-1.5 ps-8 pe-2 text-left text-foreground',
              selected && 'bg-active',
            )}
          >
            <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              <span
                id={`${id}-name`}
                className="block"
                style={{ fontVariationSettings: fontWeights.semibold }}
              >
                {name}
              </span>
              {tag && (
                <span
                  id={`${id}-tag`}
                  className={cn(size.type.caption, 'block text-muted-foreground')}
                >
                  {tag}
                </span>
              )}
              {summary && (
                <span
                  id={`${id}-summary`}
                  title={summary}
                  className={cn(
                    size.type.caption,
                    'text-muted-foreground',
                    singleLine ? 'block truncate' : 'line-clamp-2',
                  )}
                >
                  {summary}
                </span>
              )}
            </span>
            {/* A short result keeps its line; only one past two fifths of the row wraps. */}
            {result && (
              <span
                id={`${id}-result`}
                className={cn(
                  size.type.caption,
                  'max-w-[40%] shrink-0 text-end text-muted-foreground [overflow-wrap:anywhere]',
                )}
              >
                {result}
              </span>
            )}
          </Button>
        </div>
        {(detail || problem) && (
          <div className="ms-13.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 pb-1">
            {problem && <span id={`${id}-problem`}>{problem}</span>}
            {detail}
          </div>
        )}
      </div>
      {children}
    </li>
  );
}

// Members indent by the outline's step, under the same leading slot.
const rail = 'ps-3.5';
// These corrections require editing wires, membership or graph boundaries, rather than fields.
const graphIssue: Partial<Record<Diagnostic['code'], true>> = {
  ADVISOR_OUTSIDE_FLOW: true,
  BOX_BOUNDARY: true,
  BOX_PARENT: true,
  CALLABLE_IN_CONTROL_FLOW: true,
  CONTAINMENT_CYCLE: true,
  CYCLE_OUTSIDE_LOOP: true,
  DEAD_END: true,
  DECISION_BRANCH_MISSING: true,
  ENTRY_INVALID: true,
  INVALID_PORT: true,
  JOIN_PARTIAL: true,
  JOIN_SINGLE_INPUT: true,
  JOIN_SPLIT: true,
  LOOP_DEAD_END: true,
  LOOP_NO_BODY: true,
  LOOP_NO_EXIT: true,
  LOOP_NO_REPEAT: true,
  NO_OUTPUT: true,
  PARALLEL_MERGE_NEEDS_JOIN: true,
  PARALLEL_MIXED_ENTRY: true,
  PARALLEL_UNJOINED: true,
  REPEAT_NEEDS_DECISION: true,
  TEAM_NO_BODY: true,
  TEAM_NO_EXIT: true,
  TEAM_NO_MEMBERS: true,
  TEAM_REFERENCE_MEMBERS: true,
  UNREACHABLE: true,
};
const firstLine = (text?: string) => text?.trim().split(/\r?\n/, 1)[0];

export function TeamComposition({
  definition,
  hasWorkAgent,
  order,
  selection,
  collapsed,
  sheetView,
  diagnostics,
  validationStatus,
  resultOffer,
  onNode,
  onRequest,
  onToggle,
  onAdd,
  onSharedOutrider,
  onProblems,
  onShowInGraph,
  onDelete,
}: TeamCompositionProps) {
  const t = useTranslations('TeamEditor');
  const c = useTranslations('TeamEditor.composition');
  const editor = useTranslations('Editor');
  const inspector = useTranslations('Inspector');
  const ports = useTranslations('Canvas.ports');
  const codes = useTranslations('Validation.codes');
  const schema = useTranslations('Validation.schema');
  const size = useSize();
  const hint = useId();
  const navigation = useListNavigation(selection, sheetView, onDelete);
  const roster = useMemo(() => rosterOf(definition, order), [definition, order]);
  const nodes = useMemo(() => new Map(definition.nodes.map((n) => [n.id, n])), [definition.nodes]);
  const issues = useMemo(() => {
    const worst = new Map<string, Diagnostic>();
    for (const d of diagnostics) {
      if (!d.nodeId) continue;
      const prior = worst.get(d.nodeId);
      if (!prior || (prior.severity === 'warning' && d.severity === 'error'))
        worst.set(d.nodeId, d);
    }
    return worst;
  }, [diagnostics]);
  const chosen = new Set(selection.nodes);
  const actionClass = cn(size.type.caption, 'h-auto min-h-7 whitespace-normal px-2 py-1');
  function graphAction(id: string, main = false) {
    return (
      onShowInGraph && (
        <Button
          variant="ghost"
          tabIndex={-1}
          data-composition-main={main ? '' : undefined}
          className={actionClass}
          onClick={() => onShowInGraph(id)}
        >
          <GitBranch aria-hidden /> {c('showInGraph')}
        </Button>
      )
    );
  }

  function nodeRow(
    node: CorralNode,
    content: RowContent,
    {
      children,
      disclosure,
      graph = false,
    }: { children?: ReactNode; disclosure?: boolean; graph?: boolean } = {},
  ) {
    const issue = issues.get(node.id);
    const showGraph = graph || (issue && graphIssue[issue.code]);
    const offer = resultOffer?.source.id === node.id ? resultOffer : undefined;
    let problem: ReactNode;
    if (issue) {
      const path = issue.schemaPath?.replace(/^nodes\.\d+\.inputBindings$/, 'inputBindings');
      const text =
        path && schema.has(path)
          ? schema(path)
          : codes.has(issue.code)
            ? codes(issue.code, { node: node.label, message: issue.message })
            : issue.message;
      const Mark = issue.severity === 'error' ? CircleAlert : TriangleAlert;
      problem = (
        <span
          className={cn(
            size.type.caption,
            'flex min-w-0 items-start gap-1.5 [overflow-wrap:anywhere]',
            issue.severity === 'error' ? 'text-destructive' : 'text-warning',
          )}
        >
          <Mark size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            <span className="sr-only">{c(issue.severity)}:</span> <span>{text}</span>
          </span>
        </span>
      );
    }
    return (
      <Row
        key={node.id}
        icon={KIND_ICON[kindOf(node)]}
        nodeId={node.id}
        {...content}
        selected={chosen.has(node.id) && (!sheetView || sheetView === 'selection')}
        onSelect={() => onNode(node.id)}
        toggle={
          disclosure !== undefined && (
            <button
              type="button"
              tabIndex={-1}
              aria-expanded={disclosure}
              aria-label={t(disclosure ? 'collapse' : 'expand', { name: node.label })}
              className={cn(
                focusRing,
                'absolute start-1 top-1/2 z-10 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground',
              )}
              onClick={() => onToggle(node.id)}
            >
              {disclosure ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          )
        }
        problem={problem}
        detail={
          (issue || offer || (showGraph && onShowInGraph)) && (
            <>
              {showGraph && onShowInGraph
                ? graphAction(node.id)
                : issue && (
                    <Button
                      variant="ghost"
                      tabIndex={-1}
                      className={actionClass}
                      onClick={() => onNode(node.id)}
                    >
                      {c('editStep')}
                    </Button>
                  )}
              {offer && (
                <Button
                  variant="tertiary"
                  tabIndex={-1}
                  className={actionClass}
                  onClick={() => {
                    offer.apply();
                    offer.dismiss();
                  }}
                >
                  {c('useResult')}
                </Button>
              )}
            </>
          )
        }
      >
        {children}
      </Row>
    );
  }

  function agentContent(node: Extract<CorralNode, { type: 'agent' }>): RowContent {
    return {
      name: node.label,
      summary: seatTaskSummary(definition, node),
      singleLine: true,
      result: node.outputName,
      tag: node.invocation === 'callable' ? c('called') : undefined,
    };
  }
  function calledRows(
    caller: Pick<Extract<RosterStep, { calls: unknown }>, 'nodeId' | 'calls'>,
  ): ReactNode {
    if (!caller.calls.length) return null;
    return (
      <ul
        className={rail}
        aria-label={c('calledBy', { name: nodes.get(caller.nodeId)?.label ?? caller.nodeId })}
      >
        {caller.calls.map((call) => {
          const node = nodes.get(call.nodeId);
          return (
            node?.type === 'agent' &&
            nodeRow(node, agentContent(node), { children: calledRows(call) })
          );
        })}
      </ul>
    );
  }
  function step(row: RosterRow, unconnected = false): ReactNode {
    if (row.kind === 'parallel') {
      const source = nodes.get(row.sourceId);
      const route =
        source?.type === 'decision' && source.mode === 'router'
          ? source.routes.find((r) => r.id === row.port)?.label
          : undefined;
      const name = route ? c('parallelRoute', { route }) : c('parallel');
      return (
        <li key={`parallel:${row.sourceId}:${row.port}`}>
          <div
            data-composition-row
            className={cn(
              size.type.caption,
              'flex items-center gap-2 py-1 ps-8 pe-2 text-muted-foreground',
            )}
          >
            <Split aria-hidden size={14} /> {name}
            {graphAction(row.sourceId, true)}
          </div>
          <ul aria-label={name} className={rail}>
            {row.branches.map((branch) => (
              <li key={branch.edgeId}>
                <ul aria-label={nodes.get(branch.targetId)?.label ?? branch.targetId}>
                  {branch.rows.map((child) => step(child))}
                </ul>
              </li>
            ))}
          </ul>
        </li>
      );
    }
    const node = nodes.get(row.nodeId);
    if (!node) return null;
    let summary: string | undefined;
    switch (row.kind) {
      case 'agent':
      case 'callable':
        return (
          node.type === 'agent' &&
          nodeRow(node, agentContent(node), { graph: unconnected, children: calledRows(row) })
        );
      case 'team':
      case 'loop': {
        const open = !collapsed.has(node.id);
        const limit =
          row.kind === 'loop' &&
          (row.limitPolicy?.kind === 'unlimited'
            ? t('roundsUnlimited')
            : row.maxIterations && t('rounds', { count: row.maxIterations }));
        return nodeRow(
          node,
          {
            name: node.label,
            summary:
              row.kind === 'loop'
                ? [limit, row.requiredReview && c('noSubmissionIfNotPassed')]
                    .filter(Boolean)
                    .join(' · ')
                : t('inline'),
          },
          {
            disclosure: open,
            graph: unconnected,
            children: open && (
              <ul aria-label={node.label} className={rail}>
                {row.children.map((child) => step(child))}
              </ul>
            ),
          },
        );
      }
      case 'decision': {
        const kind = t(`kinds.${kindOf(node)}`);
        const branches = row.branches.map((b) => {
          const branch = b.routeLabel ?? (ports.has(b.port) ? ports(b.port) : b.port);
          return c('branch', {
            branch,
            destination: nodes.get(b.destinationId)?.label ?? b.destinationId,
          });
        });
        summary = [kind === node.label ? '' : kind, ...branches].filter(Boolean).join(' · ');
        break;
      }
      case 'reference':
        summary = t('reference', { revision: row.source.definitionRevision });
        break;
      case 'join':
        if (node.type === 'join') summary = t(node.policy === 'all' ? 'joinAll' : 'joinAny');
        break;
    }
    return nodeRow(
      node,
      { name: node.label, summary },
      { graph: unconnected || row.kind === 'reference' },
    );
  }
  // With agents, adding is a quiet row in the list's own rhythm; without, the list's one action.
  const add = (
    <Button
      variant={hasWorkAgent ? 'ghost' : 'primary'}
      tabIndex={-1}
      data-composition-main=""
      onClick={onAdd}
      className={hasWorkAgent ? 'w-full justify-start gap-2 ps-8 text-muted-foreground' : undefined}
    >
      <Plus aria-hidden className={hasWorkAgent ? 'size-3.5' : undefined} />
      {c('add')}
    </Button>
  );
  const shared = roster.advice.shared;
  return (
    <div {...navigation}>
      {/* The same head as the flow graph's outline: the team, then its problems. */}
      <div data-composition-row className="sticky top-0 z-20 bg-surface-2 pt-2 pb-1">
        <div className="flex min-h-10 items-center gap-2 py-1.5 pr-1 pl-2">
          <span
            className={cn(size.type.body, 'grow truncate text-foreground')}
            style={{ fontVariationSettings: fontWeights.semibold }}
          >
            {definition.name}
          </span>
          {hasWorkAgent && (
            <button
              type="button"
              className={cn(focusRing, 'rounded-full')}
              tabIndex={-1}
              data-composition-main=""
              disabled={Boolean(validationStatus)}
              aria-pressed={sheetView === 'problems'}
              onClick={onProblems}
            >
              <ProblemCountBadge diagnostics={diagnostics} validationStatus={validationStatus} />
            </button>
          )}
        </div>
      </div>
      <p id={hint} className="sr-only">
        {c('keyboard')}
      </p>
      <ul
        aria-label={editor('composition')}
        aria-describedby={hint}
        className="grid grid-cols-1 content-start gap-0.5"
      >
        <Row
          icon={FileText}
          name={c('request')}
          summary={firstLine(definition.input.brief)}
          result={c('criteria', { count: definition.input.criteria.length })}
          onSelect={onRequest}
          selected={
            sheetView === 'team' ||
            (!selection.nodes.length &&
              !selection.edge &&
              sheetView !== 'sharedOutrider' &&
              sheetView !== 'problems')
          }
        />
        {roster.steps.map((row) => step(row))}
        <li data-composition-row>
          {hasWorkAgent ? add : <EmptyState title={c('empty')} action={add} />}
        </li>
        {roster.unconnected.length > 0 && (
          <li>
            <span className={cn(size.type.caption, 'block py-1 ps-8 pe-2 text-muted-foreground')}>
              {c('unconnected')}
            </span>
            <ul aria-label={c('unconnected')} className={rail}>
              {roster.unconnected.map((row) => step(row, true))}
            </ul>
          </li>
        )}
        {roster.outputs.map((output) => {
          const node = nodes.get(output.nodeId);
          if (node?.type !== 'output') return null;
          const name =
            roster.outputs.length === 1 ? c('finalResult') : c('namedResult', { name: node.label });
          const summary =
            output.connected &&
            output.bindings
              .map((b, i) => {
                const binding = node.inputBindings[i];
                const source = b.producerId
                  ? nodes.get(b.producerId)?.label
                  : binding?.kind === 'run_input'
                    ? binding.name === 'criteria'
                      ? inspector('teamCriteria')
                      : c('request')
                    : binding?.artifactVersionId;
                const received = c('received', {
                  name: b.name,
                  source: source ?? c('unknownSource'),
                });
                return b.review ? `${received} · ${inspector('requireReview')}` : received;
              })
              .join(' · ');
          return nodeRow(
            node,
            { name, summary: summary || c('chooseResult') },
            { graph: !output.connected },
          );
        })}
        <Row
          icon={Eye}
          name={c('advice')}
          summary={
            shared
              ? [
                  shared.kind === 'all'
                    ? c('wholeTeam')
                    : c('selectedWorkers', { count: shared.nodeIds.length }),
                  roster.advice.artifactReview && c('outputReview'),
                  roster.advice.observationInterval !== null &&
                    c('observesEvery', { count: roster.advice.observationInterval }),
                ]
                  .filter(Boolean)
                  .join(' · ')
              : t('sharedOutrider.add')
          }
          selected={sheetView === 'sharedOutrider'}
          onSelect={onSharedOutrider}
        >
          {roster.advice.observerIds.length > 0 && (
            <ul aria-label={t('kinds.observer')} className={rail}>
              {roster.advice.observerIds.map((id) => {
                const node = nodes.get(id);
                return node?.type === 'agent' && nodeRow(node, agentContent(node));
              })}
            </ul>
          )}
        </Row>
      </ul>
    </div>
  );
}
