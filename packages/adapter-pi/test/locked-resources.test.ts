import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, type EffectiveHarnessSnapshot } from '@corral/contracts';
import { afterEach, expect, it } from 'vitest';
import { lockResources } from '../src/locked-resources.ts';
import type { SdkResources } from '../src/protocol.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'corral-lock-'));
  roots.push(root);
  const source = join(root, 'source');
  const worker = join(root, 'worker');
  mkdirSync(source);
  mkdirSync(worker);
  const text = 'export default () => {};';
  writeFileSync(join(source, 'extension.ts'), text);
  const files = [{ path: 'extension.ts', hash: hash(text), bytes: Buffer.byteLength(text) }];
  const resourceHash = hash(canonicalJson(files));
  const snapshot: EffectiveHarnessSnapshot = {
    binding: { profileId: 'writing', revision: 1 },
    snapshotHash: 'a'.repeat(64),
    piVersion: '1.3.0',
    policyRevision: 1,
    policy: 'trusted-native',
    resources: [
      {
        hash: resourceHash,
        name: 'fixture',
        version: '1.0.0',
        kind: 'extension',
        required: true,
        entry: 'extension.ts',
      },
    ],
    allowedTools: [],
    tools: [],
    diagnostics: [],
  };
  const resources = {
    extensions: [
      { path: join(source, 'extension.ts'), hash: resourceHash, source: 'extension:fixture@1.0.0' },
    ],
    skills: [],
    startupCommands: [],
    bundles: [{ root: source, hash: resourceHash, files }],
  };
  return { source, worker, text, resources, snapshot };
}
it('loads a verified execution copy, which later edits of the installed resource cannot change', () => {
  const s = setup();
  const locked = lockResources(s.resources, s.snapshot, s.worker);
  writeFileSync(join(s.source, 'extension.ts'), 'changed after locking');
  expect(locked.extensions[0]?.path.startsWith(s.worker)).toBe(true);
  expect(readFileSync(locked.extensions[0]!.path, 'utf8')).toBe(s.text);
});
it('changed content, a forged manifest or a symlink cannot reach the loader', () => {
  const s = setup();
  writeFileSync(join(s.source, 'extension.ts'), 'changed');
  expect(() => lockResources(s.resources, s.snapshot, s.worker)).toThrow();
  s.resources.bundles[0]!.files[0]!.hash = hash('changed');
  expect(() => lockResources(s.resources, s.snapshot, s.worker)).toThrow();
  rmSync(join(s.source, 'extension.ts'));
  symlinkSync('/etc/passwd', join(s.source, 'extension.ts'));
  expect(() => lockResources(s.resources, s.snapshot, s.worker)).toThrow();
});

it('a shared pack hash does not authorize an unbound sibling skill', () => {
  const s = setup();
  const files = ['bound', 'sibling'].map((name) => {
    const path = `skills/${name}/SKILL.md`;
    mkdirSync(join(s.source, 'skills', name), { recursive: true });
    writeFileSync(join(s.source, path), name);
    return { path, hash: hash(name), bytes: Buffer.byteLength(name) };
  });
  const resourceHash = hash(canonicalJson(files));
  const entry = 'skills/bound/SKILL.md';
  s.snapshot.resources = [
    {
      hash: resourceHash,
      name: 'design',
      version: '0.7.0',
      kind: 'skill',
      required: true,
      entry,
      skillName: 'bound',
      skillMode: 'explicit',
    },
  ];
  const selected: SdkResources['skills'][number] = {
    name: 'bound',
    description: 'Bound skill',
    entry,
    mode: 'explicit',
    content: 'bound',
    hash: resourceHash,
  };
  const resources: SdkResources = {
    extensions: [],
    startupCommands: [],
    bundles: [{ root: s.source, hash: resourceHash, files }],
    skills: [selected],
  };
  expect(() => lockResources(resources, s.snapshot, s.worker)).not.toThrow();
  resources.skills.push({
    ...selected,
    name: 'sibling',
    entry: 'skills/sibling/SKILL.md',
    content: 'sibling',
  });
  expect(() => lockResources(resources, s.snapshot, s.worker)).toThrow('skill is not bound');
  resources.skills.pop();
  rmSync(join(s.source, entry));
  expect(() => lockResources(resources, s.snapshot, s.worker)).toThrow();
});
