import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, waitFor, within } from 'storybook/test';
import { StudioStoresProvider } from '../context.tsx';
import { type EditorDraft, emptyDraft } from '../editor/model.ts';
import { createEditorStore, type EditorStore } from '../editor/store.ts';
import messages from '../messages/en.json' with { type: 'json' };
import { sessionStore } from '../stories/fixtures.tsx';
import { type EditResult, patchNode, placeStep } from './commands.ts';
import { TeamEditor } from './TeamEditor.tsx';

// The team editor's two layouts (docs/specs/features/canvas.md 1 and canvas.feature): the
// outline beside the canvas with the settings floating over it, or, when the host finds the
// editor narrower than 960px, the outline, the palette, the canvas and the settings one under
// another, scrolling inside the editor.

const m = messages.TeamEditor;

function ok(result: EditResult): { draft: EditorDraft; nodeId: string } {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return { draft: result.draft, nodeId: result.nodeId ?? '' };
}

/** A → B; with `loop`, also an empty Loop to move a step into. */
function team(loop: boolean): EditorDraft {
  const a = ok(placeStep(emptyDraft('layout', 'Layout team'), 'agent', { kind: 'empty' }));
  const b = ok(placeStep(a.draft, 'agent', { kind: 'after', nodeId: a.nodeId }));
  const named = patchNode(patchNode(b.draft, a.nodeId, { label: 'A' }), b.nodeId, { label: 'B' });
  return loop ? ok(placeStep(named, 'loop', { kind: 'empty' })).draft : named;
}

// The store of the story on screen, so a play function can read what a drop did to the draft.
let shown: EditorStore | null = null;

function LaidOut({
  width,
  height,
  stacked,
  loop = false,
  dark = false,
}: {
  width: number;
  height: number;
  stacked: boolean;
  loop?: boolean;
  dark?: boolean;
}) {
  const editor = useMemo(() => createEditorStore(team(loop)), [loop]);
  const session = useMemo(() => sessionStore(), []);
  shown = editor;
  return (
    <div className={dark ? 'dark bg-background text-foreground' : 'bg-background text-foreground'}>
      <div style={{ width, height }}>
        <StudioStoresProvider editor={editor} session={session}>
          <TeamEditor editor={editor} stacked={stacked} />
        </StudioStoresProvider>
      </div>
    </div>
  );
}

const meta = {
  title: 'Team editor/Layout',
  component: LaidOut,
  args: { width: 900, height: 720, stacked: true },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof LaidOut>;

export default meta;
type Story = StoryObj<typeof meta>;

const rect = (element: Element) => element.getBoundingClientRect();
const regions = (canvasElement: HTMLElement) => {
  const view = within(canvasElement);
  return {
    editor: canvasElement.querySelector('[data-layout]') as HTMLElement,
    outline: view.getByRole('complementary', { name: m.outline }),
    palette: view.getByRole('toolbar', { name: m.palette }),
    canvas: view.getByRole('application', { name: m.canvas }),
  };
};
const card = (canvasElement: HTMLElement, id: string) =>
  canvasElement.querySelector(`[data-team-canvas] [data-node="${id}"]`) as HTMLElement | null;

/** Selects a step on its card and waits for its settings to settle. */
async function selectStep(canvasElement: HTMLElement, id: string) {
  await waitFor(() => expect(card(canvasElement, id)).toBeTruthy());
  card(canvasElement, id)?.click();
  const sheet = await within(canvasElement).findByRole('complementary', { name: m.inspector });
  const motion = sheet.parentElement as Element;
  await waitFor(() => expect(getComputedStyle(motion).opacity).toBe('1'));
  await waitFor(() =>
    expect(getComputedStyle(motion).transform).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/),
  );
  return sheet;
}

const dragEvent = (type: string, dataTransfer: DataTransfer, at?: { x: number; y: number }) =>
  new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    dataTransfer,
    ...(at ? { clientX: at.x, clientY: at.y } : {}),
  });
