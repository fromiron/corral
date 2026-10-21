import {
  IMAGE_MAX_COUNT,
  ImageInput,
  type ModelProfileSnapshot,
  type ResolvedInput,
} from '@corral/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ArtifactVersionView } from './projection.ts';

export type ReadGeneratedImage = (runId: string, artifactVersionId: string) => ImageInput | null;

function decodeBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw new Error('generated image pixels are invalid');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((value.length * 3) / 4 - padding);
  let accumulator = 0;
  let bits = 0;
  let index = 0;
  for (const char of value) {
    if (char === '=') break;
    accumulator = (accumulator << 6) | alphabet.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (accumulator >> bits) & 255;
    }
  }
  return bytes;
}

/** Original pixels only. Oversized or unavailable images cannot silently become prose. */
export function generatedImageInputs(
  runId: string,
  inputs: readonly Pick<ResolvedInput, 'artifactVersionId'>[],
  artifacts: Record<string, ArtifactVersionView>,
  model: Pick<ModelProfileSnapshot, 'imageInput'>,
  read: ReadGeneratedImage | undefined,
  existing: readonly ImageInput[] = [],
): ImageInput[] {
  const images = new Map(existing.map((image) => [image.imageId, image]));
  if (images.size > IMAGE_MAX_COUNT)
    throw new Error('generated image inputs exceed the vision image count limit');
  const checked = new Set<string>();
  for (const input of inputs) {
    const id = input.artifactVersionId;
    const media = id ? artifacts[id]?.media : null;
    if (!id || !media || checked.has(id)) continue;
    if (model.imageInput !== true)
      throw new Error('generated image input requires a model with confirmed image support');
    if (!read && !images.has(id)) throw new Error('generated image pixels are unavailable');
    const parsed = ImageInput.safeParse(images.get(id) ?? read?.(runId, id));
    if (!parsed.success)
      throw new Error('original generated image is unavailable or exceeds the vision input limits');
    const image = parsed.data;
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(image.data);
    } catch {
      throw new Error('generated image pixels are invalid');
    }
    if (
      image.imageId !== id ||
      image.bytes !== media.bytes ||
      bytes.length !== media.bytes ||
      image.width !== media.width ||
      image.height !== media.height ||
      image.sha256 !== media.sha256 ||
      bytesToHex(sha256(bytes)) !== media.sha256
    )
      throw new Error('generated image identity changed');
    images.set(id, image);
    checked.add(id);
    if (images.size > IMAGE_MAX_COUNT)
      throw new Error('generated image inputs exceed the vision image count limit');
  }
  return [...images.values()];
}
