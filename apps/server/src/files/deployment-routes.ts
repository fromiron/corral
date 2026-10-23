import {
  DeploymentAction,
  DeploymentInspect,
  DeploymentStart,
  Identifier,
} from '@corral/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { WorkspaceService } from './service.ts';

type SessionParams = { sessionId: string };
type OperationParams = SessionParams & { operationId: string };
export function registerDeploymentRoutes(
  app: FastifyInstance,
  files: WorkspaceService,
  failure: (reply: FastifyReply, error: unknown) => unknown,
) {
  const base = '/api/v1/sessions/:sessionId/worktree/deployments';
  const invalid = (reply: FastifyReply) =>
    reply.code(400).send({
      error: { code: 'SCHEMA_INVALID', message: 'invalid deployment request or target' },
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
    return run(reply, () => files.deployments(request.params.sessionId));
  });
  app.post<{ Params: SessionParams }>(`${base}/inspect`, (request, reply) => {
    const input = DeploymentInspect.safeParse(request.body);
    if (!input.success || input.data.target.sessionId !== request.params.sessionId)
      return invalid(reply);
    return run(reply, () => files.inspectDeployment(request.params.sessionId, input.data));
  });
  app.post<{ Params: SessionParams }>(base, (request, reply) => {
    const input = DeploymentStart.safeParse(request.body);
    if (!input.success || input.data.target.sessionId !== request.params.sessionId)
      return invalid(reply);
    return run(reply, () => files.startDeployment(request.params.sessionId, input.data));
  });
  app.get<{ Params: OperationParams }>(`${base}/:operationId`, (request, reply) => {
    if (!Identifier.safeParse(request.params.operationId).success) return invalid(reply);
    return run(reply, () => files.deployment(request.params.sessionId, request.params.operationId));
  });
  for (const name of ['check', 'stop'] as const) {
    app.post<{ Params: OperationParams }>(`${base}/:operationId/${name}`, (request, reply) => {
      const input = DeploymentAction.safeParse(request.body);
      if (
        !input.success ||
        input.data.target.sessionId !== request.params.sessionId ||
        !Identifier.safeParse(request.params.operationId).success
      )
        return invalid(reply);
      return run(reply, () =>
        name === 'check'
          ? files.checkDeployment(request.params.sessionId, request.params.operationId, input.data)
          : files.stopDeployment(request.params.sessionId, request.params.operationId, input.data),
      );
    });
  }
}
