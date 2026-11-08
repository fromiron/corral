import type { NodeRunFacts, RunStats } from '@corral/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { StudioStoresProvider } from '../src/context.tsx';
import { type EditorDraft, emptyDraft } from '../src/editor/model.ts';
import { createEditorStore } from '../src/editor/store.ts';
import messages from '../src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../src/stories/fixtures.tsx';
import { applyPattern, type EditResult, placeStep } from '../src/team-editor/commands.ts';
import { statFigures } from '../src/team-editor/runStats.ts';
import { TeamEditor } from '../src/team-editor/TeamEditor.tsx';

// Run stats over the team canvas (docs/specs/features/run-stats.md).

beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
});
afterAll(() => vi.restoreAllMocks());

function ok(result: EditResult): EditorDraft {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.draft;
}

/** agent_1 inside loop_1, reviewed by agent_2 and decision_1, then output_1. */
function reviewedTeam(): EditorDraft {
  const writer = ok(placeStep(emptyDraft(), 'agent', { kind: 'empty' }));
  const output = ok(placeStep(writer, 'output', { kind: 'after', nodeId: 'agent_1' }));
  return ok(applyPattern(output, 'reviewLoop', ['agent_1']));
}

const fact = (runId: string, facts: Partial<NodeRunFacts>): NodeRunFacts => ({
  runId,
  executions: 0,
  failures: 0,
  retries: 0,
  outputTokens: 0,
  rounds: 0,
  capReached: false,
  branches: {},
  ...facts,
});

const runs = ['run_4', 'run_3', 'run_2', 'run_1'];
const stats: RunStats = {
  corralId: 'team',
  definitionRevision: 3,
  runs: runs.map((runId, i) => ({
    runId,
    status: i === 0 ? 'failed' : 'succeeded',
    startedAt: `2026-11-0${4 - i}T09:00:00.000Z`,
    endedAt: `2026-11-0${4 - i}T09:05:00.000Z`,
  })),
  totalOutputTokens: 1000,
  nodes: {
    loop_1: {
      perRun: [
        fact('run_4', { rounds: 3, capReached: true }),
        fact('run_3', { rounds: 3 }),
        fact('run_2', { rounds: 2 }),
        fact('run_1', { rounds: 1 }),
      ],
    },
    decision_1: {
      perRun: [
        fact('run_4', { branches: { revise: 2 } }),
        fact('run_3', { branches: { revise: 1, pass: 1 } }),
        fact('run_2', { branches: { pass: 1 } }),
      ],
    },
    agent_1: {
      perRun: [
        fact('run_4', { executions: 3, failures: 1, retries: 1, outputTokens: 400 }),
        fact('run_3', { executions: 2, outputTokens: 300 }),
      ],
    },
  },
};

describe('run stats figures', () => {
  it('turns the stats into figures per step of the saved revision', () => {
    const draft = reviewedTeam();
    const figures = statFigures(draft.definition, draft.definition, stats);
    expect(figures.get('loop_1')).toEqual([
      expect.objectContaining({ kind: 'rounds', average: 2.25 }),
      expect.objectContaining({
        kind: 'cap',
        hit: 1,
        of: 4,
        runs: [{ runId: 'run_4', value: 3 }],
      }),
    ]);
    expect(figures.get('decision_1')).toEqual([
      expect.objectContaining({ kind: 'branch', port: 'revise', count: 3 }),
      expect.objectContaining({
        kind: 'branch',
        port: 'pass',
        count: 2,
        runs: [
          { runId: 'run_3', value: 1 },
          { runId: 'run_2', value: 1 },
        ],
      }),
    ]);
    expect(figures.get('agent_1')).toEqual([
      expect.objectContaining({ kind: 'tokens', share: 0.7 }),
      expect.objectContaining({ kind: 'failures', count: 1, runs: [{ runId: 'run_4', value: 1 }] }),
      expect.objectContaining({ kind: 'retries', count: 1 }),
    ]);
    // The reviewer never ran in a counted run; the output has no figures.
    expect(figures.get('agent_2')).toEqual([{ kind: 'idle', runs: [] }]);
    expect(figures.has('output_1')).toBe(false);
  });

  it('gives steps the saved revision does not have no figures', () => {
    const draft = reviewedTeam();
    const added = ok(placeStep(draft, 'agent', { kind: 'empty' }));
    const figures = statFigures(added.definition, draft.definition, stats);
    expect(figures.has('agent_3')).toBe(false);
    expect(figures.has('agent_1')).toBe(true);
  });

  it('has no figures without counted runs', () => {
    const draft = reviewedTeam();
    const figures = statFigures(draft.definition, draft.definition, {
      ...stats,
      runs: [],
      totalOutputTokens: 0,
      nodes: {},
    });
    expect(figures.size).toBe(0);
  });
});

describe('run stats layer', () => {
  function renderLayer(onOpenRun = vi.fn()) {
    const draft = reviewedTeam();
    const editor = createEditorStore(draft);
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <StudioStoresProvider editor={editor} session={sessionStore()}>
          <TeamEditor
            editor={editor}
            runStats={{ stats, definition: draft.definition }}
            onOpenRun={onOpenRun}
          />
        </StudioStoresProvider>
      </IntlProvider>,
    );
    return onOpenRun;
  }
  const figuresOf = (nodeId: string) =>
    document.querySelector(`[data-team-canvas] [data-stats="${nodeId}"]`) as HTMLElement;

  it('pins the figures to their steps and lists the runs behind one', async () => {
    const onOpenRun = renderLayer();
    expect(within(figuresOf('loop_1')).getByRole('button', { name: /2\.3 rounds/ })).toBeTruthy();
    expect(within(figuresOf('agent_2')).getByText('Not run')).toBeTruthy();
    expect(figuresOf('output_1')).toBeNull();

    const cap = within(figuresOf('loop_1')).getByRole('button', { name: /cap 1\/4/ });
    await act(async () => fireEvent.click(cap));
    const list = await screen.findByRole('dialog');
    const rows = within(list).getAllByRole('button');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toMatch(/Failed/);
    await act(async () => fireEvent.click(rows[0] as HTMLElement));
    expect(onOpenRun).toHaveBeenCalledWith('run_4');
  });

  it('does not select or deselect steps when a figure is pressed', async () => {
    renderLayer();
    const branch = within(figuresOf('decision_1')).getByRole('button', { name: /revise 3/ });
    await act(async () => fireEvent.pointerDown(branch));
    await act(async () => fireEvent.click(branch));
    expect(screen.queryByRole('complementary', { name: /settings/i })).toBeNull();
  });
});
