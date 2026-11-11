import { createHash } from 'node:crypto';
import { Identifier } from '@corral/contracts';

// The profile id of a model that comes from a connection rather than a named profile
// (features/model-connections.md, 모델 참조). It depends only on the provider and model, so a
// stored choice means the same model after a restart and while the provider is signed out.

const IDENTIFIER_LENGTH = 120;
const HASH_LENGTH = 8;

export function connectionProfileId(provider: string, model: string): string {
  const plain = `${provider}:${model}`;
  if (Identifier.safeParse(plain).success) return plain;
  const hash = createHash('sha256').update(plain).digest('hex').slice(0, HASH_LENGTH);
  let base = plain.replace(/[^A-Za-z0-9_.:-]/g, '_');
  // Provider ids start with a letter; this only guards the Identifier's first character.
  if (!/^[A-Za-z]/.test(base)) base = `m${base}`;
  return `${base.slice(0, IDENTIFIER_LENGTH - HASH_LENGTH - 1)}.${hash}`;
}
