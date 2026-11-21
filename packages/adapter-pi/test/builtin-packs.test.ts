import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { BUILTIN_SKILLS } from '@corral/core';
import {
  DefaultPackageManager,
  loadSkills,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it } from 'vitest';

// docs/specs/features/builtin-crew.md, "생성과 검사": the Pi version Corral uses reads every
// bundled pack without a diagnostic (warnings included, which installation tolerates), and the
// skills it reports are the generated list.
const BUILTIN = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'apps',
  'server',
  'resources',
  'builtin',
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The package worker's discovery (package-worker-main.ts), keeping Pi's diagnostics. */
async function piSkills(directory: string) {
  const agentDir = mkdtempSync(join(tmpdir(), 'corral-pi-agent-'));
  roots.push(agentDir);
  const settingsManager = SettingsManager.inMemory({ npmCommand: ['npm', '--ignore-scripts'] });
  const manager = new DefaultPackageManager({ cwd: directory, agentDir, settingsManager });
  const paths = await manager.resolveExtensionSources([directory], { temporary: true });
  return loadSkills({
    cwd: directory,
    agentDir,
    skillPaths: paths.skills.filter((entry) => entry.enabled).map((entry) => entry.path),
    includeDefaults: false,
  });
}

it('Pi loads each bundled pack with no diagnostics and reports the generated skills', async () => {
  const packs = [...new Set(BUILTIN_SKILLS.map((skill) => skill.pack))];
  expect(packs).toEqual(['core', 'coding', 'design', 'browser']);
  for (const pack of packs) {
    const directory = join(BUILTIN, pack);
    const { skills, diagnostics } = await piSkills(directory);
    expect(diagnostics, pack).toEqual([]);
    expect(
      skills
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          entry: relative(directory, skill.filePath).split(sep).join('/'),
          disableModelInvocation: skill.disableModelInvocation,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      pack,
    ).toEqual(
      BUILTIN_SKILLS.filter((skill) => skill.pack === pack)
        .map(({ name, description, entry }) => ({
          name,
          description,
          entry,
          disableModelInvocation: false,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }
}, 30000);
