import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLiveModels } from '../src/live-models.ts';

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'corral-live-models-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('live models', () => {
  it('a ChatGPT sign-in reaches the GPT-6.2 models of the bundled Codex catalog', () => {
    vi.stubEnv('CORRAL_CONFIG_DIR', temp());
    vi.stubEnv('CODEX_HOME', temp());
    const live = createLiveModels();
    for (const provider of ['openai', 'openai-codex']) {
      const allowed = live.subscriptionModels?.(provider);
      expect(allowed?.has('gpt-6.2-astra')).toBe(true);
      expect(allowed?.has('gpt-6.2-sol')).toBe(true);
      // The models already listed stay.
      expect(allowed?.has('gpt-6.1-sol')).toBe(true);
    }
    expect(live.subscriptionModels?.('anthropic')).toBeNull();
  });
});
