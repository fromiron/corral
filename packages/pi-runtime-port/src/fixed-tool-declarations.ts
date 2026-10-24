// Adapted from PI-Desktop 1a812ed, fixed-tool-declarations.ts (LGPL-3.0-only).
import { createHash } from 'node:crypto';
import {
  type Api,
  type Context,
  getCurrentSystemMessage,
  type Message,
  type Model,
  normalizeContext,
  type Tool,
  type TranscriptContext,
  toToolDeclaration,
} from '@earendil-works/pi-ai';
import { automaticCompactionThresholdFor, contextBudgetLimitsFor } from './context-budget.ts';

export function supportsFixedToolDeclarations(model: Model<Api>) {
  return (
    model.id === 'deepseek-flash' &&
    model.api === 'openai-completions' &&
    model.baseUrl.replace(/\/+$/, '') === 'https://api.deepseek.com' &&
    model.compat &&
    'supportsMidConvoSystemMessages' in model.compat &&
    model.compat.supportsMidConvoSystemMessages === true
  );
}

export function toolDeclarationPolicy(
  model: Model<Api>,
  tools: readonly Tool[],
  deferred: readonly string[],
  promptTokens: number,
  accountId: string,
) {
  if (!supportsFixedToolDeclarations(model)) return { key: '', tools: undefined };
  const ordered = [...tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(toToolDeclaration);
  const key = createHash('sha256')
    .update(
      JSON.stringify({
        account: accountId,
        model: model.id,
        api: model.api,
        endpoint: model.baseUrl.replace(/\/+$/, ''),
        tools: ordered,
        deferred: [...deferred].sort(),
      }),
    )
    .digest('hex');
  // This capability and 128-function limit belong to the upstream-verified native route only.
  const budget = contextBudgetLimitsFor(model);
  if (
    ordered.length > 128 ||
    promptTokens + Math.ceil(JSON.stringify(ordered).length / 4) >=
      automaticCompactionThresholdFor(budget) - budget.keepRecentTokens
  )
    return { key, tools: undefined };
  return { key, tools: ordered };
}

/** Change model declarations only; Pi's active/callable sets and host authorization still execute tools. */
export function withFixedToolDeclarations(
  context: Context,
  policy: ReturnType<typeof toolDeclarationPolicy>,
  active: readonly string[],
): TranscriptContext {
  if (!policy.tools) return normalizeContext(context);
  const section = JSON.stringify({ version: 1, snapshot: policy.key, active: [...active].sort() });
  const messages: Message[] = context.messages.map((message) => {
    if (message.role !== 'system') return message;
    const { toolsAdded: _added, toolsRemoved: _removed, ...system } = message;
    return system;
  });
  const first = messages[0];
  if (!first || first.role !== 'system') return normalizeContext(context);
  messages[0] = { ...first, toolsAdded: policy.tools };
  if (getCurrentSystemMessage(messages)?.sections?.tool_activation !== section)
    messages.push({
      role: 'system',
      content: '',
      sections: { tool_activation: section },
      timestamp: 0,
    });
  return normalizeContext({ messages });
}
