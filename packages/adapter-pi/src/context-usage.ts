import {
  ContextUsageSnapshot as ContextUsageSchema,
  type ContextUsageSnapshot,
} from '@corral/contracts';

/** Same chars/4 heuristic as Pi 1.3.0 `estimateTokens`. CJK is often under-counted. */
const tokensOf = (chars: number) => Math.ceil(chars / 4);

export interface ContextProbe {
  category: ContextUsageSnapshot['parts'][number]['category'];
  text: string;
  /** A structural tool identity, never inferred from prompt text. */
  toolName?: string;
}

export interface InspectOptions {
  /** Tool names whose schemas were actually included and are MCP definitions. */
  mcpToolNames?: readonly string[];
  otherToolNames?: readonly string[];
  /** Memory or instruction text the assembler inserted as its own part. */
  memoryTexts?: readonly string[];
  instructionTexts?: readonly string[];
  skillTexts?: readonly string[];
  /** MCP or extension tool schemas were included but not separated from builtin tools. */
  unmeasuredTools?: boolean;
  unsupportedPayload?: boolean;
  /** Skip the internal walk and store a snapshot already measured for this request. */
  usage?: ContextUsageSnapshot;
}

type Category = ContextProbe['category'];
type Omission = NonNullable<ContextUsageSnapshot['parts'][number]['omission']>;

const emptyUsage = (completeness: ContextUsageSnapshot['completeness']): ContextUsageSnapshot =>
  ContextUsageSchema.parse({
    version: 1,
    coverage: 'messages',
    completeness,
    method: 'pi-1.3.0-chars4',
    ...(completeness === 'error' ? {} : { usedTokens: 0 }),
    parts:
      completeness === 'error'
        ? [{ category: 'other', tokens: 0, omission: 'measurement_error' }]
        : [],
  });

/** Structural walk of the request the runtime assembled. Bodies are not copied into the snapshot. */
export function inspectContext(
  context: { messages: readonly unknown[]; tools?: readonly unknown[] },
  options: InspectOptions = {},
): { usage: ContextUsageSnapshot; probes: ContextProbe[] } {
  if (options.usage) return { usage: options.usage, probes: [] };
  try {
    const buckets = new Map<Category, number>();
    const omissions = new Map<Category, Omission>();
    const probes: ContextProbe[] = [];
    let sawRequest = false;
    let countedTools = false;

    const sources = [
      ...(options.memoryTexts ?? []).map((text) => ({ category: 'memory_files' as const, text })),
      ...(options.instructionTexts ?? []).map((text) => ({
        category: 'instructions' as const,
        text,
      })),
      ...(options.skillTexts ?? []).map((text) => ({ category: 'skills' as const, text })),
    ];
    const add = (category: Category, text: string) => {
      if (!text) return;
      buckets.set(category, (buckets.get(category) ?? 0) + tokensOf(text.length));
      probes.push({ category, text });
    };
    const addText = (category: Category, text: string) =>
      partitionText(text, category, sources, add);

    for (const message of context.messages) {
      if (!message || typeof message !== 'object') continue;
      const role = 'role' in message ? String(message.role) : '';
      if (role === 'system') {
        sawRequest = true;
        const sections =
          'sections' in message && message.sections && typeof message.sections === 'object'
            ? (message.sections as Record<string, unknown>)
            : {};
        for (const [name, content] of Object.entries(sections)) {
          if (typeof content !== 'string' || !content) continue;
          if (name.startsWith('skill_')) addText('skills', content);
          else if (name.startsWith('memory_')) addText('memory_files', content);
          else if (name.startsWith('instruction_') || name === 'mcp_servers')
            addText('instructions', content);
          else addText('system_prompt', content);
        }
        const content =
          'content' in message && typeof message.content === 'string' ? message.content : '';
        // Pi appends sections to content. Equal text in both is really sent twice.
        if (content.trim()) addText('system_prompt', content);
        const toolsAdded =
          'toolsAdded' in message && Array.isArray(message.toolsAdded) ? message.toolsAdded : [];
        if (toolsAdded.length) {
          sawRequest = true;
          countedTools = true;
        }
        for (const tool of toolsAdded) addTool(tool, options, add, probes);
      } else {
        const read = readConversation(message);
        if (read.images) omissions.set('messages', 'unmeasured_image');
        if (read.unsupported) omissions.set('other', 'unsupported_payload');
        addText('messages', read.text);
      }
    }

    if (!countedTools && Array.isArray(context.tools)) {
      for (const tool of context.tools) {
        sawRequest = true;
        addTool(tool, options, add, probes);
      }
    }
    if (options.unmeasuredTools) {
      sawRequest = true;
      omissions.set('system_tools', 'unmeasured_tool');
    }
    if (options.unsupportedPayload) omissions.set('other', 'unsupported_payload');

    const parts: ContextUsageSnapshot['parts'] = [...buckets.entries()].map(
      ([category, tokens]) => ({
        category,
        tokens,
        ...(omissions.has(category) ? { omission: omissions.get(category) } : {}),
      }),
    );
    for (const [category, omission] of omissions) {
      if (!parts.some((part) => part.category === category))
        parts.push({ category, tokens: buckets.get(category) ?? 0, omission });
    }
    const usedTokens = [...buckets.values()].reduce((sum, tokens) => sum + tokens, 0);
    return {
      usage: ContextUsageSchema.parse({
        version: 1,
        coverage: sawRequest ? 'request' : 'messages',
        completeness: omissions.size ? 'partial' : 'complete',
        method: 'pi-1.3.0-chars4',
        usedTokens,
        parts,
      }),
      probes,
    };
  } catch {
    return { usage: emptyUsage('error'), probes: [] };
  }
}

