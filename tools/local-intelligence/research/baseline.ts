// Evaluate the unchanged shipped classifiers on explicit frozen rows (no teacher calls).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { lowEffortNeedsReview } from '../../../packages/core/src/reasoning-risk.ts';
import {
  bundledEffortWeights,
  createLocalIntelligence,
  EFFORT_PREPROCESS_VERSION,
  loadEffortClassifier,
  MEETING_PREPROCESS_VERSION,
} from '../../../packages/local-intelligence/src/index.ts';
import {
  effortBaselineInput,
  historyCosineReferences,
  legacyCosineTexts,
  meetingCosineInputs,
  ROLE_HISTORY_WEIGHTS,
} from './baseline-inputs.ts';
import type { MeetingInput } from './data.ts';
import { requiresExposure } from './evaluation-input.ts';

const [input, installed, output] = process.argv.slice(2);
if (!input || !installed || !output)
  throw new Error('rows, installed bundle root and output required');
if (existsSync(output)) throw new Error('baseline evidence already exists');
const bytes = readFileSync(input);
const rows = bytes
  .toString()
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((s) => JSON.parse(s));
const ai = createLocalIntelligence({ root: installed, device: 'cpu' });
const weights = bundledEffortWeights();
const identity = {
  inputSha256: createHash('sha256').update(bytes).digest('hex'),
  baseModelSha256: ai.bundle.model.sha256,
  weightsSha256: createHash('sha256').update(JSON.stringify(weights)).digest('hex'),
  meetingPreprocessVersion: MEETING_PREPROCESS_VERSION,
  sourceSha256: createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex'),
  baselineInputsSha256: createHash('sha256')
    .update(readFileSync(new URL('./baseline-inputs.ts', import.meta.url)))
    .digest('hex'),
};
if (requiresExposure(rows, process.argv.includes('--unseal-final')))
  writeFileSync(`${output}.exposure.json`, JSON.stringify({ at: Date.now(), ...identity }), {
    mode: 0o600,
    flag: 'wx',
  });
