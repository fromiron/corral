import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { IntlProvider } from 'use-intl';
import { Button, Tooltip } from '../design-kit/index.ts';
import messages from '../messages/en.json' with { type: 'json' };
import koMessages from '../messages/ko.json' with { type: 'json' };
import { TermHint, TermTooltip } from './TermHint.tsx';

// A coined name's explanation (features/term-hints.md): the info icon after a title, its open
// explanation, and the same words in a control's tooltip.

const meta: Meta = { title: 'Terms/Term hint' };
export default meta;
type Story = StoryObj;

/** The same title twice, with and without the icon, each over a row: the icon adds no height. */
function Titles({ withHint = true }: { withHint?: boolean }) {
  const title = (hint: ReactNode, id: string) => (
    <section data-titles={id} className="flex flex-col gap-2">
      <h2 data-title="" className="m-0 flex items-center gap-1 text-subtitle font-semibold">
        {messages.Terms.corral.name}
        {hint}
      </h2>
      <p data-below="" className="m-0 text-body text-muted-foreground">
        Release review · 3 roles
      </p>
    </section>
  );
  return (
    <div className="flex w-[420px] gap-8">
      {title(withHint ? <TermHint term="corral" /> : null, 'with')}
      {title(null, 'without')}
    </div>
  );
}

const box = (element: Element | null | undefined) => element?.getBoundingClientRect();

export const InTitle: Story = {
  render: () => <Titles />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const [withHint, without] = ['with', 'without'].map((id) =>
      canvasElement.querySelector(`[data-titles="${id}"]`),
    );
    // The icon stands on the name's line without making it taller or moving the row below.
    await expect(box(withHint?.querySelector('[data-title]'))?.height).toBe(
      box(without?.querySelector('[data-title]'))?.height,
    );
    await expect(box(withHint?.querySelector('[data-below]'))?.top).toBe(
      box(without?.querySelector('[data-below]'))?.top,
    );
    const icon = canvas.getByRole('button', { name: 'About Corral' });
    const target = box(icon);
    await expect(target?.width).toBeGreaterThanOrEqual(24);
    await expect(target?.height).toBeGreaterThanOrEqual(24);
    // A resting pointer opens it, and the pointer may move onto the explanation.
    const below = box(withHint?.querySelector('[data-below]'));
    await userEvent.hover(icon);
    const meaning = () =>
      document.querySelector('[data-term-popup] [data-term-meaning]') as HTMLElement | null;
    await waitFor(() => expect(meaning()).toBeVisible());
    await expect(box(withHint?.querySelector('[data-below]'))?.top).toBe(below?.top);
    await userEvent.hover(meaning() as HTMLElement);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await expect(meaning()).toBeVisible();
    // Leaving both closes it.
    await userEvent.unhover(meaning() as HTMLElement);
    await userEvent.hover(canvas.getAllByText('Release review · 3 roles')[1] as HTMLElement);
    await waitFor(() => expect(meaning()).toBeNull());
    // Focus opens it; Escape closes it and the focus stays on the icon.
    await userEvent.tab();
    await expect(icon).toHaveFocus();
    await waitFor(() => expect(meaning()).toBeVisible());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(meaning()).toBeNull());
    await expect(icon).toHaveFocus();
  },
};

/** Opened by a press, as on a touch screen; a press outside closes it. */
export const Open: Story = {
  render: () => <Titles />,
  play: async ({ canvasElement }) => {
    const icon = within(canvasElement).getByRole('button', { name: 'About Corral' });
    await userEvent.click(icon);
    await waitFor(() =>
      expect(document.querySelector('[data-term-popup] [data-term-meaning]')).toHaveTextContent(
        messages.Terms.corral.meaning,
      ),
    );
  },
};

export const OpenKorean: Story = {
  render: () => (
    <IntlProvider locale="ko" messages={koMessages} timeZone="UTC">
      <div className="flex w-[420px] flex-col gap-2">
        <h2 className="m-0 flex items-center gap-1 text-subtitle font-semibold">
          {koMessages.Terms.corral.name}
          <TermHint term="corral" />
        </h2>
        <p className="m-0 text-body text-muted-foreground">릴리스 검토 · 역할 3개</p>
      </div>
    </IntlProvider>
  ),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Corral 설명' }));
    await waitFor(() =>
      expect(document.querySelector('[data-term-popup] [data-term-meaning]')).toHaveTextContent(
        koMessages.Terms.corral.meaning,
      ),
    );
  },
};

