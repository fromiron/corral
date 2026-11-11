import type { Receipt } from '@corral/contracts';
import type { RuntimeTransport } from '@corral/core';
import { emptyProjection, toolPermissionPlan } from '@corral/core';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalPanel } from '../src/components/ApprovalPanel.tsx';
import en from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };
import { createRunSession } from '../src/run/session.ts';
import { projectionWith, sessionStore } from '../src/stories/fixtures.tsx';

// A tool permission card offers one main decision, "Allow once", beside "Allow for this run";
// the tool rules of later runs are a way out of the card, not a decision. What was decided is
// said in words, with no internal ids.

const RAW_ID = /(?:artv|crit|exec|call|appr)_[A-Za-z0-9]/;

const permission = toolPermissionPlan(
  { snapshotHash: 'c'.repeat(64), policyRevision: 2 },
  {
    name: 'run_command',
    source: 'corral',
    schemaHash: 'd'.repeat(64),
    exposure: 'direct',
    sideEffect: 'external',
  },
  {
    operationId: 'command_1',
    hostId: 'local',
    sessionId: 'session_1',
    workspaceBindingId: 'binding_1',
    worktreeId: 'worktree_1',
    rootIdentity: 'a'.repeat(64),
    tree: 'b'.repeat(40),
    shellId: 'bash',
    command: 'npm test',
    executable: 'bash',
    argv: ['-lc', 'npm test'],
    cwd: '.',
    environmentHash: 'c'.repeat(64),
    timeoutMs: 120000,
    mode: 'foreground',
    fingerprint: 'd'.repeat(64),
    request: { command: 'npm test', mode: 'foreground' },
  },
);

const approval = (
  approvalId: string,
  status: 'pending' | 'approved',
  bodyRef: string,
  scope?: 'once' | 'run',
) => ({
  approvalId,
  kind: 'user_action' as const,
  subjectVersionIds: [bodyRef],
  criteriaVersionId: null,
  status,
  ...(scope ? { scope } : {}),
  tool: {
    purpose: 'tool' as const,
    executionId: 'exec_0001',
    attemptNo: 1,
    toolCallId: `call_${approvalId}`,
    bodyRef,
    fingerprint: permission.fingerprint,
    deadline: '2099-10-18T00:00:00.000Z',
  },
});

function show(
  approvals: Record<string, ReturnType<typeof approval>>,
  locale: 'en' | 'ko' = 'en',
  resolveApproval = vi.fn(async () => ({ status: 'applied' }) as Receipt),
) {
  const texts = Object.fromEntries(
    Object.values(approvals).map((a) => [a.tool.bodyRef, JSON.stringify(permission)]),
  );
  const session = sessionStore({
    projection: projectionWith({ status: 'awaiting_user', approvals: approvals as never }),
    artifactTexts: texts,
    resolveApproval,
  });
  const view = render(
    <IntlProvider locale={locale} messages={locale === 'ko' ? ko : en} timeZone="UTC">
      <ApprovalPanel
        session={session}
        onOpenArtifact={() => {}}
        headed={false}
        policySettingsAction={<a href="/settings/harness">{en.Run.permissionSettings}</a>}
      />
    </IntlProvider>,
  );
  return { ...view, resolveApproval };
}

/** Text a person sees: collapsed details are left out. */
function visibleText(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll('[hidden], .sr-only')) hidden.remove();
  return clone.textContent ?? '';
}

