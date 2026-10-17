import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ContentHash,
  HarnessBindingRef,
  HarnessProfile,
  Identifier,
  ProjectToolConfig,
} from '@corral/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { WorkspaceError, type WorkspaceService } from '../files/service.ts';
import type { HarnessService } from './service.ts';

const revision = z.int().min(0);
const scope = z.enum(['personal', 'project']);
const safeErrors = new Set([
  'resource requires trust before binding',
  'resource integrity changed; review and trust the new content',
  'strict policy refuses native extensions',
  'mandatory skill size limit exceeded',
  'resource review expired or already installed',
  'package source requires an exact version or commit',
  'unknown or duplicate skill name',
  'package contains no supported skills or extensions',
  'selected project tool is not registered',
  'trust the repository before configuring tools',
  'trust the repository before inspecting checks',
  'no such registered check',
]);

/** Filesystem, package-manager and parser errors never reach the browser verbatim. */
async function action(reply: FastifyReply, work: () => unknown) {
  try {
    return await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const conflict =
      [
        'profile revision changed',
        'default revision changed',
        'project tool revision changed',
      ].includes(message) ||
      (error instanceof WorkspaceError && error.code === 'REVISION_CONFLICT');
    return reply.code(conflict ? 409 : 400).send({
      error: {
        code: conflict ? 'STALE_CONTROL_REVISION' : 'SCHEMA_INVALID',
        message: conflict
          ? 'The saved revision changed. Reload before saving.'
          : safeErrors.has(message)
            ? message
            : 'Resource or profile could not be validated. Check the source, trust and selected revision.',
      },
    });
  }
}

export function registerHarnessRoutes(
  app: FastifyInstance,
  service: HarnessService,
  files: WorkspaceService,
) {
  const prefix = '/api/v1/harness';
  type ProjectParams = { Params: { projectId: string } };
  type CheckParams = { Params: { projectId: string; commandId: string } };
  app.get<ProjectParams>(`${prefix}/projects/:projectId/tools`, (request, reply) =>
    action(reply, () =>
      reply
        .type('application/json')
        .send(
          JSON.stringify(files.projectTools.latest(Identifier.parse(request.params.projectId))),
        ),
    ),
  );
  app.put<ProjectParams>(`${prefix}/projects/:projectId/tools`, (request, reply) =>
    action(reply, () => {
      const input = z
        .strictObject({ expectedRevision: revision, config: ProjectToolConfig })
        .parse(request.body);
      return files.configureProjectTools(
        Identifier.parse(request.params.projectId),
        input.expectedRevision,
        input.config,
      );
    }),
  );
  app.get<CheckParams>(`${prefix}/projects/:projectId/checks/:commandId/launch`, (request, reply) =>
    action(reply, () =>
      files.inspectCheck(
        Identifier.parse(request.params.projectId),
        Identifier.parse(request.params.commandId),
      ),
    ),
  );
  app.put<CheckParams>(`${prefix}/projects/:projectId/checks/:commandId/trust`, (request, reply) =>
    action(reply, () => {
      const input = z
        .strictObject({ fingerprint: ContentHash, trusted: z.boolean() })
        .parse(request.body);
      return files.trustCheck(
        Identifier.parse(request.params.projectId),
        Identifier.parse(request.params.commandId),
        input.fingerprint,
        input.trusted,
      );
    }),
  );
  app.get(`${prefix}/resources`, async () => service.store.listResources());
  app.get(`${prefix}/profiles`, async () => service.store.listProfiles());
  app.post(`${prefix}/reviews`, (request, reply) =>
    action(reply, () => {
      const input = z
        .union([
          z.strictObject({
            kind: z.enum(['local', 'package']),
            source: z.string().min(1).max(1000),
          }),
          z.strictObject({ kind: z.literal('pi-home') }),
        ])
        .parse(request.body);
      if (input.kind === 'pi-home') return service.discoverPiHome(join(homedir(), '.pi', 'agent'));
      return input.kind === 'local'
        ? service.discoverLocal(input.source)
        : service.discoverPackage(input.source);
    }),
  );
  app.post(`${prefix}/resources`, (request, reply) =>
    action(reply, () => {
      const { reviewId } = z.strictObject({ reviewId: Identifier }).parse(request.body);
      return service.install(reviewId);
    }),
  );
  app.put<{ Params: { hash: string } }>(`${prefix}/resources/:hash/trust`, (request, reply) =>
    action(reply, () => {
      const { trusted } = z.strictObject({ trusted: z.boolean() }).parse(request.body);
      return service.trust(ContentHash.parse(request.params.hash), trusted);
    }),
  );
  app.get<{ Params: { profileId: string; revision: string } }>(
    `${prefix}/profiles/:profileId/:revision`,
    (request, reply) =>
      action(reply, () => {
        const binding = HarnessBindingRef.parse({
          profileId: request.params.profileId,
          revision: Number(request.params.revision),
        });
        const profile = service.store.getProfile(binding);
        if (!profile) throw new Error('profile not found');
        return profile;
      }),
  );
  app.put<{ Params: { profileId: string } }>(`${prefix}/profiles/:profileId`, (request, reply) =>
    action(reply, () => {
      const input = z
        .strictObject({ expectedRevision: revision, profile: HarnessProfile })
        .parse(request.body);
      return service.saveProfile(
        Identifier.parse(request.params.profileId),
        input.expectedRevision,
        input.profile,
      );
    }),
  );
  app.post(`${prefix}/preview`, (request, reply) =>
    action(reply, () => {
      const input = z
        .strictObject({
          binding: HarnessBindingRef,
          projectId: Identifier,
          runOverride: HarnessBindingRef.optional(),
        })
        .parse(request.body);
      return service.preview(input.binding, input.projectId, input.runOverride);
    }),
  );
  type DefaultParams = { Params: { scope: string; scopeId: string } };
  const defaultParams = z
    .strictObject({ scope, scopeId: Identifier })
    .refine((value) => value.scope !== 'personal' || value.scopeId === 'default');
  app.get<DefaultParams>(`${prefix}/defaults/:scope/:scopeId`, (request, reply) =>
    action(reply, () => {
      const params = defaultParams.parse(request.params);
      return service.store.getDefault(params.scope, params.scopeId);
    }),
  );
  app.put<DefaultParams>(`${prefix}/defaults/:scope/:scopeId`, (request, reply) =>
    action(reply, () => {
      const params = defaultParams.parse(request.params);
      const input = z
        .strictObject({ expectedRevision: revision, binding: HarnessBindingRef.nullable() })
        .parse(request.body);
      return service.setDefault(
        params.scope,
        params.scopeId,
        input.expectedRevision,
        input.binding,
      );
    }),
  );
}
