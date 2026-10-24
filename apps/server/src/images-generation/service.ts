import { createHash } from 'node:crypto';
import { providerFailure } from '@corral/adapter-pi/request-policy';
import {
  canonicalJson,
  GENERATED_IMAGE_MAX_BYTES,
  GenerateImageArgs,
  type ImageGenerationOwner,
  ImageGenerationProfile,
  type ImageGenerationResult,
  ImageInput,
  type ModelAttempt,
  type ModelAttemptStore,
} from '@corral/contracts';
import type { ToolCancellation } from '@corral/core';
import type { Db } from '@corral/storage-sqlite';
import { GeneratedMediaStore } from './artifact-store.ts';

/** Supplied only by the server's registered profile/credential resolver. Never sent to Studio. */
export interface ResolvedImageProfile {
  profile: ImageGenerationProfile;
  baseUrl: string;
  apiKey(): Promise<string | undefined>;
}
export class ImageGenerationUnavailable extends Error {
  readonly outcome: 'not_started' | 'unknown';
  constructor(message: string, outcome: 'not_started' | 'unknown') {
    super(message);
    this.outcome = outcome;
  }
}
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const MAX_RESPONSE = Math.ceil((GENERATED_IMAGE_MAX_BYTES * 4) / 3) + 65536;

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('image provider returned no body');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > MAX_RESPONSE)
        throw new Error('image provider response exceeds the output limit');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel();
  }
}

