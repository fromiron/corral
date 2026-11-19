import { linearCorral } from '@corral/testkit';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { assert, expect, it, vi } from 'vitest';
import { draftFromDefinition, type EditorDraft } from '../src/editor/model.ts';
import { createEditorStore } from '../src/editor/store.ts';
import messages from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };
import { patchNode, setRequiredOutputReview } from '../src/team-editor/commands.ts';
import { InspectorSheet, type InspectorSheetProps } from '../src/team-editor/InspectorSheet.tsx';

function team() {
  const definition = linearCorral(['writer']);
  definition.sharedOutrider = {
    modelProfile: 'proof',
    principles: 'Check claims.',
    targets: { kind: 'all' },
  };
  const writer = definition.nodes.find((n) => n.id === 'writer');
  const output = definition.nodes.find((n) => n.type === 'output');
  const binding = output?.inputBindings[0];
  assert(writer && binding);
  writer.label = 'City desk';
  binding.name = 'Evening edition';
  return draftFromDefinition(definition);
}

function reviewed() {
  const enabled = setRequiredOutputReview(
    team(),
    'output',
    'Evening edition',
    'writer',
    messages.Inspector.requiredReviewLabels,
  );
  assert(enabled.ok);
  const output = enabled.draft.definition.nodes.find((n) => n.type === 'output');
  const gate = output?.requiredReviews?.[0];
  assert(gate);
  const named = patchNode(enabled.draft, gate.reviewerNodeId, { label: 'Copy chief' });
  return { gate, draft: patchNode(named, gate.loopNodeId, { maxIterations: 7 }) };
}

function open(draft: EditorDraft, props: Partial<InspectorSheetProps> = {}, locale = 'en') {
  const editor = createEditorStore(draft);
  render(
    <IntlProvider locale={locale} messages={locale === 'ko' ? ko : messages}>
      <InspectorSheet
        editor={editor}
        profiles={null}
        imageProfiles={null}
        diagnostics={[]}
        teams={[]}
        outriderTargets={[]}
        selection={{ nodes: ['output'], edge: null }}
        view="selection"
        docked
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onTeamSettings={vi.fn()}
        {...props}
      />
    </IntlProvider>,
  );
  return editor;
}

const toggle = () => screen.getByRole('switch', { name: 'Submit after review passes' });
const graph = { name: 'Show in flow graph' };
const submission =
  'For final submission, “Evening edition” from City desk must pass review by Copy chief.';
const fixes = 'Fix requests go back to City desk, with up to 7 rounds of review.';
const ending = 'If the result has not passed by then, there is no final submission.';

it('creates the review with Korean step and role names from the output switch', async () => {
  const draft = team();
  const editor = open(draft, {}, 'ko');
  screen.getByRole('switch', { name: '검토 통과 후 제출' }).focus();
  await userEvent.keyboard(' ');
  const { definition } = editor.getState().draft;
  expect(definition.nodes.map((node) => node.label)).toEqual(
    expect.arrayContaining(['제출 전 검토', '제출 전 검토자', '제출 전 판정']),
  );
  expect(definition.roles.at(-1)?.name).toBe('제출 전 검토자');
  editor.getState().undo();
  expect(editor.getState().draft).toBe(draft);
});

it('describes the selected result in three facts and opens its own review Loop without an edit', async () => {
  const { draft, gate } = reviewed();
  const onShowInGraph = vi.fn();
  const editor = open(draft, { onShowInGraph });
  expect(toggle()).toBeChecked();
  expect(toggle()).toHaveAccessibleDescription([submission, fixes, ending].join(' '));
  for (const fact of [submission, fixes, ending]) expect(screen.getByText(fact)).toBeVisible();
  await userEvent.click(screen.getByRole('button', graph));
  expect(onShowInGraph).toHaveBeenCalledWith(gate.loopNodeId);
  expect(editor.getState().draft).toBe(draft);
});

it('uses graph selection when already in the flow graph', async () => {
  const { draft, gate } = reviewed();
  const onSelect = vi.fn();
  open(draft, { docked: false, onSelect });
  await userEvent.click(screen.getByRole('button', graph));
  expect(onSelect).toHaveBeenCalledWith({ nodes: [gate.loopNodeId], edge: null });
});

it('shows unlimited rounds without a made-up deadline or a dead link in a standalone list', () => {
  const { draft, gate } = reviewed();
  open(
    patchNode(draft, gate.loopNodeId, {
      maxIterations: undefined,
      limitPolicy: { kind: 'unlimited' },
    }),
  );
  expect(toggle()).toHaveAccessibleDescription(
    `${submission} Fix requests go back to City desk, with no round limit. Without a passing review, there is no final submission.`,
  );
  expect(screen.queryByRole('button', graph)).toBeNull();
});

it.each([false, true])(
  'names an unchecked binding without review facts (disabled: %s)',
  (disabled) => {
    const draft = team();
    if (disabled) delete draft.definition.sharedOutrider;
    open(draft, { onShowInGraph: vi.fn() });
    expect(toggle()).not.toBeChecked();
    expect(toggle()).toHaveAccessibleDescription(
      'Evening edition · City desk' +
        (disabled ? ' Add a shared Outrider to configure this review.' : ''),
    );
    expect(
      screen.queryByText(/fix requests|revises the candidate|no final submission/i),
    ).toBeNull();
    expect(screen.queryByRole('button', graph)).toBeNull();
  },
);

it.each(['binding', 'reviewer', 'decision', 'loop'] as const)(
  'exposes the incomplete review when its %s is missing',
  async (missing) => {
    const { draft, gate } = reviewed();
    const broken =
      missing === 'binding' ? patchNode(draft, 'output', { inputBindings: [] }) : draft;
    if (missing !== 'binding') {
      const id = {
        loop: gate.loopNodeId,
        reviewer: gate.reviewerNodeId,
        decision: gate.decisionNodeId,
      }[missing];
      broken.definition.nodes = broken.definition.nodes.filter((n) => n.id !== id);
    }
    const onShowInGraph = vi.fn();
    open(broken, { onShowInGraph });
    expect(toggle()).toBeChecked();
    expect(toggle()).toHaveAccessibleDescription(
      /Evening edition · City desk.*review setup is incomplete/i,
    );
    expect(screen.queryByText(submission)).toBeNull();
    if (missing === 'loop') expect(screen.queryByRole('button', graph)).toBeNull();
    else {
      await userEvent.click(screen.getByRole('button', graph));
      expect(onShowInGraph).toHaveBeenCalledWith(gate.loopNodeId);
    }
    toggle().focus();
    await userEvent.keyboard(' ');
    expect(
      screen.queryByRole('switch', { name: 'Submit after review passes', checked: true }),
    ).toBeNull();
  },
);
