import { createHash } from 'node:crypto';
import {
  canonicalJson,
  type EffectiveHarnessSnapshot,
  LspQuery,
  ToolDescriptor,
} from '@corral/contracts';
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import catalog from './pi-tool-schemas.json' with { type: 'json' };
import { WorkerTool } from './protocol.ts';
import { parametersOf } from './worker-tools.ts';

export function describeTool(
  tool: {
    name: string;
    parameters: unknown;
    annotations?: ToolDescriptor['annotations'];
    exposure?: ToolDescriptor['exposure'];
  },
  source: string,
): ToolDescriptor {
  const annotations = tool.annotations;
  return ToolDescriptor.parse({
    source,
    name: tool.name,
    schemaHash: createHash('sha256')
      .update(canonicalJson(JSON.parse(JSON.stringify(tool.parameters))))
      .digest('hex'),
    ...(annotations ? { annotations } : {}),
    exposure: tool.exposure ?? 'direct',
    sideEffect:
      source === 'corral' && ['run_check', 'lsp_query'].includes(tool.name)
        ? 'external'
        : source === 'corral' &&
            ['edit', 'write', 'write_file', 'delete_file', 'move_file'].includes(tool.name)
          ? 'workspace'
          : annotations?.readOnlyHint === true && annotations.openWorldHint === false
            ? 'none'
            : 'unknown',
  });
}

export function brokerParameters(
  name: 'run_check' | 'lsp_query',
  selection: EffectiveHarnessSnapshot['projectTools'],
) {
  return name === 'run_check'
    ? Type.Object(
        { commandId: Type.Union((selection?.checkIds ?? []).map((id) => Type.Literal(id))) },
        { additionalProperties: false },
      )
    : Type.Unsafe(
        z.toJSONSchema(
          z.union(
            LspQuery.options.map((option) =>
              option.extend({ serverId: z.enum(selection?.lspServerIds ?? []) }),
            ),
          ),
          { target: 'draft-07', io: 'input' },
        ),
      );
}

/** Static definitions only. Capability-bound or extension tools are reported by the worker. */
export function staticToolDescriptors(
  names: string[],
  selection?: EffectiveHarnessSnapshot['projectTools'],
): ToolDescriptor[] {
  const piTools = new Map(Object.entries(catalog.tools));
  return names.flatMap((name) => {
    if (name === 'ask' || name === 'spawn_subagents') return [];
    const pi = piTools.get(name);
    if (pi)
      return [
        describeTool(
          {
            name,
            parameters: pi,
            annotations:
              name === 'read'
                ? { readOnlyHint: true, openWorldHint: false }
                : { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
          },
          'corral',
        ),
      ];
    if (name === 'run_check' || name === 'lsp_query') {
      if (!(name === 'run_check' ? selection?.checkIds.length : selection?.lspServerIds.length))
        return [];
      return [describeTool({ name, parameters: brokerParameters(name, selection) }, 'corral')];
    }
    const parsed = WorkerTool.safeParse(name);
    return parsed.success
      ? [
          describeTool(
            { name, parameters: parametersOf(parsed.data, { delegateTo: [], askTo: [] }) },
            'corral',
          ),
        ]
      : [];
  });
}
