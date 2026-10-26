import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type {
  AgentHost,
  AgentStartInput,
  ImageGenerationOwner,
  ImageGenerationProfile,
} from '@corral/contracts';
import { Coordinator, exportRunArchive, openRunArchive } from '@corral/core';
import { openDatabase, SqliteModelAttemptStore, SqliteRunStore } from '@corral/storage-sqlite';
import { FakeClock, Gate, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { PNG } from 'pngjs';
import { describe, expect, it, vi } from 'vitest';
import { MEDIA_ARTIFACT_MIGRATION } from '../../../packages/storage-sqlite/src/media-migration.ts';
import { GeneratedMediaStore } from '../src/images-generation/artifact-store.ts';
import { ImageGenerationService } from '../src/images-generation/service.ts';

const profile: ImageGenerationProfile = {
  profileId: 'images',
  modelProfileId: 'image_credentials',
  modelId: 'configured-image-model',
  api: 'openai-images',
  timeoutMs: 1000,
  maxCallsPerRun: 2,
  maxCostUsdPerCall: 0.2,
};
const owner: ImageGenerationOwner = {
  runId: 'run_one',
  executionId: 'exec_one',
  attemptNo: 1,
  effectId: 'effect_one',
  artifactVersionId: 'artifact_one',
};
const args = { profileId: 'images', prompt: 'A small red square', size: '1024x1024' as const };
const now = () => '2026-10-20T10:00:00.000Z';
const idle = { aborted: false, onCancel: () => () => {} };
const png = () => PNG.sync.write(new PNG({ width: 3, height: 2 }));
function database() {
  const db = openDatabase(':memory:');
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='generated_media'").get())
    db.exec(MEDIA_ARTIFACT_MIGRATION.sql);
  db.prepare(
    "INSERT INTO runs (id,corral_id,definition_hash,snapshot_json,status,last_seq,projection_json,started_at) VALUES ('run_one','corral_one','hash','{}','running',0,'{}','now')",
  ).run();
  return db;
}
async function endpoint(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
) {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing HTTP address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('configured image generation and immutable bytes (ABS-10)', () => {
  it.each(['started', 'completed'] as const)(
    'a ledger failure at %s cannot leave a confirmed generation or leak cleanup',
    async (stage) => {
      const db = database(),
        attempts = new SqliteModelAttemptStore(db);
      let active = 0;
      const original = attempts.put.bind(attempts);
      vi.spyOn(attempts, 'put').mockImplementation((value) => {
        if (value.status === stage) throw new Error('storage unavailable');
        original(value);
      });
      const fetcher = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [{ b64_json: png().toString('base64') }],
              usage: { input_tokens: 1, output_tokens: 2 },
            }),
          ),
      );
      const service = new ImageGenerationService(
        db,
        async () => ({ profile, baseUrl: 'http://127.0.0.1/v1', apiKey: async () => 'fixture' }),
        now,
        fetcher,
        attempts,
      );
      try {
        await expect(
          service.generate(
            owner,
            args,
            {
              aborted: false,
              onCancel: () => {
                active++;
                return () => {
                  active--;
                };
              },
            },
            0.2,
          ),
        ).rejects.toMatchObject({ outcome: stage === 'started' ? 'not_started' : 'unknown' });
        expect(active).toBe(0);
        expect(fetcher).toHaveBeenCalledTimes(stage === 'started' ? 0 : 1);
        const operation = db
          .prepare('SELECT state FROM image_generation_operations WHERE run_id=? AND effect_id=?')
          .get(owner.runId, owner.effectId);
        expect(operation).toEqual(stage === 'started' ? undefined : { state: 'unknown' });
      } finally {
        db.close();
      }
    },
  );
  it('received image usage survives cancellation before artifact adoption', async () => {
    const db = database(),
      attempts = new SqliteModelAttemptStore(db);
    let received = false;
    try {
      const service = new ImageGenerationService(
        db,
        async () => ({ profile, baseUrl: 'http://127.0.0.1/v1', apiKey: async () => 'fixture' }),
        now,
        async () => {
          received = true;
          return new Response(
            JSON.stringify({
              data: [{ b64_json: png().toString('base64') }],
              usage: { input_tokens: 12, output_tokens: 34 },
            }),
          );
        },
        attempts,
      );
      await expect(
        service.generate(
          owner,
          args,
          {
            get aborted() {
              return received;
            },
            onCancel: () => () => {},
          },
          0.2,
        ),
      ).rejects.toMatchObject({ outcome: 'unknown' });
      expect(service.read(owner.runId, owner.artifactVersionId)).toBeNull();
      expect(attempts.list()[0]).toMatchObject({
        status: 'unknown',
        usage: { source: 'reported', inputTokens: 12, outputTokens: 34 },
      });
    } finally {
      db.close();
    }
  });
  it('Coordinator capability, effect, published artifact and private export include verified original bytes', async () => {
    const db = database(),
      bytes = png(),
      started = new Gate(),
      done = new Gate();
    let host!: AgentHost;
    const inputs: AgentStartInput[] = [];
    const http = await endpoint((_request, response) => {
      response.end(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }));
    });
    try {
      const service = new ImageGenerationService(
        db,
        async () => ({ profile, baseUrl: http.baseUrl, apiKey: async () => 'fixture' }),
        now,
      );
      const store = new SqliteRunStore(db),
        clock = new FakeClock();
      const coordinator = new Coordinator({
        clock,
        timers: clock,
        store,
        ids: new SequentialIdFactory(),
        models: {
          resolve: (profile) => ({
            ok: true,
            snapshot: {
              profile,
              provider: null,
              modelId: null,
              auth: 'mock',
              imageInput: true,
            },
          }),
        },
        imageGeneration: {
          read: (runId, versionId) => {
            const stored = service.read(runId, versionId);
            return stored
              ? {
                  kind: 'image_attachment',
                  imageId: versionId,
                  name: 'generated.png',
                  mime: 'image/png',
                  bytes: stored.media.bytes,
                  width: stored.media.width,
                  height: stored.media.height,
                  sha256: stored.media.sha256,
                  data: stored.bytes.toString('base64'),
                }
              : null;
          },
          resolve: () => profile,
          generate: (owner, args, pinned, cancellation, reserved) =>
            service.generate(owner, args, cancellation, reserved, pinned),
        },
        agents: {
          start: async (_input, h) => {
            inputs.push(_input);
            host = h;
            started.open();
            return {
              cancel: async () => done.open(),
              waitForSettlement: async () => {
                await done.wait();
                return { outcome: 'cancelled' as const };
              },
            };
          },
        },
      });
      const definition = linearCorral(['writer']);
      const role = definition.roles[0]!;
      role.allowedWorkTools.push('generate_image');
      role.allowedCollaborationTools.push('read_artifact');
      role.imageProfile = profile.profileId;
      const startedRun = coordinator.startRun({
        schemaVersion: '0.1',
        commandId: 'start_image',
        definition,
        mode: 'mock',
        permissionMode: 'auto',
      });
      if (!startedRun.runId) throw new Error(startedRun.receipt.error?.message);
      await started.wait();
      const result = await host.invokeTool({ name: 'generate_image', args });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      const versionId = String(result.result.artifactVersionId);
      expect(
        coordinator.getSnapshot(startedRun.runId).projection.artifacts[versionId]?.media,
      ).toMatchObject({ width: 3, height: 2 });
      expect(service.read(startedRun.runId, versionId)?.bytes).toEqual(bytes);
      const read = await host.invokeTool({
        name: 'read_artifact',
        args: { artifactVersionId: versionId },
      });
      expect(read.ok).toBe(true);
      if (read.ok)
        expect(read.result.images).toMatchObject([
          { data: bytes.toString('base64'), imageId: versionId },
        ]);
      expect(coordinator.getSnapshot(startedRun.runId).projection.budget).toMatchObject({
        imageSpentMicros: 0,
        imageReservedMicros: 0,
        imageUnknownOutstandingMicros: 200000,
      });
      const effect = store
        .readEvents(startedRun.runId, 0)
        .find((event) => event.type === 'budget.reserved' && event.payload.amount.image);
      expect(effect?.type).toBe('budget.reserved');
      const archive = exportRunArchive(store, startedRun.runId, { privateTranscript: true });
      const opened = openRunArchive(archive);
      expect(opened.visibility).toBe('private');
      if (opened.visibility !== 'private') throw new Error('private archive missing');
      expect(opened.media?.[versionId]?.dataHex).toBe(bytes.toString('hex'));
      const corrupt = structuredClone(archive);
      if (corrupt.visibility === 'private' && corrupt.media?.[versionId])
        corrupt.media[versionId].dataHex = '00';
      expect(() => openRunArchive(corrupt)).toThrow('generated image');
      expect((await host.invokeTool({ name: 'generate_image', args })).ok).toBe(true);
      const overBudget = await host.invokeTool({ name: 'generate_image', args });
      expect(overBudget.ok).toBe(false);
      if (!overBudget.ok) expect(overBudget.error.message).toContain('call/cost limit');
      coordinator.submit({
        schemaVersion: '0.1',
        commandId: 'stop_image',
        runId: startedRun.runId,
        type: 'cancel',
        payload: { scope: { kind: 'run' }, reason: 'next request' },
      });
      const sourceRunId = startedRun.runId;
      await vi.waitFor(() =>
        expect(coordinator.getSnapshot(sourceRunId).projection.status).toBe('cancelled'),
      );
      const next = coordinator.startRun({
        schemaVersion: '0.1',
        commandId: 'reuse_image',
        definition,
        mode: 'mock',
        permissionMode: 'auto',
        startFrom: { runId: sourceRunId, artifactVersionId: versionId },
      });
      expect(next.runId).not.toBeNull();
      await vi.waitFor(() => expect(inputs.length).toBe(2));
      expect(inputs[1]?.images).toMatchObject([
        { imageId: versionId, data: bytes.toString('base64') },
      ]);
      done.open();
    } finally {
      await http.close();
      db.close();
    }
  });
  it('sends the configured public API operation and preserves original bytes across duplicate/readback', async () => {
    const db = database(),
      bytes = png();
    let calls = 0,
      received: unknown;
    const http = await endpoint(async (request, response) => {
      calls++;
      expect(request.url).toBe('/v1/images/generations');
      expect(request.headers.authorization).toBe('Bearer fixture-image-key');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      received = JSON.parse(Buffer.concat(chunks).toString());
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          data: [{ b64_json: bytes.toString('base64') }],
          usage: { input_tokens: 12, output_tokens: 34 },
        }),
      );
    });
    try {
      const attempts = new SqliteModelAttemptStore(db);
      const service = new ImageGenerationService(
        db,
        async () => ({ profile, baseUrl: http.baseUrl, apiKey: async () => 'fixture-image-key' }),
        now,
        fetch,
        attempts,
      );
      const generated = await service.generate(owner, args, idle, 0.2);
      expect(received).toEqual({
        model: profile.modelId,
        prompt: args.prompt,
        n: 1,
        output_format: 'png',
        size: '1024x1024',
      });
      expect(generated).toMatchObject({
        media: { bytes: bytes.length, width: 3, height: 2 },
        usage: { inputTokens: 12, outputTokens: 34 },
        costUsd: null,
      });
      expect(service.read(owner.runId, owner.artifactVersionId)?.bytes).toEqual(bytes);
      expect(await service.generate(owner, args, idle, 0.2)).toEqual(generated);
      expect(calls).toBe(1);
      expect(attempts.list()).toHaveLength(1);
      expect(attempts.list()[0]).toMatchObject({
        status: 'completed',
        usage: { inputTokens: 12, outputTokens: 34, source: 'reported', costUsd: null },
      });
      await expect(
        service.generate(owner, { ...args, prompt: 'changed' }, idle, 0.2),
      ).rejects.toThrow('identity changed');
      expect(service.read('other_run', owner.artifactVersionId)).toBeNull();
    } finally {
      await http.close();
      db.close();
    }
  });
  it('edits send only Coordinator-provided original references to the supported multipart API', async () => {
    const db = database(),
      bytes = png();
    let submitted = '';
    const http = await endpoint(async (request, response) => {
      expect(request.url).toBe('/v1/images/edits');
      expect(request.headers['content-type']).toContain('multipart/form-data; boundary=');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      submitted = body.toString('latin1');
      expect(body.includes(bytes)).toBe(true);
      response.end(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }));
    });
    try {
      const service = new ImageGenerationService(
        db,
        async () => ({ profile, baseUrl: http.baseUrl, apiKey: async () => 'fixture' }),
        now,
      );
      const reference = {
        kind: 'image_attachment' as const,
        imageId: 'image_ref',
        name: 'reference.png',
        mime: 'image/png' as const,
        bytes: bytes.length,
        width: 3,
        height: 2,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        data: bytes.toString('base64'),
      };
      await expect(
        service.generate(owner, { ...args, references: ['outside'] }, idle, 0.2, profile, [
          reference,
        ]),
      ).rejects.toMatchObject({ outcome: 'not_started' });
      const result = await service.generate(
        owner,
        { ...args, references: [reference.imageId] },
        idle,
        0.2,
        profile,
        [reference],
      );
      expect(result.media.bytes).toBe(bytes.length);
      expect(submitted).toContain('name="image[]"');
      expect(submitted).toContain('filename="reference.png"');
    } finally {
      await http.close();
      db.close();
    }
  });
  it('missing explicit profile and insufficient reservation never call the provider', async () => {
    const db = database();
    try {
      const service = new ImageGenerationService(db, async () => null, now);
      await expect(service.generate(owner, args, idle, 0.2)).rejects.toThrow('configure');
      const configured = new ImageGenerationService(
        db,
        async () => ({
          profile,
          baseUrl: 'https://example.invalid/v1',
          apiKey: async () => 'fixture',
        }),
        now,
      );
      await expect(configured.generate(owner, args, idle, 0.1)).rejects.toThrow(
        'reservation changed',
      );
      expect(db.prepare('SELECT count(*) AS count FROM image_generation_operations').get()).toEqual(
        { count: 0 },
      );
    } finally {
      db.close();
    }
  });
  it('unsupported output is not published and never silently retried after restart', async () => {
    const db = database();
    let calls = 0;
    const http = await endpoint((_request, response) => {
      calls++;
      response.end(JSON.stringify({ data: [{ url: 'https://example.invalid/picture.png' }] }));
    });
    try {
      const resolve = async () => ({
        profile,
        baseUrl: http.baseUrl,
        apiKey: async () => 'fixture',
      });
      const service = new ImageGenerationService(db, resolve, now);
      await expect(service.generate(owner, args, idle, 0.2)).rejects.toMatchObject({
        outcome: 'unknown',
      });
      expect(service.read(owner.runId, owner.artifactVersionId)).toBeNull();
      const restarted = new ImageGenerationService(db, resolve, now);
      await expect(restarted.generate(owner, args, idle, 0.2)).rejects.toThrow('reconciliation');
      expect(calls).toBe(1);
    } finally {
      await http.close();
      db.close();
    }
  });
  it('cancellation after dispatch keeps an unknown billed outcome without publishing or retrying', async () => {
    const db = database(),
      dispatched = new Gate();
    let calls = 0,
      aborted = false,
      cancel: (() => void) | undefined;
    const http = await endpoint(() => {
      calls++;
      dispatched.open();
    });
    try {
      const service = new ImageGenerationService(
        db,
        async () => ({ profile, baseUrl: http.baseUrl, apiKey: async () => 'fixture' }),
        now,
      );
      const pending = service.generate(
        owner,
        args,
        {
          get aborted() {
            return aborted;
          },
          onCancel(fn) {
            cancel = fn;
            return () => {
              cancel = undefined;
            };
          },
        },
        0.2,
      );
      await dispatched.wait();
      aborted = true;
      cancel?.();
      await expect(pending).rejects.toMatchObject({ outcome: 'unknown' });
      expect(service.read(owner.runId, owner.artifactVersionId)).toBeNull();
      await expect(service.generate(owner, args, idle, 0.2)).rejects.toMatchObject({
        outcome: 'unknown',
      });
      expect(calls).toBe(1);
    } finally {
      await http.close();
      db.close();
    }
  });
  it('only original valid immutable PNG bytes can be stored', () => {
    const db = database();
    try {
      const store = new GeneratedMediaStore(db, now),
        bytes = png();
      const metadata = store.put(owner, bytes);
      expect(store.put(owner, bytes)).toEqual(metadata);
      expect(() => store.put(owner, Buffer.from('not an image'))).toThrow();
      const changed = PNG.sync.write(new PNG({ width: 4, height: 2 }));
      expect(() => store.put(owner, changed)).toThrow('immutable');
      expect(store.discardUnpublished(owner.runId, new Set([owner.artifactVersionId]))).toBe(0);
      expect(store.discardUnpublished(owner.runId, new Set())).toBe(1);
    } finally {
      db.close();
    }
  });
});
