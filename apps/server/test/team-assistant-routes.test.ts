import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  assistantKindAllowed,
  TeamAssistantReply,
  type TeamAssistantRequest,
  unusableTeamProposal,
} from '@corral/contracts';
import {
  BUILTIN_SKILLS,
  builtinComposableAgents,
  readAssistantAnswer,
  teamCatalog,
} from '@corral/core';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { type CorralServer, startCorralServer } from '../src/index.ts';
import {
  createPrompt,
  TEAM_ASSISTANT_EDIT_PROMPT,
  TEAM_ASSISTANT_MAX_OUTPUT_TOKENS,
  TEAM_ASSISTANT_TIMEOUT_MS,
} from '../src/models/team-assistant.ts';
import { FAKE_PROFILES, fakeOpenAI, fauxAssistantMessage } from '../src/testing.ts';

const assistant = '/team-assistant';
const token = 'assistant-test-bootstrap-0123456789';
const roots: string[] = [];
const servers: CorralServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup(
  options: {
    live?: boolean;
    signedIn?: boolean;
    tokensPerSecond?: number;
    profiles?: { id: string; provider: string; model: string }[];
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'corral-team-assistant-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const state = join(workspace, '.corral');
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, 'config.json'),
    JSON.stringify({ schemaVersion: '0.1', modelProfiles: options.profiles ?? FAKE_PROFILES }),
  );
  const fake = fakeOpenAI({
    configDir: join(root, 'config'),
    env: options.signedIn === false ? {} : { OPENAI_API_KEY: 'local-fake-key' },
    tokensPerSecond: options.tokensPerSecond,
  });
  const server = await startCorralServer({
    workspace,
    port: 0,
    bootstrapToken: token,
    agents: new ScriptedAgentAdapter({ turns: 1 }),
    ...(options.live === false ? {} : { live: fake.live }),
  });
  servers.push(server);
  const headers = new Headers({ origin: server.url, 'content-type': 'application/json' });
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ token }),
  });
  headers.set('cookie', (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '');
  headers.set('x-corral-csrf', login.headers.get('x-corral-csrf') ?? '');
  const call = async (path: string, body?: unknown, signal?: AbortSignal) => {
    const response = await fetch(`${server.url}/api/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { fake, call, dbPath: join(state, 'corral.db') };
}

// What the editor can pick by hand, sent with every new team request.
const catalog = {
  agents: [
    {
      id: 'a1',
      name: 'Writer',
      description: 'Writes documents.',
      changesFiles: false,
      runsCommands: false,
      output: 'draft',
      skills: [],
    },
  ],
  skills: [{ id: 's1', name: 'plain-language', description: 'Writes plainly.' }],
};
const create = (operationId: string, content: string) => ({
  operationId,
  mode: 'create',
  messages: [{ role: 'user', content }],
  catalog,
});
const edit = (operationId: string) => ({
  operationId,
  messages: [{ role: 'user', content: 'Review the notice before publishing.' }],
  mode: 'edit',
  team: {
    roles: [{ nodeId: 'writer', name: 'Writer' }],
    outputs: [{ outputId: 'out', results: [{ index: 2, name: 'Notice', producerName: 'Writer' }] }],
    hasSharedOutrider: false,
    brief: 'Write the notice.',
  },
});
const plan = {
  name: 'Notice writer',
  brief: 'Write a notice.',
  criteria: ['Clear notice.'],
  seats: [{ id: 's1', agent: 'a1', name: 'Writer', duty: 'Write and submit the notice.' }],
  flow: [{ seat: 's1' }],
};
// The plan of the removed pattern drafts: not a composition.
const legacyPlan = {
  pattern: 'single',
  name: 'Notice writer',
  brief: 'Write a notice.',
  criteria: ['Clear notice.'],
  roles: [{ slot: 'worker', name: 'Writer', duty: 'Write and submit the notice.' }],
  finalApproval: false,
};
const proposal = { kind: 'plan', plan, reason: 'Only a writer is needed.' };
const question = { kind: 'question', id: 'material', choices: ['person', 'team'] };
const required = { kind: 'require_review', outputId: 'out', index: 2 };
const failedAnswer = { status: 502, body: { error: { code: 'MODEL_UNAVAILABLE' } } };
/** The failure that names why the answer could not be used, and nothing of the answer. */
const unusable = (problem: string) => ({
  status: 502,
  body: {
    error: {
      code: 'MODEL_UNAVAILABLE',
      message: unusableTeamProposal(problem),
    },
  },
});

it('returns a plan immediately for a sufficient goal and records one body-free managed attempt', async () => {
  const { fake, call } = await setup();
  const request = create('notice', 'Write this notice with one writer.');
  fake.replyText(JSON.stringify(proposal));
  expect(await call(assistant, request)).toEqual({
    status: 200,
    body: { model: 'Test A', reply: proposal },
  });
  expect(fake.seen.hostRequests).toHaveLength(1);
  expect(fake.seen.hostRequests[0]?.text).toContain(request.messages[0]?.content);
  const history = await call('/model-attempts?ownerId=notice');
  expect(history.status).toBe(200);
  const recorded = JSON.stringify(history.body);
  expect(history.body).toMatchObject({
    items: [{ intent: { requestId: 'notice', purpose: 'draft' } }],
  });
  expect(recorded).not.toContain('Write this notice');
  expect(recorded).not.toContain(proposal.reason);
});

it('sends the catalog and the shown proposal to the model as data, with the route’s own allowance', async () => {
  const { fake, call } = await setup();
  const revised = { ...plan, name: 'Notice team' };
  fake.replyText(JSON.stringify({ ...proposal, plan: revised }));
  const request = { ...create('revise', 'Add a second writer.'), proposal: plan };
  expect(await call(assistant, request)).toMatchObject({
    status: 200,
    body: { reply: { kind: 'plan', plan: revised } },
  });
  const [sent] = fake.seen.hostRequests;
  // The route's own allowance and timeout, apart from the draft route's; the fake model caps
  // every request at 500 output tokens, so only the constants show them.
  expect([TEAM_ASSISTANT_MAX_OUTPUT_TOKENS, TEAM_ASSISTANT_TIMEOUT_MS]).toEqual([6000, 90_000]);
  expect(sent?.maxTokens).toBe(500);
  const turns = JSON.parse(sent?.text ?? '[]') as { role: string; content: unknown }[];
  const system = JSON.stringify(turns.filter(({ role }) => role !== 'user'));
  const user = JSON.stringify(turns.find(({ role }) => role === 'user')?.content);
  expect(user).toContain('Writes documents.');
  expect(user).toContain('Notice writer');
  expect(user).not.toContain('operationId');
  // The prompt composes from the catalog; it names no fixed pattern.
  expect(system).toContain('catalog');
  expect(system).not.toContain('research_write_review');
});

it('refuses a composition that seats an agent outside the catalog or names tools', async () => {
  const { fake, call } = await setup();
  const seat = plan.seats[0];
  const cases = [
    [{ ...proposal, plan: { ...plan, seats: [{ ...seat, agent: 'a9' }] } }, 'unknown_agent'],
    [
      { ...proposal, plan: { ...plan, seats: [{ ...seat, tools: ['write_file'] }] } },
      'shape:plan.seats.0:extra_field',
    ],
    [{ ...proposal, plan: legacyPlan }, 'shape:plan.seats:missing'],
  ] as const;
  for (const [i, [reply, problem]] of cases.entries()) {
    fake.replyText(JSON.stringify(reply));
    expect(await call(assistant, create(`outside-${i}`, 'Write a notice.'))).toMatchObject(
      unusable(problem),
    );
  }
  expect(fake.seen.hostRequests).toHaveLength(cases.length);
});

it('drops a skill the catalog does not list, or one named twice, and returns the plan', async () => {
  const { fake, call } = await setup();
  const seat = plan.seats[0];
  fake.replyText(
    JSON.stringify({
      ...proposal,
      plan: { ...plan, seats: [{ ...seat, skills: ['s9', 's1', 's1'] }] },
    }),
  );
  expect(await call(assistant, create('skills', 'Write a notice.'))).toEqual({
    status: 200,
    body: {
      model: 'Test A',
      reply: { ...proposal, plan: { ...plan, seats: [{ ...seat, skills: ['s1'] }] } },
    },
  });
});

type CreateRequest = Extract<TeamAssistantRequest, { mode: 'create' }>;
const agentOf = (id: string, output: 'draft' | 'review' | 'notes', name = id) => ({
  id,
  name,
  changesFiles: false,
  runsCommands: false,
  output,
  skills: [],
});
const createRequest = (more: Partial<CreateRequest> = {}): CreateRequest => ({
  operationId: 'prompt',
  mode: 'create',
  messages: [{ role: 'user', content: 'Write a notice.' }],
  catalog: {
    agents: [
      agentOf('a1', 'notes'),
      agentOf('a2', 'review'),
      agentOf('a3', 'draft'),
      agentOf('a4', 'review'),
    ],
    skills: [],
  },
  ...more,
});

it('builds a new team’s prompt from the request: deliverable first, then fields, flow, composing and examples', () => {
  const prompt = createPrompt(createRequest());
  const order = [
    'Choose the requested deliverable and the seat that produces it first. Missing files or text can be supplied when the team runs. Ask material only when choosing who gathers the material would change the team. Ask review_policy only when the person requested review before submission and left the pass condition open. A request for findings is already a deliverable.',
    'Copy "agent" from catalog.agents[].id. Flow entries reference your seat ids. Omit optional fields you do not need. Write the team name, brief, criteria, seat names, duties and reason in the language of the goal unless the person asks for another language. Keep code identifiers as written.',
    '"id": a short word you choose for the seat, such as "build" or "verify"; it only links the seat to the flow',
    '"skills": optional, at most 4 ids from catalog.skills, written exactly as their "id"',
    '- outrider: omit it unless the person explicitly asks for expert advice on request ("consultation"), feedback on a draft on request ("artifact_review"), or a pass that is required before submission ("required_review"); a structured review-policy decision takes precedence. Corral supplies the adviser or reviewer for the selected policy, so write only the policy string, for example "outrider":"consultation", and add no seat or flow step for it. A request for advice only, even without a named deliverable, is a complete goal.',
    '{"parallel":[...]}: 2 to 4 seats work side by side from what came before, or from the brief when it is the first step; the next step reads all of them.',
    // The judge is a declared seat, named once in loop.judge and never a step after the loop.
    '{"loop":{"work":[...],"judge":"check","rounds":2}}: Each round runs the 1 to 3 work seats in order, then the judge passes the work or requests changes. `rounds` counts the first work run plus the allowed revisions (1 to 3 runs, default 2), so one send-back means "rounds":2 and two send-backs mean "rounds":3. "judge" is the id of a seat you declare in seats, like any other seat; that seat\'s agent must be one that can judge a loop.',
    '"judge" is the id of a seat you declare in seats, like any other seat; that seat\'s agent must be one that can judge a loop.',
    'Within flow, reference the judge\'s seat exactly once, in loop.judge: it is not a step, so add no {"seat":…} for it after the loop; its verdict is already the check on the loop\'s work.',
    'How to compose:',
    'Give the producing seat the routine checks it can do itself (running the tests, rereading its draft). Add a seat when its result changes the next decision, such as finding the cause of a failure before fixing it. Use a judge when the producing seat\'s own checks leave a consequential failure untested, so that an independent check can send the work back. When the person explicitly makes passing review a condition of submitting the team\'s deliverable, set "outrider":"required_review" because a judged loop forwards its last candidate at the round cap even if changes are still needed. Add a judged loop alongside the gate only when the request also calls for a distinct revision stage, since the gate already returns work needing changes to its producer.',
    'The last step holds the seat that makes the deliverable.',
    '- For bounded revision, put the checker in loop.judge. End with a reviewing agent only when the review itself is the deliverable.',
    'Have reviewers inspect the evidence directly. Split independent concerns when useful, and combine the findings when the person wants one ranked report.',
    "A last step that is a side-by-side group returns each seat's result, so add a seat after it only when one combined result is wanted.",
    'Promise that a result must pass only with "required_review": not in a duty, a criterion or the reason otherwise.',
    'Each duty names what it reads from earlier seats.',
    'A small edit (a typo, a rename, a comment, a line or two) is one seat and nothing else.',
    'Examples:',
    // The full example sits the first agent that returns a draft under that agent's own name,
    // with no optional field.
    '{"kind":"plan","reason":"One seat is enough.","plan":{"name":"Small task","brief":"Do the task.","criteria":["The result does what was asked."],"seats":[{"id":"work","agent":"a3","name":',
    '"duty":"Do the task and submit the result."}],"flow":[{"seat":"work"}]}}',
    // The loop example is a whole reply: the work seat sits the same agent, the judge seat the
    // first agent that can judge, both declared.
    // It is about review and revision, not a condition of submission.
    '- review and revise a draft: {"kind":"plan","reason":"The reviewer can send the draft back for one revision.","plan":{"name":"Draft and revision","brief":"Write the draft. Another seat reviews it, and the writer revises it once if changes are requested."',
    '{"id":"write","agent":"a3",',
    '{"id":"check","agent":"a2",',
    '"flow":[{"loop":{"work":["write"],"judge":"check"}}]}}',
    // The gate: one seat and the required review.
    '- a notice that must pass review before submission: {"kind":"plan","reason":"The team can submit the notice only after it passes review.","plan":{"name":"Service notice","brief":"Write a notice about the service interruption. Submit it only if it passes review.","criteria":["The notice explains the service interruption."],"seats":[{"id":"work","agent":"a3",',
    '"duty":"Write the notice."}],"flow":[{"seat":"work"}],"outrider":"required_review"}}',
    '[{"parallel":["cost","risk"]},{"seat":"synthesize"}]',
  ];
  let at = -1;
  for (const line of order) {
    const found = prompt.indexOf(line);
    expect(found, line).toBeGreaterThan(at);
    at = found;
  }
  // The earlier guidance the new text does not replace stays.
  for (const kept of [
    'A request for advice only, even without a named deliverable, is a complete goal.',
    'A request for one writer to write a notice needs no question.',
    'Use parallel for independent attempts or independent views of the same input.',
    'If that answer is still unclear, propose a plan if possible.',
  ])
    expect(prompt).toContain(kept);
  // From this request: who can judge a loop, and which questions are still open.
  expect(prompt).toContain('Agents that can judge a loop: "a2", "a4".');
  expect(prompt).toContain('Questions you may still ask: "material", "review_policy".');
  // The new guidance names no subject of a measured goal.
  for (const subject of [/dark mode/i, /signup/i, /middleware/i, /onboarding/i, /cache/i])
    expect(prompt).not.toMatch(subject);
  // reason comes before plan, so no sibling follows the long nested object.
  expect(prompt).toContain('A plan is {"kind":"plan","reason":"one short sentence","plan":{...}}.');
  // No edit-mode example, and none of the old notation.
  for (const absent of [
    'The judge must be an agent',
    '"judge":"check"}}] (check sits',
    'outrider: optional',
    'at most `rounds` times',
    'Use material the person supplies',
    'Add a gatherer',
    'should be able to',
    'written only in loop.judge',
    'Corral supplies the reviewer, so',
    'An on-request adviser is shared advice',
    'counts work runs including the first',
    'A loop is bounded revision',
    'A checker of a change or a document is the judge of a loop',
    'a draft that another seat must check',
    'another seat must check it before it is submitted',
    'asks for an independent check before submission',
    'Draft checked before submission',
    'a notice that requires approval',
    'The notice needs review approval before submission.',
    'The editor can send the draft back',
    'EDIT MODE',
    'add_shared_advice',
    'require_review',
    'Never the first step',
    'such as "s1"',
  ])
    expect(prompt).not.toContain(absent);
});

/** The whole example replies of a prompt, as the model would copy them. */
const examplesOf = (prompt: string) =>
  prompt
    .slice(prompt.indexOf('Examples:'))
    .split('\n')
    .flatMap((line) => {
      const start = line.indexOf('{"kind":');
      return start < 0 ? [] : [line.slice(start)];
    });

it('gives example replies the reader accepts: a loop only when an agent can judge, a gate unless opinions only', () => {
  const request = createRequest();
  const examples = examplesOf(createPrompt(request));
  expect(examples).toHaveLength(3);
  for (const example of examples)
    expect(readAssistantAnswer(example, request)).toHaveProperty('reply');
  const [single, loop, gate] = examples.map((example) => JSON.parse(example));
  expect(Object.keys(single)).toEqual(['kind', 'reason', 'plan']);
  expect(Object.keys(loop)).toEqual(['kind', 'reason', 'plan']);
  expect(Object.keys(gate)).toEqual(['kind', 'reason', 'plan']);
  expect(loop.plan.seats.map((seat: { id: string }) => seat.id)).toEqual(['write', 'check']);
  expect(loop.plan.flow).toEqual([{ loop: { work: ['write'], judge: 'check' } }]);
  // The gate is read as written: one seat and the required review.
  const read = readAssistantAnswer(examples[2] as string, request);
  expect('reply' in read && read.reply.kind === 'plan' && read.reply.plan.outrider).toBe(
    'required_review',
  );
  expect(gate.plan.seats).toHaveLength(1);
  // No agent can judge: the gate, and no loop.
  const noJudge = createRequest({
    catalog: { agents: [agentOf('n1', 'notes'), agentOf('d1', 'draft')], skills: [] },
  });
  const plain = examplesOf(createPrompt(noJudge));
  expect(plain).toHaveLength(2);
  for (const example of plain)
    expect(readAssistantAnswer(example, noJudge)).toHaveProperty('reply');
  expect(createPrompt(noJudge)).not.toContain('"loop":{"work":["write"]');
  expect(createPrompt(noJudge)).toContain('"outrider":"required_review"}}');
  // Opinions only rules out a loop and a gate, so no example shows either.
  const opinions = createRequest({ decisions: { reviewPolicy: 'opinion_only' } });
  const unlooped = examplesOf(createPrompt(opinions));
  expect(unlooped).toHaveLength(1);
  expect(readAssistantAnswer(unlooped[0] as string, opinions)).toHaveProperty('reply');
  expect(createPrompt(opinions)).not.toContain('"loop":{"work":["write"]');
  expect(createPrompt(opinions)).not.toContain('"outrider":"required_review"}}');
  // Under opinions only the catalog section names no judging agent: it says to use no loop.
  expect(createPrompt(opinions)).toContain(
    '- Use no loop for this request because reviewPolicy is "opinion_only".',
  );
  expect(createPrompt(opinions)).not.toContain('Agents that can judge a loop');
  expect(createPrompt(request)).toContain('- Agents that can judge a loop: "a2", "a4".');
  expect(createPrompt(noJudge)).toContain('- Agents that can judge a loop: none, so use no loop.');
});

// The prompts as measured: a catalog whose names are trimmed and fit the seat name limit gets
// these exact prompts, byte for byte.
const PIN_DEFAULT = 'fa5ffb8798a81abcbb5f9a02a557a5b81178b60f8f25cd7cb43f0ff317b74b4a';
const PIN_CREW = 'b40f80e4b22226f8774b3fa4f13a4599e6caf1d1ce9661ecc5982ac0f215d5ee';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

it('keeps the prompt byte for byte for a catalog whose names already fit', () => {
  expect(sha(createPrompt(createRequest()))).toBe(PIN_DEFAULT);
  const crew = teamCatalog(
    builtinComposableAgents((id) => `${id.charAt(0).toUpperCase()}${id.slice(1)}`),
    BUILTIN_SKILLS.map((skill) => ({
      ref: { resourceHash: skill.resourceHash, entry: skill.entry },
      name: skill.name,
      description: skill.description,
    })),
  ).catalog;
  expect(sha(createPrompt(createRequest({ catalog: crew })))).toBe(PIN_CREW);
});

it.each([
  ['a surrogate pair straddling the cut', `${'a'.repeat(39)}😀tail`, `${'a'.repeat(39)}`],
  ['a whitespace-only name', '   ', undefined],
  ['forty leading spaces', `${' '.repeat(40)}Writer agent`, 'Writer agent'],
])('reads every example seat name with %s, and keeps agent ids', (_name, name, expected) => {
  const request = createRequest({
    catalog: { agents: [agentOf('d1', 'draft', name), agentOf('r1', 'review', name)], skills: [] },
  });
  const examples = examplesOf(createPrompt(request));
  expect(examples).toHaveLength(3);
  for (const example of examples) {
    expect(readAssistantAnswer(example, request)).toHaveProperty('reply');
    for (const seat of JSON.parse(example).plan.seats as { agent: string; name: string }[]) {
      expect(['d1', 'r1']).toContain(seat.agent);
      // No lone surrogate, nothing to trim, never empty: the cut name or the example's own.
      expect(seat.name).toBe(seat.name.trim());
      expect(seat.name.length).toBeGreaterThan(0);
      expect(seat.name.length).toBeLessThanOrEqual(40);
      expect(seat.name).toBe(expected ?? seat.name);
      if (expected === undefined) expect(['Worker', 'Writer', 'Reviewer']).toContain(seat.name);
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(seat.name),
      ).toBe(false);
    }
  }
});

it('cuts every example seat name to the seat name limit, so a long agent name stays readable', () => {
  const long = (letter: string) => letter.repeat(41);
  const request = createRequest({
    catalog: {
      agents: [agentOf('d1', 'draft', long('D')), agentOf('r1', 'review', long('R'))],
      skills: [],
    },
  });
  const prompt = createPrompt(request);
  const examples = examplesOf(prompt);
  expect(examples).toHaveLength(3);
  for (const example of examples) {
    expect(readAssistantAnswer(example, request)).toHaveProperty('reply');
    for (const seat of JSON.parse(example).plan.seats as { agent: string; name: string }[]) {
      expect(seat.name.length).toBeLessThanOrEqual(40);
      expect(['d1', 'r1']).toContain(seat.agent);
    }
  }
});

it('tells the model to ask nothing once no question is left, and falls back to the first agent', () => {
  const asked = createRequest({
    messages: [
      { role: 'user', content: 'Write the newsletter.' },
      { role: 'assistant', questionId: 'material', content: 'Who supplies it?' },
      { role: 'user', content: 'Recommend a choice.' },
    ],
    decisions: { reviewPolicy: 'required' },
  });
  expect(createPrompt(asked)).toContain('No question is left: ask nothing, give a plan.');
  expect(createPrompt(asked)).not.toContain('Questions you may still ask');
  const noDraft = createRequest({
    catalog: { agents: [agentOf('n1', 'notes'), agentOf('n2', 'notes')], skills: [] },
  });
  expect(createPrompt(noDraft)).toContain('"agent":"n1"');
  expect(createPrompt(noDraft)).toContain('Agents that can judge a loop: none, so use no loop.');
});

it('sends a new team its own prompt and an edit the edit prompt', async () => {
  const { fake, call } = await setup();
  const systemOf = (index: number) => {
    const turns = JSON.parse(fake.seen.hostRequests[index]?.text ?? '[]') as {
      role: string;
      content: unknown;
    }[];
    return JSON.stringify(turns.filter(({ role }) => role !== 'user'));
  };
  fake.replyText(JSON.stringify(proposal));
  await call(assistant, create('own-prompt', 'Write a notice.'));
  fake.replyText(JSON.stringify({ kind: 'describe', topic: 'submitter' }));
  await call(assistant, edit('edit-prompt'));
  expect(systemOf(0)).toContain('Choose the requested deliverable');
  expect(systemOf(0)).not.toContain('EDIT MODE');
  expect(systemOf(1)).toContain('EDIT MODE');
  expect(systemOf(1)).toContain(JSON.stringify(TEAM_ASSISTANT_EDIT_PROMPT).slice(1, 80));
  // The edit prompt is sent only in edit mode: it carries nothing about a new team.
  for (const createOnly of [
    'create mode',
    'catalog',
    'proposal (',
    'edit-mode request',
    'The two fixed choice lists above',
    '(edit only)',
    'only in plan and edits',
  ])
    expect(TEAM_ASSISTANT_EDIT_PROMPT).not.toContain(createOnly);
  for (const sentence of [
    'Use unsupported only for a request outside these capabilities.',
    'The fixed choice list above is exhaustive.',
    'For review_target, choices are two or three distinct existing',
    'Include one short reason sentence only in edits.',
    'After two questions give a proposal, not another question.',
  ])
    expect(TEAM_ASSISTANT_EDIT_PROMPT).toContain(sentence);
});

it('teaches an edit to ask when passing is left open, to gate when submission depends on it, and to add advice on request', () => {
  const examples = [
    `Examples:\nIn all three examples, the team's only result is a handout with outputId "handouts" and index 2.`,
    `- "Review the handout before sending it." → {"kind":"question","id":"review_policy","choices":["opinion_only","required"]}`,
    `- "Send the handout only after it passes review." → {"kind":"edits","edits":[{"kind":"require_review","outputId":"handouts","index":2}],"reason":"The handout must pass review before it can be sent."}`,
    `- "Let the team consult an expert when questions come up while drafting the handout." → {"kind":"edits","edits":[{"kind":"add_shared_advice"}],"reason":"You asked for expert advice on demand while drafting the handout."}`,
    `- describe: {"kind":"describe","topic":"submitter"}\n- unsupported: {"kind":"unsupported"}\n`,
  ];
  expect(TEAM_ASSISTANT_EDIT_PROMPT).toContain(examples.join('\n'));
  expect(TEAM_ASSISTANT_EDIT_PROMPT).toContain(
    "If the person asks for review before submission and leaves open whether the result must pass, ask review_policy. If submission depends on passing, propose require_review immediately for the selected result or the team's only result. Ask review_target only when several results could be gated and the target is still unclear.\nQUESTION RULES:",
  );
  expect(TEAM_ASSISTANT_EDIT_PROMPT).toContain(
    'A reviewPolicy decision of opinion_only asks for add_shared_advice, not a gate, reviewer, review target or question. Declining a review gate does not by itself request advice.',
  );
  // The bare examples are gone, and the lead-in counts every example.
  expect(TEAM_ASSISTANT_EDIT_PROMPT).not.toContain('In both examples');
  expect(TEAM_ASSISTANT_EDIT_PROMPT).not.toContain(
    'The author can ask for feedback without blocking submission.',
  );
  expect(TEAM_ASSISTANT_EDIT_PROMPT).not.toContain('- question: ');
  expect(TEAM_ASSISTANT_EDIT_PROMPT).not.toContain('- edits: ');
  // Each example answer is one reply an edit takes, by the contract.
  const answers = [...TEAM_ASSISTANT_EDIT_PROMPT.matchAll(/^- ".*" → (\{.*\})$/gm)].map(
    ([, json]) => TeamAssistantReply.parse(JSON.parse(json ?? '')),
  );
  expect(answers.map((reply) => reply.kind)).toEqual(['question', 'edits', 'edits']);
  for (const reply of answers) expect(assistantKindAllowed('edit', reply.kind)).toBe(true);
  expect(answers[1]).toEqual({
    kind: 'edits',
    edits: [{ kind: 'require_review', outputId: 'handouts', index: 2 }],
    reason: 'The handout must pass review before it can be sent.',
  });
  expect(answers[2]).toEqual({
    kind: 'edits',
    edits: [{ kind: 'add_shared_advice' }],
    reason: 'You asked for expert advice on demand while drafting the handout.',
  });
});

