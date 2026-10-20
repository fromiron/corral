import { join } from 'node:path';
import { Identifier } from '@corral/contracts';
import type { CorralRepository } from '@corral/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ProjectClones } from './clones.ts';
import { ProjectMaterials } from './materials.ts';

export function registerProjectRoutes(
  app: FastifyInstance,
  options: {
    root: string;
    repository: Pick<CorralRepository, 'listProjects'>;
  },
) {
  const root = join(options.root, '.corral', 'projects');
  const materials = new ProjectMaterials(root);
  const clones = new ProjectClones(root);
  app.addHook('onClose', () => clones.close());
  const action = async (reply: FastifyReply, fn: () => unknown | Promise<unknown>) => {
    try {
      return await fn();
    } catch {
      return reply.code(400).send({
        error: {
          code: 'SCHEMA_INVALID',
          message:
            'The operation could not be completed. Check the selected revision, repository access and destination. Existing folders cannot be overwritten.',
        },
      });
    }
  };
  const project = async (id: string) => {
    Identifier.parse(id);
    if (!(await options.repository.listProjects()).some((p) => p.projectId === id))
      throw new Error('Project does not exist.');
  };
  type Params = { Params: { projectId: string } };
  app.get<Params>('/api/v1/projects/:projectId/materials', (request, reply) =>
    action(reply, async () => {
      await project(request.params.projectId);
      return { materials: materials.list(request.params.projectId) };
    }),
  );
  const draft = z.strictObject({
    id: Identifier.optional(),
    expectedRevision: z.int().min(1).optional(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(90)
      .regex(/^[^/\\\p{Cc}]+$/u),
    kind: z.enum(['instructions', 'memory']),
    text: z.string().max(64 * 1024),
  });
  app.post<Params>('/api/v1/projects/:projectId/materials', (request, reply) =>
    action(reply, async () => {
      await project(request.params.projectId);
      return { material: materials.save(request.params.projectId, draft.parse(request.body)) };
    }),
  );
  app.post<Params>('/api/v1/projects/:projectId/materials/remove', (request, reply) =>
    action(reply, async () => {
      await project(request.params.projectId);
      const body = z
        .strictObject({ id: Identifier, expectedRevision: z.int().min(1) })
        .parse(request.body);
      materials.remove(request.params.projectId, body.id, body.expectedRevision);
      return { ok: true };
    }),
  );
  app.post<Params>('/api/v1/projects/:projectId/materials/attachment', (request, reply) =>
    action(reply, async () => {
      await project(request.params.projectId);
      const body = z.strictObject({ id: Identifier, revision: z.int().min(1) }).parse(request.body);
      return { attachment: materials.attachment(request.params.projectId, body.id, body.revision) };
    }),
  );
  app.get('/api/v1/project-clones', () => ({ operations: clones.list() }));
  app.post('/api/v1/project-clones', (request, reply) =>
    action(reply, () => ({
      operation: clones.start(
        z
          .strictObject({
            commandId: Identifier,
            source: z.string().min(1).max(4096),
            destination: z.string().min(1).max(4096),
          })
          .parse(request.body),
      ),
    })),
  );
  type CloneParams = { Params: { operationId: string } };
  app.post<CloneParams>('/api/v1/project-clones/:operationId/cancel', (request, reply) =>
    action(reply, () => ({ operation: clones.cancel(request.params.operationId) })),
  );
  app.post<CloneParams>('/api/v1/project-clones/:operationId/remove-partial', (request, reply) =>
    action(reply, async () => ({
      operation: await clones.removePartial(request.params.operationId),
    })),
  );
  return { materials, clones };
}
