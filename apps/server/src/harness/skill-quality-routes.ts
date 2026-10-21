import {
  Identifier,
  ResourcePath,
  SkillAdoptRequest,
  SkillEvaluationRequest,
  SkillKey,
  SkillRollbackRequest,
} from '@corral/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { SkillQualityService } from './skill-quality.ts';

export function registerSkillQualityRoutes(app: FastifyInstance, service: SkillQualityService) {
  const prefix = '/api/v1/harness/skill-quality';
  const action = async (reply: FastifyReply, work: () => unknown) => {
    try {
      return await work();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const conflict = /revision changed|operation payload changed|evaluation is running/.test(
        message,
      );
      return reply.code(conflict ? 409 : 400).send({
        error: {
          code: conflict ? 'REVISION_CONFLICT' : 'CAPABILITY_DENIED',
          message: conflict
            ? 'The saved revision changed. Reload and review before applying.'
            : 'Skill evaluation could not proceed. Check trust, completed evidence, the selected baseline and model.',
        },
      });
    }
  };
  app.post(`${prefix}/preview`, (request, reply) =>
    action(reply, () => {
      const input = z
        .strictObject({ candidate: SkillKey, baseline: SkillKey.optional() })
        .parse(request.body);
      return service.preview(input.candidate, input.baseline);
    }),
  );
  app.post(`${prefix}/adoptions`, (request, reply) =>
    action(reply, () => service.adoptions(SkillKey.parse(request.body))),
  );
  app.post(`${prefix}/file`, (request, reply) =>
    action(reply, () => {
      const input = z
        .strictObject({ candidate: SkillKey, baseline: SkillKey.optional(), path: ResourcePath })
        .parse(request.body);
      return service.compareFile(input.candidate, input.baseline, input.path);
    }),
  );
  app.post(`${prefix}/history`, (request, reply) =>
    action(reply, () => service.list(SkillKey.parse(request.body))),
  );
  app.post(`${prefix}/evaluations`, (request, reply) =>
    action(reply, () => service.start(SkillEvaluationRequest.parse(request.body))),
  );
  app.get<{ Params: { id: string } }>(`${prefix}/evaluations/:id`, (request, reply) =>
    action(reply, () => service.get(Identifier.parse(request.params.id))),
  );
  app.delete<{ Params: { id: string } }>(`${prefix}/evaluations/:id`, (request, reply) =>
    action(reply, () => service.cancel(Identifier.parse(request.params.id))),
  );
  app.post(`${prefix}/adopt`, (request, reply) =>
    action(reply, () => service.adopt(SkillAdoptRequest.parse(request.body))),
  );
  app.post(`${prefix}/rollback`, (request, reply) =>
    action(reply, () => service.rollback(SkillRollbackRequest.parse(request.body))),
  );
}