function addTool(
  tool: unknown,
  options: InspectOptions,
  add: (category: Category, text: string) => void,
  probes: ContextProbe[],
) {
  if (!tool || typeof tool !== 'object') return;
  const name = 'name' in tool && typeof tool.name === 'string' ? tool.name : '';
  const category: Category = options.mcpToolNames?.includes(name)
    ? 'mcp_tools'
    : options.otherToolNames?.includes(name)
      ? 'other'
      : 'system_tools';
  add(category, JSON.stringify(tool));
  const probe = probes.at(-1);
  if (name && probe) probe.toolName = name;
}

function readConversation(message: object): { text: string; images: number; unsupported: boolean } {
  if (!('content' in message)) return { text: '', images: 0, unsupported: false };
  const content = message.content;
  if (typeof content === 'string') return { text: content, images: 0, unsupported: false };
  if (!Array.isArray(content)) return { text: '', images: 0, unsupported: Boolean(content) };
  let text = '';
  let images = 0;
  let unsupported = false;
  for (const part of content) {
    if (!part || typeof part !== 'object' || !('type' in part)) {
      unsupported = true;
      continue;
    }
    if (part.type === 'text' && 'text' in part && typeof part.text === 'string') text += part.text;
    else if (part.type === 'image') images += 1;
    else if (part.type === 'thinking' && 'thinking' in part && typeof part.thinking === 'string')
      text += part.thinking;
    else if (part.type === 'toolCall' && 'name' in part && 'arguments' in part)
      text += String(part.name) + JSON.stringify(part.arguments);
    else unsupported = true;
  }
  return { text, images, unsupported };
}

/** Partition actual included text by assembler-provided source bodies, without adding them again. */
function partitionText(
  text: string,
  fallback: Category,
  sources: readonly ContextProbe[],
  add: (category: Category, text: string) => void,
) {
  let rest = text;
  while (rest) {
    let selected: ContextProbe | undefined;
    let offset = rest.length;
    for (const source of sources) {
      if (!source.text || source.toolName || source.category === fallback) continue;
      const at = rest.indexOf(source.text);
      if (at < 0 || at > offset) continue;
      if (at < offset || !selected || source.text.length > selected.text.length) {
        selected = source;
        offset = at;
      }
    }
    if (!selected) {
      add(fallback, rest);
      break;
    }
    if (offset) add(fallback, rest.slice(0, offset));
    add(selected.category, selected.text);
    rest = rest.slice(offset + selected.text.length);
  }
}

