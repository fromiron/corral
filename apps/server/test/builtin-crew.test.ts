import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_AGENTS, BUILTIN_SKILLS, parseMarkdownAgent, toolTargets } from '@corral/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentProblems,
  BUILTIN_MODULE,
  BUILTIN_ROOT,
  readBuiltin,
  skillFormatProblems,
  staleBuiltin,
  UPSTREAM_EXCEPTIONS,
} from '../../../tools/builtin/builtin.ts';

// docs/specs/features/builtin-crew.md, "생성과 검사". Counterexamples edit a copy of the tree.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function copyTree() {
  const base = mkdtempSync(join(tmpdir(), 'corral-builtin-crew-'));
  roots.push(base);
  const root = join(base, 'builtin');
  const module = join(base, 'builtin-crew.ts');
  cpSync(BUILTIN_ROOT, root, { recursive: true });
  cpSync(BUILTIN_MODULE, module);
  return { root, module };
}
function edit(path: string, change: (text: string) => string) {
  const before = readFileSync(path, 'utf8');
  const after = change(before);
  expect(after).not.toBe(before);
  writeFileSync(path, after);
}
const names = new Set(BUILTIN_SKILLS.map((skill) => skill.name));
const agentFile = (id: string) => readFileSync(join(BUILTIN_ROOT, 'agents', `${id}.md`), 'utf8');

describe('generated built-in files', () => {
  it('match the canonical files', () => {
    expect(staleBuiltin()).toEqual([]);
  });

  it('go stale when a skill file changes and nothing is generated again', () => {
    const tree = copyTree();
    expect(staleBuiltin(tree)).toEqual([]);
    edit(
      join(tree.root, 'coding/skills/root-cause/SKILL.md'),
      (text) => `${text}\nOne more line.\n`,
    );
    expect(staleBuiltin(tree)).toEqual([
      expect.stringMatching(/stale: .*builtin\/manifest\.json$/),
      expect.stringMatching(/stale: .*builtin-crew\.ts$/),
    ]);
  });
});

