import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { EvalSuiteDocument } from '@corral/contracts';
import {
  compileDefinition,
  executeOnce as coreExecuteOnce,
  runSuite as coreRunSuite,
  type EvalSuite,
} from '@corral/core';

export {
  type EvalReport,
  type EvalSuite,
  type ExecResult,
  type QualityResult,
  summaryTable,
} from '@corral/core';

/** Reads and checks a suite file; every problem is reported before anything runs. */
export function loadSuite(
  path: string,
): { ok: true; suite: EvalSuite } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  let document: EvalSuiteDocument;
  try {
    if (statSync(path).size > 4 * 1024 * 1024)
      return { ok: false, errors: ['suite exceeds 4 MiB'] };
    const parsed = EvalSuiteDocument.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success)
      return { ok: false, errors: parsed.error.issues.map((issue) => issue.message) };
    document = parsed.data;
  } catch {
    return { ok: false, errors: ['suite is not valid JSON'] };
  }
  const loaded: EvalSuite['variants'] = [];
  for (const variant of document.variants) {
    const file = resolve(dirname(path), variant.corral);
    if (!existsSync(file)) {
      errors.push(`variant ${variant.id}: Corral file not found`);
      continue;
    }
    try {
      if (statSync(file).size > 4 * 1024 * 1024) throw new Error('oversized');
      const compiled = compileDefinition(JSON.parse(readFileSync(file, 'utf8')));
      if (!compiled.ok) {
        errors.push(
          `variant ${variant.id}: invalid Corral (${compiled.diagnostics.map((diagnostic) => diagnostic.code).join(', ')})`,
        );
        continue;
      }
      loaded.push({ ...variant, definition: compiled.definition });
    } catch {
      errors.push(`variant ${variant.id}: invalid Corral JSON`);
    }
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    suite: {
      ...(document.comparison ? { comparison: document.comparison } : {}),
      ...(document.repetitions !== undefined ? { repetitions: document.repetitions } : {}),
      ...(document.workspace ? { workspace: document.workspace } : {}),
      briefs: document.briefs,
      variants: loaded,
    },
  };
}

export function executeOnce(
  ...[transport, definition, mode, options]: Parameters<typeof coreExecuteOnce>
) {
  return coreExecuteOnce(transport, definition, mode, { now: () => performance.now(), ...options });
}
export function runSuite(...[transport, suite, mode, options]: Parameters<typeof coreRunSuite>) {
  return coreRunSuite(transport, suite, mode, { now: () => performance.now(), ...options });
}
