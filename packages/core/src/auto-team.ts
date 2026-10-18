import type {
  AutoModelChoice,
  AutoRoute,
  AutoTemplate,
  CorralDefinition,
  RunReference,
  StartFrom,
} from '@corral/contracts';
import type { StartRunResult } from './coordinator.ts';

// CR-024: auto sessions. Not implemented yet.

export interface AutoDefinitionInput {
  id: string;
  template: AutoTemplate;
  brief: string;
  criteria?: string[];
  choice: AutoModelChoice;
  /** The session has a working copy, so the roles get file tools. */
  fileTools: boolean;
  /** Output tokens the choice request used; taken off this run's limits with one call. */
  routeOutputTokens?: number | null;
}

export function autoDefinition(_input: AutoDefinitionInput): CorralDefinition {
  throw new Error('not implemented');
}

export function parseAutoRoute(_text: string): { template: AutoTemplate; reason: string } | null {
  throw new Error('not implemented');
}

export function localAutoRoute(_brief: string): { template: AutoTemplate; reason: string } {
  throw new Error('not implemented');
}

export type RouteAnswer =
  | { ok: true; text: string; usage: { inputTokens: number; outputTokens: number } | null }
  | { ok: false; reason: 'timeout' | 'model_error' };

export interface AutoStart {
  commandId: string;
  sessionId?: string;
  brief: string;
  criteria?: string[];
  mode: 'mock' | 'live';
  choice: AutoModelChoice;
  startFrom?: StartFrom;
  references?: RunReference[];
}

export interface AutoStarterDeps {
  startRun(request: import('@corral/contracts').StartRunRequest): StartRunResult;
  /** The earlier start of a command and the choice it recorded; null if never started. */
  previousStart?(commandId: string): (StartRunResult & { autoRoute: AutoRoute | null }) | null;
  /** The start model; without it the local rule chooses and no model is called. */
  route?(input: {
    brief: string;
    choice: AutoModelChoice;
    signal: AbortSignal;
  }): Promise<RouteAnswer>;
}

export type AutoStartResult = StartRunResult & { autoRoute: AutoRoute | null };

export function createAutoStarter(_deps: AutoStarterDeps): {
  start(
    request: AutoStart,
    context: { fileTools: boolean; signal?: AbortSignal },
  ): Promise<AutoStartResult>;
} {
  return {
    start: async () => {
      throw new Error('not implemented');
    },
  };
}
