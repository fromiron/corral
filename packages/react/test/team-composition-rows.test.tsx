import { CorralDefinition, isWorkAgent } from '@corral/contracts';
import { TEAM_TEMPLATE_ROLES, type TeamTemplateId, teamTemplate } from '@corral/core';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { IntlProvider } from 'use-intl';
import { assert, describe, expect, it, vi } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json';
import messages from '../src/messages/en.json' with { type: 'json' };
import { outlineOrder } from '../src/team-editor/layout.ts';
import { TeamComposition } from '../src/team-editor/TeamComposition.tsx';

function template(id: TeamTemplateId) {
  return teamTemplate(id, 'example', {
    name: 'Example',
    brief: 'Prepare a report.\nInternal request details.',
    criteria: ['Reviewed', 'Readable'],
    roles: Object.fromEntries(
      Object.keys(TEAM_TEMPLATE_ROLES[id]).map((key) => [
        key,
        { name: key, duty: `Work on ${key}.\nPrivate details.` },
      ]),
    ),
    labels: { loop: 'Review loop', decision: 'Verdict', join: 'Gather', output: 'Report' },
  });
}

type Props = ComponentProps<typeof TeamComposition>;
function setup(definition: CorralDefinition, overrides: Partial<Props> = {}) {
  const props = {
    definition,
    order: outlineOrder(definition),
    selection: { nodes: [], edge: null },
    collapsed: new Set<string>(),
    sheetView: null,
    diagnostics: [],
    onNode: vi.fn(),
    onRequest: vi.fn(),
    onToggle: vi.fn(),
    onAdd: vi.fn(),
    onSharedOutrider: vi.fn(),
    onProblems: vi.fn(),
    onShowInGraph: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  } satisfies Props;
  const view = (p: Props) => (
    <IntlProvider locale="en" messages={messages}>
      <TeamComposition {...p} />
      <button type="button">After list</button>
    </IntlProvider>
  );
  const rendered = render(view(props));
  return {
    props,
    update: (patch: Partial<Props>) => rendered.rerender(view({ ...props, ...patch })),
  };
}
const nodeButtons = (root: ParentNode = document) => [
  ...root.querySelectorAll<HTMLButtonElement>('[data-composition-node]'),
];
const ids = (root?: ParentNode) => nodeButtons(root).map((b) => b.dataset.compositionNode);
function node(id: string) {
  const button = nodeButtons().find((b) => b.dataset.compositionNode === id);
  if (!button) throw new Error(`Missing composition row: ${id}`);
  return button;
}
function row(button: HTMLElement) {
  const item = button.closest('li');
  assert(item);
  return within(item);
}
const button = (name: string | RegExp) => screen.getByRole('button', { name });

