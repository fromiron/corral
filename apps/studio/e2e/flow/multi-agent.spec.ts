import type { CorralDefinition } from '@corral/contracts';
import { defaultReply } from '@corral/testkit';
import type { Page } from '@playwright/test';
import { expect, test } from '../server/harness.ts';
import { activityBar, activityLine, requestBox } from '../workbench.ts';
import { countVisibleLabels, waitForStill } from './probe.ts';
import {
  checkChrome,
  checkLabels,
  hold,
  measure,
  msg,
  note,
  nothingWaiting,
  shot,
} from './scene.ts';

// Scene ② several roles at once (docs/guides/testing.md "흐름 장면"; features/composer-flow.md "활동
// 바"): a team whose plan branches to three roles in parallel (the way of
// e2e/server/team-graph.spec.ts), each role's first reply held, so the three work at once. The
// closed activity bar names no role whose state is already on screen; opened, it joins a role in
// two presses. The roles are then let go one at a time, and each finishing moves no item or
// session row already on screen, leaves the input line where it is, and puts no target's state
// name on screen twice. The scene runs again with reduced motion.

const BRANCHES = [
  { node: 'research', name: 'Researcher' },
  { node: 'build', name: 'Implementer' },
  { node: 'check', name: 'Reviewer' },
] as const;

/** The held first reply of each branch, by node; set before each run of the scene. */
let gates = new Map<string, ReturnType<typeof hold>>();

const role = (id: string, name: string) => ({
  id: `${id}_role`,
  name,
  prompt: `Act as ${name}.`,
  modelProfile: 'model-a',
  allowedWorkTools: ['write_artifact'],
  allowedCollaborationTools: ['submit_result'],
  outputContract: 'text' as const,
});
const agent = (id: string, label: string, from: string | null) => ({
  id,
  type: 'agent' as const,
  label,
  roleId: `${id}_role`,
  invocation: 'scheduled' as const,
  inputBindings: from
    ? [{ kind: 'task_output' as const, name: 'previous', sourceNodeId: from }]
    : [{ kind: 'run_input' as const, name: 'brief' }],
  outputName: 'text',
});
const edge = (source: string, target: string) => ({
  id: `${source}_out_${target}_in`,
  source,
  sourcePort: 'out',
  target,
  targetPort: 'in',
});

const definition = {
  schemaVersion: '0.1',
  id: 'three_at_once',
  name: 'Three at once',
  entryNodeId: 'plan',
  input: { brief: 'Find why login is slow and fix it.', criteria: ['Say what changed.'] },
  roles: [role('plan', 'Planner'), ...BRANCHES.map((branch) => role(branch.node, branch.name))],
  nodes: [
    agent('plan', 'Plan', null),
    ...BRANCHES.map((branch) => agent(branch.node, branch.name, 'plan')),
    { id: 'meet', type: 'join', label: 'Meet', policy: 'all' },
    {
      id: 'output',
      type: 'output',
      label: 'Output',
      inputBindings: [{ kind: 'task_output', name: 'final', sourceNodeId: 'build' }],
      requireApproval: false,
    },
  ],
  controlEdges: [
    ...BRANCHES.map((branch) => edge('plan', branch.node)),
    ...BRANCHES.map((branch) => edge(branch.node, 'meet')),
    edge('meet', 'output'),
  ],
  capabilityLinks: [],
  limits: {
    maxDelegationDepth: 2,
    maxModelConcurrency: 6,
    maxSpawns: 12,
    maxQuestions: 6,
    questionTimeoutMs: 120_000,
  },
} as CorralDefinition;

