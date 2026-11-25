import { describe, expect, it } from 'vitest';
import { defaultEditingMode, withEditingMode } from '../src/editing-mode.ts';

// desktop-contract.md ABS-03: an unset editing mode follows the model family; a chosen one wins.
describe('editing mode by model family', () => {
  const model = (provider: string, modelId: string) => ({ provider, modelId });
  it('gives Hashline by default and the replace grammar to the families that handle Hashline poorly', () => {
    for (const [provider, id] of [
      ['anthropic', 'claude-opus-5-5'],
      ['openai', 'gpt-6.2'],
      ['zai', 'glm-5.3'],
      ['google', 'gemini-3-pro'],
    ] as const)
      expect(defaultEditingMode(model(provider, id)), id).toBe('hashline');
    for (const [provider, id] of [
      ['deepseek', 'deepseek-v4'],
      ['moonshot', 'kimi-k3'],
      ['minimax', 'MiniMax-M3'],
      ['xiaomi', 'mimo-v2'],
      ['stepfun', 'step-4'],
      ['openai', 'gpt-6.2-codex-spark'],
      ['zai', 'glm-5.3-flash'],
      ['alibaba', 'qwen3.8-max'],
    ] as const)
      expect(defaultEditingMode(model(provider, id)), id).toBe('pi');
    // No model named (simulation): Corral's earlier default.
    expect(defaultEditingMode({ provider: null, modelId: null })).toBe('pi');
  });

  it('never overrides a mode the role chose (counterexample)', () => {
    const role = { id: 'writer', editingMode: 'pi' } as never;
    expect(withEditingMode(role, model('anthropic', 'claude-opus-5-5'))).toBe(role);
    const chosen = { id: 'writer', editingMode: 'hashline' } as never;
    expect(withEditingMode(chosen, model('deepseek', 'deepseek-v4'))).toBe(chosen);
    const files = { id: 'writer', allowedWorkTools: ['read_file', 'write_file'] } as never;
    expect(withEditingMode(files, model('deepseek', 'deepseek-v4'))).toMatchObject({
      editingMode: 'pi',
    });
    // A role that touches no file keeps no editing mode.
    const writer = { id: 'writer', allowedWorkTools: ['write_artifact'] } as never;
    expect(withEditingMode(writer, model('anthropic', 'claude-opus-5-5'))).toBe(writer);
  });
});

// The mode reaches the execution's start input, which both the adapter's tool list and the
// Coordinator's tool admission read.
describe('editing mode at the execution start', () => {
  it('fills an unset mode from the execution model, and keeps a chosen one', async () => {
    const { Coordinator } = await import('../src/coordinator.ts');
    const { FakeClock, linearCorral, SequentialIdFactory } = await import('@corral/testkit');
    const started: { role: string; mode: string | undefined }[] = [];
    const run = async (provider: string, modelId: string, chosen?: 'pi' | 'hashline') => {
      const definition = linearCorral(['writer']);
      definition.roles = definition.roles.map((role) => ({
        ...role,
        allowedWorkTools: [...role.allowedWorkTools, 'read_file', 'write_file'],
        ...(chosen ? { editingMode: chosen } : {}),
      }));
      const coordinator = new Coordinator({
        clock: new FakeClock(),
        ids: new SequentialIdFactory(),
        models: {
          resolve: (profile: string) => ({
            ok: true,
            snapshot: { profile, provider, modelId, auth: 'mock' },
          }),
        },
        agents: {
          start: async (input: { role: { id: string; editingMode?: string } }) => {
            started.push({ role: input.role.id, mode: input.role.editingMode });
            return {
              cancel: async () => {},
              waitForSettlement: async () => ({ outcome: 'failed' as const }),
            };
          },
        },
      } as never);
      coordinator.startRun({
        schemaVersion: '0.1',
        commandId: `cmd_${started.length}_${modelId}`,
        mode: 'mock',
        definition,
      } as never);
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    await run('anthropic', 'claude-opus-5-5');
    await run('deepseek', 'deepseek-v4');
    await run('deepseek', 'deepseek-v4', 'hashline');
    expect(started.map((item) => item.mode)).toEqual(['hashline', 'pi', 'hashline']);
  });
});
