// The bundled skills and agents, read from their canonical files
// (docs/specs/features/builtin-crew.md, "생성과 검사"). `generate.ts` writes the outputs; the
// ordinary tests call the same functions.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { scan, treeHash } from '../../apps/server/src/harness/resource-tree.ts';
import { OutputContract } from '../../packages/contracts/src/definition.ts';
import type { BuiltinAgent, BuiltinSkill } from '../../packages/core/src/builtin-crew.ts';
import {
  builtinAgentTools,
  parseMarkdownAgent,
} from '../../packages/core/src/markdown-agent-import.ts';

const REPOSITORY = join(import.meta.dirname, '..', '..');
export const BUILTIN_ROOT = join(REPOSITORY, 'apps', 'server', 'resources', 'builtin');
export const BUILTIN_MODULE = join(
  REPOSITORY,
  'packages',
  'core',
  'src',
  'generated',
  'builtin-crew.ts',
);

/** The bundled packs in manifest order, with the source label an install shows. */
const PACKS: Record<string, (version: string) => string> = {
  core: (version) => `Corral ${version}`,
  coding: (version) => `Corral ${version}`,
  design: () => 'leeskills@4af91ab0be506de2323d5a6548c284a745bf1af3',
  browser: (version) => `Corral browser verification ${version}`,
};
export const PACK_IDS = Object.keys(PACKS);

/** The frontmatter of an agent file, and the tools it may name. */
const AGENT_FIELDS = ['name', 'description', 'tools', 'skills', 'metadata'];
const AGENT_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'];
const AGENT_METADATA = ['corral-output', 'corral-model-slot'];
const MODEL_SLOTS = ['a', 'b'];

export interface Frontmatter {
  keys: string[];
  fields: Record<string, string | Record<string, string>>;
  body: string;
  errors: string[];
}

const unquote = (value: string) => {
  if (value.startsWith('"')) return JSON.parse(value) as string;
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
};

/** The flat frontmatter skill files use: scalars and one level of indented string maps. */
export function readFrontmatter(text: string): Frontmatter {
  const lines = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  const result: Frontmatter = { keys: [], fields: {}, body: '', errors: [] };
  if (lines[0]?.trim() !== '---' || end < 0) {
    result.errors.push('no closed --- frontmatter block');
    result.body = text;
    return result;
  }
  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? '';
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!match) {
      result.errors.push(`unreadable frontmatter at line ${i + 1}`);
      continue;
    }
    const key = match[1] ?? '';
    const value = (match[2] ?? '').trim();
    result.keys.push(key);
    try {
      if (value) {
        result.fields[key] = unquote(value);
        continue;
      }
      const map: Record<string, string> = {};
      while (i + 1 < end && /^\s+\S/.test(lines[i + 1] ?? '')) {
        const entry = /^\s+([\w.-]+):\s*(.*)$/.exec(lines[++i] ?? '');
        if (entry) map[entry[1] ?? ''] = unquote((entry[2] ?? '').trim());
        else result.errors.push(`unreadable frontmatter at line ${i + 1}`);
      }
      result.fields[key] = map;
    } catch {
      result.errors.push(`unreadable value for ${key}`);
    }
  }
  result.body = lines.slice(end + 1).join('\n');
  return result;
}

export interface PackSkill {
  /** The skill folder name. */
  folder: string;
  directory: string;
  entry: string;
  frontmatter: Frontmatter;
}
export interface Pack {
  id: string;
  directory: string;
  manifest: { name?: string; version?: string; pi?: { skills?: string[]; extensions?: unknown } };
  files: ReturnType<typeof scan>;
  hash: string;
  skills: PackSkill[];
}

