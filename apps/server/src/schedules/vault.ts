import { createHash } from 'node:crypto';
import {
  canonicalJson,
  Identifier,
  RunReferences,
  ScheduleDraft,
  ScheduleRule,
} from '@corral/contracts';
import { z } from 'zod';
import type { VaultDomainAdapter } from '../vault/types.ts';
import { ScheduleError, type ScheduleService } from './service.ts';

const item = z.strictObject({
  sourceId: Identifier,
  sourceRevision: z.int().min(1),
  title: ScheduleDraft.shape.title,
  timezone: ScheduleDraft.shape.timezone,
  rule: ScheduleRule,
  request: ScheduleDraft.shape.request.omit({ references: true }),
  sourceReferences: RunReferences.optional(),
  sourceTarget: z.strictObject({ projectId: Identifier, sessionId: Identifier }),
  wasEnabled: z.boolean(),
});
const portable = z.strictObject({ version: z.literal(1), schedules: z.array(item).max(500) });
const prepared = z.strictObject({
  version: z.literal(1),
  entries: z.array(z.strictObject({ id: Identifier, draft: ScheduleDraft })).max(500),
});
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Portable source IDs are provenance, never implicit permission to bind a local session. */
export function scheduleVaultAdapter(service: ScheduleService): VaultDomainAdapter {
  const revision = () =>
    hash(
      service.store.list().map((s) => ({ id: s.id, revision: s.revision, deletedAt: s.deletedAt })),
    );
  return {
    async receipt(operationId) {
      const operation = service.store.importOperation(operationId);
      return operation ? { revision: operation.revision } : null;
    },
    async capture() {
      return {
        revision: revision(),
        value: {
          version: 1,
          schedules: service.list().map((schedule) => {
            const { references, ...request } = schedule.request;
            return {
              sourceId: schedule.id,
              sourceRevision: schedule.revision,
              title: schedule.title,
              timezone: schedule.timezone,
              rule: schedule.rule,
              request,
              ...(references ? { sourceReferences: references } : {}),
              sourceTarget: { projectId: schedule.projectId, sessionId: schedule.sessionId },
              wasEnabled: schedule.enabled,
            };
          }),
        },
      };
    },
    async preview(value, bindings) {
      const input = portable.parse(value);
      if (new Set(input.schedules.map((s) => s.sourceId)).size !== input.schedules.length)
        throw new ScheduleError(400, 'Duplicate schedule source IDs.');
      const entries = await Promise.all(
        input.schedules.map(async (source) => {
          const projectId = bindings[`${source.sourceId}:projectId`];
          const sessionId = bindings[`${source.sourceId}:sessionId`];
          if (!projectId || !sessionId)
            throw new ScheduleError(
              400,
              `Choose explicit local project and session bindings for ${source.sourceId}.`,
            );
          let references: z.infer<typeof RunReferences> | undefined;
          if (source.sourceReferences?.length) {
            const local = bindings[`${source.sourceId}:references`];
            if (!local)
              throw new ScheduleError(
                400,
                `Resolve local references for ${source.sourceId} before import.`,
              );
            references = RunReferences.parse(JSON.parse(local));
            if (!references.length)
              throw new ScheduleError(
                400,
                'Referenced material cannot be silently removed during import.',
              );
          }
          const draft = ScheduleDraft.parse({
            title: source.title,
            timezone: source.timezone,
            rule: source.rule,
            enabled: false,
            hostId: 'local',
            projectId,
            sessionId,
            request: { ...source.request, ...(references ? { references } : {}) },
          });
          await service.validateTarget(draft);
          return { id: source.sourceId, draft };
        }),
      );
      return {
        value: { version: 1, entries },
        warnings: [
          'All imported schedules remain disabled. Review local targets, permissions and model profiles before enabling.',
        ],
      };
    },
    async apply(value, expectedRevision, operationId) {
      const data = prepared.parse(value);
      if (data.entries.some((entry) => entry.draft.enabled))
        throw new ScheduleError(400, 'Imported schedules must remain disabled.');
      for (const entry of data.entries) await service.validateTarget(entry.draft);
      return service.applyPortable(
        data.entries,
        expectedRevision,
        operationId,
        hash(value),
        revision,
      );
    },
    async restore(snapshot, expectedRevision, operationId) {
      const data = portable.parse(snapshot.value);
      const entries = data.schedules.map((source) => ({
        id: source.sourceId,
        draft: ScheduleDraft.parse({
          title: source.title,
          timezone: source.timezone,
          rule: source.rule,
          enabled: source.wasEnabled,
          hostId: 'local',
          ...source.sourceTarget,
          request: {
            ...source.request,
            ...(source.sourceReferences ? { references: source.sourceReferences } : {}),
          },
        }),
      }));
      for (const entry of entries) await service.validateTarget(entry.draft);
      return service.applyPortable(
        entries,
        expectedRevision,
        operationId,
        hash(snapshot),
        revision,
        true,
      );
    },
  };
}
