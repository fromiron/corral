import { type AssistantMessage, Type } from '@earendil-works/pi-ai';
import type { StartFrame, WorkerTool } from './protocol.ts';

export const TOOL_TEXT: Record<WorkerTool, string> = {
  search:
    'Search registered documents, or explicitly choose Brave for an enabled live run. Returns registered source references.',
  read_document:
    'Read a registered documentId or sourceId. Raw URLs and filesystem paths are not accepted.',
  write_artifact:
    'Save your output text as a new immutable version. Returns its artifactVersionId.',
  list_files:
    'List files of the working copy under a relative folder (default: the root). Returns paths and sizes.',
  read_file:
    'Read a UTF-8 text file of the working copy by relative path. Read a file before changing it.',
  write_file:
    'Create or replace a UTF-8 text file by relative path. An existing file must be read first; if it changed since, the write is refused.',
  delete_file: 'Delete a file you have read, by relative path.',
  move_file: 'Move or rename a file you have read, from one relative path to another.',
  submit_result: 'Submit the versions that complete your task. Call it once, after write_artifact.',
  spawn_subagents:
    'Start callable agents on separate tasks, in parallel. Returns their taskIds; then call await_tasks.',
  await_tasks:
    'Wait until the given tasks you started finish. Returns each status and the versions it submitted.',
  ask: 'Ask a callable agent a question and wait for its answer (or a timeout).',
  reply: 'Answer the question you were given. Call it once; your task ends with the answer.',
  read_artifact: 'Read the text of an artifact version you are allowed to see.',
};

/** Parameters the model fills in; ids of the run, owner and question come from Corral. */
export function parametersOf(name: WorkerTool, start: Omit<StartFrame, 'protocolVersion'>) {
  const node = (targets: { nodeId: string }[]) =>
    Type.Union(targets.map((t) => Type.Literal(t.nodeId)));
  switch (name) {
    case 'search':
      return Type.Object({
        query: Type.String({ minLength: 1, maxLength: 1000 }),
        provider: Type.Optional(Type.Union([Type.Literal('corpus'), Type.Literal('brave')])),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      });
    case 'read_document':
      return Type.Union([
        Type.Object({ documentId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
        Type.Object({ sourceId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      ]);
    case 'write_artifact':
      return Type.Object({ text: Type.String() });
    case 'list_files':
      return Type.Object({ path: Type.Optional(Type.String({ maxLength: 500 })) });
    case 'read_file':
    case 'delete_file':
      return Type.Object({ path: Type.String({ minLength: 1, maxLength: 500 }) });
    case 'write_file':
      return Type.Object({
        path: Type.String({ minLength: 1, maxLength: 500 }),
        text: Type.String(),
      });
    case 'move_file':
      return Type.Object({
        from: Type.String({ minLength: 1, maxLength: 500 }),
        to: Type.String({ minLength: 1, maxLength: 500 }),
      });
    case 'submit_result':
      return Type.Object({ artifactVersionIds: Type.Array(Type.String(), { minItems: 1 }) });
    case 'spawn_subagents':
      return Type.Object({
        tasks: Type.Array(
          Type.Object({ targetNodeId: node(start.delegateTo), brief: Type.String() }),
          { minItems: 1, maxItems: 4 },
        ),
      });
    case 'await_tasks':
      return Type.Object({ taskIds: Type.Array(Type.String(), { minItems: 1 }) });
    case 'ask':
      return Type.Object({
        targetNodeId: node(start.askTo),
        body: Type.String(),
        artifactRefs: Type.Optional(Type.Array(Type.String())),
      });
    case 'reply':
      return Type.Object({
        body: Type.String(),
        evidenceRefs: Type.Optional(Type.Array(Type.String())),
      });
    case 'read_artifact':
      return Type.Object({ artifactVersionId: Type.String() });
  }
}

export function systemPrompt(start: Omit<StartFrame, 'protocolVersion'>): string {
  const names = (targets: { nodeId: string; label: string }[]) =>
    targets.map((t) => `${t.label} (${t.nodeId})`).join(', ');
  const lines = [
    start.role.prompt,
    '',
    `You are ${start.role.name}, one step of a Corral team. Your output contract is "${start.role.outputContract}".`,
  ];
  if (start.assignment.kind === 'delegated') {
    lines.push('Another agent delegated a task to you; it is given as "task" below.');
  }
  if (start.assignment.kind === 'question') {
    lines.push(
      'Another agent asked you the question given as "question" below. Answer it with reply.',
    );
  } else {
    lines.push(
      'When your work is complete, call write_artifact with the full output text, then call submit_result with the artifactVersionId it returned.',
    );
  }
  if (start.role.outputContract === 'review') {
    // Corral checks this exact shape; anything else counts as inconclusive, never as a pass.
    const target =
      start.inputs.find((i) => i.name === 'draft' && i.artifactVersionId) ??
      start.inputs.find((i) => i.artifactVersionId);
    lines.push(
      'Your output text must be a JSON review object and nothing else: ' +
        `{"targetArtifactVersionId": "${target?.artifactVersionId ?? '<the draft version>'}", ` +
        `"criteriaVersionId": "${start.criteriaVersionId}", "verdict": "pass" | "revise" | "inconclusive", ` +
        '"issues": [{"criterionId": "...", "reason": "...", "severity": "required" | "advisory", "evidenceRefs": []}], ' +
        '"evidenceRefs": []}. A revise verdict needs at least one issue.',
      // Ids the schema accepts, tied to the criteria text in the "criteria" input (#20).
      'For criterionId use c1 for the first criterion in the criteria input, c2 for the second, and so on; use "general" for an issue no criterion covers.',
    );
  }
  if (start.tools.includes('spawn_subagents')) {
    lines.push(
      `You may delegate tasks to: ${names(start.delegateTo)}. Use spawn_subagents, then await_tasks.`,
    );
  }
  if (start.tools.includes('ask')) lines.push(`You may ask: ${names(start.askTo)}. Use ask.`);
  lines.push(
    'Instructions from the person supervising this run may arrive during your work; follow them.',
  );
  return lines.join('\n');
}

export function userPrompt(start: Omit<StartFrame, 'protocolVersion'>): string {
  const round = start.round ? `This is round ${start.round} of a review loop.\n\n` : '';
  return (
    round +
    start.inputs
      .map((input) =>
        input.artifactVersionId
          ? `## ${input.name} (version ${input.artifactVersionId})\n\n${input.text}`
          : `## ${input.name}\n\n${input.text}`,
      )
      .join('\n\n')
  );
}

export function directiveText(directives: { directiveId: string; text: string }[]): string {
  return directives
    .map((d) => `Instruction from the person supervising this run (${d.directiveId}): ${d.text}`)
    .join('\n');
}

export function textOf(message: AssistantMessage): string {
  return message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

/** Provider errors can echo request details; keep a short message without credentials. */
export function safe(text: string): string {
  return text
    .replace(/(bearer\s+)[\w.-]+/gi, '$1[redacted]')
    .replace(/\b(sk|rt|eyJ)[\w.-]{8,}/g, '[redacted]')
    .slice(0, 300);
}
