import { createLocalIntelligence, type LocalIntelligence } from '@corral/local-intelligence';

/**
 * The local AI every entry point offers (#21): the shared embedding engine and the `local-model`
 * effort judge on it, installed in the OS's data directory. A bundle that is not installed
 * reports itself unavailable and the server runs without it. The server closes it on shutdown.
 */
export function defaultLocalIntelligence(): LocalIntelligence {
  return createLocalIntelligence();
}
