import { CreateLibraryAgent, type ErrorCode, UpdateLibraryAgent } from '@corral/contracts';
import type { AgentLibrary, AgentLibraryResult } from '@corral/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

type ProjectParams = { projectId: string };
type AgentParams = ProjectParams & { agentId: string };
type Refusal = Extract<AgentLibraryResult, { ok: false }>['error'];

const failures: Record<Refusal, [ErrorCode, string]> = {
  not_found: ['TARGET_NOT_FOUND', 'No such project or agent.'],
  operation_conflict: ['IDEMPOTENCY_CONFLICT', 'This operation ID was used for another creation.'],
  revision_conflict: ['REVISION_CONFLICT', 'The agent revision has changed.'],
  invalid: ['SCHEMA_INVALID', 'Invalid agent library request.'],
  storage_unavailable: ['STORAGE_UNAVAILABLE', 'The agent library is unavailable.'],
};

export function registerAgentLibraryRoutes(
  app: FastifyInstance,
  library: AgentLibrary,
  parse: <T>(schema: z.ZodType<T>, request: FastifyRequest, reply: FastifyReply) => T | null,
  fail: (reply: FastifyReply, code: ErrorCode, message: string) => FastifyReply,
) {
  const collection = '/api/v1/projects/:projectId/agents';
  const item = `${collection}/:agentId`;
  const refuse = (reply: FastifyReply, reason: Refusal) => fail(reply, ...failures[reason]);

  app.get<{ Params: ProjectParams }>(collection, async (request, reply) => {
    try {
      return await library.list(request.params.projectId);
    } catch {
      return refuse(reply, 'storage_unavailable');
    }
  });
  app.post<{ Params: ProjectParams }>(collection, async (request, reply) => {
    const body = parse(CreateLibraryAgent, request, reply);
    if (!body) return reply;
    const result = await library.create(request.params.projectId, body);
    return result.ok ? reply.code(201).send(result.agent) : refuse(reply, result.error);
  });
  app.get<{ Params: AgentParams }>(item, async ({ params }, reply) => {
    try {
      const agent = await library.get(params.projectId, params.agentId);
      return agent ?? refuse(reply, 'not_found');
    } catch {
      return refuse(reply, 'storage_unavailable');
    }
  });
  app.patch<{ Params: AgentParams }>(item, async (request, reply) => {
    const body = parse(UpdateLibraryAgent, request, reply);
    if (!body) return reply;
    const { projectId, agentId } = request.params;
    const result = await library.update(projectId, agentId, body);
    return result.ok ? result.agent : refuse(reply, result.error);
  });
}
