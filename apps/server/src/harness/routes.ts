import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ContentHash,
  canonicalJson,
  HarnessBindingRef,
  HarnessDocumentDraft,
  HarnessEntryKey,
  HarnessProfile,
  HarnessPublish,
  Identifier,
  McpServerDraft,
  ProjectToolConfig,
  ResourcePath,
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
  'codemode requires trusted-native policy',
  'MCP requires trusted-native policy',
  'mandatory skill size limit exceeded',
  'resource review expired or already installed',
  'package source requires an exact version or commit',
  'unknown or duplicate skill name',
  'package contains no supported skills or extensions',
  'selected project tool is not registered',
  'trust the repository before configuring tools',
  'trust the repository before inspecting tools',
  'no such registered tool',
  'MCP launch requires current fingerprint trust',
  'Sign in to the configured MCP server again.',
  'The saved MCP sign-in cannot be read; sign in again.',
  'resource editor size limit exceeded',
  'document is not a valid resource entry',
  'operation payload changed',
  'Remove this MCP server from the settings that use it first.',
  'MCP server ID was already used; create a new server.',
  'Choose an existing session working copy to test this server.',
  'MCP probe is busy or cleanup is unconfirmed',
  'MCP probe cancelled',
  'MCP probe timed out',
  'MCP probe failed',
  'MCP probe authorization failed',
  'MCP probe cleanup unconfirmed',
  'MCP settings are being saved; retry after completion',
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
        'management revision changed',
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
  const archive = z.strictObject({
    expectedRevision: revision,
    archived: z.boolean(),
    operationId: Identifier,
  });
  app.get(`${prefix}/entries`, () => service.entries());
  app.post(`${prefix}/entries/read`, (request, reply) =>
    action(reply, () => service.readEntry(HarnessEntryKey.parse(request.body))),
  );
  app.post(`${prefix}/documents/review`, (request, reply) =>
    action(reply, () => service.reviewDocument(HarnessDocumentDraft.parse(request.body))),
  );
  app.delete<{ Params: { reviewId: string } }>(`${prefix}/reviews/:reviewId`, (request, reply) =>
    action(reply, () => {
      service.cancelReview(Identifier.parse(request.params.reviewId));
      return { ok: true };
    }),
  );
  app.put(`${prefix}/entries/archive`, (request, reply) =>
    action(reply, () => {
      const body = archive.extend({ key: HarnessEntryKey }).parse(request.body);
      return service.archiveEntry(body.key, body.expectedRevision, body.archived, body.operationId);
    }),
  );
  app.get(`${prefix}/profile-management`, () => service.store.profileViews());
  app.put<{ Params: { profileId: string } }>(
    `${prefix}/profile-management/:profileId`,
    (request, reply) =>
      action(reply, () => {
        const body = archive.parse(request.body);
        return service.archiveProfile(
          Identifier.parse(request.params.profileId),
          body.expectedRevision,
          body.archived,
          body.operationId,
        );
      }),
  );
  app.post(`${prefix}/publish`, (request, reply) =>
    action(reply, () => service.publish(HarnessPublish.parse(request.body))),
  );
  type ProjectParams = { Params: { projectId: string } };
  type CheckParams = { Params: { projectId: string; commandId: string } };
  const mcp = () => {
    if (!service.mcp) throw new Error('MCP runtime unavailable');
    return service.mcp;
  };
  const configuredMcp = (projectId: string, id: string, configRevision?: number) => {
    const server = (
      configRevision === undefined
        ? files.projectTools.latest(projectId)
        : files.projectTools.get(projectId, configRevision)
    )?.mcpServers?.find((server) => server.id === id);
    if (!server) throw new Error('no such registered tool');
    return server;
  };
  app.get<CheckParams>(
    `${prefix}/projects/:projectId/mcp-servers/:commandId/auth`,
    (request, reply) =>
      action(reply, async () => {
        const projectId = Identifier.parse(request.params.projectId);
        return mcp().credentials.status(
          projectId,
          configuredMcp(projectId, Identifier.parse(request.params.commandId)),
        );
      }),
  );
  app.post<CheckParams>(
    `${prefix}/projects/:projectId/mcp-servers/:commandId/auth`,
    (request, reply) =>
      action(reply, async () => {
        const body = z
          .discriminatedUnion('action', [
            z.strictObject({
              action: z.literal('bearer'),
              fingerprint: ContentHash,
              token: z.string().min(1).max(16000),
            }),
            z.strictObject({ action: z.literal('sign_in'), fingerprint: ContentHash }),
            z.strictObject({
              action: z.literal('sign_out'),
              fingerprint: ContentHash,
              configRevision: z.int().positive().optional(),
            }),
          ])
          .parse(request.body);
        const projectId = Identifier.parse(request.params.projectId);
        if (body.action === 'sign_out') {
          const revision = body.configRevision ?? files.projectTools.latest(projectId)?.revision;
          const server = configuredMcp(
            projectId,
            Identifier.parse(request.params.commandId),
            revision,
          );
          if (
            server.transport === 'http' &&
            createHash('sha256').update(canonicalJson({ revision, server })).digest('hex') !==
              body.fingerprint
          )
            throw new WorkspaceError('REVISION_CONFLICT', 'MCP authentication target changed');
          if (server.transport === 'http' && server.auth.kind !== 'none')
            await mcp().credentials.delete(projectId, server);
          return mcp().credentials.status(projectId, server);
        }
        const { server, check } = await mcp().authentication(
          projectId,
          Identifier.parse(request.params.commandId),
          body.fingerprint,
        );
        if (body.action === 'sign_in')
          return mcp().credentials.startOAuth(projectId, server, check);
        if (body.action === 'bearer')
          await mcp().credentials.saveBearer(projectId, server, body.token, check);

        return mcp().credentials.status(projectId, server);
      }),
  );
  app.get<{ Params: { loginId: string } }>(`${prefix}/mcp-logins/:loginId`, (request, reply) =>
    action(reply, () => mcp().credentials.loginStatus(Identifier.parse(request.params.loginId))),
  );
  app.delete<{ Params: { loginId: string } }>(`${prefix}/mcp-logins/:loginId`, (request, reply) =>
    action(reply, async () => {
      await mcp().credentials.cancelOAuth(Identifier.parse(request.params.loginId));
      return { ok: true };
    }),
  );
  app.post<ProjectParams>(`${prefix}/projects/:projectId/criteria-files`, (request, reply) =>
    action(reply, () => {
      const { paths } = z
        .strictObject({ paths: z.array(ResourcePath).max(20) })
        .parse(request.body);
      return files.criteriaFiles(Identifier.parse(request.params.projectId), paths);
    }),
  );
  app.get<ProjectParams>(`${prefix}/projects/:projectId/tools`, (request, reply) =>
    action(reply, () =>
      reply
        .type('application/json')
        .send(
          JSON.stringify(files.projectTools.latest(Identifier.parse(request.params.projectId))),
        ),
    ),
  );
  app.post<ProjectParams>(`${prefix}/projects/:projectId/mcp`, (request, reply) =>
    action(reply, async () => {
      const body = z
        .strictObject({
          expectedRevision: revision,
          operationId: Identifier,
          draft: McpServerDraft,
          serverId: Identifier.optional(),
        })
        .parse(request.body);
      const projectId = Identifier.parse(request.params.projectId);
      return service.saveMcp(
        projectId,
        body.expectedRevision,
        body.operationId,
        body.draft,
        body.serverId,
      );
    }),
  );
  app.post<CheckParams>(
    `${prefix}/projects/:projectId/mcp-servers/:commandId/remove`,
    (request, reply) =>
      action(reply, async () => {
        const body = z
          .strictObject({
            expectedRevision: revision,
            operationId: Identifier,
            restoreRevision: z.int().positive().optional(),
          })
          .parse(request.body);
        const projectId = Identifier.parse(request.params.projectId);
        return service.removeMcp(
          projectId,
          body.expectedRevision,
          body.operationId,
          Identifier.parse(request.params.commandId),
          body.restoreRevision,
        );
      }),
  );
  app.get<ProjectParams>(`${prefix}/projects/:projectId/mcp-history`, (request, reply) =>
    action(reply, () => {
      const projectId = Identifier.parse(request.params.projectId);
      const current = service.projectTools.latest(projectId)?.mcpServers ?? [];
      const seen = new Set(current.map((server) => server.id));
      const authKey = (server: (typeof current)[number]) =>
        server.transport === 'http' && server.auth.kind !== 'none'
          ? canonicalJson({ id: server.id, url: server.url, auth: server.auth })
          : null;
      const credentials = new Set(current.map(authKey));
      return service.projectTools.history(projectId).flatMap((config) =>
        (config.mcpServers ?? []).flatMap((server) => {
          const canRestore = !seen.has(server.id);
          const key = authKey(server);
          const retiredAuth = key !== null && !credentials.has(key);
          seen.add(server.id);
          credentials.add(key);
          if (!canRestore && !retiredAuth) return [];
          return [
            {
              server,
              configRevision: config.revision,
              canRestore,
              fingerprint:
                server.transport === 'http'
                  ? createHash('sha256')
                      .update(canonicalJson({ revision: config.revision, server }))
                      .digest('hex')
                  : null,
            },
          ];
        }),
      );
    }),
  );
  app.get<CheckParams>(
    `${prefix}/projects/:projectId/mcp-servers/:commandId/usages`,
    (request, reply) =>
      action(reply, () =>
        files.mcpUsages(
          Identifier.parse(request.params.projectId),
          Identifier.parse(request.params.commandId),
        ),
      ),
  );
  app.put<ProjectParams>(`${prefix}/projects/:projectId/tools`, (request, reply) =>
    action(reply, async () => {
      const input = z
        .strictObject({ expectedRevision: revision, config: ProjectToolConfig })
        .parse(request.body);
      return mcp().updateTools(
        Identifier.parse(request.params.projectId),
        input.expectedRevision,
        () => input.config,
      );
    }),
  );
  for (const [segment, kind] of [
    ['checks', 'check'],
    ['lsp-servers', 'lsp'],
  ] as const) {
    app.get<CheckParams>(
      `${prefix}/projects/:projectId/${segment}/:commandId/launch`,
      (request, reply) =>
        action(reply, () =>
          files.inspectProjectTool(
            Identifier.parse(request.params.projectId),
            kind,
            Identifier.parse(request.params.commandId),
          ),
        ),
    );
    app.put<CheckParams>(
      `${prefix}/projects/:projectId/${segment}/:commandId/trust`,
      (request, reply) =>
        action(reply, () => {
          const input = z
            .strictObject({ fingerprint: ContentHash, trusted: z.boolean() })
            .parse(request.body);
          return files.trustProjectTool(
            Identifier.parse(request.params.projectId),
            kind,
            Identifier.parse(request.params.commandId),
            input.fingerprint,
            input.trusted,
          );
        }),
    );
  }
  app.get<CheckParams>(
    `${prefix}/projects/:projectId/mcp-servers/:commandId/launch`,
    (request, reply) =>
      action(reply, async () => {
        const query = z
          .object({
            revision: z.coerce.number().int().positive().optional(),
            sessionId: Identifier.optional(),
          })
          .parse(request.query);
        const projectId = Identifier.parse(request.params.projectId),
          serverId = Identifier.parse(request.params.commandId);
        if (!query.sessionId) return files.inspectMcpServer(projectId, serverId, query.revision);
        const { cwd: _cwd, ...view } = await files.mcpProbeContext(
          projectId,
          serverId,
          query.revision ?? files.projectTools.latest(projectId)?.revision ?? 0,
          query.sessionId,
        );
        return view;
      }),
  );
  app.put<CheckParams>(
    `${prefix}/projects/:projectId/mcp-servers/:commandId/trust`,
    (request, reply) =>
      action(reply, async () => {
        const input = z
          .strictObject({
            fingerprint: ContentHash,
            trusted: z.boolean(),
            sessionId: Identifier.optional(),
          })
          .parse(request.body);
        if (!input.trusted)
          await mcp().cancelProbe(undefined, Identifier.parse(request.params.projectId));
        return files.trustMcpServer(
          Identifier.parse(request.params.projectId),
          Identifier.parse(request.params.commandId),
          input.fingerprint,
          input.trusted,
          input.sessionId,
        );
      }),
  );
  app.post<CheckParams>(
    `${prefix}/projects/:projectId/mcp-servers/:commandId/probe`,
    (request, reply) =>
      action(reply, async () => {
        const input = z
          .strictObject({
            operationId: Identifier,
            configRevision: z.int().positive(),
            fingerprint: ContentHash,
            sessionId: Identifier.optional(),
          })
          .parse(request.body);
        const cancel = () => {
          void mcp()
            .cancelProbe(input.operationId)
            .catch(() => {});
        };
        reply.raw.once('close', cancel);
        try {
          return await mcp().probe(
            Identifier.parse(request.params.projectId),
            Identifier.parse(request.params.commandId),
            input,
          );
        } finally {
          reply.raw.off('close', cancel);
        }
      }),
  );
  app.delete<{ Params: { operationId: string } }>(
    `${prefix}/mcp-probes/:operationId`,
    (request, reply) =>
      action(reply, async () => {
        await mcp().cancelProbe(Identifier.parse(request.params.operationId));
        return { ok: true };
      }),
  );
  app.get(`${prefix}/resources`, async () => service.store.listResources());
  app.get<{ Params: { hash: string } }>(`${prefix}/resources/:hash`, (request, reply) =>
    action(reply, () => {
      const resource = service.store.getResource(ContentHash.parse(request.params.hash));
      if (!resource) throw new Error('resource not found');
      return resource;
    }),
  );
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
