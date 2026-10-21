import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CorralDefinition,
  type EvalGroup,
  type HarnessResource,
  type VerificationReport,
} from '@corral/contracts';
import { InProcessTransport, reviewCriteriaHash } from '@corral/core';
import { startCorralServer } from '@corral/server';
import {
  type FauxResponseStep,
  fakeOpenAI,
  fauxAssistantMessage,
  fauxToolCall,
} from '@corral/server/testing';
import { linearCorral, ScriptedAgentAdapter } from '@corral/testkit';
import template from '../../../../examples/eval/research-team-headless.corral.json' with {
  type: 'json',
};
import { type EvalSuite, runSuite } from '../../src/exec.ts';

const groups: EvalGroup[] = [
  'baseline',
  'mandatory_skill',
  'deterministic_check',
  'review_repair',
  'coding_tool',
];
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const criteria = [
  'Return only JSON with the arithmetic answer for the requested case.',
  'Save the same answer and case in answer.txt.',
];
const allowed = [
  'read_file',
  'write_file',
  'read',
  'edit',
  'write_artifact',
  'submit_result',
  'run_check',
];
const marker = 'MANDATORY-ARITHMETIC-FIXTURE';

function definitions() {
  return groups.map((group) => {
    const definition =
      group === 'review_repair' ? CorralDefinition.parse(template) : linearCorral(['writer']);
    definition.id = `fixture_${group}`;
    definition.name = group;
    definition.input = { brief: 'set by suite', criteria };
    definition.limits = {
      ...definition.limits,
      maxModelCalls: 40,
      maxOutputTokens: 32000,
      maxOutputTokensPerCall: 2048,
      modelTimeoutMs: 15000,
      runDeadlineMs: 60000,
    };
    if (group === 'review_repair') {
      definition.roles = definition.roles.filter((role) =>
        ['researcher', 'writer', 'reviewer'].includes(role.id),
      );
      definition.nodes = definition.nodes.filter((node) =>
        ['research', 'review_loop', 'write', 'review', 'review_decision', 'output'].includes(
          node.id,
        ),
      );
      definition.capabilityLinks = [];
      const writer = definition.nodes.find((node) => node.id === 'write');
      assert(writer?.type === 'agent');
      writer.inputBindings = [
        { kind: 'run_input', name: 'brief' },
        { kind: 'run_input', name: 'criteria' },
        { kind: 'previous_iteration_output', name: 'draft', sourceNodeId: 'write', optional: true },
      ];
      const loop = definition.nodes.find((node) => node.type === 'loop');
      assert(loop?.type === 'loop');
      loop.reviewRecipe = {
        recipeId: 'fixture-review',
        revision: 1,
        criteriaHash: reviewCriteriaHash(criteria),
        candidateNodeId: 'write',
        evaluatorRoleId: 'reviewer',
        checkIds: ['answer'],
        criteriaFiles: [],
        maxAttempts: 2,
        maxRepairs: 1,
        maxWallMs: 60000,
        maxModelCalls: 40,
        maxOutputTokens: 32000,
      };
    }
    for (const role of definition.roles) {
      role.modelProfile = 'model-b';
      role.harness = { profileId: group, revision: 1 };
      role.allowedWorkTools =
        role.id === 'writer' || role.id === 'writer_role'
          ? ['read_file', 'write_file', 'write_artifact']
          : ['write_artifact'];
      role.allowedCollaborationTools = ['submit_result'];
    }
    return { id: group, group, corral: `${group}.json`, definition };
  });
}

