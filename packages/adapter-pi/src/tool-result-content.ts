import { IMAGE_MAX_COUNT, ImageInput } from '@corral/contracts';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';

/** Authorized artifact reads carry pixels as image blocks, never base64 in prose. */
export function corralToolResultContent(name: string, result: Record<string, unknown>) {
  const content: (TextContent | ImageContent)[] = [];
  if ((name === 'read_artifact' || name === 'generate_image') && result.images !== undefined) {
    const images = ImageInput.array().max(IMAGE_MAX_COUNT).parse(result.images);
    const details = {
      ...result,
      images: images.map(({ data: _data, ...metadata }) => metadata),
    };
    content.push({ type: 'text', text: JSON.stringify(details) });
    content.push(
      ...images.map((image) => ({
        type: 'image' as const,
        data: image.data,
        mimeType: image.mime,
      })),
    );
    return { content, details };
  }
  content.push({ type: 'text', text: JSON.stringify(result) });
  return { content, details: result };
}
