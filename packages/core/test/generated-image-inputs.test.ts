import type { ImageInput } from '@corral/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { expect, it, vi } from 'vitest';
import { generatedImageInputs } from '../src/generated-image-inputs.ts';
import type { ArtifactVersionView } from '../src/projection.ts';

const data =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZxkAAAAASUVORK5CYII=';
const bytes = hexToBytes(
  '89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c020000000b4944415478da63fcff1f0003030200efa367190000000049454e44ae426082',
);
const hash = bytesToHex(sha256(bytes));
const image: ImageInput = {
  kind: 'image_attachment',
  imageId: 'artv_image',
  name: 'image.png',
  mime: 'image/png',
  bytes: bytes.length,
  sha256: hash,
  width: 1,
  height: 1,
  data,
};
const artifact: ArtifactVersionView = {
  artifactVersionId: image.imageId,
  artifactId: 'generated',
  version: 1,
  parentVersionId: null,
  name: 'image',
  contract: 'draft',
  contentHash: hash,
  byteLength: bytes.length,
  authorExecutionId: 'exec_1',
  modelCallId: null,
  contextSnapshotId: null,
  submitted: true,
  configRevision: 0,
  criteriaVersionId: null,
  inputArtifactVersionIds: [],
  media: {
    version: 1,
    kind: 'image',
    mime: 'image/png',
    bytes: bytes.length,
    width: 1,
    height: 1,
    sha256: hash,
    blobRef: 'image_blob',
  },
};
const artifacts = { [image.imageId]: artifact };
const refs = [{ artifactVersionId: image.imageId }];

it('[TC-ABS-010-H] delivers original generated pixels to a downstream vision model with identity intact', () => {
  const read = vi.fn(() => image);
  expect(
    generatedImageInputs('run_1', [...refs, ...refs], artifacts, { imageInput: true }, read),
  ).toEqual([image]);
  expect(read).toHaveBeenCalledExactlyOnceWith('run_1', image.imageId);
  expect(
    generatedImageInputs('run_1', refs, artifacts, { imageInput: true }, read, [image]),
  ).toEqual([image]);
});

it('[TC-ABS-010-N] rejects unsupported, resized, replaced and oversized image inputs rather than prose fallback', () => {
  expect(() => generatedImageInputs('run_1', refs, artifacts, {}, () => image)).toThrow(
    /confirmed image support/,
  );
  expect(() =>
    generatedImageInputs('run_1', refs, artifacts, { imageInput: true }, undefined),
  ).toThrow(/unavailable/);
  for (const changed of [
    { ...image, width: 2 },
    { ...image, data: 'Y2hhbmdlZA==' },
    { ...image, imageId: 'another_image' },
    { ...image, bytes: 1024 * 1024 + 1 },
  ])
    expect(() =>
      generatedImageInputs('run_1', refs, artifacts, { imageInput: true }, () => changed),
    ).toThrow();
});

it('[TC-ABS-010-N] bounds all images supplied to one execution and leaves ordinary text references alone', () => {
  const existing = Array.from({ length: 3 }, (_, index) => ({
    ...image,
    imageId: `attached_${index}`,
  }));
  expect(() =>
    generatedImageInputs('run_1', refs, artifacts, { imageInput: true }, () => image, existing),
  ).toThrow(/count limit/);
  const read = vi.fn(() => image);
  expect(
    generatedImageInputs('run_1', [{ artifactVersionId: 'text_version' }], artifacts, {}, read),
  ).toEqual([]);
  expect(read).not.toHaveBeenCalled();
});
