import type { CorralRepository } from '@corral/core';
import { emptyDraft } from '@corral/react';
import { type DemoTemplateId, templateForWorkspace } from './demo/templates.ts';

export type WorkspaceTemplateId = DemoTemplateId | 'blank';

export const WORKSPACE_TEMPLATES: readonly WorkspaceTemplateId[] = [
  'research-team',
  'starter',
  'blank',
];

/** Saves a new Corral from a template and returns its id, or an error message. */
export async function createFromTemplate(
  repository: CorralRepository,
  id: WorkspaceTemplateId,
  blankName: string,
  projectId?: string,
): Promise<{ ok: true; corralId: string } | { ok: false; message: string }> {
  const suffix = globalThis.crypto.randomUUID().slice(0, 8);
  const draft =
    id === 'blank'
      ? (() => {
          const empty = emptyDraft('untitled', blankName);
          return {
            definition: empty.definition,
            layout: { nodes: empty.layout, viewport: empty.viewport },
          };
        })()
      : (() => {
          const template = templateForWorkspace(id, `${id.replace('-', '_')}_${suffix}`);
          return { definition: template.definition, layout: template.layout };
        })();
  const result = await repository.save({
    ...draft,
    expectedDefinitionRevision: null,
    ...(projectId ? { projectId } : {}),
  });
  return result.ok
    ? { ok: true, corralId: result.record.corralId }
    : { ok: false, message: result.message };
}
