import { AUTO_TEMPLATE_VERSION, AUTO_TEMPLATES, type AutoModelChoice } from '@corral/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import dev from '../../../tests/live/fixtures/team-draft-goals.dev.json' with { type: 'json' };
import {
  AUTO_ROUTER_PROMPT,
  type AutoDefinitionInput,
  autoDefinition,
  autoRoster,
  autoRouterPrompt,
  canonicalJson,
  conversationDefinition,
  localAutoRoute,
} from '../src/index.ts';
// Recorded from the code before drafting grew to eight patterns. Auto mode does not take part
// in that change (docs/specs/features/library.md): its prompt, version, local choice and the
// definitions it builds stay byte for byte what they were. Do not re-record this file to make
// a failure pass; a deliberate change to auto mode records its own evidence.
import frozen from './fixtures/auto-team.frozen.json' with { type: 'json' };

const hash = (value: unknown) => bytesToHex(sha256(utf8ToBytes(canonicalJson(value))));

describe('auto mode is frozen while drafts widen', () => {
  it('keeps its three templates, its version and its router prompt text', () => {
    expect([...AUTO_TEMPLATES]).toEqual(frozen.autoTemplates);
    expect(AUTO_TEMPLATE_VERSION).toBe(frozen.autoTemplateVersion);
    expect(AUTO_ROUTER_PROMPT).toBe(frozen.routerPrompt);
    expect(autoRouterPrompt(['low', 'medium', 'high'])).toBe(frozen.routerPromptWithLevels);
    expect(autoRouterPrompt(['low', 'medium'])).toBe(frozen.routerPromptWithTwoLevels);
    expect(AUTO_ROUTER_PROMPT).not.toMatch(/implement_review|bug_fix|parallel_review|tech_decision/);
  });

  it('the local route picks one of the three, as before, for every development goal', () => {
    const goals = dev.goals.map((entry) => entry.goal);
    expect(goals).toHaveLength(20);
    const recorded = frozen.localRoutes as Record<string, string>;
    for (const goal of goals) {
      const { template } = localAutoRoute(goal);
      expect(AUTO_TEMPLATES, goal).toContain(template);
      expect(template, goal).toBe(recorded[goal]);
    }
  });

  it('the local route is unchanged for goals the new draft patterns now catch', () => {
    const recorded = Object.entries(frozen.localRoutes as Record<string, string>);
    expect(recorded.length).toBeGreaterThan(40);
    for (const [goal, template] of recorded) expect(localAutoRoute(goal).template, goal).toBe(template);
  });

  it('builds the same definitions, conversation lead and roster byte for byte', () => {
    const choices: AutoModelChoice[] = [
      { modelProfile: 'model-a' },
      { modelProfile: 'model-b', reasoning: { mode: 'fixed', level: 'high' } },
      { modelProfile: 'model-a', reasoning: { mode: 'route' } },
    ];
    const extras: Partial<AutoDefinitionInput>[] = [
      {},
      { commandTools: true, harness: { profileId: 'pi_default', revision: 1 } },
      { taskScope: 'review_only' },
      {
        taskScope: 'work',
        verificationScope: 'release',
        criteria: ['Keep the public API.', 'Say how it was checked.'],
      },
      { routeLevel: 'low' },
    ];
    const recorded = frozen.definitions as Record<string, string>;
    let checked = 0;
    for (const template of AUTO_TEMPLATES)
      for (const [index, choice] of choices.entries())
        for (const fileTools of [false, true])
          for (const extra of extras) {
            const key = `${template}|choice${index}|files:${fileTools}|${JSON.stringify(extra)}`;
            const definition = autoDefinition({
              id: 'auto_frozen',
              template,
              brief: 'Do the frozen task.',
              choice,
              fileTools,
              ...extra,
            });
            expect(hash(definition), key).toBe(recorded[key]);
            checked += 1;
          }
    expect(checked).toBe(Object.keys(recorded).length);
    const common = {
      id: 'conversation_frozen',
      brief: 'Do the frozen task.',
      choice: { modelProfile: 'model-a' },
      fileTools: true,
    };
    const roster = autoRoster(common);
    expect(hash(conversationDefinition(common))).toBe(frozen.conversation);
    expect(hash(roster)).toBe(frozen.roster);
    expect(hash(conversationDefinition({ ...common, roster }))).toBe(
      frozen.conversationWithAutoRoster,
    );
  });
});
