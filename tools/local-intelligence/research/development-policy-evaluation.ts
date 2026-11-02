// Join only explicitly listed, frozen DEVELOPMENT receipts. No globbing, final access,
// model calls, new fitting recipe, or implicit full-development map refit.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EFFORT_LEVELS, type EffortLevel } from '../../../packages/contracts/src/index.ts';
import {
  type CompletedTrial,
  compareDevelopmentPolicies,
  type DevelopmentCase,
  type EffortPolicy,
  evaluateDevelopmentPolicy,
  MAP_ALGORITHM_VERSION,
} from './effort-policies.ts';
import { deriveOutcomeRuntime } from './outcome-runtime.ts';

interface ReceiptSlot {
  effort: EffortLevel;
  repeat: 0 | 1;
  path: string;
}
interface GroupEntry {
  id: string;
  group: string;
  family: string;
  phase: string;
  origin: string;
  version: number;
  casePath: string;
  visibleFixturePath: string;
  workerRoot: string;
  revisedCaseHash?: string;
  inputHash?: string;
  availability: {
    complete: boolean;
    receiptCount: number;
    expectedReceipts: number;
    missing: unknown[];
  };
  receipts: ReceiptSlot[];
}
export interface DevelopmentManifest {
  phase: string;
  frozen: boolean;
  frozenAt: string;
  workerOutcomesReadBySelector: boolean;
  finalOutcomeAccessAuthorized: boolean;
  qualifiedDevelopmentGroups: number;
  includedCompleteGroups: number;
  excludedIncompleteGroups: number;
  groups: GroupEntry[];
  excludedIncomplete: (Pick<
    GroupEntry,
    'id' | 'family' | 'phase' | 'origin' | 'version' | 'availability'
  > & { group?: string })[];
}
export interface Fixture {
  id: string;
  group: string;
  request: string;
  context: string;
  files: { path: string; content: string }[];
  [key: string]: unknown;
}
interface ExpectedHashes {
  fixtureHash: string;
  promptHash: string;
  inputHash: string;
}
interface WorkerReceipt {
  id: string;
  group: string;
  model: string;
  role: string;
  effort: EffortLevel;
  repeat: number;
  transport: string;
  fixtureHash: string;
  promptHash: string;
  wire?: { kind: string; value: string };
  grade?: { passed?: unknown };
  usage?: { totalTokens?: unknown };
  responseSeconds?: unknown;
}
interface InputRow {
  id: string;
  group: string;
  task: string;
  split: string;
  target: unknown;
  source: { kind: string; fixtureSha256?: string };
  input: Parameters<typeof deriveOutcomeRuntime>[0]['input'];
  coreReasoningInput: unknown;
  runtimeView: ReturnType<typeof deriveOutcomeRuntime>['runtimeView'];
}
interface NativePrediction {
  id: string;
  group: string;
  task: string;
  seconds: number;
  deadlineMiss: boolean;
  result: {
    type: string;
    logits?: number[];
    inputTruncated?: boolean;
    originalPromptTokens?: number;
    usedPromptTokens?: number;
  };
}
interface NativeReport {
  modelSha256: string;
  inputSha256: string;
  helperSha256: string;
  tokenizerSha256: string;
  inputBudget: number;
  contextTokens: number;
  normalizer: string;
  complete: boolean;
  predictions: NativePrediction[];
}
interface BaselineReport {
  inputSha256: string;
  predictions: {
    id: string;
    task: string;
    raw: EffortLevel;
    applied: EffortLevel;
    milliseconds: number;
  }[];
}
interface ReferenceReport {
  metadata: { sourceInputSha256: string; [key: string]: unknown };
  runtime: { temperature: number; [key: string]: unknown };
  predictions: {
    id: string;
    group: string;
    probabilities: number[];
    logits: number[];
    milliseconds: number;
  }[];
}

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const developmentId = (id: string) =>
  /^outcome-\d{4}-\d{2}$/.test(id) && Number(id.split('-')[1]) < 20;