it('asks the first model of a connected provider when there is no named profile', async () => {
  const { fake, call } = await setup({ profiles: [] });
  const profiles = await call('/model-profiles');
  expect(profiles.body[0]).toMatchObject({ source: 'connection', modelName: 'Test A' });
  fake.replyText(JSON.stringify(proposal));
  expect(await call(assistant, create('connection-only', 'Write a notice.'))).toEqual({
    status: 200,
    body: { model: 'Test A', reply: proposal },
  });
  expect(fake.seen.hostRequests).toHaveLength(1);
});

it('skips a named profile that cannot run and asks the first one that can', async () => {
  const { fake, call } = await setup({
    profiles: [
      { id: 'retired', provider: 'openai', model: 'gpt-retired' },
      { id: 'model-b', provider: 'openai', model: 'gpt-test-b' },
    ],
  });
  fake.replyText(JSON.stringify(proposal));
  expect(await call(assistant, create('second-profile', 'Write a notice.'))).toEqual({
    status: 200,
    body: { model: 'Test B', reply: proposal },
  });
});

it('allows one material question with fixed choices, but not a third question', async () => {
  const { fake, call } = await setup();
  const request = create('materials', 'Prepare a comparison.');
  fake.replyText(JSON.stringify(question));
  expect(await call(assistant, request)).toEqual({
    status: 200,
    body: { reply: question, model: 'Test A' },
  });
  fake.replyText(JSON.stringify(question));
  const third = await call(assistant, {
    ...request,
    operationId: 'third',
    messages: [
      ...request.messages,
      { role: 'assistant', questionId: 'material', content: 'Who supplies the material?' },
      { role: 'user', content: 'Recommend a choice.' },
      { role: 'assistant', questionId: 'review_policy', content: 'Require review?' },
      { role: 'user', content: 'Recommend a choice.' },
    ],
  });
  expect(third).toMatchObject(failedAnswer);
  expect(fake.seen.hostRequests).toHaveLength(2);
});

