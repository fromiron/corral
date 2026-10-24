import type { ModelAttemptStore } from '@corral/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ModelRegistry } from '../models/registry.ts';
import { VoiceError, VoiceService } from './service.ts';

const Start = z.strictObject({
  profileId: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  target: z.strictObject({
    hostId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    runId: z.string().min(1).max(200).optional(),
    executionId: z.string().min(1).max(200).optional(),
  }),
  sdp: z.string().startsWith('v=0').max(128_000),
});

/** Registered after the ordinary session and CSRF hooks; never an unauthenticated key proxy. */
export function registerVoiceRoutes(
  app: FastifyInstance,
  options: {
    registry: ModelRegistry | null;
    hasSession: (id: string) => Promise<boolean>;
    hasRun: (sessionId: string, runId: string) => Promise<boolean>;
    service?: VoiceService;
    usageStore?: ModelAttemptStore;
  },
) {
  const voice =
    options.service ?? new VoiceService(options.registry, { usageStore: options.usageStore });
  app.addHook('onClose', () => voice.close());
  app.get('/api/v1/voice', () => voice.configuration());
  app.post('/api/v1/voice/calls', { bodyLimit: 160_000 }, async (request, reply) => {
    const parsed = Start.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: { code: 'SCHEMA_INVALID', message: 'Invalid voice request.' } });
    const { target } = parsed.data;
    const origin = request.headers.origin ?? `${request.protocol}://${request.headers.host}`;
    if (target.hostId !== origin)
      return reply.code(400).send({
        error: { code: 'CAPABILITY_DENIED', message: 'Voice destination belongs to another host.' },
      });
    if (
      !(await options.hasSession(target.sessionId)) ||
      (target.runId && !(await options.hasRun(target.sessionId, target.runId)))
    )
      return reply
        .code(404)
        .send({ error: { code: 'TARGET_NOT_FOUND', message: 'Voice destination not found.' } });
    const abort = new AbortController();
    const closed = () => {
      if (!reply.raw.writableFinished) abort.abort();
    };
    reply.raw.once('close', closed);
    try {
      return reply.code(201).send(await voice.start(parsed.data, abort.signal));
    } catch (error) {
      return reply.code(error instanceof VoiceError ? error.status : 502).send({
        error: {
          code: 'CAPABILITY_DENIED',
          message: error instanceof VoiceError ? error.message : 'Voice connection failed.',
        },
      });
    } finally {
      reply.raw.off('close', closed);
    }
  });
  app.delete<{ Params: { callId: string } }>(
    '/api/v1/voice/calls/:callId',
    async (request, reply) => {
      try {
        await voice.stop(request.params.callId);
        return reply.code(204).send();
      } catch {
        return reply.code(502).send({
          error: { code: 'CAPABILITY_DENIED', message: 'Voice shutdown is not yet confirmed.' },
        });
      }
    },
  );
}
