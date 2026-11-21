import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { StudioStoresProvider } from '../src/context.tsx';
import { type EditorDraft, emptyDraft } from '../src/editor/model.ts';
import { createEditorStore } from '../src/editor/store.ts';
import messages from '../src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../src/stories/fixtures.tsx';
import { type EditResult, patchNode, placeStep, setParent } from '../src/team-editor/commands.ts';
import { TeamEditor } from '../src/team-editor/TeamEditor.tsx';
import { STEP_DRAG_TYPE } from '../src/team-editor/TeamGraphCanvas.tsx';

// The team editor stacked (docs/specs/features/canvas.md 1): when the host finds the editor
// narrower than 960px, the outline, the palette, the canvas and the chosen step's settings sit
// one under another. jsdom has no layout, so this checks the order, the drags, the keyboard, the
// wheel and the scrolling asked of the editor; Layout.stories.tsx checks the geometry in Chromium.

const m = messages.TeamEditor;

beforeAll(() => {
  // The canvas fits its view, and draws, only once its pane has a size.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
});
afterAll(() => vi.restoreAllMocks());

function ok(result: EditResult): { draft: EditorDraft; nodeId: string } {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return { draft: result.draft, nodeId: result.nodeId ?? '' };
}

/** A → B; with `loose`, also C on its own; with `loop`, also an empty Loop. */
function team({ loose = false, loop = false } = {}): EditorDraft {
  const a = ok(placeStep(emptyDraft('stacked', 'Stacked team'), 'agent', { kind: 'empty' }));
  const b = ok(placeStep(a.draft, 'agent', { kind: 'after', nodeId: a.nodeId }));
  let draft = patchNode(patchNode(b.draft, 'agent_1', { label: 'A' }), 'agent_2', { label: 'B' });
  if (loose) {
    const c = ok(placeStep(draft, 'agent', { kind: 'empty' }));
    draft = patchNode(c.draft, c.nodeId, { label: 'C' });
  }
  if (loop) draft = ok(placeStep(draft, 'loop', { kind: 'empty' })).draft;
  return draft;
}

function renderEditor(draft: EditorDraft, stacked: boolean) {
  const editor = createEditorStore(draft);
  const session = sessionStore();
  const tree = (stacked: boolean) => (
    <IntlProvider locale="en" messages={messages}>
      <StudioStoresProvider editor={editor} session={session}>
        <TeamEditor editor={editor} stacked={stacked} />
      </StudioStoresProvider>
    </IntlProvider>
  );
  const view = render(tree(stacked));
  return { editor, layout: (next: boolean) => view.rerender(tree(next)) };
}

const layoutOf = () => document.querySelector('[data-layout]')?.getAttribute('data-layout');
const outline = () => screen.getByRole('complementary', { name: m.outline });
const palette = () => screen.getByRole('toolbar', { name: m.palette });
const canvas = () => screen.getByRole('application', { name: m.canvas });
const sheet = () => screen.getByRole('complementary', { name: m.inspector });
const canvasNode = (id: string) =>
  document.querySelector(`[data-team-canvas] [data-node="${id}"]`) as HTMLElement;
const paletteStep = (kind: keyof typeof m.kinds) =>
  within(palette()).getByRole('button', { name: `Add ${m.kinds[kind]}` });
const outlineRow = (name: string) => within(outline()).getByRole('button', { name });
const edges = (draft: EditorDraft) =>
  draft.definition.controlEdges.map((e) => `${e.source}:${e.sourcePort}>${e.target}`);

/** The drag data one drag carries from its start to its drop, as a browser keeps it. */
function transfer() {
  const data = new Map<string, string>();
  return {
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
  };
}
type Transfer = ReturnType<typeof transfer>;

function drag(
  type: 'dragStart' | 'dragOver' | 'drop' | 'dragEnd',
  target: Element,
  dataTransfer: Transfer,
  at?: { x: number; y: number },
) {
  const event = createEvent[type](target, { dataTransfer });
  // jsdom has no DragEvent, so the pointer position is set on the plain event.
  if (at) {
    Object.defineProperty(event, 'clientX', { value: at.x });
    Object.defineProperty(event, 'clientY', { value: at.y });
  }
  fireEvent(target, event);
}

/** Where a point of the canvas stage is on screen; jsdom puts the pane at 0, 0. */
function onScreen(element: HTMLElement) {
  const stage = document.querySelector('[data-graph-stage]') as HTMLElement;
  const [, x, y, k] =
    /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\((-?[\d.]+)\)/.exec(stage.style.transform) ?? [];
  const translated = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(element.style.transform);
  const left = translated ? Number(translated[1]) : Number.parseFloat(element.style.left);
  const top = translated ? Number(translated[2]) : Number.parseFloat(element.style.top);
  return { x: Number(x) + left * Number(k), y: Number(y) + top * Number(k) };
}

