import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentAvatar, AgentCard } from '../src/design-kit/index.ts';
import { Elevated } from '../src/design-kit/lib/elevated.tsx';

const levels = (el: Element | null) => ({
  bg: el?.className.match(/bg-surface-(\d)/)?.[1],
  shadow: el?.className.match(/shadow-surface-(\d)/)?.[1],
});

describe('surface shadows follow how far a surface is raised, not how deep it is nested', () => {
  it('keeps a nested card on the same shadow as a top-level card while its background steps up', () => {
    const { getByTestId } = render(
      <AgentCard data-testid="outer">
        <AgentCard data-testid="middle">
          <AgentCard data-testid="inner" />
        </AgentCard>
      </AgentCard>,
    );
    expect(levels(getByTestId('outer'))).toEqual({ bg: '3', shadow: '3' });
    expect(levels(getByTestId('middle'))).toEqual({ bg: '5', shadow: '3' });
    expect(levels(getByTestId('inner'))).toEqual({ bg: '7', shadow: '3' });
  });

  it('still honours an explicit shadow level and a dialog-sized raise', () => {
    const { getByTestId } = render(
      <>
        <Elevated data-testid="pinned" offset={2} shadowLevel={6} />
        <Elevated data-testid="dialog" offset={4} />
      </>,
    );
    expect(levels(getByTestId('pinned')).shadow).toBe('6');
    expect(levels(getByTestId('dialog')).shadow).toBe('5');
  });

  it('gives an inline avatar tile only the hairline step', () => {
    const { container } = render(
      <AgentCard>
        <AgentCard>
          <AgentAvatar name="Assistant" decorative={false} />
        </AgentCard>
      </AgentCard>,
    );
    const tile = container.querySelector('[aria-label="Assistant"] > span');
    expect(levels(tile).shadow).toBe('1');
  });
});
