import { DEFAULT_LIMITS } from '@corral/contracts';
import {
  FakeClock,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  Coordinator,
  installationPolicy,
  limitViolations,
  parseWorkspaceConfig,
  SPEC_HARD_CAPS,
} from '../src/index.ts';

describe('workspace config and installation policy (C-062)', () => {
  it('an empty config yields the Spec §9 hard caps', () => {
    const config = parseWorkspaceConfig({ schemaVersion: '0.1' });
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    expect(installationPolicy(config.config)).toEqual(SPEC_HARD_CAPS);
    expect(limitViolations(DEFAULT_LIMITS, 2, SPEC_HARD_CAPS)).toEqual([]);
  });

  it('lets an installation lower a cap but never raise one past the spec', () => {
    const lowered = parseWorkspaceConfig({ schemaVersion: '0.1', hardCaps: { maxModelCalls: 20 } });
    expect(lowered.ok && installationPolicy(lowered.config).maxModelCalls).toBe(20);
    const raised = parseWorkspaceConfig({ schemaVersion: '0.1', hardCaps: { maxModelCalls: 101 } });
    expect(raised.ok).toBe(false);
    if (!raised.ok) expect(raised.errors.join(' ')).toContain('hardCaps.maxModelCalls');
  });

  it('[TC-SEC-002-N] refuses unknown keys and any credential in the config file', () => {
    const unknown = parseWorkspaceConfig({ schemaVersion: '0.1', extra: true });
    expect(unknown.ok).toBe(false);
    for (const secret of [
      { schemaVersion: '0.1', apiKey: 'sk-test' },
      {
        schemaVersion: '0.1',
        modelProfiles: [{ id: 'a', provider: 'openai', model: 'm', token: 'x' }],
      },
      { schemaVersion: '0.1', OPENAI_API_KEY: 'sk-test' },
    ]) {
      const result = parseWorkspaceConfig(secret);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join(' ')).toMatch(/environment/);
        expect(result.errors.join(' ')).not.toContain('sk-test');
      }
    }
  });

  it('names every definition limit above the installation caps', () => {
    const policy = { ...SPEC_HARD_CAPS, maxModelCalls: 20, maxLoopIterations: 1 };
    expect(limitViolations(DEFAULT_LIMITS, 2, policy)).toEqual([
      'maxModelCalls 40 is above this installation’s cap of 20',
      'Loop rounds 2 is above this installation’s cap of 1',
    ]);
  });

  it('refuses to start a run whose limits exceed the installation policy', () => {
    const coordinator = new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({ turns: 1 }),
      policy: { ...SPEC_HARD_CAPS, maxModelCalls: 20 },
    });
    const { runId, receipt } = coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_start',
      definition: linearCorral(['writer']),
      mode: 'mock',
    });
    expect(runId).toBeNull();
    expect(receipt.error?.code).toBe('GRAPH_INVALID');
    expect(receipt.error?.message).toContain('maxModelCalls');
  });
});