const follows = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) &&
  !a.contains(b) &&
  !b.contains(a);

describe('team editor: stacked', () => {
  it('opens settings explicitly from a card and restores focus and selection to that card', async () => {
    renderEditor(team(), true);
    const user = userEvent.setup();
    const card = canvasNode('agent_2');
    await user.click(card);
    await user.click(screen.getByRole('button', { name: 'Open B settings' }));
    expect(within(sheet()).getByDisplayValue('B')).toHaveFocus();
    await user.click(within(sheet()).getByRole('button', { name: m.close }));
    expect(card).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Open B settings' })).toBeVisible();
  });
  it('reads the outline, the palette, the canvas and the chosen step’s settings in that order', () => {
    renderEditor(team(), true);
    expect(layoutOf()).toBe('stacked');
    fireEvent.click(canvasNode('agent_1'));
    // One order for the eye and for Tab.
    const regions = [outline(), palette(), canvas(), sheet()];
    for (let i = 1; i < regions.length; i++)
      expect(follows(regions[i - 1] as Element, regions[i] as Element)).toBe(true);
  });

  it('lays the outline beside the canvas when the host has room, in the same order for Tab', () => {
    renderEditor(team(), false);
    expect(layoutOf()).toBe('beside');
    fireEvent.click(canvasNode('agent_1'));
    const regions = [outline(), palette(), canvas(), sheet()];
    for (let i = 1; i < regions.length; i++)
      expect(follows(regions[i - 1] as Element, regions[i] as Element)).toBe(true);
  });

  it('drops the Agent tile as a default step without opening the picker or adding an Output', () => {
    const before = emptyDraft('drag-agent', 'Drag agent');
    const { editor } = renderEditor(before, true);
    const agent = paletteStep('agent');
    const data = transfer();
    const point = { x: 320, y: 160 };
    drag('dragStart', agent, data);
    drag('dragOver', canvas(), data, point);
    drag('drop', canvas(), data, point);
    drag('dragEnd', agent, data);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(editor.getState().draft).toEqual(
      ok(placeStep(before, 'agent', { kind: 'empty' })).draft,
    );
    expect(editor.getState().draft.definition.nodes.map((node) => node.type)).toEqual(['agent']);
    editor.getState().undo();
    expect(editor.getState().draft).toBe(before);
  });

  it('puts a palette step dropped on the connection between A and B between them', () => {
    const { editor } = renderEditor(team(), true);
    expect(layoutOf()).toBe('stacked');
    const data = transfer();
    const review = paletteStep('review');
    drag('dragStart', review, data);
    expect(data.types).toEqual([STEP_DRAG_TYPE]);
    // While a step is dragged every connection shows where it would go in.
    const insert = within(canvas()).getByRole('button', { name: m.insertHere });
    const at = onScreen(insert);
    drag('dragOver', canvas(), data, at);
    drag('drop', canvas(), data, at);
    drag('dragEnd', review, data);
    const { draft } = editor.getState();
    const added = draft.definition.nodes.find((n) => n.type === 'decision');
    expect(added).toBeTruthy();
    expect(edges(draft)).toContain(`agent_1:out>${added?.id}`);
    expect(edges(draft).some((e) => e.startsWith(`${added?.id}:`) && e.endsWith('>agent_2'))).toBe(
      true,
    );
    expect(edges(draft)).not.toContain('agent_1:out>agent_2');
  });

  it('explains why a step cannot be dropped after an Output without changing history', () => {
    const output = ok(placeStep(team(), 'output', { kind: 'after', nodeId: 'agent_2' }));
    const { editor } = renderEditor(output.draft, true);
    const data = transfer();
    const agent = paletteStep('agent');
    drag('dragStart', agent, data);
    const at = onScreen(canvasNode(output.nodeId));
    const point = { x: at.x + 8, y: at.y + 8 };
    drag('dragOver', canvas(), data, point);
    expect(screen.getByText(m.rejected.noNextStep)).toBeVisible();
    drag('drop', canvas(), data, point);
    drag('dragEnd', agent, data);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(editor.getState().canUndo).toBe(false);
    expect(editor.getState().draft).toBe(output.draft);
  });

  it('moves a step into a Loop after confirming the boundary changes on an outline drop', async () => {
    const draft = team({ loop: true });
    const loopId = draft.definition.nodes.find((n) => n.type === 'loop')?.id as string;
    expect(setParent(draft, 'agent_2', loopId).ok).toBe(true);
    const { editor } = renderEditor(draft, true);
    expect(layoutOf()).toBe('stacked');
    const data = transfer();
    const row = outlineRow('B');
    drag('dragStart', row, data);
    expect(data.types).toEqual(['application/x-corral-node']);
    const target = outlineRow('Loop');
    drag('dragOver', target, data);
    drag('drop', target, data);
    drag('dragEnd', row, data);
    const preview = screen.getByRole('dialog', { name: 'Preview connections' });
    expect(editor.getState().draft).toBe(draft);
    await userEvent.setup().click(within(preview).getByRole('button', { name: 'Apply' }));
    expect(editor.getState().draft.definition.nodes.find((n) => n.id === 'agent_2')?.parentId).toBe(
      loopId,
    );
  });

  it('adds, selects, connects, wraps, moves and deletes without a pointer', async () => {
    const { editor } = renderEditor(team({ loose: true }), true);
    expect(layoutOf()).toBe('stacked');
    const user = userEvent.setup();
    const state = () => editor.getState().draft.definition;
    // Select A on its card, then B with the arrow key.
    await act(async () => canvasNode('agent_1').focus());
    await user.keyboard('{Enter}');
    expect(canvasNode('agent_1').getAttribute('aria-pressed')).toBe('true');
    await user.keyboard('{ArrowRight}');
    expect(canvasNode('agent_2').getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(canvasNode('agent_2'));
    // Connect B to C from the sheet's list.
    await act(async () =>
      within(sheet()).getByRole('combobox', { name: 'Connect out to…' }).focus(),
    );
    await user.keyboard('{Enter}');
    await user.keyboard('{ArrowDown}');
    const option = await screen.findByRole('option', { name: 'C' });
    await act(async () => option.focus());
    await user.keyboard('{Enter}');
    expect(edges(editor.getState().draft)).toContain('agent_2:out>agent_3');
    // Add an output after C from the palette.
    await act(async () => canvasNode('agent_3').focus());
    await user.keyboard('{Enter}');
    await act(async () => paletteStep('output').focus());
    await user.keyboard('{Enter}');
    const output = state().nodes.find((n) => n.type === 'output');
    expect(edges(editor.getState().draft)).toContain(`agent_3:out>${output?.id}`);
    // Wrap B in a Loop, then move C into it, from the command menu.
    await act(async () => canvasNode('agent_2').focus());
    await user.keyboard('{Enter}');
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('Wrap in a Loop');
    await user.keyboard('{Enter}');
    const loop = state().nodes.find((n) => n.type === 'loop');
    expect(state().nodes.find((n) => n.id === 'agent_2')?.parentId).toBe(loop?.id);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async () => canvasNode('agent_3').focus());
    await user.keyboard('{Enter}');
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard(`Move into ${loop?.label}`);
    await user.keyboard('{Enter}');
    const preview = await screen.findByRole('dialog', { name: 'Preview connections' });
    const confirm = within(preview).getByRole('button', { name: 'Apply' });
    await act(async () => confirm.focus());
    await user.keyboard('{Enter}');
    expect(state().nodes.find((n) => n.id === 'agent_3')?.parentId).toBe(loop?.id);
    // Delete the output.
    await act(async () => canvasNode(output?.id as string).focus());
    await user.keyboard('{Enter}');
    await user.keyboard('{Delete}');
    expect(state().nodes.some((n) => n.id === output?.id)).toBe(false);
  });

  it('keeps the selection and the focus when the layout changes, either way', async () => {
    const { layout } = renderEditor(team(), false);
    fireEvent.click(canvasNode('agent_1'));
    const [name] = within(sheet()).getAllByRole('textbox', { name: messages.Inspector.label });
    if (!name) throw new Error('the sheet has no name field');
    await act(async () => name.focus());
    layout(true);
    expect(layoutOf()).toBe('stacked');
    expect(document.activeElement).toBe(name);
    expect(canvasNode('agent_1').getAttribute('aria-pressed')).toBe('true');
    layout(false);
    expect(layoutOf()).toBe('beside');
    expect(document.activeElement).toBe(name);
    // A card keeps the focus as well.
    const card = canvasNode('agent_1');
    await act(async () => card.focus());
    layout(true);
    expect(document.activeElement).toBe(card);
    layout(false);
    expect(document.activeElement).toBe(card);
    expect(card.getAttribute('aria-pressed')).toBe('true');
  });
});

