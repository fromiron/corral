import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fauxAssistantMessage, fauxToolCall, Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type SpikeOptions, spikeSession } from './sdk-session.ts';

// S5 (CR-018, plan §6 H1): Agent Skills reach the model through Corral, with no local folder
// in what is sent or recorded.
// - Pi lists skills only when a tool named `read` (or `bash`) is declared, so Corral offers a
//   `read` that serves bound skill files under virtual `skills/<name>/…` paths.
// - A mandatory skill goes into a system prompt section, which compaction keeps.
// - Pi always adds the absolute working folder as the `cwd` section; Corral replaces it.

let root = '';
let dispose: (() => void) | undefined;
const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'corral-har-s5-'));
  write(
    join(root, 'bound/skills/good/SKILL.md'),
    '---\nname: good\ndescription: Write good notes. Use for any note.\n---\n\nRead references/style.md first.\n',
  );
  write(join(root, 'bound/skills/good/references/style.md'), 'Use short sentences.\n');
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** Corral's read tool, reduced to skill files: `skills/<name>/<file>` inside the bound folder. */
function corralRead(reads: string[]): ToolDefinition {
  return {
    name: 'read',
    label: 'read',
    description: 'Read a file by relative path.',
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, input) => {
      const params = input as { path: string };
      const base = join(root, 'bound');
      const target = join(base, params.path);
      if (relative(base, target).startsWith('..')) throw new Error('outside the bound files');
      reads.push(params.path);
      return {
        content: [{ type: 'text', text: readFileSync(target, 'utf8') }],
        details: undefined,
      };
    },
  };
}

const virtualPaths: Pick<SpikeOptions, 'skillsOverride'> = {
  skillsOverride: (base) => ({
    ...base,
    skills: base.skills.map((s) => ({
      ...s,
      filePath: `skills/${s.name}/SKILL.md`,
      baseDir: `skills/${s.name}`,
    })),
  }),
};

/** What Corral's own extension would do: hide the folder and add mandatory skill bodies. */
const corralSections = (mandatory: Record<string, string>) => (pi: ExtensionAPI) => {
  pi.on('before_agent_start', async (event) => {
    const sections = event.systemPromptOptions?.sections as Record<string, string> | undefined;
    if (!sections) return;
    sections.cwd = 'The working copy root (paths are relative to it).';
    for (const [name, body] of Object.entries(mandatory)) sections[`skill_${name}`] = body;
  });
};

describe('S5: skills through Corral', () => {
  it('[TC-HAR-005-H] lists the bound skill under a virtual path and the model reads it with Corral read', async () => {
    const reads: string[] = [];
    const run = await spikeSession({
      responses: [
        fauxAssistantMessage([fauxToolCall('read', { path: 'skills/good/SKILL.md' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage([fauxToolCall('read', { path: 'skills/good/references/style.md' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('Done.'),
      ],
      skillPaths: [join(root, 'bound/skills')],
      customTools: [corralRead(reads)],
      extensions: [corralSections({})],
      ...virtualPaths,
    });
    dispose = run.dispose;
    await run.session.prompt('Write a note.');
    const request = run.log.requests[0]?.systemPrompt ?? '';
    expect(request).toContain('<location>skills/good/SKILL.md</location>');
    expect(reads).toEqual(['skills/good/SKILL.md', 'skills/good/references/style.md']);
    for (const r of run.log.requests) {
      expect(r.systemPrompt).not.toContain(root);
      expect(r.systemPrompt).not.toContain(run.scratch);
    }
  });

  it('[TC-HAR-005-N] without a read tool Pi does not list skills at all', async () => {
    const run = await spikeSession({
      responses: [fauxAssistantMessage('Hi.')],
      skillPaths: [join(root, 'bound/skills')],
    });
    dispose = run.dispose;
    await run.session.prompt('Hi.');
    expect(run.resourceLoader.getSkills().skills.map((s) => s.name)).toEqual(['good']);
    expect(run.log.requests[0]?.systemPrompt).not.toContain('<available_skills>');
  });

  it('[TC-HAR-005-H] a mandatory skill body stays in the request after compaction', async () => {
    const run = await spikeSession({
      responses: Array.from({ length: 8 }, () => fauxAssistantMessage('Ok.')),
      extensions: [corralSections({ good: '<skill name="good">Use short sentences.</skill>' })],
      settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1 } },
    });
    dispose = run.dispose;
    await run.session.prompt('First.');
    await run.session.prompt('Second.');
    await run.session.compact();
    await run.session.prompt('Third.');
    const last = run.log.requests.at(-1)?.systemPrompt ?? '';
    expect(last).toContain('Use short sentences.');
    // Turn requests carry it; the summarization calls in between use Pi's own summary prompt.
    const withBody = run.log.requests.filter((r) =>
      r.systemPrompt.includes('Use short sentences.'),
    );
    expect(withBody).toHaveLength(3);
    expect(run.log.requests.length).toBeGreaterThan(3);
  });

  it('[TC-HAR-005-N] Pi cannot expand /skill:name from a virtual path; Corral must expand it', async () => {
    const run = await spikeSession({
      responses: [fauxAssistantMessage('Ok.')],
      skillPaths: [join(root, 'bound/skills')],
      customTools: [corralRead([])],
      ...virtualPaths,
    });
    dispose = run.dispose;
    await run.session.prompt('/skill:good write a note');
    const user = run.session.messages.find((m) => m.role === 'user');
    expect(JSON.stringify(user)).toContain('/skill:good write a note');
  });
});
