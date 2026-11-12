import { createHash } from 'node:crypto';
import { Identifier } from '@corral/contracts';
import { expect, it } from 'vitest';
import { imageProfileIdFor } from './modelConnections.ts';

// The image profile id (models-and-resources.md, 이미지 프로필): the model-reference rule on
// `<model profile>:<image model>`, then `-2`, `-3`… when a saved profile already has that id.

const MAX = 120;

function referenceId(modelProfileId: string, modelId: string): string {
  const plain = `${modelProfileId}:${modelId}`;
  if (Identifier.safeParse(plain).success) return plain;
  const hash = createHash('sha256').update(plain).digest('hex').slice(0, 8);
  let base = plain.replace(/[^A-Za-z0-9_.:-]/g, '_');
  if (!/^[A-Za-z]/.test(base)) base = `m${base}`;
  return `${base.slice(0, MAX - 8 - 1)}.${hash}`;
}

function expectId(modelProfileId: string, modelId: string, taken: readonly string[] = []): string {
  const used = new Set(taken);
  const base = referenceId(modelProfileId, modelId);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const name = `${base.slice(0, MAX - suffix.length)}${suffix}`;
    if (!used.has(name)) return name;
  }
}

it('uses connection:model when that is an Identifier', () => {
  expect(imageProfileIdFor('keyed', 'gpt-image-1', [])).toBe('keyed:gpt-image-1');
  expect(imageProfileIdFor('local', 'llama3.2:latest', [])).toBe('local:llama3.2:latest');
});

it('numbers the id when a saved profile already has it', () => {
  expect(imageProfileIdFor('keyed', 'gpt-image-1', ['keyed:gpt-image-1'])).toBe(
    'keyed:gpt-image-1-2',
  );
  expect(
    imageProfileIdFor('keyed', 'gpt-image-1', ['keyed:gpt-image-1', 'keyed:gpt-image-1-2']),
  ).toBe('keyed:gpt-image-1-3');
});

it('keeps two image model ids apart when sanitizing would collapse them', () => {
  const slashed = imageProfileIdFor('router', 'vendor/name', []);
  const underscored = imageProfileIdFor('router', 'vendor_name', []);
  expect(slashed).toBe(expectId('router', 'vendor/name'));
  expect(underscored).toBe('router:vendor_name');
  expect(slashed).not.toBe(underscored);
  expect(imageProfileIdFor('router', 'vendor/name', [])).toBe(slashed);
});

it('stays an Identifier for a long model id, including the numbered form', () => {
  const modelId = `org/${'m'.repeat(300)}`;
  const id = imageProfileIdFor('router', modelId, []);
  const numbered = imageProfileIdFor('router', modelId, [id]);
  expect(id).toBe(expectId('router', modelId));
  expect(numbered).toBe(expectId('router', modelId, [id]));
  for (const value of [id, numbered]) {
    expect(value.length).toBeLessThanOrEqual(MAX);
    expect(Identifier.safeParse(value).success, value).toBe(true);
  }
  expect(numbered.endsWith('-2')).toBe(true);
});

it('hashes the original characters, so a non-latin model id is stable', () => {
  expect(imageProfileIdFor('keyed', '이미지', [])).toBe(expectId('keyed', '이미지'));
  expect(imageProfileIdFor('keyed', '이미지', [])).not.toBe(
    imageProfileIdFor('keyed', 'image', []),
  );
});
