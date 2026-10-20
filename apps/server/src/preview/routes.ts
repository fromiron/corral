import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PreviewService } from './service.ts';
import type { PreviewToolsBroker } from './tools.ts';

/** Uses the app's existing session/CSRF hooks. Rendering uses a different listener. */
export function registerPreviewRoutes(
  app: FastifyInstance,
  previews: PreviewService,
  tools?: PreviewToolsBroker,
) {
  const params = z.object({ sessionId: z.string().min(1).max(200) });
  if (tools)
    app.get('/api/v1/sessions/:sessionId/preview-evidence/:evidenceId', async (request, reply) => {
      const parsed = params
        .extend({ evidenceId: z.string().regex(/^[a-f0-9]{64}$/) })
        .safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ code: 'SCHEMA_INVALID' });
      const result = await tools.evidence(parsed.data.sessionId, parsed.data.evidenceId);
      if (!result) return reply.code(404).send({ code: 'NOT_FOUND' });
      return reply
        .type(result.contentType)
        .header('cache-control', 'private, no-store')
        .send(result.bytes);
    });
  app.get('/api/v1/sessions/:sessionId/previews', async (request, reply) => {
    const parsed = params.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ code: 'SCHEMA_INVALID' });
    return previews.list(parsed.data.sessionId);
  });
  app.post('/api/v1/sessions/:sessionId/previews/:leaseId/delegations', async (request, reply) => {
    const parsed = params.extend({ leaseId: z.string().min(1).max(200) }).safeParse(request.params);
    const input = z
      .strictObject({ delegationId: z.string().min(1).max(200).optional() })
      .safeParse(request.body ?? {});
    if (!parsed.success || !input.success) return reply.code(400).send({ code: 'SCHEMA_INVALID' });
    try {
      return reply
        .header('cache-control', 'no-store')
        .send(
          await previews.delegate(
            parsed.data.sessionId,
            parsed.data.leaseId,
            input.data.delegationId,
          ),
        );
    } catch {
      return reply.code(403).send({
        code: 'CAPABILITY_DENIED',
        message: 'Preview delegation is unavailable or expired.',
      });
    }
  });
  app.post('/api/v1/sessions/:sessionId/previews', async (request, reply) => {
    const parsed = params.safeParse(request.params);
    const input = z
      .union([
        z.strictObject({
          path: z.string().min(1).max(4096),
          runId: z.string().min(1).max(200).optional(),
        }),
        z.strictObject({
          operationId: z.string().min(1).max(200),
          port: z.int().min(1024).max(65535),
          entryPath: z.string().min(1).max(4096).optional(),
        }),
      ])
      .safeParse(request.body);
    if (!parsed.success || !input.success) return reply.code(400).send({ code: 'SCHEMA_INVALID' });
    try {
      return reply.code(201).send(await previews.start(parsed.data.sessionId, input.data));
    } catch {
      return reply.code(403).send({
        code: 'CAPABILITY_DENIED',
        message: 'Preview requires a supported file in a trusted session working copy.',
      });
    }
  });
  app.delete('/api/v1/sessions/:sessionId/previews/:leaseId', async (request, reply) => {
    const parsed = params.extend({ leaseId: z.string().min(1).max(200) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ code: 'SCHEMA_INVALID' });
    try {
      await previews.stop(parsed.data.sessionId, parsed.data.leaseId);
      return reply.code(204).send();
    } catch {
      return reply.code(404).send({ code: 'NOT_FOUND', message: 'Preview not found.' });
    }
  });
}
