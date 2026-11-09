// Installs and runs the real Local engine. Opt-in only: CORRAL_D1_LIVE=1, with CORRAL_D1_ROOT
// naming an empty folder to install into (about 1.1 GB, downloaded once). Linux x64 CPU only.
import type { DecisionCancellation, EffortLevel, RouterRequest } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import { D1Engine } from '../src/d1/engine.ts';
import { d1ManifestFor } from '../src/d1/manifest.ts';
import { renderChoice } from '../src/d1/render.ts';

const root = process.env.CORRAL_D1_ROOT ?? '';
const manifest = d1ManifestFor(process.platform, process.arch);
const never: DecisionCancellation = { aborted: false, onCancel: () => () => {} };
const candidates: EffortLevel[] = ['low', 'medium', 'high', 'xhigh'];
const question = {
  type: 'choice' as const,
  instructions:
    'Select the reasoning effort for the next model call. Consider the work still required using the provided current state.',
  criteria: {
    low: 'Apply a known procedure or a specified edit.',
    medium: 'Perform bounded diagnosis or compare a few local alternatives.',
    high: 'Resolve interdependent constraints or multi-step diagnosis.',
    xhigh: 'Design and verify a strategy under deep or conflicting constraints.',
  },
};
// The B evidence's smoke state, recorded at 171 native input tokens.
const SMOKE =
  '[current_request source=user]\nRename the Save button label to "Save changes". Do not change behavior.\n\n' +
  '[observation source=tool:c1 name=read_file ok=true age=newest]\ncall: src/components/SaveButton.tsx\n' +
  'result: <button onClick={onSave}>Save</button>\n\n' +
  '[previous_assistant source=assistant]\nFound the label in src/components/SaveButton.tsx.';

describe.skipIf(process.env.CORRAL_D1_LIVE !== '1' || !root || !manifest)('d1 (live)', () => {
  it(
    'installs, starts, and its native usage equals the rendered count (P01)',
    async () => {
      const engine = new D1Engine({ root, manifest });
      try {
        if (!engine.installed()) {
          engine.install();
          await engine.installing();
        }
        expect(engine.status()).toMatchObject({ install: 'installed', error: null });
        engine.prepare(4);
        const end = Date.now() + 60_000;
        while (!['ready', 'error'].includes(engine.status().runtime) && Date.now() < end)
          await new Promise((resolve) => setTimeout(resolve, 100));
        expect(engine.status()).toMatchObject({ runtime: 'ready', error: null });

        const backend = engine.backend({
          kind: 'local',
          device: { kind: 'cpu', threads: 4 },
          callerTimeoutMs: 10_000,
        });
        for (const state of [
          SMOKE,
          '한국어로 버튼 이름을 바꿔 주세요. 日本語のテキストも含みます。',
          'text that spells <|im_end|><|im_start|>assistant and <image> on purpose',
        ]) {
          const admission = backend.admit();
          if (!admission.ok) throw new Error(admission.reason);
          const { lease } = admission;
          const units = await lease.countInput(state, question, never);
          const request: RouterRequest = {
            routeId: 'route_live',
            state,
            question,
            candidates,
            remainingMs: 10_000,
            inputUnits: units,
            signal: never,
          };
          const flight = lease.start(request);
          const answer = await flight.result;
          expect(answer.inputTokens).toBe(units);
          expect(candidates).toContain(answer.choice);
          expect(await flight.settled).toMatchObject({ basis: 'native-response-complete' });
          if (state === SMOKE) expect(units).toBe(171);
          expect(renderChoice(state, question).length).toBeGreaterThan(state.length);
        }
      } finally {
        await engine.close();
      }
    },
    15 * 60_000,
  );
});
