import {
  cleanupLegacyJudge,
  createLocalIntelligence,
  type LocalIntelligence,
  legacyJudgeDir,
} from '@corral/local-intelligence';

/**
 * The local AI every entry point offers (#21): the shared embedding engine and the `local-model`
 * effort judge on it, installed in the OS's data directory. A bundle that is not installed
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
