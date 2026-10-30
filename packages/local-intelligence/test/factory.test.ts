import type { DecisionCancellation } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import { bundledManifest } from '../src/bundle.ts';
import { requestInput } from '../src/effort/preprocess.ts';
import { bundledEffortWeights, createLocalIntelligence } from '../src/factory.ts';
import { fakeLauncher, flush, markInstalled } from './fake-helper.ts';
import { tempDir, testBundle, testWeights as weights } from './helpers.ts';

const never: DecisionCancellation = { aborted: false, onCancel: () => () => {} };

describe('local intelligence factory', () => {
  it('wires the engine and the effort judge for this machine and starts nothing until used', async () => {
    const root = tempDir();
    const bundle = testBundle();
    markInstalled(root, bundle);
    const launcher = fakeLauncher();
    const li = createLocalIntelligence({
      root,
      bundle,
      effortWeights: weights(),
      launch: launcher.launch,
      env: { CORRAL_LOCAL_AI_HELPER: '/opt/helper' },
      platform: 'linux',
      arch: 'x64',
      logicalCores: 8,
    });
    expect(li.target).toBe('linux-x64');
    expect(li.effort).toMatchObject({ id: 'local-model', version: 'test-release-1+test-weights' });
    expect(li.effort.available()).toBe(true);
    expect(launcher.helpers).toHaveLength(0);

    const judged = li.effort.decideRequest(requestInput('rename a variable'), never);
    await flush();
    const helper = launcher.last();
    expect(helper.command.executable).toBe('/opt/helper');
    const args = helper.command.args;
    expect(args[args.indexOf('--threads') + 1]).toBe('4');
    helper.ready();
    await flush();
    helper.answer();
    await expect(judged).resolves.toMatchObject({ answer: 'medium', abstain: false });

    await li.close();
    expect(helper.killed).toBe(true);
  });

  it('reports a machine without a runtime as unsupported and refuses weights for another model', () => {
    const launcher = fakeLauncher();
    const li = createLocalIntelligence({
      root: tempDir(),
      bundle: testBundle(),
      effortWeights: weights(),
      launch: launcher.launch,
      env: {},
      platform: 'darwin',
      arch: 'x64',
    });
    expect(li.target).toBeNull();
    expect(li.engine.status().state).toBe('unsupported');
    expect(li.effort.available()).toMatch(/no runtime for this platform/);
    expect(() =>
      createLocalIntelligence({
        root: tempDir(),
        bundle: testBundle(),
        effortWeights: weights('0'.repeat(64)),
        env: {},
      }),
    ).toThrow(/another base model/);
  });

  it('ships effort weights trained for the bundled model', () => {
    const li = createLocalIntelligence({ root: tempDir(), env: {}, launch: fakeLauncher().launch });
    expect(li.effort.version).toBe(`${bundledManifest().release}+effort-v1`);
    expect(bundledEffortWeights()).toMatchObject({
      dims: bundledManifest().embedding.dims,
      baseModelSha256: bundledManifest().model.sha256,
    });
  });
});
