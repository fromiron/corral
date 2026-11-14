import { type RunProjection, type UsageTotals, usageTotals } from '@corral/core';

// The run's usage split by the agent node whose execution made each request. Every group is
// counted with the run total's own definition (usageTotals), so the groups add up to the run.
// Usage the record cannot give to an agent (a team choice, an image, a call whose execution is
// not in the record) forms one group of its own.

export interface AgentUsage {
  /** The agent node, or null for usage outside any recorded agent execution. */
  nodeId: string | null;
  totals: UsageTotals;
  /** Whether any of its requests reported output usage; without it there is no information. */
  reported: boolean;
}

type Calls = RunProjection['modelCalls'];

export function usageByAgent(
  projection: Pick<RunProjection, 'modelCalls' | 'executions' | 'usage' | 'executionOrder'>,
): AgentUsage[] {
  const groups = new Map<string | null, Calls>();
  const group = (key: string | null) => {
    const calls = groups.get(key) ?? {};
    groups.set(key, calls);
    return calls;
  };
  // Agents in the order they first ran, then the calls themselves in record order.
  for (const id of projection.executionOrder) {
    const nodeId = projection.executions[id]?.nodeId;
    if (nodeId) group(nodeId);
  }
  for (const call of Object.values(projection.modelCalls))
    group(projection.executions[call.executionId]?.nodeId ?? null)[call.modelCallId] = call;
  const records = Object.values(projection.usage);
  const rows: AgentUsage[] = [];
  for (const [nodeId, calls] of groups) {
    if (nodeId === null) continue;
    const list = Object.values(calls);
    if (!list.length) continue;
    rows.push({
      nodeId,
      totals: usageTotals({ modelCalls: calls, executions: projection.executions, usage: {} }),
      reported: list.some((call) => call.usage?.outputTokens != null),
    });
  }
  const outside = groups.get(null) ?? {};
  if (Object.keys(outside).length || records.length)
    rows.push({
      nodeId: null,
      totals: usageTotals({
        modelCalls: outside,
        executions: projection.executions,
        usage: projection.usage,
      }),
      reported:
        Object.values(outside).some((call) => call.usage?.outputTokens != null) ||
        records.some((record) => record.kind !== 'image' && record.outputTokens !== null),
    });
  return rows;
}
