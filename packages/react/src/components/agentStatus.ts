import type { ExecutionStatus, RunStatus } from '@corral/contracts';
import type { AgentStatus } from '../design-kit/components/agent/agent-primitives.tsx';

// The kit's six agent states drive its glyphs, colours and motion. Corral keeps its own, finer
// status as the visible label, so the mapping only chooses the glyph: `waiting` means the user
// is needed, a cancellation is `stopped` and never `failed`, and work that waits on its own
// children or messages is still `running`.

const RUN: Record<RunStatus, AgentStatus> = {
  created: 'queued',
  validating: 'queued',
  running: 'running',
  pausing: 'running',
  paused: 'stopped',
  awaiting_user: 'waiting',
  cancelling: 'running',
  succeeded: 'done',
  failed: 'failed',
  cancelled: 'stopped',
  interrupted: 'failed',
};

const EXECUTION: Record<ExecutionStatus, AgentStatus> = {
  queued: 'queued',
  ready: 'queued',
  active: 'running',
  waiting_children: 'running',
  waiting_message: 'running',
  waiting_approval: 'waiting',
  pausing: 'running',
  paused: 'stopped',
  cancelling: 'running',
  succeeded: 'done',
  failed: 'failed',
  cancelled: 'stopped',
};

export function runAgentStatus(status: RunStatus): AgentStatus {
  return RUN[status];
}

export function executionAgentStatus(status: ExecutionStatus): AgentStatus {
  return EXECUTION[status];
}
