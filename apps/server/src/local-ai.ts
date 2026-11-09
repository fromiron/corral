import {
  cleanupLegacyJudge,
  createLocalIntelligence,
  D1Engine,
  d1ManifestFor,
  defaultD1Dir,
  type LocalIntelligence,
  legacyJudgeDir,
} from '@corral/local-intelligence';

/**
 * The Local effort routing engine of a server with real models (features/effort-routing.md):
 * d1 in the OS's data directory, apart from the meeting bundle. Nothing downloads or starts
 * until the person installs it or saves Manual + Local.
 */
export function defaultD1Engine(): D1Engine {
  return new D1Engine({
    root: defaultD1Dir(),
    manifest: d1ManifestFor(process.platform, process.arch),
  });
}

/**
 * The local AI every entry point offers (#21): the embedding engine for meeting analysis,
 * installed in the OS's data directory. A bundle that is not installed
 * reports itself unavailable and the server runs without it. The server closes it on shutdown.
 * Starting also removes what the old judge model installed; a failed cleanup never stops it.
 */
export function defaultLocalIntelligence(): LocalIntelligence {
  try {
    cleanupLegacyJudge(legacyJudgeDir());
  } catch {
    // Left for the next start.
  }
  return createLocalIntelligence();
}
