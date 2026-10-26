import { TEXT_ATTACHMENT_MAX_BYTES } from '@corral/contracts';
import { type ArtifactVersionView, createTextAttachment } from '@corral/core';
import { expect, it, vi } from 'vitest';
import { captureMeetingResult } from './meetingEvidence.ts';

const body = '<script>not executable</script>\nA result.';
const digest = createTextAttachment('source.txt', 'text/plain', body);
const artifact = {
  artifactVersionId: 'artifact_1',
  name: 'Answer',
  byteLength: digest.bytes,
  contentHash: digest.sha256,
} as ArtifactVersionView;

it('explicitly captures one result version with its immutable source and plain text', async () => {
  const transport = { getArtifactText: vi.fn(async () => body) };
  const captured = await captureMeetingResult(transport, 'run_1', artifact);
  expect(transport.getArtifactText).toHaveBeenCalledExactlyOnceWith('run_1', 'artifact_1');
  expect(captured.mime).toBe('text/plain');
  expect(captured.text).toContain('run_1');
  expect(captured.text).toContain('artifact_1');
  expect(captured.text).toContain(body);
});

it('refuses oversized or binary results before reading their bodies', async () => {
  const transport = { getArtifactText: vi.fn(async () => body) };
  await expect(
    captureMeetingResult(transport, 'run_1', {
      ...artifact,
      byteLength: TEXT_ATTACHMENT_MAX_BYTES + 1,
    }),
  ).rejects.toThrow();
  await expect(
    captureMeetingResult(transport, 'run_1', {
      ...artifact,
      media: { mime: 'image/png' },
    } as ArtifactVersionView),
  ).rejects.toThrow();
  expect(transport.getArtifactText).not.toHaveBeenCalled();
});

it('refuses missing and changed result bodies instead of silently capturing them', async () => {
  const getArtifactText = vi.fn(async (): Promise<string | null> => null);
  await expect(captureMeetingResult({ getArtifactText }, 'run_1', artifact)).rejects.toThrow();
  getArtifactText.mockResolvedValue('replacement');
  await expect(captureMeetingResult({ getArtifactText }, 'run_1', artifact)).rejects.toThrow();
});