it('accepts a typed policy answer and does not send the person through the same question again', async () => {
  const { fake, call } = await setup();
  const base = edit('typed');
  const messages = [
    { role: 'user', content: 'Get a review before publishing.' },
    { role: 'assistant', questionId: 'review_policy', content: 'Choose one.' },
    { role: 'user', content: 'Just get a second opinion.' },
  ];
  const advice = {
    kind: 'edits',
    edits: [{ kind: 'add_shared_advice' }],
    reason: 'Advice is optional.',
  };
  const repeated = { kind: 'question', id: 'review_policy', choices: ['opinion_only', 'required'] };
  for (const [operationId, input, answer, expected] of [
    ['typed-edit', base, advice, advice],
    ['typed-create', create('', ''), proposal, proposal],
    ['unresolved-edit', base, repeated, { kind: 'unsupported' }],
    ['unresolved-create', create('', ''), repeated, null],
    [
      'typed-decision',
      { ...base, decisions: { reviewPolicy: 'opinion_only' } },
      { ...advice, edits: [required] },
      { kind: 'edits', edits: [{ kind: 'add_shared_advice' }] },
    ],
  ] as const) {
    fake.replyText(JSON.stringify(answer));
    const response = await call(assistant, { ...input, operationId, messages });
    expect(response).toMatchObject(
      expected ? { status: 200, body: { reply: expected } } : failedAnswer,
    );
  }
  expect(fake.seen.hostRequests).toHaveLength(5);
});

