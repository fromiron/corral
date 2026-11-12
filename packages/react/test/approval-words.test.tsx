import type { CheckPlan, Receipt } from '@corral/contracts';
import { fireEvent, render, screen } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalPanel } from '../src/components/ApprovalPanel.tsx';
import en from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };
import { projectionWith, sessionStore } from '../src/stories/fixtures.tsx';

// Approval cards and their result lines say what is decided in words; internal identifiers
// (`artv_…`, `crit_…`, `exec_…`) stay in collapsed details (chat-widgets-contract §6.3).

const RAW_ID = /(?:artv|crit|exec|call|appr)_[A-Za-z0-9]/;

function show(
  approvals: Record<string, unknown>,
  options: {
    texts?: Record<string, string>;
    toolCalls?: Record<string, unknown>;
    locale?: 'en' | 'ko';
    resolveApproval?: () => Promise<Receipt>;
  } = {},
) {
  const session = sessionStore({
    projection: projectionWith({
      status: 'awaiting_user',
      currentCriteriaVersionId: 'crit_0001',
      approvals: approvals as never,
      toolCalls: (options.toolCalls ?? {}) as never,
    }),
    artifactTexts: options.texts ?? {},
    ...(options.resolveApproval ? { resolveApproval: options.resolveApproval } : {}),
  });
  const view = render(
    <IntlProvider
      locale={options.locale ?? 'en'}
      messages={options.locale === 'ko' ? ko : en}
      timeZone="UTC"
    >
      <ApprovalPanel session={session} onOpenArtifact={() => {}} headed={false} />
    </IntlProvider>,
  );
  return view;
}

const noProgress = {
  approvalId: 'appr_0001',
  kind: 'user_action',
  subjectVersionIds: ['crit_0001'],
  criteriaVersionId: 'crit_0001',
  status: 'pending',
  limit: { kind: 'no_progress', used: 6, max: 6 },
};

describe('an approval a run limit asked for', () => {
  it.each(['en', 'ko'] as const)(
    'names the limit and its count, with no subject or criteria (%s)',
    async (locale) => {
      const decide = vi.fn(async () => ({ status: 'applied' }) as Receipt);
      const { container } = show(
        { appr_0001: noProgress },
        {
          locale,
          texts: { crit_0001: 'Answer with the final report.' },
          resolveApproval: decide,
        },
      );
      const messages = locale === 'ko' ? ko : en;
      const card = screen.getByTestId('approval-appr_0001');
      const title = messages.Approvals.limit.title.no_progress.replace('{used}', '6');
      expect(card.textContent).toContain(title);
      expect(card.textContent).toContain(messages.Approvals.limit.explain);
      expect(card.textContent).not.toContain(messages.Approvals.kind.user_action);
      expect(card.textContent).not.toContain(messages.Approvals.subject);
      expect(card.textContent).not.toContain(messages.Approvals.criteria);
      expect(card.textContent).not.toContain('Answer with the final report.');
      expect(container.textContent).not.toMatch(RAW_ID);
      fireEvent.click(screen.getByRole('button', { name: messages.Approvals.limit.approve }));
      await vi.waitFor(() => expect(decide).toHaveBeenCalledWith('appr_0001', 'approve'));
      expect(screen.getByRole('button', { name: messages.Approvals.limit.reject })).toBeVisible();
    },
  );

  it.each([
    ['spawns', 8, 8],
    ['questions', 20, 20],
    ['depth', 3, 3],
    ['loop_iterations', 5, 5],
  ] as const)('says which limit was reached for %s, with its count', (kind, used, max) => {
    show({ appr_0001: { ...noProgress, limit: { kind, used, max } } });
    const card = screen.getByTestId('approval-appr_0001');
    const title = en.Approvals.limit.title[kind]
      .replace('{used}', String(used))
      .replace('{max}', String(max));
    expect(card.textContent).toContain(title);
    expect(card.textContent).toContain(String(max));
  });

  it.each(['en', 'ko'] as const)(
    'a request budget approval names the budget and its count, with or without the limit (%s)',
    (locale) => {
      const messages = locale === 'ko' ? ko : en;
      const budget = {
        ...noProgress,
        kind: 'request_budget',
        executionId: 'exec_0001',
        limit: { kind: 'request_budget', used: 80, max: 50, executionId: 'exec_0001' },
      };
      const { container, unmount } = show({ appr_0001: budget }, { locale });
      const card = screen.getByTestId('approval-appr_0001');
      expect(card.textContent).toContain(
        messages.Approvals.limit.title.request_budget
          .replace('{used}', '80')
          .replace('{max}', '50'),
      );
      expect(container.textContent).not.toMatch(RAW_ID);
      unmount();
      // A criteria change asks again without the limit fact; the kind still reads.
      const { limit: _limit, ...asked } = budget;
      show({ appr_0001: asked }, { locale });
      expect(screen.getByTestId('approval-appr_0001').textContent).toContain(
        messages.Approvals.kind.request_budget,
      );
    },
  );

  it('the line of a limit approval already decided says it continued, without an id', () => {
    const { container } = show({
      appr_0001: { ...noProgress, status: 'approved' },
      appr_0002: { ...noProgress, approvalId: 'appr_0002' },
    });
    const line = screen.getByTestId('approved-appr_0001');
    expect(line.textContent).toBe(
      en.Approvals.doneLimit.replace(
        '{limit}',
        en.Approvals.limit.title.no_progress.replace('{used}', '6'),
      ),
    );
    expect(container.textContent).not.toMatch(RAW_ID);
  });
});