/** Saves the team, opens a session on it and starts a simulated run there. */
async function startTeamRun(page: Page) {
  return page.evaluate(async (definition) => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const call = async (path: string, body: unknown) => {
      const response = await fetch(`/api/v1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`setup ${path}: ${response.status}`);
      return response.json();
    };
    const saved = await call('/corrals', { definition });
    const { session } = await call('/sessions', {
      projectId: 'default',
      title: 'Three at once',
      corralId: saved.record.corralId,
    });
    const started = await call('/runs', {
      schemaVersion: '0.1',
      commandId: 'flow-three-at-once',
      sessionId: session.sessionId,
      corralId: saved.record.corralId,
      definitionRevision: saved.record.definitionRevision,
      mode: 'mock',
    });
    return { sessionId: session.sessionId as string, runId: started.runId as string };
  }, definition);
}

test.use({
  agentReply: {
    reply: defaultReply,
    beforeReply: async (turn, input) => {
      const gate = gates.get(input.nodeId);
      if (turn !== 1 || !gate) return;
      gate.reach();
      await gate.opened;
    },
  },
});

for (const reduced of [false, true]) {
  const SCENE = reduced ? 'multi-agent-reduced-motion' : 'multi-agent';
  test(`② three roles at once: the bar names none on screen, joins in two presses, and each finishing moves nothing${reduced ? ', reduced motion' : ''}`, async ({
    page,
    corral,
  }) => {
    test.setTimeout(180_000);
    gates = new Map(BRANCHES.map((branch) => [branch.node, hold()]));
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
      await corral.open('/');
      const { sessionId, runId } = await startTeamRun(page);
      const projection = () => corral.server.coordinator.getSnapshot(runId).projection;
      const executionOf = (node: string) => projection().nodeExecutions[node]?.[0] ?? '';
      const state = (node: string) => projection().executions[executionOf(node)]?.status;
      // The three branches work at once, each held at its first reply.
      await Promise.all(BRANCHES.map((branch) => gates.get(branch.node)?.reached));
      await corral.open(`/sessions/${sessionId}`);
      await expect(page.locator('[data-chat-item]').first()).toBeVisible();
      await waitForStill(page);
      for (const branch of BRANCHES) expect(state(branch.node)).toBe('active');
      await checkLabels(page, SCENE, 'three working');
      await shot(page, SCENE, 'three-working');

      // The closed bar names no role whose state is on screen. The run row's log is closed at
      // first; opened by the keyboard, it shows each role's row with its state.
      const sayings: unknown[] = [];
      const barSays = async (where: string) => {
        const visible = Object.keys((await countVisibleLabels(page)).labels);
        const closed = (await activityLine(page).innerText()).trim();
        const said = BRANCHES.map((branch) => ({
          name: branch.name,
          onScreen: visible.includes(`execution:${executionOf(branch.node)}`),
          named: closed.includes(branch.name),
        }));
        sayings.push({ where, closed, visible, said });
        for (const role of said)
          if (role.onScreen)
            expect
              .soft(role.named, `${SCENE} ${where}: ${role.name} is on screen and on the bar`)
              .toBe(false);
        return said;
      };
      await barSays('log closed');
      const head = page.locator('[data-chat-part="head"] button[aria-expanded]').first();
      await head.focus();
      await page.keyboard.press('Enter');
      await expect(head).toHaveAttribute('aria-expanded', 'true');
      await waitForStill(page);
      const opened = await barSays('log open');
      note(SCENE, 'closed bar', sayings);
      expect(opened.filter((role) => role.onScreen)).toHaveLength(BRANCHES.length);
      await checkLabels(page, SCENE, 'log open');
      await shot(page, SCENE, 'log-open');

      // Join a role from the bar in two presses: open the panel, then its Join.
      const bar = activityBar(page);
      const toggle = bar.locator('[data-activity-toggle]');
      await toggle.focus();
      await page.keyboard.press('Enter');
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      // A row for each working role.
      await expect(bar.locator('[data-activity-role]')).toHaveCount(BRANCHES.length);
      await checkLabels(page, SCENE, 'panel open');
      const target = BRANCHES[1];
      const join = bar.getByRole('button', {
        name: msg('Activity.joinRole', { name: target.name }),
        exact: true,
      });
      await join.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-slot="composer-target"]').first()).toContainText(
        target.name,
      );
      await expect(bar.locator(`[data-activity-role="${executionOf(target.node)}"]`)).toContainText(
        msg('Activity.joinTarget'),
      );
      await expect(requestBox(page)).toBeFocused();
      await shot(page, SCENE, 'joined');
      // The panel closes again before the roles finish.
      await toggle.focus();
      await page.keyboard.press('Enter');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await waitForStill(page);

      // The roles finish one at a time.
      for (const [index, branch] of BRANCHES.entries()) {
        const last = index === BRANCHES.length - 1;
        await measure(page, SCENE, `${branch.node}-finishes`, async () => {
          gates.get(branch.node)?.open();
          await expect.poll(() => state(branch.node), { timeout: 30_000 }).toBe('succeeded');
          if (last)
            await expect.poll(() => projection().status, { timeout: 30_000 }).toBe('succeeded');
        });
        await checkLabels(page, SCENE, `${branch.node} finished`);
      }
      await checkChrome(page, SCENE, 'end');
      await shot(page, SCENE, 'end');
      nothingWaiting(corral.server.coordinator, SCENE);
      expect(corral.errors).toEqual([]);
    } finally {
      for (const gate of gates.values()) gate.open();
    }
  });
}
