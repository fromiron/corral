import { Identifier } from '@corral/contracts';
import { type CorralRepository, createTextAttachment } from '@corral/core';
import { z } from 'zod';
import type { VaultDomainAdapter } from '../vault/types.ts';
import type { ProjectMaterials } from './materials.ts';

const portable = z.strictObject({
  documents: z
    .array(
      z.strictObject({
        id: Identifier,
        projectId: Identifier,
        name: z
          .string()
          .trim()
          .min(1)
          .max(90)
          .regex(/^[^/\\\p{Cc}]+$/u),
        text: z.string().max(65536),
      }),
    )
    .max(1000),
});

export function materialsVaultAdapters(
  materials: ProjectMaterials,
  repository: Pick<CorralRepository, 'listProjects'>,
): Record<'instructions' | 'memory', VaultDomainAdapter> {
  const adapter = (kind: 'instructions' | 'memory'): VaultDomainAdapter => ({
    capture: async () => materials.snapshot(kind),
    receipt: async (operationId) => materials.receipt(kind, operationId),
    preview: async (value, bindings) => {
      const parsed = portable.parse(value);
      const projects = await repository.listProjects();
      const documents = parsed.documents.map((item) => {
        const projectId = bindings[`project:${item.projectId}`];
        if (
          !projectId ||
          !projects.some((project) => project.projectId === projectId && !project.archivedAt)
        )
          throw new Error(`Choose an active local project for project:${item.projectId}.`);
        createTextAttachment(item.name, 'text/markdown', item.text);
        if (
          materials
            .list(projectId)
            .some((current) => current.id === item.id && current.kind !== kind)
        )
          throw new Error('An imported identity belongs to a different document kind.');
        return { ...item, projectId };
      });
      const incoming = new Set(documents.map((item) => `${item.projectId}:${item.id}`));
      if (incoming.size !== documents.length)
        throw new Error('Project mappings create duplicate document identities.');
      const current = materials.snapshot(kind).value.documents;
      const merged = current.filter((item) => !incoming.has(`${item.projectId}:${item.id}`));
      const overwritten = documents.filter((item) =>
        current.some(
          (old) =>
            old.id === item.id &&
            old.projectId === item.projectId &&
            (old.name !== item.name || old.text !== item.text),
        ),
      );
      return {
        value: { documents: [...merged, ...documents] },
        warnings: [
          'Project documents are not automatically attached to requests. Existing request snapshots remain unchanged.',
          ...(overwritten.length
            ? [
                `New versions will replace ${overwritten.length} current documents: ${overwritten.map((item) => item.name).join(', ')}.`,
              ]
            : []),
        ],
      };
    },
    apply: async (value, expectedRevision, operationId) =>
      materials.replaceKind(kind, portable.parse(value).documents, expectedRevision, operationId),
    restore: async (snapshot, expectedRevision, operationId) =>
      materials.replaceKind(
        kind,
        portable.parse(snapshot.value).documents,
        expectedRevision,
        operationId,
      ),
  });
  return { instructions: adapter('instructions'), memory: adapter('memory') };
}
