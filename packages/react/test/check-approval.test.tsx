import type { CheckPlan, Receipt } from '@corral/contracts';
import { fireEvent, render, screen } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import { ApprovalPanel } from '../src/components/ApprovalPanel.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { projectionWith, sessionStore } from '../src/stories/fixtures.tsx';

const plan: CheckPlan = {
  commandId: 'types',
  name: 'Type check',
  argv: ['node', 'check.mjs'],
  timeoutMs: 10000,
  configRevision: 2,
  fingerprint: 'a'.repeat(64),
  tree: 'b'.repeat(40),
  trusted: false,
};
function setup(text: string | null, purpose?: 'check' | 'lsp') {
  const resolveApproval = vi.fn(async () => ({ status: 'applied' }) as Receipt);
  const session = sessionStore({
    projection: projectionWith({
      status: 'awaiting_user',
      approvals: {
        approval_check: {
          approvalId: 'approval_check',
          kind: 'user_action',
          subjectVersionIds: ['check_body'],
          criteriaVersionId: null,
          status: 'pending',
          tool: {
            ...(purpose ? { purpose } : {}),
            executionId: 'exec_1',
            attemptNo: 2,
            effectId: 'effect_1',
            toolCallId: 'tool_1',
            bodyRef: 'check_body',
            fingerprint: plan.fingerprint,
            targetTree: plan.tree,
            deadline: '2099-10-18T00:00:00.000Z',
          },
        },
      },
    }),
    artifactTexts: text === null ? {} : { check_body: text },
    resolveApproval,
  });
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <ApprovalPanel session={session} onOpenArtifact={() => {}} />
    </IntlProvider>,
  );
  return resolveApproval;
}
it('[TC-HAR-010-H] identifies a language server launch and query without promising a frozen check copy', async () => {
  const decide = setup(
    JSON.stringify({
      ...plan,
      purpose: 'lsp',
      query: {
        serverId: plan.commandId,
        path: 'src/main.ts',
        operation: 'definition',
        position: { line: 0, character: 1 },
      },
    }),
    'lsp',
  );
  expect(await screen.findByText('Approve language server launch')).toBeVisible();
  expect(await screen.findByText('definition · src/main.ts')).toBeVisible();
  expect(screen.queryByText(/frozen copy/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Run this query once' }));
  await vi.waitFor(() => expect(decide).toHaveBeenCalledWith('approval_check', 'approve'));
});
it('[TC-HAR-012-H] shows the exact check command, revision and fingerprint before one-time approval', async () => {
  const decide = setup(JSON.stringify(plan));
  expect(await screen.findByText('node check.mjs')).toBeVisible();
  expect(screen.getByText(/Type check/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Run this check once' }));
  await vi.waitFor(() => expect(decide).toHaveBeenCalledWith('approval_check', 'approve'));
});
it.each([null, JSON.stringify({ ...plan, fingerprint: 'c'.repeat(64) })])(
  '[TC-HAR-012-N] missing or mismatched approval details cannot be approved blindly',
  async (text) => {
    setup(text);
    expect(await screen.findByRole('button', { name: 'Run this check once' })).toBeDisabled();
    expect(
      await screen.findByText(
        'Check details could not be verified. Dismiss this request and try again.',
      ),
    ).toBeVisible();
  },
);

it.each([false, true])(
  '[TC-SAFE-002-H] [TC-SAFE-002-N] tool approval shows final arguments and refuses a tampered body (%s)',
  async (tampered) => {
    const { toolPermissionPlan } = await import('@corral/core');
    const permission = toolPermissionPlan(
      { snapshotHash: 'c'.repeat(64), policyRevision: 2 },
      {
        name: 'send',
        source: 'extension:fixture@1.0.0',
        schemaHash: 'd'.repeat(64),
        exposure: 'direct',
        sideEffect: 'external',
      },
      { content: 'Approved content' },
    );
    const resolveApproval = vi.fn(async () => ({ status: 'applied' }) as Receipt);
    const session = sessionStore({
      projection: projectionWith({
        status: 'awaiting_user',
        approvals: {
          approval_tool: {
            approvalId: 'approval_tool',
            kind: 'user_action',
            subjectVersionIds: ['tool_body'],
            criteriaVersionId: null,
            status: 'pending',
            tool: {
              purpose: 'tool',
              executionId: 'exec_1',
              attemptNo: 1,
              toolCallId: 'tool_1',
              bodyRef: 'tool_body',
              fingerprint: permission.fingerprint,
              deadline: '2099-10-18T00:00:00.000Z',
            },
          },
        },
      }),
      resolveApproval,
      artifactTexts: {
        tool_body: JSON.stringify(
          tampered ? { ...permission, arguments: { content: 'Different content' } } : permission,
        ),
      },
    });
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ApprovalPanel session={session} onOpenArtifact={() => {}} />
      </IntlProvider>,
    );
    const button = screen.getByRole('button', { name: 'Allow once' });
    if (tampered) {
      await vi.waitFor(() => expect(screen.getByRole('alert')).toBeVisible());
      expect(button).toBeDisabled();
    } else {
      await vi.waitFor(() => expect(button).toBeEnabled());
      expect(screen.getByText(/Approved content/)).toBeVisible();
      fireEvent.click(button);
      await vi.waitFor(() =>
        expect(resolveApproval).toHaveBeenCalledWith('approval_tool', 'approve'),
      );
    }
  },
);

it('[TC-ABS-001-H] command approval leads with source and launch scope, keeps transport in disclosure', async () => {
  const args = {
    operationId: 'command_1',
    hostId: 'host_1',
    sessionId: 'session_1',
    workspaceBindingId: 'binding_1',
    worktreeId: 'worktree_1',
    rootIdentity: 'a'.repeat(64),
    tree: 'b'.repeat(40),
    shellId: 'powershell',
    command: 'Write-Output "hello"',
    executable: 'powershell.exe',
    argv: ['-EncodedCommand', 'TRANSPORT_ONLY_BASE64'],
    cwd: 'src',
    environmentHash: 'c'.repeat(64),
    timeoutMs: 120000,
    mode: 'service',
    fingerprint: 'd'.repeat(64),
    request: { command: 'Write-Output "hello"', mode: 'service' },
  };
  await renderCorralTool('run_command', args);
  expect(await screen.findByText('Write-Output "hello"')).toBeVisible();
  expect(screen.getByText('src')).toBeVisible();
  expect(screen.getByText('PowerShell')).toBeVisible();
  expect(screen.getByText('Service')).toBeVisible();
  expect(screen.getByText('120 s')).toBeVisible();
  expect(screen.getByText(/TRANSPORT_ONLY_BASE64/)).not.toBeVisible();
  fireEvent.click(screen.getByText('Tool identity and call fingerprint'));
  expect(screen.getByText(/TRANSPORT_ONLY_BASE64/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Allow once' })).toBeEnabled();
});

it('[TC-ABS-003-H] Hashline approval shows the affected path and multiline operations before technical metadata', async () => {
  await renderCorralTool('edit_hashline', {
    version: 1,
    path: 'src/main.ts',
    tag: 'A123',
    ops: 'PUT 2\n+const value = 2;',
  });
  expect(await screen.findByText('src/main.ts')).toBeVisible();
  expect(screen.getByText('PUT 2 +const value = 2;')).toBeVisible();
  expect(screen.getByText(/"tag": "A123"/)).not.toBeVisible();
  expect(screen.getByRole('button', { name: 'Allow once' })).toBeEnabled();
});

async function renderCorralTool(name: string, args: Record<string, unknown>) {
  const { toolPermissionPlan } = await import('@corral/core');
  const permission = toolPermissionPlan(
    { snapshotHash: 'e'.repeat(64), policyRevision: 2 },
    {
      name,
      source: 'corral',
      schemaHash: 'f'.repeat(64),
      exposure: 'direct',
      sideEffect: 'workspace',
    },
    args,
  );
  const session = sessionStore({
    projection: projectionWith({
      status: 'awaiting_user',
      approvals: {
        approval_command: {
          approvalId: 'approval_command',
          kind: 'user_action',
          subjectVersionIds: ['command_body'],
          criteriaVersionId: null,
          status: 'pending',
          tool: {
            purpose: 'tool',
            executionId: 'exec_1',
            attemptNo: 1,
            toolCallId: 'tool_1',
            bodyRef: 'command_body',
            fingerprint: permission.fingerprint,
            deadline: '2099-10-18T00:00:00.000Z',
          },
        },
      },
    }),
    artifactTexts: { command_body: JSON.stringify(permission) },
  });
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <ApprovalPanel session={session} onOpenArtifact={() => {}} />
    </IntlProvider>,
  );
}
