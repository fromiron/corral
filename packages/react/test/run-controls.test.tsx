import { type CorralDefinition, DEFAULT_LIMITS } from '@corral/contracts';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { RunControls } from '../src/components/RunControls.tsx';
import { StudioStoresProvider } from '../src/context.tsx';
import { draftFromDefinition } from '../src/editor/model.ts';
import { createEditorStore } from '../src/editor/store.ts';
import messages from '../src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../src/stories/fixtures.tsx';

// The editor's test run starts outside any session (docs/specs/features/canvas.md, 14).

function team(withCheck: boolean): CorralDefinition {
  return {
    schemaVersion: '0.1',
    id: 'checked',
    name: 'Checked',
    entryNodeId: 'writer',
    input: { brief: 'Write the change.', criteria: ['Types pass.'] },
    roles: [
      {
        id: 'writer_role',
        name: 'writer',
        prompt: 'Write.',
        modelProfile: 'model-a',
        allowedWorkTools: ['write_artifact'],
        allowedCollaborationTools: ['submit_result'],
        outputContract: 'text',
      },
    ],
    nodes: [
      {
        id: 'writer',
        type: 'agent',
        label: 'Writer',
        roleId: 'writer_role',
        invocation: 'scheduled',
        inputBindings: [{ kind: 'run_input', name: 'brief' }],
        outputName: 'text',
      },
      ...(withCheck
        ? [
            {
              id: 'types',
              type: 'decision' as const,
              label: 'Types',
              mode: 'check' as const,
              checkIds: ['types'],
              inputBindings: [
                { kind: 'task_output' as const, name: 'change', sourceNodeId: 'writer' },
              ],
            },
          ]
        : []),
      {
        id: 'output',
        type: 'output',
        label: 'Output',
        inputBindings: [{ kind: 'task_output', name: 'final', sourceNodeId: 'writer' }],
        requireApproval: false,
      },
    ],
    controlEdges: withCheck
      ? [
          { id: 'e1', source: 'writer', sourcePort: 'out', target: 'types', targetPort: 'in' },
          { id: 'e2', source: 'types', sourcePort: 'pass', target: 'output', targetPort: 'in' },
        ]
      : [{ id: 'e1', source: 'writer', sourcePort: 'out', target: 'output', targetPort: 'in' }],
    capabilityLinks: [],
    limits: DEFAULT_LIMITS,
  } as CorralDefinition;
}

function renderControls(definition: CorralDefinition, live = false, available = true) {
  const start = vi.fn().mockResolvedValue(undefined);
  render(
    <IntlProvider locale="en" messages={messages}>
      <StudioStoresProvider
        editor={createEditorStore(draftFromDefinition(definition))}
        session={sessionStore({ start })}
      >
        <RunControls
          mode={live ? 'live' : 'mock'}
          liveAvailable={available}
          roleOverrides={{ writer_role: { modelProfile: 'override' } }}
          breakpoints={['writer']}
        />
      </StudioStoresProvider>
    </IntlProvider>,
  );
  return {
    start,
    run: screen.getByRole('button', { name: live ? 'Run with real models' : 'Start mock test' }),
  };
}

describe('test run controls', () => {
  it('keep Run off for a team with a check step and say why', () => {
    const { run } = renderControls(team(true));
    expect(run).toBeDisabled();
    expect(
      screen.getByText(
        "Check steps run only in a conversation's Paddock, so this Corral can't start here.",
      ),
    ).toBeInTheDocument();
  });

  it('leave Run on for the same team without its check step', () => {
    const { run } = renderControls(team(false));
    expect(run).toBeEnabled();
    expect(screen.queryByText(/Check steps run only/)).toBeNull();
  });

  it('sends live mode and the prepared overrides only through its named action', async () => {
    const { run, start } = renderControls(team(false), true);
    expect(start).not.toHaveBeenCalled();
    fireEvent.click(run);
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith(
        team(false),
        undefined,
        'live',
        undefined,
        undefined,
        { writer_role: { modelProfile: 'override' } },
        ['writer'],
      ),
    );
  });

  it('never starts when real models are unavailable', () => {
    const { run, start } = renderControls(team(false), true, false);
    expect(run).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(messages.Run.liveUnavailable);
    fireEvent.click(run);
    expect(start).not.toHaveBeenCalled();
  });
});