it('rejects whole invalid replies, unknown targets and mode mismatches without retry or raw text', async () => {
  const { fake, call } = await setup();
  const edits = [{ kind: 'add_shared_advice' }, { ...required, index: 0 }];
  const cases = [
    [
      create('extra', 'Write it.'),
      { ...proposal, extra: 'private-raw-answer' },
      'shape:$:extra_field',
    ],
    [edit('target'), { kind: 'edits', edits, reason: 'private-raw-answer' }, 'decision_conflict'],
    [edit('plan'), { ...proposal, reason: 'private-raw-answer' }, 'kind'],
    [create('describe', 'Who submits?'), { kind: 'describe', topic: 'submitter' }, 'kind'],
    [create('prose', 'Write it.'), 'private-raw-answer, not an object', 'not_json'],
  ] as const;
  for (const [request, reply, problem] of cases) {
    fake.replyText(typeof reply === 'string' ? reply : JSON.stringify(reply));
    const result = await call(assistant, request);
    expect(result).toMatchObject(unusable(problem));
    expect(JSON.stringify(result.body)).not.toContain('private-raw-answer');
  }
  expect(fake.seen.hostRequests).toHaveLength(cases.length);
});

it('says an answer was empty, or cut off at the output limit, without retry', async () => {
  const { fake, call } = await setup();
  fake.replyText('');
  expect(await call(assistant, create('empty', 'Write it.'))).toMatchObject(unusable('empty'));
  fake.replyText('  \n');
  expect(await call(assistant, create('blank', 'Write it.'))).toMatchObject(unusable('empty'));
  // Stopped at the limit: cut off, whether the text so far is empty or half a reply.
  const half = JSON.stringify(proposal).slice(0, 40);
  for (const [i, text] of ['', half].entries()) {
    fake.setResponses([fauxAssistantMessage(text, { stopReason: 'length' })]);
    expect(await call(assistant, create(`cut-${i}`, 'Write it.'))).toMatchObject(
      unusable('cut_off'),
    );
  }
  // A reply that is whole is used even when the model reports the limit.
  fake.setResponses([fauxAssistantMessage(JSON.stringify(proposal), { stopReason: 'length' })]);
  expect(await call(assistant, create('whole', 'Write it.'))).toMatchObject({
    status: 200,
    body: { reply: proposal },
  });
  expect(fake.seen.hostRequests).toHaveLength(5);
});

