import { RunEvent } from '@corral/contracts';
import type { ExecutionView, RunProjection } from '@corral/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { projectionWith, sessionStore } from '../stories/fixtures.tsx';
import { ApprovalPanel } from './ApprovalPanel.tsx';
import { ContinueDecisions } from './ContinueDecisions.tsx';
import { RequestAreaContext, RequestRunContext } from './RequestCard.tsx';

// Every waiting request in one card grammar (RequestCard.tsx): an approval beside a question with
// a written answer, with options, with several questions, and an extension's prompts.

const execution = (executionId: string): ExecutionView => ({
  executionId,
  nodeId: 'writer',
  taskId: `task_${executionId}`,
  attemptNo: 1,
  parentExecutionId: null,
  previousExecutionId: null,
  depth: 0,
  iterationId: null,
  modelProfile: 'model-a',
  configRevision: 0,
  criteriaVersionId: null,
  status: 'waiting_approval',
  activity: null,
  waitingOn: null,
  modelCallIds: [],
  error: null,
});

const outputApproval: RunProjection['approvals'][string] = {
  approvalId: 'approval_output',
  kind: 'final_output',
  subjectVersionIds: [],
  criteriaVersionId: null,
  status: 'pending',
};

type Prompt =
  | { type: 'user_input.requested'; body: unknown }
  | { type: 'extension.ui_requested'; body: unknown };

/** A run waiting on the given prompts, each from its own execution, beside a final output. */
function store(prompts: Prompt[], approvals = [outputApproval]) {
  const executions: RunProjection['executions'] = {};
  const artifactTexts: Record<string, string> = {};
  const events = prompts.map((prompt, index) => {
    const executionId = `exec_${index}`;
    executions[executionId] = execution(executionId);
    artifactTexts[`body_${index}`] = JSON.stringify(prompt.body);
    return RunEvent.parse({
      schemaVersion: '0.1',
      eventId: `event_${index}`,
      runId: 'run_story',
      runSeq: index + 1,
      recordedAt: '2026-11-09T00:00:00.000Z',
      actor: { kind: 'runtime', id: 'runtime' },
      causedByEventIds: [],
      type: prompt.type,
      payload: {
        requestId: `request_${index}`,
        executionId,
        attemptNo: 1,
        bodyRef: `body_${index}`,
        ...(prompt.type === 'user_input.requested'
          ? { schemaHash: 'b'.repeat(64) }
          : { kind: (prompt.body as { kind: string }).kind, bodyHash: 'b'.repeat(64) }),
        deadline: '2099-11-09T00:01:00.000Z',
      },
    });
  });
  return sessionStore({
    runId: 'run_story',
    projection: projectionWith({
      status: 'awaiting_user',
      executions,
      executionOrder: Object.keys(executions),
      approvals: Object.fromEntries(approvals.map((a) => [a.approvalId, a])),
    }),
    events,
    artifactTexts,
    sendCommand: fn(async () => ({ status: 'applied' }) as never),
  });
}

const written: Prompt = {
  type: 'user_input.requested',
  body: {
    key: 'layout',
    questions: [{ id: 'layout', kind: 'text', prompt: 'Which layout should I keep?' }],
  },
};

const meta = {
  title: 'Run/Request cards',
  component: ApprovalPanel,
  args: { session: store([written]), onOpenArtifact: fn(), showPlan: false, headed: false },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 720 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ApprovalPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Two cards, one frame: the same head, body and answer row for a question and an approval. */
async function sameFrame(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const approval = await canvas.findByTestId('approval-approval_output');
  const heads = canvasElement.querySelectorAll('[data-request-head]');
  const feet = canvasElement.querySelectorAll('[data-request-foot]');
  await expect(heads.length).toBeGreaterThanOrEqual(2);
  for (const head of heads)
    await expect(head.className).toBe(approval.querySelector('[data-request-head]')?.className);
  for (const foot of feet)
    await expect(foot.className).toBe(approval.querySelector('[data-request-foot]')?.className);
}

/** A question with a written answer: Send answer waits for the words. */
export const WrittenAnswer: Story = {
  play: async ({ canvasElement }) => {
    await sameFrame(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Which layout should I keep?')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Send answer' })).toBeDisabled();
  },
};

