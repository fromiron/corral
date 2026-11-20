import {
  CollaborationTool,
  type CorralDefinition,
  CorralDefinitionDraft,
  type EffectiveHarnessSnapshot,
  type RoleSkillRef,
  WorkTool,
} from '@corral/contracts';

export interface AgentImportDraft {
  definition: CorralDefinition;
}
export interface AgentImportProfile {
  profileId: string;
  available: boolean;
}

export const MAX_AGENT_MARKDOWN_BYTES = 32768;
function utf8Length(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes > MAX_AGENT_MARKDOWN_BYTES) break;
  }
  return bytes;
}
const excluded = new Set(['ask_user', 'update_plan']);
// These are proposed translations, never silently enabled. Grep has no equivalent in the
// file broker; internet search/read_file are deliberately not claimed to be content search.
// Built-in agent files go through the same table (builtinAgentTools below).
export const MARKDOWN_TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  Read: ['read_file'],
  Glob: ['list_files'],
  Grep: [],
  Bash: ['run_command'],
  Edit: ['write_file'],
  Write: ['write_file'],
  Task: ['spawn_subagents'],
  BrowserPreview: ['preview_file', 'preview_app'],
};
export function toolTargets(source: string): string[] {
  const supported = [...WorkTool.options, ...CollaborationTool.options] as string[];
  if (excluded.has(source)) return [];
  const candidates = Object.hasOwn(MARKDOWN_TOOL_ALIASES, source)
    ? (MARKDOWN_TOOL_ALIASES[source] ?? [])
    : [source];
  return candidates.filter((target) => supported.includes(target));
}
function knownTool(tool: string): boolean {
  return (
    Object.hasOwn(MARKDOWN_TOOL_ALIASES, tool) ||
    WorkTool.safeParse(tool).success ||
    CollaborationTool.safeParse(tool).success
  );
}

/**
 * A built-in agent file's tools as its preset gives them (builtin-crew.md, "파일 형식"): the
 * import table above, then the tools that travel with them. An import still proposes only the
 * table's translations.
 */
export function builtinAgentTools(tools: readonly string[]): {
  workTools: WorkTool[];
  collaborationTools: CollaborationTool[];
} {
  const granted = new Set<string>([
    ...tools.flatMap(toolTargets),
    'write_artifact',
    'preview_file',
    'read_artifact',
    'submit_result',
    'ask_user',
  ]);
  if (granted.has('run_command'))
    for (const tool of ['preview_app', 'preview_action']) granted.add(tool);
  if (granted.has('write_file')) for (const tool of ['delete_file', 'move_file']) granted.add(tool);
  return {
    workTools: WorkTool.options.filter((tool) => granted.has(tool)),
    collaborationTools: CollaborationTool.options.filter((tool) => granted.has(tool)),
  };
}

export interface MarkdownAgent {
  name: string;
  description: string;
  prompt: string;
  model: string;
  tools: string[];
  /** Skill names; an import attaches the same-named usable skills (agent-library.md). */
  skills: string[];
  /** Read and kept, never used by an import. */
  metadata: Record<string, string>;
  errors: string[];
}

