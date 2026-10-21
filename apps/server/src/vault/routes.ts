import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { decryptVault, encryptVault, MAX_VAULT_BYTES } from './crypto.ts';
import { VaultConflict, VaultS3Transport } from './s3.ts';
import { PortableApplication, type VaultBindings, type VaultService } from './service.ts';
import { VAULT_DOMAINS } from './types.ts';

const password = z.string().min(12).max(1024);
const domains = z.array(z.enum(VAULT_DOMAINS)).min(1).max(9);
const bindings = z
  .partialRecord(z.enum(VAULT_DOMAINS), z.record(z.string().max(200), z.string().max(20000)))
  .default({});
const captureBody = z.strictObject({
  password,
  domains,
  application: PortableApplication,
  bindings,
  includeSecrets: z.array(z.string().min(1).max(120)).max(20).default([]),
});
const s3Config = z.strictObject({
  endpoint: z.string().url().max(1000),
  region: z.string().min(1).max(64),
  bucket: z.string().min(3).max(63),
  key: z.string().min(1).max(1024),
});
const credentials = z.strictObject({
  accessKeyId: z.string().min(1).max(256),
  secretAccessKey: z.string().min(1).max(8192),
  sessionToken: z.string().min(1).max(16384).optional(),
});
const connection = z.strictObject({ config: s3Config, credentials });
export function registerVaultRoutes(
  app: FastifyInstance,
  options: { vault: VaultService; directory: string },
) {
  const { vault, directory } = options;
  const connectionFile = join(directory, 's3-connection.json');
  async function remote(password: string) {
    if (!existsSync(connectionFile)) throw new Error('Configure an S3 connection first.');
    const document = await decryptVault(JSON.parse(readFileSync(connectionFile, 'utf8')), password);
    const entry = document.domains.application;
    if (entry?.revision !== 's3-connection-v1') throw new Error('Invalid S3 connection.');
    const data = connection.parse(entry.value);
    return new VaultS3Transport(data.config, data.credentials);
  }
  const error = (reply: FastifyReply, reason: unknown) =>
    reply.code(reason instanceof VaultConflict ? 409 : 400).send({
      error: {
        code: reason instanceof VaultConflict ? 'REVISION_CONFLICT' : 'SCHEMA_INVALID',
        message:
          reason instanceof z.ZodError
            ? 'Invalid vault request.'
            : reason instanceof Error
              ? reason.message
              : 'Vault operation failed.',
      },
    });
  app.get('/api/v1/vault', async () => ({
    ...vault.state(),
    domains: vault.available(),
    s3Configured: existsSync(connectionFile),
  }));
  app.post('/api/v1/vault/options', async (request, reply) => {
    try {
      const data = z.strictObject({ bindings }).parse(request.body);
      return {
        ...vault.state(),
        domains: vault.available(data.bindings),
        s3Configured: existsSync(connectionFile),
      };
    } catch (reason) {
      return error(reply, reason);
    }
  });
  app.post('/api/v1/vault/export', { bodyLimit: MAX_VAULT_BYTES * 2 }, async (request, reply) => {
    try {
      const data = captureBody.parse(request.body);
      return {
        envelope: await vault.capture(
          data.domains,
          data.password,
          data.application,
          data.bindings,
          data.includeSecrets,
        ),
      };
    } catch (reason) {
      return error(reply, reason);
    }
  });
  app.post('/api/v1/vault/preview', { bodyLimit: MAX_VAULT_BYTES * 2 }, async (request, reply) => {
    try {
      const data = z
        .strictObject({
          envelope: z.unknown(),
          password,
          application: PortableApplication,
          bindings,
        })
        .parse(request.body);
      return await vault.preview(data.envelope, data.password, data.application, data.bindings);
    } catch (reason) {
      return error(reply, reason);
    }
  });
  app.post('/api/v1/vault/apply', async (request, reply) => {
    try {
      const data = z
        .strictObject({ previewId: z.string().min(1).max(200), password, domains })
        .parse(request.body);
      return await vault.apply(data.previewId, data.domains, data.password);
    } catch (reason) {
      return error(reply, reason);
    }
  });
  app.post('/api/v1/vault/pending', async (request, reply) => {
    try {
      return await vault.pending(z.strictObject({ password }).parse(request.body).password);
    } catch (reason) {
      return error(reply, reason);
    }
  });
  app.post('/api/v1/vault/acknowledge', async (request, reply) => {
    try {
      const data = z
        .strictObject({
          id: z.string().min(1).max(200),
          password,
          application: PortableApplication,
        })
        .parse(request.body);
      return await vault.acknowledge(data.id, data.password, data.application);
    } catch (reason) {
      return error(reply, reason);
    }
  });
  app.post('/api/v1/vault/rollback', async (request, reply) => {
    try {
      return await vault.rollback(z.strictObject({ password }).parse(request.body).password);
    } catch (reason) {
      return error(reply, reason);
    }
  });
  app.put('/api/v1/vault/s3', async (request, reply) => {
    try {
      const data = z.strictObject({ password, config: s3Config, credentials }).parse(request.body);
      // Constructor validates endpoints and identifiers without a network request.
      new VaultS3Transport(data.config, data.credentials);
      const encrypted = await encryptVault(
        {
          version: 1,
          createdAt: new Date().toISOString(),
          domains: {
            application: {
              revision: 's3-connection-v1',
              value: { config: data.config, credentials: data.credentials },
            },
          },
        },
        data.password,
      );
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(`${connectionFile}.tmp`, JSON.stringify(encrypted), { mode: 0o600 });
      renameSync(`${connectionFile}.tmp`, connectionFile);
      return { configured: true };
    } catch (reason) {
      return error(reply, reason);
    }
  });
  app.post('/api/v1/vault/s3/download', async (request, reply) => {
    try {
      const data = z.strictObject({ password }).parse(request.body);
      const found = await (await remote(data.password)).read();
      if (!found) return { etag: null, envelope: null };
      const envelope = JSON.parse(found.body);
      await decryptVault(envelope, data.password);
      return { etag: found.etag, envelope };
    } catch (reason) {
      return error(reply, reason);
    }
  });
  app.post('/api/v1/vault/s3/upload', async (request, reply) => {
    try {
      const data = captureBody
        .extend({ expectedEtag: z.string().max(514).nullable() })
        .parse(request.body);
      const transport = await remote(data.password);
      const envelope = await vault.capture(
        data.domains,
        data.password,
        data.application,
        data.bindings as VaultBindings,
        data.includeSecrets,
      );
      return await transport.write(JSON.stringify(envelope), data.expectedEtag);
    } catch (reason) {
      return error(reply, reason);
    }
  });
}