/** The canvas's zoom, from its stage. */
const zoom = () =>
  Number(
    /scale\((-?[\d.]+)\)/.exec(
      (document.querySelector('[data-graph-stage]') as HTMLElement).style.transform,
    )?.[1],
  );
/** A wheel turn over the canvas; whether the canvas took it for itself. */
function wheel(init: WheelEventInit = {}) {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120, ...init });
  act(() => {
    canvas().dispatchEvent(event);
  });
  return event.defaultPrevented;
}
/** A press, a move and a release on the canvas's empty stage. */
function dragStage(dx: number, dy: number) {
  const pointer = (type: string, x: number, y: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
    for (const [key, value] of [
      ['pointerId', 1],
      ['clientX', x],
      ['clientY', y],
    ] as const)
      Object.defineProperty(event, key, { value });
    act(() => {
      canvas().dispatchEvent(event);
    });
  };
  pointer('pointerdown', 10, 10);
  pointer('pointermove', 10 + dx, 10 + dy);
  pointer('pointerup', 10 + dx, 10 + dy);
}
const stageAt = () =>
  (document.querySelector('[data-graph-stage]') as HTMLElement).style.transform.split(' scale')[0];

describe('team editor: the wheel over the canvas', () => {
  it('stacked, a plain wheel is left to the editor to scroll, and Ctrl, ⌘ or a pinch zooms', () => {
    renderEditor(team(), true);
    const before = zoom();
    expect(wheel()).toBe(false);
    expect(zoom()).toBe(before);
    expect(wheel({ ctrlKey: true })).toBe(true);
    expect(zoom()).toBeGreaterThan(before);
    const zoomed = zoom();
    expect(wheel({ metaKey: true })).toBe(true);
    expect(zoom()).toBeGreaterThan(zoomed);
  });

  it('beside, a plain wheel zooms the canvas as before', () => {
    renderEditor(team(), false);
    const before = zoom();
    expect(wheel()).toBe(true);
    expect(zoom()).toBeGreaterThan(before);
  });

  it('stacked, dragging the empty canvas still pans it', () => {
    renderEditor(team(), true);
    const before = stageAt();
    dragStage(40, 30);
    expect(stageAt()).not.toBe(before);
  });
});

