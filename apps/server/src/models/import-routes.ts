import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LiveModels } from '../app.ts';
import { readWorkspaceConfig, type Workspace, writeModelConfig } from '../workspace.ts';
import { ModelCatalogService } from './catalog-service.ts';
import { endpointClashes, endpointsFrom, registerEndpoints } from './endpoints.ts';
import {
  IMPORT_SOURCES,
  type ImportDraft,
  type ImportSource,
  MAX_IMPORT_BYTES,
  parseModelImport,
} from './imports/parsers.ts';
import type { ModelRegistry } from './registry.ts';

const previewBody = z.strictObject({
  source: z.enum(IMPORT_SOURCES),
  path: z.string().min(1).max(2000).optional(),
});
const commitBody = z.strictObject({
  previewId: z.string().uuid(),
  revision: z.string().min(1).max(100),
  selected: z
    .array(z.strictObject({ id: z.string().min(1).max(100), copyKey: z.boolean() }))
    .min(1)
    .max(20),
});
const defaultPaths: Record<ImportSource, string[]> = {
  'claude-code': ['.claude', 'settings.json'],
  codex: ['.codex', 'config.toml'],
  opencode: ['.config', 'opencode', 'opencode.json'],
  pi: ['.pi', 'agent', 'models.json'],
};
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const profileId = (draft: ImportDraft) =>
  `import-${digest(`${draft.provider}/${draft.model}/${draft.baseUrl ?? ''}`)}`;
const providerId = (draft: ImportDraft) =>
  draft.baseUrl ? `import-${draft.provider}-${digest(draft.baseUrl)}` : draft.provider;