export function validateManifest(manifest: DevelopmentManifest, root: string): void {
  if (
    manifest.phase !== 'development' ||
    manifest.frozen !== true ||
    manifest.workerOutcomesReadBySelector !== false ||
    manifest.finalOutcomeAccessAuthorized !== false ||
    !Number.isFinite(Date.parse(manifest.frozenAt)) ||
    Date.parse(manifest.frozenAt) >= Date.now() ||
    manifest.includedCompleteGroups !== manifest.groups.length ||
    manifest.excludedIncompleteGroups !== manifest.excludedIncomplete.length ||
    manifest.qualifiedDevelopmentGroups !==
      manifest.groups.length + manifest.excludedIncomplete.length
  )
    throw new Error('only a frozen blind development selection may authorize receipt access');
  const ids = new Set<string>();
  const families = new Set<string>();
  for (const entry of [...manifest.groups, ...manifest.excludedIncomplete]) {
    const family = entry.group ?? entry.family;
    if (
      !developmentId(entry.id) ||
      entry.phase !== 'development' ||
      !family ||
      family !== entry.family ||
      ids.has(entry.id) ||
      families.has(family)
    )
      throw new Error('manifest has a final, duplicate, or ungrouped development case');
    ids.add(entry.id);
    families.add(family);
  }
  for (const entry of manifest.groups) {
    if (!entry.group) throw new Error('included fitting cases require their audited group');
    const original = entry.origin === 'original';
    if (
      (!original && entry.origin !== 'repaired') ||
      (original ? entry.version !== 0 : entry.version < 1)
    )
      throw new Error('unknown original/repaired fixture version');
    const expectedCase = original
      ? `outcomes/validated/${entry.id}/case.json`
      : `outcomes/quality-revisions/${entry.id}/v${entry.version}/case.json`;
    if (
      entry.casePath !== expectedCase ||
      resolve(entry.visibleFixturePath) !== resolve(root, expectedCase) ||
      (original
        ? entry.workerRoot !== '.'
        : !new RegExp(`^qualified-trials/${entry.id}-v${entry.version}-[0-9a-f]{12}$`).test(
            entry.workerRoot,
          ))
    )
      throw new Error('fixture or worker root differs from its selected development version');
    if (
      !entry.availability.complete ||
      entry.availability.receiptCount !== 8 ||
      entry.availability.expectedReceipts !== 8 ||
      entry.availability.missing.length ||
      entry.receipts.length !== 8
    )
      throw new Error('selected development fitting family is not complete');
    const slots = new Set<string>();
    for (const slot of entry.receipts) {
      const key = `${slot.effort}:${slot.repeat}`;
      if (
        !EFFORT_LEVELS.includes(slot.effort) ||
        ![0, 1].includes(slot.repeat) ||
        slots.has(key) ||
        resolve(slot.path) !==
          resolve(
            root,
            entry.workerRoot,
            'outcomes/trials-corral',
            entry.id,
            slot.effort,
            String(slot.repeat),
            'receipt.json',
          )
      )
        throw new Error('receipt path/level/repeat is not the exact selected development slot');
      slots.add(key);
    }
  }
}

export function validateReceipt(
  raw: unknown,
  entry: GroupEntry,
  slot: ReceiptSlot,
  fixture: Fixture,
  expected: ExpectedHashes,
): { trial?: CompletedTrial; seconds?: number; reason?: string } {
  const receipt = raw as WorkerReceipt;
  if (
    receipt.id !== entry.id ||
    receipt.group !== fixture.group ||
    receipt.model !== 'gpt-6.1-sol' ||
    receipt.role !== 'evaluated-worker' ||
    receipt.effort !== slot.effort ||
    receipt.repeat !== slot.repeat ||
    receipt.transport !== 'corral' ||
    receipt.fixtureHash !== expected.fixtureHash ||
    receipt.promptHash !== expected.promptHash ||
    receipt.wire?.kind !== 'effort' ||
    receipt.wire.value !== slot.effort
  )
    throw new Error(
      'worker receipt identity, visible prompt, fixture version, or actual effort wire differs',
    );
  const tokens = receipt.usage?.totalTokens;
  if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens <= 0)
    return { reason: 'missing-or-invalid-total-usage' };
  if (typeof receipt.grade?.passed !== 'boolean') return { reason: 'missing-completed-grade' };
  if (
    typeof receipt.responseSeconds !== 'number' ||
    !Number.isFinite(receipt.responseSeconds) ||
    receipt.responseSeconds < 0
  )
    return { reason: 'missing-response-timing' };
  return {
    trial: {
      level: slot.effort,
      repeat: slot.repeat,
      completed: true,
      passed: receipt.grade.passed,
      totalTokens: tokens,
    },
    seconds: receipt.responseSeconds,
  };
}