const centre = (element: Element) => {
  const r = rect(element);
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

/** Drags the palette's Review onto the connection between A and B, as a browser would. */
async function dropReviewBetween(canvasElement: HTMLElement) {
  const { palette, canvas } = regions(canvasElement);
  const review = within(palette).getByRole('button', { name: `Add ${m.kinds.review}` });
  const data = new DataTransfer();
  review.dispatchEvent(dragEvent('dragstart', data));
  await expect([...data.types]).toEqual(['application/x-corral-step']);
  // While a step is dragged every connection shows where it would go in.
  const insert = await within(canvas).findByRole('button', { name: m.insertHere });
  const at = centre(insert);
  insert.dispatchEvent(dragEvent('dragover', data, at));
  insert.dispatchEvent(dragEvent('drop', data, at));
  review.dispatchEvent(dragEvent('dragend', data));
  const definition = shown?.getState().draft.definition;
  const added = definition?.nodes.find((n) => n.type === 'decision');
  const edges = definition?.controlEdges.map((e) => `${e.source}>${e.target}`) ?? [];
  await expect(edges).toContain(`agent_1>${added?.id}`);
  await expect(edges).toContain(`${added?.id}>agent_2`);
  await expect(edges).not.toContain('agent_1>agent_2');
  // The new card fades in; the accessibility check reads it settled.
  await waitFor(() => expect(card(canvasElement, added?.id ?? '')?.style.opacity).toBe(''));
}

/**
 * 900px: the outline, the palette and the canvas one under another, the chosen step's settings
 * under the canvas, never over it, and a Review dropped on the connection goes between A and B.
 */
export const Stacked: Story = {
  play: async ({ canvasElement }) => {
    const { editor, outline, palette, canvas } = regions(canvasElement);
    await expect(rect(outline).bottom).toBeLessThanOrEqual(rect(palette).top + 0.5);
    await expect(rect(palette).bottom).toBeLessThanOrEqual(rect(canvas).top + 0.5);
    // One column: each region starts at the editor's left edge and the canvas has its width.
    for (const region of [outline, palette, canvas])
      await expect(Math.abs(rect(region).left - rect(editor).left)).toBeLessThan(1);
    await expect(rect(canvas).width).toBeGreaterThan(rect(editor).width * 0.9);
    const sheet = await selectStep(canvasElement, 'agent_1');
    await expect(rect(sheet).top).toBeGreaterThanOrEqual(rect(canvas).bottom - 0.5);
    await expect(Math.abs(rect(sheet).left - rect(editor).left)).toBeLessThan(1);
    // A card chosen on the canvas leaves the editor where it is: the person works on the canvas.
    await expect(editor.scrollTop).toBe(0);
    // The editor scrolls, and the canvas, which keeps touch for panning, never fills it, so there
    // is always somewhere to scroll from. A plain wheel over the canvas is the editor's to
    // scroll; Ctrl or ⌘ with it, as a pinch sends it, zooms the canvas.
    await expect(getComputedStyle(editor).overflowY).toBe('auto');
    await expect(editor.scrollHeight).toBeGreaterThan(editor.clientHeight);
    await expect(rect(canvas).height).toBeLessThan(editor.clientHeight);
    const turn = (init: WheelEventInit) =>
      canvas.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120, ...init }),
      );
    await expect(turn({})).toBe(true);
    await expect(turn({ ctrlKey: true })).toBe(false);
    // Scrolled to the palette, the settings' head shows under the canvas.
    editor.scrollTop += rect(palette).top - rect(editor).top;
    await expect(rect(sheet).top).toBeLessThan(rect(editor).bottom);
    await dropReviewBetween(canvasElement);
  },
};

/**
 * A short editor: 60% of its height would leave the canvas too small, so it takes 400px or as
 * much as leaves 6rem of the editor to scroll by, whichever is less.
 */
export const StackedShort: Story = {
  args: { height: 480 },
  play: async ({ canvasElement }) => {
    const { editor, canvas } = regions(canvasElement);
    await waitFor(() => expect(card(canvasElement, 'agent_1')).toBeTruthy());
    await expect(rect(canvas).height).toBeGreaterThan(editor.clientHeight * 0.6 + 1);
    await expect(rect(canvas).height).toBeLessThanOrEqual(editor.clientHeight - 96 + 0.5);
  },
};

/**
 * 540px, a panel beside the conversation: the palette wraps inside the width, nothing scrolls
 * sideways, and dropping a connected step into a Loop previews its boundary crossing before
 * moving it.
 */
