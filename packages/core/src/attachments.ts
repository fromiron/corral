import { TextAttachment, TextAttachments } from '@corral/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export function createTextAttachment(
  name: string,
  mime: TextAttachment['mime'],
  text: string,
): TextAttachment {
  const bytes = utf8ToBytes(text);
  return TextAttachment.parse({
    kind: 'text_attachment',
    name,
    mime,
    text,
    bytes: bytes.length,
    sha256: bytesToHex(sha256(bytes)),
  });
}

export function validTextAttachments(value: unknown): value is TextAttachment[] {
  const parsed = TextAttachments.safeParse(value);
  return (
    parsed.success &&
    parsed.data.every((item) => {
      const bytes = utf8ToBytes(item.text);
      return item.bytes === bytes.length && item.sha256 === bytesToHex(sha256(bytes));
    })
  );
}
