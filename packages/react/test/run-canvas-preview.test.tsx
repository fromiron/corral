import type { ExecutionView } from '@corral/core';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps, ComponentType, ReactNode } from 'react';
import { useState } from 'react';
import { IntlProvider } from 'use-intl';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { RunCanvas } from '../src/components/RunCanvas.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { projectionWith, researchTeamDraft, sessionStore } from '../src/stories/fixtures.tsx';

beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterAll(() => vi.restoreAllMocks());

function execution(id: string, nodeId: string): ExecutionView {
  return {
    executionId: id,
    nodeId,
    taskId: `task_${id}`,
    attemptNo: 1,
    parentExecutionId: null,
    previousExecutionId: null,
    depth: 0,
    iterationId: null,
    modelProfile: 'model-a',
    configRevision: 0,
    criteriaVersionId: null,
    status: 'succeeded',
    activity: null,
    waitingOn: null,
    modelCallIds: [],
    error: null,
  };
}

type PreviewControls = { close: () => void; trigger: HTMLElement | null };
const PreviewCanvas = RunCanvas as ComponentType<
  ComponentProps<typeof RunCanvas> & {
    renderNodePreview: (id: string, controls: PreviewControls) => ReactNode;
  }
>;

function setup() {
  const { definition } = researchTeamDraft();
  const projection = projectionWith({
    executions: { writer: execution('writer', 'write'), reviewer: execution('reviewer', 'review') },
    executionOrder: ['writer', 'reviewer'],
    nodeExecutions: { write: ['writer'], review: ['reviewer'] },
  });
  const session = sessionStore({ runId: 'run_preview', definition, projection });
  const onSelect = vi.fn();
  function Harness() {
    const [selected, setSelected] = useState<string | null>(null);
    return (
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <PreviewCanvas
          session={session}
          definition={definition}
          selectedNodeId={selected}
          onSelectNode={(id) => {
            setSelected(id);
            onSelect(id);
          }}
          renderNodePreview={(id, { close }) => (
            <div>
              <p>Preview {id}</p>
              <button type="button" onClick={close}>
                Close preview
              </button>
            </div>
          )}
        />
      </IntlProvider>
    );
  }
  render(<Harness />);
  const button = (nodeId: string) => {
    const node = document.querySelector<HTMLElement>(
      `.react-flow__node[data-id="${nodeId}"] button`,
    );
    if (!node) throw new Error(`Missing ${nodeId} button`);
    return node;
  };
  return { button, onSelect };
}

it('opens one quick view at a time and moves it to the next selected agent', async () => {
  const { button, onSelect } = setup();
  await act(async () => fireEvent.click(button('write')));
  expect(await screen.findByText('Preview write')).toBeInTheDocument();
  expect(button('write')).toHaveAttribute('aria-pressed', 'true');
  await act(async () => fireEvent.click(button('review')));
  expect(await screen.findByText('Preview review')).toBeInTheDocument();
  expect(screen.queryByText('Preview write')).not.toBeInTheDocument();
  expect(button('review')).toHaveAttribute('aria-pressed', 'true');
  expect(onSelect.mock.calls.map((args) => args[0])).toEqual(['write', 'review']);
});

it('closes on Escape, restores focus to the node, and keeps its selection', async () => {
  const { button } = setup();
  const writer = button('write');
  writer.focus();
  await act(async () => fireEvent.click(writer));
  expect(await screen.findByText('Preview write')).toBeInTheDocument();
  await act(async () => fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' }));
  await waitFor(() => expect(screen.queryByText('Preview write')).not.toBeInTheDocument());
  await waitFor(() => expect(writer).toHaveFocus());
  expect(writer).toHaveAttribute('aria-pressed', 'true');
});

it('closes on an outside click without clearing the selected node', async () => {
  const { button } = setup();
  const writer = button('write');
  const outside = document.createElement('button');
  outside.textContent = 'Outside';
  document.body.append(outside);
  try {
    await act(async () => fireEvent.click(writer));
    expect(await screen.findByText('Preview write')).toBeInTheDocument();
    await act(async () => {
      fireEvent.pointerDown(outside);
      fireEvent.pointerUp(outside);
      fireEvent.click(outside);
    });
    await waitFor(() => expect(screen.queryByText('Preview write')).not.toBeInTheDocument());
    expect(writer).toHaveAttribute('aria-pressed', 'true');
  } finally {
    outside.remove();
  }
});
