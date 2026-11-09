import { ExecutionStatus, RunStatus } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import { executionAgentStatus, runAgentStatus } from '../src/components/agentStatus.ts';

describe('Corral status → kit AgentStatus', () => {
  it('maps every run status', () => {
    expect(Object.fromEntries(RunStatus.options.map((s) => [s, runAgentStatus(s)]))).toEqual({
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
    });
  });

  it('maps every execution status', () => {
    expect(
      Object.fromEntries(ExecutionStatus.options.map((s) => [s, executionAgentStatus(s)])),
    ).toEqual({
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
    });
  });

  it('never shows a cancellation as a failure', () => {
    expect(runAgentStatus('cancelled')).not.toBe('failed');
    expect(executionAgentStatus('cancelled')).not.toBe('failed');
  });

  it('keeps "needs you" for work that waits on the user only', () => {
    expect(executionAgentStatus('waiting_children')).not.toBe('waiting');
    expect(executionAgentStatus('waiting_message')).not.toBe('waiting');
  });
});