describe('approval result lines and cards without identifiers', () => {
  it('an allowed tool call is named by its tool and command, never its body id', async () => {
    const { toolPermissionPlan } = await import('@corral/core');
    const permission = toolPermissionPlan(
      { snapshotHash: 'e'.repeat(64), policyRevision: 2 },
      {
        name: 'run_command',
        source: 'corral',
        schemaHash: 'f'.repeat(64),
        exposure: 'direct',
        sideEffect: 'workspace',
      },
      {
        operationId: 'command_1',
        hostId: 'host_1',
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
        launchFingerprint: 'e'.repeat(64),
        fingerprint: 'd'.repeat(64),
        request: { command: 'npm test', mode: 'foreground' },
      },
    );
    const tool = (approvalId: string, status: string, bodyRef: string) => ({
      approvalId,
      kind: 'user_action',
      subjectVersionIds: [bodyRef],
      criteriaVersionId: null,
      status,
      tool: {
        purpose: 'tool',
        executionId: 'exec_0001',
        attemptNo: 1,
        toolCallId: `call_${approvalId}`,
        bodyRef,
        fingerprint: permission.fingerprint,
        deadline: '2099-10-18T00:00:00.000Z',
      },
    });
    const { container } = show(
      {
        appr_one: tool('appr_one', 'approved', 'artv_0007'),
        appr_two: tool('appr_two', 'pending', 'artv_0008'),
      },
      {
        texts: {
          artv_0007: JSON.stringify(permission),
          artv_0008: JSON.stringify(permission),
        },
        toolCalls: {
          call_appr_one: {
            toolCallId: 'call_appr_one',
            executionId: 'exec_0001',
            name: 'run_command',
            status: 'requested',
            reason: null,
          },
        },
      },
    );
    const line = screen.getByTestId('approved-appr_one');
    await vi.waitFor(() =>
      expect(line.textContent).toBe(
        en.Approvals.doneTool.replace('{call}', `${en.Turn.tool.run_command} · npm test`),
      ),
    );
    // The waiting card heads itself with the tool permission and no execution id under it.
    const card = screen.getByTestId('approval-appr_two');
    expect(card.textContent).toContain(en.Approvals.toolHeading);
    expect(visibleText(container)).not.toMatch(RAW_ID);
  });

  it('a decision about an unnamed version says what was decided without the raw id', () => {
    const { container } = show({
      appr_first: {
        approvalId: 'appr_first',
        kind: 'user_action',
        subjectVersionIds: ['artv_unknown'],
        criteriaVersionId: null,
        status: 'approved',
      },
      appr_next: {
        approvalId: 'appr_next',
        kind: 'user_action',
        subjectVersionIds: ['artv_unknown'],
        criteriaVersionId: null,
        status: 'pending',
      },
    });
    expect(screen.getByTestId('approved-appr_first').textContent).toBe(
      en.Approvals.doneBare.replace('{step}', en.Approvals.kind.user_action),
    );
    expect(container.textContent).not.toMatch(RAW_ID);
    // The id is still at hand for diagnostics, as a title.
    expect(container.querySelector('[title="artv_unknown"]')).not.toBeNull();
  });

  it('a check approval keeps its execution and fingerprint in collapsed details', async () => {
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
    const { container } = show(
      {
        appr_check: {
          approvalId: 'appr_check',
          kind: 'user_action',
          subjectVersionIds: ['artv_check'],
          criteriaVersionId: null,
          status: 'pending',
          tool: {
            executionId: 'exec_0001',
            attemptNo: 2,
            effectId: 'effect_1',
            toolCallId: 'call_1',
            bodyRef: 'artv_check',
            fingerprint: plan.fingerprint,
            targetTree: plan.tree,
            deadline: '2099-10-18T00:00:00.000Z',
          },
        },
      },
      { texts: { artv_check: JSON.stringify(plan) } },
    );
    expect(await screen.findByText('node check.mjs')).toBeVisible();
    expect(visibleText(container)).not.toMatch(RAW_ID);
  });
});

/** The text a person sees: closed disclosures and visually hidden text are left out. */
function visibleText(root: HTMLElement): string {
  const copy = root.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll('[hidden], .sr-only')) hidden.remove();
  return copy.textContent ?? '';
}
