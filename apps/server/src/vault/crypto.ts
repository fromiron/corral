import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { z } from 'zod';
import { VAULT_DOMAINS, type VaultDocument } from './types.ts';

export const MAX_VAULT_BYTES = 8 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const domainSchema = z.partialRecord(
  z.enum(VAULT_DOMAINS),
  z.strictObject({
    revision: z.string().min(1).max(256),
    value: z.unknown(),
  }),
);
const documentSchema = z.strictObject({
  version: z.literal(1),
  createdAt: z.iso.datetime(),
  domains: domainSchema,
});
const envelopeSchema = z.strictObject({
  version: z.literal(1),
  algorithm: z.literal('aes-256-gcm'),
  kdf: z.strictObject({
    name: z.literal('scrypt'),
    N: z.literal(32768),
    r: z.literal(8),
    p: z.literal(1),
  }),
  salt: z.string().regex(BASE64).length(44),
  nonce: z.string().regex(BASE64).length(16),
  tag: z.string().regex(BASE64).length(24),
  ciphertext: z
    .string()
    .regex(BASE64)
    .max(Math.ceil(MAX_VAULT_BYTES / 3) * 4),
});
export type VaultEnvelope = z.infer<typeof envelopeSchema>;
const PARAMETERS = {
  version: 1,
  algorithm: 'aes-256-gcm',
  kdf: { name: 'scrypt', N: 32768, r: 8, p: 1 },
} as const;
const AAD = Buffer.from(`Corral settings vault\n${JSON.stringify(PARAMETERS)}`);
function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024)
    throw new Error('Use a vault password between 12 and 1024 characters.');
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}
export async function encryptVault(
  document: VaultDocument,
  password: string,
): Promise<VaultEnvelope> {
  const content = Buffer.from(JSON.stringify(documentSchema.parse(document)));
  if (content.byteLength > MAX_VAULT_BYTES) throw new Error('Vault exceeds 8 MiB.');
  const salt = randomBytes(32);
  const nonce = randomBytes(12);
  const key = await derive(password, salt);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(content), cipher.final()]);
    return {
      ...PARAMETERS,
      salt: salt.toString('base64'),
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  } finally {
    key.fill(0);
    content.fill(0);
  }
}
export async function decryptVault(raw: unknown, password: string): Promise<VaultDocument> {
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Unsupported or invalid vault envelope.');
  const envelope = parsed.data;
  const salt = Buffer.from(envelope.salt, 'base64');
  const nonce = Buffer.from(envelope.nonce, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  if (
    salt.byteLength !== 32 ||
    nonce.byteLength !== 12 ||
    tag.byteLength !== 16 ||
    ciphertext.byteLength > MAX_VAULT_BYTES
  )
    throw new Error('Invalid vault envelope.');
  const key = await derive(password, salt);
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return documentSchema.parse(JSON.parse(plaintext.toString('utf8'))) as VaultDocument;
  } catch {
    throw new Error('Vault authentication failed or content is invalid.');
  } finally {
    key.fill(0);
    plaintext?.fill(0);
  }
}
