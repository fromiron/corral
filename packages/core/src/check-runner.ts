import type {
  AgentAdapter,
  AgentHandle,
  AgentHost,
  AgentRole,
  AgentSettlement,
  AgentStartInput,
} from '@corral/contracts';

// A check Decision's own execution (docs/specs/features/team-graph.md, "check 실행"). It calls
// no model: it runs the node's registered checks through the ordinary run_check tool, so launch
// approval, reports, stale trees and cancellation work as for any check, then submits a summary.
// The Coordinator decides the branch from the recorded tool results, not from this summary.

export const CHECK_ROLE_ID = 'check_runner';
/** The input that names the checks to run, as a JSON array of command ids. */
export const CHECKS_INPUT = 'checks';

/** The built-in role a check execution runs with. Its model is pinned but never called. */
export const checkRole = (modelProfile: string): AgentRole => ({
  id: CHECK_ROLE_ID,
  name: 'Checks',
  prompt: 'Runs the registered checks of a check step.',
  modelProfile,
  // run_check is allowed by the run's pinned checks (ToolGateView.checkSelection), not a work tool.
  allowedWorkTools: ['write_artifact'],
  allowedCollaborationTools: ['submit_result'],
  outputContract: 'text',
});

export class BuiltInCheckRunner implements AgentAdapter {
  async start(input: AgentStartInput, host: AgentHost): Promise<AgentHandle> {
    let cancelled = false;
    const settlement = (async (): Promise<AgentSettlement> => {
      const ids = JSON.parse(
        input.inputs.find((i) => i.name === CHECKS_INPUT)?.text ?? '[]',
      ) as string[];
      const lines: string[] = [];
      for (const commandId of ids) {
        if (cancelled) return { outcome: 'cancelled' };
        const outcome = await host.invokeTool({ name: 'run_check', args: { commandId } });
        const result = outcome.ok ? (outcome.result as Record<string, unknown>) : null;
        lines.push(
          result
            ? `${commandId}: ${String(result.state)} ${String(result.verdict)}${result.stale ? ' (tree changed)' : ''}`
            : `${commandId}: not run (${outcome.ok ? 'no report' : outcome.error.code})`,
        );
      }
      if (cancelled) return { outcome: 'cancelled' };
      const written = await host.invokeTool({
        name: 'write_artifact',
        args: { text: lines.join('\n') || 'no checks' },
      });
      if (!written.ok) return { outcome: 'failed', error: written.error.message };
      const submitted = await host.invokeTool({
        name: 'submit_result',
        args: { artifactVersionIds: [written.result.artifactVersionId] },
      });
      if (!submitted.ok) return { outcome: 'failed', error: submitted.error.message };
      return { outcome: 'succeeded' };
    })();
    return {
      cancel: async () => {
        cancelled = true;
      },
      waitForSettlement: () => settlement,
    };
  }
}
