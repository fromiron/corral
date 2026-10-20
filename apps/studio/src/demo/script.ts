import type { AgentStartInput, DeliveredDirective, RequestPermit } from '@corral/contracts';

// Simulated replies for the demo team (C-063). They are fixed text, marked as simulated, and
// built only from what the runtime handed the execution: its inputs, its assignment, the
// collaboration results (notes) and the directives delivered to its requests. A directive
// shows up from the request it was delivered in onward, never before (Spec §8.2).

/** Model requests per simulated execution; the last one carries the submitted text. */
export const DEMO_TURNS = 2;

export type DemoReply = (
  turn: number,
  input: AgentStartInput,
  permit: RequestPermit,
  notes: readonly string[],
) => string;

const TEAM_ROLES = new Set(['researcher', 'helper', 'writer', 'reviewer']);
const SESSION_PLAN_ROLES = new Set(['worker', 'planner']);

export function createDemoReply(): DemoReply {
  // Directives already delivered to each execution stay in its later requests' context.
  const delivered = new Map<string, DeliveredDirective[]>();
  return (turn, input, permit, notes) => {
    const directives = [...(delivered.get(input.executionId) ?? []), ...permit.directives];
    delivered.set(input.executionId, directives);
    // A responder answers in its one request (ScriptedAgentAdapter); others use DEMO_TURNS.
    const last = input.assignment.kind === 'question' ? 1 : DEMO_TURNS;
    const header = `> Simulated ${input.role.name} reply, request ${turn} of ${last}. No model was called.`;
    const body =
      turn < last
        ? progress(input)
        : TEAM_ROLES.has(input.role.id) || input.assignment.kind === 'question'
          ? final(input, notes)
          : workerAnswer(input);
    return [header, instructions(directives), body].filter(Boolean).join('\n\n');
  };
}

function instructions(directives: readonly DeliveredDirective[]): string {
  if (directives.length === 0) return '';
  return [
    '**Following your instructions**',
    ...directives.map((d) => `- “${d.text}” (${d.directiveId})`),
  ].join('\n');
}

const START_FROM = '\n\nStart from this earlier version:\n';

/** A short greeting stays plan-free. This phrase asks the demo to publish a real checklist. */
const DEMO_PLAN_MARK = '단계별';

const DEMO_PLAN_TITLES = [
  '예시 · 관련 코드 확인',
  '예시 · 변경 계획 작성',
  '예시 · 채팅 레이아웃 수정',
  '예시 · 회귀 테스트',
  '예시 · 결과 정리',
  '예시 · 화면 확인',
  '예시 · 기록 남기기',
] as const;
const DEMO_PLAN_STEPS = [0, 1, 2, 3, 4, 5, 6, 7] as const;

export function demoPlansFor(input: AgentStartInput): boolean {
  if (!SESSION_PLAN_ROLES.has(input.role.id)) return false;
  if (!input.role.allowedCollaborationTools.includes('update_plan')) return false;
  const raw = input.inputs.find((item) => item.name === 'brief')?.text ?? '';
  const at = raw.indexOf(START_FROM);
  const request = (at === -1 ? raw : raw.slice(0, at)).trim();
  return request.includes(DEMO_PLAN_MARK);
}

/** Step 0 is 0/7 with the first item in progress; later steps complete that many items. */
export function demoPlanUpdate(step: (typeof DEMO_PLAN_STEPS)[number], criteriaVersionId: string) {
  return {
    scope: 'execution' as const,
    expectedRevision: step,
    criteriaVersionId,
    items: DEMO_PLAN_TITLES.map((title, index) => ({
      id: `step_${index + 1}`,
      title,
      status:
        index < step
          ? ('completed' as const)
          : index === step
            ? ('in_progress' as const)
            : ('pending' as const),
    })),
  };
}

/** Publishes the checklist through the host. A failed update stops the sequence and leaves the reply path alone. */
export async function publishDemoPlan(
  input: AgentStartInput,
  host: {
    invokeTool(call: {
      name: 'update_plan';
      args: ReturnType<typeof demoPlanUpdate>;
    }): Promise<{ ok: boolean }>;
  },
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  stepDelayMs = 400,
): Promise<void> {
  for (const step of DEMO_PLAN_STEPS) {
    const updated = await host.invokeTool({
      name: 'update_plan',
      args: demoPlanUpdate(step, input.criteriaVersionId),
    });
    if (!updated.ok) return;
    if (step < DEMO_PLAN_TITLES.length) await wait(stepDelayMs);
  }
}

