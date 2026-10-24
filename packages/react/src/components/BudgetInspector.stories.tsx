import { linearCorral } from '@corral/testkit';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { projectionWith, sessionStore } from '../stories/fixtures.tsx';
import { BudgetInspector } from './BudgetInspector.tsx';

const definition = linearCorral(['writer']);
const meta = {
  title: 'Run/BudgetInspector',
  component: BudgetInspector,
  decorators: [(Story) => <div className="w-88">{Story()}</div>],
} satisfies Meta<typeof BudgetInspector>;
export default meta;
type Story = StoryObj<typeof meta>;

export const UnknownUsage: Story = {
  args: {
    session: sessionStore({
      runId: 'run_story',
      definition,
      projection: projectionWith({
        budget: {
          spent: 100,
          reserved: 200,
          unknownOutstanding: 300,
          modelCalls: 3,
          reservations: {
            known: {
              modelCallId: 'call_known',
              scope: 'run',
              reserved: 200,
              actual: 100,
              status: 'settled',
            },
            pending: {
              modelCallId: 'call_pending',
              scope: 'run',
              reserved: 200,
              actual: null,
              status: 'reserved',
            },
            unknown: {
              modelCallId: 'call_unknown',
              scope: 'run',
              reserved: 300,
              actual: null,
              status: 'unknown',
            },
          },
        },
      }),
    }),
  },
  play: async ({ canvasElement, userEvent }) => {
    // [TC-UX-001-N] Unknown usage retains its reservation and remains visibly unknown.
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Usage by request' }));
    expect(canvas.getByTestId('budget-call-call_unknown')).toHaveTextContent('300');
    expect(canvas.getByTestId('budget-call-call_unknown')).toHaveTextContent(/unknown/i);
    expect(canvas.getByTestId('budget-call-call_known')).toHaveTextContent('100');
  },
};

export const UnlimitedImageUsage: Story = {
  args: {
    session: sessionStore({
      runId: 'run_story',
      definition,
      projection: projectionWith({
        usageLimits: 'none',
        budget: {
          spent: 100,
          reserved: 0,
          unknownOutstanding: 0,
          modelCalls: 2,
          reservations: {},
          imageSpentMicros: 0,
          imageUnknownOutstandingMicros: 200000,
        },
      }),
    }),
  },
  play: async ({ canvasElement }) => {
    // [TC-LLM-005-N] Unlimited text usage does not hide unconfirmed image charges.
    const canvas = within(canvasElement);
    expect(canvas.queryAllByRole('meter')).toHaveLength(0);
    expect(canvas.getByText('$0.20')).toBeVisible();
    expect(canvas.getByText(/No default usage limits/)).toBeVisible();
  },
};

export const CallsOnlyBudget: Story = {
  args: {
    session: sessionStore({
      runId: 'run_story',
      definition,
      projection: projectionWith({
        limits: {
          ...definition.limits,
          maxModelCalls: 20,
          maxOutputTokens: Number.MAX_SAFE_INTEGER,
        },
      }),
    }),
  },
  play: async ({ canvasElement }) => {
    // [TC-LLM-005-N] A calls-only budget does not imply a token ceiling.
    expect(within(canvasElement).getAllByRole('meter')).toHaveLength(1);
    expect(canvasElement.textContent).not.toContain(String(Number.MAX_SAFE_INTEGER));
  },
};
