import {
  DebugBreakpoints,
  DebugCommand,
  DebugInspect,
  DebugQuery,
  DebugStart,
  Identifier,
  type WorkspaceTarget,
} from '@corral/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { WorkspaceService } from './service.ts';

type SessionParams = { sessionId: string };
export function registerDebugRoutes(
  app: FastifyInstance,
  files: WorkspaceService,
  failure: (reply: FastifyReply, error: unknown) => unknown,
) {
  const base = '/api/v1/sessions/:sessionId/worktree/debug';
  const invalid = (reply: FastifyReply) =>
    reply.code(400).send({
      error: { code: 'SCHEMA_INVALID', message: 'invalid debugger request or target' },
    });
  const run = async (reply: FastifyReply, action: () => unknown) => {
    try {
      return await action();
    } catch (error) {
      return failure(reply, error);
    }
  };
  app.get<{ Params: SessionParams }>(base, (request, reply) => {
    if (!z.strictObject({}).safeParse(request.query).success) return invalid(reply);
    return run(reply, () => files.debugState(request.params.sessionId));
  });
  function command<T extends { target: WorkspaceTarget }>(
    suffix: string,
    schema: z.ZodType<T>,
    action: (sessionId: string, input: T) => unknown,
  ) {
    app.post<{ Params: SessionParams }>(`${base}/${suffix}`, (request, reply) => {
      const input = schema.safeParse(request.body);
      if (!input.success || input.data.target.sessionId !== request.params.sessionId)
        return invalid(reply);
      // A disconnected HTTP caller reads the original effect's receipt instead of replaying it.
      return run(reply, () => action(request.params.sessionId, input.data));
    });
  }
  command('inspect', DebugInspect, (id, input) => files.inspectDebug(id, input));
  command('start', DebugStart, (id, input) => files.startDebug(id, input));
  command('breakpoints', DebugBreakpoints, (id, input) => files.setDebugBreakpoints(id, input));
  command('query', DebugQuery, (id, input) => files.queryDebug(id, input));
  command('commands', DebugCommand, (id, input) => files.commandDebug(id, input));
  app.get<{ Params: SessionParams & { generation: string; commandId: string } }>(
    `${base}/commands/:generation/:commandId`,
    (request, reply) => {
      if (
        !Identifier.safeParse(request.params.generation).success ||
        !Identifier.safeParse(request.params.commandId).success
      )
        return invalid(reply);
      return run(reply, () =>
        files.debugCommand(
          request.params.sessionId,
          request.params.generation,
          request.params.commandId,
        ),
      );
    },
  );
}