const classifier = loadEffortClassifier(weights, {
  dims: ai.bundle.embedding.dims,
  baseModelSha256: ai.bundle.model.sha256,
  preprocessVersion: EFFORT_PREPROCESS_VERSION,
});
const predictions = [];
let warmUpMilliseconds = 0;
const replayStarted = performance.now();
try {
  const warmUpStarted = performance.now();
  await ai.effort.warmUp();
  warmUpMilliseconds = performance.now() - warmUpStarted;
  for (const row of rows) {
    const start = performance.now();
    if (row.task === 'effort') {
      const view = effortBaselineInput(row);
      const [vector] = await ai.engine.embed({
        texts: [view.text],
        task: 'classification',
        overflow: 'truncate',
        priority: 'effort',
      });
      const judgment = classifier.judge(vector!);
      const review =
        judgment.abstain || lowEffortNeedsReview(judgment.answer, judgment.probabilities);
      predictions.push({
        id: row.id,
        task: row.task,
        probabilities: judgment.probabilities,
        raw: judgment.answer,
        applied: review ? 'medium' : judgment.answer,
        abstained: review,
        inputView: view.source,
        inputTextSha256: createHash('sha256').update(view.text).digest('hex'),
        milliseconds: performance.now() - start,
      });
    } else {
      const x = row.input as MeetingInput;
      const input = {
        message: x.message,
        participants: x.participants.map((p) => ({ participantId: p.id, prompt: p.role })),
        history: x.turns.slice(-12).map((t) => ({ participantId: t.speakerId, text: t.text })),
      };
      const selected = await ai.meeting.select(input);
      const milliseconds = performance.now() - start;
      const all = x.participants.map((p) => p.id);
      const last = x.turns.findLast((t) => t.speakerId && all.includes(t.speakerId))?.speakerId;
      const legacyCosineStarted = performance.now();
      const vectors: Float32Array[] = [];
      let legacyEmbeddingRequests = 0;
      for (const text of legacyCosineTexts(input)) {
        if (text) legacyEmbeddingRequests++;
        const [vector] = text
          ? await ai.engine.embed({
              texts: [text],
              task: 'classification',
              overflow: 'truncate',
              priority: 'meeting',
            })
          : [new Float32Array(ai.bundle.embedding.dims)];
        vectors.push(vector!);
      }
      const dot = (v: Float32Array) =>
        v.reduce((sum, value, n) => sum + value * vectors[0]![n]!, 0);
      const scores = all.map((_, n) =>
        Math.max(dot(vectors[n + 1]!), dot(vectors[n + 1 + all.length]!)),
      );
      const cosine = [all[scores.indexOf(Math.max(...scores))]!];
      const legacyCosineMilliseconds = performance.now() - legacyCosineStarted;
      const historyStarted = performance.now();
      const view = meetingCosineInputs(x);
      let historyEmbeddingRequests = 0;
      let historyEmbeddingMilliseconds = 0;
      const embed = async (text: string) => {
        if (!text) return new Float32Array(ai.bundle.embedding.dims);
        historyEmbeddingRequests++;
        const started = performance.now();
        const [vector] = await ai.engine.embed({
          texts: [text],
          task: 'classification',
          overflow: 'truncate',
          priority: 'meeting',
        });
        historyEmbeddingMilliseconds += performance.now() - started;
        return vector!;
      };
      const query = await embed(view.query);
      // The unchanged native embedding normalizes vectors, so their dot product is cosine.
      const similarity = (vector: Float32Array) =>
        vector.reduce((sum, value, index) => sum + value * query[index]!, 0);
      const roleScores: number[] = [];
      const historyScores: number[] = [];
      for (const person of view.participants) {
        roleScores.push(similarity(await embed(person.role)));
        const scores: number[] = [];
        for (const turn of person.history) scores.push(similarity(await embed(turn)));
        historyScores.push(scores.length ? Math.max(...scores) : 0);
      }
      const historyReferences = historyCosineReferences(all, roleScores, historyScores);
      const historyCosineMilliseconds = performance.now() - historyStarted;
      predictions.push({
        id: row.id,
        task: row.task,
        selected,
        applied: selected ?? all,
        references: {
          all,
          first: all.slice(0, 1),
          last: last ? [last] : all.slice(0, 1),
          cosine,
          shippedWithOneFallback: selected ?? (last ? [last] : all.slice(0, 1)),
          ...historyReferences,
        },
        milliseconds,
        offlineReferenceTiming: {
          legacyCosineMilliseconds,
          legacyEmbeddingRequests,
          historyCosineMilliseconds,
          historyEmbeddingMilliseconds,
          historyEmbeddingRequests,
          historyTurnCount: view.participants.reduce(
            (count, person) => count + person.history.length,
            0,
          ),
          totalMilliseconds: legacyCosineMilliseconds + historyCosineMilliseconds,
        },
      });
    }
    if (predictions.length % 20 === 0)
      console.log(JSON.stringify({ completed: predictions.length, total: rows.length }));
  }
} finally {
  await ai.close();
}
writeFileSync(
  output,
  JSON.stringify(
    {
      ...identity,
      policy: 'corral-effort-v2; role and history cosine with legacy all fallback',
      source: 'shipped native CPU engine, external judgment disabled',
      effortInputPolicy: 'prefer explicit runtimeView.legacyText; otherwise oldText',
      referenceVersion: 'meeting-cosine-full-roles-last12-v1',
      roleHistoryWeights: ROLE_HISTORY_WEIGHTS,
      referencePolicy:
        'name/role cosine and maximum owned-turn cosine inside last12 turns; absent history scores0; ties keep roster order; no labels used; choose reference on P only',
      timing: {
        warmUpMilliseconds,
        totalReplayMilliseconds: performance.now() - replayStarted,
        scope:
          'CPU wall time; offline references timed separately and share native embedding cache with shipped selection. Grid scores share their embeddings; these are not independent cold-reference timings.',
      },
      predictions,
    },
    null,
    2,
  ),
  { mode: 0o600, flag: 'wx' },
);