export function validateVisibleInput(row: InputRow, fixture: Fixture): void {
  if (
    !developmentId(row.id) ||
    row.id !== fixture.id ||
    row.group !== fixture.group ||
    row.task !== 'effort' ||
    row.split === 'final' ||
    row.target !== null ||
    row.source?.kind !== 'executable-snapshot'
  )
    throw new Error('prediction input is not the selected development executable snapshot');
  const input = {
    goal: '',
    request: `${fixture.request}\nObserved context:\n${fixture.context}`,
    previousRequest: '',
    previousReply: '',
    stage: 'step',
    plan: '',
    tools: fixture.files.map((file) => ({
      name: 'read_file',
      args: file.path,
      status: 'success',
      content: file.content,
    })),
  };
  assert.deepEqual(row.input, input, 'model input differs from exact worker-visible source');
  const derived = deriveOutcomeRuntime({ task: 'effort', input });
  assert.deepEqual(row.coreReasoningInput, derived.coreReasoningInput, 'actual Core input changed');
  assert.deepEqual(row.runtimeView, derived.runtimeView, 'actual Core rendered input changed');
}

export function scoreDecisions(
  cases: readonly DevelopmentCase[],
  decisions: ReadonlyMap<string, EffortLevel>,
) {
  if (decisions.size !== cases.length)
    throw new Error('applied decisions must cover all fitting cases');
  const groups = new Map<string, { trials: number; successes: number; tokens: number }>();
  let successes = 0;
  let totalTokens = 0;
  for (const item of cases) {
    const level = decisions.get(item.id);
    if (!level || !EFFORT_LEVELS.includes(level)) throw new Error('invalid applied effort');
    const selected = item.trials.filter((trial) => trial.level === level);
    if (
      selected.length !== 2 ||
      selected.some(
        (trial) =>
          !trial.completed ||
          typeof trial.passed !== 'boolean' ||
          !Number.isSafeInteger(trial.totalTokens) ||
          trial.totalTokens <= 0,
      )
    )
      throw new Error('applied effort lacks complete paired trials');
    const group = groups.get(item.group) ?? { trials: 0, successes: 0, tokens: 0 };
    for (const trial of selected) {
      group.trials++;
      group.successes += Number(trial.passed);
      group.tokens += trial.totalTokens;
      successes += Number(trial.passed);
      totalTokens += trial.totalTokens;
    }
    groups.set(item.group, group);
  }
  return {
    cases: cases.length,
    groups: groups.size,
    trials: cases.length * 2,
    successes,
    totalTokens,
    successRate:
      [...groups.values()].reduce((sum, group) => sum + group.successes / group.trials, 0) /
      groups.size,
    meanTotalTokens:
      [...groups.values()].reduce((sum, group) => sum + group.tokens / group.trials, 0) /
      groups.size,
  };
}

/** Outcome rows contain no placeholder probabilities; each model view supplies its own. */
export function separatePolicyData(cases: readonly DevelopmentCase[]) {
  return {
    outcomeCases: cases.map(({ probabilities: _probabilities, ...outcome }) => outcome),
    policyInputs: cases.map(({ trials: _trials, ...input }) => input),
  };
}

function probabilities(logits: number[], temperature: number): number[] {
  if (
    logits.length !== 4 ||
    logits.some((value) => !Number.isFinite(value)) ||
    !Number.isFinite(temperature) ||
    temperature <= 0
  )
    throw new Error('invalid frozen difficulty logits/calibration');
  const peak = Math.max(...logits);
  const exponents = logits.map((value) => Math.exp((value - peak) / temperature));
  const sum = exponents.reduce((total, value) => total + value, 0);
  return exponents.map((value) => value / sum);
}