describe('a tool permission card', () => {
  it.each([
    ['Deny', ['approval_tool', 'reject']],
    ['Allow once', ['approval_tool', 'approve']],
    ['Allow for this run', ['approval_tool', 'approve', { scope: 'run' }]],
  ] as const)('%s sends the matching decision and scope', async (name, call) => {
    const { resolveApproval } = show({
      approval_tool: approval('approval_tool', 'pending', 'tool_body'),
    });
    const button = screen.getByRole('button', { name });
    await vi.waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await vi.waitFor(() => expect(resolveApproval).toHaveBeenCalledWith(...call));
    expect(resolveApproval).toHaveBeenCalledTimes(1);
  });

  it('keeps one main decision, the run-wide one beside it, and the rules as a way out', async () => {
    const { container } = show({
      approval_tool: approval('approval_tool', 'pending', 'tool_body'),
    });
    const card = screen.getByTestId('approval-approval_tool');
    await vi.waitFor(() =>
      expect(within(card).getByRole('button', { name: 'Allow once' })).toBeEnabled(),
    );
    const decisions = [...card.querySelectorAll<HTMLElement>('[data-approval-action]')];
    expect(decisions.map((button) => [button.textContent, button.dataset.approvalAction])).toEqual([
      ['Deny', 'decline'],
      ['Allow for this run', 'run'],
      ['Allow once', 'primary'],
    ]);
    // The rules of later runs stay reachable from the card, outside its decisions.
    expect(within(card).getByRole('link', { name: en.Run.permissionSettings })).toBeVisible();
    // The buttons say the reach of each decision; the card repeats it nowhere.
    expect(card.textContent).not.toContain(en.Approvals.toolOnce);
    expect(visibleText(container)).not.toMatch(RAW_ID);
  });

  it('the run-wide decision waits for the verified call like the main one', async () => {
    const session = sessionStore({
      projection: projectionWith({
        status: 'awaiting_user',
        approvals: { approval_tool: approval('approval_tool', 'pending', 'tool_body') } as never,
      }),
      artifactTexts: {
        tool_body: JSON.stringify({ ...permission, arguments: { command: 'something else' } }),
      },
    });
    render(
      <IntlProvider locale="en" messages={en} timeZone="UTC">
        <ApprovalPanel session={session} onOpenArtifact={() => {}} />
      </IntlProvider>,
    );
    await vi.waitFor(() => expect(screen.getByRole('alert')).toBeVisible());
    expect(screen.getByRole('button', { name: 'Allow for this run' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeDisabled();
  });

  it.each(['en', 'ko'] as const)(
    'a call allowed for the run says so in its result line (%s)',
    async (locale) => {
      const messages = locale === 'ko' ? ko : en;
      const { container } = show(
        {
          appr_run: approval('appr_run', 'approved', 'artv_0007', 'run'),
          appr_once: approval('appr_once', 'approved', 'artv_0008', 'once'),
          appr_next: approval('appr_next', 'pending', 'artv_0009'),
        },
        locale,
      );
      const call = `${messages.Turn.tool.run_command} · npm test`;
      await vi.waitFor(() =>
        expect(screen.getByTestId('approved-appr_run').textContent).toBe(
          messages.Approvals.doneToolRun.replace('{call}', call),
        ),
      );
      expect(screen.getByTestId('approved-appr_once').textContent).toBe(
        messages.Approvals.doneTool.replace('{call}', call),
      );
      expect(visibleText(container)).not.toMatch(RAW_ID);
    },
  );

  it('names the decisions in Korean', async () => {
    show({ approval_tool: approval('approval_tool', 'pending', 'tool_body') }, 'ko');
    expect(screen.getByRole('button', { name: '이번만 허용' })).toBeVisible();
    expect(screen.getByRole('button', { name: '이 실행 동안 허용' })).toBeVisible();
  });
});

describe('the run session', () => {
  it('sends the scope of a decision with resolve_approval, and none when it is not given', async () => {
    const sendCommand = vi.fn(
      async (command: { commandId: string; runId: string }) =>
        ({
          commandId: command.commandId,
          runId: command.runId,
          status: 'applied',
          target: 'approval:approval_tool',
          acceptedSeq: 1,
          requestedBoundary: 'immediate',
          relatedEventIds: [],
        }) as Receipt,
    );
    const session = createRunSession({ sendCommand } as unknown as RuntimeTransport);
    const projection = emptyProjection('run_1');
    projection.approvals = { approval_tool: approval('approval_tool', 'pending', 'tool_body') };
    projection.controlRevision = 3;
    session.setState({ runId: 'run_1', projection });
    await session.getState().resolveApproval('approval_tool', 'approve', { scope: 'run' });
    await session.getState().resolveApproval('approval_tool', 'approve');
    expect(sendCommand.mock.calls.map(([command]) => command)).toEqual([
      expect.objectContaining({
        type: 'resolve_approval',
        expectedControlRevision: 3,
        payload: {
          approvalId: 'approval_tool',
          decision: 'approve',
          subjectVersionId: 'tool_body',
          scope: 'run',
        },
      }),
      expect.objectContaining({
        payload: {
          approvalId: 'approval_tool',
          decision: 'approve',
          subjectVersionId: 'tool_body',
        },
      }),
    ]);
    session.getState().dispose();
  });
});
