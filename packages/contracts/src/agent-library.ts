import { z } from 'zod';
import { AgentRole } from './definition.ts';
import { Identifier } from './ids.ts';

export const LibraryAgentRole = AgentRole.omit({ id: true, origin: true });
export type LibraryAgentRole = z.infer<typeof LibraryAgentRole>;

export const LibraryAgent = z.strictObject({
  agentId: Identifier,
  projectId: Identifier,
  revision: z.int().min(1),
  role: LibraryAgentRole,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
});
export type LibraryAgent = z.infer<typeof LibraryAgent>;

export const CreateLibraryAgent = z.strictObject({
  role: LibraryAgentRole,
  operationId: Identifier,
});
export type CreateLibraryAgent = z.infer<typeof CreateLibraryAgent>;

export const UpdateLibraryAgent = z
  .strictObject({
    role: LibraryAgentRole.optional(),
    archived: z.boolean().optional(),
    expectedRevision: z.int().min(1),
  })
  .refine((change) => change.role !== undefined || change.archived !== undefined, 'empty update');
export type UpdateLibraryAgent = z.infer<typeof UpdateLibraryAgent>;