export class ImageGenerationService {
  private readonly media: GeneratedMediaStore;
  private readonly db: Db;
  private readonly resolve: (profileId: string) => Promise<ResolvedImageProfile | null>;
  private readonly fetcher: typeof fetch;
  private readonly attempts?: ModelAttemptStore;
  private readonly now: () => string;
  constructor(
    db: Db,
    resolve: (profileId: string) => Promise<ResolvedImageProfile | null>,
    now: () => string,
    fetcher: typeof fetch = fetch,
    attempts?: ModelAttemptStore,
  ) {
    this.db = db;
    this.attempts = attempts;
    this.now = now;
    this.resolve = resolve;
    this.fetcher = fetcher;
    this.media = new GeneratedMediaStore(db, now);
    // Requests surviving a host restart must not incur another provider call.
    db.prepare(
      "UPDATE image_generation_operations SET state='unknown' WHERE state='running'",
    ).run();
  }
  async generate(
    owner: ImageGenerationOwner,
    raw: GenerateImageArgs,
    cancellation: ToolCancellation,
    /** Coordinator already reserved this upper bound; the server may not increase it. */
    reservedCostUsd: number,
    expectedProfile?: ImageGenerationProfile,
    referenceImages: ImageInput[] = [],
  ): Promise<ImageGenerationResult> {
    const args = GenerateImageArgs.parse(raw);
    const references = referenceImages.map((image) => ImageInput.parse(image));
    if (
      canonicalJson(references.map((image) => image.imageId)) !==
      canonicalJson(args.references ?? [])
    )
      throw new ImageGenerationUnavailable(
        'image references were not authorized by the Coordinator',
        'not_started',
      );
    for (const image of references) {
      const bytes = Buffer.from(image.data, 'base64');
      if (
        bytes.length !== image.bytes ||
        createHash('sha256').update(bytes).digest('hex') !== image.sha256
      )
        throw new ImageGenerationUnavailable('image reference integrity changed', 'not_started');
    }
    if (cancellation.aborted)
      throw new ImageGenerationUnavailable('image generation cancelled', 'not_started');
    const resolved = await this.resolve(args.profileId);
    if (!resolved)
      throw new ImageGenerationUnavailable(
        'configure an image generation profile in model settings',
        'not_started',
      );
    const profile = ImageGenerationProfile.parse(resolved.profile);
    if (expectedProfile && canonicalJson(profile) !== canonicalJson(expectedProfile))
      throw new ImageGenerationUnavailable('image profile changed after Run start', 'not_started');
    if (
      profile.profileId !== args.profileId ||
      reservedCostUsd < profile.maxCostUsdPerCall ||
      !Number.isFinite(reservedCostUsd)
    )
      throw new ImageGenerationUnavailable(
        'image profile or cost reservation changed',
        'not_started',
      );
    const endpoint = new URL(
      `${resolved.baseUrl.replace(/\/+$/, '')}/images/${references.length ? 'edits' : 'generations'}`,
    );
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      (endpoint.protocol !== 'https:' &&
        !(
          endpoint.protocol === 'http:' &&
          ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)
        ))
    )
      throw new ImageGenerationUnavailable('image profile endpoint is unsupported', 'not_started');
    const identity = hash({
      owner,
      args,
      profile,
      endpoint: endpoint.toString(),
      references: references.map(({ data: _data, ...metadata }) => metadata),
    });
    const existing = this.db
      .prepare(
        'SELECT identity_hash,state,result_json FROM image_generation_operations WHERE run_id=? AND effect_id=?',
      )
      .get(owner.runId, owner.effectId) as
      | { identity_hash: string; state: string; result_json: string | null }
      | undefined;
    if (existing) {
      if (existing.identity_hash !== identity)
        throw new ImageGenerationUnavailable('image operation identity changed', 'not_started');
      if (
        existing.state === 'completed' &&
        existing.result_json &&
        this.media.read(owner.runId, owner.artifactVersionId)
      )
        return JSON.parse(existing.result_json) as ImageGenerationResult;
      throw new ImageGenerationUnavailable(
        'image operation already started; outcome requires reconciliation',
        'unknown',
      );
    }
    const key = await resolved.apiKey();
    if (!key)
      throw new ImageGenerationUnavailable(
        'image profile credential is unavailable',
        'not_started',
      );
    if (cancellation.aborted)
      throw new ImageGenerationUnavailable('image generation cancelled', 'not_started');
    const attempt: ModelAttempt = {
      version: 2,
      attemptId: `image_${owner.runId}_${owner.effectId}`,
      intent: {
        requestId: owner.effectId,
        purpose: 'image',
        revision: owner.attemptNo,
        owner: {
          kind: 'image',
          id: owner.effectId,
          runId: owner.runId,
          executionId: owner.executionId,
        },
      },
      provider: profile.api,
      modelId: profile.modelId,
      status: 'started',
      startedAt: this.now(),
      endedAt: null,
      payloadHash: hash(args),
      payloadBytes: Buffer.byteLength(canonicalJson(args)),
      firstEventAt: null,
      failure: null,
      usage: {
        version: 2,
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        source: 'unknown',
        costStatus: 'unknown',
        costUsd: null,
      },
    };
    try {
      this.db.transaction(() => {
        const count = this.db
          .prepare(
            'SELECT COUNT(*) AS count FROM image_generation_operations WHERE run_id=? AND profile_id=?',
          )
          .get(owner.runId, profile.profileId) as { count: number };
        if (count.count >= profile.maxCallsPerRun)
          throw new ImageGenerationUnavailable(
            'image generation call limit reached',
            'not_started',
          );
        this.db
          .prepare("INSERT INTO image_generation_operations VALUES (?,?,?,?,'running',NULL)")
          .run(owner.runId, owner.effectId, identity, profile.profileId);
        this.attempts?.put(attempt);
      })();
    } catch (error) {
      if (error instanceof ImageGenerationUnavailable) throw error;
      throw new ImageGenerationUnavailable('image request could not be recorded', 'not_started');
    }

    const abort = new AbortController();
    const off = cancellation.onCancel(() => abort.abort());
    const timer = setTimeout(() => abort.abort(), profile.timeoutMs);
    let dispatched = false;
    try {
      // Public Images API: explicit model, one PNG, base64 response. No redirects or URL downloads.
      const fields = {
        model: profile.modelId,
        prompt: args.prompt,
        n: 1,
        output_format: 'png',
        ...(args.size ? { size: args.size } : {}),
        ...(args.quality ? { quality: args.quality } : {}),
      };
      let requestBody: string | FormData = JSON.stringify(fields);
      if (references.length) {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
        for (const image of references)
          form.append(
            'image[]',
            new Blob([Buffer.from(image.data, 'base64')], { type: image.mime }),
            image.name,
          );
        requestBody = form;
      }
      dispatched = true;
      const response = await this.fetcher(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: abort.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          ...(references.length ? {} : { 'Content-Type': 'application/json' }),
        },
        body: requestBody,
      });
      if (!response.ok) throw new Error(`image provider HTTP ${response.status}`);
      const body = (await boundedJson(response)) as {
        data?: { b64_json?: unknown }[];
        usage?: { input_tokens?: unknown; output_tokens?: unknown };
      };
      const tokenCount = (value: unknown) =>
        Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
      const usage = {
        inputTokens: tokenCount(body.usage?.input_tokens),
        outputTokens: tokenCount(body.usage?.output_tokens),
      };
      attempt.usage = {
        ...attempt.usage,
        ...usage,
        source: usage.inputTokens !== null && usage.outputTokens !== null ? 'reported' : 'unknown',
      };
      this.attempts?.put(attempt);
      const encoded = body.data?.length === 1 ? body.data[0]?.b64_json : null;
      if (
        typeof encoded !== 'string' ||
        encoded.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
      )
        throw new Error('image provider returned unsupported image content');
      if (cancellation.aborted || abort.signal.aborted)
        throw new Error('image generation cancelled after dispatch');
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded)
        throw new Error('noncanonical generated image encoding');
      const media = this.media.put(owner, bytes);
      const result: ImageGenerationResult = {
        media,
        usage,
        costUsd: null,
      };
      attempt.status = 'completed';
      attempt.endedAt = this.now();
      this.db.transaction(() => {
        this.db
          .prepare(
            "UPDATE image_generation_operations SET state='completed',result_json=? WHERE run_id=? AND effect_id=?",
          )
          .run(canonicalJson(result), owner.runId, owner.effectId);
        this.attempts?.put(attempt);
      })();
      return result;
    } catch (error) {
      attempt.status = dispatched ? 'unknown' : 'failed';
      attempt.endedAt = this.now();
      attempt.failure = providerFailure(error);
      this.db
        .prepare(
          "UPDATE image_generation_operations SET state='unknown' WHERE run_id=? AND effect_id=?",
        )
        .run(owner.runId, owner.effectId);
      try {
        this.attempts?.put(attempt);
      } catch {
        /* The operation remains durably unknown; never resend it. */
      }
      // Provider bodies/errors may contain secrets or prompts. Keep only a bounded safe diagnosis.
      throw new ImageGenerationUnavailable(
        dispatched
          ? 'image provider operation did not produce a confirmed artifact; billing may be unknown'
          : 'image request could not be prepared',
        dispatched ? 'unknown' : 'not_started',
      );
    } finally {
      clearTimeout(timer);
      off();
    }
  }
  read(runId: string, versionId: string) {
    return this.media.read(runId, versionId);
  }
  cleanupOrphans(): number {
    const runs = this.db
      .prepare(
        "SELECT DISTINCT m.run_id FROM generated_media m JOIN runs r ON r.id=m.run_id WHERE r.status IN ('succeeded','failed','cancelled','interrupted')",
      )
      .all() as { run_id: string }[];
    let removed = 0;
    for (const run of runs) {
      const events = this.db
        .prepare(
          "SELECT event_json FROM run_events WHERE run_id=? AND type='artifact.version_created'",
        )
        .all(run.run_id) as { event_json: string }[];
      const published = new Set(
        events.map((row) => String(JSON.parse(row.event_json).payload.artifactVersionId)),
      );
      removed += this.media.discardUnpublished(run.run_id, published);
    }
    return removed;
  }
}
