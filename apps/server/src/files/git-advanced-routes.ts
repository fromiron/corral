import {
  GitAdvancedReconcile,
  GitConflictRequest,
  GitHunksRequest,
  GitHunkWrite,
  GitSequenceCommand,
  Identifier,
} from '@corral/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { WorkspaceService } from './service.ts';

type SessionParams = { sessionId: string };
type OperationParams = SessionParams & { operationId: string };
const HunksQuery = GitHunksRequest.omit({ target: true, head: true }).extend({
  target: z.string().max(4096),
  head: z.string().max(64),
});
const ConflictQuery = GitConflictRequest.omit({
  target: true,
  head: true,
  sequenceIdentity: true,
}).extend({
  target: z.string().max(4096),
  head: z.string().max(64),
  sequenceIdentity: z.string().max(64),
});
const Command = z.union([GitHunkWrite, GitSequenceCommand]);

/** Advanced Git uses the same session authentication and durable human operation ledger. */
export function registerGitAdvancedRoutes(
  app: FastifyInstance,
  files: WorkspaceService,
  failure: (reply: FastifyReply, error: unknown) => unknown,
) {
  const base = '/api/v1/sessions/:sessionId/worktree/git';
  const invalid = (reply: FastifyReply) =>
    reply.code(400).send({
      error: { code: 'SCHEMA_INVALID', message: 'invalid Git request or target' },
    });
  const run = async (reply: FastifyReply, action: () => unknown) => {
    try {
      return await action();
    } catch (error) {
      return failure(reply, error);
    }
  };
  app.get<{ Params: SessionParams }>(`${base}/hunks`, (request, reply) => {
    const query = HunksQuery.safeParse(request.query);
    if (!query.success) return invalid(reply);
    let target: unknown;
    try {
      target = JSON.parse(query.data.target);
    } catch {
      return invalid(reply);
    }
    const input = GitHunksRequest.safeParse({
      ...query.data,
      target,
      head: query.data.head || null,
    });
    if (!input.success || input.data.target.sessionId !== request.params.sessionId)
      return invalid(reply);
    return run(reply, () => files.gitHunks(request.params.sessionId, input.data));
  });
  app.get<{ Params: SessionParams }>(`${base}/sequence`, (request, reply) => {
    if (!z.strictObject({}).safeParse(request.query).success) return invalid(reply);
    return run(reply, () => files.gitSequence(request.params.sessionId));
  });
  app.get<{ Params: SessionParams }>(`${base}/conflict`, (request, reply) => {
    const query = ConflictQuery.safeParse(request.query);
    if (!query.success) return invalid(reply);
    let target: unknown;
    try {
      target = JSON.parse(query.data.target);
    } catch {
      return invalid(reply);
    }
    const input = GitConflictRequest.safeParse({
      ...query.data,
      target,
      head: query.data.head || null,
      sequenceIdentity: query.data.sequenceIdentity || null,
    });
    if (!input.success || input.data.target.sessionId !== request.params.sessionId)
      return invalid(reply);
    return run(reply, () => files.gitConflict(request.params.sessionId, input.data));
  });
  app.post<{ Params: SessionParams }>(`${base}/advanced-operations`, (request, reply) => {
    const input = Command.safeParse(request.body);
    if (!input.success || input.data.target.sessionId !== request.params.sessionId)
      return invalid(reply);
    const command = input.data;
    return run(reply, () =>
      command.kind === 'stage_hunks' || command.kind === 'unstage_hunks'
        ? files.changeGitHunks(request.params.sessionId, command)
        : files.changeGitSequence(request.params.sessionId, command),
    );
  });
  app.get<{ Params: OperationParams }>(
    `${base}/advanced-operations/:operationId`,
    (request, reply) => {
      if (!Identifier.safeParse(request.params.operationId).success) return invalid(reply);
      return run(reply, () =>
        files.gitAdvancedOperation(request.params.sessionId, request.params.operationId),
      );
    },
  );
  app.post<{ Params: SessionParams }>(`${base}/advanced-operations/reconcile`, (request, reply) => {
    const input = GitAdvancedReconcile.safeParse(request.body);
    if (!input.success || input.data.target.sessionId !== request.params.sessionId)
      return invalid(reply);
    return run(reply, () => files.reconcileGitAdvanced(request.params.sessionId, input.data));
  });
  app.post<{ Params: OperationParams }>(
    `${base}/advanced-operations/:operationId/cancel`,
    (request, reply) => {
      if (
        !Identifier.safeParse(request.params.operationId).success ||
        !z.strictObject({}).safeParse(request.body).success
      )
        return invalid(reply);
      return run(reply, () =>
        files.cancelGitAdvanced(request.params.sessionId, request.params.operationId),
      );
    },
  );
}
