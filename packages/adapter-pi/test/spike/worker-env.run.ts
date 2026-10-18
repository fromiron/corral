// S8 helper: runs in a child process with the worker's environment (NODE_ENV and PATH only,
// as channel.ts spawns workers). Prints one JSON line with what happened.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { spikeSession } from './sdk-session.ts';

const dir = mkdtempSync(join(tmpdir(), 'corral-har-s8-'));
const extension = join(dir, 'extension.ts');
writeFileSync(
  extension,
  `import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
export default function (pi: ExtensionAPI): void {
  pi.on('before_agent_start', async (event) => {
    const sections = event.systemPromptOptions?.sections as Record<string, string> | undefined;
    if (sections) sections.loaded = 'TS extension loaded.';
  });
}\n`,
);
const run = await spikeSession({
  responses: [fauxAssistantMessage('Hello.')],
  extensionPaths: [extension],
});
await run.session.prompt('Say hello.');
console.log(
  JSON.stringify({
    home: process.env.HOME ?? null,
    node: process.version,
    errors: run.resourceLoader.getExtensions().errors.map((e) => e.error),
    permits: run.log.permits.length,
    loaded: run.log.requests[0]?.systemPrompt.includes('TS extension loaded.') ?? false,
    answer: run.session.getLastAssistantText(),
  }),
);
run.dispose();