const FIELDS = ['name', 'description', 'prompt', 'model', 'tools', 'skills', 'metadata'];
// What YAML 1.2 reads as a null, boolean or number, plus flow and block collections.
const NON_STRING =
  /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?|0o[0-7]+|0x[0-9a-fA-F]+|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$|^[[|>]/;

/** Deliberately bounded frontmatter: flat strings, literal/folded blocks, string lists and one
 * indented map of strings. Unsupported YAML constructs/fields fail visibly rather than being
 * interpreted differently.
 */
export function parseMarkdownAgent(source: string): MarkdownAgent {
  const result: MarkdownAgent = {
    name: '',
    description: '',
    prompt: '',
    model: '',
    tools: [],
    skills: [],
    metadata: {},
    errors: [],
  };
  if (utf8Length(source) > MAX_AGENT_MARKDOWN_BYTES) {
    result.errors.push('Markdown exceeds 32 KiB.');
    return result;
  }
  const lines = source
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (lines[0]?.trim() !== '---' || end < 0) {
    result.errors.push('Expected a closed --- frontmatter block.');
    return result;
  }
  const fields = new Map<string, string | string[] | Record<string, string>>();
  const scalar = (value: string): string => {
    const text = value.trim();
    if (text.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'string') return parsed;
      } catch {
        /* report below */
      }
      result.errors.push('Invalid quoted string.');
      return '';
    }
    if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
    if (/^[&*!{]/.test(text) || text.startsWith("'")) {
      result.errors.push('Unsupported YAML value; use a plain or quoted string.');
      return '';
    }
    return text;
  };
  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? '';
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) {
      result.errors.push(`Invalid frontmatter at line ${i + 1}.`);
      continue;
    }
    const key = match[1] ?? '';
    const value = match[2] ?? '';
    if (!FIELDS.includes(key)) result.errors.push(`Unsupported field: ${key}`);
    if (fields.has(key)) result.errors.push(`Duplicate field: ${key}`);
    if (key === 'metadata') {
      const map: Record<string, string> = {};
      const invalid = (line: number) =>
        result.errors.push(`metadata must be an indented map of string values (line ${line}).`);
      if (value.trim()) invalid(i + 1);
      let indent: number | undefined;
      while (i + 1 < end && (/^\s/.test(lines[i + 1] ?? '') || !lines[i + 1]?.trim())) {
        const row = lines[++i] ?? '';
        if (!row.trim() || row.trimStart().startsWith('#')) continue;
        const depth = row.length - row.trimStart().length;
        indent ??= depth;
        const entry = /^([A-Za-z0-9][A-Za-z0-9_.-]*):\s*(.*)$/.exec(row.trimStart());
        const raw = entry?.[2]?.trim() ?? '';
        if (depth !== indent || !entry || !raw || NON_STRING.test(raw)) {
          invalid(i + 1);
          continue;
        }
        const name = entry[1] ?? '';
        if (Object.hasOwn(map, name)) result.errors.push(`Duplicate metadata key: ${name}`);
        map[name] = scalar(raw);
      }
      if (indent === undefined && !value.trim()) invalid(i + 1);
      fields.set(key, map);
    } else if (/^[|>][-+]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < end && (/^\s/.test(lines[i + 1] ?? '') || !lines[i + 1]?.trim()))
        block.push(lines[++i] ?? '');
      const indent = Math.min(
        ...block.filter((row) => row.trim()).map((row) => row.length - row.trimStart().length),
      );
      // A list field read as text would silently become an empty list.
      if (key === 'tools' || key === 'skills') {
        result.errors.push(`${key} must be a list, not a block of text.`);
        fields.set(key, []);
        continue;
      }
      fields.set(
        key,
        block
          .map((row) => row.slice(Number.isFinite(indent) ? indent : 0))
          .join(value.startsWith('>') ? ' ' : '\n')
          .trim(),
      );
    } else if (key === 'tools' || key === 'skills') {
      let values: string[];
      if (!value) {
        values = [];
        while (i + 1 < end && /^\s+-\s*/.test(lines[i + 1] ?? ''))
          values.push((lines[++i] ?? '').replace(/^\s+-\s*/, ''));
      } else {
        const list = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
        values = list.split(',').filter((part) => part.trim());
      }
      fields.set(key, values.map(scalar));
    } else fields.set(key, scalar(value));
  }
  for (const key of ['name', 'description', 'prompt', 'model'] as const) {
    const value = fields.get(key);
    if (typeof value === 'string') result[key] = value.trim();
  }
  const body = lines
    .slice(end + 1)
    .join('\n')
    .trim();
  if (result.prompt && body)
    result.errors.push('Use either prompt frontmatter or the Markdown body, not both.');
  else result.prompt ||= body;
  const tools = fields.get('tools');
  if (Array.isArray(tools)) result.tools = [...new Set(tools)];
  const skills = fields.get('skills');
  if (Array.isArray(skills)) result.skills = [...new Set(skills)];
  const metadata = fields.get('metadata');
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata))
    result.metadata = metadata;
  if (!fields.has('tools')) result.errors.push('Declare tools explicitly (tools: [] for none).');
  for (const tool of result.tools) {
    if (!knownTool(tool)) result.errors.push(`Unknown tool: ${tool}`);
  }
  if (!result.name || result.name.length > 120)
    result.errors.push('Name must contain 1–120 characters.');
  if (!result.description || result.description.length > 2000)
    result.errors.push('Description must contain 1–2000 characters.');
  if (!result.prompt || result.prompt.length > 18000)
    result.errors.push('Prompt must contain 1–18000 characters.');
  return result;
}

/** A usable skill entry (installed, its package on, trusted, not archived) an import can attach. */
export interface ImportableSkill extends RoleSkillRef {
  /** The skill's own name from its SKILL.md, not a display name. */
  name: string;
  /** A later version is linked to this entry. */
  superseded: boolean;
  /** When its package was installed. */
  installedAt: string;
}

