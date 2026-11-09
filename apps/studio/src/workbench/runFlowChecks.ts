import type { VerificationReport } from '@corral/contracts';
import type { RunFlowCheck } from '@corral/react';

type CheckRecord = {
  verificationId: string;
  name: string;
  report?: Pick<VerificationReport, 'owner' | 'state' | 'verdict' | 'exitCode' | 'timedOut'> | null;
};

/** Join only exact references owned by this Run; raw reports/output never enter the view. */
export function runFlowChecks(
  records: readonly CheckRecord[],
  runId: string,
  references: readonly string[],
): RunFlowCheck[] {
  const ids = new Set(references);
  return records.flatMap((record) => {
    const report = record.report;
    if (
      !ids.has(record.verificationId) ||
      report?.owner.kind !== 'execution' ||
      report.owner.runId !== runId
    )
      return [];
    return [
      {
        id: record.verificationId,
        name: record.name,
        state: report.state,
        verdict: report.verdict,
        exitCode: report.exitCode,
        timedOut: report.timedOut,
      },
    ];
  });
}