/** One option of several, and several options at once. */
export const Options: Story = {
  args: {
    session: store([
      {
        type: 'user_input.requested',
        body: {
          key: 'format',
          questions: [
            {
              id: 'format',
              kind: 'single',
              prompt: 'Which format should the report use?',
              options: [
                { id: 'table', label: 'A table', recommended: true },
                { id: 'list', label: 'A list', description: 'One line per finding' },
              ],
            },
          ],
        },
      },
      {
        type: 'user_input.requested',
        body: {
          key: 'parts',
          questions: [
            {
              id: 'parts',
              kind: 'multiple',
              prompt: 'Which parts should it cover?',
              options: [
                { id: 'auth', label: 'Sign-in' },
                { id: 'billing', label: 'Billing' },
                { id: 'search', label: 'Search' },
              ],
              allowFreeText: true,
            },
          ],
        },
      },
    ]),
  },
  play: async ({ canvasElement }) => sameFrame(canvasElement),
};

/** Several questions, one step at a time, with the step count under the title. */
export const Steps: Story = {
  args: {
    session: store([
      {
        type: 'user_input.requested',
        body: {
          key: 'release',
          questions: [
            { id: 'name', kind: 'text', prompt: 'What should the release be called?' },
            {
              id: 'when',
              kind: 'single',
              prompt: 'When should it go out?',
              options: [
                { id: 'now', label: 'Now' },
                { id: 'monday', label: 'Monday' },
              ],
            },
          ],
        },
      },
    ]),
  },
  play: async ({ canvasElement }) => {
    await sameFrame(canvasElement);
    await expect(within(canvasElement).getByText(/Question 1\/2/)).toBeVisible();
  },
};

/** An extension's confirm, choice and input prompts. */
export const ExtensionPrompts: Story = {
  args: {
    session: store([
      {
        type: 'extension.ui_requested',
        body: {
          kind: 'confirm',
          title: 'Publish the draft?',
          message: 'It goes to the team page.',
        },
      },
      {
        type: 'extension.ui_requested',
        body: { kind: 'select', title: 'Pick a channel', options: ['General', 'Releases'] },
      },
      {
        type: 'extension.ui_requested',
        body: { kind: 'input', title: 'Name the build', placeholder: 'nightly' },
      },
    ]),
  },
  play: async ({ canvasElement }) => sameFrame(canvasElement),
};

/**
 * Two runs waiting in one place, as a conversation's tray holds them: each area is named by its
 * run, and inside it every card by its own title, so no two landmarks share a name.
 */
export const SeveralRuns: Story = {
  render: (args) => (
    <div className="flex flex-col gap-3">
      {(['Run #1', 'Run #2'] as const).map((run, index) => (
        <section key={run} aria-label={`${run} · Waiting for you`}>
          <RequestRunContext.Provider value={run}>
            <RequestAreaContext.Provider value={true}>
              <ApprovalPanel
                {...args}
                session={index === 0 ? store([written]) : store([written], [outputApproval])}
              />
            </RequestAreaContext.Provider>
          </RequestRunContext.Provider>
        </section>
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('region', { name: 'Run #1 · Waiting for you' })).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'Run #2 · Waiting for you' })).toBeVisible();
    await expect(canvas.queryAllByRole('region', { name: 'Waiting for you' })).toHaveLength(0);
    await expect(canvas.queryAllByRole('article', { name: 'Waiting for you' })).toHaveLength(0);
  },
};

const limitApproval = (approvalId: string): RunProjection['approvals'][string] => ({
  approvalId,
  kind: 'user_action',
  subjectVersionIds: [],
  criteriaVersionId: null,
  status: 'pending',
  limit: { kind: 'loop_iterations', used: 3, max: 3 },
});

/**
 * Two runs at their limits in one place: each continue-or-stop stack is named by its run as well,
 * so the two stacks are told apart.
 */
export const SeveralRunsAtLimits: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      {(['Run #1', 'Run #2'] as const).map((run, index) => (
        <section key={run} aria-label={`${run} · Waiting for you`}>
          <RequestRunContext.Provider value={run}>
            <RequestAreaContext.Provider value={true}>
              <ContinueDecisions session={store([], [limitApproval(`limit_${index}`)])} />
            </RequestAreaContext.Provider>
          </RequestRunContext.Provider>
        </section>
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('region', { name: 'Run #1 · Continue or stop' }),
    ).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'Run #2 · Continue or stop' })).toBeVisible();
    await expect(canvas.queryAllByRole('region', { name: 'Continue or stop' })).toHaveLength(0);
    // The stacks fade in on springs; the a11y check runs after play, once nothing still fades.
    await waitFor(
      () => {
        for (const element of canvasElement.querySelectorAll('*'))
          expect(getComputedStyle(element).opacity).toBe('1');
      },
      { timeout: 3000 },
    );
  },
};
