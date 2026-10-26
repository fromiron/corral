import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CORRAL_EXTENSION, spikeSession } from './sdk-session.ts';

// S4: a Corral session loads only the resources bound to the role.
// Pi's own discovery (personal ~/.pi/agent and ~/.agents, project .pi/ and .agents/, context
// files such as AGENTS.md) must load nothing, even when those places are full of resources.

const TRAP = '__corralTrap';
let root = '';
let savedHome: string | undefined;
let dispose: (() => void) | undefined;

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const trapExtension = (label: string) =>
  `export default function () { (globalThis.${TRAP} ??= []).push(${JSON.stringify(label)}); }\n`;
const skill = (name: string, text: string) =>
  `---\nname: ${name}\ndescription: ${text}\n---\n\n# ${name}\n\n${text}\n`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'corral-har-s4-'));
  savedHome = process.env.HOME;
  const home = join(root, 'home');
  process.env.HOME = home;
  delete (globalThis as Record<string, unknown>)[TRAP];
  // Personal resources Pi would discover.
  write(join(home, '.pi/agent/extensions/trap.ts'), trapExtension('home extension'));
  write(
    join(home, '.pi/agent/skills/trap-home/SKILL.md'),
    skill('trap-home', 'TRAP personal skill.'),
  );
  write(join(home, '.pi/agent/AGENTS.md'), 'TRAP personal AGENTS.md\n');
  write(
    join(home, '.agents/skills/trap-agents/SKILL.md'),
    skill('trap-agents', 'TRAP agents skill.'),
  );
  // Project resources Pi would discover (and ask project trust for).
  const work = join(root, 'work');
  write(join(work, '.pi/settings.json'), '{}\n');
  write(join(work, '.pi/extensions/trap.ts'), trapExtension('project extension'));
  write(
    join(work, '.pi/skills/trap-project/SKILL.md'),
    skill('trap-project', 'TRAP project skill.'),
  );
  write(join(work, '.pi/SYSTEM.md'), 'TRAP project SYSTEM.md\n');
  write(join(work, '.pi/APPEND_SYSTEM.md'), 'TRAP project APPEND_SYSTEM.md\n');
  write(join(work, '.agents/skills/trap-project2/SKILL.md'), skill('trap-project2', 'TRAP skill.'));
  write(join(work, 'AGENTS.md'), 'TRAP project AGENTS.md\n');
  write(join(work, 'CLAUDE.md'), 'TRAP project CLAUDE.md\n');
  // What the role is bound to.
  write(
    join(root, 'bound/extension.ts'),
    `export default function (pi) {
  pi.registerTool({
    name: 'bound_tool', label: 'bound_tool', description: 'Bound.',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: undefined }),
  });
}\n`,
  );
  write(join(root, 'bound/skills/good/SKILL.md'), skill('good', 'The bound skill.'));
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

describe('S4: only bound resources load', () => {
  it('loads the bound extension and skill, and Corral last', async () => {
    const run = await spikeSession({
      responses: [fauxAssistantMessage('Hello.')],
      cwd: join(root, 'work'),
      extensionPaths: [join(root, 'bound/extension.ts')],
      skillPaths: [join(root, 'bound/skills')],
    });
    dispose = run.dispose;
    const loaded = run.resourceLoader.getExtensions();
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions.map((e) => e.path)).toEqual([
      join(root, 'bound/extension.ts'),
      CORRAL_EXTENSION,
    ]);
    expect(run.resourceLoader.getSkills().skills.map((s) => s.name)).toEqual(['good']);
    expect(run.session.getActiveToolNames()).toEqual(['bound_tool']);
  });

  it('nothing from the personal or project folders reaches the run', async () => {
    const run = await spikeSession({
      responses: [fauxAssistantMessage('Hello.')],
      cwd: join(root, 'work'),
      extensionPaths: [join(root, 'bound/extension.ts')],
      skillPaths: [join(root, 'bound/skills')],
    });
    dispose = run.dispose;
    await run.session.prompt('Say hello.');
    expect((globalThis as Record<string, unknown>)[TRAP]).toBeUndefined();
    expect(run.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
    const request = run.log.requests[0]?.systemPrompt ?? '';
    expect(request).toContain('You are one role of a Corral team.');
    expect(request).not.toContain('TRAP');
  });
});
