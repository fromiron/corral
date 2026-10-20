import { importMarkdownAgent, parseMarkdownAgent, waitForProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentTools,
} from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import { liveRuntime } from './harness.ts';

it('[TC-ABS-011-H] a Markdown Edit callable exposes real Hashline schemas when delegated through Pi', async () => {
  const parent = linearCorral(['writer']);
  for (const role of parent.roles)
    role.allowedWorkTools = ['write_artifact', 'read_file', 'write_file'];
  const imported = importMarkdownAgent({
    draft: { definition: parent, layout: {} },
    candidate: parseMarkdownAgent(
      '---\nname: fixer\ndescription: Make a scoped edit\ntools: [Read, Edit]\n---\nRead the current file before editing.',
    ),
    parentNodeId: 'writer',
    modelProfile: 'model-a',
    profiles: [{ profileId: 'model-a', available: true }],
    mappings: { Read: 'read_file', Edit: 'write_file' },
    suffix: 'worker_schema',
  });
  let childSchemas = 0;
  const respond: FauxResponseStep = (context) => {
    const tools = getCurrentTools(context.messages);
    const edit = tools.find((tool) => tool.name === 'edit_hashline');
    const isChild = !!edit;
    if (edit) {
      childSchemas += 1;
      expect(tools.map((tool) => tool.name)).toContain('read_hashline');
      expect(tools.map((tool) => tool.name)).not.toContain('edit');
      expect(tools.map((tool) => tool.name)).not.toContain('write');
      expect(edit.parameters).toMatchObject({
        type: 'object',
        properties: { path: { type: 'string' }, tag: { type: 'string' }, ops: { type: 'string' } },
      });
    }
    const resultOf = (name: string) => {
      const message = context.messages.find(
        (message) => message.role === 'toolResult' && message.toolName === name,
      );
      if (message?.role !== 'toolResult') return null;
      const text = message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
      return JSON.parse(text || '{}') as Record<string, unknown>;
    };
    const call = (name: string, args: Record<string, unknown>) =>
      fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], {
        stopReason: 'toolUse',
      });
    if (!isChild) {
      const spawned = resultOf('spawn_subagents');
      if (!spawned)
        return call('spawn_subagents', {
          tasks: [
            {
              targetNodeId: 'import_worker_schema',
              brief: 'Report the available editing contract.',
            },
          ],
        });
      if (!resultOf('await_tasks')) return call('await_tasks', { taskIds: spawned.taskIds });
    }
    const written = resultOf('write_artifact');
    if (!written)
      return call('write_artifact', {
        text: isChild ? 'Hashline role verified.' : 'Imported child completed.',
      });
    if (!resultOf('submit_result'))
      return call('submit_result', { artifactVersionIds: [written.artifactVersionId] });
    return fauxAssistantMessage('Done.');
  };
  const { transport } = liveRuntime(Array.from({ length: 20 }, () => respond));
  const { runId, receipt } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: 'cmd_imported_role',
    definition: imported.definition,
    mode: 'live',
  });
  if (!runId) throw new Error(JSON.stringify(receipt.error));
  const final = await waitForProjection(transport, runId, (state) =>
    ['succeeded', 'failed', 'cancelled'].includes(state.status),
  );
  expect(final.status).toBe('succeeded');
  expect(childSchemas).toBeGreaterThan(0);
  const childTasks = Object.values(final.tasks).filter(
    (task) => task.nodeId === 'import_worker_schema',
  );
  expect(childTasks).toHaveLength(1);
  expect(childTasks[0]?.submittedArtifactVersionIds.length).toBeGreaterThan(0);
});
