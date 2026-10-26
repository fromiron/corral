import type { ImageInput } from '@corral/contracts';
import { expect, it } from 'vitest';
import { corralToolResultContent } from '../src/tool-result-content.ts';

const image: ImageInput = {
  kind: 'image_attachment',
  imageId: 'artv_image',
  name: 'image.png',
  mime: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
  sha256: 'a'.repeat(64),
  data: 'AQID',
};
it('renders authorized image reads as actual Pi image parts without base64 prose or details', () => {
  const result = corralToolResultContent('read_artifact', {
    artifactVersionId: 'artv_image',
    images: [image],
  });
  expect(result.content).toContainEqual({ type: 'image', data: image.data, mimeType: 'image/png' });
  expect(JSON.stringify(result.content.filter((part) => part.type === 'text'))).not.toContain(
    'AQID',
  );
  expect(JSON.stringify(result.details)).not.toContain('AQID');
});
it('malformed image input is a failure rather than a text-only successful read', () => {
  expect(() =>
    corralToolResultContent('read_artifact', { images: [{ ...image, bytes: 1024 * 1024 + 1 }] }),
  ).toThrow();
});
