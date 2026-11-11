import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PreviewCard,
  PreviewCardButton,
  PreviewCardGrid,
  PreviewCardGroup,
} from '../src/design-kit/adapters/preview-cards.tsx';

// One choice among picture cards (Corral's appearance gallery): a radio group with one tab stop,
// keys that move and choose at once, and a selection ring that springs from card to card.

const VALUES = ['dawn', 'noon', 'dusk'];

// Motion reads the reduced-motion query on its first use and then follows its change event, so
// the query is in place before anything renders.
let reduce = false;
let changed: (() => void) | null = null;
window.matchMedia = (query: string) =>
  ({
    get matches() {
      return query.includes('reduced-motion') && reduce;
    },
    media: query,
    addEventListener: (_: string, listener: () => void) => {
      if (query.includes('reduced-motion')) changed = listener;
    },
    removeEventListener() {},
  }) as unknown as MediaQueryList;

function Cards({ initial = 'dawn' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <PreviewCardGroup aria-label="Look" value={value} onValueChange={setValue} values={VALUES}>
        <PreviewCardGrid>
          {VALUES.map((each, index) => (
            <PreviewCard
              key={each}
              value={each}
              index={index}
              label={each[0]?.toUpperCase() + each.slice(1)}
              preview={<span />}
            />
          ))}
          <PreviewCardButton index={VALUES.length} label="Add" icon={null} />
        </PreviewCardGrid>
      </PreviewCardGroup>
      <button type="button">After</button>
    </>
  );
}

const radio = (name: string) => screen.getByRole('radio', { name });
const checked = () =>
  screen
    .getAllByRole('radio')
    .filter((each) => each.getAttribute('aria-checked') === 'true')
    .map((each) => each.getAttribute('aria-label'));

describe('preview cards', () => {
  it('are one radio group whose chosen card alone is checked and holds the one tab stop', () => {
    render(<Cards initial="noon" />);
    expect(screen.getAllByRole('radiogroup')).toHaveLength(1);
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(checked()).toEqual(['Noon']);
    expect(screen.getAllByRole('radio').map((each) => each.getAttribute('tabindex'))).toEqual([
      '-1',
      '0',
      '-1',
    ]);
  });

  it('give the first card the tab stop when no card is chosen', () => {
    render(<Cards initial="midnight" />);
    expect(checked()).toEqual([]);
    expect(radio('Dawn')).toHaveAttribute('tabindex', '0');
  });

  it('move and choose with the arrows, Home and End, and Tab leaves the group', async () => {
    const user = userEvent.setup();
    render(<Cards />);
    await user.tab();
    expect(radio('Dawn')).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(radio('Noon')).toHaveFocus();
    expect(checked()).toEqual(['Noon']);
    await user.keyboard('{ArrowDown}');
    expect(checked()).toEqual(['Dusk']);
    // Wraps around, as native radios do.
    await user.keyboard('{ArrowRight}');
    expect(radio('Dawn')).toHaveFocus();
    expect(checked()).toEqual(['Dawn']);
    await user.keyboard('{ArrowLeft}');
    expect(checked()).toEqual(['Dusk']);
    await user.keyboard('{Home}');
    expect(radio('Dawn')).toHaveFocus();
    expect(checked()).toEqual(['Dawn']);
    await user.keyboard('{End}');
    expect(radio('Dusk')).toHaveFocus();
    expect(checked()).toEqual(['Dusk']);
    // The action tile after the cards is a separate stop, then the page goes on.
    await user.tab();
    expect(screen.getByRole('button', { name: 'Add' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('choose with Space, Enter and a press', async () => {
    const user = userEvent.setup();
    render(<Cards />);
    radio('Noon').focus();
    await user.keyboard(' ');
    expect(checked()).toEqual(['Noon']);
    radio('Dusk').focus();
    await user.keyboard('{Enter}');
    expect(checked()).toEqual(['Dusk']);
    await user.click(radio('Dawn'));
    expect(checked()).toEqual(['Dawn']);
  });
});

describe('the selection ring', () => {
  // jsdom has no layout: each card's picture is 160 × 100, 200px after the one before it.
  const props = ['offsetLeft', 'offsetTop', 'offsetWidth', 'offsetHeight', 'offsetParent'] as const;
  const original = new Map(
    props.map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]),
  );
  const media = (element: HTMLElement) => element.matches('[data-preview-card-media]');
  const index = (element: HTMLElement) =>
    Number(element.closest('[data-fluid-hover-index]')?.getAttribute('data-fluid-hover-index'));
  beforeEach(() => {
    const define = (name: (typeof props)[number], get: (this: HTMLElement) => unknown) =>
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get });
    define('offsetLeft', function () {
      return media(this) ? index(this) * 200 : 0;
    });
    define('offsetTop', () => 0);
    define('offsetWidth', function () {
      return media(this) ? 160 : 0;
    });
    define('offsetHeight', function () {
      return media(this) ? 100 : 0;
    });
    define('offsetParent', () => null);
  });
  afterEach(() => {
    for (const [name, descriptor] of original)
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
  });

  const ring = () => document.querySelector<HTMLElement>('[data-preview-card-ring]');
  async function frames(milliseconds: number) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    });
  }
  async function moveTo(name: string) {
    fireEvent.click(radio(name));
    await frames(40);
    return ring()?.style.transform ?? '';
  }

  it('rings the chosen picture, 4px outside it, with a check', async () => {
    render(<Cards initial="noon" />);
    await frames(40);
    const shown = ring();
    expect(shown?.style.transform).toContain('translateX(196px)');
    expect(shown?.style.width).toBe('168px');
    expect(shown?.style.height).toBe('108px');
    expect(shown?.querySelector('svg')).not.toBeNull();
  });

  it('springs to the next choice, so it is still travelling a moment later', async () => {
    reduce = false;
    changed?.();
    render(<Cards />);
    await frames(40);
    expect(ring()?.style.transform).toContain('translateX(-4px)');
    const moving = await moveTo('Dusk');
    expect(moving).not.toContain('translateX(-4px)');
    expect(moving).not.toContain('translateX(396px)');
  });

  it('lands at once under reduced motion', async () => {
    reduce = true;
    changed?.();
    render(<Cards />);
    await frames(40);
    expect(await moveTo('Dusk')).toContain('translateX(396px)');
    expect(await moveTo('Noon')).toContain('translateX(196px)');
    reduce = false;
    changed?.();
  });
});
