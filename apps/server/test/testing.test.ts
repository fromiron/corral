import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context, ToolResultMessage } from '@earendil-works/pi-ai';
import { afterEach, expect, it } from 'vitest';
import { fakeOpenAI } from '../src/testing.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function scriptedAnswer() {
  const configDir = mkdtempSync(join(tmpdir(), 'corral-fake-answer-'));
  directories.push(configDir);
  const fake = fakeOpenAI({ configDir, env: { OPENAI_API_KEY: 'local-fake-key' } });
  fake.answerWith('The confirmed result.');
  const model = fake.live.models.getModel('openai', 'gpt-test-b');
  if (!model) throw new Error('Missing fake model');
  const tools: Context['tools'] = [
    { name: 'write_artifact', description: 'Write an artifact', parameters: { type: 'object' } },
  ];
  const write = await fake.live.models.streamSimple(model, { tools, messages: [] }).result();
  expect(write.content).toContainEqual(expect.objectContaining({ name: 'write_artifact' }));
  return (messages: Context['messages']) =>
    fake.live.models.streamSimple(model, { tools, messages: [write, ...messages] }).result();
}

function result(artifactVersionId: string, isError = false): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: 'write-result',
    toolName: 'write_artifact',
    content: [{ type: 'text', text: JSON.stringify({ artifactVersionId }) }],
    isError,
    timestamp: 1,
  };
}

it('submits the written artifact instead of later artifact IDs in notifications and other tools', async () => {
  const respond = await scriptedAnswer();
  const written = `artv_${'1'.repeat(32)}`;
  const other = `artv_${'2'.repeat(32)}`;
  const response = await respond([
    result(written),
    { ...result(other), toolName: 'read_artifact' },
    { role: 'system', content: `Extension notification: ${other}`, timestamp: 2 },
  ]);
  expect(response.content).toContainEqual(
    expect.objectContaining({
      name: 'submit_result',
      arguments: { artifactVersionIds: [written] },
    }),
  );
});

it('does not manufacture a successful submission from a failed write result', async () => {
  const respond = await scriptedAnswer();
  const response = await respond([result(`artv_${'3'.repeat(32)}`, true)]);
  expect(response.stopReason).toBe('error');
  expect(response.content.some((part) => part.type === 'toolCall')).toBe(false);
});
