import { Identifier, ScheduleDraft } from '@corral/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ScheduleError, type ScheduleService } from './service.ts';

export function registerScheduleRoutes(app: FastifyInstance, service: ScheduleService) {
  const revision = z.strictObject({ expectedRevision: z.int().min(1) });
  app.get('/api/v1/schedules', async () => ({ schedules: service.list() }));
  app.post('/api/v1/schedules', async (request, reply) => {
    const parsed = ScheduleDraft.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: { message: 'Invalid schedule fields.' } });
    try {
      return reply.code(201).send(await service.create(parsed.data));
    } catch (error) {
      return failure(error, reply);
    }
  });
  app.put<{ Params: { id: string } }>('/api/v1/schedules/:id', async (request, reply) => {
    const parsed = z
      .strictObject({ draft: ScheduleDraft, expectedRevision: z.int().min(1) })
      .safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: { message: 'Invalid schedule fields.' } });
    try {
      return await service.update(
        request.params.id,
        parsed.data.draft,
        parsed.data.expectedRevision,
      );
    } catch (error) {
      return failure(error, reply);
    }
  });
  app.delete<{ Params: { id: string } }>('/api/v1/schedules/:id', async (request, reply) => {
    const parsed = revision.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: { message: 'Expected revision is required.' } });
    try {
      service.remove(request.params.id, parsed.data.expectedRevision);
      return reply.code(204).send();
    } catch (error) {
      return failure(error, reply);
    }
  });
  app.get<{ Params: { id: string } }>('/api/v1/schedules/:id/occurrences', async (request) => ({
    occurrences: service.history(request.params.id),
  }));
  app.post<{ Params: { id: string } }>('/api/v1/schedules/:id/run', async (request, reply) => {
    const parsed = revision.extend({ commandId: Identifier }).safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: { message: 'Expected revision and command ID are required.' } });
    try {
      return {
        occurrences: await service.runNow(
          request.params.id,
          parsed.data.expectedRevision,
          parsed.data.commandId,
        ),
      };
    } catch (error) {
      return failure(error, reply);
    }
  });
}

function failure(error: unknown, reply: import('fastify').FastifyReply) {
  if (error instanceof ScheduleError)
    return reply.code(error.status).send({ error: { message: error.message } });
  throw error;
}
