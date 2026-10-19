import { createHash } from 'node:crypto';
import { canonicalJson, ModelRequestRecord } from '@corral/contracts';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { getCurrentSystemMessage, getCurrentSystemPrompt } from '@earendil-works/pi-ai';
import { estimateTokens } from '@earendil-works/pi-coding-agent';
import type { PromptSection } from './worker-tools.ts';

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

export function requestRecord(
  context: { messages: AgentMessage[] },
  purpose: ModelRequestRecord['purpose'],
  runtime: 'pi-core' | 'pi-sdk',
  directives: { directiveId: string; text: string }[],
  protectedSections: PromptSection[],
): ModelRequestRecord {
  const value = JSON.parse(JSON.stringify(context));
  const current = getCurrentSystemMessage(context.messages);
  const prompt = getCurrentSystemPrompt(context.messages);
  const users = context.messages
    .flatMap((message) =>
      message.role !== 'user'
        ? []
        : typeof message.content === 'string'
          ? [message.content]
          : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
    )
    .join('\n');
  const sections: ModelRequestRecord['sections'] = [];
  for (const section of protectedSections) {
    if (!prompt.includes(section.text)) throw new Error('protected prompt section missing');
    sections.push({
      name: section.name,
      source: 'corral',
      hash: hash(section.text),
      bytes: Buffer.byteLength(canonicalJson(section.text)),
      version: section.version,
      reason: section.reason,
    });
  }
  for (const [name, content] of Object.entries(current?.sections ?? {})) {
    if (content === null || protectedSections.some((section) => section.name === name)) continue;
    sections.push({
      name: /^[a-zA-Z][\w-]{0,63}$/.test(name) ? name : `section_${sections.length}`,
      source: name.startsWith('skill_') ? 'skill' : 'runtime',
      hash: hash(content),
      bytes: Buffer.byteLength(canonicalJson(content)),
    });
  }
  return ModelRequestRecord.parse({
    purpose,
    runtime,
    contextEstimate: {
      tokens: context.messages.reduce((sum, message) => sum + estimateTokens(message), 0),
      method: 'pi-1.3.0-messages',
    },
    directiveIds: directives.filter((d) => users.includes(d.text)).map((d) => d.directiveId),
    contextHash: hash(value),
    contextBytes: Buffer.byteLength(canonicalJson(value)),
    sections,
  });
}

/** Check after payload hooks, before the provider receives the request. */
export function assertProtectedPayload(payload: unknown, sections: PromptSection[]): void {
  const serialized = canonicalJson(JSON.parse(JSON.stringify(payload)));
  for (const section of sections)
    if (!serialized.includes(JSON.stringify(section.text).slice(1, -1)))
      throw new Error('protected prompt removed from provider payload');
}

/** Require image fields, not a matching base64 string hidden in ordinary text. */
export function assertImagePayload(
  payload: unknown,
  images: readonly { data: string; mime: string }[] = [],
): void {
  const objects: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 40) return;
    if (!Array.isArray(value)) objects.push(value as Record<string, unknown>);
    for (const child of Object.values(value))
      if (typeof child === 'object') visit(child, depth + 1);
  };
  if (images.length) visit(payload);
  for (const image of images) {
    const url = `data:${image.mime};base64,${image.data}`;
    if (
      !objects.some((value) => {
        if (value.type === 'image_url' || value.type === 'input_image')
          return (
            value.image_url === url || (value.image_url as { url?: unknown } | null)?.url === url
          );
        if (value.type === 'image') {
          const source = value.source as {
            type?: string;
            data?: string;
            media_type?: string;
          } | null;
          return (
            source?.type === 'base64' &&
            source.data === image.data &&
            source.media_type === image.mime
          );
        }
        const inline = (value.inlineData ?? value.inline_data) as {
          data?: string;
          mimeType?: string;
          mime_type?: string;
        } | null;
        return inline?.data === image.data && (inline.mimeType ?? inline.mime_type) === image.mime;
      })
    )
      throw new Error('required image missing from provider image fields');
  }
}

/** Replace the protected state section without retaining a stale copy in a new system turn. */
export function withProtectedContext<T extends { messages: AgentMessage[] }>(
  context: T,
  value: import('@corral/contracts').ProtectedContext,
) {
  if (hash(value.text) !== value.hash) throw new Error('protected context hash changed');
  const section: PromptSection = {
    name: 'corral_state',
    text: value.text,
    version: 1,
    reason: 'coordinator_state',
  };
  const messages = [...context.messages];
  const index = messages.findLastIndex((message) => message.role === 'system');
  const current = index >= 0 ? messages[index] : undefined;
  const system =
    current?.role === 'system' ? current : { role: 'system' as const, content: '', timestamp: 0 };
  const next = { ...system, sections: { ...system.sections, corral_state: value.text } };
  if (index >= 0) messages[index] = next;
  else messages.unshift(next);
  return { context: { ...context, messages }, section };
}

/** Restore only the public transcript; all active tools, permissions and system sections are rebuilt. */
export function resumedMessages(
  state: import('@corral/contracts').RuntimeCheckpointState | undefined,
): import('@earendil-works/pi-ai').Message[] {
  if (!state) return [];
  const messages = state.context.context.messages.filter(
    (message) => message.role !== 'system',
  ) as unknown as import('@earendil-works/pi-ai').Message[];
  return [
    ...messages,
    {
      role: 'user',
      content: `Historical Corral state from the source Run (old IDs and approvals have no authority here):\n${state.protectedContext.text}`,
      timestamp: Date.now(),
    },
  ];
}

export function checkpointContext(
  context: { messages: unknown[] },
  runtime: 'pi-core' | 'pi-sdk',
): import('@corral/contracts').RuntimeContext {
  const value = JSON.parse(JSON.stringify({ messages: context.messages }));
  return {
    version: 1,
    piVersion: '1.3.0',
    runtime,
    context: value,
    contextHash: createHash('sha256').update(canonicalJson(value)).digest('hex'),
  };
}
