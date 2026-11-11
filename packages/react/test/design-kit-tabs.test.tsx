import { render, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { TabItem, Tabs, TabsList } from '../src/design-kit/components/ui/tabs.tsx';
import { SurfaceProvider } from '../src/design-kit/lib/surface-context.tsx';

// The selected tab is a pill inside the list's track, not a floating surface: its fill rises
// with the substrate so it stays apart from the track, but its shadow stays the quiet step the
// kit gives a control at rest, however deep the tabs are nested.

window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }) as unknown as MediaQueryList;

// jsdom lays nothing out; the tabs only need a size to count as measured.
for (const [name, value] of [
  ['offsetWidth', 48],
  ['offsetHeight', 28],
  ['clientWidth', 48],
  ['clientHeight', 28],
] as const)
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
HTMLElement.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 48, 28);

async function pill(substrate: number) {
  const view = render(
    <SurfaceProvider value={substrate}>
      <Tabs defaultValue="a">
        <TabsList aria-label="Views">
          <TabItem value="a">Alpha</TabItem>
          <TabItem value="b">Beta</TabItem>
        </TabsList>
      </Tabs>
    </SurfaceProvider>,
  );
  // The pill is drawn once the tabs are measured, on the next frame.
  const element = await waitFor(() => {
    const found = screen
      .getByRole('tablist')
      .querySelector<HTMLElement>('[class*="shadow-surface-"]');
    if (!found) throw new Error('Missing the selected pill');
    return found;
  });
  view.unmount();
  return element.className;
}

it.each([
  [1, 'bg-surface-4'],
  [5, 'bg-surface-8'],
])(
  'on substrate %i the selected pill fills %s and keeps a level 2 shadow',
  async (substrate, fill) => {
    const classes = await pill(substrate);
    expect(classes).toContain(fill);
    expect(classes).toContain('shadow-surface-2');
    expect(classes).not.toMatch(/shadow-surface-[3-8]/);
  },
);