/**
 * A Markdown agent's `skills` as the imported role's skill choice (agent-library.md, "정의의 선택
 * 필드"). Each name takes one same-named usable skill, chosen as harness-contract.md chooses the
 * other usable skills: an entry no later version follows, then the latest installed. A name
 * nothing answers comes back in `unresolved` for the review to show; it is never dropped silently.
 */
export function attachSkillsByName(
  names: readonly string[],
  usable: readonly ImportableSkill[],
): { skills: RoleSkillRef[]; unresolved: string[] } {
  const skills: RoleSkillRef[] = [];
  const unresolved: string[] = [];
  for (const name of names) {
    const pick = usable
      .filter((skill) => skill.name === name)
      .sort(
        (a, b) =>
          Number(a.superseded) - Number(b.superseded) || b.installedAt.localeCompare(a.installedAt),
      )[0];
    if (pick) skills.push({ resourceHash: pick.resourceHash, entry: pick.entry });
    else unresolved.push(name);
  }
  return { skills, unresolved };
}

export function importMarkdownAgent<T extends AgentImportDraft>(input: {
  draft: T;
  candidate: MarkdownAgent;
  parentNodeId: string;
  modelProfile: string;
  profiles: AgentImportProfile[];
  mappings: Record<string, string>;
  suffix: string;
  /** Preserves an explicit Corral role setting when importing a settings snapshot. */
  editingMode?: 'pi' | 'hashline' | undefined;
  parentHarness?: Pick<EffectiveHarnessSnapshot, 'binding' | 'policy' | 'allowedTools'> | undefined;
  /** The skills `attachSkillsByName` found; none leaves the role without a skill choice. */
  skills?: readonly RoleSkillRef[] | undefined;
}): T {
  const { draft, candidate, parentNodeId, modelProfile, profiles, mappings, suffix } = input;
  if (candidate.errors.length) throw new Error(candidate.errors.join('\n'));
  if (!profiles.some((profile) => profile.profileId === modelProfile && profile.available))
    throw new Error('Select an available model profile.');
  const parent = draft.definition.nodes.find(
    (node) => node.id === parentNodeId && node.type === 'agent',
  );
  const parentRole =
    parent?.type === 'agent'
      ? draft.definition.roles.find((role) => role.id === parent.roleId)
      : undefined;
  if (!parentRole) throw new Error('Select a parent agent.');
  if (!parentRole.allowedCollaborationTools.includes('submit_result'))
    throw new Error('Parent capability must include submit_result.');
  if (!parentRole.allowedWorkTools.includes('write_artifact'))
    throw new Error(
      'Parent capability must include write_artifact so the child can return a result.',
    );
  const work: WorkTool[] = ['write_artifact'];
  const collaboration: CollaborationTool[] = ['submit_result', 'ask'];
  for (const source of candidate.tools) {
    if (!knownTool(source)) throw new Error(`Unknown tool: ${source}`);
    if (excluded.has(source)) continue;
    const target = mappings[source];
    if (!target) throw new Error(`Choose a mapping or exclusion for ${source}.`);
    if (target === 'omit') {
      if (source === 'write_artifact' || source === 'submit_result' || source === 'ask')
        throw new Error(`${source} is required to return a result or ask the parent.`);
      continue;
    }
    if (!toolTargets(source).includes(target))
      throw new Error(`Unsupported mapping: ${source} → ${target}`);
    const workTool = WorkTool.safeParse(target);
    if (workTool.success) {
      if (!parentRole.allowedWorkTools.includes(workTool.data))
        throw new Error(`Tool exceeds parent capability: ${target}`);
      if (!work.includes(workTool.data)) work.push(workTool.data);
    } else {
      const tool = CollaborationTool.parse(target);
      if (tool !== 'ask' && !parentRole.allowedCollaborationTools.includes(tool))
        throw new Error(`Tool exceeds parent capability: ${target}`);
      if (!collaboration.includes(tool)) collaboration.push(tool);
    }
  }
  const editingMode =
    candidate.tools.includes('Edit') && mappings.Edit === 'write_file'
      ? 'hashline'
      : input.editingMode;
  if (editingMode === 'hashline') {
    if (!parentRole.allowedWorkTools.includes('read_file'))
      throw new Error('Hashline editing requires parent read_file capability.');
    if (!work.includes('read_file')) work.push('read_file');
  }
  if (collaboration.includes('spawn_subagents')) {
    if (!parentRole.allowedCollaborationTools.includes('await_tasks'))
      throw new Error('Delegating children requires parent await_tasks capability.');
    if (!collaboration.includes('await_tasks')) collaboration.push('await_tasks');
  }
  if (work.includes('run_command')) {
    const harness = input.parentHarness;
    if (
      !parentRole.harness ||
      !harness ||
      harness.binding.profileId !== parentRole.harness.profileId ||
      harness.binding.revision !== parentRole.harness.revision ||
      harness.policy !== 'trusted-native' ||
      !harness.allowedTools.includes('run_command')
    )
      throw new Error(
        'Shell import requires the parent’s verified local Harness to allow run_command under trusted-native policy.',
      );
  }
  if (parentRole.harness) {
    const harness = input.parentHarness;
    if (
      !harness ||
      harness.binding.profileId !== parentRole.harness.profileId ||
      harness.binding.revision !== parentRole.harness.revision
    )
      throw new Error('Import requires the parent’s verified local Harness revision.');
    const required = [
      'write_artifact',
      'submit_result',
      'spawn_subagents',
      'await_tasks',
      'ask',
      'reply',
    ];
    const unavailable = required.filter((tool) => !harness.allowedTools.includes(tool));
    if (unavailable.length)
      throw new Error(
        `The parent Harness does not allow the delegation and parent question tools: ${unavailable.join(', ')}.`,
      );
  }
  if (work.includes('generate_image') && !parentRole.imageProfile)
    throw new Error('Image generation import requires the parent’s local image profile.');
  const nodeId = `import_${suffix}`;
  const roleId = `${nodeId}_role`;
  const linkId = `${nodeId}_delegate`;
  if (
    draft.definition.nodes.some((node) => node.id === nodeId) ||
    draft.definition.roles.some((role) => role.id === roleId) ||
    draft.definition.capabilityLinks.some((link) => link.id === linkId)
  )
    throw new Error('Imported identifier already exists.');
  const definition = CorralDefinitionDraft.parse({
    ...draft.definition,
    roles: [
      ...draft.definition.roles.map((role) =>
        role.id === parentRole.id
          ? {
              ...role,
              allowedCollaborationTools: [
                ...new Set([
                  ...role.allowedCollaborationTools,
                  'spawn_subagents',
                  'await_tasks',
                  'ask',
                  'reply',
                ]),
              ],
            }
          : role,
      ),
      {
        id: roleId,
        name: candidate.name,
        prompt: `${candidate.description}\n\n${candidate.prompt}\n\nCorral import tool mapping:\n${candidate.tools.map((source) => `${source}: ${excluded.has(source) ? 'excluded; the parent handles user input and run control' : mappings[source] === 'omit' ? 'excluded; do not attempt this tool' : source === 'Edit' && editingMode === 'hashline' ? 'read_hashline, then edit_hashline using the returned file tag' : mappings[source]}`).join('\n')}\nUse only the effective Corral tool names. Return results through write_artifact and submit_result. If clarification or user input is needed, call ask with targetNodeId "${parentNodeId}" to the parent who delegated this task. Wait for the reply and continue this same task before submitting the result. The parent handles user input and run control. Agent questions and replies do not grant human approval or additional permissions.`,
        modelProfile,
        ...(work.includes('generate_image') && parentRole.imageProfile
          ? { imageProfile: parentRole.imageProfile }
          : {}),
        ...(parentRole.harness ? { harness: { ...parentRole.harness } } : {}),
        ...(editingMode ? { editingMode } : {}),
        // An empty choice would still switch the role to harness resolution.
        ...(input.skills?.length ? { skills: input.skills.map((ref) => ({ ...ref })) } : {}),
        allowedWorkTools: work,
        allowedCollaborationTools: collaboration,
        outputContract: 'text',
      },
    ],
    nodes: [
      ...draft.definition.nodes,
      {
        id: nodeId,
        type: 'agent',
        label: candidate.name,
        roleId,
        invocation: 'callable',
        inputBindings: [],
        outputName: `${nodeId}_result`,
      },
    ],
    capabilityLinks: [
      ...draft.definition.capabilityLinks,
      {
        id: linkId,
        kind: 'delegate',
        sourceNodeId: parentNodeId,
        targetNodeId: nodeId,
        parentQuestions: true,
      },
    ],
  });
  return { ...draft, definition };
}
