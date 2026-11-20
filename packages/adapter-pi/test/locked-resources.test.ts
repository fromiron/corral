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

// harness-contract.md, "그 밖에 쓸 수 있는 스킬": a skill nobody required or picked whose body is
// not text is left out; a required or picked one still stops the start, naming the skill.
it('leaves out an unbound skill whose body is not UTF-8 and refuses a bound one by name', () => {
  const s = setup();
  const latin1 = Buffer.from('---\nname: café\n---\ncaf\xe9', 'latin1');
  const bodies: Record<string, Buffer> = { text: Buffer.from('plain'), latin: latin1 };
  const files = Object.entries(bodies).map(([name, body]) => {
    const path = `skills/${name}/SKILL.md`;
    mkdirSync(join(s.source, 'skills', name), { recursive: true });
    writeFileSync(join(s.source, path), body);
    return {
      path,
      hash: createHash('sha256').update(body).digest('hex'),
      bytes: body.length,
    };
  });
  const resourceHash = hash(canonicalJson(files));
  const bind = (marks: { required?: boolean; selectedByRole?: true; library?: true }) => {
    s.snapshot.resources = Object.keys(bodies).map((name) => ({
      hash: resourceHash,
      name: 'pack',
      version: '1.0.0',
      kind: 'skill' as const,
      required: false,
      entry: `skills/${name}/SKILL.md`,
      skillName: name,
      skillMode: 'auto' as const,
      ...(name === 'latin' ? marks : { library: true as const }),
    }));
    const resources: SdkResources = {
      extensions: [],
      startupCommands: [],
      bundles: [{ root: s.source, hash: resourceHash, files }],
      skills: Object.keys(bodies).map((name) => ({
        name,
        description: `Use ${name}.`,
        entry: `skills/${name}/SKILL.md`,
        mode: 'auto' as const,
        content: '',
        hash: resourceHash,
      })),
    };
    return () => lockResources(resources, s.snapshot, s.worker);
  };
  expect(bind({ library: true })().skills.map((skill) => skill.name)).toEqual(['text']);
  expect(bind({})().skills.map((skill) => skill.name)).toEqual(['text']);
  expect(bind({ selectedByRole: true })).toThrow('skill latin is not UTF-8 text');
  expect(bind({ required: true })).toThrow('skill latin is not UTF-8 text');
});
