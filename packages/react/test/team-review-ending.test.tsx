import { linearCorral } from '@corral/testkit';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { afterAll, assert, beforeAll, expect, it, vi } from 'vitest';
import { StudioStoresProvider } from '../src/context.tsx';
import { draftFromDefinition, type EditorDraft } from '../src/editor/model.ts';
import { createEditorStore } from '../src/editor/store.ts';
import en from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };
import { sessionStore } from '../src/stories/fixtures.tsx';
import {
  checkPorts,
  connectPorts,
  type EditResult,
  patchNode,
  setRequiredOutputReview,
} from '../src/team-editor/commands.ts';
import { TeamEditor } from '../src/team-editor/TeamEditor.tsx';

beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
});
afterAll(() => vi.restoreAllMocks());

function accepted(result: EditResult) {
  if (!result.ok) throw Error(result.reason);
  return result.draft;
}

function reviewed() {
  const definition = linearCorral(['writer']);
  definition.sharedOutrider = { modelProfile: 'critic', principles: '', targets: { kind: 'all' } };
  const output = definition.nodes.find((node) => node.type === 'output');
  assert(output);
  // Only the second output requires review. The other output would be a valid wire destination.
  definition.nodes.unshift({ ...output, id: 'other-output', label: 'Other output' });
  const draft = accepted(
    setRequiredOutputReview(
      draftFromDefinition(definition),
      output.id,
      'final',
      'writer',
      en.Inspector.requiredReviewLabels,
    ),
  );
  const gated = draft.definition.nodes.find((node) => node.id === output.id);
  const review = gated?.type === 'output' && gated.requiredReviews?.[0];
  if (!review) throw Error('Missing review');
  const loop = draft.definition.nodes.find((node) => node.id === review.loopNodeId);
  assert(loop);
  const wire = {
    source: loop.id,
    sourcePort: 'exhausted',
    target: 'other-output',
    targetPort: 'in',
  } as const;
  return { draft, outputId: output.id, review, loop, wire };
}

function show(draft: EditorDraft, locale: 'en' | 'ko' = 'en') {
  const editor = createEditorStore(draft);
  render(
    <IntlProvider locale={locale} messages={locale === 'en' ? en : ko}>
      <StudioStoresProvider editor={editor} session={sessionStore()}>
        <TeamEditor editor={editor} view="graph" />
      </StudioStoresProvider>
    </IntlProvider>,
  );
  return editor;
}

it.each([
  ['en', en, 'No final submission'],
  ['ko', ko, '최종 제출 없음'],
] as const)(
  'shows an inert ending on the expanded and collapsed review Loop in %s',
  async (locale, catalog, text) => {
    const { draft, loop } = reviewed();
    const editor = show(draft, locale);
    const user = userEvent.setup();
    const canvas = screen.getByRole('application', { name: catalog.TeamEditor.canvas });
    const tree = within(screen.getByRole('complementary', { name: catalog.TeamEditor.outline }));
    const toggle = tree.getByRole('button', {
      name: catalog.TeamEditor.collapse.replace('{name}', loop.label),
    });
    const row = toggle.closest('li');
    assert(row);
    const start = catalog.TeamEditor.startPort.replace(
      '{port}',
      `${loop.label} · ${catalog.Canvas.ports.exhausted}`,
    );
    for (const expanded of [true, false]) {
      if (!expanded) await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', String(expanded));
      expect(within(row).getByText(text)).toBeVisible();
      const ending = within(canvas).getByText(text);
      expect(ending).toBeVisible();
      expect(ending.closest('button, [tabindex]')).toBe(canvas);
      expect(within(canvas).queryByRole('button', { name: start })).toBeNull();
      fireEvent.pointerDown(ending, { button: 0, pointerId: 1 });
      expect(canvas).not.toHaveAttribute('data-connecting');
      fireEvent.pointerCancel(ending, { pointerId: 1 });
    }
    expect(editor.getState().draft).toBe(draft);
    expect(editor.getState().past).toEqual([]);
  },
);

it('offers the other wire starts, but not exhaustion, in the keyboard chooser and connection editor', async () => {
  const { draft, loop } = reviewed();
  const editor = show(draft);
  const user = userEvent.setup();
  const tree = within(screen.getByRole('complementary', { name: en.TeamEditor.outline }));
  await user.click(tree.getByText(loop.label));
  const connections = within(screen.getByRole('region', { name: en.TeamEditor.connections }));
  expect(connections.queryByRole('combobox', { name: /exhausted/ })).toBeNull();
  const canvas = within(screen.getByRole('application', { name: en.TeamEditor.canvas }));
  const connect = canvas.getByRole('button', { name: en.TeamEditor.connectNext });
  connect.focus();
  await user.keyboard('{Enter}');
  expect(canvas.getByRole('status')).toHaveTextContent(`${loop.label} · next`);
  expect(canvas.getByRole('button', { name: 'Start from body' })).toBeVisible();
  expect(canvas.queryByRole('button', { name: 'Start from exhausted' })).toBeNull();
  await user.keyboard('{Escape}');
  expect(editor.getState().draft).toBe(draft);
  expect(editor.getState().past).toEqual([]);
});

it('refuses a new wire and a retargeted bypass from the required ending before changing the draft', () => {
  const { draft, wire, outputId } = reviewed();
  const before = structuredClone(draft);
  const rejection = { ok: false, reason: 'reviewExhausted' };
  expect(checkPorts(draft, wire)).toEqual(rejection);
  expect(connectPorts(draft, wire)).toEqual(rejection);
  expect(draft).toEqual(before);
  const imported = {
    ...draft,
    definition: {
      ...draft.definition,
      controlEdges: [...draft.definition.controlEdges, { ...wire, id: 'bypass', target: outputId }],
    },
  };
  expect(connectPorts(imported, wire, 'bypass')).toEqual(rejection);
  expect(imported.definition.controlEdges.at(-1)?.target).toBe(outputId);
});

it('restores the ordinary exhausted port when the last review is released from a surviving Loop', async () => {
  const { draft, wire, outputId, review, loop } = reviewed();
  // An imported gate with a missing reviewer still owns the ending until explicitly released.
  const incomplete = patchNode(draft, outputId, {
    requiredReviews: [{ ...review, reviewerNodeId: 'missing' }],
  });
  expect(checkPorts(incomplete, wire)).toEqual({ ok: false, reason: 'reviewExhausted' });
  const released = accepted(
    setRequiredOutputReview(incomplete, outputId, 'final', 'writer', false),
  );
  show(released);
  const canvas = within(screen.getByRole('application', { name: en.TeamEditor.canvas }));
  expect(canvas.queryByText('No final submission')).toBeNull();
  const port = canvas.getByRole('button', { name: `Start from ${loop.label} · exhausted` });
  port.focus();
  await userEvent.keyboard('{Enter}');
  expect(canvas.getByRole('status')).toHaveTextContent(`${loop.label} · exhausted`);
  expect(accepted(connectPorts(released, wire)).definition.controlEdges).toContainEqual(
    expect.objectContaining(wire),
  );
});