/** A tool line control whose tooltip already says its name: no icon, the sentence under it. */
export const InTooltip: Story = {
  render: () => (
    <div className="flex items-center gap-1 pt-16">
      <TermTooltip term="outrider">
        <Button variant="ghost" size="compact" aria-label={messages.Terms.outrider.name}>
          {messages.Terms.outrider.name}
        </Button>
      </TermTooltip>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const control = canvas.getByRole('button', { name: messages.Terms.outrider.name });
    await expect(canvas.getAllByRole('button')).toHaveLength(1);
    await userEvent.hover(control);
    await waitFor(() =>
      expect(document.querySelector('[role="tooltip"] [data-term-meaning]')).toHaveTextContent(
        messages.Terms.outrider.meaning,
      ),
    );
    // Both lines sit inside the tooltip's box.
    const tip = box(document.querySelector('[role="tooltip"]'));
    const meaning = box(document.querySelector('[role="tooltip"] [data-term-meaning]'));
    await expect(meaning?.bottom).toBeLessThanOrEqual(tip?.bottom ?? 0);
    // The kit's fade ends before the accessibility check reads the colors.
    await new Promise((resolve) => setTimeout(resolve, 500));
  },
};

/** What a surface looks like: the parts both forms must share. */
const surface = (element: Element | null) => {
  if (!element) return null;
  const style = getComputedStyle(element);
  return {
    background: style.backgroundColor,
    color: style.color,
    radius: style.borderTopLeftRadius,
    padding: `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`,
    shadow: style.boxShadow,
    font: `${style.fontSize}/${style.lineHeight}`,
  };
};

/** The icon's explanation and a control's tooltip stand on one surface. */
export const SameSurface: Story = {
  render: () => (
    <div className="flex items-center gap-8 pt-24">
      <h2 className="m-0 flex items-center gap-1 text-subtitle font-semibold">
        {messages.Terms.corral.name}
        <TermHint term="corral" />
      </h2>
      <TermTooltip term="outrider">
        <Button variant="ghost" size="compact" aria-label={messages.Terms.outrider.name}>
          {messages.Terms.outrider.name}
        </Button>
      </TermTooltip>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'About Corral' }));
    const popup = () => document.querySelector('[data-term-popup]');
    await waitFor(() => expect(popup()).toBeVisible());
    await new Promise((resolve) => setTimeout(resolve, 500));
    const icon = surface(popup());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(popup()).toBeNull());
    await userEvent.hover(canvas.getByRole('button', { name: messages.Terms.outrider.name }));
    const meaning = () => document.querySelector('[role="tooltip"] [data-term-meaning]');
    await waitFor(() => expect(meaning()).toBeVisible());
    await new Promise((resolve) => setTimeout(resolve, 500));
    // The kit tooltip draws its surface on the element its words sit in.
    const tip = surface(meaning()?.parentElement?.parentElement ?? null);
    await expect(icon).not.toBeNull();
    await expect(icon).toEqual(tip);
  },
};

/** A tooltip of words alone keeps every line inside it; one line stays one line high. */
export const KitTooltipLines: Story = {
  render: () => (
    <div className="flex items-center gap-8 pt-24">
      <Tooltip content="Archive">
        <Button variant="ghost" size="compact">
          One
        </Button>
      </Tooltip>
      <Tooltip
        content="Folders this project may read and write; anything else needs your approval."
        className="max-w-xs"
      >
        <Button variant="ghost" size="compact">
          Two
        </Button>
      </Tooltip>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const open = async (name: string) => {
      await userEvent.hover(canvas.getByRole('button', { name }));
      await waitFor(() => expect(document.querySelector('[role="tooltip"]')).toBeVisible());
      await new Promise((resolve) => setTimeout(resolve, 500));
      const tip = document.querySelector('[role="tooltip"]') as HTMLElement;
      const inner = tip.firstElementChild as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(inner);
      const words = [...range.getClientRects()];
      const result = { box: inner.getBoundingClientRect(), words };
      await userEvent.unhover(canvas.getByRole('button', { name }));
      await waitFor(() => expect(document.querySelector('[role="tooltip"]')).toBeNull());
      return result;
    };
    const one = await open('One');
    // One line, at the kit's ~24px.
    await expect(Math.round(one.box.height)).toBeLessThanOrEqual(25);
    const two = await open('Two');
    await expect(two.box.height).toBeGreaterThan(one.box.height + 8);
    for (const line of two.words) await expect(line.bottom).toBeLessThanOrEqual(two.box.bottom);
  },
};

/** A title with its icon between two other controls, as the icon sits in a real screen. */
function Between() {
  return (
    <div className="flex w-[420px] flex-col gap-3">
      <Button variant="ghost" size="compact">
        Before
      </Button>
      <h2 className="m-0 flex items-center gap-1 text-subtitle font-semibold">
        {messages.Terms.corral.name}
        <TermHint term="corral" />
      </h2>
      <p data-below="" className="m-0 text-body text-muted-foreground">
        Release review · 3 roles
      </p>
      <Button variant="ghost" size="compact">
        After
      </Button>
    </div>
  );
}