/** Actual SDK/broker/check/recipe paths; answers are deterministic fixtures, not LLM quality evidence. */
export async function runHarnessComparison() {
  const root = mkdtempSync(join(tmpdir(), 'corral-harness-comparison-'));
  const repository = join(root, 'project'),
    config = join(root, 'config'),
    workspace = join(root, 'workspace');
  mkdirSync(repository);
  mkdirSync(join(workspace, '.corral'), { recursive: true });
  writeFileSync(
    join(workspace, '.corral', 'config.json'),
    JSON.stringify({
      schemaVersion: '0.1',
      modelProfiles: [{ id: 'model-b', provider: 'openai', model: 'gpt-test-b' }],
    }),
  );
  writeFileSync(join(repository, 'answer.txt'), 'seed\n');
  writeFileSync(
    join(repository, 'problems.json'),
    JSON.stringify({ calibration: [2, 2], holdout: [3, 4] }) + '\n',
  );
  writeFileSync(
    join(repository, 'check.mjs'),
    `import assert from 'node:assert/strict';import{readFileSync}from'node:fs';const answer=JSON.parse(readFileSync('answer.txt','utf8'));const values=JSON.parse(readFileSync('problems.json','utf8'))[answer.case];assert(Array.isArray(values));assert.equal(answer.answer,values[0]+values[1]);console.log('CHECK_OK');\n`,
  );
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
      {
        cwd: repository,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2026-10-17T00:00:00Z',
          GIT_COMMITTER_DATE: '2026-10-17T00:00:00Z',
        },
      },
    ).trim();
  git('init', '-q');
  // Keep source bytes identical across Windows/POSIX managed worktrees.
  git('config', 'core.autocrlf', 'false');
  git('add', '.');
  git('commit', '-qm', 'personal harness fixture');
  const baseCommit = git('rev-parse', 'HEAD');
  const fake = fakeOpenAI({ configDir: config, env: { OPENAI_API_KEY: 'fixture-key-never-real' } });
  const server = await startCorralServer({
    workspace,
    worktreeRoot: join(root, 'copies'),
    agents: new ScriptedAgentAdapter({ turns: 1 }),
    live: fake.live,
  });
  const evidence = {
    mandatorySkillObserved: 0,
    completedChecks: 0,
    files: [] as { variant: string; brief: string; hash: string; verdicts: string[] }[],
  };
  try {
    const session = await fetch(`${server.url}/api/v1/session`, {
      method: 'POST',
      headers: { origin: server.url, 'content-type': 'application/json' },
      body: JSON.stringify({ token: server.bootstrapUrl.split('bootstrap=')[1] }),
    });
    assert(session.ok);
    const headers = {
      origin: server.url,
      'content-type': 'application/json',
      cookie: (session.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
      'x-corral-csrf': session.headers.get('x-corral-csrf') ?? '',
    };
    async function api<T = unknown>(
      path: string,
      body?: unknown,
      method = body ? 'POST' : 'GET',
    ): Promise<T> {
      const response = await fetch(`${server.url}/api/v1${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert(response.ok, `fixture API ${path.split('?')[0]} returned ${response.status}`);
      return response.json() as Promise<T>;
    }
    await api('/projects/default/workspace', { path: repository }, 'PUT');
    await api('/projects/default/workspace', { trusted: true }, 'PATCH');
    await api(
      '/harness/projects/default/tools',
      {
        expectedRevision: 0,
        config: {
          checks: [
            { id: 'answer', name: 'Answer check', argv: ['node', 'check.mjs'], timeoutMs: 5000 },
          ],
          lspServers: [],
        },
      },
      'PUT',
    );
    const launch = await api<{ fingerprint: string }>(
      '/harness/projects/default/checks/answer/launch',
    );
    await api(
      '/harness/projects/default/checks/answer/trust',
      { fingerprint: launch.fingerprint, trusted: true },
      'PUT',
    );
    const skill = join(root, 'skill');
    mkdirSync(join(skill, 'skills', 'arithmetic'), { recursive: true });
    writeFileSync(
      join(skill, 'package.json'),
      JSON.stringify({
        name: 'fixture-arithmetic',
        version: '1.0.0',
        license: 'MIT',
        pi: { skills: ['./skills'] },
      }),
    );
    writeFileSync(
      join(skill, 'skills/arithmetic/SKILL.md'),
      `---\nname: arithmetic\ndescription: Fixture arithmetic rule.\n---\n${marker}\nCheck both operands before submitting.\n`,
    );
    const review = await api<{ reviewId: string; resource: HarnessResource }>('/harness/reviews', {
      kind: 'local',
      source: skill,
    });
    await api('/harness/resources', { reviewId: review.reviewId });
    await api(`/harness/resources/${review.resource.hash}/trust`, { trusted: true }, 'PUT');
    for (const group of groups)
      await api(
        `/harness/profiles/${group}`,
        {
          expectedRevision: 0,
          profile: {
            name: group,
            policy: 'strict',
            allowedTools: allowed,
            resources:
              group === 'mandatory_skill'
                ? [
                    {
                      kind: 'skill',
                      resourceHash: review.resource.hash,
                      entry: 'skills/arithmetic/SKILL.md',
                      required: true,
                      skillMode: 'mandatory',
                    },
                  ]
                : [],
            startupCommands: [],
            ...(['deterministic_check', 'review_repair'].includes(group)
              ? { checkIds: ['answer'] }
              : {}),
          },
        },
        'PUT',
      );
    const suite: EvalSuite = {
      comparison: 'personal_harness',
      workspace: { projectId: 'default', baseCommit },
      briefs: [
        {
          id: 'calibration',
          phase: 'calibration',
          brief:
            'Case calibration. Add 2 and 2. Save the case and answer in answer.txt and return only JSON with answer.',
          expected: { kind: 'json', value: { answer: 4 } },
        },
        {
          id: 'holdout',
          phase: 'holdout',
          brief:
            'Case holdout. Add 3 and 4. Save the case and answer in answer.txt and return only JSON with answer.',
          expected: { kind: 'json', value: { answer: 7 } },
        },
      ],
      variants: definitions(),
    };
    const transport = new InProcessTransport(server.coordinator),
      start = transport.startRun.bind(transport);
    transport.startRun = async (request) => {
      assert('definition' in request, 'fixture runs require an inline definition');
      const group = request.definition.id.replace('fixture_', '') as EvalGroup;
      const operands = /Add (\d+) and (\d+)/.exec(request.definition.input.brief);
      assert(operands);
      const correct = Number(operands[1]) + Number(operands[2]);
      const caseId = request.definition.input.brief.includes('Case calibration.')
        ? 'calibration'
        : 'holdout';
      const respond: FauxResponseStep = (context) => {
        const text = context.messages
          .filter((message) => message.role === 'system')
          .map((message) => Object.values(message.sections ?? {}).join('\n'))
          .join('\n');
        const all = JSON.stringify(context.messages);
        const results = context.messages.filter((message) => message.role === 'toolResult');
        assert(
          results.every((result) => !result.isError),
          'fixture tool returned an error',
        );
        const isReviewer = text.includes('JSON review object and nothing else');
        const planner = text.includes('Act as the Researcher.');
        const firstRound = all.includes('This is round 1 of a review loop.');
        const answer = group === 'review_repair' && firstRound ? correct + 1 : correct;
        if (group === 'mandatory_skill' && !results.length) {
          assert(text.includes(marker));
          evidence.mandatorySkillObserved++;
        }
        if (group !== 'mandatory_skill') assert(!text.includes(marker));
        const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
          fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
        if (isReviewer || planner) {
          if (!results.length) {
            let output = 'Fixture plan: add both operands.';
            if (isReviewer) {
              const target = /"targetArtifactVersionId": "([^"]+)"/.exec(text)?.[1],
                criteriaVersion = /"criteriaVersionId": "([^"]+)"/.exec(text)?.[1];
              assert(target && criteriaVersion);
              output = JSON.stringify({
                targetArtifactVersionId: target,
                criteriaVersionId: criteriaVersion,
                verdict: firstRound ? 'revise' : 'pass',
                issues: firstRound
                  ? [
                      {
                        criterionId: 'c1',
                        reason: 'The arithmetic result needs correction.',
                        severity: 'required',
                        evidenceRefs: [],
                      },
                    ]
                  : [],
                evidenceRefs: [],
              });
            }
            return tool('write_artifact', { text: output });
          }
        } else {
          if (!results.length)
            return tool(group === 'coding_tool' ? 'read' : 'read_file', { path: 'answer.txt' });
          if (results.length === 1)
            return group === 'coding_tool'
              ? tool('edit', {
                  path: 'answer.txt',
                  edits: [{ oldText: 'seed', newText: JSON.stringify({ case: caseId, answer }) }],
                })
              : tool('write_file', {
                  path: 'answer.txt',
                  text: JSON.stringify({ case: caseId, answer }) + '\n',
                });
          if (group === 'deterministic_check' && results.length === 2)
            return tool('run_check', { commandId: 'answer' });
          if (!results.some((result) => result.toolName === 'write_artifact'))
            return tool('write_artifact', { text: JSON.stringify({ answer }) });
        }
        if (!results.some((result) => result.toolName === 'submit_result')) {
          const written = results.find((result) => result.toolName === 'write_artifact');
          const id = JSON.stringify(written).match(/artv_[a-f0-9]{32}/)?.[0];
          assert(id);
          return tool('submit_result', { artifactVersionIds: [id] });
        }
        return fauxAssistantMessage('Done.');
      };
      fake.setResponses(Array.from({ length: 40 }, () => respond));
      return start(request);
    };
    const report = await runSuite(transport, suite, 'live', {
      signal: AbortSignal.timeout(60000),
      prepareWorkspace: (target) => server.prepareEvaluation(target),
    });
    for (const row of report.results) {
      assert.equal(row.status, 'succeeded', `${row.group}/${row.brief}: ${row.reason}`);
      assert(row.workspace);
      const file = await api<{ content: { kind: string; text: string } }>(
        `/sessions/${row.workspace.sessionId}/worktree/file?path=answer.txt`,
      );
      assert.equal(file.content.kind, 'text');
      const value = JSON.parse(file.content.text);
      assert.equal(value.answer, row.brief === 'calibration' ? 4 : 7);
      const checks = await api<{ report?: VerificationReport }[]>(
        `/sessions/${row.workspace.sessionId}/verifications`,
      );
      evidence.completedChecks += checks.filter(
        (check) => check.report?.state === 'completed',
      ).length;
      evidence.files.push({
        variant: row.variant,
        brief: row.brief,
        hash: sha(file.content.text),
        verdicts: checks.flatMap((check) => (check.report ? [check.report.verdict] : [])),
      });
    }
    return { kind: 'local_sdk_fixture' as const, baseCommit, report, evidence };
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}
