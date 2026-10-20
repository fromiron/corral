import { createHash } from 'node:crypto';
import {
  CanvasLayout,
  CorralDefinitionDraft,
  type EffectiveHarnessSnapshot,
  type HarnessBindingRef,
} from '@corral/contracts';
import {
  type AgentImportProfile,
  type CorralRecord,
  type CorralRepository,
  canonicalJson,
  importMarkdownAgent,
  type MarkdownAgent,
  type SaveRequest,
  type SaveResult,
} from '@corral/core';
import { z } from 'zod';
import type { VaultDomainAdapter, VaultDomainSnapshot } from './types.ts';

// A team is an explicit local binding. Only callable roles are consumed from an incoming
// snapshot; the complete settings snapshot exists so the vault's authenticated journal can
// restore the original parent permissions, revisioned definition and layout.
const TeamSnapshot = z
  .strictObject({
    version: z.literal(1),
    corralId: z.string(),
    projectId: z.string(),
    definition: CorralDefinitionDraft,
    layout: CanvasLayout,
  })
  .refine(
    (snapshot) =>
      snapshot.definition.id === snapshot.corralId &&
      snapshot.layout.corralId === snapshot.corralId,
    'Team snapshot identity mismatch.',
  );
const PreparedImport = z.strictObject({
  kind: z.literal('corral-subagents-import'),
  source: TeamSnapshot,
  bindings: z.record(z.string(), z.string()),
});
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const settings = (record: CorralRecord) => ({
  version: 1 as const,
  corralId: record.corralId,
  projectId: record.projectId,
  definition: record.definition,
  layout: record.layout,
});
const revision = (record: CorralRecord) =>
  hash({
    corralId: record.corralId,
    projectId: record.projectId,
    definitionRevision: record.definitionRevision,
    layoutRevision: record.layoutRevision,
    definitionHash: record.definitionHash,
  });

export interface SubagentOperationRepository extends CorralRepository {
  saveOperation(
    request: SaveRequest,
    operationId: string,
    expectedLayoutRevision: number,
  ): Promise<SaveResult>;
  operationReceipt(operationId: string): Promise<SaveResult | null>;
}

/** The caller must bind a user-selected team, never infer the active team from a tab.
 * `restore` is for the vault's encrypted local journal only, never an imported document.
 */
