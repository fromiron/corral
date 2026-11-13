import type { ExecutionStatus, RunStatus } from '@corral/contracts';
import type { AgentStatus } from '../design-kit/components/agent/agent-primitives.tsx';
import { executionPresence, runPresence } from '../run/presence.ts';

// The kit's six agent states drive its glyphs and motion. The glyph a status takes is the one its
// presence gives (docs/specs/features/presence.md): this only reads it for callers that hold a
// bare status. A Run or execution always has a glyph.

export function runAgentStatus(status: RunStatus): AgentStatus {
  return runPresence({ status }, [], []).glyph ?? 'queued';
}

export function executionAgentStatus(status: ExecutionStatus): AgentStatus {
  return executionPresence({ status }).glyph ?? 'queued';
}
