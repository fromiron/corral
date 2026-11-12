import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ThinkingStep,
  ThinkingSteps,
  ThinkingStepsContent,
} from '../src/design-kit/components/ui/thinking-steps.tsx';

/** The step's outer element, the one whose height grows a new step in. */
function stepFrame(label: string): HTMLElement {
  const frame = screen.getByText(label).closest<HTMLElement>('.z-10.overflow-hidden');
  if (!frame) throw new Error(`No step frame for ${label}`);
  return frame;
}

function Steps({ labels, settledOnMount }: { labels: string[]; settledOnMount?: boolean }) {
  return (
    <ThinkingSteps open>
      <ThinkingStepsContent settledOnMount={settledOnMount}>
        {labels.map((label) => (
          <ThinkingStep key={label} label={label} />
        ))}
      </ThinkingStepsContent>
    </ThinkingSteps>
  );
}

describe('ThinkingStep in a panel that mounts open', () => {
  beforeEach(() => {
    // jsdom lays nothing out; give every element a height so the panel can measure itself.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(20);
    class Observer {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', Observer);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('grows its first steps in by default, as the source kit does', () => {
    render(<Steps labels={['Read the brief']} />);
    expect(stepFrame('Read the brief').style.height).toBe('0px');
  });

  it('with settledOnMount, shows the steps it mounts with at their height; later steps grow in', async () => {
    const view = render(<Steps labels={['Read the brief']} settledOnMount />);
    // Arrived with the open panel (a view mounted again): never drawn at height 0.
    expect(stepFrame('Read the brief').style.height).not.toBe('0px');
    // A frame later the panel has its height; a new step is new work and grows in from 0.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    view.rerender(<Steps labels={['Read the brief', 'Wrote the answer']} settledOnMount />);
    expect(stepFrame('Wrote the answer').style.height).toBe('0px');
  });
});