describe('Team composition rows', () => {
  it('reads the request, rounds, seat duty, decisions and bound submitter without numbering steps', async () => {
    const d = template('plan-implement-review');
    const worker = d.nodes.find((n) => n.id === 'implement');
    if (!worker || !isWorkAgent(worker)) throw new Error('Expected implementer');
    worker.stepInstruction = 'Write the report.\nKeep these details in settings.';
    const { props, update } = setup(d);
    expect(screen.getByRole('list', { name: 'Team composition' })).toBeVisible();
    expect(button(/^Request\b/)).toHaveAttribute('aria-pressed', 'true');
    expect(row(button(/^Request\b/)).getByText('Prepare a report.')).toBeVisible();
    expect(row(button(/^Request\b/)).getByText('2 completion criteria')).toBeVisible();
    expect(ids()).toEqual([
      'plan',
      'review_loop',
      'implement',
      'review',
      'review_decision',
      'output',
    ]);
    expect(node('plan')).toHaveTextContent('Work on plan.');
    expect(node('implement')).toHaveTextContent('Write the report.');
    expect(node('implement')).toHaveTextContent(/draft$/);
    expect(node('implement')).not.toHaveTextContent('Work on implement');
    expect(
      screen.queryByText(/Private details|Keep these details|Internal request details/),
    ).not.toBeInTheDocument();
    expect(node('review_loop')).toHaveTextContent('up to 2 rounds');
    expect(node('review_decision')).toHaveTextContent(/Review.*pass → Report.*revise → implement/i);
    expect(node('output')).toHaveAccessibleName('Final result');
    expect(node('output')).toHaveTextContent(/draft · implement/);
    const add = button('Add agent');
    expect(
      node('review_decision').compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      add.compareDocumentPosition(node('output')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      node('output').compareDocumentPosition(button(/Add shared Outrider/)) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText(/^\d+[.)]?$/)).not.toBeInTheDocument();
    await userEvent.click(button('Collapse Review loop'));
    expect(props.onToggle).toHaveBeenCalledWith('review_loop');
    update({ collapsed: new Set(['review_loop']) });
    expect(ids()).toEqual(['plan', 'review_loop', 'output']);
    expect(button('Expand Review loop')).toHaveAttribute('aria-expanded', 'false');
  });

  it('groups the parallel reviews but not the join; offers the new producer without relabelling the output', async () => {
    const d = template('parallel-review');
    const source = d.nodes.find((n) => n.id === 'security');
    assert(source);
    const offer = {
      source,
      apply: vi.fn(),
      dismiss: vi.fn(),
    };
    setup(d, { resultOffer: offer });
    const group = screen.getByRole('list', { name: 'In parallel' });
    expect(ids(group)).toEqual(['correctness', 'security']);
    expect(ids()).toEqual(['scope', 'correctness', 'security', 'gather', 'synthesis', 'output']);
    expect(node('output')).toHaveTextContent('draft · synthesis');
    expect(row(node('security')).getAllByRole('button')).toHaveLength(2);
    await userEvent.click(
      row(node('security')).getByRole('button', { name: 'Use this step’s result' }),
    );
    expect(offer.apply).toHaveBeenCalledOnce();
    expect(offer.dismiss).toHaveBeenCalledOnce();
  });

  it('keeps every called seat below its own caller and observers after shared advice', () => {
    const d = CorralDefinition.parse(researchTeam);
    d.nodes.push({
      id: 'advisor',
      type: 'agent',
      invocation: 'observer',
      label: 'Watcher',
      roleId: 'researcher',
      outputName: 'advice',
    });
    d.sharedOutrider = {
      modelProfile: 'model-a',
      principles: 'Review',
      targets: { kind: 'selected', nodeIds: ['write'] },
    };
    setup(d);
    expect(ids()).toEqual([
      'research',
      'helper',
      'review_loop',
      'write',
      'respond',
      'helper',
      'review',
      'review_decision',
      'approval',
      'output',
      'advisor',
    ]);
    expect(nodeButtons().filter((b) => b.dataset.compositionNode === 'helper')).toHaveLength(2);
    expect(screen.getAllByText('Called when needed')).toHaveLength(3);
    expect(node('output')).toHaveTextContent('draft · 작성');
    expect(button(/Shared Outrider · 1 worker/)).toBeVisible();
  });

  it('shows named outputs individually, including unconnected outputs, and links a disconnected seat to the graph', async () => {
    const d = template('parallel-review');
    const output = d.nodes.find((n) => n.type === 'output');
    assert(output);
    output.label = 'Output';
    output.inputBindings.push({
      kind: 'task_output',
      name: 'findings',
      sourceNodeId: 'correctness',
    });
    // Disconnected output with *stored* bindings: it cannot receive those results.
    d.nodes.push({ ...output, id: 'unused', label: 'Appendix' });
    d.nodes.push({
      type: 'team',
      id: 'library',
      label: 'Library team',
      source: { kind: 'reference', corralId: 'lib', definitionRevision: 7 },
    });
    const { props } = setup(d);
    const disconnected = screen.getByRole('list', { name: 'Not connected' });
    expect(ids(disconnected)).toEqual(['library']);
    expect(
      button('Add agent').compareDocumentPosition(disconnected) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(node('library')).toHaveTextContent('v7');
    expect(row(node('library')).queryByRole('button', { name: /Collapse|Expand/ })).toBeNull();
    await userEvent.click(within(disconnected).getByRole('button', { name: 'Show in flow graph' }));
    expect(props.onShowInGraph).toHaveBeenCalledWith('library');
    expect(node('output')).toHaveAccessibleName('Final result · Output');
    expect(node('unused')).toHaveAccessibleName('Final result · Appendix');
    expect(node('output')).toHaveTextContent('draft · synthesis');
    expect(node('output')).toHaveTextContent('findings · correctness');
    expect(node('unused')).toHaveTextContent('Choose a result');
    expect(node('unused')).not.toHaveTextContent('synthesis');
  });

  it('shows one localized issue per seat, errors before warnings, and opens the correction and problem list', async () => {
    const { props } = setup(template('parallel-review'), {
      diagnostics: [
        {
          code: 'REVIEW_WITHOUT_CRITERIA',
          severity: 'warning',
          nodeId: 'scope',
          message: 'fallback warning',
        },
        { code: 'DEAD_END', severity: 'error', nodeId: 'scope', message: 'fallback error' },
      ],
    });
    const step = row(node('scope'));
    expect(
      button('2 problems').compareDocumentPosition(button(/^Request\b/)) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(node('scope')).toHaveAccessibleDescription(/Error: This step has no next step/);
    expect(step.getByText('This step has no next step.')).toBeVisible();
    expect(step.queryByText(/scope does not get the criteria/)).not.toBeInTheDocument();
    await userEvent.click(step.getByRole('button', { name: 'Show in flow graph' }));
    expect(props.onShowInGraph).toHaveBeenCalledWith('scope');
    await userEvent.click(button('2 problems'));
    expect(props.onProblems).toHaveBeenCalledOnce();
  });

  it('moves one tabstop without selecting, reaches row actions, and ignores IME Enter and Delete', async () => {
    const user = userEvent.setup();
    const { props, update } = setup(template('plan-implement-review'));
    await user.tab();
    expect(button(/^Request\b/)).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(node('plan')).toHaveFocus();
    expect(props.onNode).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(node('plan'), { key: 'Enter', isComposing: true })).toBe(false);
    expect(props.onNode).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(props.onNode).toHaveBeenCalledWith('plan');
    update({ selection: { nodes: ['plan'], edge: null } });
    fireEvent.keyDown(node('plan'), { key: 'Delete', keyCode: 229 });
    expect(props.onDelete).not.toHaveBeenCalled();
    await user.keyboard('{Delete}');
    expect(props.onDelete).toHaveBeenCalledWith(['plan']);
    await user.keyboard('{ArrowDown}{ArrowRight}');
    expect(button('Collapse Review loop')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(props.onToggle).toHaveBeenCalledWith('review_loop');
    expect(
      screen
        .getAllByRole('button')
        .filter((b) => b.tabIndex === 0 && b.textContent !== 'After list'),
    ).toHaveLength(1);
    await user.tab();
    expect(button('After list')).toHaveFocus();
  });

  it.each([false, true])(
    'makes adding the first agent the empty state action, including an output-only draft (%s)',
    async (keepOutput) => {
      const base = template('parallel-review');
      const d = {
        ...base,
        nodes: keepOutput ? base.nodes.filter((n) => n.type === 'output') : [],
        entryNodeId: '',
        controlEdges: [],
      };
      const { props } = setup(d);
      expect(button(/^Request\b/)).toHaveAttribute('aria-pressed', 'true');
      const add = button('Add agent');
      expect(add.closest('[data-slot="empty-state"]')).not.toBeNull();
      await userEvent.click(add);
      expect(props.onAdd).toHaveBeenCalledOnce();
    },
  );
});