/** A pack as installation hashes it, and the skill folders its `pi.skills` paths hold. */
export function readPack(root: string, id: string, problems: string[]): Pack {
  const directory = join(root, id);
  const manifest = JSON.parse(
    readFileSync(join(directory, 'package.json'), 'utf8'),
  ) as Pack['manifest'];
  const files = scan(directory);
  const skills: PackSkill[] = [];
  for (const path of manifest.pi?.skills ?? []) {
    const base = join(directory, path);
    for (const folder of readdirSync(base).sort()) {
      const skill = join(base, folder);
      const entry = relative(directory, join(skill, 'SKILL.md')).split('\\').join('/');
      if (!statSync(skill).isDirectory() || !existsSync(join(skill, 'SKILL.md'))) {
        problems.push(`${id}/${relative(directory, skill)}: not a skill folder with a SKILL.md`);
        continue;
      }
      skills.push({
        folder,
        directory: skill,
        entry,
        frontmatter: readFrontmatter(readFileSync(join(skill, 'SKILL.md'), 'utf8')),
      });
    }
  }
  return { id, directory, manifest, files, hash: treeHash(files), skills };
}

/** Problems with one agent file: anything the parser refuses or the spec does not allow. */
export function agentProblems(
  file: string,
  source: string,
  skillNames: ReadonlySet<string>,
): string[] {
  const where = `agents/${file}`;
  const parsed = parseMarkdownAgent(source);
  const problems = parsed.errors.map((error) => `${where}: ${error}`);
  const keys = readFrontmatter(source).keys;
  for (const key of keys)
    if (!AGENT_FIELDS.includes(key)) problems.push(`${where}: field ${key} is not allowed`);
  for (const key of AGENT_FIELDS)
    if (!keys.includes(key)) problems.push(`${where}: field ${key} is missing`);
  if (`${parsed.name}.md` !== file)
    problems.push(`${where}: name ${parsed.name} is not the file name`);
  for (const tool of parsed.tools)
    if (!AGENT_TOOLS.includes(tool)) problems.push(`${where}: tool ${tool} is not allowed`);
  for (const skill of parsed.skills)
    if (!skillNames.has(skill)) problems.push(`${where}: skill ${skill} is not a built-in skill`);
  for (const key of Object.keys(parsed.metadata))
    if (!AGENT_METADATA.includes(key)) problems.push(`${where}: metadata ${key} is not allowed`);
  const output = parsed.metadata['corral-output'];
  if (!OutputContract.safeParse(output).success)
    problems.push(`${where}: corral-output ${output ?? '(missing)'} is not an output contract`);
  const slot = parsed.metadata['corral-model-slot'];
  if (!MODEL_SLOTS.includes(slot ?? ''))
    problems.push(`${where}: corral-model-slot ${slot ?? '(missing)'} is not a or b`);
  return problems;
}

const SKILL_FIELDS = ['name', 'description', 'license', 'compatibility', 'metadata'];
const SCRIPT = /\.(?:py|sh|bash|zsh|fish|ps1|bat|cmd|js|mjs|cjs|ts|mts|cts|rb|pl|php|exe)$/i;
const USE = /(?:^|[.;]\s+)Use (?:when|for|to|before|after|if|while|on|in)\b/;
type SkillRule =
  | 'fields'
  | 'name'
  | 'description'
  | 'stored'
  | 'when'
  | 'body'
  | 'parent-path'
  | 'invocation'
  | 'scripts'
  | 'corral';
/**
 * The design pack is upstream byte for byte (its NOTICE). Where its skills break a rule they
 * are named here, per rule; every other rule still applies to them.
 */
export const UPSTREAM_EXCEPTIONS: Record<string, Partial<Record<string, readonly SkillRule[]>>> = {
  design: {
    'audit-design': ['scripts'],
    'check-accessibility': ['scripts'],
    'design-workflow': ['parent-path'],
    'edit-copy': ['scripts'],
    'map-flows': ['scripts'],
    'plan-structure': ['scripts'],
    'review-components': ['scripts', 'parent-path'],
    'review-motion': ['scripts'],
    'review-visuals': ['scripts', 'parent-path'],
    'verify-changes': ['scripts'],
    'verify-content': ['scripts'],
  },
};

