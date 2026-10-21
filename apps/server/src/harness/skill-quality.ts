import { createHash } from 'node:crypto';
import {
  type Clock,
  canonicalJson,
  type HarnessProfile,
  type Scheduler,
  SkillAdoption,
  SkillAdoptRequest,
  SkillEvaluationRequest,
  SkillEvaluationView,
  type SkillFileComparison,
  SkillKey,
  SkillRollbackRequest,
  type SkillUpdatePreview,
} from '@corral/contracts';
import {
  autoDefinition,
  type Coordinator,
  type EvalReport,
  type EvalSuite,
  InProcessTransport,
  runSuite,
} from '@corral/core';
import type { Db } from '@corral/storage-sqlite';
import { systemTimers } from '../runtime.ts';
import type { HarnessService } from './service.ts';

const hash = (input: unknown) => createHash('sha256').update(canonicalJson(input)).digest('hex');
const sameKey = (a: SkillKey, b: SkillKey) =>
  a.resourceHash === b.resourceHash && a.entry === b.entry;

/** User-owned comparisons reuse the CLI evaluator and the application's Coordinator. */
export class SkillQualityService {
  private readonly pending = new Map<
    string,
    { controller: AbortController; done: Promise<SkillEvaluationView> }
  >();
  private readonly timers: Scheduler;
  private readonly deps: {
    db: Db;
    clock: Clock;
    harness: HarnessService;
    coordinator: Coordinator;
    timers?: Scheduler;
  };
  constructor(deps: SkillQualityService['deps']) {
    this.deps = deps;
    this.timers = deps.timers ?? systemTimers;
    deps.db
      .prepare(
        "UPDATE skill_evaluations SET view_json = json_set(view_json, '$.status', 'interrupted', '$.endedAt', ?) WHERE json_extract(view_json, '$.status') = 'running'",
      )
      .run(deps.clock.nowIso());
  }
  private resource(raw: SkillKey) {
    const key = SkillKey.parse(raw);
    const resource = this.deps.harness.store.getResource(key.resourceHash);
    if (!resource?.trustedAt) throw new Error('skill requires trust');
    this.deps.harness.readEntry(key);
    if (
      this.deps.harness.store.entryManagement(key).archivedAt ||
      this.deps.harness.store.packageManagement(key.resourceHash).status !== 'enabled'
    )
      throw new Error('skill is not active');
    const skill = resource.skills.find((entry) => entry.entry === key.entry);
    if (!skill) throw new Error('unknown skill entry');
    return { resource, skill };
  }
  preview(rawCandidate: SkillKey, rawBaseline?: SkillKey): SkillUpdatePreview {
    const candidate = SkillKey.parse(rawCandidate),
      baseline = rawBaseline ? SkillKey.parse(rawBaseline) : undefined;
    const next = this.resource(candidate),
      previous = baseline ? this.resource(baseline) : undefined;
    if (previous && (sameKey(candidate, baseline!) || previous.skill.name !== next.skill.name))
      throw new Error('update requires a different revision of the same skill');
    const oldFiles = new Map(previous?.resource.files.map((file) => [file.path, file.hash]) ?? []);
    const newFiles = new Map(next.resource.files.map((file) => [file.path, file.hash]));
    const changes: SkillUpdatePreview['changes'] = [];
    for (const path of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()) {
      if (oldFiles.get(path) === newFiles.get(path)) continue;
      const category = /(^|\/)(LICENSE|COPYING|NOTICE)/i.test(path)
        ? 'license'
        : /(^|\/)references\//.test(path)
          ? 'reference'
          : /(^|\/)(scripts|extensions)\/|\.(?:js|mjs|cjs|ts|py|sh)$/.test(path)
            ? 'script'
            : /(^|\/)(package\.json|.*permissions.*)$/.test(path)
              ? 'permissions'
              : 'source';
      changes.push({
        path,
        change: !oldFiles.has(path) ? 'added' : !newFiles.has(path) ? 'removed' : 'changed',
        category,
      });
    }
    return {
      candidate,
      baseline: baseline ?? null,
      changes,
      sourceChanged:
        !previous ||
        hash([
          previous.resource.sourceKind,
          previous.resource.sourceLabel,
          previous.resource.version,
        ]) !== hash([next.resource.sourceKind, next.resource.sourceLabel, next.resource.version]),
      licenseChanged:
        !previous ||
        previous.resource.license !== next.resource.license ||
        changes.some((change) => change.category === 'license'),
    };
  }
  get(id: string): SkillEvaluationView {
    const row = this.deps.db
      .prepare('SELECT view_json FROM skill_evaluations WHERE id = ?')
      .get(id) as { view_json: string } | undefined;
    if (!row) throw new Error('evaluation not found');
    return SkillEvaluationView.parse(JSON.parse(row.view_json));
  }
  compareFile(
    candidate: SkillKey,
    baseline: SkillKey | undefined,
    path: string,
  ): SkillFileComparison {
    const preview = this.preview(candidate, baseline);
    if (!preview.changes.some((change) => change.path === path)) throw new Error('no changed file');
    return {
      path,
      before: baseline ? this.deps.harness.reviewFile(baseline.resourceHash, path) : null,
      after: this.deps.harness.reviewFile(candidate.resourceHash, path),
    };
  }
  list(candidate: SkillKey) {
    SkillKey.parse(candidate);
    return (
      this.deps.db
        .prepare(
          "SELECT view_json FROM skill_evaluations WHERE json_extract(view_json, '$.request.candidate.resourceHash') = ? AND json_extract(view_json, '$.request.candidate.entry') = ? ORDER BY rowid DESC LIMIT 30",
        )
        .all(candidate.resourceHash, candidate.entry) as { view_json: string }[]
    ).map((row) => SkillEvaluationView.parse(JSON.parse(row.view_json)));
  }
  adoptions(candidate: SkillKey): SkillAdoption[] {
    SkillKey.parse(candidate);
    return (
      this.deps.db
        .prepare(`SELECT r.result_json FROM harness_management_receipts r JOIN skill_evaluations e
      ON json_extract(r.result_json, '$.evaluationId') = e.id
      WHERE json_extract(r.result_json, '$.kind') = 'skill_adoption'
      AND json_extract(e.view_json, '$.request.candidate.resourceHash') = ?
      AND json_extract(e.view_json, '$.request.candidate.entry') = ? ORDER BY r.rowid DESC LIMIT 30`)
        .all(candidate.resourceHash, candidate.entry) as { result_json: string }[]
    ).map((row) => SkillAdoption.parse(JSON.parse(row.result_json)));
  }
  private write(view: SkillEvaluationView) {
    this.deps.db
      .prepare(
        "UPDATE skill_evaluations SET view_json = ? WHERE id = ? AND json_extract(view_json, '$.status') = 'running'",
      )
      .run(JSON.stringify(SkillEvaluationView.parse(view)), view.id);
  }
  start(raw: SkillEvaluationRequest): SkillEvaluationView {
    const request = SkillEvaluationRequest.parse(raw),
      requestHash = hash(request);
    const prior = this.deps.db
      .prepare('SELECT request_hash FROM skill_evaluations WHERE id = ?')
      .get(request.operationId) as { request_hash: string } | undefined;
    if (prior) {
      if (prior.request_hash !== requestHash) throw new Error('operation payload changed');
      return this.get(request.operationId);
    }
    if (this.pending.size) throw new Error('another skill evaluation is running');
    const models = this.deps.coordinator.prepareModels([request.modelProfile], request.mode);
    if (!models.ok) throw new Error('evaluation model is unavailable');
    this.preview(request.candidate, request.baseline);
    const name = this.resource(request.candidate).skill.name;
    const release: (() => void)[] = [];
    const variants: EvalSuite['variants'] = [];
    const view: SkillEvaluationView = {
      id: request.operationId,
      requestHash,
      fixtureHash: hash(request.fixtures),
      request,
      status: 'running',
      createdAt: this.deps.clock.nowIso(),
      endedAt: null,
      runIds: [],
      results: [],
    };
    this.deps.db.transaction(() => {
      for (const variant of ['baseline', 'candidate'] as const) {
        const resource = variant === 'baseline' ? request.baseline : request.candidate;
        const profileId = `eval_${requestHash.slice(0, 24)}_${variant}`;
        this.deps.harness.saveProfile(profileId, 0, {
          name: 'Skill evaluation',
          policy: 'strict',
          allowedTools: ['read', 'read_artifact', 'write_artifact', 'submit_result'],
          resources: resource ? [{ ...resource, required: true, skillMode: 'auto' }] : [],
          startupCommands: [],
        });
        // Internal immutable snapshots remain readable but never enter the user's active list.
        this.deps.harness.store.manageProfile(profileId, 0, true);
        const definition = autoDefinition({
          id: profileId,
          template: 'single',
          brief: 'Evaluation fixture',
          choice: { modelProfile: request.modelProfile },
          fileTools: false,
          harness: { profileId, revision: 1 },
        });
        definition.roles[0]!.allowedCollaborationTools = ['read_artifact', 'submit_result'];
        definition.limits = {
          ...definition.limits,
          maxModelCalls: 4,
          maxOutputTokensPerCall: 1024,
          maxOutputTokens: 4096,
          runDeadlineMs: 60000,
        };
        variants.push({
          id: variant,
          corral: variant,
          group: variant === 'baseline' ? 'baseline' : 'specialist_skills',
          definition,
        });
      }
      this.deps.db
        .prepare('INSERT INTO skill_evaluations VALUES (?, ?, ?)')
        .run(view.id, requestHash, JSON.stringify(view));
    })();
    const cleanup = () => {
      for (const close of release) close();
      this.pending.delete(view.id);
    };
    try {
      for (const variant of variants)
        for (const fixture of request.fixtures)
          release.push(
            this.deps.harness.sealEvaluationDefinition({
              ...variant.definition,
              input: { ...variant.definition.input, brief: fixture.brief },
            }),
          );
    } catch (error) {
      view.status = 'failed';
      view.endedAt = this.deps.clock.nowIso();
      this.write(view);
      cleanup();
      throw error;
    }
    const controller = new AbortController();
    const done = this.run(view, variants, name, controller, models.models).finally(cleanup);
    this.pending.set(view.id, { controller, done });
    void done.catch(() => {});
    return this.get(view.id);
  }
  private async run(
    view: SkillEvaluationView,
    variants: EvalSuite['variants'],
    name: string,
    controller: AbortController,
    models: Record<string, import('@corral/contracts').ModelProfileSnapshot>,
  ) {
    const deadline = this.timers.after(15 * 60000, () => controller.abort());
    try {
      const transport = new InProcessTransport(this.deps.coordinator);
      transport.startRun = async (request) => this.deps.coordinator.startRun(request, models);
      await runSuite(
        transport,
        {
          comparison: 'skill_quality',
          repetitions: 1,
          variants,
          briefs: view.request.fixtures.map((fixture) => ({
            id: fixture.id,
            brief: fixture.brief,
            phase: fixture.phase,
            expected: fixture.expected,
            skillExpectation: {
              required: fixture.shouldActivate ? [name] : [],
              forbidden: fixture.shouldActivate ? [] : [name],
            },
          })),
        },
        view.request.mode,
        {
          signal: controller.signal,
          stopOnInput: true,
          now: () => this.deps.clock.monotonicMs(),
          wallNow: () => Date.parse(this.deps.clock.nowIso()),
          onStart: (id) => {
            view.runIds.push(id);
            this.write(view);
          },
          onCaseResult: (row: EvalReport['results'][number]) => {
            const snapshot = this.deps.coordinator.getRunSnapshot(row.runId);
            view.results.push({
              runId: row.runId,
              variant: row.variant as 'baseline' | 'candidate',
              fixtureId: row.brief,
              phase: row.phase,
              status: row.status,
              correct: row.quality?.finalCorrect ?? null,
              activationPassed: row.activation?.passed ?? null,
              output: row.output?.slice(0, 4096) ?? null,
              outputTruncated: (row.output?.length ?? 0) > 4096,
              definitionHash: row.definitionHash,
              harnessHashes: row.harnessHashes,
              modelHashes: Object.values(snapshot?.models ?? {}).map(hash),
              modelCalls: row.modelCalls,
              outputTokens: row.outputTokens,
              unknownTokens: row.unknownTokensHeld,
            });
            this.write(view);
          },
        },
      );
      view.status = controller.signal.aborted
        ? 'cancelled'
        : view.results.length === view.request.fixtures.length * 2
          ? 'completed'
          : 'failed';
    } catch {
      view.status = controller.signal.aborted ? 'cancelled' : 'failed';
    } finally {
      deadline();
      view.endedAt = this.deps.clock.nowIso();
      this.write(view);
    }
    return this.get(view.id);
  }
  cancel(id: string) {
    this.get(id);
    this.pending.get(id)?.controller.abort();
    return this.get(id);
  }
  async wait(id: string) {
    return this.pending.get(id)?.done ?? this.get(id);
  }
  async close() {
    const work = [...this.pending.values()];
    for (const item of work) item.controller.abort();
    await Promise.allSettled(work.map((item) => item.done));
  }
  adopt(raw: SkillAdoptRequest): SkillAdoption {
    const input = SkillAdoptRequest.parse(raw);
    return this.deps.harness.store.receipt(input.operationId, input, () => {
      const evaluation = this.get(input.evaluationId);
      if (evaluation.status !== 'completed') throw new Error('evaluation must be completed');
      this.preview(evaluation.request.candidate, evaluation.request.baseline);
      const currentDefault = this.deps.harness.store.getDefault(
        input.target.scope,
        input.target.scopeId,
      );
      if (
        currentDefault.revision !== input.target.expectedRevision ||
        canonicalJson(currentDefault.binding) !== canonicalJson(input.target.binding)
      )
        throw new Error('default revision changed');
      const current = this.deps.harness.store.getProfile(input.target.binding);
      if (!current) throw new Error('profile revision changed');
      const { profileId, revision, createdAt: _createdAt, ...profile } = current;
      const before = evaluation.request.baseline,
        candidate = evaluation.request.candidate;
      const slot = profile.resources.findIndex(
        (resource) =>
          resource.kind === 'skill' &&
          (before
            ? sameKey(resource as SkillKey, before)
            : sameKey(resource as SkillKey, candidate)),
      );
      if (before ? slot < 0 : slot >= 0)
        throw new Error('evaluation baseline does not match the selected profile');
      const resources = [...profile.resources];
      if (slot >= 0) resources[slot] = { ...resources[slot]!, ...candidate };
      else resources.push({ ...candidate, required: true, skillMode: 'auto' });
      const saved = this.deps.harness.saveProfile(profileId, revision, {
        ...profile,
        resources,
      } as HarnessProfile);
      const binding = { profileId, revision: saved.revision };
      const target = this.deps.harness.setDefault(
        input.target.scope,
        input.target.scopeId,
        input.target.expectedRevision,
        binding,
      );
      return SkillAdoption.parse({
        kind: 'skill_adoption',
        id: input.operationId,
        evaluationId: evaluation.id,
        target: input.target,
        binding,
        defaultRevision: target.revision,
      });
    });
  }
  rollback(raw: SkillRollbackRequest) {
    const input = SkillRollbackRequest.parse(raw);
    return this.deps.harness.store.receipt(input.operationId, input, () => {
      const adoption = SkillAdoption.parse(
        this.deps.harness.store.receiptOutcome(input.adoptionId),
      );
      const current = this.deps.harness.store.getDefault(
        adoption.target.scope,
        adoption.target.scopeId,
      );
      if (
        current.revision !== input.expectedRevision ||
        canonicalJson(current.binding) !== canonicalJson(adoption.binding)
      )
        throw new Error('default revision changed');
      return this.deps.harness.setDefault(
        adoption.target.scope,
        adoption.target.scopeId,
        input.expectedRevision,
        adoption.target.binding,
      );
    });
  }
}