it('drops one surplus closing brace only when the answer ended normally', async () => {
  const { fake, call } = await setup();
  const surplus = `${JSON.stringify({ kind: 'plan', reason: proposal.reason, plan: proposal.plan })}}`;
  fake.setResponses([fauxAssistantMessage(surplus, { stopReason: 'stop' })]);
  expect(await call(assistant, create('surplus-stop', 'Write a notice.'))).toEqual({
    status: 200,
    body: { reply: proposal, model: 'Test A' },
  });
  fake.setResponses([fauxAssistantMessage(surplus, { stopReason: 'length' })]);
  expect(await call(assistant, create('surplus-length', 'Write a notice.'))).toMatchObject(
    unusable('cut_off'),
  );
  expect(fake.seen.hostRequests).toHaveLength(2);
});

it('closes a new team’s answer one outer brace short only when it ended normally', async () => {
  const { fake, call } = await setup();
  const short = JSON.stringify({
    kind: 'plan',
    reason: proposal.reason,
    plan: proposal.plan,
  }).slice(0, -1);
  fake.setResponses([fauxAssistantMessage(short, { stopReason: 'stop' })]);
  expect(await call(assistant, create('short-stop', 'Write a notice.'))).toEqual({
    status: 200,
    body: { reply: proposal, model: 'Test A' },
  });
  // Stopped at the output limit: cut off, never closed.
  fake.setResponses([fauxAssistantMessage(short, { stopReason: 'length' })]);
  expect(await call(assistant, create('short-length', 'Write a notice.'))).toMatchObject(
    unusable('cut_off'),
  );
  // An edit's answer is never closed.
  const edits = JSON.stringify({ kind: 'edits', edits: [required], reason: 'Gate it.' });
  fake.setResponses([fauxAssistantMessage(edits.slice(0, -1), { stopReason: 'stop' })]);
  expect(await call(assistant, edit('short-edit'))).toMatchObject(unusable('not_json'));
  expect(fake.seen.hostRequests).toHaveLength(3);
});