export function registerModelImportRoutes(
  app: FastifyInstance,
  options: {
    workspace: Workspace;
    registry: ModelRegistry | null;
    live: LiveModels | undefined;
    now?: () => number;
    previewId?: () => string;
  },
) {
  const { workspace, registry, live } = options;
  const now = options.now ?? Date.now;
  const nextPreviewId = options.previewId ?? randomUUID;
  const previews = new Map<
    string,
    { created: number; revision: string; drafts: ImportDraft[]; supported: boolean[] }
  >();
  const catalog = live
    ? new ModelCatalogService(join(live.configDir, 'model-catalog-v1.json'))
    : null;
  app.get('/api/v1/model-catalog/metadata', async () => catalog?.view() ?? null);
  app.post('/api/v1/model-catalog/metadata/refresh', async (_request, reply) =>
    catalog
      ? catalog.refresh()
      : reply.code(503).send({
          error: { code: 'CAPABILITY_DENIED', message: 'Live models are not configured.' },
        }),
  );
  app.post('/api/v1/model-imports/preview', async (request, reply) => {
    if (!registry || !live)
      return reply
        .code(503)
        .send({ error: { code: 'CAPABILITY_DENIED', message: 'Live models are not configured.' } });
    const body = previewBody.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({
        error: { code: 'SCHEMA_INVALID', message: 'Choose a source and configuration file.' },
      });
    let drafts: ImportDraft[];
    try {
      const path = body.data.path
        ? resolve(body.data.path)
        : join(homedir(), ...defaultPaths[body.data.source]);
      const file = await open(path, 'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_IMPORT_BYTES) throw new Error();
        const bytes = Buffer.alloc(MAX_IMPORT_BYTES + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = await file.read(bytes, length, bytes.length - length, null);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length > MAX_IMPORT_BYTES) throw new Error();
        drafts = parseModelImport(body.data.source, bytes.subarray(0, length).toString('utf8'));
      } finally {
        await file.close();
      }
    } catch {
      return reply.code(400).send({
        error: {
          code: 'SCHEMA_INVALID',
          message:
            'Cannot read this model configuration. Select a valid file up to 1 MiB; model fields must use supported JSON or TOML syntax.',
        },
      });
    }
    const snapshot = readWorkspaceConfig(workspace.root);
    const profiles = snapshot.config.modelProfiles ?? registry.profileConfigs();
    const candidates = drafts.map((draft, index) => {
      const old = profiles.find((profile) => profile.id === profileId(draft));
      const known = registry
        .catalog()
        .find((provider) => provider.providerId === draft.provider)
        ?.models.some((model) => model.id === draft.model);
      const reason =
        draft.unsupported ??
        (!draft.baseUrl && !known
          ? 'Model is not available in the runtime provider catalog. Add a supported endpoint or choose an available model.'
          : null);
      return {
        id: String(index),
        profileId: profileId(draft),
        provider: providerId(draft),
        model: draft.model,
        endpoint: draft.baseUrl ?? null,
        hasKey: Boolean(draft.secret),
        supported: reason === null,
        reason,
        warnings: draft.warnings,
        change: old ? 'replace' : 'add',
        previous: old
          ? {
              provider: old.provider,
              model: old.model,
              endpoint:
                snapshot.config.modelProviders?.find((p) => p.id === old.provider)?.baseUrl ?? null,
            }
          : null,
      };
    });
    for (const [id, preview] of previews) if (now() - preview.created > 600000) previews.delete(id);
    const oldest = previews.keys().next().value;
    if (previews.size >= 20 && oldest) previews.delete(oldest);
    const previewId = nextPreviewId();
    previews.set(previewId, {
      created: now(),
      revision: snapshot.revision,
      drafts,
      supported: candidates.map((candidate) => candidate.supported),
    });
    return { previewId, revision: snapshot.revision, source: body.data.source, candidates };
  });
  app.post('/api/v1/model-imports/commit', async (request, reply) => {
    if (!registry || !live)
      return reply
        .code(503)
        .send({ error: { code: 'CAPABILITY_DENIED', message: 'Live models are not configured.' } });
    const body = commitBody.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({
        error: { code: 'SCHEMA_INVALID', message: 'Choose models from a current preview.' },
      });
    const preview = previews.get(body.data.previewId);
    if (!preview || now() - preview.created > 600000 || preview.revision !== body.data.revision)
      return reply.code(409).send({
        error: {
          code: 'REVISION_CONFLICT',
          message: 'Preview expired. Read the configuration again.',
        },
      });
    const ids = new Set(body.data.selected.map((selection) => selection.id));
    if (
      ids.size !== body.data.selected.length ||
      body.data.selected.some(
        (selection) =>
          !/^(0|[1-9]\d*)$/.test(selection.id) || !preview.supported[Number(selection.id)],
      )
    )
      return reply.code(400).send({
        error: {
          code: 'SCHEMA_INVALID',
          message: 'The selection contains an unavailable or duplicate model.',
        },
      });
    const snapshot = readWorkspaceConfig(workspace.root);
    const profiles = [...(snapshot.config.modelProfiles ?? registry.profileConfigs())];
    const providers = structuredClone(snapshot.config.modelProviders ?? []);
    for (const selection of body.data.selected) {
      const draft = preview.drafts[Number(selection.id)];
      if (!draft) throw new Error('Validated import candidate is missing.');
      const profile = { id: profileId(draft), provider: providerId(draft), model: draft.model };
      const index = profiles.findIndex((item) => item.id === profile.id);
      if (index < 0) profiles.push(profile);
      else profiles[index] = { ...profiles[index], ...profile };
      if (draft.baseUrl) {
        let provider = providers.find((item) => item.id === profile.provider);
        if (!provider) {
          provider = {
            id: profile.provider,
            name: draft.provider,
            baseUrl: draft.baseUrl,
            access: 'api_key',
            models: [],
          };
          providers.push(provider);
        }
        // Imported metadata never grants reasoning/image capabilities.
        if (!provider.models.some((model) => model.id === draft.model))
          provider.models.push({ id: draft.model, reasoning: false, imageInput: false });
      }
    }
    const written = writeModelConfig(
      workspace.root,
      { modelProfiles: profiles, modelProviders: providers },
      body.data.revision,
      (config) => {
        const endpoints = endpointsFrom(config.modelProviders);
        return [
          ...endpointClashes(live.models, endpoints),
          ...registry.unknownProviders(config.modelProfiles ?? [], endpoints),
        ];
      },
    );
    if (!written.ok)
      return reply.code(written.conflict ? 409 : 400).send({
        error: {
          code: written.conflict ? 'REVISION_CONFLICT' : 'SCHEMA_INVALID',
          message: written.errors.join('; '),
        },
      });
    // No await occurs between the revision check, atomic config save and endpoint registration.
    workspace.config = written.config;
    workspace.configRevision = written.revision;
    const endpoints = endpointsFrom(written.config.modelProviders);
    registerEndpoints(live.models, endpoints);
    await registry.reconfigure(profiles, endpoints, written.revision);
    const keyFailures: string[] = [];
    for (const selection of body.data.selected) {
      const draft = preview.drafts[Number(selection.id)];
      if (!draft) throw new Error('Validated import candidate is missing.');
      if (!selection.copyKey || !draft.secret) continue;
      // Recheck after async credential writes. Existing origin binding is maintained by registry.
      if (readWorkspaceConfig(workspace.root).revision !== written.revision) {
        keyFailures.push(profileId(draft));
        continue;
      }
      try {
        await registry.setApiKey(providerId(draft), draft.secret);
      } catch {
        keyFailures.push(profileId(draft));
      }
    }
    previews.delete(body.data.previewId);
    const readback = readWorkspaceConfig(workspace.root);
    return {
      revision: readback.revision,
      modelProfiles: readback.config.modelProfiles ?? [],
      modelProviders: readback.config.modelProviders ?? [],
      keyFailures,
    };
  });
}
