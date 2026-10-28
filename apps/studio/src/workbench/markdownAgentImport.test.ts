import {
  type CorralDefinition,
  DEFAULT_LIMITS,
  type EffectiveHarnessSnapshot,
} from '@corral/contracts';
import { compileDefinition } from '@corral/core';
import { createEditorStore, draftFromDefinition } from '@corral/react';
import { describe, expect, it } from 'vitest';
import { importMarkdownAgent, parseMarkdownAgent, toolTargets } from './markdownAgentImport.ts';

const definition: CorralDefinition = {
  schemaVersion: '0.1',
  id: 'team',
  name: 'Team',
  entryNodeId: 'parent',
  input: { brief: 'Inspect code', criteria: ['Explain findings'] },
  roles: [
    {
      id: 'parent_role',
      name: 'Parent',
      prompt: 'Work.',
      modelProfile: 'connected',
      allowedWorkTools: ['write_artifact', 'read_file', 'list_files'],
      allowedCollaborationTools: ['submit_result', 'ask_user', 'update_plan'],
      outputContract: 'text',
    },
  ],
  nodes: [
    {
      id: 'parent',
      type: 'agent',
      roleId: 'parent_role',
      label: 'Parent',
      invocation: 'scheduled',
      inputBindings: [],
      outputName: 'answer',
    },
    {
      id: 'output',
      type: 'output',
      label: 'Output',
      inputBindings: [{ kind: 'task_output', name: 'answer', sourceNodeId: 'parent' }],
      requireApproval: false,
    },
  ],
  controlEdges: [
    { id: 'edge', source: 'parent', sourcePort: 'out', target: 'output', targetPort: 'in' },
  ],
  capabilityLinks: [],
  limits: DEFAULT_LIMITS,
};
const source =
  '---\nname: explorer\ndescription: Inspect source\ntools: [Read, Glob]\nmodel: provider/model\n---\nReport paths and evidence.';
const profile = [{ profileId: 'connected', label: 'Connected model', available: true }];
const importAgent = (text = source, mappings = { Read: 'read_file', Glob: 'list_files' }) =>
  importMarkdownAgent({
    draft: draftFromDefinition(definition),
    candidate: parseMarkdownAgent(text),
    parentNodeId: 'parent',
    modelProfile: 'connected',
    profiles: profile,
    mappings,
    suffix: 'a1',
  });

