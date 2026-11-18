import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  SidePanelFrame,
  type SidePanelPresentation,
} from '../src/design-kit/adapters/side-panel-frame.tsx';

// session-panel.md: with reduced motion, the panel's state changes happen at once. Motion reads
// the preference on its first use in this file, so it is set before anything renders.
window.matchMedia = (query: string) =>
  ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

function frame(presentation: SidePanelPresentation) {
  return (
    <SidePanelFrame
      presentation={presentation}
      sideLabel="패널"
      sideWidth={400}
      drawerWidth={400}
      main={<p>대화</p>}
      side={<p>패널 내용</p>}
    />
  );
}

it('opens and closes a drawer at once under reduced motion', () => {
  const view = render(frame('closed'));
  view.rerender(frame('drawer'));
  const side = screen.getByRole('region', { name: '패널' });
  expect(side.style.transform).toBe('');
  view.rerender(frame('withdrawn'));
  // No slide out: the side is gone in the same render.
  expect(screen.queryByRole('region', { name: '패널' })).toBeNull();
  expect(screen.getByText('패널 내용')).not.toBeVisible();
  expect(
    document.querySelector('[data-slot="side-panel-side"]')?.getAttribute('data-presentation'),
  ).toBe('withdrawn');
});
