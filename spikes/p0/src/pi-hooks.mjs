// C-052 Pi spike (no network): tool hook order, blocked tools, per-request context injection,
// steering timing, per-call credentials, abort. Uses pi-ai's faux provider.
import { Agent } from '@earendil-works/pi-agent-core';
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, Type } from '@earendil-works/pi-ai';

function setup({ toolExecution, responses, prepareRequest, getApiKey }) {
  const faux = createFauxCore({});
  faux.setResponses(responses);
  const log = [];
  const executed = [];
  const tool = (name) => ({
    name,
    label: name,
    description: `${name} tool`,
    parameters: Type.Object({ text: Type.String() }),
    execute: async (id, params) => {
      executed.push(name);
      log.push(`execute:${name}`);
      return { content: [{ type: 'text', text: `${name} ok` }], details: params };
    },
  });
  const agent = new Agent({
    initialState: {
      model: faux.getModel(),
      systemPrompt: 'spike',
      tools: [tool('write_artifact'), tool('shell_exec')],
    },
    streamFn: faux.streamSimple,
    toolExecution,
    getApiKey,
    prepareRequest,
    beforeToolCall: async ({ toolCall }) => {
      log.push(`beforeToolCall:${toolCall.name}`);
      return toolCall.name === 'shell_exec' ? { block: true, reason: 'not allowed' } : undefined;
    },
  });
  agent.subscribe((event) => {
    if (event.type.startsWith('tool_execution')) log.push(`${event.type}:${event.toolName}${event.type === 'tool_execution_end' ? `:isError=${event.isError}:ran=${event.durationMs !== undefined}` : ''}`);
    else if (['turn_start', 'turn_end', 'agent_end'].includes(event.type)) log.push(event.type);
  });
  return { agent, faux, log, executed };
}

const twoTools = () => [
  fauxAssistantMessage([fauxToolCall('write_artifact', { text: 'a' }), fauxToolCall('shell_exec', { text: 'rm' })], { stopReason: 'toolUse' }),
  fauxAssistantMessage('done'),
];

const result = {};

// A. Hook order and blocked tools, sequential and parallel.
for (const mode of ['sequential', 'parallel']) {
  const s = setup({ toolExecution: mode, responses: twoTools() });
  await s.agent.prompt('go');
  result[`toolOrder_${mode}`] = s.log;
  result[`executed_${mode}`] = s.executed;
}

// B. prepareRequest runs before every provider request and can inject a directive.
{
  const seen = [];
  let requests = 0;
  const responses = [
    (ctx) => {
      seen.push(JSON.stringify(ctx.messages).includes('DIRECTIVE-1'));
      return fauxAssistantMessage([fauxToolCall('write_artifact', { text: 'x' })], { stopReason: 'toolUse' });
    },
    (ctx) => {
      seen.push(JSON.stringify(ctx.messages).includes('DIRECTIVE-1'));
      return fauxAssistantMessage('done');
    },
  ];
  const s = setup({
    toolExecution: 'sequential',
    responses,
    prepareRequest: async ({ context }) => {
      requests += 1;
      if (requests !== 2) return undefined;
      const directive = { role: 'user', content: [fauxText('DIRECTIVE-1 use primary sources')], timestamp: Date.now() };
      return { context: { ...context, messages: [...context.messages, directive] } };
    },
  });
  await s.agent.prompt('go');
  result.prepareRequestCalls = requests;
  result.directiveVisibleToRequest = seen;
}

// C. agent.steer() during request 1 reaches request 2 only.
{
  const seen = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const responses = [
    async (ctx) => {
      seen.push(JSON.stringify(ctx.messages).includes('STEER-1'));
      await gate;
      return fauxAssistantMessage([fauxToolCall('write_artifact', { text: 'x' })], { stopReason: 'toolUse' });
    },
    (ctx) => {
      seen.push(JSON.stringify(ctx.messages).includes('STEER-1'));
      return fauxAssistantMessage('done');
    },
  ];
  const s = setup({ toolExecution: 'sequential', responses });
  const run = s.agent.prompt('go');
  await new Promise((r) => setTimeout(r, 20));
  s.agent.steer({ role: 'user', content: [fauxText('STEER-1')], timestamp: Date.now() });
  release();
  await run;
  result.steerVisibleToRequest = seen;
}

// D. getApiKey is asked before each provider request (host can refresh OAuth per call).
{
  const asked = [];
  const s = setup({ toolExecution: 'sequential', responses: twoTools(), getApiKey: (provider) => (asked.push(provider), 'token') });
  await s.agent.prompt('go');
  result.getApiKeyCalls = asked;
}

// E. abort during a slow response: final message and usage.
{
  const faux = createFauxCore({ tokensPerSecond: 5 });
  faux.setResponses([fauxAssistantMessage('a long answer that streams slowly '.repeat(5))]);
  const agent = new Agent({ initialState: { model: faux.getModel(), systemPrompt: 'spike' }, streamFn: faux.streamSimple });
  const run = agent.prompt('go');
  await new Promise((r) => setTimeout(r, 300));
  agent.abort();
  await run;
  const last = agent.state.messages.at(-1);
  result.abort = { stopReason: last?.stopReason, errorMessage: last?.errorMessage, usage: last?.usage };
}

console.log(JSON.stringify(result, null, 2));
