import {
  CollaborationTool,
  type CorralDefinition,
  CorralDefinitionDraft,
  type EffectiveHarnessSnapshot,
  type NodeLayout,
  WorkTool,
} from '@corral/contracts';
import { MAX_CANVAS_NODES } from './compiler/index.ts';

export interface AgentImportDraft {
  definition: CorralDefinition;
  layout: Record<string, NodeLayout>;
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
const aliases: Record<string, readonly string[]> = {
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
  const candidates = Object.hasOwn(aliases, source) ? (aliases[source] ?? []) : [source];
  return candidates.filter((target) => supported.includes(target));
}
function knownTool(tool: string): boolean {
  return (
    Object.hasOwn(aliases, tool) ||
    WorkTool.safeParse(tool).success ||
    CollaborationTool.safeParse(tool).success
  );
}

export interface MarkdownAgent {
  name: string;
  description: string;
  prompt: string;
  model: string;
  tools: string[];
  errors: string[];
}

/** Deliberately bounded frontmatter: flat strings, literal/folded blocks and string lists.
 * Unsupported YAML constructs/fields fail visibly rather than being interpreted differently.
 */
export function parseMarkdownAgent(source: string): MarkdownAgent {
  const result: MarkdownAgent = {
    name: '',
    description: '',
    prompt: '',
    model: '',
    tools: [],
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
  const fields = new Map<string, string | string[]>();
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
    if (!['name', 'description', 'prompt', 'model', 'tools'].includes(key))
      result.errors.push(`Unsupported field: ${key}`);
    if (fields.has(key)) result.errors.push(`Duplicate field: ${key}`);
    if (/^[|>][-+]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < end && (/^\s/.test(lines[i + 1] ?? '') || !lines[i + 1]?.trim()))
        block.push(lines[++i] ?? '');
      const indent = Math.min(
        ...block.filter((row) => row.trim()).map((row) => row.length - row.trimStart().length),
      );
      fields.set(
        key,
        block
          .map((row) => row.slice(Number.isFinite(indent) ? indent : 0))
          .join(value.startsWith('>') ? ' ' : '\n')
          .trim(),
      );
    } else if (key === 'tools') {
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
}): T {
  const { draft, candidate, parentNodeId, modelProfile, profiles, mappings, suffix } = input;
  if (draft.definition.nodes.length >= MAX_CANVAS_NODES)
    throw new Error(`This version supports at most ${MAX_CANVAS_NODES} nodes per Corral.`);
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
        'Shell import requires the parent’s verified local work style to allow run_command under trusted-native policy.',
      );
  }
  if (parentRole.harness) {
    const harness = input.parentHarness;
    if (
      !harness ||
      harness.binding.profileId !== parentRole.harness.profileId ||
      harness.binding.revision !== parentRole.harness.revision
    )
      throw new Error('Import requires the parent’s verified local work style revision.');
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
        `The parent work style does not allow the delegation and parent question tools: ${unavailable.join(', ')}.`,
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
  const position = draft.layout[parentNodeId];
  return {
    ...draft,
    definition,
    layout: {
      ...draft.layout,
      [nodeId]: { x: (position?.x ?? 0) + 280, y: (position?.y ?? 0) + 160 },
    },
  };
}
