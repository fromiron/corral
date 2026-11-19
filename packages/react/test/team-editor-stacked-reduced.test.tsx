import { fireEvent, render, screen, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { StudioStoresProvider } from '../src/context.tsx';
import { emptyDraft } from '../src/editor/model.ts';
import { createEditorStore } from '../src/editor/store.ts';
import messages from '../src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../src/stories/fixtures.tsx';
import { placeStep } from '../src/team-editor/commands.ts';
import { TeamEditor } from '../src/team-editor/TeamEditor.tsx';

// canvas.md 1: in the stacked editor, settings opened from outside the canvas scroll into view,
// and under reduced motion they are there at once. Motion reads the preference on its first use in
// this file, so it is set before anything renders.
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

beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
});
afterAll(() => vi.restoreAllMocks());

it('scrolls the settings into view at once under reduced motion', () => {
  const placed = placeStep(emptyDraft('reduced', 'Reduced team'), 'agent', { kind: 'empty' });
  if (!placed.ok) throw new Error(placed.reason);
  const editor = createEditorStore(placed.draft);
  render(
    <IntlProvider locale="en" messages={messages}>
      <StudioStoresProvider editor={editor} session={sessionStore()}>
        <TeamEditor editor={editor} stacked />
      </StudioStoresProvider>
    </IntlProvider>,
  );
  const root = document.querySelector('[data-graph-scroll]') as HTMLElement;
  const scrollTo = vi.fn();
  root.scrollTo = scrollTo as unknown as typeof root.scrollTo;
  const outline = screen.getByRole('complementary', { name: messages.TeamEditor.outline });
  fireEvent.click(within(outline).getByRole('button', { name: 'Agent 1' }));
  const settings = screen.getByRole('complementary', { name: messages.TeamEditor.inspector });
  expect(scrollTo).toHaveBeenCalledWith({
    top: (settings.parentElement as HTMLElement).offsetTop,
    behavior: 'instant',
  });
});