it('respects the structured opinion-only decision even when the model requests a valid review gate', async () => {
  const { fake, call } = await setup();
  const request = edit('opinion');
  const reply = { kind: 'edits', edits: [required], reason: 'Gate submission.' };
  fake.replyText(JSON.stringify(reply));
  expect(await call(assistant, { ...request, decisions: { reviewPolicy: 'required' } })).toEqual({
    status: 200,
    body: { reply, model: 'Test A' },
  });
  fake.replyText(JSON.stringify(reply));
  const opinion = await call(assistant, {
    ...request,
    operationId: 'opinion-only',
    decisions: { reviewPolicy: 'opinion_only' },
  });
  expect(opinion).toMatchObject({
    status: 200,
    body: { reply: { kind: 'edits', edits: [{ kind: 'add_shared_advice' }] } },
  });
  expect(fake.seen.hostRequests).toHaveLength(2);
  const requestText = fake.seen.hostRequests[1]?.text;
  if (!requestText) throw new Error('Missing second request');
  const sent = JSON.parse(requestText) as { role: string; content: unknown }[];
  const payload = sent.find(({ role }) => role === 'user')?.content;
  expect(JSON.stringify(payload)).toContain('opinion_only');
});

it('coalesces identical sends and replays persisted outcomes, but refuses changed messages', async () => {
  const { fake, call, dbPath } = await setup();
  const request = create('repeat', 'Write a notice.');
  fake.replyText(JSON.stringify(proposal));
  const expected = { status: 200, body: { reply: proposal, model: 'Test A' } };
  const pair = await Promise.all([call(assistant, request), call(assistant, request)]);
  expect(pair).toEqual([expected, expected]);
  const reordered = {
    catalog: { skills: catalog.skills, agents: catalog.agents },
    messages: request.messages,
    mode: request.mode,
    operationId: request.operationId,
  };
  expect(await call(assistant, reordered)).toEqual(expected);
  expect(await call(assistant, create('repeat', 'Translate a notice.'))).toMatchObject({
    status: 409,
    body: { error: { code: 'REVISION_CONFLICT' } },
  });
  // Simulate an interrupted prior process: admission is durable but its outcome is not.
  const db = new DatabaseSync(dbPath);
  try {
    const reset = db.prepare('UPDATE model_operations SET result_json=NULL WHERE operation_id=?');
    expect(reset.run(request.operationId).changes).toBe(1);
  } finally {
    db.close();
  }
  expect(await call(assistant, request)).toMatchObject({
    status: 409,
    body: { error: { code: 'REQUEST_OUTCOME_UNKNOWN' } },
  });
  expect(fake.seen.hostRequests).toHaveLength(1);
});