describe('built-in skills', () => {
  it('follow the skill format, with the design pack’s upstream exceptions named', () => {
    expect(skillFormatProblems()).toEqual([]);
    // Every named exception is one the upstream content needs.
    const unexcused = skillFormatProblems(BUILTIN_ROOT, { exceptions: false });
    for (const [skill, rules] of Object.entries(UPSTREAM_EXCEPTIONS.design ?? {}))
      for (const rule of rules ?? [])
        expect(
          unexcused.some(
            (problem) =>
              problem.startsWith(`design/${skill}: `) &&
              (rule === 'scripts' ? /script/.test(problem) : /\.\.\//.test(problem)),
          ),
          `${skill} ${rule}`,
        ).toBe(true);
  });

  it('name each skill that breaks the format, and why', () => {
    const tree = copyTree();
    const skill = (path: string) => join(tree.root, path, 'SKILL.md');
    edit(skill('coding/skills/root-cause'), (text) =>
      text.replace('name: root-cause', 'name: root-causes'),
    );
    edit(skill('core/skills/corral-review'), (text) =>
      text.replace('license: MIT', 'license: MIT\ndisable-model-invocation: true'),
    );
    edit(skill('coding/skills/prove-it'), (text) => `${text}\nSee ../break-it/SKILL.md.\n`);
    edit(skill('coding/skills/shape-first'), (text) => `${text}${'line\n'.repeat(500)}`);
    edit(skill('coding/skills/plain-prose'), (text) => text.replace(/ Use when drafting[^"]*/, ''));
    edit(skill('coding/skills/doc-writing'), (text) =>
      text.replace('license: MIT', `license: MIT\nallowed-tools: Bash`),
    );
    edit(skill('core/skills/corral-handoff'), (text) =>
      text.replace('compatibility: "Designed for Corral."\n', ''),
    );
    // Over the 1,000 characters Corral stores, under the 1,024 Agent Skills allows.
    const original =
      BUILTIN_SKILLS.find((item) => item.name === 'measure-first')?.description ?? '';
    const measured = 1010;
    edit(skill('coding/skills/measure-first'), (text) =>
      text.replace(original, `${'x'.repeat(measured - original.length - 1)} ${original}`),
    );
    mkdirSync(join(tree.root, 'coding/skills/break-it/scripts'));
    writeFileSync(join(tree.root, 'coding/skills/break-it/scripts/run.md'), 'run\n');
    writeFileSync(join(tree.root, 'coding/skills/break-it/check.py'), 'print(1)\n');
    writeFileSync(join(tree.root, 'coding/skills/change-impact/tool'), 'binary\n');
    chmodSync(join(tree.root, 'coding/skills/change-impact/tool'), 0o755);
    // The design exceptions are per rule: a design skill still fails every other rule.
    edit(skill('design/skills/audit-design'), (text) =>
      text.replace('name: audit-design', 'name: audit'),
    );
    expect(skillFormatProblems(tree.root).sort()).toEqual(
      [
        'coding/break-it: check.py is a script or an executable',
        'coding/break-it: scripts/run.md is a script or an executable',
        'coding/change-impact: tool is a script or an executable',
        'coding/doc-writing: field allowed-tools is not allowed',
        `coding/measure-first: description has ${measured} characters; Corral stores 1,000`,
        'coding/plain-prose: description does not say when to use it',
        'coding/prove-it: SKILL.md uses a ../ path',
        'coding/root-cause: name root-causes is not the folder name',
        'coding/shape-first: body is longer than 500 lines',
        'core/corral-handoff: a corral- skill must name Corral in compatibility',
        'core/corral-review: disable-model-invocation is not allowed in a built-in skill',
        'design/audit-design: name audit is not the folder name',
      ].sort(),
    );
  });

  it('have names unique across the bundled packs and descriptions Corral can store', () => {
    expect(BUILTIN_SKILLS).toHaveLength(names.size);
    for (const skill of BUILTIN_SKILLS) expect(skill.description.length).toBeLessThanOrEqual(1000);
    const tree = copyTree();
    cpSync(join(tree.root, 'coding/skills/root-cause'), join(tree.root, 'core/skills/root-cause'), {
      recursive: true,
    });
    expect(readBuiltin(tree.root).problems).toEqual([
      'coding/root-cause: skill name root-cause is also in core',
    ]);
  });

  it('list every skill of every pack once, with its pack, hash and entry', () => {
    const { packs } = readBuiltin();
    expect(BUILTIN_SKILLS.map((skill) => `${skill.pack}/${skill.name}`)).toEqual(
      packs.flatMap((pack) => pack.skills.map((skill) => `${pack.id}/${skill.folder}`)),
    );
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.resourceHash).toBe(packs.find((pack) => pack.id === skill.pack)?.hash);
      expect(skill.entry).toBe(`skills/${skill.name}/SKILL.md`);
    }
  });
});

describe('built-in agent files', () => {
  it('pass the import parser and use only built-in skills and the allowed tools and metadata', () => {
    const { agents, problems } = readBuiltin();
    expect(problems).toEqual([]);
    expect(agents.map((agent) => agent.id)).toEqual([
      'adversary',
      'architect',
      'builder',
      'explainer',
      'investigator',
      'judge',
      'researcher',
      'reviewer',
      'verifier',
      'writer',
    ]);
    expect(BUILTIN_AGENTS).toEqual(agents);
    for (const agent of agents) {
      const parsed = parseMarkdownAgent(agentFile(agent.id));
      expect(parsed.errors).toEqual([]);
      expect(parsed.name).toBe(agent.id);
      expect(parsed.prompt).toBe(agent.prompt);
      expect(agent.skills.map((skill) => skill.name)).toEqual(parsed.skills);
      for (const ref of agent.skills)
        expect(BUILTIN_SKILLS).toContainEqual(expect.objectContaining(ref));
    }
  });

  it('name the agent and the value when a skill, tool, metadata value or name is not allowed', () => {
    const source = agentFile('adversary');
    const problems = (text: string, file = 'adversary.md') => agentProblems(file, text, names);
    expect(problems(source)).toEqual([]);
    expect(problems(source.replace('  - break-it', '  - break-everything'))).toEqual([
      'agents/adversary.md: skill break-everything is not a built-in skill',
    ]);
    expect(problems(source.replace('Read, Glob, Grep, Bash', 'Read, Task'))).toEqual([
      'agents/adversary.md: tool Task is not allowed',
    ]);
    expect(problems(source.replace('Read, Glob, Grep, Bash', 'Read, SecretTool'))).toEqual([
      'agents/adversary.md: Unknown tool: SecretTool',
      'agents/adversary.md: tool SecretTool is not allowed',
    ]);
    expect(problems(source.replace('corral-model-slot: "a"', 'corral-model-slot: "c"'))).toEqual([
      'agents/adversary.md: corral-model-slot c is not a or b',
    ]);
    expect(problems(source.replace('corral-output: "notes"', 'corral-output: "summary"'))).toEqual([
      'agents/adversary.md: corral-output summary is not an output contract',
    ]);
    expect(
      problems(source.replace('corral-model-slot: "a"', 'corral-model-slot: "a"\n  color: "red"')),
    ).toEqual(['agents/adversary.md: metadata color is not allowed']);
    expect(problems(source.replace('tools:', 'model: provider/model\ntools:'))).toEqual([
      'agents/adversary.md: field model is not allowed',
    ]);
    expect(problems(source, 'breaker.md')).toEqual([
      'agents/breaker.md: name adversary is not the file name',
    ]);
  });

  it('stop generation when an agent file names a skill that is not built in', () => {
    const tree = copyTree();
    edit(join(tree.root, 'agents/judge.md'), (text) =>
      text.replace('  - plain-prose', '  - ghost'),
    );
    expect(staleBuiltin(tree)).toEqual(['agents/judge.md: skill ghost is not a built-in skill']);
  });

  it('take Corral tools from the import table plus the tools a preset carries with them', () => {
    for (const agent of BUILTIN_AGENTS) {
      const sources = parseMarkdownAgent(agentFile(agent.id)).tools;
      const tools: string[] = [...agent.workTools, ...agent.collaborationTools];
      const mapped = sources.flatMap(toolTargets);
      const expected = new Set([
        ...mapped,
        'write_artifact',
        'preview_file',
        'read_artifact',
        'submit_result',
        'ask_user',
        ...(mapped.includes('run_command') ? ['preview_app', 'preview_action'] : []),
        ...(mapped.includes('write_file') ? ['delete_file', 'move_file'] : []),
      ]);
      expect(new Set(tools), agent.id).toEqual(expected);
    }
    // An import proposes only the table's translations.
    expect(['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'].map(toolTargets)).toEqual([
      ['read_file'],
      ['list_files'],
      [],
      ['run_command'],
      ['write_file'],
      ['write_file'],
    ]);
  });
});
