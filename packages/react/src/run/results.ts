import type { BinaryArtifact, OutputContract } from '@corral/contracts';
import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { RunProjection } from '@corral/core';

// What a run produced, as the Results view lists it (CR-009). Computed from committed
// projection facts only; nothing here is stored. The Output node's versions are the final
// results, in the order it received them. Everything else the run made is intermediate,
// grouped per artifact. A run that ended without an Output keeps its work as a partial result.

export interface ResultItem {
  artifactVersionId: string;
  artifactId: string;
  name: string;
  version: number;
  contract: OutputContract;
  authorExecutionId: string;
  submitted: boolean;
  byteLength: number;
  parentVersionId: string | null;
  media?: BinaryArtifact;
  /** The latest review of this version, or null when none was recorded. */
  review: { verdict: 'pass' | 'revise' | 'inconclusive'; stale: boolean } | null;
}

export interface ResultGroup {
  artifactId: string;
  name: string;
  latest: ResultItem;
  /** Newest first; final versions are listed under final results instead. */
  versions: ResultItem[];
}

export interface RunResults {
  /**
   * final: the Output has versions. partial: the run ended without them but made something.
   * pending: still working and no final result yet. none: ended with nothing to show.
   */
  kind: 'final' | 'partial' | 'pending' | 'none';
  final: ResultItem[];
  intermediate: ResultGroup[];
  /** What the view opens on when nothing is chosen. */
  defaultId: string | null;
}

export function runResults(projection: RunProjection): RunResults {
  const order = Object.keys(projection.artifacts);
  const latestReview = new Map<string, ResultItem['review']>();
  for (const review of Object.values(projection.reviews)) {
    latestReview.set(review.targetVersionId, { verdict: review.verdict, stale: review.stale });
  }
  const item = (id: string): ResultItem | null => {
    const artifact = projection.artifacts[id];
    if (!artifact) return null;
    return {
      artifactVersionId: id,
      artifactId: artifact.artifactId,
      name: artifact.name,
      version: artifact.version,
      contract: artifact.contract,
      authorExecutionId: artifact.authorExecutionId,
      submitted: artifact.submitted,
      byteLength: artifact.byteLength,
      parentVersionId: artifact.parentVersionId,
      ...(artifact.media ? { media: artifact.media } : {}),
      review: latestReview.get(id) ?? null,
    };
  };

  const finalIds = projection.output?.artifactVersionIds ?? [];
  const final = finalIds.flatMap((id) => item(id) ?? []);
  const finalSet = new Set(finalIds);

  // Groups ordered by their most recent version, newest first.
  const groups = new Map<string, { position: number; versions: ResultItem[] }>();
  order.forEach((id, position) => {
    if (finalSet.has(id)) return;
    const result = item(id);
    if (!result) return;
    const group = groups.get(result.artifactId) ?? { position, versions: [] };
    group.position = position;
    group.versions.push(result);
    groups.set(result.artifactId, group);
  });
  const intermediate = [...groups.entries()]
    .sort((a, b) => b[1].position - a[1].position)
    .map(([artifactId, group]) => {
      const versions = [...group.versions].sort((a, b) => b.version - a.version);
      const latest = versions[0] as ResultItem;
      return { artifactId, name: latest.name, latest, versions };
    });

  const ended = TERMINAL_RUN_STATUSES.has(projection.status);
  const kind: RunResults['kind'] =
    final.length > 0 ? 'final' : !ended ? 'pending' : intermediate.length > 0 ? 'partial' : 'none';
  return {
    kind,
    final,
    intermediate,
    defaultId: final[0]?.artifactVersionId ?? intermediate[0]?.latest.artifactVersionId ?? null,
  };
}