export function createSubagentsVaultAdapter(options: {
  repository: CorralRepository;
  corralId: string;
  profiles(): Promise<AgentImportProfile[]>;
  resolveHarness?(
    binding: HarnessBindingRef,
    projectId: string,
  ): Promise<Pick<EffectiveHarnessSnapshot, 'binding' | 'policy' | 'allowedTools'>>;
}): VaultDomainAdapter {
  const operations = options.repository as Partial<SubagentOperationRepository>;
  if (
    typeof operations.saveOperation !== 'function' ||
    typeof operations.operationReceipt !== 'function'
  )
    throw new Error('Subagent vault writes require a repository with atomic operation receipts.');
  const repository = options.repository as SubagentOperationRepository;
  const operationKey = (operationId: string) => `subagents:${options.corralId}:${operationId}`;
  const receipt = async (operationId: string) => {
    const result = await repository.operationReceipt(operationKey(operationId));
    if (!result) return null;
    if (!result.ok) throw new Error(result.message);
    if (result.record.corralId !== options.corralId)
      throw new Error('Operation belongs to another team.');
    return { revision: revision(result.record) };
  };
  const get = async () => {
    const record = await options.repository.get(options.corralId);
    if (!record) throw new Error('Selected subagent team no longer exists.');
    return record;
  };
  const build = async (
    record: CorralRecord,
    prepared: z.infer<typeof PreparedImport>,
    operationId: string,
  ) => {
    const { source, bindings } = prepared;
    if (
      bindings.corralId !== record.corralId ||
      bindings.projectId !== record.projectId ||
      !bindings.parentNodeId
    )
      throw new Error('Bind the target project, team and parent agent explicitly.');
    const nodes = source.definition.nodes.filter(
      (node) => node.type === 'agent' && node.invocation === 'callable',
    );
    if (!nodes.length) throw new Error('The source team has no callable agents.');
    const profiles = await options.profiles();
    const parent = record.definition.nodes.find((node) => node.id === bindings.parentNodeId);
    const parentRole =
      parent?.type === 'agent'
        ? record.definition.roles.find((role) => role.id === parent.roleId)
        : undefined;
    const parentHarness =
      parentRole?.harness && options.resolveHarness
        ? await options.resolveHarness(parentRole.harness, record.projectId)
        : undefined;
    let draft = { definition: record.definition, layout: record.layout.nodes };
    for (const node of nodes) {
      if (node.type !== 'agent') continue;
      const role = source.definition.roles.find((role) => role.id === node.roleId);
      if (!role) throw new Error('Source callable role is missing.');
      const modelProfile = bindings[`model:${role.id}`];
      if (!modelProfile) throw new Error(`Map the model for role ${role.name} explicitly.`);
      const tools = [...new Set([...role.allowedWorkTools, ...role.allowedCollaborationTools])];
      const candidate: MarkdownAgent = {
        name: role.name,
        description: `Imported callable agent: ${role.name}`,
        prompt: role.prompt,
        tools,
        model: role.modelProfile,
        errors: [],
      };
      const mappings = Object.fromEntries(
        tools.map((tool) => [tool, bindings[`tool:${node.id}:${tool}`] ?? tool]),
      );
      draft = importMarkdownAgent({
        draft,
        candidate,
        parentNodeId: bindings.parentNodeId,
        modelProfile,
        profiles,
        mappings,
        editingMode: role.editingMode,
        parentHarness,
        suffix: `vault_${hash([operationId, source.corralId, node.id]).slice(0, 24)}`,
      });
    }
    return draft;
  };
  const save = async (
    record: CorralRecord,
    draft: { definition: CorralRecord['definition']; layout: CorralRecord['layout'] },
    operationId: string,
  ) => {
    // Profile resolution above is asynchronous. Recheck layout as well as definition before
    // entering the existing synchronous local repository save, which guards definition again.
    if (revision(await get()) !== revision(record))
      throw new Error('Subagent team revision conflict; review again.');
    const result = await repository.saveOperation(
      {
        definition: draft.definition,
        layout: { nodes: draft.layout.nodes, viewport: draft.layout.viewport },
        expectedDefinitionRevision: record.definitionRevision,
      },
      operationKey(operationId),
      record.layoutRevision,
    );
    if (!result.ok) throw new Error(result.message);
    return { revision: revision(result.record) };
  };
  return {
    receipt,
    async capture(): Promise<VaultDomainSnapshot> {
      const record = await get();
      return { revision: revision(record), value: settings(record) };
    },
    async preview(value, bindings) {
      const source = TeamSnapshot.parse(value);
      const prepared = PreparedImport.parse({ kind: 'corral-subagents-import', source, bindings });
      // Executes precisely the same permission/model checks as editor import, without saving.
      await build(await get(), prepared, 'preview');
      return {
        value: prepared,
        warnings: [
          'Only callable agents are added. Source control edges, task inputs, limits, harness bindings and project ownership are not imported.',
          'Model mappings and the selected parent determine effective capabilities. ask_user and update_plan stay with the parent.',
          'The selected parent gains spawn_subagents, await_tasks, ask and reply. Imported children gain ask only for their current delegating parent; questions and replies continue the same tasks.',
          'Save applies to future runs. Existing runs retain their pinned team revision.',
        ],
      };
    },
    async apply(value, expectedRevision, operationId) {
      const prepared = PreparedImport.parse(value);
      // The vault journal binds this operation ID to its immutable reviewed request hash.
      const existing = await receipt(operationId);
      if (existing) return existing;
      const record = await get();
      if (revision(record) !== expectedRevision)
        throw new Error('Subagent team revision conflict; review again.');
      const draft = await build(record, prepared, operationId);
      return save(
        record,
        {
          definition: draft.definition,
          layout: { ...record.layout, nodes: draft.layout },
        },
        operationId,
      );
    },
    async restore(snapshot, expectedRevision, operationId) {
      const original = TeamSnapshot.parse(snapshot.value);
      const existing = await receipt(operationId);
      if (existing) return existing;
      const record = await get();
      if (original.corralId !== record.corralId || original.projectId !== record.projectId)
        throw new Error('Cannot restore a snapshot into a different team.');
      if (revision(record) !== expectedRevision)
        throw new Error('Subagent restore revision conflict; manual recovery is required.');
      return save(
        record,
        { definition: original.definition, layout: original.layout },
        operationId,
      );
    },
  };
}
