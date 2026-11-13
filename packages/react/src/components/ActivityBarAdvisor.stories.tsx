import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useState } from 'react';
import { expect, fn, waitFor, within } from 'storybook/test';
import { IntlProvider } from 'use-intl';
import { Elevated } from '../design-kit/index.ts';
import en from '../messages/en.json' with { type: 'json' };
import ko from '../messages/ko.json' with { type: 'json' };
import { ActivityBar, type ActivityBarProps, type ActivityBarRole } from './ActivityBar.tsx';

// The activity bar's advisor row (features/advisor.md "보이는 곳", features/composer-flow.md "활동
// 바"), as the composer gives it: after the roles, watching or reviewing and how many advice
// reached their targets; no Join; View opens its execution in the run record. Once the roles have
// ended, the closed line says the advisor's last review.

async function settled(canvasElement: HTMLElement) {
  await waitFor(
    () => {
      for (const el of canvasElement.querySelectorAll('*')) {
        if (el.closest('[hidden]')) continue;
        expect(getComputedStyle(el).opacity).toBe('1');
      }
    },
    { timeout: 3000 },
  );
}

function Card({ locale = 'en', ...props }: ActivityBarProps & { locale?: 'en' | 'ko' }) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const bar: ReactNode = (
    <div className="mx-auto w-full max-w-[720px]">
      <Elevated offset={2} className="rounded-[var(--shape-panel-radius)] p-1">
        <ActivityBar {...props} open={open} onOpenChange={setOpen} />
        <div className="px-2.5 py-2 text-ui text-muted-foreground">
          {locale === 'ko' ? '다음 변경을 요청…' : 'Ask for the next change…'}
        </div>
      </Elevated>
    </div>
  );
  return locale === 'ko' ? (
    <IntlProvider locale="ko" messages={ko} timeZone="UTC">
      {bar}
    </IntlProvider>
  ) : (
    <IntlProvider locale="en" messages={en} timeZone="UTC">
      {bar}
    </IntlProvider>
  );
}

const lead = (name: string, activity: string, working = 'Working'): ActivityBarRole => ({
  id: 'exec_lead',
  name,
  glyph: 'running',
  tone: 'active',
  state: { text: working, target: 'execution:exec_lead' },
  stateShown: true,
  working: true,
  activity,
  target: true,
  onShow: fn(),
});

const advisor = (change: Partial<ActivityBarRole>): ActivityBarRole => ({
  id: 'exec_advisor',
  name: 'Advisor',
  glyph: 'running',
  tone: 'active',
  stateShown: true,
  target: false,
  onShow: fn(),
  ...change,
});

const controls = { paused: false, onPause: fn(), onStop: fn() };

const meta = {
  title: 'Components/ActivityBar/Advisor',
  component: Card,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The panel open: the implementer at work, the advisor watching with one advice delivered. */
export const Watching: Story = {
  args: {
    defaultOpen: true,
    line: { glyph: 'running', tone: 'active', text: 'Edit file · src/session.ts' },
    roles: [
      lead('Implementer', 'Edit file · src/session.ts'),
      advisor({
        state: { text: 'Watching', target: 'execution:exec_advisor' },
        activity: '1 piece of advice delivered',
      }),
    ],
    controls,
  },
  play: async ({ canvasElement }) => {
    const row = canvasElement.querySelector('[data-activity-role="exec_advisor"]') as HTMLElement;
    // No Join: an advisor takes no instruction.
    await expect(within(row).queryByRole('button', { name: /Join/ })).toBeNull();
    await settled(canvasElement);
  },
};

/** An advisor that failed: its row says so, and the line raises no warning; the run goes on. */
export const Failed: Story = {
  args: {
    defaultOpen: true,
    line: { glyph: 'running', tone: 'active', text: 'Edit file · src/session.ts' },
    roles: [
      lead('Implementer', 'Edit file · src/session.ts'),
      advisor({
        name: 'Reviewer',
        glyph: 'failed',
        tone: 'danger',
        state: { text: 'Failed', target: 'execution:exec_advisor' },
      }),
    ],
    controls,
  },
  play: async ({ canvasElement }) => {
    await settled(canvasElement);
  },
};

/** 한국어: 역할이 모두 끝나고 감독의 마지막 검토만 남은 닫힌 줄. */
export const FinalReviewKo: Story = {
  args: {
    locale: 'ko',
    line: { glyph: 'running', tone: 'active', text: '감독: 마지막 검토' },
    roles: [
      advisor({
        name: '감독',
        state: { text: '검토 중', target: 'execution:exec_advisor' },
        activity: '조언 1건 전달',
      }),
    ],
    controls,
  },
  play: async ({ canvasElement }) => {
    // The closed line names the advisor once; its row is in the folded panel.
    const line = canvasElement.querySelector('[data-activity-bar] > div');
    await expect(line?.textContent?.split('감독').length).toBe(2);
    await settled(canvasElement);
  },
};

/** 한국어: 펼친 곳. 역할 뒤에 감독이 검토 중, 전달된 조언 2건. */
export const ReviewingKo: Story = {
  args: {
    locale: 'ko',
    defaultOpen: true,
    line: { glyph: 'running', tone: 'active', text: '파일 편집 · src/session.ts' },
    roles: [
      lead('구현자', '파일 편집 · src/session.ts', '작업 중'),
      advisor({
        name: '감독',
        state: { text: '검토 중', target: 'execution:exec_advisor' },
        activity: '조언 2건 전달',
      }),
    ],
    controls,
  },
  play: async ({ canvasElement }) => {
    await settled(canvasElement);
  },
};