function pairedHashes(
  fixtures: { entry: GroupEntry; fixture: Fixture; raw: string }[],
): Record<string, ExpectedHashes> {
  // Use the producer's Python JSON serialization, including Unicode escaping and
  // numeric representation. The worker-prompt literal is read from its source AST;
  // no worker function, command, answer, test, or reference implementation is executed.
  const script = `import ast,hashlib,json,pathlib,sys
data=json.load(sys.stdin)
tree=ast.parse(pathlib.Path('trials.py').read_text())
prefix=[n.value.left.value for n in ast.walk(tree) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='prompt' for t in n.targets) and isinstance(n.value,ast.BinOp) and isinstance(n.value.left,ast.Constant)]
assert len(prefix)==1
sha=lambda x:hashlib.sha256(x.encode()).hexdigest()
result={}
for item in data:
 c=json.loads(item['raw']);e=item['entry'];visible={k:c[k] for k in ['request','context','files']}
 used=c if e['origin']=='original' else {k:c[k] for k in ['request','context','files','id','group','language','referenceFiles','tests']}
 result[e['id']]={'fixtureHash':sha(json.dumps(used,sort_keys=True)),'promptHash':sha(prefix[0]+json.dumps(visible,ensure_ascii=False)),'inputHash':sha(json.dumps(visible,sort_keys=True,ensure_ascii=False,separators=(',',':')))}
json.dump(result,sys.stdout)
`;
  const process = spawnSync(processEnv('CORRAL_RESEARCH_PYTHON', 'python3'), ['-c', script], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    input: JSON.stringify(fixtures),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (process.status !== 0) throw new Error('exact fixture/prompt hash derivation failed');
  return JSON.parse(process.stdout) as Record<string, ExpectedHashes>;
}

function processEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function main() {
  const options = new Map<string, string>();
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key || !value || !['--root', '--manifest', '--out'].includes(key))
      throw new Error('root, exact development manifest, and output required');
    options.set(key, value);
  }
  const rootArg = options.get('--root');
  const manifestArg = options.get('--manifest');
  const outputArg = options.get('--out');
  if (!rootArg || !manifestArg || !outputArg) throw new Error('root, manifest, output required');
  const root = realpathSync(rootArg);
  const manifestPath = resolve(manifestArg);
  const output = resolve(outputArg);
  if (existsSync(output)) throw new Error('development policy report already exists');
  const sourceHashes: Record<string, string> = {};
  const read = (path: string) => {
    const absolute = resolve(path);
    if (realpathSync(absolute) !== absolute || relative(root, absolute).startsWith('..'))
      throw new Error('research input escaped its declared root');
    const raw = readFileSync(absolute);
    sourceHashes[relative(root, absolute)] = sha(raw);
    return raw;
  };
  const manifest = JSON.parse(read(manifestPath).toString()) as DevelopmentManifest;
  validateManifest(manifest, root); // Before opening ANY worker receipt or fixture.
  const algorithmFreeze = JSON.parse(
    read(resolve(root, 'runs/effort-policy-v1/algorithm-freeze.json')).toString(),
  ) as { algorithm: string; algorithmSha256: string };
  const algorithmSource = readFileSync(new URL('./effort-policies.ts', import.meta.url));
  if (
    algorithmFreeze.algorithm !== MAP_ALGORITHM_VERSION ||
    algorithmFreeze.algorithmSha256 !== sha(algorithmSource)
  )
    throw new Error('policy algorithm changed after its pre-outcome freeze');
  const precision = JSON.parse(
    read(resolve(root, 'reports/candidate-cp-evaluation-v1.precision-freeze.json')).toString(),
  ) as {
    selectedQuantization: string;
    modelSha256: string;
    temperature: number;
    helperSha256: string;
    tokenizerSha256: string;
  };
  if (precision.selectedQuantization !== 'q8' || precision.temperature !== 1.0725250686877876)
    throw new Error('this declared development comparison requires the frozen Q8 calibration');
  const inputRaw = read(resolve(root, 'outcomes/development-v3-core-inputs.jsonl'));
  const inputHash = sha(inputRaw);
  const inputs = inputRaw
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as InputRow);
  if (
    inputs.some((row) => !developmentId(row.id) || row.split === 'final' || row.target !== null) ||
    new Set(inputs.map((row) => row.id)).size !== inputs.length
  )
    throw new Error('only distinct development executable inputs may be joined');
  const inputLookup = new Map(inputs.map((row) => [row.id, row]));
  const native = new Map<number, NativeReport>();
  for (const budget of [1024, 2048]) {
    const report = JSON.parse(
      read(resolve(root, `reports/final-q8-development-v3-${budget}.json`)).toString(),
    ) as NativeReport;
    if (
      !report.complete ||
      report.modelSha256 !== precision.modelSha256 ||
      report.helperSha256 !== precision.helperSha256 ||
      report.tokenizerSha256 !== precision.tokenizerSha256 ||
      report.inputSha256 !== inputHash ||
      report.inputBudget !== budget ||
      report.predictions.length !== inputs.length ||
      new Set(report.predictions.map((p) => p.id)).size !== inputs.length ||
      report.predictions.some(
        (p) =>
          !inputLookup.has(p.id) ||
          p.task !== 'effort' ||
          p.group !== inputLookup.get(p.id)?.group ||
          p.result.type !== 'result' ||
          p.deadlineMiss ||
          !Number.isFinite(p.seconds) ||
          p.seconds < 0 ||
          p.seconds >= 3 ||
          !p.result.logits,
      )
    )
      throw new Error('native development predictions lack exact, timely Q8 CoreV3 coverage');
    native.set(budget, report);
  }
  const baseline = JSON.parse(
    read(resolve(root, 'reports/baseline-development-v3.json')).toString(),
  ) as BaselineReport;
  const reference = JSON.parse(
    read(resolve(root, 'runs/reference-upstream-v1/development.predictions.json')).toString(),
  ) as ReferenceReport;
  for (const [hash, predictions] of [
    [baseline.inputSha256, baseline.predictions],
    [reference.metadata.sourceInputSha256, reference.predictions],
  ] as const) {
    if (
      hash !== inputHash ||
      predictions.length !== inputs.length ||
      new Set(predictions.map((p) => p.id)).size !== inputs.length ||
      predictions.some((p) => !inputLookup.has(p.id))
    )
      throw new Error('baseline/reference uses different development inputs');
  }
  if (reference.runtime.temperature !== 1.55)
    throw new Error('supplied reference temperature must remain unchanged');
  if (
    baseline.predictions.some(
      (p) =>
        p.task !== 'effort' ||
        !EFFORT_LEVELS.includes(p.applied) ||
        !Number.isFinite(p.milliseconds) ||
        p.milliseconds < 0,
    ) ||
    reference.predictions.some(
      (p) =>
        p.group !== inputLookup.get(p.id)?.group ||
        !Number.isFinite(p.milliseconds) ||
        p.milliseconds < 0,
    )
  )
    throw new Error('baseline/reference applied decisions or measured timings are invalid');
  const fixtures = manifest.groups.map((entry) => {
    const raw = read(entry.visibleFixturePath);
    const fixture = JSON.parse(raw.toString()) as Fixture;
    if (entry.origin === 'repaired' && sha(raw) !== entry.revisedCaseHash)
      throw new Error('approved revised fixture bytes changed');
    const input = inputLookup.get(entry.id);
    if (!input) throw new Error('selected development fixture has no prediction input');
    validateVisibleInput(input, fixture);
    return { entry, fixture, raw: raw.toString() };
  });
  const expected = pairedHashes(fixtures);
  const baseCases: DevelopmentCase[] = [];
  const timings = new Map<string, Map<EffortLevel, number[]>>();
  const extraIncomplete: { id: string; group: string; reasons: string[] }[] = [];
  for (const { entry, fixture } of fixtures) {
    const hashes = expected[entry.id];
    if (!hashes) throw new Error('fixture hash coverage is incomplete');
    const input = inputLookup.get(entry.id);
    assert.ok(input);
    if (
      (entry.origin === 'original' && input.source.fixtureSha256 !== hashes.fixtureHash) ||
      (entry.origin === 'repaired' && entry.inputHash !== hashes.inputHash)
    )
      throw new Error(
        'original/revised fixture does not match its immutable visible-input provenance',
      );
    const trials: CompletedTrial[] = [];
    const reasons: string[] = [];
    const seconds = new Map<EffortLevel, number[]>();
    for (const slot of entry.receipts) {
      const parsed = validateReceipt(
        JSON.parse(read(slot.path).toString()),
        entry,
        slot,
        fixture,
        hashes,
      );
      if (!parsed.trial || parsed.seconds === undefined)
        reasons.push(`${slot.effort}:${slot.repeat}:${parsed.reason}`);
      else {
        trials.push(parsed.trial);
        const values = seconds.get(slot.effort) ?? [];
        values.push(parsed.seconds);
        seconds.set(slot.effort, values);
      }
    }
    if (reasons.length) extraIncomplete.push({ id: entry.id, group: entry.group, reasons });
    else {
      baseCases.push({
        id: entry.id,
        group: entry.group,
        split: 'development',
        probabilities: [1, 0, 0, 0],
        trials,
      });
      timings.set(entry.id, seconds);
    }
  }
  const high = evaluateDevelopmentPolicy(baseCases, { kind: 'constant', level: 'high' }).metrics;
  const low = evaluateDevelopmentPolicy(baseCases, { kind: 'constant', level: 'low' }).metrics;
  const summarize = (
    cases: DevelopmentCase[],
    actions: Map<string, EffortLevel>,
    judgeSeconds: Map<string, number>,
  ) => {
    const metrics = scoreDecisions(cases, actions);
    const costs = new Map<string, { n: number; worker: number; judge: number }>();
    for (const item of cases) {
      const action = actions.get(item.id);
      assert.ok(action);
      const values = timings.get(item.id)?.get(action);
      assert.ok(values && values.length === 2);
      const group = costs.get(item.group) ?? { n: 0, worker: 0, judge: 0 };
      group.n++;
      group.worker += values.reduce((sum, value) => sum + value, 0) / values.length;
      group.judge += judgeSeconds.get(item.id) ?? 0;
      costs.set(item.group, group);
    }
    const meanWorkerSeconds =
      [...costs.values()].reduce((sum, group) => sum + group.worker / group.n, 0) / costs.size;
    const meanJudgeSeconds =
      [...costs.values()].reduce((sum, group) => sum + group.judge / group.n, 0) / costs.size;
    const equal =
      Math.abs(low.successRate - metrics.successRate) < 1e-12 &&
      Math.abs(low.meanTotalTokens - metrics.meanTotalTokens) < 1e-12;
    const dominated =
      low.successRate >= metrics.successRate - 1e-12 &&
      low.meanTotalTokens <= metrics.meanTotalTokens + 1e-12;
    return {
      ...metrics,
      tokenReductionVsHigh: 1 - metrics.meanTotalTokens / high.meanTotalTokens,
      successDeltaVsHigh: metrics.successRate - high.successRate,
      empiricalConstantLowComparison: equal
        ? 'equivalent'
        : dominated
          ? 'dominated'
          : 'not-dominated',
      meanWorkerSeconds,
      meanJudgeSeconds,
      meanWorkerPlusJudgeSeconds: meanWorkerSeconds + meanJudgeSeconds,
      appliedCounts: Object.fromEntries(
        EFFORT_LEVELS.map((level) => [
          level,
          [...actions.values()].filter((value) => value === level).length,
        ]),
      ),
    };
  };
  const qwen: Record<string, unknown> = {};
  for (const [budget, report] of native) {
    const lookup = new Map(report.predictions.map((prediction) => [prediction.id, prediction]));
    const cases = baseCases.map((item) => {
      const prediction = lookup.get(item.id);
      assert.ok(prediction?.result.logits);
      return {
        ...item,
        probabilities: probabilities(prediction.result.logits, precision.temperature),
      };
    });
    const comparison = compareDevelopmentPolicies(cases);
    const judge = new Map(cases.map((item) => [item.id, lookup.get(item.id)?.seconds ?? 0]));
    const evaluated = comparison.comparisons.map((entry) => ({
      name: entry.name,
      policy: entry.policy,
      metrics: summarize(
        cases,
        new Map(entry.predictions.map((p) => [p.id, p.appliedLevel])),
        entry.policy.kind === 'constant' ? new Map() : judge,
      ),
    }));
    qwen[String(budget)] = {
      policyInputs: separatePolicyData(cases).policyInputs,
      comparison,
      evaluated,
      learnedOOF: summarize(
        cases,
        new Map(comparison.learnedOOF.predictions.map((p) => [p.id, p.appliedLevel])),
        judge,
      ),
      inputBudget: report.inputBudget,
      contextTokens: report.contextTokens,
      truncations: cases.filter((item) => lookup.get(item.id)?.result.inputTruncated).length,
      fullDevelopmentRefit: null,
    };
  }
  const baselineLookup = new Map(
    baseline.predictions.map((prediction) => [prediction.id, prediction]),
  );
  const shippedActions = new Map(
    baseCases.map((item) => {
      const p = baselineLookup.get(item.id);
      assert.ok(p);
      return [item.id, p.applied] as const;
    }),
  );
  const shippedJudge = new Map(
    baseCases.map((item) => [item.id, (baselineLookup.get(item.id)?.milliseconds ?? 0) / 1000]),
  );
  const referenceLookup = new Map(
    reference.predictions.map((prediction) => [prediction.id, prediction]),
  );
  const referenceCases = baseCases.map((item) => {
    const p = referenceLookup.get(item.id);
    assert.ok(p);
    const calculated = probabilities(p.logits, 1.55);
    if (
      calculated.some(
        (value, index) => Math.abs(value - (p.probabilities[index] ?? Infinity)) > 1e-7,
      )
    )
      throw new Error('supplied fixed reference probabilities changed');
    return { ...item, probabilities: p.probabilities };
  });
  const referenceJudge = new Map(
    baseCases.map((item) => [item.id, (referenceLookup.get(item.id)?.milliseconds ?? 0) / 1000]),
  );
  const referencePolicies: EffortPolicy[] = [
    { kind: 'identity' },
    { kind: 'asymmetric' },
    { kind: 'relative-base-low' },
    { kind: 'asymmetric-relative-low' },
  ];
  const referenceResults = referencePolicies.map((policy) => {
    const evaluated = evaluateDevelopmentPolicy(referenceCases, policy);
    return {
      policy,
      metrics: summarize(
        referenceCases,
        new Map(evaluated.predictions.map((p) => [p.id, p.appliedLevel])),
        referenceJudge,
      ),
    };
  });
  const report = {
    phase: 'development',
    algorithm: MAP_ALGORITHM_VERSION,
    sourceHashes,
    runnerSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
    algorithmFreeze,
    precision,
    qualifiedGroups: manifest.qualifiedDevelopmentGroups,
    manifestCompleteGroups: manifest.groups.length,
    fittedGroups: baseCases.length,
    excludedIncomplete: manifest.excludedIncomplete.map((entry) => ({
      id: entry.id,
      group: entry.group ?? entry.family,
      origin: entry.origin,
      version: entry.version,
      availability: entry.availability,
    })),
    additionalIncompleteExclusions: extraIncomplete,
    selectedVersions: manifest.groups.map((entry) => ({
      id: entry.id,
      group: entry.group,
      origin: entry.origin,
      version: entry.version,
    })),
    outcomeCases: separatePolicyData(baseCases).outcomeCases,
    qwen,
    shippedApplied: summarize(baseCases, shippedActions, shippedJudge),
    suppliedReference: {
      runtime: reference.runtime,
      metadata: reference.metadata,
      fixedTemperature: 1.55,
      comparisons: referenceResults,
    },
    fullDevelopmentRefit: null,
    finalOutcomeAccessed: false,
    limitations: [
      'Complete-group development fitting only; exclusions must NEVER be copied to the final gate.',
      'Small synthetic development cohort; empirical success constraint and domination are not population guarantees.',
      'Modeled completed reads and next-response worker snapshots, not end-to-end autonomous harness outcomes.',
      'Each measured judge latency is reused across the two worker repeats; sampled runs do not isolate contention.',
    ],
  };
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify(
      {
        fittedGroups: report.fittedGroups,
        excludedIncomplete: report.excludedIncomplete.map((entry) => entry.id),
        additionalIncompleteExclusions: extraIncomplete.length,
        qwenBudgets: [...native.keys()],
        shippedApplied: report.shippedApplied,
        reference: referenceResults,
        fullDevelopmentRefit: null,
      },
      (_key, value) => value,
      2,
    ),
  );
}

if (import.meta.main) main();
