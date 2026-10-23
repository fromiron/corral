import { TEXT_ATTACHMENT_MAX_BYTES, type TextAttachment } from '@corral/contracts';
import {
  type ArtifactVersionView,
  createTextAttachment,
  type RuntimeTransport,
} from '@corral/core';

/** Only an explicit result choice calls this; HTML and links remain inert captured text. */
export async function captureMeetingResult(
  transport: Pick<RuntimeTransport, 'getArtifactText'>,
  runId: string,
  artifact: ArtifactVersionView,
): Promise<TextAttachment> {
  if (artifact.media || artifact.byteLength > TEXT_ATTACHMENT_MAX_BYTES)
    throw new Error('This result cannot be attached as text.');
  const text = await transport.getArtifactText(runId, artifact.artifactVersionId);
  if (text === null) throw new Error('This result is no longer available.');
  const captured = createTextAttachment('result.txt', 'text/plain', text);
  if (captured.sha256 !== artifact.contentHash || captured.bytes !== artifact.byteLength)
    throw new Error('The result does not match the selected version.');
  return createTextAttachment(
    `${
      artifact.name
        .replace(/[/\\\p{Cc}]/gu, '_')
        .trim()
        .slice(0, 70) || 'result'
    }.txt`,
    'text/plain',
    `Run: ${runId}\nArtifact version: ${artifact.artifactVersionId}\n\n${text}`,
  );
}