describe('Markdown agent import', () => {
  it('reviews a real parent question channel so a child can ask and continue its task', () => {
    const imported = importAgent();
    expect(imported.definition.capabilityLinks.at(-1)).toMatchObject({
      kind: 'delegate',
      parentQuestions: true,
    });
    expect(imported.definition.roles.at(-1)?.allowedCollaborationTools).toContain('ask');
    expect(imported.definition.roles[0]?.allowedCollaborationTools).toEqual(
      expect.arrayContaining(['ask', 'reply', 'spawn_subagents', 'await_tasks']),
    );
    expect(imported.definition.roles.at(-1)?.prompt).toContain('ask');
    expect(imported.definition.roles.at(-1)?.prompt).not.toContain(
      'report the question to the parent in your result',
    );
  });
  it('inherits only the selected local parent binding and verifies shell work style availability', () => {
    const binding = { profileId: 'local_shell', revision: 3 };
    const parentDefinition = {
      ...definition,
      roles: definition.roles.map((role) => ({
        ...role,
        harness: binding,
        allowedWorkTools: [...role.allowedWorkTools, 'run_command' as const],
      })),
    };
    const build = (
      parentHarness?: Pick<EffectiveHarnessSnapshot, 'binding' | 'policy' | 'allowedTools'>,
    ) =>
      importMarkdownAgent({
        draft: draftFromDefinition(parentDefinition),
        candidate: parseMarkdownAgent(source.replace('Read, Glob', 'Bash')),
        parentNodeId: 'parent',
        modelProfile: 'connected',
        profiles: profile,
        mappings: { Bash: 'run_command' },
        suffix: 'shell',
        parentHarness,
      });
    const communication = [
      'write_artifact',
      'submit_result',
      'spawn_subagents',
      'await_tasks',
      'ask',
      'reply',
    ];
    expect(() => build()).toThrow(/verified local work style/);
    expect(() => build({ binding, policy: 'strict', allowedTools: ['run_command'] })).toThrow(
      /trusted-native/,
    );
    expect(() => build({ binding, policy: 'trusted-native', allowedTools: [] })).toThrow(
      /run_command/,
    );
    expect(() =>
      build({ binding, policy: 'trusted-native', allowedTools: ['run_command'] }),
    ).toThrow(/parent question/);
    const imported = build({
      binding,
      policy: 'trusted-native',
      allowedTools: ['run_command', ...communication],
    });
    expect(imported.definition.roles.at(-1)?.harness).toEqual(binding);
    expect(imported.definition.roles.at(-1)?.allowedWorkTools).toEqual([
      'write_artifact',
      'run_command',
    ]);
    expect(() =>
      build({
        binding: { ...binding, revision: 4 },
        policy: 'trusted-native',
        allowedTools: ['run_command'],
      }),
    ).toThrow(/verified/);
  });
  it('maps Markdown Edit to the actual Hashline role mode and bounded file permissions', () => {
    expect(toolTargets('Edit')).toEqual(['write_file']);
    expect(toolTargets('BrowserPreview')).toEqual(['preview_file', 'preview_app']);
    const parentDefinition = {
      ...definition,
      roles: definition.roles.map((role) => ({
        ...role,
        allowedWorkTools: [...role.allowedWorkTools, 'write_file' as const],
      })),
    };
    const imported = importMarkdownAgent({
      draft: draftFromDefinition(parentDefinition),
      candidate: parseMarkdownAgent(source.replace('Read, Glob', 'Edit')),
      parentNodeId: 'parent',
      modelProfile: 'connected',
      profiles: profile,
      mappings: { Edit: 'write_file' },
      suffix: 'editing',
    });
    expect(imported.definition.roles.at(-1)).toMatchObject({
      editingMode: 'hashline',
      allowedWorkTools: ['write_artifact', 'write_file', 'read_file'],
    });
    expect(imported.definition.roles[0]?.editingMode).toBeUndefined();
    const unreadable = {
      ...parentDefinition,
      roles: parentDefinition.roles.map((role) => ({
        ...role,
        allowedWorkTools: role.allowedWorkTools.filter((tool) => tool !== 'read_file'),
      })),
    };
    expect(() =>
      importMarkdownAgent({
        draft: draftFromDefinition(unreadable),
        candidate: parseMarkdownAgent(source.replace('Read, Glob', 'Edit')),
        parentNodeId: 'parent',
        modelProfile: 'connected',
        profiles: profile,
        mappings: { Edit: 'write_file' },
        suffix: 'editing',
      }),
    ).toThrow(/parent read_file/);
  });
  it('parses metadata, multiline prompt and YAML list tools without executing Markdown', () => {
    const parsed = parseMarkdownAgent(
      '---\nname: "code-reviewer"\ndescription: >\n  Review code\n  for regressions\ntools:\n  - Read\n  - Glob\nprompt: |\n  Use evidence.\n  Explain issues.\n---\n',
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.name).toBe('code-reviewer');
    expect(parsed.description).toBe('Review code for regressions');
    expect(parsed.prompt).toBe('Use evidence.\nExplain issues.');
    expect(parsed.tools).toEqual(['Read', 'Glob']);
  });
  it('rejects unsupported fields, duplicate keys, unknown tools and oversized input', () => {
    expect(
      parseMarkdownAgent(source.replace('name: explorer', 'name: explorer\nname: second')).errors
        .length,
    ).toBeGreaterThan(0);
    expect(
      parseMarkdownAgent(source.replace('model:', 'temperature:')).errors.length,
    ).toBeGreaterThan(0);
    expect(
      parseMarkdownAgent(source.replace('Read, Glob', 'Read, SecretTool')).errors.length,
    ).toBeGreaterThan(0);
    expect(parseMarkdownAgent('a'.repeat(33000)).errors.length).toBeGreaterThan(0);
    expect(parseMarkdownAgent('가'.repeat(11000)).errors).toContain('Markdown exceeds 32 KiB.');
    expect(
      parseMarkdownAgent(source.replace('Read, Glob', 'constructor')).errors.length,
    ).toBeGreaterThan(0);
    expect(toolTargets('constructor')).toEqual([]);
  });
  it('creates a callable node and explicit parent delegate link without altering limits or control flow', () => {
    const imported = importAgent();
    const child = imported.definition.nodes.at(-1);
    expect(child).toMatchObject({
      type: 'agent',
      invocation: 'callable',
      roleId: 'import_a1_role',
    });
    expect(imported.definition.capabilityLinks.at(-1)).toMatchObject({
      sourceNodeId: 'parent',
      targetNodeId: 'import_a1',
      kind: 'delegate',
    });
    expect(imported.definition.roles.at(-1)).toMatchObject({
      allowedWorkTools: ['write_artifact', 'read_file', 'list_files'],
      allowedCollaborationTools: ['submit_result', 'ask'],
      modelProfile: 'connected',
    });
    expect(imported.definition.roles[0]?.allowedCollaborationTools).toContain('spawn_subagents');
    expect(imported.definition.limits).toEqual(DEFAULT_LIMITS);
    expect(imported.definition.controlEdges).toEqual(definition.controlEdges);
    expect(imported.definition.roles.at(-1)?.prompt).toContain('Inspect source');
    const compiled = compileDefinition(imported.definition, { knownModelProfiles: ['connected'] });
    expect(compiled.ok).toBe(true);
    if (compiled.ok) expect(compiled.plan.callables.parent?.delegate).toEqual(['import_a1']);
  });
  it('requires explicit mappings and a real available model, and rejects parent permission escalation', () => {
    expect(() => importAgent(source, {} as never)).toThrow();
    expect(() =>
      importAgent(source.replace('Read, Glob', 'Write'), { Write: 'write_file' } as never),
    ).toThrow(/parent/i);
    expect(() =>
      importMarkdownAgent({
        draft: draftFromDefinition(definition),
        candidate: parseMarkdownAgent(source),
        parentNodeId: 'parent',
        modelProfile: 'invented',
        profiles: profile,
        mappings: { Read: 'read_file', Glob: 'list_files' },
        suffix: 'a1',
      }),
    ).toThrow(/model/i);
  });
  it('removes imported user interaction and run control, and requires explicit exclusion of unavailable tools', () => {
    const imported = importAgent(
      source.replace('[Read, Glob]', '[Read, Glob, ask_user, update_plan]'),
    );
    expect(imported.definition.roles.at(-1)?.allowedCollaborationTools).toEqual([
      'submit_result',
      'ask',
    ]);
    expect(() =>
      importAgent(source.replace('Read, Glob', 'Grep'), { Grep: 'read_file' } as never),
    ).toThrow();
    expect(
      importAgent(source.replace('Read, Glob', 'Grep'), {
        Grep: 'omit',
      } as never).definition.roles.at(-1)?.allowedWorkTools,
    ).toEqual(['write_artifact']);
  });
  it('retains existing node limits and refuses duplicate ids', () => {
    const draft = importAgent();
    expect(() =>
      importMarkdownAgent({
        draft,
        candidate: parseMarkdownAgent(source),
        parentNodeId: 'parent',
        modelProfile: 'connected',
        profiles: profile,
        mappings: { Read: 'read_file', Glob: 'list_files' },
        suffix: 'a1',
      }),
    ).toThrow(/identifier/i);
  });
  it('preserves the import as one undo/redo operation and refuses a full graph', () => {
    const before = draftFromDefinition(definition);
    const editor = createEditorStore(before);
    const after = importAgent();
    editor.getState().applyDraft(after);
    editor.getState().undo();
    expect(editor.getState().draft).toBe(before);
    editor.getState().redo();
    expect(editor.getState().draft).toBe(after);
    const full = {
      ...before,
      definition: {
        ...definition,
        nodes: Array.from({ length: 20 }, (_, index) => ({
          id: `node_${index}`,
          type: 'agent' as const,
          roleId: 'parent_role',
          label: 'Parent',
          invocation: 'scheduled' as const,
          inputBindings: [],
          outputName: 'answer',
        })),
      },
    };
    const almostFull = {
      ...full,
      definition: { ...full.definition, nodes: full.definition.nodes.slice(0, 19) },
    };
    expect(
      importMarkdownAgent({
        draft: almostFull,
        candidate: parseMarkdownAgent(source),
        parentNodeId: 'node_0',
        modelProfile: 'connected',
        profiles: profile,
        mappings: { Read: 'read_file', Glob: 'list_files' },
        suffix: 'last',
      }).definition.nodes,
    ).toHaveLength(20);
    expect(() =>
      importMarkdownAgent({
        draft: full,
        candidate: parseMarkdownAgent(source),
        parentNodeId: 'node_0',
        modelProfile: 'connected',
        profiles: profile,
        mappings: { Read: 'read_file', Glob: 'list_files' },
        suffix: 'full',
      }),
    ).toThrow();
  });
});
