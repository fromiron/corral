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

describe('workspace config and installation policy', () => {
  it('an empty config yields the product contract §9 hard caps', () => {
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

  it('refuses unknown keys and any credential in the config file', () => {
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

  it('accepts OpenAI-compatible endpoints: https anywhere, http on this computer only', () => {
    const config = (baseUrl: string, extra: Record<string, unknown> = {}) =>
      parseWorkspaceConfig({
        schemaVersion: '0.1',
        modelProviders: [
          {
            id: 'local',
            name: 'Local',
            baseUrl,
            access: 'none',
            models: [{ id: 'llama3.2', contextWindow: 128000, maxOutput: 4096 }],
            ...extra,
          },
        ],
        modelProfiles: [{ id: 'small', provider: 'local', model: 'llama3.2' }],
      });
    for (const ok of [
      'http://127.0.0.1:11434/v1',
      'http://localhost:1234/v1',
      'http://[::1]:8080/v1',
      'https://openrouter.ai/api/v1',
    ]) {
      expect(config(ok).ok, ok).toBe(true);
    }
    const parsed = config('http://127.0.0.1:11434/v1');
    expect(parsed.ok && parsed.config.modelProviders?.[0]?.models[0]?.maxOutput).toBe(4096);
    expect(config('https://x.test/v1', { access: 'api_key' }).ok).toBe(true);
  });

  it('refuses plain http off this computer, credentials in the address and unknown access', () => {
    const errors = (provider: Record<string, unknown>) => {
      const result = parseWorkspaceConfig({
        schemaVersion: '0.1',
        modelProviders: [
          { id: 'p', name: 'P', access: 'none', models: [{ id: 'm' }], ...provider },
        ],
      });
      return result.ok ? [] : result.errors;
    };
    expect(errors({ baseUrl: 'http://192.168.1.5:11434/v1' }).join(' ')).toContain(
      'modelProviders.0.baseUrl',
    );
    expect(errors({ baseUrl: 'https://user:pw@x.test/v1' }).join(' ')).not.toContain('pw');
    expect(errors({ baseUrl: 'https://user:pw@x.test/v1' })).not.toEqual([]);
    expect(errors({ baseUrl: 'https://x.test/v1?k=1' })).not.toEqual([]);
    expect(errors({ baseUrl: 'ftp://x.test/' })).not.toEqual([]);
    expect(errors({ baseUrl: 'https://x.test/v1', access: 'oauth' })).not.toEqual([]);
    expect(errors({ baseUrl: 'https://x.test/v1', models: [] })).not.toEqual([]);
    // A key in the config file is refused as before; keys are entered under Settings → Models.
    expect(errors({ baseUrl: 'https://x.test/v1', apiKey: 'sk-test' }).join(' ')).toMatch(
      /Settings → Models/,
    );
  });

  it('names every definition limit above the installation caps', () => {
    const policy = { ...SPEC_HARD_CAPS, maxModelCalls: 20, maxLoopIterations: 1 };
    expect(limitViolations(DEFAULT_LIMITS, 2, policy)).toEqual([
      'maxModelCalls 40 is above this installation’s cap of 20',
      'Loop rounds 2 is above this installation’s cap of 1',
    ]);
  });

  it('ignores legacy installation usage caps for a run with no explicit budget', () => {
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
    expect(runId).not.toBeNull();
    expect(receipt.error).toBeUndefined();
  });
});
