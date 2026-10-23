import {
  FileEditApply,
  FileEditDecision,
  FileEditInverse,
  FileEditPreview,
  FileEditReconcile,
  type WorkspaceTarget,
} from '@corral/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { z } from 'zod';
import type { WorkspaceService } from './service.ts';

type SessionParams = { sessionId: string };
type ProposalParams = SessionParams & { proposalId: string };

/** Human edit proposals share authentication and receipts, never a fabricated agent execution. */
export function registerFileEditRoutes(
  app: FastifyInstance,
  files: WorkspaceService,
  failure: (reply: FastifyReply, error: unknown) => unknown,
) {
  const base = '/api/v1/sessions/:sessionId/worktree';
  const invalid = (reply: FastifyReply) =>
    reply.code(400).send({
      error: { code: 'SCHEMA_INVALID', message: 'invalid file edit request or target' },
    });
  const run = async (reply: FastifyReply, action: () => unknown) => {
    try {
      return await action();
    } catch (error) {
      return failure(reply, error);
    }
  };
  app.get<{ Params: SessionParams }>(`${base}/edit-proposals`, (request, reply) =>
    run(reply, () => files.fileEditProposals(request.params.sessionId)),
  );
  app.get<{ Params: ProposalParams }>(`${base}/edit-proposals/:proposalId`, (request, reply) =>
    run(reply, () => files.fileEditProposal(request.params.sessionId, request.params.proposalId)),
  );
  app.post<{ Params: SessionParams }>(
    `${base}/edit-proposals`,
    { bodyLimit: 7 * 1024 * 1024 },
    async (request, reply) => {
      const input = FileEditPreview.safeParse(request.body);
      if (!input.success || input.data.target.sessionId !== request.params.sessionId)
        return invalid(reply);
      const dropped = new AbortController();
      const onClose = () => {
        if (!reply.raw.writableEnded) dropped.abort();
      };
      reply.raw.once('close', onClose);
      if (reply.raw.destroyed || request.raw.aborted) dropped.abort();
      try {
        return await run(reply, () =>
          files.previewFileEdits(request.params.sessionId, input.data, {
            get aborted() {
              return dropped.signal.aborted;
            },
            onCancel(listener) {
              dropped.signal.addEventListener('abort', listener, { once: true });
              return () => dropped.signal.removeEventListener('abort', listener);
            },
          }),
        );
      } finally {
        reply.raw.off('close', onClose);
      }
    },
  );
  function mutation<T extends { target: WorkspaceTarget }>(
    suffix: string,
    schema: z.ZodType<T>,
    apply: (sessionId: string, proposalId: string, input: T) => unknown,
  ) {
    app.post<{ Params: ProposalParams }>(
      `${base}/edit-proposals/:proposalId/${suffix}`,
      (request, reply) => {
        const input = schema.safeParse(request.body);
        if (!input.success || input.data.target.sessionId !== request.params.sessionId)
          return invalid(reply);
        // Apply continues after a lost response. The caller reads the same operation receipt.
        return run(reply, () =>
          apply(request.params.sessionId, request.params.proposalId, input.data),
        );
      },
    );
  }
  mutation('apply', FileEditApply, (sessionId, id, input) =>
    files.applyFileEdits(sessionId, id, input),
  );
  mutation('dismiss', FileEditDecision, (sessionId, id, input) =>
    files.dismissFileEdits(sessionId, id, input),
  );
  mutation('inverse', FileEditInverse, (sessionId, id, input) =>
    files.inverseFileEdits(sessionId, id, input),
  );
  app.get<{ Params: SessionParams & { operationId: string } }>(
    `${base}/edit-operations/:operationId`,
    (request, reply) =>
      run(reply, () =>
        files.fileEditOperation(request.params.sessionId, request.params.operationId),
      ),
  );
  app.post<{ Params: SessionParams }>(`${base}/edit-operations/reconcile`, (request, reply) => {
    const input = FileEditReconcile.safeParse(request.body);
    if (!input.success || input.data.target.sessionId !== request.params.sessionId)
      return invalid(reply);
    return run(reply, () => files.reconcileFileEdits(request.params.sessionId, input.data));
  });
}
