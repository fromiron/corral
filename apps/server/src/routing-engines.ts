import type { RoutingBackend, RoutingEngine } from '@corral/contracts';
import type { DecisionApis } from './decision-apis.ts';

// The engine a saved effort routing setting names (features/effort-routing.md#설정). Only that
// one is built: choosing an API never starts, installs or asks Local, and the reverse.

export interface RoutingEngineDeps {
  /** Absent on a server that cannot keep keys; an API engine is then unavailable. */
  decisionApis: DecisionApis | undefined;
}

export function routingEngines(deps: RoutingEngineDeps) {
  return (engine: RoutingEngine): RoutingBackend | null =>
    // Local runs the d1 runtime, which this server does not provide yet.
    engine.kind === 'api' ? (deps.decisionApis?.backend(engine) ?? null) : null;
}
