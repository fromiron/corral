import {
  type AdmissionConfig,
  type Gate,
  type ModelGateView,
  NO_PROGRESS_TURNS,
  noProgressReached,
} from '../src/index.ts';

// A configured model.request gate that asks the person after six replies without progress. It
// is not a default (docs/specs/llm-runtime.md); tests that need a run-wide approval use it.
const noProgressApproval: Gate<ModelGateView> = {
  id: 'no_progress',
  version: 1,
  check: ({ projection }) =>
    noProgressReached(projection.progress)
      ? {
          kind: 'require_approval',
          approval: 'user_action',
          limit: { kind: 'no_progress', used: projection.progress.turns, max: NO_PROGRESS_TURNS },
        }
      : { kind: 'allow' },
};

export const NO_PROGRESS_APPROVAL: AdmissionConfig = {
  gates: { 'model.request': [noProgressApproval] },
};