/** The person's own request. A later run's brief also carries the prior artifact (CR-007); that tail stays model input and is not the answer. */
function workerAnswer(input: AgentStartInput): string {
  const raw = input.inputs.find((i) => i.name === 'brief')?.text ?? '';
  const at = raw.indexOf(START_FROM);
  const request = (at === -1 ? raw : raw.slice(0, at)).trim();
  return request || 'No request text was given.';
}

const brief = (input: AgentStartInput) => workerAnswer(input);

const versionOf = (input: AgentStartInput, name: string) =>
  input.inputs.find((i) => i.name === name)?.artifactVersionId ?? null;

function progress(input: AgentStartInput): string {
  const read = input.inputs.map((i) =>
    i.artifactVersionId ? `${i.name}@${i.artifactVersionId}` : i.name,
  );
  return `Reading ${read.join(', ') || 'the assignment'} and planning the answer.`;
}

function final(input: AgentStartInput, notes: readonly string[]): string {
  const { assignment } = input;
  if (assignment.kind === 'question') {
    return [
      `**Question:** “${assignment.body}”`,
      "The main claim rests on each project's official documentation. Cite it by name, and mark anything it does not confirm as an assumption.",
    ].join('\n\n');
  }
  if (assignment.kind === 'delegated') {
    return [
      `## Helper notes`,
      `Task: ${assignment.brief}`,
      [
        '- Source to cite: the official documentation of each option.',
        '- Source to cite: each project’s published limits and release notes.',
        '- Gap: there is no benchmark for this team’s workload. The draft should say so.',
      ].join('\n'),
    ].join('\n\n');
  }
  switch (input.role.id) {
    case 'researcher':
      return researchNotes(input, notes);
    case 'writer':
      return draft(input, notes);
    default:
      return `Checked ${versionOf(input, 'draft') ?? 'the draft'} against the criteria.`;
  }
}

function researchNotes(input: AgentStartInput, notes: readonly string[]): string {
  const merged = notes.flatMap((n) => (n.startsWith('read ') ? [n.slice('read '.length)] : []));
  return [
    '## Research notes',
    `Brief: ${brief(input)}`,
    merged.length
      ? `Two helpers split the work. Their notes (${merged.join(', ')}) are merged below.`
      : 'No helper notes were available, so these notes cover the brief alone.',
    [
      '- Part 1: setup, day-to-day operations and cost.',
      '- Part 2: concurrent writes, data size and known limits.',
      '- Cite: the official documentation of each option, and its published limits.',
    ].join('\n'),
  ].join('\n\n');
}

function draft(input: AgentStartInput, notes: readonly string[]): string {
  const round = input.round ?? 1;
  const answer = notes.flatMap((n) =>
    n.startsWith('answer: ') ? [n.slice('answer: '.length)] : [],
  );
  const review = versionOf(input, 'review');
  const sources = [
    `- Research notes ${versionOf(input, 'notes') ?? ''}`.trimEnd(),
    ...(round > 1 ? ['- Official documentation of each option, cited for the main claim.'] : []),
  ];
  const sections = [
    `# Draft ${round}`,
    `**Brief:** ${input.inputs.find((i) => i.name === 'notes') ? briefFromNotes(input) : brief(input)}`,
    '## Recommendation',
    'Start with the simpler option while one service writes to the data, and move to the server database when several services need to write at once.',
    '## Strengths and limits',
    [
      '- **Embedded database:** no server to run and a single file to back up. Limit: one writer at a time.',
      '- **Server database:** many concurrent writers, roles and replication. Limit: a service to operate and upgrade.',
    ].join('\n'),
    '## Sources',
    sources.join('\n'),
  ];
  if (answer.length) {
    sections.push(
      '## What the Source Responder said',
      answer.map((a) => `> ${firstLine(a)}`).join('\n'),
    );
  }
  if (review) {
    sections.push(
      '## Changes since the last draft',
      `- Named the source behind the main claim, as review ${review} asked.`,
    );
  }
  return sections.join('\n\n');
}

function briefFromNotes(input: AgentStartInput): string {
  const notes = input.inputs.find((i) => i.name === 'notes')?.text ?? '';
  return /^Brief: (.+)$/m.exec(notes)?.[1] ?? 'see the research notes';
}

/** The answer's own text, without the simulated-reply header. */
function firstLine(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('>') && !line.startsWith('**Question:**'));
  return lines[0] ?? text;
}