describe('team editor: settings opened from outside the canvas', () => {
  /** The editor's own scrolling, watched; jsdom does not scroll. */
  function watchScroll() {
    const root = document.querySelector('[data-graph-scroll]') as HTMLElement;
    const scrollTo = vi.fn();
    root.scrollTo = scrollTo as unknown as typeof root.scrollTo;
    return scrollTo;
  }
  const settingsTop = () => (sheet().parentElement as HTMLElement).offsetTop;
  const problems = () => within(outline()).getByRole('button', { name: /problems?$/ });

  it('stacked, an outline row, the team settings and the problem list bring the settings’ top into view', () => {
    renderEditor(team(), true);
    const scrollTo = watchScroll();
    fireEvent.click(outlineRow('B'));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: settingsTop(), behavior: 'smooth' });
    fireEvent.click(within(outline()).getByRole('button', { name: m.teamSettings }));
    expect(scrollTo).toHaveBeenCalledTimes(2);
    fireEvent.click(problems());
    expect(scrollTo).toHaveBeenCalledTimes(3);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: settingsTop(), behavior: 'smooth' });
    // Closing the problem list from the same button opens nothing to show.
    fireEvent.click(problems());
    expect(scrollTo).toHaveBeenCalledTimes(3);
  });

  it('stacked, a step chosen from the problem list brings its settings’ top into view', () => {
    // A rule after B whose branches lead nowhere: problems on the rule.
    const rule = ok(placeStep(team(), 'rule', { kind: 'after', nodeId: 'agent_2' }));
    renderEditor(rule.draft, true);
    fireEvent.click(problems());
    const scrollTo = watchScroll();
    const item = within(sheet())
      .getAllByRole('button')
      .find((button) => /not connected/.test(button.textContent ?? ''));
    if (!item) throw new Error('the problem list has no item for the rule');
    fireEvent.click(item);
    expect(canvasNode(rule.nodeId).getAttribute('aria-pressed')).toBe('true');
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: settingsTop(), behavior: 'smooth' });
  });

  it('stacked, choosing a card on the canvas leaves the editor where it is', () => {
    renderEditor(team(), true);
    const scrollTo = watchScroll();
    fireEvent.click(canvasNode('agent_1'));
    expect(sheet()).toBeTruthy();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('beside, the settings float in view and nothing scrolls', () => {
    renderEditor(team(), false);
    const scrollTo = watchScroll();
    fireEvent.click(outlineRow('B'));
    fireEvent.click(within(outline()).getByRole('button', { name: m.teamSettings }));
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