/** Measure supported final provider input fields after hooks; transport options are not context. */
export function reconcileContextUsage(
  usage: ContextUsageSnapshot,
  probes: readonly ContextProbe[],
  serializedPayload: string,
): ContextUsageSnapshot {
  if (usage.completeness === 'error') return usage;
  const buckets = new Map<Category, number>();
  const omissions = new Map<Category, Omission>();
  for (const part of usage.parts)
    if (part.omission === 'unmeasured_tool' || part.omission === 'measurement_error')
      omissions.set(part.category, part.omission);
  const actualTexts: string[] = [];
  const actualTools = new Set<string>();
  const classified = probes.filter((probe) =>
    ['skills', 'memory_files', 'instructions'].includes(probe.category),
  );
  const add = (category: Category, text: string) => {
    if (text) buckets.set(category, (buckets.get(category) ?? 0) + tokensOf(text.length));
  };
  const text = (value: string, category: Category) => {
    actualTexts.push(value);
    partitionText(value, category, classified, add);
  };
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const unsupported = () => omissions.set('other', 'unsupported_payload');
  const tool = (value: unknown) => {
    const item = object(value);
    if (!item) return unsupported();
    const definition = object(item.function) ?? item;
    const name = typeof definition.name === 'string' ? definition.name : '';
    const source = probes.find((probe) => probe.toolName === name);
    const category = source?.category ?? 'other';
    if (
      !name ||
      (!definition.parameters && !definition.input_schema && !definition.parametersJsonSchema)
    )
      omissions.set(category, 'unmeasured_tool');
    if (name) actualTools.add(name);
    add(category, JSON.stringify(definition));
  };
  const content = (value: unknown, category: Category) => {
    if (typeof value === 'string') return text(value, category);
    if (value == null) return;
    if (!Array.isArray(value)) return unsupported();
    for (const entry of value) {
      const part = object(entry);
      if (!part) {
        unsupported();
        continue;
      }
      if (part.thoughtSignature || part.thought_signature) unsupported();
      if (
        typeof part.text === 'string' &&
        ['text', 'input_text', 'output_text', undefined].includes(part.type as string | undefined)
      )
        text(part.text, category);
      else if (
        ['image', 'image_url', 'input_image'].includes(String(part.type)) ||
        part.inlineData ||
        part.inline_data ||
        part.fileData
      )
        omissions.set(category, 'unmeasured_image');
      else if (part.type === 'thinking' && typeof part.thinking === 'string') {
        text(part.thinking, category);
        if (part.signature) unsupported();
      } else if (part.type === 'tool_result') content(part.content, category);
      else if (part.type === 'tool_use')
        text(String(part.name) + JSON.stringify(part.input), category);
      else if (part.functionCall) text(JSON.stringify(part.functionCall), category);
      else if (part.functionResponse) {
        const response = object(part.functionResponse);
        if (!response) unsupported();
        else {
          text(JSON.stringify({ name: response.name, response: response.response }), category);
          if (response.parts) content(response.parts, category);
        }
      } else unsupported();
    }
  };
  const messages = (value: unknown) => {
    if (typeof value === 'string') return text(value, 'messages');
    if (!Array.isArray(value)) return unsupported();
    for (const entry of value) {
      const message = object(entry);
      if (!message) {
        unsupported();
        continue;
      }
      const category = ['system', 'developer'].includes(String(message.role))
        ? 'system_prompt'
        : 'messages';
      for (const key of ['reasoning_content', 'reasoning', 'reasoning_text']) {
        if (typeof message[key] === 'string') text(message[key], category);
        else if (message[key] != null) unsupported();
      }
      if (message.reasoning_details != null) unsupported();
      if (message.type === 'function_call') {
        text(String(message.name) + String(message.arguments), category);
      } else if (message.type === 'function_call_output') {
        content(message.output, category);
      } else if (['additional_tools', 'tool_search_output'].includes(String(message.type))) {
        if (Array.isArray(message.tools)) message.tools.forEach(tool);
        else unsupported();
      } else if (message.content !== undefined || message.parts !== undefined) {
        content(message.content ?? message.parts, category);
        if (Array.isArray(message.tool_calls))
          for (const call of message.tool_calls) {
            const fn = object(object(call)?.function);
            if (fn) text(String(fn.name) + String(fn.arguments), category);
            else unsupported();
          }
        if (message.sections || message.toolsAdded || message.toolsRemoved) unsupported();
      } else unsupported();
    }
  };
  try {
    const payload = object(JSON.parse(serializedPayload || '{}'));
    if (!payload) unsupported();
    else {
      const recognized =
        payload.messages !== undefined ||
        payload.input !== undefined ||
        payload.contents !== undefined;
      if (!recognized) unsupported();
      if (payload.messages !== undefined) messages(payload.messages);
      if (payload.input !== undefined) messages(payload.input);
      if (payload.contents !== undefined) messages(payload.contents);
      if (payload.instructions !== undefined) content(payload.instructions, 'system_prompt');
      if (payload.system !== undefined) content(payload.system, 'system_prompt');
      const config = object(payload.config);
      const system =
        payload.systemInstruction ?? payload.system_instruction ?? config?.systemInstruction;
      if (typeof system === 'string') text(system, 'system_prompt');
      else if (system !== undefined) content(object(system)?.parts, 'system_prompt');
      const definitions = payload.tools ?? config?.tools;
      if (Array.isArray(definitions))
        for (const entry of definitions) {
          const declarations =
            object(entry)?.functionDeclarations ?? object(entry)?.function_declarations;
          if (Array.isArray(declarations)) declarations.forEach(tool);
          else tool(entry);
        }
    }
    for (const probe of probes) {
      // Provider adapters can split/merge message blocks. The actual blocks above
      // have already been counted, so concatenated source messages are not probes.
      if (probe.category === 'messages') continue;
      const present = probe.toolName
        ? actualTools.has(probe.toolName)
        : actualTexts.some((value) => value.includes(probe.text));
      if (!present && !omissions.has(probe.category))
        omissions.set(probe.category, 'not_in_payload');
    }
    const parts = [...new Set([...buckets.keys(), ...omissions.keys()])].map((category) => ({
      category,
      tokens: buckets.get(category) ?? 0,
      ...(omissions.has(category) ? { omission: omissions.get(category) } : {}),
    }));
    return ContextUsageSchema.parse({
      ...usage,
      coverage: 'request',
      completeness: omissions.size ? 'partial' : 'complete',
      usedTokens: parts.reduce((sum, part) => sum + part.tokens, 0),
      parts,
    });
  } catch {
    return emptyUsage('error');
  }
}
