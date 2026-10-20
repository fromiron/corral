import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { updateChannel } from '../src/update-policy.ts';
import { assertRelocatableRuntime, assertRuntimeIdentity, runtimeTarget } from './packaging.ts';

const desktop = resolve(import.meta.dirname, '..');
const target = runtimeTarget(process.platform, process.arch);
assertRelocatableRuntime(join(desktop, 'staging'));
assertRuntimeIdentity(
  JSON.parse(readFileSync(join(desktop, 'staging/runtime.json'), 'utf8')),
  target.platform,
  target.arch,
);
// No target overrides: a cross-build would silently ship the build host's native modules.
const args = process.argv.slice(2);
assert(
  args.length === 0 || (args.length === 1 && args[0] === '--dir'),
  'Only --dir is supported; package on the target OS and architecture.',
);
const platform = { win32: '--win', darwin: '--mac', linux: '--linux' }[target.platform];
assert(platform);
const config = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')).build;
const channelFile = join(desktop, 'staging/update-channel.json');
const configured = Array.isArray(config.publish) ? config.publish[0] : config.publish;
const configuredPublisher = config.win?.signtoolOptions?.publisherName;
if (process.env.CORRAL_UPDATE_URL || configured?.provider === 'generic') {
  const channel = updateChannel(
    {
      url: process.env.CORRAL_UPDATE_URL ?? configured.url,
      channel: process.env.CORRAL_UPDATE_CHANNEL ?? configured?.channel ?? 'latest',
      publisherName:
        process.env.CORRAL_UPDATE_PUBLISHER ??
        (Array.isArray(configuredPublisher) ? configuredPublisher[0] : configuredPublisher),
    },
    target.platform,
  );
  config.publish = [{ provider: 'generic', url: channel.url, channel: channel.channel }];
  config.electronUpdaterCompatibility = '>=2.16';
  if (target.platform === 'win32')
    config.win = {
      ...config.win,
      signtoolOptions: { ...config.win?.signtoolOptions, publisherName: [channel.publisherName] },
    };
  writeFileSync(channelFile, JSON.stringify(channel));
} else {
  assert(!configured, 'Only a configured generic HTTPS update feed is supported.');
  config.publish = null;
  if (existsSync(channelFile)) rmSync(channelFile);
}
mkdirSync(join(desktop, 'release'), { recursive: true });
const configFile = join(desktop, 'release/builder-local-config.json');
writeFileSync(configFile, JSON.stringify(config));
execFileSync(
  process.execPath,
  [
    createRequire(import.meta.url).resolve('electron-builder/cli.js'),
    platform,
    `--${target.arch}`,
    '--config',
    configFile,
    '--publish',
    'never',
    ...args,
  ],
  { cwd: desktop, stdio: 'inherit', windowsHide: true },
);
