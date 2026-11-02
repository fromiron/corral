interface NativeBuildEvidence {
  sourceCommit: string;
  helperSourceSha256: string;
  dependencyEvidence: {
    name: string;
    version?: string;
    commit?: string;
    license: string;
    source: string;
    scope?: string;
    nodeCompatibility?: string;
  }[];
}

/** Import only public dependency facts; raw build reports include private filesystem paths. */
export function nativeEvidence(report: NativeBuildEvidence, helperSourceSha256: string) {
  if (
    !/^[a-f0-9]{40}$/.test(report.sourceCommit) ||
    report.helperSourceSha256 !== helperSourceSha256 ||
    !report.dependencyEvidence?.length
  )
    throw new Error('native evidence does not match the helper source');
  const dependencies = report.dependencyEvidence.map((dependency) => {
    if (!dependency.name || !dependency.license || !/^https:\/\//.test(dependency.source))
      throw new Error('native dependency needs a public source and license');
    return {
      name: dependency.name,
      version: dependency.version ?? dependency.commit ?? report.sourceCommit,
      license: dependency.license,
      source: dependency.source,
      scope: dependency.scope ?? 'opt-in local decision helper',
      nodeCompatibility:
        dependency.nodeCompatibility ??
        'External C++ executable/library; no Node ABI addon or peer dependency.',
    };
  });
  return {
    scope: 'opt-in experimental local decision runtime; not the default bundle',
    sourceCommit: report.sourceCommit,
    helperSourceSha256,
    review:
      'Pinned recurrent-model runtime compared with LiteRT-LM and node-llama-cpp; isolated process with explicit state reset and verified lifecycle.',
    compatibility:
      'Linux x64 Ubuntu24-class package tested on Node24.15; GLIBC_2.38/GLIBCXX_3.4.32 required. Other platforms remain unqualified.',
    dependencies,
  };
}