export const StackedNarrow: Story = {
  args: { width: 540, loop: true },
  play: async ({ canvasElement, userEvent }) => {
    const { editor, outline, palette } = regions(canvasElement);
    await waitFor(() => expect(card(canvasElement, 'agent_1')).toBeTruthy());
    await expect(rect(palette).right).toBeLessThanOrEqual(rect(editor).right + 0.5);
    for (const button of within(palette).getAllByRole('button'))
      await expect(rect(button).right).toBeLessThanOrEqual(rect(editor).right + 0.5);
    await expect(editor.scrollWidth).toBeLessThanOrEqual(editor.clientWidth);
    const original = shown?.getState().draft;
    const row = within(outline).getByRole('button', { name: 'B' });
    const target = within(outline).getByRole('button', { name: 'Loop' });
    const data = new DataTransfer();
    row.dispatchEvent(dragEvent('dragstart', data));
    await expect([...data.types]).toEqual(['application/x-corral-node']);
    target.dispatchEvent(dragEvent('dragover', data, centre(target)));
    target.dispatchEvent(dragEvent('drop', data, centre(target)));
    row.dispatchEvent(dragEvent('dragend', data));
    const dialog = await within(canvasElement.ownerDocument.body).findByRole('dialog', {
      name: m.placement.previewTitle,
    });
    await expect(shown?.getState().draft).toBe(original);
    await expect(within(dialog).getByRole('heading', { name: m.placement.boundary })).toBeVisible();
    await expect(within(dialog).getByRole('listitem')).toHaveTextContent('A · out → B · in');
    await userEvent.click(within(dialog).getByRole('button', { name: m.placement.apply }));
    const loop = shown?.getState().draft.definition.nodes.find((n) => n.type === 'loop');
    const moved = shown?.getState().draft.definition.nodes.find((n) => n.id === 'agent_2');
    await expect(moved?.parentId).toBe(loop?.id);
  },
};

/**
 * 1200px: the outline sits beside the palette and canvas. The palette occupies the row above
 * the canvas, and the settings stay inside the canvas, leaving at least 320px uncovered.
 */
export const Beside: Story = {
  args: { width: 1200, stacked: false },
  play: async ({ canvasElement }) => {
    const { outline, palette, canvas } = regions(canvasElement);
    await expect(rect(outline).right).toBeLessThanOrEqual(rect(canvas).left + 0.5);
    await expect(rect(outline).right).toBeLessThanOrEqual(rect(palette).left + 0.5);
    await expect(Math.abs(rect(palette).left - rect(canvas).left)).toBeLessThanOrEqual(0.5);
    await expect(Math.abs(rect(palette).right - rect(canvas).right)).toBeLessThanOrEqual(0.5);
    await expect(rect(palette).bottom).toBeLessThanOrEqual(rect(canvas).top + 0.5);
    const sheet = await selectStep(canvasElement, 'agent_1');
    await expect(rect(sheet).right).toBeLessThanOrEqual(rect(canvas).right);
    await expect(rect(sheet).left - rect(canvas).left).toBeGreaterThanOrEqual(320);
    await expect(rect(sheet).top).toBeGreaterThanOrEqual(rect(canvas).top - 0.5);
    await expect(rect(sheet).bottom).toBeLessThanOrEqual(rect(canvas).bottom + 0.5);
  },
};

/** 960px, the narrowest beside: the open settings still leave 320px of the canvas uncovered. */
export const BesideNarrowest: Story = {
  args: { width: 960, stacked: false },
  play: async ({ canvasElement }) => {
    const { canvas } = regions(canvasElement);
    const sheet = await selectStep(canvasElement, 'agent_1');
    await expect(rect(sheet).left - rect(canvas).left).toBeGreaterThanOrEqual(320);
  },
};

/**
 * Settings opened from outside the canvas, from an outline row or the team settings, scroll
 * into view at their top; the editor cannot scroll past its end, so a short sheet stops there.
 */
export const StackedSettingsFromOutline: Story = {
  play: async ({ canvasElement }) => {
    const { editor, outline } = regions(canvasElement);
    await waitFor(() => expect(card(canvasElement, 'agent_2')).toBeTruthy());
    within(outline).getByRole('button', { name: 'B' }).click();
    const sheet = await within(canvasElement).findByRole('complementary', { name: m.inspector });
    await waitFor(() => expect(Math.abs(rect(sheet).top - rect(editor).top)).toBeLessThan(1));
    editor.scrollTop = 0;
    within(outline).getByRole('button', { name: m.teamSettings }).click();
    await waitFor(() => expect(editor.scrollTop).toBeGreaterThan(0));
    await waitFor(() => {
      const top = rect(sheet).top - rect(editor).top;
      const atEnd = editor.scrollTop >= editor.scrollHeight - editor.clientHeight - 1;
      expect(Math.abs(top) < 1 || (atEnd && top > 0)).toBe(true);
    });
    await waitFor(() => expect(getComputedStyle(sheet.parentElement as Element).opacity).toBe('1'));
  },
};

/** The stacked settings in the dark theme, so the accessibility check reads its colours. */
export const StackedDark: Story = {
  args: { dark: true },
  play: async ({ canvasElement }) => {
    await selectStep(canvasElement, 'agent_1');
  },
};