function filesUnder(directory: string, prefix = ''): string[] {
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const path = prefix ? `${prefix}/${name}` : name;
      return statSync(join(directory, name)).isDirectory()
        ? filesUnder(join(directory, name), path)
        : [path];
    });
}

/**
 * Where a bundled pack or skill breaks the format (builtin-crew.md, "파일 형식").
 * `exceptions: false` reports the upstream exceptions too, so each one can be shown to be needed.
 */
export function skillFormatProblems(root = BUILTIN_ROOT, { exceptions = true } = {}): string[] {
  const problems: string[] = [];
  for (const id of PACK_IDS) {
    const pack = readPack(root, id, problems);
    for (const file of ['LICENSE', 'NOTICE.md', 'package.json'])
      if (!existsSync(join(pack.directory, file))) problems.push(`${id}: ${file} is missing`);
    if (!pack.manifest.pi?.skills?.length) problems.push(`${id}: package.json has no pi.skills`);
    if (pack.manifest.pi?.extensions !== undefined)
      problems.push(`${id}: package.json declares pi.extensions`);
    for (const skill of pack.skills) {
      const { folder, frontmatter } = skill;
      const allowed = (exceptions && UPSTREAM_EXCEPTIONS[id]?.[folder]) || [];
      const report = (rule: SkillRule, message: string) => {
        if (!allowed.includes(rule)) problems.push(`${id}/${folder}: ${message}`);
      };
      for (const error of frontmatter.errors) report('fields', error);
      for (const key of frontmatter.keys)
        if (key === 'disable-model-invocation')
          report('invocation', 'disable-model-invocation is not allowed in a built-in skill');
        else if (!SKILL_FIELDS.includes(key)) report('fields', `field ${key} is not allowed`);
      const { name, description, compatibility, metadata } = frontmatter.fields;
      if (typeof name !== 'string' || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
        report('name', `name ${String(name)} is not 1–64 lowercase letters, digits and hyphens`);
      else if (name !== folder) report('name', `name ${name} is not the folder name`);
      if (typeof description !== 'string' || !description.trim() || description.length > 1024)
        report('description', 'description must have 1–1,024 characters');
      else {
        if (description.length > 1000)
          report('stored', `description has ${description.length} characters; Corral stores 1,000`);
        if (!USE.test(description)) report('when', 'description does not say when to use it');
      }
      if (metadata !== undefined && typeof metadata !== 'object')
        report('fields', 'metadata must be a map of strings');
      const forCorral = typeof compatibility === 'string' && /\bCorral\b/.test(compatibility);
      if (typeof name === 'string' && name.startsWith('corral-') !== forCorral)
        report(
          'corral',
          forCorral
            ? 'compatibility names Corral but the name has no corral- prefix'
            : 'a corral- skill must name Corral in compatibility',
        );
      if (frontmatter.body.replace(/\n+$/, '').split('\n').length > 500)
        report('body', 'body is longer than 500 lines');
      for (const file of filesUnder(skill.directory)) {
        const path = join(skill.directory, file);
        if (file.startsWith('scripts/') || SCRIPT.test(file) || statSync(path).mode & 0o111)
          report('scripts', `${file} is a script or an executable`);
        if (file.endsWith('.md') && readFileSync(path, 'utf8').includes('../'))
          report('parent-path', `${file} uses a ../ path`);
      }
    }
  }
  return problems;
}

export interface Builtin {
  packs: Pack[];
  skills: BuiltinSkill[];
  agents: BuiltinAgent[];
  problems: string[];
}

/** Everything the outputs are made from, and every reason they cannot be made. */
export function readBuiltin(root = BUILTIN_ROOT): Builtin {
  const problems: string[] = [];
  for (const name of readdirSync(root).sort())
    if (statSync(join(root, name)).isDirectory() && name !== 'agents' && !PACK_IDS.includes(name))
      problems.push(`${name}: a pack folder the generator does not list`);
  const packs = PACK_IDS.map((id) => readPack(root, id, problems));
  const skills: BuiltinSkill[] = [];
  for (const pack of packs)
    for (const skill of pack.skills) {
      const { name, description } = skill.frontmatter.fields;
      if (typeof name !== 'string' || typeof description !== 'string') {
        problems.push(`${pack.id}/${skill.entry}: name and description must be strings`);
        continue;
      }
      const other = skills.find((candidate) => candidate.name === name);
      if (other)
        problems.push(`${pack.id}/${skill.folder}: skill name ${name} is also in ${other.pack}`);
      skills.push({
        name,
        description,
        pack: pack.id,
        resourceHash: pack.hash,
        entry: skill.entry,
      });
    }
  const names = new Set(skills.map((skill) => skill.name));
  const agents: BuiltinAgent[] = [];
  const agentFolder = join(root, 'agents');
  for (const file of readdirSync(agentFolder).sort()) {
    const source = readFileSync(join(agentFolder, file), 'utf8');
    const found = agentProblems(file, source, names);
    problems.push(...found);
    if (found.length) continue;
    const parsed = parseMarkdownAgent(source);
    agents.push({
      id: parsed.name,
      description: parsed.description,
      ...builtinAgentTools(parsed.tools),
      outputContract: OutputContract.parse(parsed.metadata['corral-output']),
      modelSlot: parsed.metadata['corral-model-slot'] === 'b' ? 'b' : 'a',
      prompt: parsed.prompt,
      // agentProblems has refused any name that is not a built-in skill.
      skills: skills
        .filter((skill) => parsed.skills.includes(skill.name))
        .sort((a, b) => parsed.skills.indexOf(a.name) - parsed.skills.indexOf(b.name))
        .map(({ name, resourceHash, entry }) => ({ name, resourceHash, entry })),
    });
  }
  return { packs, skills, agents, problems };
}

export function renderManifest(packs: readonly Pack[]): string {
  const manifest = Object.fromEntries(
    packs.map((pack) => [
      pack.id,
      {
        hash: pack.hash,
        files: pack.files.length,
        skills: pack.skills.length,
        source: PACKS[pack.id]?.(pack.manifest.version ?? ''),
      },
    ]),
  );
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function renderModule(skills: readonly BuiltinSkill[], agents: readonly BuiltinAgent[]) {
  return [
    '// Generated by `pnpm builtin:generate` from apps/server/resources/builtin. Do not edit;',
    '// change the canonical files and generate again (`pnpm builtin:check` fails when stale).',
    "import type { BuiltinAgent, BuiltinSkill } from '../builtin-crew.ts';",
    '',
    `export const BUILTIN_SKILLS: readonly BuiltinSkill[] = ${JSON.stringify(skills, null, 2)};`,
    '',
    `export const BUILTIN_AGENTS: readonly BuiltinAgent[] = ${JSON.stringify(agents, null, 2)};`,
    '',
  ].join('\n');
}

/** The output files and their content, or the problems that stop generation. */
export function builtinOutputs(options: { root?: string; module?: string } = {}) {
  const root = options.root ?? BUILTIN_ROOT;
  const builtin = readBuiltin(root);
  if (builtin.problems.length) return { problems: builtin.problems, files: [] };
  return {
    problems: [],
    files: [
      { path: join(root, 'manifest.json'), text: renderManifest(builtin.packs) },
      {
        path: options.module ?? BUILTIN_MODULE,
        text: renderModule(builtin.skills, builtin.agents),
      },
    ],
  };
}

/** `pnpm builtin:check`: the outputs that differ from what generation would write. */
export function staleBuiltin(options: { root?: string; module?: string } = {}): string[] {
  const { problems, files } = builtinOutputs(options);
  if (problems.length) return problems;
  return files.flatMap(({ path, text }) => {
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {}
    return current === text ? [] : [`stale: ${relative(REPOSITORY, path)}`];
  });
}
