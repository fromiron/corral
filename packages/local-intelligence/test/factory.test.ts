import { describe, expect, it } from 'vitest';
import { bundledManifest } from '../src/bundle.ts';
import { createLocalIntelligence } from '../src/factory.ts';
import { fakeLauncher, flush, markInstalled } from './fake-helper.ts';
import { tempDir, testBundle } from './helpers.ts';

describe('local intelligence factory', () => {
  it('wires the meeting engine for this machine and starts nothing until used', async () => {
    const root = tempDir();
    const bundle = testBundle();
    markInstalled(root, bundle);
    const launcher = fakeLauncher();
    const li = createLocalIntelligence({
      root,
      bundle,
      launch: launcher.launch,
      env: { CORRAL_LOCAL_AI_HELPER: '/opt/helper' },
      platform: 'linux',
      arch: 'x64',
      logicalCores: 8,
    });
    expect(li.target).toBe('linux-x64');
    expect(li.engine.available()).toBe(true);
    expect(li).not.toHaveProperty('effort');
    expect(launcher.helpers).toHaveLength(0);

    const embedded = li.engine.embed({
      texts: ['hi'],
      task: 'classification',
      overflow: 'truncate',
    });
    await flush();
    const helper = launcher.last();
    expect(helper.command.executable).toBe('/opt/helper');
    const args = helper.command.args;
    expect(args[args.indexOf('--threads') + 1]).toBe('4');
    expect(args).not.toContain('--effort-model');
    helper.ready();
    await flush();
    helper.answer();
    await expect(embedded).resolves.toHaveLength(1);

    await li.close();
    expect(helper.killed).toBe(true);
  });

  it('reports a machine without a runtime as unsupported', () => {
    const li = createLocalIntelligence({
      root: tempDir(),
      bundle: testBundle(),
      launch: fakeLauncher().launch,
      env: {},
      platform: 'darwin',
      arch: 'x64',
    });
    expect(li.target).toBeNull();
    expect(li.engine.status().state).toBe('unsupported');
    expect(li.engine.available()).toMatch(/no runtime for this platform/);
  });

  it('ships a bundle with the meeting model only', () => {
    const li = createLocalIntelligence({ root: tempDir(), env: {}, launch: fakeLauncher().launch });
    expect(li.status().models).toEqual({ meeting: bundledManifest().models.meeting.name });
  });
});