it('aborts the actual model stream on disconnect and does not resend on replay', async () => {
  const { fake, call } = await setup({ tokensPerSecond: 1 });
  const request = create('closed', 'Write a notice.');
  fake.replyText(JSON.stringify(proposal));
  const stream = vi.spyOn(fake.live.models, 'streamSimple');
  const controller = new AbortController();
  const pending = call(assistant, request, controller.signal).catch(() => null);
  try {
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
    const signal = stream.mock.calls[0]?.[2]?.signal;
    expect(signal?.aborted).toBe(false);
    controller.abort();
    await pending;
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(await call(assistant, request)).toMatchObject({
      status: 409,
      body: { error: { code: 'REQUEST_OUTCOME_UNKNOWN' } },
    });
    expect(stream).toHaveBeenCalledTimes(1);
  } finally {
    controller.abort();
    stream.mockRestore();
  }
});

it.each([
  { live: false, status: 501, code: 'COMMAND_NOT_SUPPORTED' },
  { signedIn: false, status: 403, code: 'CAPABILITY_DENIED' },
])(
  'refuses without a usable model before any request ($status)',
  async ({ status, code, ...options }) => {
    const { fake, call } = await setup(options);
    expect(await call(assistant, create('offline', 'Write a notice.'))).toMatchObject({
      status,
      body: { error: { code } },
    });
    expect(fake.seen.hostRequests).toHaveLength(0);
  },
);

it('refuses an invalid edit summary before contacting the model', async () => {
  const { fake, call } = await setup();
  const request = edit('private');
  const result = await call(assistant, {
    ...request,
    team: { ...request.team, roleInstructions: 'private-role-instructions' },
  });
  expect(result).toMatchObject({ status: 400, body: { error: { code: 'SCHEMA_INVALID' } } });
  expect(JSON.stringify(result.body)).not.toContain('private-role-instructions');
  expect(fake.seen.hostRequests).toHaveLength(0);
});