const hintPopup = () => document.querySelector('[data-term-popup]');
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Opened by focus, Tab and Shift+Tab go straight on to the next control and close it. */
export const KeyboardAround: Story = {
  render: () => <Between />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const icon = canvas.getByRole('button', { name: 'About Corral' });
    const before = canvas.getByRole('button', { name: 'Before' });
    const after = canvas.getByRole('button', { name: 'After' });
    before.focus();
    await userEvent.tab();
    await expect(icon).toHaveFocus();
    await waitFor(() => expect(hintPopup()).not.toBeNull());
    // One Tab: on to the next control, and the explanation closes.
    await userEvent.tab();
    await expect(after).toHaveFocus();
    await waitFor(() => expect(hintPopup()).toBeNull());
    // Back with one Shift+Tab, which opens it by focus again.
    await userEvent.tab({ shift: true });
    await expect(icon).toHaveFocus();
    await waitFor(() => expect(hintPopup()).not.toBeNull());
    // One Shift+Tab: on to the control before, and it closes.
    await userEvent.tab({ shift: true });
    await expect(before).toHaveFocus();
    await waitFor(() => expect(hintPopup()).toBeNull());
  },
};

/** Opened by focus, it stays while the focus does, though a pointer passes over and away. */
export const FocusOutlastsPointer: Story = {
  render: () => <Between />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const icon = canvas.getByRole('button', { name: 'About Corral' });
    canvas.getByRole('button', { name: 'Before' }).focus();
    await userEvent.tab();
    await waitFor(() => expect(hintPopup()).not.toBeNull());
    await userEvent.hover(icon);
    await pause(300);
    await userEvent.unhover(icon);
    await userEvent.hover(canvas.getByText('Release review · 3 roles'));
    await pause(600);
    await expect(icon).toHaveFocus();
    await expect(hintPopup()).not.toBeNull();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(hintPopup()).toBeNull());
  },
};

/** Pressing an icon that already has the focus leaves nothing behind: focus opens it again. */
export const PressThenTabBack: Story = {
  render: () => <Between />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const icon = canvas.getByRole('button', { name: 'About Corral' });
    await userEvent.click(icon);
    await waitFor(() => expect(hintPopup()).not.toBeNull());
    await userEvent.click(icon);
    await waitFor(() => expect(hintPopup()).toBeNull());
    await expect(icon).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'After' })).toHaveFocus();
    await userEvent.tab({ shift: true });
    await expect(icon).toHaveFocus();
    await waitFor(() => expect(hintPopup()).not.toBeNull());
    await userEvent.keyboard('{Escape}');
  },
};

/** Closed by a press on something that takes no focus, it stays closed. */
export const PressOutsideStaysClosed: Story = {
  render: () => <Between />,
  play: async ({ canvasElement }) => {
    const icon = within(canvasElement).getByRole('button', { name: 'About Corral' });
    await userEvent.click(icon);
    await waitFor(() => expect(hintPopup()).not.toBeNull());
    await userEvent.click(canvasElement.querySelector('[data-below]') as HTMLElement);
    const samples: number[] = [];
    for (let i = 0; i < 6; i++) {
      await pause(150);
      samples.push(hintPopup() ? 1 : 0);
    }
    await expect(samples.join('')).toBe('000000');
  },
};

/** A press dragged off the icon makes no click; it leaves nothing behind either. */
export const DragOffThenTabBack: Story = {
  render: () => <Between />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const icon = canvas.getByRole('button', { name: 'About Corral' });
    const below = canvas.getByText('Release review · 3 roles');
    await userEvent.pointer([
      { keys: '[MouseLeft>]', target: icon },
      { target: below },
      { keys: '[/MouseLeft]', target: below },
    ]);
    await expect(icon).toHaveFocus();
    await pause(300);
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'After' })).toHaveFocus();
    await userEvent.tab({ shift: true });
    await expect(icon).toHaveFocus();
    await waitFor(() => expect(hintPopup()).not.toBeNull());
    await userEvent.keyboard('{Escape}');
  },
};

/** Opened by focus, the focus going nowhere (a script's blur) closes it. */
export const FocusLeavesForNowhere: Story = {
  render: () => <Between />,
  play: async ({ canvasElement }) => {
    const icon = within(canvasElement).getByRole('button', { name: 'About Corral' });
    icon.focus();
    await waitFor(() => expect(hintPopup()).not.toBeNull());
    icon.blur();
    await waitFor(() => expect(hintPopup()).toBeNull());
  },
};

/** Opened by focus, the focus moving into the explanation keeps it open. */
export const FocusIntoExplanation: Story = {
  render: () => <Between />,
  play: async ({ canvasElement }) => {
    const icon = within(canvasElement).getByRole('button', { name: 'About Corral' });
    icon.focus();
    await waitFor(() => expect(hintPopup()).not.toBeNull());
    (hintPopup() as HTMLElement).focus();
    await pause(400);
    await expect(hintPopup()).not.toBeNull();
    await userEvent.keyboard('{Escape}');
  },
};
